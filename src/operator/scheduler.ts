/**
 * Dealer-timezone scheduler for the daily operating rhythm (spec §20).
 *
 * Cron formats (ARCHITECTURE §8)
 * - `'HH:MM'`   daily at that wall-clock time in the dealer's timezone (`dealer.settings.timezone`,
 *               default Asia/Shanghai). Due when local now ≥ today's HH:MM and the schedule has not
 *               run since that instant. A job missed for several days runs ONCE (catch-up is not
 *               replayed per missed day); a job whose time has not yet come today waits for today.
 * - `'every:N'` every N minutes (N ≥ 1): due when it never ran or ≥ N minutes passed since last run.
 *
 * `tick()` starts every due schedule whose workflow is registered, in due-time order, sequentially.
 * Before starting, a schedule is claimed with a compare-and-set on `last_run_at`, so two schedulers
 * sharing a database never start the same due window twice. `last_run_id` is written as soon as the
 * run row exists (observable while running) and is kept even when the run FAILED.
 */
import type { AppContext } from '../app/context.ts';
import { AppError, NotFoundError, ValidationError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { DEFAULT_TZ, addDaysToKey, localDateKey, localParts, zonedTimeToUtc } from '../core/time.ts';
import type { Dealer, Schedule, WorkflowRun } from '../core/types.ts';
import { describeError, safeLog, type WorkflowEngine } from './workflow-engine.ts';

export interface ScheduleEntry {
  workflow: string;
  cron: string;
}

/** Workflow names D1 must register. Order = the daily pipeline order. */
export const DEFAULT_DAILY_SCHEDULE: { workflow: string; cron: string }[] = [
  { workflow: 'refresh_dealer_data', cron: '08:00' },
  { workflow: 'market_research', cron: '08:30' },
  { workflow: 'account_planning', cron: '09:00' },
  { workflow: 'lead_discovery', cron: '09:30' },
  { workflow: 'signal_processing', cron: 'every:60' },
  { workflow: 'reply_processing', cron: 'every:30' },
  { workflow: 'content_publishing', cron: 'every:60' },
  { workflow: 'performance_collection', cron: '18:00' },
  { workflow: 'evening_analysis', cron: '20:00' },
];

export type ParsedCron = { kind: 'daily'; hour: number; minute: number } | { kind: 'every'; minutes: number };

const DAILY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EVERY_RE = /^every:([1-9]\d{0,5})$/;
const MAX_INTERVAL_MS = 2_147_483_647;
const WARN_THROTTLE_MS = 60 * 60_000;

/** Parse `'HH:MM'` / `'every:N'`; returns null for anything else. */
export function parseCron(cron: string): ParsedCron | null {
  if (typeof cron !== 'string') return null;
  const daily = DAILY_RE.exec(cron);
  if (daily) return { kind: 'daily', hour: Number(daily[1]), minute: Number(daily[2]) };
  const every = EVERY_RE.exec(cron);
  if (every) return { kind: 'every', minutes: Number(every[1]) };
  return null;
}

export interface ScheduleEvaluation {
  valid: boolean;
  due: boolean;
  /** start of the current due window (when due) */
  due_at: Date | null;
  /** next instant the schedule is (or becomes) due; equals due_at when due now */
  next_run_at: Date | null;
}

function parseInstant(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

const tzValidity = new Map<string, boolean>();
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  let ok = tzValidity.get(tz);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      ok = true;
    } catch {
      ok = false;
    }
    tzValidity.set(tz, ok);
  }
  return ok;
}

/**
 * Pure due-time evaluation of one schedule at instant `now` in timezone `tz`.
 * An invalid `tz` falls back to Asia/Shanghai (the same rule the scheduler applies to dealer settings).
 */
