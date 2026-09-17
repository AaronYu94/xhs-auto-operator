/**
 * Automotive Query Generator + Search Intelligence (spec §5, §19).
 *
 * `generateQueries` turns a dealer goal into persisted search queries across five classes (direct model,
 * competitor, purchase scenario, transaction intent, location) grounded in Dealer Brain rows. The search-intelligence
 * functions measure each query by the leads it actually produced and evolve the query set over time.
 */
import type { AppContext } from '../../../app/context.ts';
import { ValidationError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import { clamp, round } from '../../../core/text.ts';
import { GOAL_TYPES } from '../../../core/types.ts';
import type { GoalSpec, SearchQuery } from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import { defineSkill } from '../../registry.ts';
import { getDealer } from '../../operations/dealer-brain/index.ts';
import { QUERY_ACTOR, QUERY_AGENT, QUERY_SKILL, completedRunCounts } from './intelligence.ts';
import { GENERATED_QUERY_CLASSES, buildQueryPlan, queryKey, type GeneratedQueryClass, type PlannedQuery } from './plan.ts';

export {
  BUDGET_BRACKET_WAN,
  FALLBACK_MODEL_CAP,
  GENERATED_QUERY_CLASSES,
  MAX_COMPETITORS_PER_MODEL,
  PRIORITY_MODEL_BOOST,
  QUERY_CLASS_PRIORS,
  budgetBracketWan,
  buildPlannedQueries,
  buildQueryPlan,
  queryKey,
  resolveQueryTargets,
  trimAlias,
  type BrandTarget,
  type EntryPrice,
  type GeneratedQueryClass,
  type InStockTrim,
  type ModelTarget,
  type PlannedQuery,
  type QueryPlan,
  type QueryPlanTargets,
} from './plan.ts';
export {
  FEEDBACK,
  QUERY_ACTOR,
  QUERY_AGENT,
  QUERY_SKILL,
  completedRunCounts,
  evolveQueries,
  getQueryEffectiveness,
  selectQueriesToRun,
  smoothedDensity,
  type EvolveResult,
  type PriorityChange,
  type QueryEffectiveness,
} from './intelligence.ts';

export interface QueryPlanInput {
  dealer_id: string;
  goal: GoalSpec;
  goal_id?: string | null;
}

const shortText = v.string({ min: 1, max: 60 });

export const goalSpecValidator = v.object({
  type: v.literal(GOAL_TYPES),
  brand: v.optional(shortText),
  models: v.withDefault(v.array(shortText, { max: 20 }), []),
  location: v.optional(shortText),
  province: v.optional(shortText),
  timeframe: v.optional(v.object({ label: v.string(), start: v.string(), end: v.string() })),
  target_leads: v.optional(v.number({ min: 0, int: true })),
  notes: v.optional(v.array(v.string({ max: 500 }), { max: 50 })),
});

export const queryPlanInputValidator = v.object({
  dealer_id: v.string({ min: 1 }),
  goal: goalSpecValidator,
  goal_id: v.optional(v.nullable(v.string({ min: 1 }))),
});

/** Validate the input and build the query plan without persisting anything (preview). */
export function planQueries(ctx: AppContext, input: QueryPlanInput): PlannedQuery[] {
  const parsed = queryPlanInputValidator(input, 'input');
  return buildQueryPlan(ctx, getDealer(ctx, parsed.dealer_id), parsed.goal).queries;
}

/**
 * Generate and persist the goal's search queries (spec §5). Dedup by (dealer_id, normalized text): an existing row
 * keeps its id; a null goal_id is attached; retired queries stay retired. Its priority is raised when the new prior is
 * higher and either the query has no completed run yet or the call is a NEW goal for that row; a paused query is
 * reactivated only for a NEW goal. A goal is new for a row when the row is attached to another goal (or none) and the
 * goal has never been planned for this dealer before (no earlier `query_generation` decision) — so a goal gets one
 * chance to lift / reactivate a shared query, and re-running any already-planned goal (the daily plan) never undoes
 * what evolveQueries learned (priorities, pauses).
 * Returns the plan's rows in class order (direct_model, competitor, purchase_scenario, transaction_intent, location).
 */
export function generateQueries(ctx: AppContext, input: QueryPlanInput): SearchQuery[] {
  const parsed = queryPlanInputValidator(input, 'input');
  const dealer = getDealer(ctx, parsed.dealer_id);
  const goalId = parsed.goal_id ?? null;
  if (goalId !== null) {
    const goalRow = ctx.db.table('operator_goals').get(goalId);
    if (goalRow && goalRow.dealer_id !== dealer.id) {
      throw new ValidationError('goal_id', `goal ${goalId} belongs to another dealer`);
    }
  }
  const goal: GoalSpec = parsed.goal;
  const plan = buildQueryPlan(ctx, dealer, goal);
  if (plan.queries.length === 0) {
    throw new ValidationError('goal', 'no search query could be generated: the goal resolves to no brand, model or location');
  }

  return ctx.db.tx(() => {
    const table = ctx.db.table('search_queries');
    const existing = new Map(table.findMany({ dealer_id: dealer.id }).map((q) => [queryKey(q.text), q]));
    const runs = completedRunCounts(ctx, dealer.id);
    const now = ctx.clock.iso();
    const rows: SearchQuery[] = [];
    const created: SearchQuery[] = [];
    const updated: { query_id: string; text: string; changes: Record<string, { from: unknown; to: unknown }> }[] = [];
    const reactivated: SearchQuery[] = [];
    // A goal lifts / reactivates shared queries only the first time it is planned for this dealer (see doc comment).
    const goalPlannedBefore =
      goalId !== null &&
      ctx.db
        .table('agent_decisions')
        .findMany({ decision_type: 'query_generation', subject_type: 'goal', subject_id: goalId })
        .some((d) => d.inputs.dealer_id === dealer.id);

    for (const p of plan.queries) {
      const key = queryKey(p.text);
      const row = existing.get(key);
      if (!row) {
        const inserted = table.insert({
          id: newId('q'),
          dealer_id: dealer.id,
          goal_id: goalId,
          text: p.text,
          query_class: p.query_class,
          brand: p.brand,
          model: p.model,
          location: p.location,
          priority: p.priority,
          status: 'active',
          parent_query_id: null,
          generation_reason: p.generation_reason,
          created_at: now,
          updated_at: now,
        });
        existing.set(key, inserted);
        created.push(inserted);
        rows.push(inserted);
        continue;
      }

      if (row.status === 'retired') {
        // retired by evidence (evolveQueries): never revived, re-prioritized or re-attached by generation
        rows.push(row);
        continue;
      }
      const patch: Partial<SearchQuery> = {};
      const diff: Record<string, { from: unknown; to: unknown }> = {};
      const newGoal = goalId !== null && row.goal_id !== goalId && !goalPlannedBefore;
      if (p.priority > row.priority + 1e-9 && ((runs.get(row.id) ?? 0) === 0 || newGoal)) {
        patch.priority = p.priority;
        diff.priority = { from: row.priority, to: p.priority };
      }
      if (row.goal_id === null && goalId !== null) {
        patch.goal_id = goalId;
        diff.goal_id = { from: null, to: goalId };
      }
      if (row.status === 'paused' && newGoal) {
        patch.status = 'active';
        diff.status = { from: 'paused', to: 'active' };
      }
      if (Object.keys(patch).length === 0) {
        rows.push(row);
        continue;
      }
      const next = table.update(row.id, patch);
      existing.set(key, next);
      rows.push(next);
      updated.push({ query_id: next.id, text: next.text, changes: diff });
      if (diff.status) {
        reactivated.push(next);
        ctx.audit.event({
          actor: QUERY_ACTOR,
          action: 'search_query.reactivated',
          entity_type: 'search_query',
          entity_id: next.id,
          details: { text: next.text, goal_id: goalId, previous_goal_id: row.goal_id },
        });
      }
    }

    const classCounts = Object.fromEntries(GENERATED_QUERY_CLASSES.map((c) => [c, 0])) as Record<GeneratedQueryClass, number>;
    for (const p of plan.queries) classCounts[p.query_class]++;

    if (created.length > 0 || updated.length > 0) {
      ctx.audit.event({
        actor: QUERY_ACTOR,
        action: 'search_queries.generated',
        entity_type: 'dealer',
        entity_id: dealer.id,
        details: {
          goal_id: goalId,
          created: created.map((q) => ({ query_id: q.id, text: q.text, query_class: q.query_class, priority: q.priority })),
          updated,
        },
      });
    }

    const t = plan.targets;
    const usedFallback = t.location_source === 'dealer' || t.model_source === 'inventory';
    ctx.audit.decision({
      agent: QUERY_AGENT,
      skill: QUERY_SKILL,
      decision_type: 'query_generation',
      subject_type: goalId !== null ? 'goal' : 'dealer',
      subject_id: goalId ?? dealer.id,
      inputs: {
        dealer_id: dealer.id,
        goal_id: goalId,
        goal,
        resolved: {
          brands: t.brands.map((b) => ({ brand: b.brand, brand_zh: b.brand_zh })),
          models: t.brands.flatMap((b) =>
            b.models.map((m) => ({
              model: m.model,
              model_zh: m.model_zh,
              priority: m.priority,
              in_stock: m.in_stock_quantity,
              in_transit: m.in_transit_quantity,
              in_stock_trims: m.in_stock_trims.map((x) => x.alias),
              budget_bracket_wan: m.entry?.bracket_wan ?? null,
              net_price: m.entry?.net_price ?? null,
              finance_offer: m.finance_offers[0]?.id ?? null,
              lease_offer: m.lease_offers[0]?.id ?? null,
            })),
          ),
          city: t.city,
          province: t.province,
          location_source: t.location_source,
          ignored_province: t.ignored_province,
          area: t.area,
          model_source: t.model_source,
          skipped_models: t.skipped_models,
          omitted_models: t.omitted_models,
          trade_in_offer: t.trade_in_offers[0]?.id ?? null,
        },
      },
      evidence: plan.evidence,
      output: {
        classes: classCounts,
        total: rows.length,
        created: created.length,
        updated: updated.length,
        reactivated: reactivated.length,
        unchanged: rows.length - created.length - updated.length,
        queries: rows.map((q) => ({ query_id: q.id, text: q.text, query_class: q.query_class, priority: q.priority, status: q.status })),
      },
      confidence: round(
        clamp(
          (usedFallback ? 0.8 : 0.9) -
            (t.skipped_models.length > 0 ? 0.1 : 0) -
            // §5.2: explicitly out-of-area buyers never become Qualified here; §5.3: routed to another group store
            (t.area.status === 'out_of_area' ? 0.2 : t.area.status === 'group_dealer' ? 0.1 : 0) -
            (t.ignored_province !== null ? 0.05 : 0),
          0,
          1,
        ),
        4,
      ),
      engine: 'rules',
    });

    return rows;
  });
}

export const skill = defineSkill<QueryPlanInput, SearchQuery[]>({
  name: 'automotive-query-generation',
  category: 'acquisition',
  agent: 'lead-hunting-agent',
  description:
    '根据经营目标（品牌、车型、地域）与Dealer Brain真实数据（在售车型、现车配置、当期现金/金融/租赁/置换政策、门店城市）生成五类小红书搜索词（直接车型、竞品对比、购车场景、交易意图、地域），按类别先验与重点车型设定优先级，按文本去重持久化并记录生成依据。',
  input: queryPlanInputValidator,
  run: (ctx, input) => generateQueries(ctx, input),
  validateOutput(output) {
    if (!Array.isArray(output) || output.length === 0) throw new Error('automotive-query-generation: no queries were produced');
    for (const q of output) {
      if (typeof q.text !== 'string' || q.text.trim() === '') throw new Error('automotive-query-generation: empty query text');
      if (!(q.priority >= 0 && q.priority <= 1)) throw new Error(`automotive-query-generation: priority out of range for "${q.text}"`);
      if (typeof q.generation_reason !== 'string' || q.generation_reason.trim() === '')
        throw new Error(`automotive-query-generation: missing generation_reason for "${q.text}"`);
    }
  },
});
