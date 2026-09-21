/**
 * Fleet Controller (spec §11, ARCHITECTURE §5.3 + §8 B5): exclusive, explainable lead-to-account assignment.
 *
 * Every candidate account is scored on seven factors (location, model specialization, persona fit,
 * response rate, conversion rate, load, health) with a Chinese reason per factor, so a salesperson can see
 * WHY an account owns a lead. Ownership is exclusive (DB partial unique index) and sticky: an account that
 * already contacted the user keeps the relationship unless an operator explicitly reassigns it.
 */
import type { AppContext } from '../../../app/context.ts';
import { NotFoundError, PolicyError, ValidationError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import { clamp, round } from '../../../core/text.ts';
import { addDays, localDateKey } from '../../../core/time.ts';
import type {
  AccountHealth,
  AccountPersona,
  AccountType,
  AssignmentCandidate,
  Dealer,
  Lead,
  LeadAssignment,
  OutreachStatus,
  PurchaseStage,
  ScoreComponent,
  TransactionQuestion,
  XhsAccount,
} from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import {
  CITY_PROVINCE,
  findBrands,
  findLocation,
  getBrandInfo,
  getModelInfo,
  provinceOfIp,
  resolveModelName,
} from '../../../domain/automotive-lexicon.ts';
import { defineSkill } from '../../registry.ts';
import { effectiveOutreachPolicy, ensurePersona, getAccountPerformance } from '../../operations/account-brain/index.ts';
import { computeAccountHealth, getLatestHealth, isAccountOperable } from '../../operations/account-health/index.ts';
import { isSuppressed, STAGE_INDEX, transitionLead } from '../../operations/crm/index.ts';
import { getScoringConfig } from '../lead-scoring/index.ts';

const AGENT = 'fleet-controller';
const SKILL = 'account-assignment';
export const DEFAULT_ASSIGNER = 'agent:fleet-controller';

/** Maximum points per factor (sum 100). */
export const ASSIGNMENT_FACTOR_MAX = Object.freeze({
  location: 20,
  model_specialization: 20,
  persona_fit: 15,
  response_rate: 10,
  conversion_rate: 10,
  load: 10,
  health: 15,
});
export type AssignmentFactor = keyof typeof ASSIGNMENT_FACTOR_MAX;

export const INTENT_CLASSES = ['transactional', 'research', 'awareness'] as const;
export type IntentClass = (typeof INTENT_CLASSES)[number];

/** persona_fit points by lead intent class × account type. */
export const PERSONA_FIT_POINTS: Readonly<Record<IntentClass, Readonly<Record<AccountType, number>>>> = Object.freeze({
  transactional: { salesperson: 15, model_specialist: 10, official: 8, local_guide: 6, customer_story: 4 },
  research: { model_specialist: 15, local_guide: 11, salesperson: 9, customer_story: 8, official: 7 },
  awareness: { customer_story: 12, local_guide: 12, model_specialist: 9, official: 8, salesperson: 6 },
});

/** A focus list with at most this many models counts as specialized. */
export const SPECIALIST_MAX_FOCUS_MODELS = 3;
/** Neutral priors and calibration targets (a target rate earns full points; the prior equals half of it). */
export const RATE_PRIOR_POINTS = 5;
export const MIN_OUTREACH_FOR_REPLY_RATE = 5;
export const MIN_CONTACTED_FOR_CONVERSION_RATE = 3;
export const REPLY_RATE_TARGET = 0.5;
export const CONVERSION_RATE_TARGET = 0.2;
/** capacity = LOAD_CAPACITY_MULTIPLIER × effective daily outreach limit */
export const LOAD_CAPACITY_MULTIPLIER = 5;

/** Outreach not yet delivered that a released owner must never send. */
export const PENDING_OUTREACH_STATUSES: readonly OutreachStatus[] = ['DRAFT', 'READY_FOR_REVIEW', 'APPROVED'];
const SENT_STATUSES = `('SENT', 'SENT_MANUALLY')`;

export const REASSIGN_CANCEL_REASON = '线索已重新分配';
/** blocked_reason for undelivered outreach of a non-owner account found when a new owner is created */
export const ORPHAN_OUTREACH_CANCEL_REASON = '线索已由其他账号负责，原账号的待发私信作废';
export const STICKY_UNAVAILABLE_REASON = '原负责账号不可用，需人工重新分配';
/** Why a lead was freed: its owning account left the fleet. The lead itself is never deleted with an account. */
export const GONE_ACCOUNT_REASON = '负责账号已从账号矩阵移除，线索回到门店线索池';
export const INDUSTRY_ACCOUNT_REASON = '线索为车商/销售等行业账号，非购车客户，不分配账号';

const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  official: '官方号',
  salesperson: '销售顾问号',
  model_specialist: '车型专家号',
  local_guide: '本地攻略号',
  customer_story: '车主故事号',
};

const INTENT_CLASS_LABELS: Record<IntentClass, string> = {
  transactional: '成交型需求',
  research: '调研/对比型需求',
  awareness: '认知型需求',
};

const TRANSACTIONAL_STAGES: readonly PurchaseStage[] = ['price_shopping', 'active_shopping', 'dealer_selection', 'purchase_imminent'];
const STAGE_LABELS: Record<PurchaseStage, string> = {
  awareness: '认知了解',
  research: '调研了解',
  comparison: '对比选车',
  price_shopping: '询价比价',
  active_shopping: '积极选购',
  dealer_selection: '选择门店',
  purchase_imminent: '即将购买',
};
const TQ_LABELS: Partial<Record<TransactionQuestion, string>> = {
  price: '询问价格',
  landing_price: '询问落地价',
  discount: '询问优惠',
  inventory: '询问现车',
  color_trim_availability: '询问指定颜色/配置',
  finance: '询问贷款',
  lease: '询问租赁',
  trade_in: '询问置换',
  dealer_location: '询问门店',
  test_drive: '想到店看车',
};

// ─────────────────────────────────────────────────────────────────────────────
// Lead-side context
// ─────────────────────────────────────────────────────────────────────────────

export interface IntentClassification {
  intent_class: IntentClass;
  /** Chinese cues that produced the class, e.g. ['询问现车', '即将购买'] */
  cues: string[];
}

