/**
 * Observable, resumable workflow engine (spec §20: "All jobs observable and resumable").
 *
 * A workflow is an ordered list of steps. Every run and every step is persisted
 * (`workflow_runs` / `workflow_steps`) BEFORE and AFTER it executes, so the UI can observe progress
 * and a crashed or failed run can be resumed with the same run id.
 *
 * Step contract
 * - `run(sc)` receives the run-bound context (`sc.ctx.runId === run.id`, decisions are stamped),
 *   the stored run input and the outputs of every earlier SUCCEEDED/SKIPPED step (`sc.outputs[key]`,
 *   a private deep copy — mutating it never affects other steps or the stored outputs).
 * - It returns a JSON-serializable plain object (`undefined`/`null` are stored as `{}`). Outputs that
 *   are not JSON-serializable (functions, bigint, NaN/Infinity, Map/Set/class instances without
 *   `toJSON`, circular references) fail the step with a clear error and are NOT retried.
 * - Returning `{ __skipped: true, reason }` (see `skipStep()`) records the step as SKIPPED — use it
 *   when the step legitimately cannot act (e.g. a provider capability is UNAVAILABLE). Other keys of
 *   the object are kept in the stored output next to `skipped: true` and `reason`.
 * - Throwing fails the attempt; the step is retried up to `retries` times (default 0).
 *
 * Run status (ARCHITECTURE §8)
 * - all steps SUCCEEDED/SKIPPED → SUCCEEDED
 * - an `optional` step failed (and no required one) → PARTIAL, later steps still run
 * - a required step failed → FAILED, later steps stay PENDING
 * - cancelled via `cancel()` → CANCELLED, not-yet-started steps stay PENDING
 *
 * `start()` resolves with the final run for every step outcome; it only rejects for invalid
 * requests (unknown workflow, invalid input/definition, unknown dealer/goal) or infrastructure
 * failures (e.g. the database became unavailable — the run is then marked FAILED when possible).
 */
import { withRun, type AppContext } from '../app/context.ts';
import { AppError, NotFoundError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { truncate } from '../core/text.ts';
import {
  WORKFLOW_STATUSES,
  WORKFLOW_TRIGGERS,
  type StepStatus,
  type WorkflowRun,
  type WorkflowStatus,
  type WorkflowStep,
  type WorkflowTrigger,
} from '../core/types.ts';
import { AGENTS, type AgentName } from '../skills/registry.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Public types (ARCHITECTURE §8 · A6)
// ─────────────────────────────────────────────────────────────────────────────

export interface StepContext {
  ctx: AppContext;
  run: WorkflowRun;
  input: Record<string, unknown>;
  outputs: Record<string, Record<string, unknown>>;
  /**
   * Report live progress of a long step (stored as the RUNNING step's `output.progress`, shown on the run page).
   * Replaced by the step's real output when it finishes. Never throws.
   */
  progress(p: Record<string, unknown>): void;
}

export interface WorkflowStepDef {
  key: string;
  agent: AgentName;
  skill: string;
  description: string;
  run(sc: StepContext): Promise<Record<string, unknown>> | Record<string, unknown>;
  /** extra attempts after a thrown error (default 0, max 10) */
  retries?: number;
  /** an optional step's failure does not stop the run (run ends PARTIAL) */
  optional?: boolean;
  /** wait between attempts in milliseconds (default 0) */
  retryDelayMs?: number;
}

export interface WorkflowDef {
  name: string;
  description: string;
  steps: WorkflowStepDef[] | ((input: Record<string, unknown>) => WorkflowStepDef[]);
}

export interface StartOptions {
  trigger: WorkflowTrigger;
  dealer_id?: string | null;
  goal_id?: string | null;
  /**
   * When true and a RUNNING run of the same workflow exists for the same dealer, that run is
   * returned and nothing new is started. Defaults to true for trigger 'schedule', false otherwise.
   */
  singleton?: boolean;
  /** audit actor (default 'scheduler' for trigger 'schedule', else 'system') */
  actor?: string;
  /** called synchronously once the run row exists, before the first step executes */
  onStarted?: (run: WorkflowRun) => void;
}

export interface ResumeOptions {
  actor?: string;
}

export interface ListRunsQuery {
  dealer_id?: string | null;
  workflow?: string;
  status?: WorkflowStatus | WorkflowStatus[];
  /** default 50, max 500 */
  limit?: number;
}

export type WorkflowRunSummary = { succeeded: number; failed: number; skipped: number; pending: number };

/** Shape of `WorkflowRun.output` written by the engine. */
export type WorkflowRunOutput = {
  steps: Record<string, StepStatus>;
  summary: WorkflowRunSummary;
  outputs: Record<string, Record<string, unknown>>;
};

export interface SkippedStepResult {
  __skipped: true;
  reason: string;
  [key: string]: unknown;
}

/** Build the step result that records a step as SKIPPED (e.g. capability unavailable). */
export function skipStep(reason: string, details: Record<string, unknown> = {}): SkippedStepResult {
  return { ...details, __skipped: true, reason };
}

/**
 * The step ran and found nothing to do (no new drafts to write, no leads to research). It is still stored as
 * SKIPPED — the step did no work — but marked `idle: true`, so a report never lists it next to steps that were
 * blocked (a logged-out session, a missing capability) as if it had the same cause.
 */
export function idleStep(reason: string, details: Record<string, unknown> = {}): SkippedStepResult {
  return { ...details, idle: true, __skipped: true, reason };
}

export const INTERRUPTED_ERROR = 'interrupted: process restarted';
export const RESUMABLE_STATUSES: readonly WorkflowStatus[] = ['FAILED', 'PARTIAL', 'RUNNING', 'CANCELLED'];

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RETRIES = 10;
const MAX_ERROR_CHARS = 2000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const REMOVED_STEP_REASON = 'step no longer defined in workflow';

/**
 * Runs executing in THIS process. Process-scoped on purpose: "interrupted" means the process that
 * was executing a RUNNING run is gone, which is exactly what this set can tell apart.
 */
const IN_FLIGHT = new Set<string>();
const CANCEL_REQUESTS = new Map<string, { actor: string; reason: string }>();

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Best-effort logging. The database rows and the audit trail are the source of truth; a broken log
 * sink must never change a run's outcome, fail a scheduled start, or leave a run wedged in flight.
 */
export function safeLog(ctx: AppContext, level: LogLevel, msg: string, data: Record<string, unknown> = {}): void {
  try {
    ctx.log[level](msg, data);
  } catch {
    // intentionally ignored (see above)
  }
}

/** Assign an own enumerable property — also for the key `__proto__`, which plain assignment would turn into a prototype swap. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[key] = value;
  }
}

/** Deterministic contract violation (non-serializable step output) — never retried. */
class SerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerializationError';
  }
}