export function evaluateSchedule(
  schedule: Pick<Schedule, 'cron' | 'last_run_at' | 'created_at'>,
  now: Date,
  tz: string = DEFAULT_TZ,
): ScheduleEvaluation {
  const parsed = parseCron(schedule.cron);
  if (!parsed) return { valid: false, due: false, due_at: null, next_run_at: null };
  const nowMs = now.getTime();
  const last = parseInstant(schedule.last_run_at);

  if (parsed.kind === 'every') {
    if (last === null) {
      const since = new Date(Math.min(parseInstant(schedule.created_at) ?? nowMs, nowMs));
      return { valid: true, due: true, due_at: since, next_run_at: since };
    }
    const nextAt = new Date(last + parsed.minutes * 60_000);
    const due = nowMs >= nextAt.getTime();
    return { valid: true, due, due_at: due ? nextAt : null, next_run_at: nextAt };
  }

  const zone = isValidTimeZone(tz) ? tz : DEFAULT_TZ;
  const p = localParts(now, zone);
  const todayAt = zonedTimeToUtc(p.year, p.month, p.day, parsed.hour, parsed.minute, zone);
  const ranSinceTodayAt = last !== null && last >= todayAt.getTime();
  if (!ranSinceTodayAt && nowMs >= todayAt.getTime()) {
    return { valid: true, due: true, due_at: todayAt, next_run_at: todayAt };
  }
  if (!ranSinceTodayAt) return { valid: true, due: false, due_at: null, next_run_at: todayAt };
  const [y, m, d] = addDaysToKey(localDateKey(now, zone), 1).split('-').map(Number);
  return { valid: true, due: false, due_at: null, next_run_at: zonedTimeToUtc(y, m, d, parsed.hour, parsed.minute, zone) };
}

export interface EnsureSchedulesOptions {
  /** also re-enable matching schedules an operator disabled (default false: their state is kept) */
  reenable?: boolean;
}

export interface DueSchedule {
  schedule: Schedule;
  due_at: Date;
  timezone: string;
}

export class Scheduler {
  readonly engine: WorkflowEngine;
  private readonly warnedAt = new Map<string, number>();

  constructor(engine: WorkflowEngine) {
    this.engine = engine;
  }