/** Pure: classify a lead's merged intent (+ transaction questions of its purchase signals) for persona fit. */
export function classifyLeadIntent(lead: Pick<Lead, 'intent'>, transactionQuestions: readonly TransactionQuestion[] = []): IntentClassification {
  const intent = lead.intent ?? {};
  const cues: string[] = [];
  const add = (cue: string) => {
    if (!cues.includes(cue)) cues.push(cue);
  };
  if (intent.inventory_intent) add('询问现车');
  if (intent.color_intent) add('询问指定颜色/配置');
  if (intent.price_intent) add('询问价格/落地价');
  if (intent.discount_intent) add('询问优惠');
  if (intent.financing_intent) add('询问贷款');
  if (intent.leasing_intent) add('询问租赁');
  if (intent.trade_in_intent) add('询问置换');
  if (intent.dealer_selection_intent) add('询问门店');
  if (intent.visit_intent) add('想到店看车');
  for (const tq of transactionQuestions) {
    const label = TQ_LABELS[tq];
    if (label && !(tq === 'price' && cues.includes('询问价格/落地价')) && !(tq === 'landing_price' && cues.includes('询问价格/落地价')))
      add(label);
  }
  const stage = intent.purchase_stage;
  if (stage && TRANSACTIONAL_STAGES.includes(stage)) add(STAGE_LABELS[stage]);
  if (cues.length > 0) return { intent_class: 'transactional', cues };
  if (stage === 'research' || stage === 'comparison') return { intent_class: 'research', cues: [STAGE_LABELS[stage]] };
  if ((intent.competing_models ?? []).length > 0) return { intent_class: 'research', cues: ['对比竞品车型'] };
  if (stage === 'awareness') return { intent_class: 'awareness', cues: [STAGE_LABELS.awareness] };
  return { intent_class: 'research', cues: ['购买阶段未知，按调研阶段匹配'] };
}

/** Where the lead's location came from: stated by the user, inferred from the post context, or the IP 属地. */
export type LocationSource = 'stated' | 'post_context' | 'ip';

interface LeadContext {
  lead: Lead;
  dealer: Dealer;
  city: string | null;
  province: string | null;
  ip_province: string | null;
  location_source: LocationSource | null;
  model: string | null;
  brand: string | null;
  competing_models: string[];
  classification: IntentClassification;
}

const normPlace = (s: string | null | undefined): string | null => {
  const t = (s ?? '').normalize('NFKC').replace(/\s+/g, '');
  return t ? t : null;
};
/** '杭州市' / '杭州市西湖区' → '杭州', '魔都' → '上海'; unknown names keep their text (minus a trailing 市). */
function canonicalCity(s: string | null | undefined): string | null {
  const t = normPlace(s);
  if (!t) return null;
  const short = t.replace(/市$/, '');
  if (CITY_PROVINCE[short]) return short;
  return findLocation(t)?.city ?? short;
}
/** '浙江省' → '浙江', '广西壮族自治区' → '广西', '杭州' → '浙江'; unknown → null. */
function canonicalProvince(s: string | null | undefined): string | null {
  const t = normPlace(s);
  return t ? provinceOfIp(t) : null;
}
/** True when the text names a province rather than a city ('浙江', '广东省'); municipalities count as cities. */
function isProvinceName(s: string | null | undefined): boolean {
  const t = normPlace(s);
  if (!t) return false;
  if (CITY_PROVINCE[t.replace(/市$/, '')] || findLocation(t)?.city) return false;
  const province = provinceOfIp(t);
  return province !== null && t.startsWith(province);
}
const modelKey = (s: string): string => (resolveModelName(s) ?? s).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
/** '宝马' / 'bmw' / '寶馬' → 'BMW'; unknown brands keep their text. */
function canonicalBrand(s: string): string {
  const t = s.normalize('NFKC').trim();
  return getBrandInfo(t)?.brand ?? findBrands(t)[0]?.brand ?? t;
}
const brandKey = (s: string): string => canonicalBrand(s).toLowerCase().replace(/\s+/g, '');

function requireLead(ctx: AppContext, leadId: string): Lead {
  const lead = ctx.db.table('leads').get(leadId);
  if (!lead) throw new NotFoundError('lead', leadId);
  return lead;
}

function requireDealer(ctx: AppContext, dealerId: string): Dealer {
  const dealer = ctx.db.table('dealers').get(dealerId);
  if (!dealer) throw new NotFoundError('dealer', dealerId);
  return dealer;
}

/** Most recent IP 属地 among the lead's signal sources (comments / posts), normalized to a province. */
function leadIpProvince(ctx: AppContext, leadId: string): string | null {
  const rows = ctx.db.all<{ ip: string | null }>(
    `SELECT COALESCE(pc.ip_location, CASE WHEN s.source_type = 'post' THEN pp.ip_location END) AS ip
     FROM lead_signals s
       LEFT JOIN public_comments pc ON pc.id = s.public_comment_id
       LEFT JOIN public_posts pp ON pp.id = s.public_post_id
     WHERE s.lead_id = ?
     ORDER BY s.signal_at DESC, s.created_at DESC`,
    leadId,
  );
  for (const r of rows) {
    const p = provinceOfIp(r.ip);
    if (p) return p;
  }
  return null;
}

function leadTransactionQuestions(ctx: AppContext, leadId: string): TransactionQuestion[] {
  const out = new Set<TransactionQuestion>();
  for (const s of ctx.db.table('lead_signals').findMany({ lead_id: leadId, is_purchase_signal: true })) {
    for (const tq of s.transaction_questions ?? []) out.add(tq);
  }
  return [...out];
}

