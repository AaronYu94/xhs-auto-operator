/**
 * Account strategy (B3, spec §15/§16): turns an account's persona content mix into this period's pillar weights,
 * adjusted by (a) the dealer goal for accounts that carry the goal models, (b) the dealer's latest research
 * briefs (finance questions → finance_explainer, comparisons → comparison) and (c) content→lead attribution of
 * the account's own published posts — qualified leads per post outweigh likes.
 */
import type { AppContext } from '../../../app/context.ts';
import { NotFoundError, ValidationError } from '../../../core/errors.ts';
import { round } from '../../../core/text.ts';
import { DAY_MS } from '../../../core/time.ts';
import {
  CONTENT_PILLARS,
  GOAL_TYPES,
  LEAD_STAGES,
  type AccountType,
  type ContentPillar,
  type ContentPlan,
  type Evidence,
  type GoalSpec,
  type ResearchBrief,
  type XhsAccount,
} from '../../../core/types.ts';
import { v, type Validator } from '../../../core/validate.ts';
import { modelShortLabel, resolveModelName } from '../../../domain/automotive-lexicon.ts';
import { defineSkill } from '../../registry.ts';
import { ensurePersona, requireAccount } from '../../operations/account-brain/index.ts';
import { STAGE_INDEX } from '../../operations/crm/index.ts';
import { getDealerProfile } from '../../operations/dealer-brain/index.ts';
import { FINANCE_CLUSTER_KEYS, clusterKeyForLabel, latestBrief } from '../../research/shared.ts';

export type AccountStrategy = ContentPlan['strategy'];

export const STRATEGY_AGENT = 'account-strategy-agent';
export const SKILL_NAME = 'account-strategy';

/** Pillars boosted for accounts whose focus models include the goal models. */
export const GOAL_PILLARS: readonly ContentPillar[] = ['model_review', 'price_offer', 'inventory_showcase'];
/** Goal boost strength by account type (salesperson and model specialist carry goal models hardest). */
export const GOAL_STRENGTH: Readonly<Record<AccountType, number>> = {
  salesperson: 1,
  model_specialist: 1,
  official: 0.6,
  local_guide: 0.4,
  customer_story: 0.25,
};
export const GOAL_BOOST = 0.12;
export const RESEARCH_BOOST = 0.1;
/** How well a research-driven pillar suits an account type (0..1). */
export const PILLAR_FIT: Readonly<Record<AccountType, Partial<Record<ContentPillar, number>>>> = {
  official: { finance_explainer: 0.7, comparison: 0.3 },
  salesperson: { finance_explainer: 1, comparison: 1 },
  model_specialist: { finance_explainer: 0.6, comparison: 1 },
  local_guide: { finance_explainer: 1, comparison: 0.6 },
  customer_story: { finance_explainer: 0.2, comparison: 0.2 },
};
export const ATTRIBUTION_BOOST = 0.3;
export const ENGAGEMENT_BOOST = 0.03;
export const NO_LEAD_PENALTY = 0.8;
export const MIN_PILLAR_WEIGHT = 0.05;
export const RESEARCH_MAX_AGE_DAYS = 30;
export const ATTRIBUTION_WINDOW_DAYS = 90;
/** Research signal thresholds: at least this many mentions and this share of question mentions. */
export const RESEARCH_MIN_COUNT = 2;
export const RESEARCH_MIN_SHARE = 0.15;

const TYPE_LABEL: Record<AccountType, string> = {
  official: '官方号',
  salesperson: '销售号',
  model_specialist: '车型专研号',
  local_guide: '本地攻略号',
  customer_story: '车主故事号',
};

/** Used only when a persona has no usable content mix. */
const TYPE_FALLBACK_PILLARS: Record<AccountType, ContentPillar[]> = {
  official: ['dealer_event', 'price_offer', 'inventory_showcase', 'model_review'],
  salesperson: ['buying_guide', 'price_offer', 'comparison', 'customer_story'],
  model_specialist: ['model_review', 'comparison', 'ownership_tips'],
  local_guide: ['buying_guide', 'local_life', 'finance_explainer'],
  customer_story: ['customer_story', 'ownership_tips', 'local_life'],
};