  /**
   * Idempotently create the dealer's schedules (unique dealer + workflow + cron). New schedules are
   * enabled. Existing ones are returned unchanged unless `opts.reenable`. Returns schedules in plan order.
   */
  ensureSchedules(
    ctx: AppContext,
    dealerId: string,
    plan: { workflow: string; cron: string }[] = DEFAULT_DAILY_SCHEDULE,
    opts: EnsureSchedulesOptions = {},
  ): Schedule[] {
    if (!ctx.db.table('dealers').get(dealerId)) throw new NotFoundError('dealer', dealerId);
    if (!Array.isArray(plan)) throw new ValidationError('plan', 'expected an array of {workflow, cron}');
    const entries: ScheduleEntry[] = [];
    const seen = new Set<string>();
    plan.forEach((entry, i) => {
      if (typeof entry !== 'object' || entry === null) throw new ValidationError(`plan[${i}]`, 'expected {workflow, cron}');
      if (typeof entry.workflow !== 'string' || !entry.workflow.trim() || entry.workflow !== entry.workflow.trim()) {
        throw new ValidationError(`plan[${i}].workflow`, 'expected a non-empty workflow name without surrounding spaces');
      }
      if (!parseCron(entry.cron)) {
        throw new ValidationError(`plan[${i}].cron`, `invalid cron ${JSON.stringify(entry.cron)} (use 'HH:MM' or 'every:N')`);
      }
      const key = `${entry.workflow}\u0000${entry.cron}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({ workflow: entry.workflow, cron: entry.cron });
    });

    const table = ctx.db.table('schedules');
    return ctx.db.tx(() =>
      entries.map((entry) => {
        const existing = table.findOne({ dealer_id: dealerId, workflow: entry.workflow, cron: entry.cron });
        if (existing) {
          if (existing.enabled || !opts.reenable) return existing;
          const enabled = table.update(existing.id, { enabled: true });
          ctx.audit.event({
            actor: 'system',
            action: 'schedule.enabled_changed',
            entity_type: 'schedule',
            entity_id: existing.id,
            details: { dealer_id: dealerId, workflow: entry.workflow, cron: entry.cron, enabled: true },
          });
          return enabled;
        }
        const created = table.insert({
          id: newId('sch'),
          dealer_id: dealerId,
          workflow: entry.workflow,
          cron: entry.cron,
          enabled: true,
          last_run_at: null,
          last_run_id: null,
          created_at: ctx.clock.iso(),
        });
        ctx.audit.event({
          actor: 'system',
          action: 'schedule.created',
          entity_type: 'schedule',
          entity_id: created.id,
          details: { dealer_id: dealerId, workflow: entry.workflow, cron: entry.cron },
        });
        return created;
      }),
    );
  }

  listSchedules(ctx: AppContext, q: { dealer_id?: string; enabled?: boolean } = {}): Schedule[] {
    return ctx.db
      .table('schedules')
      .findMany({ dealer_id: q.dealer_id, enabled: q.enabled }, { orderBy: 'dealer_id ASC, created_at ASC, id ASC' });
  }

  setEnabled(ctx: AppContext, scheduleId: string, enabled: boolean, actor: string): Schedule {
    const schedule = ctx.db.table('schedules').get(scheduleId);
    if (!schedule) throw new NotFoundError('schedule', scheduleId);
    if (schedule.enabled === enabled) return schedule;
    return ctx.db.tx(() => {
      const updated = ctx.db.table('schedules').update(scheduleId, { enabled });
      ctx.audit.event({
        actor,
        action: 'schedule.enabled_changed',
        entity_type: 'schedule',
        entity_id: scheduleId,
        details: { dealer_id: schedule.dealer_id, workflow: schedule.workflow, cron: schedule.cron, enabled },
      });
      return updated;
    });
  }

  /** Enabled schedules due at `now`, ordered by due time (earliest first). */
  due(ctx: AppContext, now: Date): Schedule[] {
    return this.evaluateDue(ctx, now).map((d) => d.schedule);
  }

  /** Like `due()` but with the due instant and the timezone used. */
  evaluateDue(ctx: AppContext, now: Date): DueSchedule[] {
    const schedules = ctx.db.table('schedules').findMany({ enabled: true }, { orderBy: 'created_at ASC, id ASC' });
    if (schedules.length === 0) return [];
    const dealerIds = [...new Set(schedules.map((s) => s.dealer_id))];
    const dealers = new Map(ctx.db.table('dealers').findMany({ id: dealerIds }).map((d) => [d.id, d]));
    const pipelineOrder = new Map(DEFAULT_DAILY_SCHEDULE.map((e, i) => [e.workflow, i]));

    const due: DueSchedule[] = [];
    for (const schedule of schedules) {
      if (!parseCron(schedule.cron)) {
        this.warnThrottled(ctx, `cron:${schedule.id}:${schedule.cron}`, 'scheduler.invalid_cron', {
          schedule_id: schedule.id,
          dealer_id: schedule.dealer_id,
          workflow: schedule.workflow,
          cron: schedule.cron,
        });
        continue;
      }
      const timezone = this.timezoneOf(ctx, dealers.get(schedule.dealer_id));
      const ev = evaluateSchedule(schedule, now, timezone);
      if (ev.due && ev.due_at) due.push({ schedule, due_at: ev.due_at, timezone });
    }
    const orderOf = (w: string) => pipelineOrder.get(w) ?? Number.MAX_SAFE_INTEGER;
    return due.sort(
      (a, b) =>
        a.due_at.getTime() - b.due_at.getTime() ||
        orderOf(a.schedule.workflow) - orderOf(b.schedule.workflow) ||
        a.schedule.created_at.localeCompare(b.schedule.created_at) ||
        a.schedule.id.localeCompare(b.schedule.id),
    );
  }

  /** Start every due schedule (sequentially). Returns the runs started, in their final state. */
  async tick(ctx: AppContext): Promise<WorkflowRun[]> {
    const due = this.evaluateDue(ctx, ctx.clock.now());
    const runs: WorkflowRun[] = [];
    for (const item of due) {
      try {
        const run = await this.runDue(ctx, item);
        if (run) runs.push(run);
      } catch (err) {
        safeLog(ctx, 'error', 'scheduler.schedule_error', {
          schedule_id: item.schedule.id,
          workflow: item.schedule.workflow,
          dealer_id: item.schedule.dealer_id,
          error: describeError(err),
        });
      }
    }
    return runs;
  }

  /**
   * Run `tick()` every `intervalMs` (timer unref'd). A tick is skipped while the previous one is
   * still running. Returns `stop()`.
   */
  start(ctx: AppContext, intervalMs: number, opts: { immediate?: boolean } = {}): () => void {
    if (!Number.isFinite(intervalMs) || intervalMs < 1 || intervalMs > MAX_INTERVAL_MS) {
      throw new ValidationError('intervalMs', `must be between 1 and ${MAX_INTERVAL_MS} milliseconds`);
    }
    let ticking = false;
    let stopped = false;
    const runTick = async () => {
      if (stopped) return;
      if (ticking) {
        safeLog(ctx, 'debug', 'scheduler.tick_skipped_overlap', { interval_ms: intervalMs });
        return;
      }
      ticking = true;
      try {
        const runs = await this.tick(ctx);
        if (runs.length > 0) {
          safeLog(ctx, 'info', 'scheduler.tick', { started: runs.length, runs: runs.map((r) => ({ id: r.id, workflow: r.workflow, status: r.status })) });
        }
      } catch (err) {
        safeLog(ctx, 'error', 'scheduler.tick_failed', { error: describeError(err) });
      } finally {
        ticking = false;
      }
    };
    const timer = setInterval(() => {
      void runTick();
    }, intervalMs);
    timer.unref();
    let immediate: ReturnType<typeof setTimeout> | null = null;
    if (opts.immediate) {
      immediate = setTimeout(() => {
        void runTick();
      }, 0);
      immediate.unref();
    }
    safeLog(ctx, 'info', 'scheduler.started', { interval_ms: intervalMs });
    return () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (immediate) clearTimeout(immediate);
      safeLog(ctx, 'info', 'scheduler.stopped', {});
    };
  }

  // ───────────────────────────────────────────────────────────────────────────

  private async runDue(ctx: AppContext, item: DueSchedule): Promise<WorkflowRun | null> {
    const { schedule } = item;
    if (!this.engine.has(schedule.workflow)) {
      this.warnThrottled(ctx, `unregistered:${schedule.id}`, 'scheduler.unregistered_workflow', {
        schedule_id: schedule.id,
        dealer_id: schedule.dealer_id,
        workflow: schedule.workflow,
      });
      return null;
    }
    const running = this.engine.findRunningRun(ctx, schedule.workflow, schedule.dealer_id);
    if (running) {
      safeLog(ctx, 'info', 'scheduler.skipped_running', {
        schedule_id: schedule.id,
        workflow: schedule.workflow,
        dealer_id: schedule.dealer_id,
        running_run_id: running.id,
      });
      return null;
    }

    const claimedAt = ctx.clock.iso();
    const claim = ctx.db.run(
      'UPDATE schedules SET last_run_at = ? WHERE id = ? AND enabled = 1 AND last_run_at IS ?',
      claimedAt,
      schedule.id,
      schedule.last_run_at,
    );
    if (claim.changes !== 1) {
      safeLog(ctx, 'info', 'scheduler.claim_lost', { schedule_id: schedule.id, workflow: schedule.workflow });
      return null;
    }

    const started: { id: string | null } = { id: null };
    let run: WorkflowRun;
    try {
      run = await this.engine.start(
        ctx,
        schedule.workflow,
        {
          dealer_id: schedule.dealer_id,
          schedule_id: schedule.id,
          cron: schedule.cron,
          scheduled_at: item.due_at.toISOString(),
          timezone: item.timezone,
        },
        {
          trigger: 'schedule',
          dealer_id: schedule.dealer_id,
          singleton: true,
          actor: 'scheduler',
          onStarted: (r) => {
            started.id = r.id;
            ctx.db.table('schedules').update(schedule.id, { last_run_id: r.id });
          },
        },
      );
    } catch (err) {
      this.recordStartFailure(ctx, item, claimedAt, started.id, err);
      return null;
    }
    // Only the engine call above decides success: logging below is best-effort and can never turn a
    // finished run into a reported start failure.
    if (started.id === null) {
      // Another starter won the singleton race after our check: release the claim for a later tick.
      this.releaseClaim(ctx, schedule, claimedAt);
      safeLog(ctx, 'info', 'scheduler.skipped_running', {
        schedule_id: schedule.id,
        workflow: schedule.workflow,
        dealer_id: schedule.dealer_id,
        running_run_id: run.id,
      });
      return null;
    }
    safeLog(ctx, 'info', 'scheduler.run_finished', {
      schedule_id: schedule.id,
      workflow: schedule.workflow,
      dealer_id: schedule.dealer_id,
      run_id: run.id,
      status: run.status,
    });
    return run;
  }

  /** Give the due window back (only if nobody else claimed it since). Returns true when released. */
  private releaseClaim(ctx: AppContext, schedule: Schedule, claimedAt: string): boolean {
    const res = ctx.db.run(
      'UPDATE schedules SET last_run_at = ? WHERE id = ? AND last_run_at = ?',
      schedule.last_run_at,
      schedule.id,
      claimedAt,
    );
    return res.changes === 1;
  }

  /**
   * `engine.start` threw.
   * - A run exists (it failed while executing): the window stays used; `last_run_id` already points at it.
   * - No run exists and the error is an AppError (unknown dealer, invalid or unresolvable definition):
   *   deterministic, so the window stays used rather than retrying a broken definition on every tick.
   * - No run exists and the error is anything else (e.g. the database is locked): infrastructure. The
   *   window is released so a later tick retries instead of silently skipping the day's job.
   */
  private recordStartFailure(ctx: AppContext, item: DueSchedule, claimedAt: string, runId: string | null, err: unknown): void {
    const { schedule } = item;
    const error = describeError(err);
    let windowReleased = false;
    if (runId === null && !(err instanceof AppError)) {
      try {
        windowReleased = this.releaseClaim(ctx, schedule, claimedAt);
      } catch (releaseErr) {
        safeLog(ctx, 'error', 'scheduler.claim_release_failed', {
          schedule_id: schedule.id,
          workflow: schedule.workflow,
          error: describeError(releaseErr),
        });
      }
    }
    safeLog(ctx, 'error', 'scheduler.start_failed', {
      schedule_id: schedule.id,
      workflow: schedule.workflow,
      dealer_id: schedule.dealer_id,
      run_id: runId,
      window_released: windowReleased,
      error,
    });
    ctx.audit.event({
      actor: 'scheduler',
      action: 'schedule.start_failed',
      entity_type: 'schedule',
      entity_id: schedule.id,
      details: {
        dealer_id: schedule.dealer_id,
        workflow: schedule.workflow,
        cron: schedule.cron,
        run_id: runId,
        window_released: windowReleased,
        error,
      },
    });
  }

  private timezoneOf(ctx: AppContext, dealer: Dealer | undefined): string {
    if (!dealer || !dealer.settings?.timezone) return DEFAULT_TZ;
    const tz = dealer.settings.timezone;
    if (isValidTimeZone(tz)) return tz;
    this.warnThrottled(ctx, `tz:${dealer.id}:${tz}`, 'scheduler.invalid_timezone', {
      dealer_id: dealer.id,
      timezone: tz,
      fallback: DEFAULT_TZ,
    });
    return DEFAULT_TZ;
  }

  /** Warn at most once per hour (clock time) per key so a misconfiguration does not flood logs. */
  private warnThrottled(ctx: AppContext, key: string, msg: string, data: Record<string, unknown>): void {
    const nowMs = ctx.clock.now().getTime();
    const last = this.warnedAt.get(key);
    if (last !== undefined && nowMs - last < WARN_THROTTLE_MS && nowMs >= last) return;
    this.warnedAt.set(key, nowMs);
    safeLog(ctx, 'warn', msg, data);
  }
}
