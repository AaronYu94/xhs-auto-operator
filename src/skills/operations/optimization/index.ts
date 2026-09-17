/**
 * Optimization agent (spec §19 "queries evolve", §16 "which content sells cars", §11 load balancing).
 *
 * Optimizes by leads and sales, not likes:
 * 1. Search intelligence — `evolveQueries` reprioritizes / derives / pauses / retires queries by real lead density.
 * 2. Scoring thresholds — outcome analysis per score band; produces a RECOMMENDATION only (thresholds are a business
 *    decision and are never changed automatically).
 * 3. Content pillars — attribution of published posts to qualified leads, appointments and wins per pillar.
 * 4. Account load — active leads vs outreach capacity per account; rebalancing recommendations.
 * Recorded as one 'optimization' decision with the evidence numbers.
 */
import type { AppContext } from '../../../app/context.ts';
import { NotFoundError } from '../../../core/errors.ts';
import { round } from '../../../core/text.ts';
import { DAY_MS } from '../../../core/time.ts';
import { LEAD_STAGES, type ContentPillar, type LeadStage } from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import { defineSkill } from '../../registry.ts';
import { evolveQueries } from '../../acquisition/automotive-query-generation/index.ts';
import { getScoringConfig } from '../../acquisition/lead-scoring/index.ts';
import { effectiveOutreachPolicy } from '../account-brain/index.ts';
import { getAccountsOverview, getContentAttribution } from '../analytics/index.ts';

export const OPTIMIZATION_AGENT = 'optimization-agent';
export const SKILL_NAME = 'optimization';
export const OUTCOME_WINDOW_DAYS = 30;
export const ATTRIBUTION_WINDOW_DAYS = 90;
/** minimum contacted leads per score band before its reply rate is trusted */
export const MIN_BAND_CONTACTED = 10;
export const LOAD_HIGH = 0.8;
export const LOAD_LOW = 0.2;
export const CAPACITY_MULTIPLIER = 5;

const CHAIN: LeadStage[] = LEAD_STAGES.filter((s) => s !== 'LOST');
const deeperThan = (stage: LeadStage): LeadStage[] => CHAIN.slice(CHAIN.indexOf(stage));

export interface BandOutcome {
  band: 'qualified' | 'high_intent' | 'immediate';
  min_score: number;
  max_score: number | null;
  leads: number;
  contacted: number;
  replied: number;
  appointments: number;
  won: number;
  reply_rate: number;
  appointment_rate: number;
}

