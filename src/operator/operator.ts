/**
 * Automotive Operator (spec §3): the AI operations employee. Operators state business goals; the operator parses them,
 * plans the work from real Dealer Brain rows, persists the goal with its plan and an auditable 'goal_planning'
 * decision, and executes it through the observable, resumable workflow engine. It also runs the daily rhythm on demand.
 */
import type { AppContext } from '../app/context.ts';
import { AppError, ValidationError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import type { Evidence, GoalStatus, OperatorGoal, WorkflowRun } from '../core/types.ts';
import { GOAL_STATUSES } from '../core/types.ts';
import { getDealer } from '../skills/operations/dealer-brain/index.ts';
import { parseGoal, type GoalCatalog } from './goal-parser.ts';
import { explainPlan, planGoal } from './planner.ts';
import { DEFAULT_DAILY_SCHEDULE } from './scheduler.ts';
import { describeError, safeLog, type WorkflowEngine } from './workflow-engine.ts';
import { GOAL_WORKFLOW } from './workflows.ts';

export const OPERATOR_AGENT = 'automotive-operator';

export interface SubmitGoalInput {
  dealer_id: string;
  text: string;
  actor: string;
}

export interface SubmitGoalOptions {
  /** return as soon as the run row exists (status RUNNING); execution continues in the background */
  background?: boolean;
}

export class AutomotiveOperator {
  readonly engine: WorkflowEngine;

  constructor(engine: WorkflowEngine) {
    this.engine = engine;
  }

  /** Dealer catalog for goal parsing: models of the dealer's brands in its group. */
  catalogFor(ctx: AppContext, dealerId: string): GoalCatalog {
    const dealer = getDealer(ctx, dealerId);
    const brands = new Set(dealer.brands.map((b) => b.toLowerCase()));
    const byModel = new Map<string, { brand: string; model: string; aliases: string[] }>();
    for (const veh of ctx.db.table('vehicles').findMany({ group_id: dealer.group_id })) {
      if (brands.size > 0 && !brands.has(veh.brand.toLowerCase()) && !brands.has(veh.brand_zh.toLowerCase())) continue;
      const entry = byModel.get(veh.model) ?? { brand: veh.brand, model: veh.model, aliases: [] };
      for (const a of [veh.model_zh, ...veh.aliases]) if (a && !entry.aliases.includes(a)) entry.aliases.push(a);
      byModel.set(veh.model, entry);
    }
    return { models: [...byModel.values()] };
  }

  async submitGoal(ctx: AppContext, input: SubmitGoalInput, opts: SubmitGoalOptions = {}): Promise<{ goal: OperatorGoal; run: WorkflowRun }> {
    if (!input || typeof input.dealer_id !== 'string' || !input.dealer_id) throw new ValidationError('dealer_id', '需要门店 dealer_id');
    const dealer = getDealer(ctx, input.dealer_id);
    const actor = typeof input.actor === 'string' && input.actor.trim() ? input.actor.trim() : 'operator';
    const catalog = this.catalogFor(ctx, dealer.id);
    const spec = parseGoal(input.text, dealer, ctx.clock.now(), catalog);
    const plan = planGoal(ctx, dealer, spec);
    const preview = explainPlan(ctx, dealer, spec);
    const now = ctx.clock.iso();
    const stated = [spec.models.length > 0, Boolean(spec.location || spec.province), Boolean(spec.timeframe), Boolean(spec.target_leads)].filter(Boolean).length;

    const goal = ctx.db.tx(() => {
      const row = ctx.db.table('operator_goals').insert({
        id: newId('goal'),
        dealer_id: dealer.id,
        text: input.text.normalize('NFKC').trim(),
        spec,
        status: 'active',
        plan,
        created_at: now,
        updated_at: now,
      });
      const evidence: Evidence[] = (spec.notes ?? []).map((note) => ({ code: 'goal_interpretation', label: note, source_ref: row.id }));
      ctx.audit.decision({
        agent: OPERATOR_AGENT,
        skill: OPERATOR_AGENT,
        decision_type: 'goal_planning',
        subject_type: 'goal',
        subject_id: row.id,
        inputs: { text: row.text, dealer_id: dealer.id, actor },
        evidence,
        output: { spec, plan, preview, workflow: GOAL_WORKFLOW },
        confidence: Math.min(0.9, 0.5 + stated * 0.1),
        engine: 'rules',
      });
      ctx.audit.event({
        actor: actor.startsWith('operator:') || actor.includes(':') ? actor : `operator:${actor}`,
        action: 'goal.created',
        entity_type: 'operator_goal',
        entity_id: row.id,
        details: { type: spec.type, models: spec.models, location: spec.location ?? null, timeframe: spec.timeframe ?? null },
      });
      return row;
    });

    const workflowInput = { dealer_id: dealer.id, goal_id: goal.id, goal_type: spec.type };
    const startOpts = { trigger: 'goal' as const, dealer_id: dealer.id, goal_id: goal.id, actor };
    if (opts.background) {
      const run = await new Promise<WorkflowRun>((resolve, reject) => {
        let started = false;
        this.engine
          .start(ctx, GOAL_WORKFLOW, workflowInput, {
            ...startOpts,
            onStarted: (r) => {
              started = true;
              resolve(r);
            },
          })
          .then(
            (r) => resolve(r),
            (err: unknown) => {
              if (started) safeLog(ctx, 'error', 'operator.goal_run_failed', { goal_id: goal.id, error: describeError(err) });
              else reject(err);
            },
          );
      });
      return { goal: ctx.db.table('operator_goals').require(goal.id), run };
    }
    const run = await this.engine.start(ctx, GOAL_WORKFLOW, workflowInput, startOpts);
    return { goal: ctx.db.table('operator_goals').require(goal.id), run };
  }

  /** Run the daily workflows once, in pipeline order (manual trigger; a workflow already running is not duplicated). */
  async runDaily(ctx: AppContext, dealerId: string, actor = 'operator'): Promise<WorkflowRun[]> {
    getDealer(ctx, dealerId);
    const runs: WorkflowRun[] = [];
    const seen = new Set<string>();
    for (const entry of DEFAULT_DAILY_SCHEDULE) {
      if (seen.has(entry.workflow) || !this.engine.has(entry.workflow)) continue;
      seen.add(entry.workflow);
      runs.push(await this.engine.start(ctx, entry.workflow, { dealer_id: dealerId }, { trigger: 'manual', dealer_id: dealerId, actor, singleton: true }));
    }
    return runs;
  }

  async runWorkflow(ctx: AppContext, name: string, dealerId: string, actor = 'operator', input: Record<string, unknown> = {}): Promise<WorkflowRun> {
    getDealer(ctx, dealerId);
    if (name === GOAL_WORKFLOW) throw new AppError('goal_workflow_requires_goal', '经营目标工作流请通过 submitGoal 下达', 422);
    return this.engine.start(ctx, name, { ...input, dealer_id: dealerId }, { trigger: 'manual', dealer_id: dealerId, actor, singleton: true });
  }

  listGoals(ctx: AppContext, dealerId: string, status?: GoalStatus): OperatorGoal[] {
    return ctx.db.table('operator_goals').findMany({ dealer_id: dealerId, status }, { orderBy: 'created_at DESC, id DESC' });
  }

  /** Operator pause / resume / close of a goal. */
  setGoalStatus(ctx: AppContext, goalId: string, status: GoalStatus, actor: string): OperatorGoal {
    if (!GOAL_STATUSES.includes(status)) throw new ValidationError('status', `需要 ${GOAL_STATUSES.join('|')}`);
    const goal = ctx.db.table('operator_goals').require(goalId);
    if (goal.status === status) return goal;
    return ctx.db.tx(() => {
      const updated = ctx.db.table('operator_goals').update(goalId, { status });
      ctx.audit.event({ actor, action: 'goal.status_changed', entity_type: 'operator_goal', entity_id: goalId, details: { from: goal.status, to: status } });
      return updated;
    });
  }
}