export const PILLAR_LABEL: Record<ContentPillar, string> = {
  model_review: '车型解读',
  price_offer: '价格优惠',
  inventory_showcase: '现车展示',
  comparison: '车型对比',
  buying_guide: '购车攻略',
  finance_explainer: '金融置换',
  customer_story: '车主故事',
  local_life: '本地生活',
  dealer_event: '门店活动',
  ownership_tips: '用车贴士',
};

const key = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');
const canon = (m: string) => resolveModelName(m.trim()) ?? m.trim();
const pctText = (w: number) => `${Math.round(w * 1000) / 10}%`;
const plusText = (d: number) => `+${Math.round(d * 1000) / 10}%`;

export const goalSpecValidator: Validator<GoalSpec> = v.object({
  type: v.literal(GOAL_TYPES),
  brand: v.optional(v.string()),
  models: v.array(v.string({ min: 1, max: 40 }), { max: 20 }),
  location: v.optional(v.string()),
  province: v.optional(v.string()),
  nationwide: v.optional(v.boolean()),
  timeframe: v.optional(v.object({ label: v.string(), start: v.string(), end: v.string() })),
  target_leads: v.optional(v.number({ min: 0 })),
  notes: v.optional(v.array(v.string())),
}) as Validator<GoalSpec>;

export interface StrategyOptions {
  goal?: GoalSpec | null;
  goal_id?: string | null;
}

/** Goal from opts.goal, else the stored operator goal (must belong to the account's dealer). */
export function resolveGoal(ctx: AppContext, dealerId: string, opts: StrategyOptions): GoalSpec | null {
  if (opts.goal) return goalSpecValidator(opts.goal, 'goal');
  if (!opts.goal_id) return null;
  const row = ctx.db.table('operator_goals').get(opts.goal_id);
  if (!row) throw new NotFoundError('operator_goal', opts.goal_id);
  if (row.dealer_id !== dealerId) throw new ValidationError('goal_id', `goal ${opts.goal_id} belongs to another dealer`);
  return goalSpecValidator(row.spec, 'goal');
}

/** Persona focus ∩ carried models, goal models first (canonical names, persona order otherwise). */
export function strategyFocusModels(personaFocus: readonly string[], carried: readonly string[], goal: GoalSpec | null): string[] {
  const carriedKeys = new Set(carried.map(key));
  const seen = new Set<string>();
  const persona: string[] = [];
  for (const raw of personaFocus) {
    const m = canon(raw);
    if (!m || !carriedKeys.has(key(m)) || seen.has(key(m))) continue;
    seen.add(key(m));
    persona.push(m);
  }
  const goalKeys = (goal?.models ?? []).map((m) => key(canon(m)));
  const first = goalKeys.map((g) => persona.find((m) => key(m) === g)).filter((m): m is string => !!m);
  return [...new Set([...first, ...persona])];
}

export interface PillarAttribution {
  pillar: ContentPillar;
  posts: number;
  qualified_leads: number;
  engagement: number;
  post_ids: string[];
  titles: { id: string; title: string }[];
}

const QUALIFIED_STAGES = LEAD_STAGES.filter((s) => s !== 'LOST' && STAGE_INDEX[s] >= STAGE_INDEX.QUALIFIED);

/**
 * Pillar outcomes of the account's PUBLISHED posts in the attribution window: qualified leads (leads.attributed_post_id
 * at QUALIFIED or deeper; LOST leads count when they had reached QUALIFIED+) and engagement (likes+collects+comments+shares).
 */