/** Human-readable error: `Name: message (at firstFrame)`, truncated. */
export function describeError(err: unknown): string {
  if (err instanceof SerializationError) return truncate(err.message, MAX_ERROR_CHARS);
  if (err instanceof Error) {
    const head = err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message || err.name;
    const frame = (err.stack ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('at '));
    return truncate(frame ? `${head} (${frame})` : head, MAX_ERROR_CHARS);
  }
  if (typeof err === 'string') return truncate(err, MAX_ERROR_CHARS);
  try {
    return truncate(JSON.stringify(err) ?? String(err), MAX_ERROR_CHARS);
  } catch {
    return truncate(String(err), MAX_ERROR_CHARS);
  }
}

function constructorName(obj: object): string {
  const proto = Object.getPrototypeOf(obj) as { constructor?: { name?: string } } | null;
  return proto?.constructor?.name || 'object';
}

/** Deep JSON-safety check that also returns a detached JSON copy (JSON semantics for undefined). */
function toJsonSafe(value: unknown, path: string, stack: object[]): unknown {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new SerializationError(`${path}: non-finite number (${value}) is not JSON-serializable`);
      return value;
    case 'undefined':
      return undefined;
    case 'bigint':
    case 'symbol':
    case 'function':
      throw new SerializationError(`${path}: ${typeof value} is not JSON-serializable`);
    default:
      break;
  }
  if (value === null) return null;
  const obj = value as object;
  if (stack.includes(obj)) throw new SerializationError(`${path}: circular reference is not JSON-serializable`);
  if (obj instanceof Date) {
    if (Number.isNaN(obj.getTime())) throw new SerializationError(`${path}: invalid Date is not JSON-serializable`);
    return obj.toISOString();
  }
  stack.push(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map((item, i) => {
        const x = toJsonSafe(item, `${path}[${i}]`, stack);
        return x === undefined ? null : x;
      });
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      const toJSON = (obj as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function') return toJsonSafe(toJSON.call(obj), path, stack);
      throw new SerializationError(`${path}: ${constructorName(obj)} instance is not a plain JSON object`);
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj)) {
      const x = toJsonSafe(val, `${path}.${k}`, stack);
      if (x !== undefined) setOwn(out, k, x);
    }
    return out;
  } finally {
    stack.pop();
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return constructorName(value);
  return typeof value;
}

type NormalizedResult = { skipped: boolean; output: Record<string, unknown> };

function normalizeStepResult(stepKey: string, raw: unknown): NormalizedResult {
  if (raw === undefined || raw === null) return { skipped: false, output: {} };
  let safe: unknown;
  try {
    safe = toJsonSafe(raw, 'output', []);
  } catch (err) {
    if (err instanceof SerializationError) {
      throw new SerializationError(`step "${stepKey}" output is not JSON-serializable: ${err.message}`);
    }
    throw err;
  }
  if (!isPlainRecord(safe)) {
    throw new SerializationError(`step "${stepKey}" must return a plain object, got ${describeKind(raw)}`);
  }
  if (safe.__skipped === true) {
    const { __skipped: _marker, reason, ...rest } = safe;
    const text = typeof reason === 'string' && reason.trim() ? reason.trim() : 'skipped';
    return { skipped: true, output: { ...rest, skipped: true, reason: text } };
  }
  return { skipped: false, output: safe };
}

