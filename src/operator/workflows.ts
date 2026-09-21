/**
 * Automotive Operator workflows (spec §3, §20; ARCHITECTURE §8 D1).
 *
 * Every workflow step calls the real skill modules. A step that legitimately cannot act — the Xiaohongshu capability
 * is not AVAILABLE, a session requires login, there is nothing to process — returns `skipStep(reason, details)` so the
 * run stays observable and honest. No step fabricates data, and nothing here falls back to simulation: the provider
 * in `ctx.xhs` is whatever the runtime configured.
 *
 * Daily rhythm (DEFAULT_DAILY_SCHEDULE): refresh_dealer_data 08:00 · market_research 08:30 · account_planning 09:00 ·
 * lead_discovery 09:30 · signal_processing every 60 min · reply_processing every 30 min · content_publishing every 60 min ·
 * performance_collection 18:00 · evening_analysis 20:00. Goals run `goal_execution`, whose steps depend on the goal type.
 */
import type { AppContext } from '../app/context.ts';
import { AppError, NotFoundError, PolicyError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { DAY_MS, DEFAULT_TZ, addDaysToKey, localDateKey } from '../core/time.ts';
import {
  LEAD_STAGES,
  type Dealer,
  type GoalSpec,
  type GoalStatus,
  type GoalType,
  type LeadStage,
  type OperatorGoal,
  type ResearchBrief,
} from '../core/types.ts';
import type { CapabilityReport } from '../providers/xhs/types.ts';
import { assignLead, getActiveAssignment } from '../skills/acquisition/account-assignment/index.ts';
import { STAGE_INDEX } from '../skills/operations/crm/index.ts';
import { evolveQueries, generateQueries } from '../skills/acquisition/automotive-query-generation/index.ts';
import { dataModeForProvider, ingestPublicContent, runDiscovery } from '../skills/acquisition/lead-discovery/index.ts';
import { researchLead } from '../skills/acquisition/lead-research/index.ts';
import { reviewPost } from '../skills/content/content-review/index.ts';
import { planContent } from '../skills/content/content-planning/index.ts';
import { draftEngagementReplies } from '../skills/content/engagement/index.ts';
import { generatePost } from '../skills/content/post-generation/index.ts';
import { collectPerformance, publishDuePosts } from '../skills/content/publishing/index.ts';
import { computeFleetHealth } from '../skills/operations/account-health/index.ts';
import { recordCapabilitySnapshots, syncFleetAuth } from '../skills/operations/account-sessions/index.ts';
import { getDealer, getKnowledge, isOfferActive } from '../skills/operations/dealer-brain/index.ts';
import { syncAccountNotifications } from '../skills/operations/notification-inbox/index.ts';
import { refreshDealerVoices } from '../skills/content/account-voice/index.ts';
import { runOptimization } from '../skills/operations/optimization/index.ts';
import { generateOperatorReport } from '../skills/operations/reporting/index.ts';
import { runMarketResearch } from '../skills/research/automotive-market-research/index.ts';
import { runCompetitorResearch } from '../skills/research/competitor-research/index.ts';
import { runTrendDetectionWithProvider } from '../skills/research/trend-detection/index.ts';
import { runXhsResearch } from '../skills/research/xhs-research/index.ts';
import { pollInbox } from '../skills/sales/conversation/index.ts';
import { planFollowUps } from '../skills/sales/follow-up/index.ts';
import { prepareOutreach } from '../skills/sales/outreach/index.ts';
import { goalTargets } from './goal-parser.ts';
import { DEFAULT_DAILY_SCHEDULE } from './scheduler.ts';
import { skipStep, type StepContext, type WorkflowDef, type WorkflowStepDef } from './workflow-engine.ts';

export const GOAL_WORKFLOW = 'goal_execution';
export const MAX_RESEARCH_PER_RUN = 20;
export const MAX_ASSIGN_PER_RUN = 200;
/**
 * Stages where a lead needs an owning account. Leads belong to the store, so a lead that lost its owner (its account
 * left the fleet) is picked up here again at whatever stage it reached — not only fresh QUALIFIED ones.
 */
export const ASSIGNABLE_STAGES: readonly LeadStage[] = LEAD_STAGES.filter(
  (stage) => STAGE_INDEX[stage] >= STAGE_INDEX.QUALIFIED && stage !== 'WON' && stage !== 'LOST',
);
export const MAX_OUTREACH_PER_RUN = 50;
export const MAX_POSTS_PER_RUN = 30;
export const MAX_OWN_NOTE_COMMENTS = 100;
export const CONTENT_LOOKAHEAD_DAYS = 2;
export const EXPIRY_HORIZON_DAYS = 3;
export const RECOMMENDED_FLEET_SIZE = 5;
export const PLAN_DAYS = 7;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function dealerIdOf(sc: Pick<StepContext, 'run' | 'input'>): string {
  const id = sc.run.dealer_id ?? (typeof sc.input.dealer_id === 'string' ? sc.input.dealer_id : null);
  if (!id) throw new AppError('workflow_dealer_required', `工作流 ${sc.run.workflow} 需要 dealer_id`, 422, { workflow: sc.run.workflow });
  return id;
}

function goalIdOf(sc: Pick<StepContext, 'run' | 'input'>): string | null {
  return sc.run.goal_id ?? (typeof sc.input.goal_id === 'string' && sc.input.goal_id ? sc.input.goal_id : null);
}

const tzOf = (dealer: Pick<Dealer, 'settings'>) => dealer.settings?.timezone || DEFAULT_TZ;
const todayKey = (ctx: AppContext, dealer: Dealer) => localDateKey(ctx.clock.now(), tzOf(dealer));
const positiveInt = (x: unknown): number | undefined => (typeof x === 'number' && Number.isInteger(x) && x > 0 ? x : undefined);

/** The goal a run works for: the run's goal, else the dealer's most recent active goal. */
export function resolveGoal(ctx: AppContext, dealerId: string, goalId: string | null): OperatorGoal | null {
  const table = ctx.db.table('operator_goals');
  if (goalId) {
    const goal = table.get(goalId);
    if (!goal) throw new NotFoundError('operator_goal', goalId);
    if (goal.dealer_id !== dealerId) {
      throw new AppError('goal_dealer_mismatch', `经营目标 ${goalId} 不属于门店 ${dealerId}`, 422, { goal_id: goalId, dealer_id: dealerId });
    }
    return goal;
  }
  return table.findOne({ dealer_id: dealerId, status: 'active' }, { orderBy: 'created_at DESC, id DESC' }) ?? null;
}

function activeAccounts(ctx: AppContext, dealerId: string) {
  return ctx.db.table('xhs_accounts').findMany({ dealer_id: dealerId, status: 'active' }, { orderBy: 'created_at ASC, id ASC' });
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');
const CHAIN: LeadStage[] = LEAD_STAGES.filter((s) => s !== 'LOST');
const stagesFrom = (stage: LeadStage): LeadStage[] => CHAIN.slice(CHAIN.indexOf(stage));

function briefSummary(brief: ResearchBrief): Record<string, unknown> {
  return {
    brief_id: brief.id,
    kind: brief.kind,
    headline: brief.findings.headline,
    insights: brief.findings.insights.length,
    source_counts: brief.source_counts,
    engine: brief.engine,
  };
}

type StepRun = WorkflowStepDef['run'];
const step = (
  key: string,
  agent: WorkflowStepDef['agent'],
  skill: string,
  description: string,
  run: StepRun,
  extra: Pick<WorkflowStepDef, 'optional' | 'retries' | 'retryDelayMs'> = {},
): WorkflowStepDef => ({ key, agent, skill, description, run, ...extra });

// ─────────────────────────────────────────────────────────────────────────────
// Step factories
// ─────────────────────────────────────────────────────────────────────────────

/** Dealer Brain freshness: expiring offers/knowledge, empty catalog/inventory, fleet size. */
export function checkDealerFactsStep(): WorkflowStepDef {
  return step('check_dealer_facts', 'automotive-operator', 'dealer-brain', '检查 Dealer Brain：即将到期的优惠与知识、车型/库存是否为空、账号数量', ({ ctx, run, input }) => {
    const dealer = getDealer(ctx, dealerIdOf({ run, input }));
    const now = ctx.clock.now();
    const today = todayKey(ctx, dealer);
    const horizon = addDaysToKey(today, EXPIRY_HORIZON_DAYS);
    const offers = ctx.db.table('offers').findMany({ dealer_id: dealer.id }, { orderBy: 'valid_until ASC' });
    const active = offers.filter((o) => isOfferActive(o, dealer, now));
    const expiring = active.filter((o) => o.valid_until.slice(0, 10) <= horizon);
    const knowledge = getKnowledge(ctx, dealer.id).filter((k) => k.valid_until && k.valid_until.slice(0, 10) <= horizon);
    const vehicles = ctx.db.table('vehicles').count({ group_id: dealer.group_id });
    const inventory = ctx.db.table('inventory').findMany({ dealer_id: dealer.id });
    const inStock = inventory.filter((i) => i.status === 'in_stock').reduce((s, i) => s + i.quantity, 0);
    const accounts = activeAccounts(ctx, dealer.id).length;
    const warnings: string[] = [];
    if (vehicles === 0) warnings.push('Dealer Brain 没有车型数据：请导入经销商资料（车型/价格）');
    if (inventory.length === 0) warnings.push('门店没有库存数据：私信与内容不会提及现车');
    if (active.length === 0) warnings.push('门店当前没有有效优惠政策：内容与私信不会提及优惠');
    if (accounts < RECOMMENDED_FLEET_SIZE) warnings.push(`当前只有 ${accounts} 个活跃小红书账号（建议 ≥ ${RECOMMENDED_FLEET_SIZE}）`);
    for (const o of expiring) warnings.push(`优惠「${o.title}」将于 ${o.valid_until} 到期`);
    for (const k of knowledge) warnings.push(`知识「${k.title}」将于 ${k.valid_until} 到期`);
    return {
      today,
      vehicles,
      inventory_rows: inventory.length,
      in_stock_quantity: inStock,
      offers_active: active.length,
      offers_expiring: expiring.map((o) => ({ id: o.id, title: o.title, valid_until: o.valid_until })),
      knowledge_expiring: knowledge.map((k) => ({ id: k.id, title: k.title, valid_until: k.valid_until })),
      active_accounts: accounts,
      warnings,
    };
  });
}

export function accountHealthStep(): WorkflowStepDef {
  return step('account_health', 'fleet-controller', 'account-health', '计算每个账号今日健康度（触达量、负反馈、回复率、登录状态）', ({ ctx, run, input }) => {
    const rows = computeFleetHealth(ctx, dealerIdOf({ run, input }));
    return {
      accounts: rows.map((h) => ({ account_id: h.account_id, state: h.state, health_score: h.health_score, issues: h.issues })),
      by_state: countBy(rows, (h) => h.state),
    };
  });
}

export function accountSessionsStep(): WorkflowStepDef {
  return step(
    'account_sessions',
    'fleet-controller',
    'account-sessions',
    '检测每个账号的小红书登录会话（未登录/登录错账号会暂停自动动作）',
    async ({ ctx, run, input }) => {
      if (!ctx.xhs.auth) return skipStep(`当前小红书接入（${ctx.xhs.name}，模式 ${ctx.xhs.mode}）不支持登录状态检测`, { provider: ctx.xhs.name, mode: ctx.xhs.mode });
      const results = await syncFleetAuth(ctx, dealerIdOf({ run, input }));
      return {
        accounts: results.map((r) => ({
          account_id: r.account.id,
          nickname: r.account.nickname,
          status: r.status,
          auth_state: r.account.auth_state,
          applicable: r.applicable,
          reason: r.reason,
        })),
        by_status: countBy(results, (r) => r.status),
      };
    },
    { optional: true },
  );
}

/**
 * Probe capabilities (provider-level + every active account), persist them as capability_snapshots (plus the LLM
 * status) so the console and the operator report show what is genuinely available.
 */
export function capabilitySnapshotStep(): WorkflowStepDef {
  return step(
    'capability_snapshot',
    'automotive-operator',
    'account-sessions',
    '检测小红书接入能力（搜索/读取/发布/私信）并记录快照，不可用的能力会在日报中标出',
    async ({ ctx, run, input }) => {
      const dealerId = dealerIdOf({ run, input });
      const reports: CapabilityReport[] = [await ctx.xhs.capabilities(null)];
      for (const account of activeAccounts(ctx, dealerId)) reports.push(await ctx.xhs.capabilities(account.id));
      let snapshots = 0;
      for (const report of reports) snapshots += recordCapabilitySnapshots(ctx, report).length;
      const llm = ctx.llm.status();
      ctx.db.table('capability_snapshots').insert({
        id: newId('cap'),
        provider: llm.provider,
        account_id: null,
        capability: 'llm',
        status: llm.status,
        reason: llm.reason,
        checked_at: ctx.clock.iso(),
      });
      const states = reports.flatMap((r) => Object.values(r.capabilities).map((c) => ({ account_id: r.account_id, capability: c.capability, status: c.status, reason: c.reason })));
      return {
        provider: ctx.xhs.name,
        mode: ctx.xhs.mode,
        snapshots: snapshots + 1,
        by_status: countBy(states, (s) => s.status),
        not_available: states.filter((s) => s.status !== 'AVAILABLE' && s.account_id !== null).slice(0, 40),
        public_reads: Object.values(reports[0].capabilities)
          .filter((c) => c.capability.startsWith('search') || c.capability.startsWith('read_public'))
          .map((c) => ({ capability: c.capability, status: c.status, reason: c.reason })),
        llm: { status: llm.status, reason: llm.reason },
      };
    },
    { optional: true },
  );
}

export function researchSteps(): WorkflowStepDef[] {
  const run = (fn: (ctx: AppContext, input: { dealer_id: string }) => Promise<ResearchBrief>): StepRun => async ({ ctx, run: wf, input }) =>
    briefSummary(await fn(ctx, { dealer_id: dealerIdOf({ run: wf, input }) }));
  return [
    step('xhs_research', 'research-agent', 'xhs-research', '小红书公开内容研究：买家高频问题、高互动话题（证据为原文引用）', run(runXhsResearch), { optional: true }),
    step('competitor_research', 'research-agent', 'competitor-research', '竞品研究：与本店车型一起被对比的竞品及原话', run(runCompetitorResearch), { optional: true }),
    step('market_research', 'research-agent', 'automotive-market-research', '市场研究：用户口中的落地价/优惠 vs 本店真实政策、地区需求', run(runMarketResearch), { optional: true }),
    step('trend_detection', 'research-agent', 'trend-detection', '趋势检测：近期上升的车型与话题词', run(runTrendDetectionWithProvider), { optional: true }),
  ];
}

export function planContentStep(mode: 'tomorrow' | 'goal'): WorkflowStepDef {
  return step('plan_content', 'account-strategy-agent', 'content-planning', '为每个活跃账号制定差异化内容计划（跨账号去重，避免内容互相抢量）', ({ ctx, run, input }) => {
    const dealer = getDealer(ctx, dealerIdOf({ run, input }));
    const goal = resolveGoal(ctx, dealer.id, goalIdOf({ run, input }));
    const today = todayKey(ctx, dealer);
    let periodStart = addDaysToKey(today, 1);
    let days = PLAN_DAYS;
    if (mode === 'goal' && goal?.spec.timeframe) {
      const tz = tzOf(dealer);
      const startMs = Math.max(Date.parse(goal.spec.timeframe.start), ctx.clock.now().getTime());
      const endMs = Date.parse(goal.spec.timeframe.end);
      if (endMs <= ctx.clock.now().getTime()) return skipStep(`经营目标时间范围已结束（${goal.spec.timeframe.label}），不再生成内容计划`, { goal_id: goal.id });
      periodStart = localDateKey(new Date(startMs), tz);
      days = Math.min(31, Math.max(1, Math.ceil((endMs - startMs) / DAY_MS)));
    }
    const { plans, posts } = planContent(ctx, { dealer_id: dealer.id, period_start: periodStart, days, goal_id: goal?.id ?? null });
    if (plans.length === 0) return skipStep('没有可运营的活跃账号，未生成内容计划', { period_start: periodStart });
    return {
      period_start: periodStart,
      days,
      goal_id: goal?.id ?? null,
      plans: plans.length,
      posts: posts.length,
      posts_by_account: countBy(posts, (p) => p.account_id),
    };
  });
}

export function ensureQueriesStep(mode: 'goal' | 'if_missing'): WorkflowStepDef {
  return step(
    'ensure_queries',
    'lead-hunting-agent',
    'automotive-query-generation',
    mode === 'goal' ? '根据经营目标生成五类搜索词（车型/竞品/场景/交易/地域），全部基于门店真实车型、库存与政策' : '没有活跃搜索词时按门店库存与在售车型生成搜索词',
    ({ ctx, run, input }) => {
      const dealerId = dealerIdOf({ run, input });
      const goal = resolveGoal(ctx, dealerId, goalIdOf({ run, input }));
      const activeBefore = ctx.db.table('search_queries').count({ dealer_id: dealerId, status: 'active' });
      if (mode === 'if_missing' && activeBefore > 0) return { generated: 0, active: activeBefore, reason: `已有 ${activeBefore} 个活跃搜索词` };
      const spec: GoalSpec = goal?.spec ?? { type: 'lead_generation', models: [] };
      const queries = generateQueries(ctx, { dealer_id: dealerId, goal: spec, goal_id: goal?.id ?? null });
      return {
        goal_id: goal?.id ?? null,
        generated: queries.length,
        active: ctx.db.table('search_queries').count({ dealer_id: dealerId, status: 'active' }),
        by_class: countBy(queries, (q) => q.query_class),
      };
    },
  );
}

export function discoverStep(): WorkflowStepDef {
  return step('discover', 'lead-hunting-agent', 'lead-discovery', '按搜索词在小红书搜索公开笔记与评论，先粗筛再识别购车意向、判断发言人身份、评分并去重入库', async ({ ctx, run, input, progress }) => {
    const dealerId = dealerIdOf({ run, input });
    const goal = resolveGoal(ctx, dealerId, goalIdOf({ run, input }));
    // Optional run input (e.g. a small trial run from 系统 → 手动运行); absent = the skill's defaults.
    const maxPosts = positiveInt(input.max_posts);
    const maxComments = positiveInt(input.max_comments_per_post);
    const result = await runDiscovery(ctx, {
      dealer_id: dealerId,
      goal_id: goal?.id ?? null,
      max_queries: positiveInt(input.max_queries),
      ...(maxPosts || maxComments
        ? { limits: { ...(maxPosts ? { max_posts: maxPosts } : {}), ...(maxComments ? { max_comments_per_post: maxComments } : {}) } }
        : {}),
    }, (p) => progress({ ...p }));
    const runs = result.runs.map((r) => ({
      run_id: r.id,
      query_id: r.query_id,
      status: r.status,
      data_mode: r.data_mode ?? 'unknown',
      posts_discovered: r.posts_discovered,
      comments_scanned: r.comments_scanned,
      users_evaluated: r.users_evaluated,
      candidates: r.candidates,
      qualified: r.qualified,
      high_intent: r.high_intent,
      error: r.error,
    }));
    const totals = runs.reduce(
      (t, r) => ({
        posts: t.posts + r.posts_discovered,
        comments: t.comments + r.comments_scanned,
        users: t.users + r.users_evaluated,
        candidates: t.candidates + r.candidates,
        qualified: t.qualified + r.qualified,
        high_intent: t.high_intent + r.high_intent,
      }),
      { posts: 0, comments: 0, users: 0, candidates: 0, qualified: 0, high_intent: 0 },
    );
    const details = { provider: ctx.xhs.name, mode: ctx.xhs.mode, runs, totals, leads_touched: result.leads_touched, blocked: result.blocked };
    if (result.blocked && !runs.some((r) => r.status === 'SUCCEEDED')) {
      return skipStep(`公开内容搜索被阻断（${result.blocked.status}）：${result.blocked.reason}`, details);
    }
    // Every query failed without a block (e.g. one query that timed out): nothing was searched, so this is not done.
    if (runs.length > 0 && !runs.some((r) => r.status === 'SUCCEEDED')) {
      return skipStep(`${runs.length} 个搜索词都没有搜索成功：${runs[0]?.error ?? ''}`, details);
    }
    return details;
  });
}

export function researchLeadsStep(): WorkflowStepDef {
  return step(
    'research_leads',
    'lead-research-agent',
    'lead-research',
    '读取新合格线索的公开主页：识别车商/销售账号、确认本地真实用户、补充主页笔记中的购车信号',
    async ({ ctx, run, input, outputs }) => {
      const dealerId = dealerIdOf({ run, input });
      const report = await ctx.xhs.capabilities(null);
      const cap = report.capabilities.read_public_profile;
      if (cap.status !== 'AVAILABLE') return skipStep(`读取公开主页不可用（${cap.status}：${cap.reason}）`, { status: cap.status });
      const touched = outputs.discover?.leads_touched;
      const ids = Array.isArray(touched) ? touched.filter((x): x is string => typeof x === 'string') : [];
      if (ids.length === 0) return skipStep('本次没有新发现或更新的线索需要研究');
      const leads = ctx.db
        .table('leads')
        .findMany({ id: ids, dealer_id: dealerId, stage: stagesFrom('QUALIFIED') })
        .filter((l) => !l.suppressed && ctx.audit.decisionsFor('lead', l.id).every((d) => d.decision_type !== 'lead_research'))
        .slice(0, MAX_RESEARCH_PER_RUN);
      const results = [];
      for (const lead of leads) {
        const r = await researchLead(ctx, lead.id);
        results.push({ lead_id: r.lead_id, status: r.status, industry_account: r.industry_account, added_signals: r.added_signals, reason: r.reason });
      }
      return { researched: results.filter((r) => r.status === 'researched').length, skipped: results.filter((r) => r.status === 'skipped').length, results };
    },
    { optional: true },
  );
}

export function assignLeadsStep(): WorkflowStepDef {
  return step('assign_leads', 'fleet-controller', 'account-assignment', '为每条合格线索选择唯一最合适的账号（地域、车型专长、人设、负载、健康度），防止多账号重复触达', ({ ctx, run, input }) => {
    const dealerId = dealerIdOf({ run, input });
    const leads = ctx.db
      .table('leads')
      .query(`dealer_id = ? AND suppressed = 0 AND stage IN (${ASSIGNABLE_STAGES.map(() => '?').join(', ')})`, [dealerId, ...ASSIGNABLE_STAGES], {
        orderBy: 'score DESC, last_signal_at DESC',
        limit: MAX_ASSIGN_PER_RUN,
      });
    const assigned: { lead_id: string; account_id: string; reason: string }[] = [];
    const notAssigned: { lead_id: string; reason: string }[] = [];
    for (const lead of leads) {
      if (getActiveAssignment(ctx, lead.id)) continue;
      const r = assignLead(ctx, lead.id);
      if (r.assignment) assigned.push({ lead_id: lead.id, account_id: r.assignment.account_id, reason: r.reason });
      else notAssigned.push({ lead_id: lead.id, reason: r.reason });
    }
    return { considered: leads.length, assigned: assigned.length, not_assigned: notAssigned.length, assignments: assigned, failures: notAssigned };
  });
}

const OUTREACH_EXISTS_STATUSES = ['DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'SENT', 'SENT_MANUALLY', 'BLOCKED'];

export function prepareOutreachStep(): WorkflowStepDef {
  return step('prepare_outreach', 'outreach-agent', 'outreach', '基于用户原话与 Dealer Brain 事实生成个性化私信并执行 10 项发送前检查；无法自动发送时进入人工审核', async ({ ctx, run, input }) => {
    const dealerId = dealerIdOf({ run, input });
    const leads = ctx.db
      .table('leads')
      .query(
        `dealer_id = ? AND stage = 'ASSIGNED' AND suppressed = 0 AND NOT EXISTS (
           SELECT 1 FROM outreach o WHERE o.lead_id = leads.id AND o.kind = 'first_touch' AND o.status IN (${placeholders(OUTREACH_EXISTS_STATUSES.length)}))`,
        [dealerId, ...OUTREACH_EXISTS_STATUSES],
        { orderBy: 'score DESC', limit: MAX_OUTREACH_PER_RUN },
      );
    if (leads.length === 0) return skipStep('没有待生成私信的已分配线索');
    const prepared: { lead_id: string; outreach_id: string; status: string; account_id: string }[] = [];
    const refused: { lead_id: string; code: string; message: string }[] = [];
    for (const lead of leads) {
      if (!getActiveAssignment(ctx, lead.id)) continue;
      try {
        const o = await prepareOutreach(ctx, lead.id);
        prepared.push({ lead_id: lead.id, outreach_id: o.id, status: o.status, account_id: o.account_id });
      } catch (err) {
        if (err instanceof PolicyError) refused.push({ lead_id: lead.id, code: err.code, message: err.message });
        else throw err;
      }
    }
    return { considered: leads.length, prepared: prepared.length, by_status: countBy(prepared, (p) => p.status), outreach: prepared, refused };
  });
}

export function evolveQueriesStep(): WorkflowStepDef {
  return step(
    'evolve_queries',
    'optimization-agent',
    'automotive-query-generation',
    '按真实线索密度调整搜索词优先级，衍生高效变体，暂停/淘汰无效搜索词',
    ({ ctx, run, input }) => {
      const r = evolveQueries(ctx, dealerIdOf({ run, input }));
      return {
        evaluated: r.evaluated,
        reprioritized: r.reprioritized,
        derived: r.derived.map((q) => q.text),
        paused: r.paused.map((q) => q.text),
        retired: r.retired.map((q) => q.text),
      };
    },
    { optional: true },
  );
}

export function pollInboxStep(): WorkflowStepDef {
  return step(
    'poll_inbox',
    'conversation-agent',
    'conversation',
    '拉取每个账号的私信回复并更新对话、意向与销售阶段（平台不支持时如实跳过，需人工录入回复）',
    async ({ ctx, run, input }) => {
      const accounts = activeAccounts(ctx, dealerIdOf({ run, input }));
      if (accounts.length === 0) return skipStep('没有活跃账号');
      const results = [];
      for (const account of accounts) {
        const r = await pollInbox(ctx, account.id);
        results.push({ account_id: account.id, nickname: account.nickname, status: r.status, processed: r.processed, reason: r.reason });
      }
      const processed = results.reduce((s, r) => s + r.processed, 0);
      if (results.every((r) => r.status !== 'AVAILABLE')) {
        const reasons = [...new Set(results.map((r) => `${r.status}：${r.reason}`))];
        return skipStep(`所有账号均无法自动接收私信（${reasons.join('；')}）；回复需销售在控制台手动录入`, { accounts: results });
      }
      return { processed, accounts: results };
    },
    { optional: true },
  );
}

/**
 * The platform's own inbox: who commented on our notes, @-mentioned us, liked or collected them, and who started
 * following. Buyer comments become leads here, so an inbound customer is picked up in the same half hour as a reply.
 */
export function syncNotificationsStep(): WorkflowStepDef {
  return step(
    'sync_notifications',
    'lead-hunting-agent',
    'notification-inbox',
    '读取每个账号在小红书消息中心收到的评论和@、赞和收藏、新增关注，把有购车意向的评论变成线索',
    async ({ ctx, run, input }) => {
      const accounts = activeAccounts(ctx, dealerIdOf({ run, input }));
      if (accounts.length === 0) return skipStep('没有活跃账号');
      const results = [];
      for (const account of accounts) {
        const r = await syncAccountNotifications(ctx, account.id);
        results.push({ account_id: account.id, nickname: account.nickname, created: r.created, leads_created: r.leads_created, tabs: r.tabs, detail: r.detail });
      }
      if (results.every((r) => r.tabs.every((t) => t.status !== 'AVAILABLE'))) {
        const reasons = [...new Set(results.flatMap((r) => r.tabs.map((t) => `${t.status}：${t.reason}`)).filter(Boolean))];
        return skipStep(`所有账号都读不到消息中心（${reasons.join('；')}）`, { accounts: results });
      }
      return {
        created: results.reduce((s, r) => s + r.created, 0),
        leads_created: results.reduce((s, r) => s + r.leads_created, 0),
        accounts: results,
      };
    },
    { optional: true },
  );
}

/**
 * 账号语言风格: keep each account's learned voice current. Only accounts whose profile is missing or older than a week
 * are re-read, so this is cheap on most days and picks up new notes as the store keeps publishing.
 */
export function learnAccountVoiceStep(): WorkflowStepDef {
  return step(
    'learn_account_voice',
    'account-strategy-agent',
    'account-voice',
    '读取每个账号自己已发布的笔记，更新它独有的写作风格（标题、句式、emoji、结构、引导语、称呼）',
    async ({ ctx, run, input }) => {
      const dealerId = dealerIdOf({ run, input });
      const results = await refreshDealerVoices(ctx, dealerId, 'agent:account-strategy-agent');
      if (results.length === 0) return skipStep('没有需要更新语言风格的账号（都在一周内学过）');
      const learned = results.filter((r) => r.status === 'AVAILABLE');
      if (learned.length === 0) {
        return skipStep(`暂时学不到语言风格（${[...new Set(results.map((r) => r.reason))].join('；')}）`, { accounts: results.map((r) => ({ account_id: r.account_id, reason: r.reason })) });
      }
      return {
        learned: learned.length,
        accounts: results.map((r) => ({ account_id: r.account_id, nickname: r.account_name, status: r.status, samples: r.used, rules: r.profile?.rules.length ?? 0, reason: r.reason })),
      };
    },
    { optional: true },
  );
}

export function planFollowUpsStep(): WorkflowStepDef {
  return step(
    'plan_follow_ups',
    'outreach-agent',
    'follow-up',
    '为已触达但未回复、达到跟进间隔的线索生成跟进私信（受最多未回复次数限制）',
    async ({ ctx, run, input }) => {
      const planned = await planFollowUps(ctx, dealerIdOf({ run, input }));
      return { planned: planned.length, by_status: countBy(planned, (o) => o.status) };
    },
    { optional: true },
  );
}

export function generatePostsStep(): WorkflowStepDef {
  return step('generate_posts', 'content-agent', 'post-generation', `为 ${CONTENT_LOOKAHEAD_DAYS} 天内到期的内容计划生成笔记（事实只来自 Dealer Brain）`, async ({ ctx, run, input }) => {
    const dealer = getDealer(ctx, dealerIdOf({ run, input }));
    const until = addDaysToKey(todayKey(ctx, dealer), CONTENT_LOOKAHEAD_DAYS);
    const posts = ctx.db.table('posts').query('dealer_id = ? AND status = ? AND slot_date <= ?', [dealer.id, 'PLANNED', until], { orderBy: 'slot_date ASC, id ASC', limit: MAX_POSTS_PER_RUN });
    if (posts.length === 0) return skipStep('没有需要生成的内容计划');
    const done: { post_id: string; status: string }[] = [];
    const failures: { post_id: string; error: string }[] = [];
    for (const p of posts) {
      try {
        const r = await generatePost(ctx, p.id);
        done.push({ post_id: r.id, status: r.status });
      } catch (err) {
        failures.push({ post_id: p.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (done.length === 0) throw new Error(`全部 ${failures.length} 篇笔记生成失败：${failures[0]?.error ?? ''}`);
    return { generated: done.length, failed: failures.length, by_status: countBy(done, (d) => d.status), failures };
  });
}

export function reviewPostsStep(): WorkflowStepDef {
  return step('review_posts', 'content-review-agent', 'content-review', '事实核查 + 跨账号重复检查 + 平台规则检查，按审批策略进入待审/排期', ({ ctx, run, input }) => {
    const posts = ctx.db.table('posts').findMany({ dealer_id: dealerIdOf({ run, input }), status: 'DRAFTED' }, { orderBy: 'slot_date ASC, id ASC', limit: MAX_POSTS_PER_RUN });
    if (posts.length === 0) return skipStep('没有待审核的草稿');
    const reviewed = posts.map((p) => {
      const r = reviewPost(ctx, p.id);
      return { post_id: r.id, status: r.status };
    });
    return { reviewed: reviewed.length, by_status: countBy(reviewed, (r) => r.status) };
  });
}

export function publishDueStep(): WorkflowStepDef {
  return step('publish_due', 'publishing-agent', 'publishing', '发布到期笔记：平台确认成功才算已发布；不支持自动发布时进入"待人工发布"', async ({ ctx, run, input }) => {
    const r = await publishDuePosts(ctx, dealerIdOf({ run, input }));
    return {
      published: r.published.length,
      ready_to_publish: r.ready_to_publish.length,
      changes_required: r.changes_required.length,
      failed: r.failed.length,
      skipped: r.skipped.length,
      published_ids: r.published.map((p) => p.id),
      ready_ids: r.ready_to_publish.map((p) => p.id),
      skipped_reasons: r.skipped.slice(0, 20),
    };
  });
}

export function collectPerformanceStep(): WorkflowStepDef {
  return step(
    'collect_performance',
    'analytics-agent',
    'publishing',
    '采集已发布笔记的互动数据（平台不提供浏览量时如实记为未知）',
    async ({ ctx, run, input }) => {
      const r = await collectPerformance(ctx, dealerIdOf({ run, input }));
      if (r.updated === 0 && r.status !== 'AVAILABLE') return skipStep(`互动数据不可读取（${r.status}：${r.reason}）`, { status: r.status, unreconciled: r.unreconciled });
      return { updated: r.updated, status: r.status, reason: r.reason, unreconciled: r.unreconciled, views_unavailable: r.views_unavailable, failures: r.failures.slice(0, 20) };
    },
    { optional: true },
  );
}

/**
 * Comments on OUR published notes (content → lead attribution, engagement replies). Reads go through the owning
 * account's session; the note's xsec_token must already be known from a public_posts row (xiaohongshu-mcp requires it).
 */
export function collectOwnCommentsStep(): WorkflowStepDef {
  return step(
    'collect_own_comments',
    'publishing-agent',
    'lead-discovery',
    '读取自家已发布笔记下的公开评论并入库：评论中的购车信号进入线索流程并归因到该笔记',
    async ({ ctx, run, input }) => {
      const dealerId = dealerIdOf({ run, input });
      const report = await ctx.xhs.capabilities(null);
      const cap = report.capabilities.read_public_comments;
      if (cap.status !== 'AVAILABLE') return skipStep(`读取公开评论不可用（${cap.status}：${cap.reason}）`, { status: cap.status });
      const dataMode = dataModeForProvider(ctx.xhs.mode);
      if (dataMode === 'unknown') return skipStep(`当前小红书接入（${ctx.xhs.name}，模式 ${ctx.xhs.mode}）不产生可入库的公开数据`);
      const posts = ctx.db
        .table('posts')
        .query("dealer_id = ? AND status = 'PUBLISHED' AND platform_note_id IS NOT NULL", [dealerId], { orderBy: 'published_at DESC, id DESC', limit: MAX_POSTS_PER_RUN });
      if (posts.length === 0) return skipStep('没有带笔记ID的已发布笔记（发布后需登记笔记链接）');

      const results: { post_id: string; comments: number; signals_created: number; leads_created: number; leads_merged: number }[] = [];
      const failures: { post_id: string; status: string; reason: string }[] = [];
      const missingToken: string[] = [];
      for (const post of posts) {
        const noteId = post.platform_note_id!;
        const known = ctx.db.table('public_posts').queryOne('own_post_id = ? OR platform_post_id = ?', [post.id, noteId], { orderBy: 'fetched_at DESC' });
        if (!known?.xsec_token) {
          missingToken.push(post.id);
          continue;
        }
        const ref = { platform_post_id: noteId, xsec_token: known.xsec_token };
        const note = await ctx.xhs.getNote(ref, post.account_id);
        if (!note.ok) {
          failures.push({ post_id: post.id, status: note.status, reason: note.reason });
          if (note.status === 'REQUIRES_AUTH') break;
          continue;
        }
        const comments = await ctx.xhs.getComments(ref, { include_replies: true, limit: MAX_OWN_NOTE_COMMENTS }, post.account_id);
        if (!comments.ok) {
          failures.push({ post_id: post.id, status: comments.status, reason: comments.reason });
          if (comments.status === 'REQUIRES_AUTH') break;
          continue;
        }
        const summary = await ingestPublicContent(ctx, { dealer_id: dealerId, notes: [{ ...note.data, comments: comments.data }], data_mode: dataMode });
        results.push({
          post_id: post.id,
          comments: summary.comments,
          signals_created: summary.signals_created,
          leads_created: summary.leads_created,
          leads_merged: summary.leads_merged,
        });
      }
      const details = { failures, missing_token: missingToken, data_mode: dataMode };
      if (results.length === 0) {
        if (failures.length > 0) return skipStep(`读取自家笔记评论失败（${failures[0].status}：${failures[0].reason}）`, details);
        return skipStep('已发布笔记缺少 xsec_token（笔记需先出现在公开搜索结果中），暂时无法读取评论', details);
      }
      return {
        posts: results.length,
        comments: results.reduce((s, r) => s + r.comments, 0),
        signals_created: results.reduce((s, r) => s + r.signals_created, 0),
        leads_created: results.reduce((s, r) => s + r.leads_created, 0),
        leads_merged: results.reduce((s, r) => s + r.leads_merged, 0),
        results,
        ...details,
      };
    },
    { optional: true },
  );
}

export function draftEngagementRepliesStep(): WorkflowStepDef {
  return step(
    'draft_engagement_replies',
    'publishing-agent',
    'engagement',
    '为自家笔记下的新评论起草公开回复（经发送前检查，需审核）',
    async ({ ctx, run, input }) => {
      const replies = await draftEngagementReplies(ctx, dealerIdOf({ run, input }));
      return { drafted: replies.length, by_status: countBy(replies, (r) => r.status) };
    },
    { optional: true },
  );
}

export function optimizeStep(): WorkflowStepDef {
  return step('optimize', 'optimization-agent', 'optimization', '按线索与成交结果优化：搜索词、评分阈值建议、内容支柱、账号负载', async ({ ctx, run, input }) => {
    const r = await runOptimization(ctx, dealerIdOf({ run, input }));
    return { recommendations: r.recommendations, queries: r.queries };
  });
}

export function operatorReportStep(): WorkflowStepDef {
  return step('operator_report', 'analytics-agent', 'reporting', '生成今日经营日报（数据来源、能力受限情况一并说明）', ({ ctx, run, input }) => {
    const report = generateOperatorReport(ctx, dealerIdOf({ run, input }));
    return { report_id: report.id, date: report.date, summary: (report.report as { summary?: unknown }).summary ?? [] };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Goal progress
// ─────────────────────────────────────────────────────────────────────────────

export interface GoalProgress {
  goal_id: string;
  type: GoalType;
  qualified_leads: number;
  appointments: number;
  target_leads: number | null;
  posts_planned: number;
  posts_published: number;
  target_posts: number | null;
  timeframe_ended: boolean;
  status_before: GoalStatus;
  status_after: GoalStatus;
  reason: string;
}

export function computeGoalProgress(ctx: AppContext, goal: OperatorGoal): Omit<GoalProgress, 'status_after' | 'reason'> {
  const spec = goal.spec;
  const end = spec.timeframe?.end ?? null;
  const models = (spec.models ?? []).filter(Boolean);
  const reachedCount = (from: LeadStage): number => {
    const stages = stagesFrom(from);
    const params: (string | number)[] = [goal.dealer_id, ...stages, goal.created_at];
    let sql = `SELECT COUNT(DISTINCT t.lead_id) AS n FROM lead_stage_transitions t JOIN leads l ON l.id = t.lead_id
               WHERE l.dealer_id = ? AND t.to_stage IN (${placeholders(stages.length)}) AND t.at >= ?`;
    if (end) {
      sql += ' AND t.at < ?';
      params.push(end);
    }
    if (models.length > 0) {
      sql += ` AND json_extract(l.intent, '$.model') IN (${placeholders(models.length)})`;
      params.push(...models);
    }
    return Number(ctx.db.get<{ n: number }>(sql, ...params)?.n ?? 0);
  };
  const posts = ctx.db.get<{ planned: number; published: number }>(
    `SELECT COUNT(*) AS planned, SUM(CASE WHEN p.status = 'PUBLISHED' THEN 1 ELSE 0 END) AS published
     FROM posts p JOIN content_plans c ON c.id = p.plan_id
     WHERE c.dealer_id = ? AND json_extract(c.strategy, '$.goal_id') = ? AND p.status <> 'REJECTED'`,
    goal.dealer_id,
    goal.id,
  );
  const perAccount = goalTargets(spec).posts_per_account;
  const accounts = ctx.db.table('xhs_accounts').count({ dealer_id: goal.dealer_id, status: 'active' });
  return {
    goal_id: goal.id,
    type: spec.type,
    qualified_leads: reachedCount('QUALIFIED'),
    appointments: reachedCount('APPOINTMENT'),
    target_leads: spec.target_leads ?? null,
    posts_planned: Number(posts?.planned ?? 0),
    posts_published: Number(posts?.published ?? 0),
    target_posts: perAccount ? perAccount * accounts : null,
    timeframe_ended: end !== null && ctx.clock.now().getTime() >= Date.parse(end),
    status_before: goal.status,
  };
}

function decideGoalStatus(ctx: AppContext, goal: OperatorGoal, p: Omit<GoalProgress, 'status_after' | 'reason'>): { status: GoalStatus; reason: string } {
  if (goal.status !== 'active') return { status: goal.status, reason: `目标状态为 ${goal.status}，不自动变更` };
  switch (p.type) {
    case 'lead_generation':
      if (p.target_leads !== null && p.qualified_leads >= p.target_leads) return { status: 'completed', reason: `合格线索 ${p.qualified_leads} 条，已达成目标 ${p.target_leads} 条` };
      if (p.timeframe_ended) {
        return p.target_leads !== null
          ? { status: 'failed', reason: `时间范围已结束，合格线索 ${p.qualified_leads} 条，未达成目标 ${p.target_leads} 条` }
          : { status: 'completed', reason: `时间范围已结束，共获得合格线索 ${p.qualified_leads} 条` };
      }
      return { status: 'active', reason: `进行中：合格线索 ${p.qualified_leads}${p.target_leads !== null ? ` / ${p.target_leads}` : ''} 条，预约 ${p.appointments} 个` };
    case 'content_campaign':
      if (p.target_posts !== null && p.posts_published >= p.target_posts) return { status: 'completed', reason: `已发布 ${p.posts_published} 篇，达成目标 ${p.target_posts} 篇` };
      if (p.timeframe_ended) {
        return p.target_posts !== null && p.posts_published < p.target_posts
          ? { status: 'failed', reason: `时间范围已结束，已发布 ${p.posts_published} 篇，未达成目标 ${p.target_posts} 篇` }
          : { status: 'completed', reason: `时间范围已结束，计划 ${p.posts_planned} 篇，已发布 ${p.posts_published} 篇` };
      }
      return { status: 'active', reason: `进行中：计划 ${p.posts_planned} 篇，已发布 ${p.posts_published}${p.target_posts !== null ? ` / ${p.target_posts}` : ''} 篇` };
    case 'reporting': {
      const report = ctx.db.table('operator_reports').queryOne('dealer_id = ? AND created_at >= ?', [goal.dealer_id, goal.created_at]);
      return report ? { status: 'completed', reason: `已生成经营报告（${report.date}）` } : { status: 'active', reason: '报告尚未生成' };
    }
    default:
      return p.timeframe_ended
        ? { status: 'completed', reason: '时间范围已结束' }
        : { status: 'active', reason: `日常运营进行中：合格线索 ${p.qualified_leads} 条，预约 ${p.appointments} 个` };
  }
}

export function updateGoalProgressStep(): WorkflowStepDef {
  return step('update_goal_progress', 'automotive-operator', 'automotive-operator', '更新经营目标进度与状态（达成/时间结束/进行中）', ({ ctx, run, input }) => {
    const dealerId = dealerIdOf({ run, input });
    const goalId = goalIdOf({ run, input });
    if (!goalId) return skipStep('本次运行没有关联的经营目标');
    const goal = resolveGoal(ctx, dealerId, goalId)!;
    const progress = computeGoalProgress(ctx, goal);
    const decision = decideGoalStatus(ctx, goal, progress);
    if (decision.status !== goal.status) {
      ctx.db.tx(() => {
        ctx.db.table('operator_goals').update(goal.id, { status: decision.status });
        ctx.audit.event({
          actor: 'agent:automotive-operator',
          action: 'goal.status_changed',
          entity_type: 'operator_goal',
          entity_id: goal.id,
          details: { from: goal.status, to: decision.status, reason: decision.reason, progress },
        });
      });
    }
    return { ...progress, status_after: decision.status, reason: decision.reason };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflows
// ─────────────────────────────────────────────────────────────────────────────

/** Lead chain shared by lead_discovery and goal execution. */
function leadChain(queries: 'goal' | 'if_missing'): WorkflowStepDef[] {
  return [ensureQueriesStep(queries), discoverStep(), researchLeadsStep(), assignLeadsStep(), prepareOutreachStep(), evolveQueriesStep()];
}

/** Steps of `goal_execution` for a goal type (also used by the planner to show the plan). */
export function goalExecutionSteps(input: Record<string, unknown>): WorkflowStepDef[] {
  const type = (typeof input.goal_type === 'string' ? input.goal_type : 'lead_generation') as GoalType;
  switch (type) {
    case 'content_campaign':
      return [planContentStep('goal'), generatePostsStep(), reviewPostsStep(), publishDueStep(), updateGoalProgressStep()];
    case 'reporting':
      return [capabilitySnapshotStep(), operatorReportStep(), updateGoalProgressStep()];
    case 'daily_operations':
      return [accountHealthStep(), ...leadChain('if_missing'), planContentStep('tomorrow'), updateGoalProgressStep()];
    case 'lead_generation':
    default:
      return [...leadChain('goal'), updateGoalProgressStep()];
  }
}

export function buildWorkflows(): WorkflowDef[] {
  return [
    {
      name: 'refresh_dealer_data',
      description: '08:00 刷新门店数据：Dealer Brain 到期检查、账号健康、登录会话、能力检测、账号语言风格',
      steps: [checkDealerFactsStep(), accountHealthStep(), accountSessionsStep(), capabilitySnapshotStep(), learnAccountVoiceStep()],
    },
    { name: 'market_research', description: '08:30 市场与竞品研究（证据为公开原文）', steps: researchSteps() },
    { name: 'account_planning', description: '09:00 为每个账号制定未来 7 天差异化内容计划', steps: [planContentStep('tomorrow')] },
    { name: 'lead_discovery', description: '09:30 公开信号获客：搜索 → 意向识别 → 评分去重 → 分配 → 私信准备', steps: leadChain('if_missing') },
    { name: 'signal_processing', description: '每小时：分配合格线索、准备私信', steps: [assignLeadsStep(), prepareOutreachStep()] },
    {
      name: 'reply_processing',
      description: '每 30 分钟：读取消息中心、处理回复、安排跟进',
      steps: [syncNotificationsStep(), pollInboxStep(), planFollowUpsStep()],
    },
    { name: 'content_publishing', description: '每小时：生成、审核并发布到期笔记', steps: [generatePostsStep(), reviewPostsStep(), publishDueStep()] },
    {
      name: 'performance_collection',
      description: '18:00 采集内容表现、读取自家笔记评论、起草评论回复',
      steps: [collectPerformanceStep(), collectOwnCommentsStep(), draftEngagementRepliesStep()],
    },
    { name: 'evening_analysis', description: '20:00 健康度、优化建议与经营日报', steps: [accountHealthStep(), optimizeStep(), operatorReportStep()] },
    { name: GOAL_WORKFLOW, description: '执行经营目标（按目标类型编排步骤）', steps: goalExecutionSteps },
  ];
}

/** Every workflow name the scheduler plan requires (guard used by bootstrap and tests). */
export function missingScheduledWorkflows(defs: readonly WorkflowDef[]): string[] {
  const names = new Set(defs.map((d) => d.name));
  return [...new Set(DEFAULT_DAILY_SCHEDULE.map((e) => e.workflow))].filter((w) => !names.has(w));
}