export function pillarAttribution(ctx: AppContext, accountId: string): PillarAttribution[] {
  const since = new Date(ctx.clock.now().getTime() - ATTRIBUTION_WINDOW_DAYS * DAY_MS).toISOString();
  const placeholders = QUALIFIED_STAGES.map(() => '?').join(', ');
  const rows = ctx.db.all<{ id: string; pillar: ContentPillar; title: string; metrics: string; qualified: number }>(
    `SELECT p.id, p.pillar, p.title, p.metrics,
       (SELECT COUNT(*) FROM leads l WHERE l.attributed_post_id = p.id AND (
          l.stage IN (${placeholders})
          OR (l.stage = 'LOST' AND EXISTS (SELECT 1 FROM lead_stage_transitions t WHERE t.lead_id = l.id AND t.to_stage IN (${placeholders})))
       )) AS qualified
     FROM posts p
     WHERE p.account_id = ? AND p.status = 'PUBLISHED' AND COALESCE(p.published_at, p.updated_at) >= ?
     ORDER BY COALESCE(p.published_at, p.updated_at) DESC, p.id ASC`,
    ...QUALIFIED_STAGES,
    ...QUALIFIED_STAGES,
    accountId,
    since,
  );
  const byPillar = new Map<ContentPillar, PillarAttribution>();
  for (const r of rows) {
    let metrics: { likes?: number; collects?: number; comments?: number; shares?: number } = {};
    try {
      metrics = JSON.parse(r.metrics) as typeof metrics;
    } catch {
      metrics = {};
    }
    const engagement = (metrics.likes ?? 0) + (metrics.collects ?? 0) + (metrics.comments ?? 0) + (metrics.shares ?? 0);
    let a = byPillar.get(r.pillar);
    if (!a) {
      a = { pillar: r.pillar, posts: 0, qualified_leads: 0, engagement: 0, post_ids: [], titles: [] };
      byPillar.set(r.pillar, a);
    }
    a.posts += 1;
    a.qualified_leads += Number(r.qualified) || 0;
    a.engagement += engagement;
    a.post_ids.push(r.id);
    if (r.title.trim()) a.titles.push({ id: r.id, title: r.title });
  }
  return CONTENT_PILLARS.map((p) => byPillar.get(p)).filter((x): x is PillarAttribution => !!x);
}

interface ResearchSignals {
  briefs: ResearchBrief[];
  finance: { count: number; share: number } | null;
  comparison: { xhs_count: number; xhs_share: number; competitor_mentions: number } | null;
}

function relevantToFocus(brief: ResearchBrief, focus: readonly string[]): boolean {
  if (focus.length === 0 || brief.scope.models.length === 0) return true;
  const keys = new Set(focus.map(key));
  return brief.scope.models.some((m) => keys.has(key(m)));
}

function researchSignals(ctx: AppContext, dealerId: string, focus: readonly string[]): ResearchSignals {
  const briefs = (['xhs', 'competitor', 'market', 'trend'] as const)
    .map((kind) => latestBrief(ctx, dealerId, kind, RESEARCH_MAX_AGE_DAYS, { with_data: true }))
    .filter((b): b is ResearchBrief => b !== null && relevantToFocus(b, focus))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  const xhs = briefs.find((b) => b.kind === 'xhs');
  const competitor = briefs.find((b) => b.kind === 'competitor');
  let finance: ResearchSignals['finance'] = null;
  let comparison: ResearchSignals['comparison'] = null;
  const questions = xhs?.findings.top_questions ?? [];
  const totalMentions = questions.reduce((s, q) => s + q.count, 0);
  if (totalMentions > 0) {
    const financeCount = questions.filter((q) => {
      const k = clusterKeyForLabel(q.question);
      return k !== null && FINANCE_CLUSTER_KEYS.includes(k);
    }).reduce((s, q) => s + q.count, 0);
    if (financeCount > 0) finance = { count: financeCount, share: financeCount / totalMentions };
    const cmp = questions.filter((q) => clusterKeyForLabel(q.question) === 'model_comparison').reduce((s, q) => s + q.count, 0);
    if (cmp > 0) comparison = { xhs_count: cmp, xhs_share: cmp / totalMentions, competitor_mentions: 0 };
  }
  const focusKeys = new Set(focus.map(key));
  const mentions = (competitor?.findings.competitors ?? [])
    .filter((c) => focusKeys.size === 0 || focusKeys.has(key(c.comparison_with)))
    .reduce((s, c) => s + c.mentions, 0);
  if (mentions > 0) comparison = { xhs_count: comparison?.xhs_count ?? 0, xhs_share: comparison?.xhs_share ?? 0, competitor_mentions: mentions };
  return { briefs, finance, comparison };
}