function validateSteps(workflow: string, steps: unknown): asserts steps is WorkflowStepDef[] {
  const fail = (message: string, step?: string): never => {
    throw new AppError('invalid_workflow', `Workflow "${workflow}": ${message}`, 422, { workflow, step: step ?? null });
  };
  if (!Array.isArray(steps)) fail('steps must be an array of step definitions');
  const seen = new Set<string>();
  (steps as unknown[]).forEach((raw, i) => {
    if (!isPlainRecord(raw)) fail(`step #${i + 1} is not an object`);
    const s = raw as Partial<WorkflowStepDef>;
    const key = typeof s.key === 'string' ? s.key.trim() : '';
    if (!key || key !== s.key || key.length > 100) fail(`step #${i + 1} needs a non-empty key (≤100 chars, no surrounding spaces)`);
    if (key === '__proto__') fail(`step #${i + 1} key "__proto__" is reserved`, key);
    if (seen.has(key)) fail(`duplicate step key "${key}"`, key);
    seen.add(key);
    if (!AGENTS.includes(s.agent as AgentName)) fail(`step "${key}" has unknown agent "${String(s.agent)}"`, key);
    if (typeof s.skill !== 'string' || !s.skill.trim()) fail(`step "${key}" needs a skill name`, key);
    if (typeof s.description !== 'string') fail(`step "${key}" needs a description`, key);
    if (typeof s.run !== 'function') fail(`step "${key}" needs a run function`, key);
    if (s.retries !== undefined && (!Number.isInteger(s.retries) || s.retries < 0 || s.retries > MAX_RETRIES)) {
      fail(`step "${key}" retries must be an integer between 0 and ${MAX_RETRIES}`, key);
    }
    if (s.retryDelayMs !== undefined && (!Number.isFinite(s.retryDelayMs) || s.retryDelayMs < 0)) {
      fail(`step "${key}" retryDelayMs must be a non-negative number`, key);
    }
    if (s.optional !== undefined && typeof s.optional !== 'boolean') fail(`step "${key}" optional must be boolean`, key);
  });
}

