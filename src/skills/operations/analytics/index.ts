/**
 * Business-outcome analytics (spec §16–19, §26): read-only queries over the real tables that answer
 * "what happened today, what needs me, and which content/accounts actually produce leads and sales".
 * Nothing here is static or sampled; every figure is recomputed from persisted rows at read time.
 */
import type { AppContext } from '../../../app/context.ts';
import { ValidationError } from '../../../core/errors.ts';
import { LEAD_STAGES, SCORE_TIERS, SIGNAL_SOURCE_TYPES } from '../../../core/types.ts';
import { v, type Validator } from '../../../core/validate.ts';
import { defineSkill } from '../../registry.ts';
import { getAccountsOverview } from './accounts.ts';
import { getContentAttribution } from './content.ts';
import { getDashboard } from './dashboard.ts';
import { normalizeFilters, periodFor } from './filters.ts';
import { getFunnel } from './funnel.ts';
import { getLeadDetail, getLeadInbox, type LeadInboxOptions } from './leads.ts';
import type {
  AccountOverviewRow,
  AnalyticsFilters,
  AnalyticsPeriod,
  ContentAttributionRow,
  DashboardMetrics,
  FunnelStage,
  LeadCard,
  LeadDetail,
} from './types.ts';

export type {
  AccountAttention,
  AccountOverviewRow,
  AnalyticsFilters,
  AnalyticsPeriod,
  ContentAttributionRow,
  DashboardException,
  DashboardMetrics,
  ExceptionKind,
  ExceptionSeverity,
  FunnelStage,
  LeadCard,
  LeadDetail,
  LeadSignalDetail,
  PipelineStageValue,
} from './types.ts';
export { EXCEPTION_KINDS } from './types.ts';
export { HEALTH_NOT_COMPUTED_ISSUE, getAccountsOverview } from './accounts.ts';
export { getContentAttribution } from './content.ts';
export { APPOINTMENT_WINDOW_HOURS, BLOCKED_WINDOW_DAYS, OPEN_PIPELINE_STAGES, buildBriefing, getDashboard } from './dashboard.ts';
export { getFunnel } from './funnel.ts';
export {
  DEFAULT_INBOX_LIMIT,
  MAX_INBOX_LIMIT,
  MAX_INTENT_CHIPS,
  NON_INTENT_EVIDENCE_CODES,
  PURCHASE_STAGE_LABELS,
  WARNING_EVIDENCE_CODES,
  TIER_LABELS,
  UNKNOWN_LOCATION_LABEL,
  UNKNOWN_MODEL_LABEL,
  buildLeadCard,
  getLeadDetail,
  getLeadInbox,
  intentChips,
  locationLabel,
  modelLabel,
  type LeadInboxOptions,
} from './leads.ts';

/**
 * Reporting window `[from, to)` (UTC ISO). Default: dealer-local today in the dealer timezone (Asia/Shanghai when no
 * dealer/account filter). Also returns the timezone and whether the window is exactly today.
 */