export interface ThresholdAdvice {
  action: 'keep' | 'raise_qualified' | 'review_candidates';
  current: { candidate: number; qualified: number; high_intent: number; immediate: number };
  suggested_qualified: number | null;
  reason: string;
  bands: BandOutcome[];
  sample_size: number;
  auto_applied: false;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/** Outcomes of leads that reached QUALIFIED in the window, grouped by their current score band. */
export function scoreBandOutcomes(ctx: AppContext, dealerId: string, sinceIso: string): { bands: BandOutcome[]; thresholds: ThresholdAdvice['current'] } {
  const cfg = getScoringConfig(ctx, dealerId);
  const t = cfg.thresholds;
  const qualifiedStages = deeperThan('QUALIFIED');
  const leads = ctx.db.all<{ id: string; score: number }>(
    `SELECT l.id, l.score FROM leads l
     WHERE l.dealer_id = ? AND EXISTS (
       SELECT 1 FROM lead_stage_transitions t WHERE t.lead_id = l.id AND t.to_stage IN (${placeholders(qualifiedStages.length)}) AND t.at >= ?)`,
    dealerId,
    ...qualifiedStages,
    sinceIso,
  );
  const reached = (leadId: string, stage: LeadStage): boolean => {
    const stages = deeperThan(stage);
    return (
      ctx.db.get(`SELECT 1 AS x FROM lead_stage_transitions WHERE lead_id = ? AND to_stage IN (${placeholders(stages.length)}) LIMIT 1`, leadId, ...stages) !==
      undefined
    );
  };
  const defs: { band: BandOutcome['band']; min: number; max: number | null }[] = [
    { band: 'qualified', min: t.qualified, max: t.high_intent },
    { band: 'high_intent', min: t.high_intent, max: t.immediate },
    { band: 'immediate', min: t.immediate, max: null },
  ];
  const bands = defs.map((d) => {
    const inBand = leads.filter((l) => l.score >= d.min && (d.max === null || l.score < d.max));
    const contacted = inBand.filter((l) => reached(l.id, 'CONTACTED')).length;
    const replied = inBand.filter((l) => reached(l.id, 'REPLIED')).length;
    const appointments = inBand.filter((l) => reached(l.id, 'APPOINTMENT')).length;
    const won = inBand.filter((l) => reached(l.id, 'WON')).length;
    return {
      band: d.band,
      min_score: d.min,
      max_score: d.max,
      leads: inBand.length,
      contacted,
      replied,
      appointments,
      won,
      reply_rate: contacted > 0 ? round(replied / contacted, 3) : 0,
      appointment_rate: contacted > 0 ? round(appointments / contacted, 3) : 0,
    };
  });
  return { bands, thresholds: { candidate: t.candidate, qualified: t.qualified, high_intent: t.high_intent, immediate: t.immediate } };
}

export function adviseThresholds(ctx: AppContext, dealerId: string): ThresholdAdvice {
  const since = new Date(ctx.clock.now().getTime() - OUTCOME_WINDOW_DAYS * DAY_MS).toISOString();
  const { bands, thresholds } = scoreBandOutcomes(ctx, dealerId, since);
  const sample = bands.reduce((s, b) => s + b.contacted, 0);
  const low = bands[0];
  const high = bands.slice(1).reduce(
    (acc, b) => ({ contacted: acc.contacted + b.contacted, replied: acc.replied + b.replied }),
    { contacted: 0, replied: 0 },
  );
  const highRate = high.contacted > 0 ? high.replied / high.contacted : 0;
  const base = { current: thresholds, bands, sample_size: sample, auto_applied: false as const };

  if (low.contacted >= MIN_BAND_CONTACTED && high.contacted >= MIN_BAND_CONTACTED && low.reply_rate < 0.05 && highRate >= 0.2) {
    const suggested = Math.min(thresholds.high_intent - 1, thresholds.qualified + 5);
    return {
      ...base,
      action: 'raise_qualified',
      suggested_qualified: suggested,
      reason: `近${OUTCOME_WINDOW_DAYS}天合格档（${thresholds.qualified}–${thresholds.high_intent - 1}分）触达 ${low.contacted} 位仅回复 ${low.replied} 位（${round(low.reply_rate * 100, 1)}%），高意向及以上回复率 ${round(highRate * 100, 1)}%：建议把合格阈值提高到 ${suggested}，把私信额度留给高意向客户（需人工确认后在评分配置中修改）`,
    };
  }
  const candidatesRecent = Number(
    ctx.db.get<{ n: number }>(
      `SELECT COUNT(DISTINCT t.lead_id) AS n FROM lead_stage_transitions t JOIN leads l ON l.id = t.lead_id
       WHERE l.dealer_id = ? AND t.to_stage = 'CANDIDATE' AND t.at >= ?`,
      dealerId,
      since,
    )?.n ?? 0,
  );
  const qualifiedRecent = bands.reduce((s, b) => s + b.leads, 0);
  if (candidatesRecent >= 20 && qualifiedRecent <= 3) {
    return {
      ...base,
      action: 'review_candidates',
      suggested_qualified: null,
      reason: `近${OUTCOME_WINDOW_DAYS}天候选线索 ${candidatesRecent} 条、合格仅 ${qualifiedRecent} 条：建议人工抽查候选线索的评分依据，确认是否漏判；不自动降低阈值`,
    };
  }
  return {
    ...base,
    action: 'keep',
    suggested_qualified: null,
    reason:
      sample < MIN_BAND_CONTACTED
        ? `近${OUTCOME_WINDOW_DAYS}天已触达的合格线索仅 ${sample} 位，样本不足，保持当前阈值`
        : '各分档回复表现与阈值一致，保持当前阈值',
  };
}

export interface PillarSignal {
  pillar: ContentPillar;
  posts: number;
  engagement: number;
  leads: number;
  qualified_leads: number;
  appointments: number;
  won: number;
  qualified_per_post: number;
  signal: 'increase' | 'decrease' | 'keep';
  reason: string;
}

export function contentPillarSignals(ctx: AppContext, dealerId: string): PillarSignal[] {
  const from = new Date(ctx.clock.now().getTime() - ATTRIBUTION_WINDOW_DAYS * DAY_MS).toISOString();
  const rows = getContentAttribution(ctx, { dealer_id: dealerId, from });
  const byPillar = new Map<ContentPillar, Omit<PillarSignal, 'qualified_per_post' | 'signal' | 'reason'>>();
  for (const r of rows) {
    const acc = byPillar.get(r.pillar) ?? { pillar: r.pillar, posts: 0, engagement: 0, leads: 0, qualified_leads: 0, appointments: 0, won: 0 };
    acc.posts += 1;
    acc.engagement += r.engagement;
    acc.leads += r.leads;
    acc.qualified_leads += r.qualified_leads;
    acc.appointments += r.appointments;
    acc.won += r.won;
    byPillar.set(r.pillar, acc);
  }
  const list = [...byPillar.values()].map((p) => ({ ...p, qualified_per_post: p.posts > 0 ? round(p.qualified_leads / p.posts, 3) : 0 }));
  const best = Math.max(0, ...list.map((p) => p.qualified_per_post));
  return list
    .map((p): PillarSignal => {
      if (p.won > 0 || (best > 0 && p.qualified_per_post >= best && p.qualified_leads > 0)) {
        return { ...p, signal: 'increase', reason: `近${ATTRIBUTION_WINDOW_DAYS}天 ${p.posts} 篇带来合格线索 ${p.qualified_leads} 条、预约 ${p.appointments}、成交 ${p.won}：建议增加` };
      }
      if (p.posts >= 3 && p.leads === 0) {
        return { ...p, signal: 'decrease', reason: `近${ATTRIBUTION_WINDOW_DAYS}天发布 ${p.posts} 篇、互动 ${p.engagement}，但没有带来任何线索：建议减少或更换角度` };
      }
      return { ...p, signal: 'keep', reason: `近${ATTRIBUTION_WINDOW_DAYS}天 ${p.posts} 篇，合格线索 ${p.qualified_leads} 条：样本有限，保持` };
    })
    .sort((a, b) => b.won - a.won || b.qualified_per_post - a.qualified_per_post || b.posts - a.posts);
}

export interface LoadRecommendation {
  account_id: string;
  nickname: string;
  active_leads: number;
  capacity: number;
  load: number;
  health_state: string | null;
  recommendation: 'overloaded' | 'has_capacity' | 'ok' | 'attention';
  reason: string;
}

export function accountLoadRecommendations(ctx: AppContext, dealerId: string): LoadRecommendation[] {
  return getAccountsOverview(ctx, dealerId)
    .filter((a) => a.status === 'active')
    .map((a): LoadRecommendation => {
      const capacity = Math.max(1, CAPACITY_MULTIPLIER * effectiveOutreachPolicy(ctx, a.account_id).daily_limit);
      const load = round(a.active_leads / capacity, 3);
      const base = { account_id: a.account_id, nickname: a.nickname, active_leads: a.active_leads, capacity, load, health_state: a.health_state };
      if (a.health_state === 'AT_RISK' || a.health_state === 'RESTRICTED') {
        return { ...base, recommendation: 'attention', reason: `账号健康状态 ${a.health_state}：暂停新线索分配，已有 ${a.active_leads} 条线索建议人工复核` };
      }
      if (load >= LOAD_HIGH) {
        return { ...base, recommendation: 'overloaded', reason: `在跟线索 ${a.active_leads} 条，已达容量 ${Math.round(load * 100)}%：新线索应优先分给其他账号` };
      }
      if (load <= LOAD_LOW && a.health_state === 'HEALTHY') {
        return { ...base, recommendation: 'has_capacity', reason: `在跟线索 ${a.active_leads} 条（容量 ${capacity}），可承接更多线索` };
      }
      return { ...base, recommendation: 'ok', reason: `负载 ${Math.round(load * 100)}%，正常` };
    });
}

export async function runOptimization(ctx: AppContext, dealerId: string): Promise<Record<string, unknown>> {
  const dealer = ctx.db.table('dealers').get(dealerId);
  if (!dealer) throw new NotFoundError('dealer', dealerId);

  const evolved = evolveQueries(ctx, dealerId);
  const queries = {
    evaluated: evolved.evaluated,
    reprioritized: evolved.reprioritized,
    derived: evolved.derived.map((q) => q.text),
    paused: evolved.paused.map((q) => q.text),
    retired: evolved.retired.map((q) => q.text),
    best_smoothed_density: evolved.best_smoothed_density,
  };
  const thresholds = adviseThresholds(ctx, dealerId);
  const pillars = contentPillarSignals(ctx, dealerId);
  const accounts = accountLoadRecommendations(ctx, dealerId);

  const recommendations: string[] = [];
  if (queries.derived.length > 0) recommendations.push(`新增衍生搜索词 ${queries.derived.length} 个：${queries.derived.slice(0, 5).join('、')}`);
  if (queries.paused.length + queries.retired.length > 0) {
    recommendations.push(`暂停 ${queries.paused.length} 个、淘汰 ${queries.retired.length} 个低效搜索词`);
  }
  recommendations.push(thresholds.reason);
  for (const p of pillars.filter((x) => x.signal !== 'keep')) recommendations.push(`内容「${p.pillar}」：${p.reason}`);
  for (const a of accounts.filter((x) => x.recommendation !== 'ok')) recommendations.push(`${a.nickname}：${a.reason}`);

  const result = { dealer_id: dealerId, queries, thresholds, pillars, accounts, recommendations, generated_at: ctx.clock.iso() };
  const sample = thresholds.sample_size + pillars.reduce((s, p) => s + p.posts, 0) + queries.evaluated;
  ctx.audit.decision({
    agent: OPTIMIZATION_AGENT,
    skill: SKILL_NAME,
    decision_type: 'optimization',
    subject_type: 'dealer',
    subject_id: dealerId,
    inputs: { outcome_window_days: OUTCOME_WINDOW_DAYS, attribution_window_days: ATTRIBUTION_WINDOW_DAYS },
    evidence: [],
    output: JSON.parse(JSON.stringify(result)) as Record<string, unknown>,
    confidence: Math.min(0.9, 0.3 + sample / 200),
    engine: 'rules',
  });
  return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
}

export const skill = defineSkill<{ dealer_id: string }, Record<string, unknown>>({
  name: SKILL_NAME,
  category: 'operations',
  agent: OPTIMIZATION_AGENT,
  description: '按线索与成交结果优化：搜索词演化、评分阈值建议（不自动修改）、内容支柱信号、账号负载均衡',
  input: v.object({ dealer_id: v.string({ min: 1 }) }),
  run: (ctx, input) => runOptimization(ctx, input.dealer_id),
});