/** Normalize to 1, drop pillars below MIN_PILLAR_WEIGHT, renormalize, round to 3 decimals keeping the sum at 1. */
export function normalizePillarWeights(weights: ReadonlyMap<ContentPillar, number>): { kept: [ContentPillar, number][]; dropped: [ContentPillar, number][] } {
  const positive = [...weights.entries()].filter(([, w]) => w > 0);
  const total = positive.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return { kept: [], dropped: [] };
  const normalized = positive.map(([p, w]) => [p, w / total] as [ContentPillar, number]);
  const dropped = normalized.filter(([, w]) => w < MIN_PILLAR_WEIGHT);
  let kept = normalized.filter(([, w]) => w >= MIN_PILLAR_WEIGHT);
  if (kept.length === 0) kept = [[...normalized].sort((a, b) => b[1] - a[1])[0]];
  const keptTotal = kept.reduce((s, [, w]) => s + w, 0);
  const order = (p: ContentPillar) => CONTENT_PILLARS.indexOf(p);
  let rounded = kept
    .map(([p, w]) => [p, round(w / keptTotal, 3)] as [ContentPillar, number])
    .sort((a, b) => b[1] - a[1] || order(a[0]) - order(b[0]));
  const diff = round(1 - rounded.reduce((s, [, w]) => s + w, 0), 3);
  if (diff !== 0) rounded[0] = [rounded[0][0], round(rounded[0][1] + diff, 3)];
  rounded = rounded.sort((a, b) => b[1] - a[1] || order(a[0]) - order(b[0]));
  return { kept: rounded, dropped };
}