export function resolvePeriod(ctx: AppContext, f: AnalyticsFilters = {}): AnalyticsPeriod {
  return periodFor(normalizeFilters(ctx, f), ctx.clock.now());
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill
// ─────────────────────────────────────────────────────────────────────────────

export const ANALYTICS_KINDS = ['dashboard', 'inbox', 'funnel', 'attribution', 'accounts', 'lead_detail'] as const;
export type AnalyticsKind = (typeof ANALYTICS_KINDS)[number];

export interface AnalyticsSkillInput {
  kind: AnalyticsKind;
  filters: AnalyticsFilters & LeadInboxOptions;
  /** required for kind 'lead_detail' */
  lead_id?: string;
}

export type AnalyticsSkillOutput =
  | { kind: 'dashboard'; result: DashboardMetrics }
  | { kind: 'inbox'; result: LeadCard[] }
  | { kind: 'funnel'; result: FunnelStage[] }
  | { kind: 'attribution'; result: ContentAttributionRow[] }
  | { kind: 'accounts'; result: AccountOverviewRow[] }
  | { kind: 'lead_detail'; result: LeadDetail };

const optText = v.optional(v.string({ max: 200 }));

const filtersValidator = v.object({
  dealer_id: optText,
  account_id: optText,
  brand: optText,
  model: optText,
  location: optText,
  from: optText,
  to: optText,
  source_type: v.optional(v.literal(SIGNAL_SOURCE_TYPES)),
  stage: v.optional(v.literal(LEAD_STAGES)),
  tier: v.optional(v.literal(SCORE_TIERS)),
  limit: v.optional(v.number({ int: true, min: 1, max: 500 })),
  offset: v.optional(v.number({ int: true, min: 0 })),
});

const baseInput = v.object({
  kind: v.literal(ANALYTICS_KINDS),
  filters: v.withDefault(filtersValidator, {}),
  lead_id: v.optional(v.string({ min: 1 })),
});

const analyticsInput: Validator<AnalyticsSkillInput> = (value, path = '') => {
  const parsed = baseInput(value, path);
  if (parsed.kind === 'lead_detail' && parsed.lead_id === undefined)
    throw new ValidationError(path ? `${path}.lead_id` : 'lead_id', 'required for kind lead_detail');
  return parsed;
};

/** Throws when any number anywhere in the result is NaN or infinite (analytics must never emit NaN). */
function assertFinite(value: unknown, path: string, seen: Set<unknown> = new Set()): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`analytics: non-finite number at ${path}`);
    return;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, i) => assertFinite(item, `${path}[${i}]`, seen));
  else for (const [k, item] of Object.entries(value)) assertFinite(item, `${path}.${k}`, seen);
}

/** When the operator runs the dashboard (e.g. evening analysis), the briefing it reports is an audited decision. */
function recordBriefing(ctx: AppContext, filters: AnalyticsFilters, result: DashboardMetrics): void {
  const subject = filters.account_id
    ? { type: 'account', id: filters.account_id }
    : filters.dealer_id
      ? { type: 'dealer', id: filters.dealer_id }
      : { type: 'fleet', id: 'all' };
  ctx.audit.decision({
    agent: 'analytics-agent',
    skill: 'analytics',
    decision_type: 'report',
    subject_type: subject.type,
    subject_id: subject.id,
    inputs: { filters: { ...filters }, period: result.period },
    evidence: result.exceptions.map((e) => ({ code: `exception:${e.kind}`, label: `${e.title}（${e.count}）` })),
    output: {
      content: result.content,
      discovery: result.discovery,
      outreach: result.outreach,
      sales: result.sales,
      pipeline_estimated_value: result.pipeline.estimated_value,
      accounts: {
        active: result.accounts.active,
        healthy: result.accounts.healthy,
        requiring_attention: result.accounts.requiring_attention.length,
      },
      exceptions: result.exceptions.map((e) => ({ kind: e.kind, count: e.count })),
      briefing: result.briefing,
    },
    confidence: 1,
    engine: 'rules',
  });
}

export const skill = defineSkill<AnalyticsSkillInput, AnalyticsSkillOutput>({
  name: 'analytics',
  category: 'operations',
  agent: 'analytics-agent',
  description:
    '经营结果分析：今日看板（内容/发现/触达/销售/管道/账号与待处理事项）与AI员工简报、线索收件箱（原始信号不隐藏）、线索详情、销售漏斗、内容成交归因与账号概览，全部基于真实数据实时计算。',
  input: analyticsInput,
  run(ctx, input): AnalyticsSkillOutput {
    switch (input.kind) {
      case 'dashboard': {
        const result = getDashboard(ctx, input.filters);
        recordBriefing(ctx, input.filters, result);
        return { kind: 'dashboard', result };
      }
      case 'inbox':
        return { kind: 'inbox', result: getLeadInbox(ctx, input.filters) };
      case 'funnel':
        return { kind: 'funnel', result: getFunnel(ctx, input.filters) };
      case 'attribution':
        return { kind: 'attribution', result: getContentAttribution(ctx, input.filters) };
      case 'accounts':
        return { kind: 'accounts', result: getAccountsOverview(ctx, input.filters.dealer_id) };
      case 'lead_detail':
        return { kind: 'lead_detail', result: getLeadDetail(ctx, input.lead_id as string) };
    }
  },
  validateOutput(output) {
    assertFinite(output.result, 'result');
  },
});