function buildRunOutput(rows: WorkflowStep[]): WorkflowRunOutput {
  const steps: Record<string, StepStatus> = {};
  const outputs: Record<string, Record<string, unknown>> = {};
  const summary: WorkflowRunSummary = { succeeded: 0, failed: 0, skipped: 0, pending: 0 };
  for (const row of rows) {
    steps[row.step_key] = row.status;
    if (row.status === 'SUCCEEDED') {
      summary.succeeded++;
      outputs[row.step_key] = row.output;
    } else if (row.status === 'SKIPPED') {
      summary.skipped++;
      outputs[row.step_key] = row.output;
    } else if (row.status === 'FAILED') {
      summary.failed++;
    } else {
      summary.pending++;
    }
  }
  return { steps, summary, outputs };
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const isDone = (status: StepStatus) => status === 'SUCCEEDED' || status === 'SKIPPED';

// ─────────────────────────────────────────────────────────────────────────────
// Engine
// ─────────────────────────────────────────────────────────────────────────────

export class WorkflowEngine {
  private readonly defs = new Map<string, WorkflowDef>();

  constructor(defs: WorkflowDef[] = []) {
    for (const def of defs) this.register(def);
  }

  register(def: WorkflowDef): void {
    if (!def || typeof def.name !== 'string' || !def.name.trim()) {
      throw new AppError('invalid_workflow', 'Workflow definition needs a non-empty name', 422);
    }
    if (this.defs.has(def.name)) {
      throw new AppError('workflow_already_registered', `Workflow already registered: ${def.name}`, 409, {
        workflow: def.name,
      });
    }
    if (typeof def.steps !== 'function') validateSteps(def.name, def.steps);
    this.defs.set(def.name, def);
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  get(name: string): WorkflowDef {
    const def = this.defs.get(name);
    if (!def) throw new AppError('unknown_workflow', `Unknown workflow: ${name}`, 404, { workflow: name });
    return def;
  }

  list(): WorkflowDef[] {
    return [...this.defs.values()];
  }

  /** Resolve (static or input-dependent) steps and validate them. */
  resolveSteps(def: WorkflowDef, input: Record<string, unknown>): WorkflowStepDef[] {
    let steps: unknown;
    try {
      steps = typeof def.steps === 'function' ? def.steps(input) : def.steps;
    } catch (err) {
      throw new AppError(
        'workflow_steps_unresolvable',
        `Workflow "${def.name}" could not resolve its steps: ${describeError(err)}`,
        422,
        { workflow: def.name },
      );
    }
    validateSteps(def.name, steps);
    return steps;
  }

  async start(ctx: AppContext, name: string, input: Record<string, unknown>, opts: StartOptions): Promise<WorkflowRun> {
    const def = this.get(name);
    if (!opts || !WORKFLOW_TRIGGERS.includes(opts.trigger)) {
      throw new AppError('invalid_trigger', `Invalid workflow trigger: ${String(opts?.trigger)}`, 422, { workflow: name });
    }
    const storedInput = this.sanitizeInput(name, input);
    const dealerId = opts.dealer_id ?? null;
    const goalId = opts.goal_id ?? null;
    if (dealerId !== null && !ctx.db.table('dealers').get(dealerId)) throw new NotFoundError('dealer', dealerId);
    if (goalId !== null) {
      const goal = ctx.db.table('operator_goals').get(goalId);
      if (!goal) throw new NotFoundError('operator_goal', goalId);
      if (dealerId !== null && goal.dealer_id !== dealerId) {
        // Tenant isolation: a run must never be attributed to another dealer's goal.
        throw new AppError(
          'goal_dealer_mismatch',
          `Goal ${goalId} belongs to dealer ${goal.dealer_id}, not to dealer ${dealerId}`,
          422,
          { workflow: name, goal_id: goalId, goal_dealer_id: goal.dealer_id, dealer_id: dealerId },
        );
      }
    }
    const actor = opts.actor ?? (opts.trigger === 'schedule' ? 'scheduler' : 'system');
    const singleton = opts.singleton ?? opts.trigger === 'schedule';

    if (singleton) {
      const existing = this.findRunningRun(ctx, name, dealerId);
      if (existing) return this.skipSingleton(ctx, existing, name, dealerId, opts.trigger, actor);
    }

    const steps = this.resolveSteps(def, storedInput);
    const runId = newId('wf');
    const now = ctx.clock.iso();
    const outcome = ctx.db.tx(() => {
      // Re-check inside the write transaction (BEGIN IMMEDIATE holds the write lock): another process
      // sharing the database may have started this workflow for the dealer since the fast-path check.
      if (singleton) {
        const existing = this.findRunningRun(ctx, name, dealerId);
        if (existing) return { kind: 'existing' as const, run: existing };
      }
      const created = ctx.db.table('workflow_runs').insert({
        id: runId,
        workflow: name,
        dealer_id: dealerId,
        goal_id: goalId,
        trigger: opts.trigger,
        status: 'RUNNING',
        input: storedInput,
        output: {},
        error: null,
        resumed_from_run_id: null,
        started_at: now,
        finished_at: null,
      });
      steps.forEach((step, i) => {
        ctx.db.table('workflow_steps').insert({
          id: newId('step'),
          run_id: runId,
          step_key: step.key,
          seq: i + 1,
          agent: step.agent,
          skill: step.skill,
          status: 'PENDING',
          attempts: 0,
          output: {},
          error: null,
          started_at: null,
          finished_at: null,
        });
      });
      ctx.audit.event({
        actor,
        action: 'workflow.started',
        entity_type: 'workflow_run',
        entity_id: runId,
        details: {
          workflow: name,
          trigger: opts.trigger,
          dealer_id: dealerId,
          goal_id: goalId,
          steps: steps.map((s) => s.key),
        },
      });
      return { kind: 'created' as const, run: created };
    });
    if (outcome.kind === 'existing') return this.skipSingleton(ctx, outcome.run, name, dealerId, opts.trigger, actor);

    IN_FLIGHT.add(runId);
    safeLog(ctx, 'info', 'workflow.started', { run_id: runId, workflow: name, trigger: opts.trigger, dealer_id: dealerId });
    if (opts.onStarted) {
      try {
        opts.onStarted(outcome.run);
      } catch (err) {
        safeLog(ctx, 'warn', 'workflow.on_started_callback_failed', { run_id: runId, error: describeError(err) });
      }
    }
    return this.execute(ctx, runId, steps, actor);
  }

  private skipSingleton(
    ctx: AppContext,
    existing: WorkflowRun,
    workflow: string,
    dealerId: string | null,
    trigger: WorkflowTrigger,
    actor: string,
  ): WorkflowRun {
    ctx.audit.event({
      actor,
      action: 'workflow.skipped_singleton',
      entity_type: 'workflow_run',
      entity_id: existing.id,
      details: { workflow, dealer_id: dealerId, trigger, running_since: existing.started_at },
    });
    safeLog(ctx, 'info', 'workflow.skipped_singleton', { workflow, dealer_id: dealerId, running_run_id: existing.id });
    return existing;
  }

  async resume(ctx: AppContext, runId: string, opts: ResumeOptions = {}): Promise<WorkflowRun> {
    const run = this.requireRun(ctx, runId);
    if (run.status === 'SUCCEEDED') {
      safeLog(ctx, 'info', 'workflow.resume_noop', { run_id: runId, workflow: run.workflow });
      return run;
    }
    if (!RESUMABLE_STATUSES.includes(run.status)) {
      throw new AppError('workflow_not_resumable', `Run ${runId} with status ${run.status} cannot be resumed`, 409, {
        run_id: runId,
        status: run.status,
      });
    }
    if (IN_FLIGHT.has(runId)) {
      throw new AppError('workflow_already_running', `Run ${runId} is currently executing in this process`, 409, {
        run_id: runId,
      });
    }
    const def = this.get(run.workflow);
    const stepDefs = this.resolveSteps(def, run.input);
    const actor = opts.actor ?? 'system';
    const existing = ctx.db.table('workflow_steps').findMany({ run_id: runId }, { orderBy: 'seq ASC' });
    const existingKeys = new Set(existing.map((r) => r.step_key));
    const defKeys = new Set(stepDefs.map((s) => s.key));
    const now = ctx.clock.iso();
    const appended: string[] = [];
    const removed: string[] = [];
    const rerun: string[] = [];

    ctx.db.tx(() => {
      let seq = existing.reduce((max, r) => Math.max(max, r.seq), 0);
      for (const step of stepDefs) {
        if (existingKeys.has(step.key)) continue;
        seq += 1;
        ctx.db.table('workflow_steps').insert({
          id: newId('step'),
          run_id: runId,
          step_key: step.key,
          seq,
          agent: step.agent,
          skill: step.skill,
          status: 'PENDING',
          attempts: 0,
          output: {},
          error: null,
          started_at: null,
          finished_at: null,
        });
        appended.push(step.key);
      }
      for (const row of existing) {
        if (isDone(row.status)) continue;
        if (!defKeys.has(row.step_key)) {
          ctx.db.table('workflow_steps').update(row.id, {
            status: 'SKIPPED',
            output: {
              skipped: true,
              reason: REMOVED_STEP_REASON,
              previous_status: row.status,
              previous_error: row.error,
            },
            finished_at: now,
          });
          removed.push(row.step_key);
        } else {
          rerun.push(row.step_key);
        }
      }
      ctx.db.table('workflow_runs').update(runId, { status: 'RUNNING', error: null, finished_at: null });
      ctx.audit.event({
        actor,
        action: 'workflow.resumed',
        entity_type: 'workflow_run',
        entity_id: runId,
        details: {
          workflow: run.workflow,
          previous_status: run.status,
          previous_error: run.error,
          rerun_steps: rerun,
          appended_steps: appended,
          removed_steps: removed,
        },
      });
    });
    IN_FLIGHT.add(runId);
    safeLog(ctx, 'info', 'workflow.resumed', {
      run_id: runId,
      workflow: run.workflow,
      previous_status: run.status,
      rerun_steps: rerun,
      appended_steps: appended,
    });
    return this.execute(ctx, runId, stepDefs, actor);
  }

  /**
   * After a process crash, runs left RUNNING (and not executing in this process) are marked FAILED
   * with `INTERRUPTED_ERROR`; their RUNNING steps become FAILED. They can then be `resume()`d.
   * Call at process start, before this process begins executing workflows.
   */
  recoverInterrupted(ctx: AppContext): WorkflowRun[] {
    const stale = ctx.db
      .table('workflow_runs')
      .findMany({ status: 'RUNNING' }, { orderBy: 'started_at ASC, id ASC' })
      .filter((run) => !IN_FLIGHT.has(run.id));
    const recovered: WorkflowRun[] = [];
    for (const run of stale) {
      const now = ctx.clock.iso();
      const updated = ctx.db.tx(() => {
        const interrupted: string[] = [];
        for (const step of ctx.db.table('workflow_steps').findMany({ run_id: run.id, status: 'RUNNING' })) {
          ctx.db.table('workflow_steps').update(step.id, { status: 'FAILED', error: INTERRUPTED_ERROR, finished_at: now });
          interrupted.push(step.step_key);
        }
        const rows = ctx.db.table('workflow_steps').findMany({ run_id: run.id }, { orderBy: 'seq ASC' });
        const result = ctx.db.table('workflow_runs').update(run.id, {
          status: 'FAILED',
          error: INTERRUPTED_ERROR,
          output: buildRunOutput(rows),
          finished_at: now,
        });
        ctx.audit.event({
          actor: 'system',
          action: 'workflow.interrupted',
          entity_type: 'workflow_run',
          entity_id: run.id,
          details: { workflow: run.workflow, dealer_id: run.dealer_id, interrupted_steps: interrupted },
        });
        return result;
      });
      safeLog(ctx, 'warn', 'workflow.interrupted', { run_id: run.id, workflow: run.workflow });
      recovered.push(updated);
    }
    return recovered;
  }

  /**
   * Cancel a run. A run executing in this process stops before its next step (the current step is
   * allowed to finish) and ends CANCELLED. A run not executing here (PENDING, FAILED or an
   * interrupted RUNNING run) is marked CANCELLED immediately. CANCELLED runs remain resumable.
   */
  cancel(ctx: AppContext, runId: string, meta: { actor: string; reason: string }): WorkflowRun {
    const run = this.requireRun(ctx, runId);
    if (run.status === 'CANCELLED') return run;
    if (run.status === 'SUCCEEDED' || run.status === 'PARTIAL') {
      throw new AppError('workflow_not_cancellable', `Run ${runId} already finished with status ${run.status}`, 409, {
        run_id: runId,
        status: run.status,
      });
    }
    const actor = meta.actor?.trim() || 'system';
    const reason = meta.reason?.trim() || 'no reason given';
    if (IN_FLIGHT.has(runId)) {
      CANCEL_REQUESTS.set(runId, { actor, reason });
      ctx.audit.event({
        actor,
        action: 'workflow.cancel_requested',
        entity_type: 'workflow_run',
        entity_id: runId,
        details: { workflow: run.workflow, reason },
      });
      safeLog(ctx, 'info', 'workflow.cancel_requested', { run_id: runId, workflow: run.workflow, actor });
      return run;
    }
    const now = ctx.clock.iso();
    const updated = ctx.db.tx(() => {
      for (const step of ctx.db.table('workflow_steps').findMany({ run_id: runId, status: 'RUNNING' })) {
        ctx.db.table('workflow_steps').update(step.id, { status: 'FAILED', error: `cancelled: ${reason}`, finished_at: now });
      }
      const rows = ctx.db.table('workflow_steps').findMany({ run_id: runId }, { orderBy: 'seq ASC' });
      const result = ctx.db.table('workflow_runs').update(runId, {
        status: 'CANCELLED',
        error: truncate(`cancelled by ${actor}: ${reason}`, MAX_ERROR_CHARS),
        output: buildRunOutput(rows),
        finished_at: now,
      });
      ctx.audit.event({
        actor,
        action: 'workflow.cancelled',
        entity_type: 'workflow_run',
        entity_id: runId,
        details: { workflow: run.workflow, previous_status: run.status, previous_error: run.error, reason },
      });
      return result;
    });
    safeLog(ctx, 'info', 'workflow.cancelled', { run_id: runId, workflow: run.workflow, actor });
    return updated;
  }

  getRun(ctx: AppContext, runId: string): { run: WorkflowRun; steps: WorkflowStep[] } {
    const run = this.requireRun(ctx, runId);
    const steps = ctx.db.table('workflow_steps').findMany({ run_id: runId }, { orderBy: 'seq ASC' });
    return { run, steps };
  }

  /** Newest first. `dealer_id: null` lists runs without a dealer. */
  listRuns(ctx: AppContext, q: ListRunsQuery = {}): WorkflowRun[] {
    const requested = typeof q.limit === 'number' && !Number.isNaN(q.limit) ? q.limit : DEFAULT_LIST_LIMIT;
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(requested)));
    if (q.status !== undefined) {
      const statuses = Array.isArray(q.status) ? q.status : [q.status];
      for (const s of statuses) {
        if (!WORKFLOW_STATUSES.includes(s)) throw new AppError('invalid_status', `Unknown workflow status: ${s}`, 422);
      }
    }
    return ctx.db
      .table('workflow_runs')
      .findMany(
        { dealer_id: q.dealer_id, workflow: q.workflow, status: q.status },
        { orderBy: 'started_at DESC, id DESC', limit },
      );
  }

  /** The RUNNING run of `workflow` for `dealerId` (null = runs without dealer), if any. */
  findRunningRun(ctx: AppContext, workflow: string, dealerId: string | null): WorkflowRun | undefined {
    return ctx.db
      .table('workflow_runs')
      .findOne({ workflow, dealer_id: dealerId, status: 'RUNNING' }, { orderBy: 'started_at DESC' });
  }

  /** True while the run is executing inside this process. */
  isExecuting(runId: string): boolean {
    return IN_FLIGHT.has(runId);
  }

  // ───────────────────────────────────────────────────────────────────────────

  private requireRun(ctx: AppContext, runId: string): WorkflowRun {
    const run = ctx.db.table('workflow_runs').get(runId);
    if (!run) throw new NotFoundError('workflow_run', runId);
    return run;
  }

  private sanitizeInput(workflow: string, input: unknown): Record<string, unknown> {
    if (input === undefined || input === null) return {};
    let safe: unknown;
    try {
      safe = toJsonSafe(input, 'input', []);
    } catch (err) {
      throw new AppError('invalid_workflow_input', `Workflow "${workflow}" input is not JSON-serializable: ${describeError(err)}`, 422, {
        workflow,
      });
    }
    if (!isPlainRecord(safe)) {
      throw new AppError('invalid_workflow_input', `Workflow "${workflow}" input must be a plain object`, 422, { workflow });
    }
    return safe;
  }

  private async execute(ctx: AppContext, runId: string, stepDefs: WorkflowStepDef[], actor: string): Promise<WorkflowRun> {
    // Everything after the run was registered in IN_FLIGHT sits inside try/finally, so no failure can
    // leave a run marked as executing in this process (that would block recovery, resume and singleton starts).
    try {
      const bound = withRun(ctx, runId);
      const defByKey = new Map(stepDefs.map((s) => [s.key, s]));
      const rows = ctx.db.table('workflow_steps').findMany({ run_id: runId }, { orderBy: 'seq ASC' });
      const outputs: Record<string, Record<string, unknown>> = {};
      for (const row of rows) if (isDone(row.status)) outputs[row.step_key] = row.output;

      let cancelled: { actor: string; reason: string } | null = null;
      for (const row of rows) {
        if (isDone(row.status)) continue;
        const def = defByKey.get(row.step_key);
        if (!def) continue;
        const cancel = CANCEL_REQUESTS.get(runId);
        if (cancel) {
          cancelled = cancel;
          break;
        }
        const result = await this.executeStep(bound, runId, def, row.id, outputs);
        if (result.status === 'FAILED') {
          if (!def.optional) break;
        } else {
          outputs[def.key] = result.output;
        }
      }
      return this.finalize(ctx, runId, defByKey, actor, cancelled);
    } catch (err) {
      this.markEngineFailure(ctx, runId, err);
      throw err;
    } finally {
      IN_FLIGHT.delete(runId);
      CANCEL_REQUESTS.delete(runId);
    }
  }

  private async executeStep(
    ctx: AppContext,
    runId: string,
    def: WorkflowStepDef,
    stepId: string,
    outputs: Record<string, Record<string, unknown>>,
  ): Promise<{ status: 'SUCCEEDED' | 'SKIPPED' | 'FAILED'; output: Record<string, unknown> }> {
    const steps = ctx.db.table('workflow_steps');
    const maxAttempts = 1 + (def.retries ?? 0);
    const startedAt = ctx.clock.iso();
    let lastError = 'step failed without an error message';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const prev = steps.require(stepId);
      steps.update(stepId, {
        status: 'RUNNING',
        attempts: prev.attempts + 1,
        agent: def.agent,
        skill: def.skill,
        started_at: attempt === 1 ? startedAt : prev.started_at,
        error: attempt === 1 ? null : prev.error,
        finished_at: null,
      });
      const run = ctx.db.table('workflow_runs').require(runId);
      safeLog(ctx, 'info', 'workflow.step_started', {
        run_id: runId,
        workflow: run.workflow,
        step_key: def.key,
        attempt,
        max_attempts: maxAttempts,
      });

      let raw: unknown;
      try {
        const progress = (p: Record<string, unknown>) => {
          try {
            steps.update(stepId, { output: { progress: { ...p, at: ctx.clock.iso() } } });
          } catch {
            // progress is best effort; the step's own result is what counts
          }
        };
        raw = await def.run({ ctx, run, input: run.input, outputs: structuredClone(outputs), progress });
      } catch (err) {
        lastError = describeError(err);
        if (attempt < maxAttempts) {
          steps.update(stepId, { error: lastError });
          safeLog(ctx, 'warn', 'workflow.step_retry', { run_id: runId, step_key: def.key, attempt, error: lastError });
          if (def.retryDelayMs) await sleep(def.retryDelayMs);
          continue;
        }
        break;
      }

      let normalized: NormalizedResult;
      try {
        normalized = normalizeStepResult(def.key, raw);
      } catch (err) {
        lastError = describeError(err);
        break; // deterministic contract violation: retrying would only repeat side effects
      }

      const status = normalized.skipped ? 'SKIPPED' : 'SUCCEEDED';
      steps.update(stepId, { status, output: normalized.output, error: null, finished_at: ctx.clock.iso() });
      if (normalized.skipped) {
        ctx.audit.event({
          actor: `agent:${def.agent}`,
          action: 'workflow.step_skipped',
          entity_type: 'workflow_run',
          entity_id: runId,
          details: { workflow: run.workflow, step_key: def.key, skill: def.skill, reason: normalized.output.reason },
        });
        safeLog(ctx, 'info', 'workflow.step_skipped', { run_id: runId, step_key: def.key, reason: normalized.output.reason });
      } else {
        safeLog(ctx, 'info', 'workflow.step_succeeded', { run_id: runId, step_key: def.key, attempt });
      }
      return { status, output: normalized.output };
    }

    const failed = steps.update(stepId, { status: 'FAILED', error: lastError, finished_at: ctx.clock.iso() });
    const run = ctx.db.table('workflow_runs').require(runId);
    ctx.audit.event({
      actor: `agent:${def.agent}`,
      action: 'workflow.step_failed',
      entity_type: 'workflow_run',
      entity_id: runId,
      details: {
        workflow: run.workflow,
        step_key: def.key,
        skill: def.skill,
        optional: def.optional === true,
        attempts: failed.attempts,
        error: lastError,
      },
    });
    safeLog(ctx, def.optional ? 'warn' : 'error', 'workflow.step_failed', {
      run_id: runId,
      workflow: run.workflow,
      step_key: def.key,
      optional: def.optional === true,
      error: lastError,
    });
    return { status: 'FAILED', output: {} };
  }

  private finalize(
    ctx: AppContext,
    runId: string,
    defByKey: Map<string, WorkflowStepDef>,
    actor: string,
    cancelled: { actor: string; reason: string } | null,
  ): WorkflowRun {
    const run = this.requireRun(ctx, runId);
    const rows = ctx.db.table('workflow_steps').findMany({ run_id: runId }, { orderBy: 'seq ASC' });
    const failed = rows.filter((r) => r.status === 'FAILED');
    const requiredFailed = failed.filter((r) => defByKey.get(r.step_key)?.optional !== true);
    const unfinished = rows.filter((r) => r.status === 'PENDING' || r.status === 'RUNNING');

    let status: WorkflowStatus;
    let error: string | null;
    if (cancelled) {
      status = 'CANCELLED';
      error = `cancelled by ${cancelled.actor}: ${cancelled.reason}`;
    } else if (requiredFailed.length > 0) {
      status = 'FAILED';
      error = requiredFailed.map((r) => `step "${r.step_key}" failed: ${r.error ?? 'unknown error'}`).join('; ');
    } else if (unfinished.length > 0) {
      status = 'FAILED';
      error = `steps not executed: ${unfinished.map((r) => r.step_key).join(', ')}`;
    } else if (failed.length > 0) {
      status = 'PARTIAL';
      error = `optional step(s) failed: ${failed.map((r) => `${r.step_key} (${r.error ?? 'unknown error'})`).join('; ')}`;
    } else {
      status = 'SUCCEEDED';
      error = null;
    }

    const output = buildRunOutput(rows);
    const finishedAt = ctx.clock.iso();
    const updated = ctx.db.tx(() => {
      const result = ctx.db.table('workflow_runs').update(runId, {
        status,
        output,
        error: error === null ? null : truncate(error, MAX_ERROR_CHARS),
        finished_at: finishedAt,
      });
      ctx.audit.event({
        actor: cancelled ? cancelled.actor : actor,
        action: 'workflow.completed',
        entity_type: 'workflow_run',
        entity_id: runId,
        details: {
          workflow: run.workflow,
          dealer_id: run.dealer_id,
          status,
          summary: output.summary,
          error: result.error,
          duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(run.started_at)),
        },
      });
      return result;
    });
    const level = status === 'SUCCEEDED' ? 'info' : status === 'FAILED' ? 'error' : 'warn';
    safeLog(ctx, level, 'workflow.completed', {
      run_id: runId,
      workflow: run.workflow,
      status,
      summary: output.summary,
      error: updated.error,
    });
    return updated;
  }

  /** Infrastructure failure while orchestrating: never leave the run silently RUNNING. */
  private markEngineFailure(ctx: AppContext, runId: string, err: unknown): void {
    const message = truncate(`engine error: ${describeError(err)}`, MAX_ERROR_CHARS);
    try {
      const run = ctx.db.table('workflow_runs').get(runId);
      if (!run || run.status !== 'RUNNING') return;
      const now = ctx.clock.iso();
      ctx.db.tx(() => {
        for (const step of ctx.db.table('workflow_steps').findMany({ run_id: runId, status: 'RUNNING' })) {
          ctx.db.table('workflow_steps').update(step.id, { status: 'FAILED', error: message, finished_at: now });
        }
        const rows = ctx.db.table('workflow_steps').findMany({ run_id: runId }, { orderBy: 'seq ASC' });
        ctx.db.table('workflow_runs').update(runId, {
          status: 'FAILED',
          error: message,
          output: buildRunOutput(rows),
          finished_at: now,
        });
        ctx.audit.event({
          actor: 'system',
          action: 'workflow.completed',
          entity_type: 'workflow_run',
          entity_id: runId,
          details: { workflow: run.workflow, status: 'FAILED', error: message },
        });
      });
    } catch (inner) {
      safeLog(ctx, 'error', 'workflow.engine_failure_unrecorded', { run_id: runId, error: message, cause: describeError(inner) });
      return;
    }
    safeLog(ctx, 'error', 'workflow.engine_failure', { run_id: runId, error: message });
  }
}