/** Build (and audit) the account's content strategy for the next planning period. */
export function buildAccountStrategy(ctx: AppContext, accountId: string, opts: StrategyOptions = {}): AccountStrategy {
  const account: XhsAccount = requireAccount(ctx, accountId);
  const persona = ensurePersona(ctx, account);
  const profile = getDealerProfile(ctx, account.dealer_id);
  const goal = resolveGoal(ctx, account.dealer_id, opts);
  const type = account.account_type;
  const focus = strategyFocusModels(persona.focus_models, profile.models, goal);

  const weights = new Map<ContentPillar, number>();
  const notes = new Map<ContentPillar, string[]>();
  const note = (p: ContentPillar, text: string) => notes.set(p, [...(notes.get(p) ?? []), text]);
  const add = (p: ContentPillar, delta: number, text: string) => {
    if (delta <= 0) return;
    weights.set(p, (weights.get(p) ?? 0) + delta);
    note(p, text);
  };
  const evidence: Evidence[] = [];

  // base: persona content mix
  const mix = CONTENT_PILLARS.map((p) => [p, Number(persona.content_mix?.[p] ?? 0)] as [ContentPillar, number]).filter(
    ([, w]) => Number.isFinite(w) && w > 0,
  );
  const mixTotal = mix.reduce((s, [, w]) => s + w, 0);
  const baseMix: Partial<Record<ContentPillar, number>> = {};
  if (mixTotal > 0) {
    for (const [p, w] of mix) {
      weights.set(p, w / mixTotal);
      baseMix[p] = round(w / mixTotal, 4);
      note(p, `人设内容配比${pctText(w / mixTotal)}`);
    }
  } else {
    const fallback = TYPE_FALLBACK_PILLARS[type];
    for (const p of fallback) {
      weights.set(p, 1 / fallback.length);
      baseMix[p] = round(1 / fallback.length, 4);
      note(p, `人设未配置内容配比，按${TYPE_LABEL[type]}默认支柱均分${pctText(1 / fallback.length)}`);
    }
  }

  // (a) goal models carried by this account
  const goalModels = (goal?.models ?? []).map(canon);
  const goalHits = focus.filter((m) => goalModels.some((g) => key(g) === key(m)));
  let goalDelta = 0;
  if (goal && goalHits.length > 0) {
    const strength = GOAL_STRENGTH[type];
    goalDelta = GOAL_BOOST * strength;
    const labels = goalHits.map((m) => modelShortLabel(m)).join('、');
    for (const p of GOAL_PILLARS) add(p, goalDelta, `目标车型${labels}属于本账号主推车型（${TYPE_LABEL[type]}目标加权×${strength}）${plusText(goalDelta)}`);
  }

  // (b) research briefs
  const research = researchSignals(ctx, account.dealer_id, focus);
  const briefDate = (kind: string) => research.briefs.find((b) => b.kind === kind)?.created_at.slice(0, 10) ?? '';
  if (research.finance && research.finance.count >= RESEARCH_MIN_COUNT && research.finance.share >= RESEARCH_MIN_SHARE) {
    const fit = PILLAR_FIT[type].finance_explainer ?? 0;
    const delta = RESEARCH_BOOST * fit * Math.min(1, research.finance.share / 0.3);
    add(
      'finance_explainer',
      delta,
      `近期调研（${briefDate('xhs')}）：买家贷款/租赁/置换类提问${research.finance.count}次，占提问${Math.round(research.finance.share * 100)}%（${TYPE_LABEL[type]}适配度${fit}）${plusText(delta)}`,
    );
  }
  if (research.comparison) {
    const c = research.comparison;
    const xhsIntensity = c.xhs_count >= RESEARCH_MIN_COUNT && c.xhs_share >= RESEARCH_MIN_SHARE ? Math.min(1, c.xhs_share / 0.3) : 0;
    const competitorIntensity = c.competitor_mentions >= RESEARCH_MIN_COUNT ? Math.min(1, c.competitor_mentions / 10) : 0;
    const intensity = Math.max(xhsIntensity, competitorIntensity);
    const fit = PILLAR_FIT[type].comparison ?? 0;
    if (intensity > 0) {
      const delta = RESEARCH_BOOST * fit * intensity;
      const parts = [
        c.xhs_count > 0 ? `买家车型对比提问${c.xhs_count}次` : '',
        c.competitor_mentions > 0 ? `竞品同框讨论${c.competitor_mentions}次（${briefDate('competitor')}）` : '',
      ].filter(Boolean);
      add('comparison', delta, `近期调研：${parts.join('，')}（${TYPE_LABEL[type]}适配度${fit}）${plusText(delta)}`);
    }
  }
  for (const b of research.briefs) evidence.push({ code: 'research_brief', label: `${b.kind}调研：${b.findings.headline}`, source_ref: `research_brief:${b.id}` });

  // (c) content → lead attribution (leads outweigh likes)
  const attribution = pillarAttribution(ctx, accountId);
  const totalQualified = attribution.reduce((s, a) => s + a.qualified_leads, 0);
  if (totalQualified > 0) {
    for (const a of attribution) {
      if (a.posts >= 2 && a.qualified_leads === 0 && weights.has(a.pillar)) {
        weights.set(a.pillar, (weights.get(a.pillar) ?? 0) * NO_LEAD_PENALTY);
        note(a.pillar, `近${ATTRIBUTION_WINDOW_DAYS}天${a.posts}篇已发布笔记未带来合格线索，权重×${NO_LEAD_PENALTY}`);
      }
    }
    const rateSum = attribution.reduce((s, a) => s + a.qualified_leads / a.posts, 0);
    for (const a of attribution) {
      if (a.qualified_leads === 0) continue;
      const rate = a.qualified_leads / a.posts;
      const delta = ATTRIBUTION_BOOST * (rate / rateSum);
      add(
        a.pillar,
        delta,
        `内容→线索归因：近${ATTRIBUTION_WINDOW_DAYS}天${a.posts}篇已发布笔记带来${a.qualified_leads}条合格线索（${round(rate, 2)}条/篇）${plusText(delta)}`,
      );
      for (const t of a.titles.slice(0, 2)) {
        evidence.push({ code: 'post_attribution', label: `${PILLAR_LABEL[a.pillar]}：${a.qualified_leads}条合格线索/${a.posts}篇`, quote: t.title, source_ref: `post:${t.id}` });
      }
    }
  }
  const totalEngagement = attribution.reduce((s, a) => s + a.engagement, 0);
  if (totalEngagement > 0) {
    for (const a of attribution) {
      if (a.engagement <= 0) continue;
      const delta = ENGAGEMENT_BOOST * (a.engagement / totalEngagement);
      add(a.pillar, delta, `互动${a.engagement}（仅作参考，线索结果优先）${plusText(delta)}`);
    }
  }

  const { kept, dropped } = normalizePillarWeights(weights);
  const pillars = kept.map(([pillar, weight]) => ({
    pillar,
    weight,
    rationale: `${PILLAR_LABEL[pillar]}：${(notes.get(pillar) ?? []).join('；')}；最终权重${pctText(weight)}`,
  }));
  const research_insights = research.briefs.map((b) => b.findings.headline).filter((h) => h.trim().length > 0).slice(0, 5);
  const strategy: AccountStrategy = {
    positioning: persona.content_positioning,
    pillars,
    focus_models: focus,
    research_insights,
    ...(opts.goal_id ? { goal_id: opts.goal_id } : {}),
  };

  const confidence = Math.min(0.9, 0.6 + (research.briefs.length > 0 ? 0.1 : 0) + (totalQualified > 0 ? 0.2 : 0));
  ctx.audit.decision({
    agent: STRATEGY_AGENT,
    skill: SKILL_NAME,
    decision_type: 'content_strategy',
    subject_type: 'account',
    subject_id: accountId,
    inputs: {
      account_id: accountId,
      dealer_id: account.dealer_id,
      account_type: type,
      base_mix: baseMix,
      persona_focus_models: persona.focus_models,
      carried_models: profile.models,
      goal,
      goal_id: opts.goal_id ?? null,
      goal_boost: goalDelta,
      research: {
        briefs: research.briefs.map((b) => ({ id: b.id, kind: b.kind, created_at: b.created_at })),
        finance: research.finance,
        comparison: research.comparison,
      },
      attribution: attribution.map((a) => ({ pillar: a.pillar, posts: a.posts, qualified_leads: a.qualified_leads, engagement: a.engagement })),
    },
    evidence,
    output: { strategy, dropped_pillars: dropped.map(([p, w]) => ({ pillar: p, weight: round(w, 4) })) },
    confidence,
    engine: 'rules',
    workflow_run_id: ctx.runId,
  });
  return strategy;
}