function buildLeadContext(ctx: AppContext, lead: Lead): LeadContext {
  const dealer = requireDealer(ctx, lead.dealer_id);
  const intent = lead.intent ?? {};
  const inferred = new Set(intent.inferred_fields ?? []);
  // A province written into the location field ('浙江', '广东省') is a province, not a city.
  const locationIsProvince = isProvinceName(intent.location);
  const city = intent.location && !locationIsProvince ? canonicalCity(intent.location) : null;
  const province =
    canonicalProvince(intent.province) ??
    (locationIsProvince ? canonicalProvince(intent.location) : null) ??
    (city ? (CITY_PROVINCE[city] ?? null) : null);
  const ipProvince = leadIpProvince(ctx, lead.id);
  let locationSource: LocationSource | null = null;
  if (city) locationSource = inferred.has('location') ? 'post_context' : 'stated';
  else if (province) {
    const provinceInferred = locationIsProvince ? inferred.has('location') : inferred.has('province');
    const ipEvidence = (lead.evidence ?? []).some((e) => e.code === 'ip_location');
    locationSource = !provinceInferred ? 'stated' : ipEvidence || ipProvince === province ? 'ip' : 'post_context';
  }
  const model = intent.model ? (resolveModelName(intent.model) ?? intent.model) : null;
  // The lexicon brand of a known model wins over a merged intent brand ('Model 3' is never a BMW brand match).
  const modelBrand = model ? getModelInfo(model)?.brand : undefined;
  const brand = modelBrand ?? (intent.brand ? canonicalBrand(intent.brand) : null);
  return {
    lead,
    dealer,
    city,
    province,
    ip_province: ipProvince,
    location_source: locationSource,
    model,
    brand,
    competing_models: (intent.competing_models ?? []).map((m) => resolveModelName(m) ?? m),
    classification: classifyLeadIntent(lead, leadTransactionQuestions(ctx, lead.id)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Factor scoring
// ─────────────────────────────────────────────────────────────────────────────

const factor = (name: AssignmentFactor, points: number, reason: string): ScoreComponent => ({
  factor: name,
  points: round(clamp(points, 0, ASSIGNMENT_FACTOR_MAX[name]), 1),
  max: ASSIGNMENT_FACTOR_MAX[name],
  reason,
});

function accountProvince(account: XhsAccount, accountDealer: Dealer): string | null {
  const city = canonicalCity(account.city);
  if (city && CITY_PROVINCE[city]) return CITY_PROVINCE[city];
  const dealerProvince = canonicalProvince(accountDealer.province) ?? canonicalProvince(accountDealer.city);
  if (city && city === canonicalCity(accountDealer.city)) return dealerProvince;
  return canonicalProvince(account.city) ?? dealerProvince;
}

function scoreLocation(lc: LeadContext, account: XhsAccount, accountDealer: Dealer, crossDealer: boolean): ScoreComponent {
  if (crossDealer)
    return factor('location', 0, `跨门店账号：账号属于${accountDealer.name}，非线索所属门店${lc.dealer.name}，地域分不计`);
  const accCity = canonicalCity(account.city);
  const accProvince = accountProvince(account, accountDealer);
  const accLabel = account.city?.trim() || accountDealer.city;
  const note = lc.location_source === 'post_context' ? '（地域由所在帖子内容推断）' : '';
  if (lc.city && accCity && lc.city === accCity) return factor('location', 20, `客户在${lc.city}，与账号同城${note}`);
  if (lc.province) {
    const subject =
      lc.location_source === 'ip'
        ? `客户IP属地${lc.province}`
        : `客户在${lc.city && lc.city !== lc.province ? `${lc.city}（${lc.province}）` : lc.province}`;
    if (accProvince && lc.province === accProvince) return factor('location', 12, `${subject}，与账号（${accLabel}）同省${note}`);
    return factor('location', 0, `${subject}，与账号所在${accLabel}不同省${note}`);
  }
  if (lc.ip_province) {
    if (accProvince && lc.ip_province === accProvince)
      return factor('location', 12, `客户IP属地${lc.ip_province}，与账号（${accLabel}）同省`);
    return factor('location', 0, `客户IP属地${lc.ip_province}，与账号所在${accLabel}不同省`);
  }
  if (lc.city) return factor('location', 10, `客户所在地「${lc.city}」无法判断所属省份，地域按中性分计${note}`);
  return factor('location', 10, '客户未透露所在地，地域按中性分计');
}

function scoreModel(lc: LeadContext, persona: AccountPersona, accountDealer: Dealer): ScoreComponent {
  const focus = persona.focus_models ?? [];
  const focusKeys = new Set(focus.map(modelKey));
  const brands = (persona.focus_brands?.length ? persona.focus_brands : accountDealer.brands).map(brandKey);
  const focusLabel = focus.length > 0 ? `主攻${focus.join('、')}` : '未设定主攻车型';
  if (!lc.model) return factor('model_specialization', 10, '客户未指明具体车型，车型匹配按中性分计');
  if (focusKeys.has(modelKey(lc.model))) {
    if (focus.length <= SPECIALIST_MAX_FOCUS_MODELS)
      return factor('model_specialization', 20, `客户关注${lc.model}，是本账号主攻车型（${focusLabel}）`);
    return factor('model_specialization', 12, `客户关注${lc.model}，在本账号覆盖范围内（覆盖${focus.length}款车型，非专精）`);
  }
  const competing = lc.competing_models.find((m) => focusKeys.has(modelKey(m)));
  if (competing) return factor('model_specialization', 12, `客户对比车型中包含本账号主攻的${competing}（${focusLabel}）`);
  if (lc.brand && brands.includes(brandKey(lc.brand)))
    return factor('model_specialization', 8, `客户关注${lc.model}，仅品牌匹配，非本账号主攻车型（${focusLabel}）`);
  return factor('model_specialization', 0, `客户关注${lc.model}，与本账号车型和品牌均不匹配`);
}

function scorePersona(lc: LeadContext, account: XhsAccount): ScoreComponent {
  const cls = lc.classification;
  const points = PERSONA_FIT_POINTS[cls.intent_class][account.account_type];
  return factor(
    'persona_fit',
    points,
    `${INTENT_CLASS_LABELS[cls.intent_class]}（${cls.cues.join('、')}），${ACCOUNT_TYPE_LABELS[account.account_type]}人设匹配度${points}/${ASSIGNMENT_FACTOR_MAX.persona_fit}`,
  );
}

function contactedLeads90d(ctx: AppContext, accountId: string): number {
  const now = ctx.clock.now();
  const row = ctx.db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT lead_id) AS n FROM outreach WHERE account_id = ? AND status IN ${SENT_STATUSES}
     AND sent_at IS NOT NULL AND sent_at >= ? AND sent_at <= ?`,
    accountId,
    addDays(now, -90).toISOString(),
    now.toISOString(),
  );
  return Number(row?.n ?? 0);
}

/**
 * A same-day snapshot is stale when the account or its dealer settings changed after it was computed, or when the
 * LIVE operability (account-health `isAccountOperable`: disabled/RESTRICTED → blocking; requires_auth, ≥3 negative
 * responses in 7 days, daily limit reached → review) disagrees with the snapshot state. This catches a re-enabled or
 * re-authenticated account and new negative feedback even within the same clock instant.
 */
function isSnapshotStale(ctx: AppContext, account: XhsAccount, accountDealer: Dealer, snapshot: AccountHealth): boolean {
  if (account.updated_at > snapshot.computed_at || accountDealer.updated_at > snapshot.computed_at) return true;
  const live = isAccountOperable(ctx, account.id);
  const liveClass = live.blocking ? 'blocked' : live.ok ? 'ok' : 'review';
  const snapshotClass = snapshot.state === 'RESTRICTED' ? 'blocked' : snapshot.state === 'AT_RISK' ? 'review' : 'ok';
  return liveClass !== snapshotClass;
}

/** Today's (dealer-local) snapshot; (re)computed — and audited by account-health — when missing or stale. */
function todaysHealth(ctx: AppContext, account: XhsAccount, accountDealer: Dealer): AccountHealth {
  const today = localDateKey(ctx.clock.now(), accountDealer.settings.timezone);
  const latest = getLatestHealth(ctx, account.id);
  if (latest && latest.date === today && !isSnapshotStale(ctx, account, accountDealer, latest)) return latest;
  return computeAccountHealth(ctx, account.id);
}

interface Evaluated {
  candidate: AssignmentCandidate;
  account: XhsAccount;
  order: number;
}

function evaluateAccount(ctx: AppContext, lc: LeadContext, account: XhsAccount, order: number, crossDealer: boolean): Evaluated {
  const accountDealer = account.dealer_id === lc.dealer.id ? lc.dealer : requireDealer(ctx, account.dealer_id);
  const persona = ensurePersona(ctx, account);
  const perf = getAccountPerformance(ctx, account.id);
  const policy = effectiveOutreachPolicy(ctx, account.id);
  const factors: ScoreComponent[] = [
    scoreLocation(lc, account, accountDealer, crossDealer),
    scoreModel(lc, persona, accountDealer),
    scorePersona(lc, account),
  ];

  if (perf.outreach_sent_30d < MIN_OUTREACH_FOR_REPLY_RATE)
    factors.push(factor('response_rate', RATE_PRIOR_POINTS, `近30天仅发送${perf.outreach_sent_30d}条私信，样本不足，按中性分计`));
  else
    factors.push(
      factor(
        'response_rate',
        10 * Math.min(1, perf.reply_rate_30d / REPLY_RATE_TARGET),
        `近30天私信回复率${round(perf.reply_rate_30d * 100, 1)}%（发送${perf.outreach_sent_30d}条）`,
      ),
    );

  const contacted = contactedLeads90d(ctx, account.id);
  if (contacted < MIN_CONTACTED_FOR_CONVERSION_RATE)
    factors.push(factor('conversion_rate', RATE_PRIOR_POINTS, `近90天仅触达${contacted}位客户，成交数据不足，按中性分计`));
  else
    factors.push(
      factor(
        'conversion_rate',
        10 * Math.min(1, perf.conversion_rate_90d / CONVERSION_RATE_TARGET),
        `近90天成交转化率${round(perf.conversion_rate_90d * 100, 1)}%（成交${perf.won_90d}单，触达${contacted}位）`,
      ),
    );

  const ownsThis = ctx.db.table('lead_assignments').count({ lead_id: lc.lead.id, account_id: account.id, active: true }) > 0;
  const activeLeads = Math.max(0, perf.leads_owned_active - (ownsThis ? 1 : 0));
  const capacity = LOAD_CAPACITY_MULTIPLIER * policy.daily_limit;
  if (capacity <= 0) factors.push(factor('load', 0, `每日私信上限为${policy.daily_limit}，无法承接新线索`));
  else
    factors.push(
      factor('load', 10 * (1 - Math.min(1, activeLeads / capacity)), `当前负责${activeLeads}条活跃线索，容量${capacity}条（每日私信上限${policy.daily_limit}×${LOAD_CAPACITY_MULTIPLIER}）`),
    );

  let eligible = true;
  let excluded: string | undefined;
  if (account.group_id !== lc.lead.group_id) {
    eligible = false;
    excluded = '账号不属于该线索所属经销商集团';
    factors.push(factor('health', 0, excluded));
  } else if (account.status === 'disabled') {
    eligible = false;
    excluded = '账号已停用';
    factors.push(factor('health', 0, excluded));
  } else if (account.status === 'paused' || account.status === 'cooldown') {
    eligible = false;
    excluded = account.status === 'paused' ? '账号已暂停运营' : '账号处于冷却期';
    factors.push(factor('health', 0, excluded));
  } else {
    const health = todaysHealth(ctx, account, accountDealer);
    if (health.state === 'RESTRICTED') {
      eligible = false;
      excluded = `账号健康度受限（RESTRICTED）${health.issues.length ? `：${health.issues.join('；')}` : ''}`;
      factors.push(factor('health', 0, excluded));
    } else if (account.auth_state === 'requires_auth') {
      factors.push(factor('health', 3, `需重新登录：账号授权已失效（健康状态${health.state}）`));
    } else {
      const points = health.state === 'HEALTHY' ? 15 : health.state === 'WATCH' ? 9 : 3;
      const label = health.state === 'HEALTHY' ? '账号健康' : health.state === 'WATCH' ? '账号需关注' : '账号存在风险';
      factors.push(factor('health', points, `${label}（健康分${health.health_score}）${health.issues.length ? `：${health.issues.join('；')}` : ''}`));
    }
  }

  const score = round(factors.reduce((sum, f) => sum + f.points, 0), 1);
  const candidate: AssignmentCandidate = { account_id: account.id, nickname: account.nickname, score, eligible, factors };
  if (excluded) candidate.excluded_reason = excluded;
  return { candidate, account, order };
}

function sortEvaluated(list: Evaluated[]): Evaluated[] {
  return [...list].sort(
    (a, b) =>
      Number(b.candidate.eligible) - Number(a.candidate.eligible) ||
      b.candidate.score - a.candidate.score ||
      (a.account.created_at < b.account.created_at ? -1 : a.account.created_at > b.account.created_at ? 1 : 0) ||
      a.order - b.order,
  );
}

function accountsOrdered(ctx: AppContext, whereSql: string, ...params: string[]): XhsAccount[] {
  const table = ctx.db.table('xhs_accounts');
  return ctx.db.all(`SELECT * FROM xhs_accounts WHERE ${whereSql} ORDER BY created_at ASC, rowid ASC`, ...params).map((r) => table.decode(r));
}

interface Ranking {
  lc: LeadContext;
  evaluated: Evaluated[];
  fallback_used: boolean;
}

function rankInternal(ctx: AppContext, lead: Lead): Ranking {
  const lc = buildLeadContext(ctx, lead);
  let order = 0;
  const primary = accountsOrdered(ctx, 'dealer_id = ?', lead.dealer_id).map((a) => evaluateAccount(ctx, lc, a, order++, false));
  if (primary.some((e) => e.candidate.eligible)) return { lc, evaluated: sortEvaluated(primary), fallback_used: false };
  const others = accountsOrdered(ctx, 'group_id = ? AND dealer_id <> ?', lead.group_id, lead.dealer_id).map((a) =>
    evaluateAccount(ctx, lc, a, order++, true),
  );
  return { lc, evaluated: sortEvaluated([...primary, ...others]), fallback_used: others.length > 0 };
}

/** Rank every candidate account for the lead: eligible first, score desc, ties by account created_at asc. */
export function rankAccountsForLead(ctx: AppContext, lead: Lead): AssignmentCandidate[] {
  return rankInternal(ctx, lead).evaluated.map((e) => e.candidate);
}

// ─────────────────────────────────────────────────────────────────────────────
// Assignment
// ─────────────────────────────────────────────────────────────────────────────

export interface AssignLeadOptions {
  reassign_to?: string;
  actor?: string;
  reason?: string;
}

export interface AssignLeadResult {
  assignment: LeadAssignment | null;
  candidates: AssignmentCandidate[];
  changed: boolean;
  reason: string;
}

export type AssignmentMode = 'ranked' | 'sticky' | 'reassign';

export function getActiveAssignment(ctx: AppContext, leadId: string): LeadAssignment | undefined {
  return ctx.db.table('lead_assignments').findOne({ lead_id: leadId, active: true });
}

function isActiveAssignmentConflict(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed: lead_assignments');
}

/**
 * Confidence of choosing `chosenAccountId` (default: the best eligible account) from the score margin to the best
 * OTHER eligible account: 0.5 + margin/30 clamped to 0.05..0.99, so a choice that trails the top account is < 0.5.
 * 0.9 when the choice is the only eligible account; 1 when nothing is eligible (the failure itself is certain).
 */
export function assignmentConfidence(candidates: readonly AssignmentCandidate[], chosenAccountId?: string): number {
  const eligible = candidates.filter((c) => c.eligible);
  if (eligible.length === 0) return 1;
  const chosen =
    chosenAccountId === undefined
      ? eligible.reduce((best, c) => (c.score > best.score ? c : best), eligible[0])
      : eligible.find((c) => c.account_id === chosenAccountId);
  if (!chosen) return 0.05;
  const others = eligible.filter((c) => c !== chosen);
  if (others.length === 0) return 0.9;
  const margin = chosen.score - Math.max(...others.map((c) => c.score));
  return round(clamp(0.5 + margin / 30, 0.05, 0.99), 2);
}

/** The strongest factors (by share of their maximum) as one Chinese sentence. */
export function summarizeFactors(candidate: AssignmentCandidate, limit = 3): string {
  const top = candidate.factors
    .filter((f) => f.points > 0 && f.max > 0)
    .sort((a, b) => b.points / b.max - a.points / a.max || b.max - a.max)
    .slice(0, limit);
  return top.length > 0 ? top.map((f) => f.reason).join('；') : '各项匹配因素得分均较低';
}

/** Must run inside ctx.db.tx. */
function cancelPendingOutreach(
  ctx: AppContext,
  leadId: string,
  filter: { account_id?: string; except_account_id?: string },
  reason: string,
  actor: string,
): string[] {
  const table = ctx.db.table('outreach');
  const pending = table
    .findMany({ lead_id: leadId, status: [...PENDING_OUTREACH_STATUSES] }, { orderBy: 'created_at ASC' })
    .filter(
      (o) =>
        (filter.account_id === undefined || o.account_id === filter.account_id) &&
        (filter.except_account_id === undefined || o.account_id !== filter.except_account_id),
    );
  for (const o of pending) {
    table.update(o.id, { status: 'CANCELLED', blocked_reason: reason });
    ctx.audit.event({
      actor,
      action: 'outreach.cancelled',
      entity_type: 'outreach',
      entity_id: o.id,
      details: { lead_id: leadId, account_id: o.account_id, previous_status: o.status, reason },
    });
  }
  return pending.map((o) => o.id);
}

/** Must run inside ctx.db.tx. */
function releaseInternal(
  ctx: AppContext,
  assignment: LeadAssignment,
  reason: string,
  actor: string,
  cancel: { reason: string; filter: { account_id?: string; except_account_id?: string } },
): { released: LeadAssignment; outreach_cancelled: string[] } {
  const released = ctx.db
    .table('lead_assignments')
    .update(assignment.id, { active: false, released_at: ctx.clock.iso(), released_reason: reason });
  const cancelled = cancelPendingOutreach(ctx, assignment.lead_id, cancel.filter, cancel.reason, actor);
  ctx.audit.event({
    actor,
    action: 'lead.assignment_released',
    entity_type: 'lead',
    entity_id: assignment.lead_id,
    details: { assignment_id: assignment.id, account_id: assignment.account_id, reason, outreach_cancelled: cancelled },
  });
  return { released, outreach_cancelled: cancelled };
}

/** Release the lead's active assignment (no-op when none) and cancel that account's undelivered outreach. */
export function releaseAssignment(ctx: AppContext, leadId: string, reason: string, actor: string): void {
  if (typeof reason !== 'string' || reason.trim() === '') throw new ValidationError('reason', 'required non-empty string');
  if (typeof actor !== 'string' || actor.trim() === '') throw new ValidationError('actor', 'required non-empty string');
  requireLead(ctx, leadId);
  ctx.db.tx(() => {
    const active = getActiveAssignment(ctx, leadId);
    if (!active) return;
    releaseInternal(ctx, active, reason.trim(), actor.trim(), {
      reason: `负责账号已释放：${reason.trim()}`,
      filter: { account_id: active.account_id },
    });
  });
}

/**
 * Release every lead this account owns (used when an account leaves the fleet). The leads themselves are untouched:
 * they go back to the store's pool, keep their score, stage and history, and can be assigned to any other account.
 * Must run inside ctx.db.tx.
 */
export function releaseAccountLeads(ctx: AppContext, accountId: string, reason: string, actor: string): { leads: string[]; outreach_cancelled: string[] } {
  if (typeof reason !== 'string' || reason.trim() === '') throw new ValidationError('reason', 'required non-empty string');
  const active = ctx.db.table('lead_assignments').findMany({ account_id: accountId, active: true }, { orderBy: 'assigned_at ASC, id ASC' });
  const leads: string[] = [];
  const cancelled: string[] = [];
  for (const assignment of active) {
    const out = releaseInternal(ctx, assignment, reason.trim(), actor.trim(), {
      reason: `负责账号已移除：${reason.trim()}`,
      filter: { account_id: accountId },
    });
    leads.push(out.released.lead_id);
    cancelled.push(...out.outreach_cancelled);
  }
  return { leads, outreach_cancelled: cancelled };
}

/** An account that is no longer part of the fleet (deleted row, or archived for history only). */
function isGoneAccount(ctx: AppContext, accountId: string): boolean {
  const account = ctx.db.table('xhs_accounts').get(accountId);
  return !account || Boolean(account.removed_at);
}

/** Account with the most recent real contact (sent outreach or conversation) with this lead. */
function stickyAccountId(ctx: AppContext, leadId: string): string | null {
  const row = ctx.db.get<{ account_id: string }>(
    `SELECT account_id, MAX(at) AS last_at FROM (
       SELECT account_id, COALESCE(sent_at, updated_at) AS at FROM outreach WHERE lead_id = ? AND status IN ${SENT_STATUSES}
       UNION ALL
       SELECT account_id, last_message_at AS at FROM conversations WHERE lead_id = ?
     ) GROUP BY account_id ORDER BY last_at DESC LIMIT 1`,
    leadId,
    leadId,
  );
  return row?.account_id ?? null;
}

function guardLead(ctx: AppContext, lead: Lead): string | null {
  if (lead.suppressed || isSuppressed(ctx, lead.platform_user_id, lead.platform))
    return '客户已要求勿扰（全局勿扰名单），禁止分配账号与触达';
  if (lead.stage === 'WON') return '线索已成交，无需分配账号';
  if (lead.stage === 'LOST') return '线索已流失，无需分配账号（需运营重新激活后再分配）';
  const inConversation = STAGE_INDEX[lead.stage] >= STAGE_INDEX.CONTACTED;
  // §10.2: an industry / dealer-sales account is never a buyer, so no relationship is ever STARTED with it. As in
  // lead-research, an existing sales conversation is not orphaned (its contact account may still re-own it).
  if (!inConversation && (lead.actor_type === 'DEALER_OR_SALES' || (lead.evidence ?? []).some((e) => e.code === 'industry_account')))
    return INDUSTRY_ACCOUNT_REASON;
  const qualified = getScoringConfig(ctx, lead.dealer_id).thresholds.qualified;
  // Leads already in a sales conversation (CONTACTED or deeper) are qualified by the funnel, not the decaying signal score.
  if (!inConversation && lead.score < qualified)
    return `线索分${lead.score}低于合格阈值${qualified}，暂不分配账号`;
  return null;
}

function decisionInputs(ranking: Ranking, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const { lc } = ranking;
  return {
    lead_id: lc.lead.id,
    lead_score: lc.lead.score,
    lead_tier: lc.lead.tier,
    lead_stage: lc.lead.stage,
    intent: lc.lead.intent,
    intent_class: lc.classification.intent_class,
    intent_cues: lc.classification.cues,
    lead_location: { city: lc.city, province: lc.province, ip_province: lc.ip_province, source: lc.location_source },
    dealer_id: lc.dealer.id,
    dealer_name: lc.dealer.name,
    group_id: lc.lead.group_id,
    fallback_used: ranking.fallback_used,
    factor_max: ASSIGNMENT_FACTOR_MAX,
    ...extra,
  };
}

function keepExisting(ctx: AppContext, owner: LeadAssignment, candidates: AssignmentCandidate[], prefix = ''): AssignLeadResult {
  const name = ctx.db.table('xhs_accounts').get(owner.account_id)?.nickname ?? owner.account_id;
  const current = candidates.find((c) => c.account_id === owner.account_id);
  let reason = `${prefix}线索已由「${name}」负责，保持独占归属不变`;
  if (current && !current.eligible) reason += `；注意：该账号当前不可用（${current.excluded_reason}），建议人工重新分配`;
  return { assignment: owner, candidates, changed: false, reason };
}

function lastAssignmentDecision(ctx: AppContext, leadId: string) {
  const row = ctx.db.get(
    `SELECT * FROM agent_decisions WHERE decision_type = 'account_assignment' AND subject_type = 'lead' AND subject_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    leadId,
  );
  return row ? ctx.db.table('agent_decisions').decode(row) : undefined;
}

function failAssignment(ctx: AppContext, ranking: Ranking, reason: string, actor: string, extra: Record<string, unknown> = {}): AssignLeadResult {
  const lead = ranking.lc.lead;
  const candidates = ranking.evaluated.map((e) => e.candidate);
  // Idempotent: the same failure (identical reason, nothing assigned since) is recorded once, not on every retry.
  const last = lastAssignmentDecision(ctx, lead.id);
  if (last && last.output.assigned === false && last.output.reason === reason) {
    return { assignment: null, candidates, changed: false, reason };
  }
  ctx.db.tx(() => {
    ctx.audit.event({
      actor,
      action: 'lead.assignment_failed',
      entity_type: 'lead',
      entity_id: lead.id,
      details: {
        reason,
        ...extra,
        candidates: candidates.map((c) => ({
          account_id: c.account_id,
          nickname: c.nickname,
          score: c.score,
          eligible: c.eligible,
          excluded_reason: c.excluded_reason ?? null,
        })),
      },
    });
    ctx.audit.decision({
      agent: AGENT,
      skill: SKILL,
      decision_type: 'account_assignment',
      subject_type: 'lead',
      subject_id: lead.id,
      inputs: decisionInputs(ranking, extra),
      evidence: lead.evidence,
      output: { assigned: false, reason, ranking: candidates },
      confidence: 1,
      engine: 'rules',
    });
  });
  return { assignment: null, candidates, changed: false, reason };
}

interface CreatePlan {
  chosen: Evaluated;
  mode: AssignmentMode;
  reason: string;
  confidence: number;
  engine: 'rules' | 'human';
  release_reason?: string;
  extra?: Record<string, unknown>;
}

function createAssignment(ctx: AppContext, ranking: Ranking, plan: CreatePlan, actor: string): AssignLeadResult {
  const lead = ranking.lc.lead;
  const candidates = ranking.evaluated.map((e) => e.candidate);
  const { chosen } = plan;
  try {
    return ctx.db.tx((): AssignLeadResult => {
      const current = getActiveAssignment(ctx, lead.id);
      let outreachCancelled: string[] = [];
      if (current) {
        if (plan.mode !== 'reassign' || current.account_id === chosen.account.id)
          return keepExisting(ctx, current, candidates, plan.mode === 'reassign' ? '无需重新分配：' : '');
        outreachCancelled = releaseInternal(ctx, current, plan.release_reason ?? `重新分配给「${chosen.account.nickname}」`, actor, {
          reason: REASSIGN_CANCEL_REASON,
          filter: { except_account_id: chosen.account.id },
        }).outreach_cancelled;
      }
      // Undelivered outreach of any other account (e.g. left behind by an earlier owner) must never be sent, and a live
      // first touch would block the new owner's own first touch (uq_live_first_touch).
      outreachCancelled = [
        ...outreachCancelled,
        ...cancelPendingOutreach(
          ctx,
          lead.id,
          { except_account_id: chosen.account.id },
          plan.mode === 'reassign' ? REASSIGN_CANCEL_REASON : ORPHAN_OUTREACH_CANCEL_REASON,
          actor,
        ),
      ];
      const row = ctx.db.table('lead_assignments').insert({
        id: newId('asg'),
        lead_id: lead.id,
        account_id: chosen.account.id,
        active: true,
        reason: plan.reason,
        candidates,
        assigned_by: actor,
        assigned_at: ctx.clock.iso(),
        released_at: null,
        released_reason: null,
      });
      const transition = transitionLead(ctx, lead.id, 'ASSIGNED', { reason: `分配给账号「${chosen.account.nickname}」`, actor });
      const crossDealer = chosen.account.dealer_id !== lead.dealer_id;
      ctx.audit.event({
        actor,
        action: 'lead.assigned',
        entity_type: 'lead',
        entity_id: lead.id,
        details: {
          assignment_id: row.id,
          account_id: chosen.account.id,
          nickname: chosen.account.nickname,
          account_dealer_id: chosen.account.dealer_id,
          score: chosen.candidate.score,
          mode: plan.mode,
          assigned_by: actor,
          reason: plan.reason,
          previous_assignment_id: current?.id ?? null,
          previous_account_id: current?.account_id ?? null,
          outreach_cancelled: outreachCancelled,
          cross_dealer: crossDealer,
          stage_changed: transition.changed,
        },
      });
      const eligible = candidates.filter((c) => c.eligible && c.account_id !== chosen.account.id);
      ctx.audit.decision({
        agent: AGENT,
        skill: SKILL,
        decision_type: 'account_assignment',
        subject_type: 'lead',
        subject_id: lead.id,
        inputs: decisionInputs(ranking, { mode: plan.mode, actor, ...plan.extra }),
        evidence: lead.evidence,
        output: {
          assigned: true,
          assignment_id: row.id,
          account_id: chosen.account.id,
          nickname: chosen.account.nickname,
          score: chosen.candidate.score,
          reason: plan.reason,
          margin_to_next: eligible.length > 0 ? round(chosen.candidate.score - eligible[0].score, 1) : null,
          previous_account_id: current?.account_id ?? null,
          outreach_cancelled: outreachCancelled,
          cross_dealer: crossDealer,
          ranking: candidates,
        },
        confidence: plan.confidence,
        engine: plan.engine,
      });
      return { assignment: row, candidates, changed: true, reason: plan.reason };
    });
  } catch (err) {
    // A concurrent writer won the exclusive-ownership race (uq_active_assignment): report its owner instead.
    if (isActiveAssignmentConflict(err)) {
      const owner = getActiveAssignment(ctx, lead.id);
      if (owner) return keepExisting(ctx, owner, candidates, '并发分配已由其他流程完成：');
    }
    throw err;
  }
}

function addCandidate(ctx: AppContext, ranking: Ranking, account: XhsAccount): Evaluated {
  const existing = ranking.evaluated.find((e) => e.account.id === account.id);
  if (existing) return existing;
  const evaluated = evaluateAccount(ctx, ranking.lc, account, ranking.evaluated.length, account.dealer_id !== ranking.lc.lead.dealer_id);
  ranking.evaluated = sortEvaluated([...ranking.evaluated, evaluated]);
  return evaluated;
}

function fallbackNote(ranking: Ranking, chosen: Evaluated): string {
  return chosen.account.dealer_id !== ranking.lc.lead.dealer_id && ranking.fallback_used
    ? `线索所属门店「${ranking.lc.dealer.name}」暂无可用账号，由集团内其他门店账号兜底；`
    : '';
}

/**
 * Exclusive, explainable owner selection. Guards (suppressed, WON/LOST, below the qualified threshold) return
 * `assignment: null`; an active owner is kept; an account that already contacted the user is the forced owner;
 * otherwise the best eligible account wins. `reassign_to` (operator action) releases the current owner and
 * cancels its undelivered outreach in the same transaction.
 */
export function assignLead(ctx: AppContext, leadId: string, opts: AssignLeadOptions = {}): AssignLeadResult {
  const lead = requireLead(ctx, leadId);
  const actor = opts.actor?.trim() || DEFAULT_ASSIGNER;
  const operatorReason = opts.reason?.trim() || undefined;
  const guard = guardLead(ctx, lead);
  if (guard) return { assignment: null, candidates: [], changed: false, reason: guard };

  const ranking = rankInternal(ctx, lead);

  if (opts.reassign_to !== undefined) {
    const target = ctx.db.table('xhs_accounts').get(opts.reassign_to);
    if (!target) throw new NotFoundError('xhs_account', opts.reassign_to);
    if (target.group_id !== lead.group_id)
      throw new PolicyError('account_not_in_group', `账号「${target.nickname}」不属于该线索所属经销商集团，不能重新分配`, {
        lead_id: lead.id,
        account_id: target.id,
      });
    const chosen = addCandidate(ctx, ranking, target);
    if (!chosen.candidate.eligible)
      throw new PolicyError('account_ineligible', `不能重新分配给「${target.nickname}」：${chosen.candidate.excluded_reason}`, {
        lead_id: lead.id,
        account_id: target.id,
        excluded_reason: chosen.candidate.excluded_reason ?? null,
      });
    const human = actor.startsWith('operator:');
    return createAssignment(
      ctx,
      ranking,
      {
        chosen,
        mode: 'reassign',
        reason: `${human ? '人工重新分配' : '按指令重新分配'}给「${target.nickname}」（${chosen.candidate.score}分）${operatorReason ? `：${operatorReason}` : ''}；${summarizeFactors(chosen.candidate)}`,
        confidence: human ? 1 : assignmentConfidence(ranking.evaluated.map((e) => e.candidate), target.id),
        engine: human ? 'human' : 'rules',
        release_reason: operatorReason ?? `重新分配给「${target.nickname}」`,
        extra: { reassign_to: target.id, operator_reason: operatorReason ?? null },
      },
      actor,
    );
  }

  const existing = getActiveAssignment(ctx, lead.id);
  if (existing && !isGoneAccount(ctx, existing.account_id)) return keepExisting(ctx, existing, ranking.evaluated.map((e) => e.candidate));
  if (existing) {
    // The owning account left the fleet (deleted or archived): the lead is the store's, so it is freed and re-ranked.
    ctx.db.tx(() => {
      releaseInternal(ctx, existing, GONE_ACCOUNT_REASON, actor, { reason: `负责账号已移除：${GONE_ACCOUNT_REASON}`, filter: { account_id: existing.account_id } });
    });
  }

  const stickyId = stickyAccountId(ctx, lead.id);
  // An account that left the fleet cannot keep the lead: the lead goes to another account, and the decision says so.
  const stickyGone = stickyId !== null && isGoneAccount(ctx, stickyId);
  if (stickyId && !stickyGone) {
    const account = ctx.db.table('xhs_accounts').get(stickyId);
    const sticky = account ? addCandidate(ctx, ranking, account) : null;
    if (!sticky || !sticky.candidate.eligible) {
      const detail = sticky ? `（「${sticky.candidate.nickname}」${sticky.candidate.excluded_reason ?? '不可用'}）` : '（账号已不存在）';
      return failAssignment(ctx, ranking, `${STICKY_UNAVAILABLE_REASON}${detail}`, actor, { sticky_account_id: stickyId });
    }
    return createAssignment(
      ctx,
      ranking,
      {
        chosen: sticky,
        mode: 'sticky',
        reason: `${fallbackNote(ranking, sticky)}「${sticky.account.nickname}」已与该客户建立联系（已发送私信或已有对话），由同一账号继续跟进，避免多账号重复触达（${sticky.candidate.score}分）；${summarizeFactors(sticky.candidate)}`,
        confidence: 0.95,
        engine: 'rules',
        extra: { sticky_account_id: stickyId },
      },
      actor,
    );
  }

  const eligible = ranking.evaluated.filter((e) => e.candidate.eligible);
  if (eligible.length === 0) {
    const reasons = [...new Set(ranking.evaluated.map((e) => e.candidate.excluded_reason).filter((r): r is string => Boolean(r)))];
    return failAssignment(
      ctx,
      ranking,
      ranking.evaluated.length === 0
        ? '没有可分配的账号：该门店及集团内均未配置小红书账号'
        : `没有可用的账号：${reasons.join('；')}，需人工处理`,
      actor,
    );
  }
  const [chosen, runnerUp] = eligible;
  const handover = existing || stickyGone ? '原负责账号已从账号矩阵移除，线索回到门店线索池后重新分配：' : '';
  const lead_margin = runnerUp
    ? `，领先第二名「${runnerUp.account.nickname}」（${runnerUp.candidate.score}分）${round(chosen.candidate.score - runnerUp.candidate.score, 1)}分`
    : '，为唯一可用账号';
  return createAssignment(
    ctx,
    ranking,
    {
      chosen,
      mode: 'ranked',
      reason: `${handover}${fallbackNote(ranking, chosen)}选择「${chosen.account.nickname}」（${chosen.candidate.score}分）${lead_margin}：${summarizeFactors(chosen.candidate)}`,
      confidence: assignmentConfidence(ranking.evaluated.map((e) => e.candidate), chosen.account.id),
      engine: 'rules',
    },
    actor,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill definition
// ─────────────────────────────────────────────────────────────────────────────

export interface AccountAssignmentInput {
  lead_id: string;
  reassign_to?: string;
  actor?: string;
  reason?: string;
}

export const skill = defineSkill<AccountAssignmentInput, AssignLeadResult>({
  name: 'account-assignment',
  category: 'acquisition',
  agent: 'fleet-controller',
  description:
    '车队调度：综合地域、主攻车型、人设匹配、历史回复率与成交率、当前线索负载和账号健康度，为合格线索选出唯一负责账号并记录可解释的排名；已联系过客户的账号保持归属，支持运营人工重新分配。',
  input: v.object({
    lead_id: v.string({ min: 1 }),
    reassign_to: v.optional(v.string({ min: 1 })),
    actor: v.optional(v.string({ min: 1 })),
    reason: v.optional(v.string({ min: 1 })),
  }),
  run(ctx, input) {
    return assignLead(ctx, input.lead_id, { reassign_to: input.reassign_to, actor: input.actor, reason: input.reason });
  },
  validateOutput(output) {
    if (typeof output.reason !== 'string' || output.reason.trim() === '') throw new Error('account-assignment: reason is required');
    if (output.assignment && !output.assignment.active) throw new Error('account-assignment: returned assignment must be active');
    if (output.changed) {
      const owner = output.assignment ? output.candidates.find((c) => c.account_id === output.assignment?.account_id) : undefined;
      if (!owner || !owner.eligible) throw new Error('account-assignment: a new owner must be an eligible ranked candidate');
    }
    for (const c of output.candidates) {
      const sum = round(c.factors.reduce((s, f) => s + f.points, 0), 1);
      if (Math.abs(sum - c.score) > 0.05 || c.score < 0 || c.score > 100)
        throw new Error(`account-assignment: candidate ${c.account_id} score ${c.score} does not equal its factors (${sum})`);
    }
  },
});