export interface AccountStrategySkillInput {
  account_id: string;
  goal?: GoalSpec;
  goal_id?: string | null;
}

export const skill = defineSkill<AccountStrategySkillInput, AccountStrategy>({
  name: SKILL_NAME,
  category: 'content',
  agent: 'account-strategy-agent',
  description:
    '账号内容策略：以人设内容配比为基础，按经营目标车型、最新调研简报（金融/对比类提问）和“内容→合格线索”归因调整各内容支柱权重（线索结果优先于点赞），输出带中文理由的策略。',
  input: v.object({
    account_id: v.string({ min: 1 }),
    goal: v.optional(goalSpecValidator),
    goal_id: v.optional(v.nullable(v.string({ min: 1 }))),
  }),
  run(ctx, input) {
    return buildAccountStrategy(ctx, input.account_id, { goal: input.goal ?? null, goal_id: input.goal_id ?? null });
  },
  validateOutput(output) {
    const sum = output.pillars.reduce((s, p) => s + p.weight, 0);
    if (output.pillars.length === 0) throw new Error('account-strategy: no pillars');
    if (Math.abs(sum - 1) > 1e-6) throw new Error(`account-strategy: weights sum to ${sum}`);
    for (const p of output.pillars) {
      if (p.weight < MIN_PILLAR_WEIGHT) throw new Error(`account-strategy: pillar ${p.pillar} below minimum weight`);
      if (!p.rationale.trim()) throw new Error(`account-strategy: pillar ${p.pillar} lacks a rationale`);
    }
  },
});
