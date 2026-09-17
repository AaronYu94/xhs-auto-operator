import type { AppContext } from '../../../app/context.ts';
import { NotFoundError, ValidationError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import { clamp, normalizeText, round } from '../../../core/text.ts';
import { DEFAULT_TZ, daysBetween } from '../../../core/time.ts';
import {
  PURCHASE_STAGES,
  SIGNAL_SOURCE_TYPES,
  TRANSACTION_QUESTIONS,
  type AuthorRole,
  type AutomotiveIntent,
  type DealerProfile,
  type Evidence,
  type IntentDetection,
  type Lead,
  type LeadScore,
  type LeadSignal,
  type PurchaseStage,
  type ScoreComponent,
  type ScoreTier,
  type ScoringConfig,
  type ScoringThresholds,
  type ScoringWeights,
  type SignalContext,
  type TransactionQuestion,
} from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import { provinceOfIp } from '../../../domain/automotive-lexicon.ts';
import { buildDealerProfile } from '../../../domain/dealer-profile.ts';
import { listDealers } from '../../operations/dealer-brain/index.ts';
import { defineSkill } from '../../registry.ts';
import { detectIntentRules, isNonBuyerRole } from '../intent-detection/nlu.ts';

/**
 * Lead Scoring (spec §9, ARCHITECTURE §5): configurable, evidence-based scoring of purchase-intent
 * signals and aggregate lead scores. Every point awarded carries a Chinese explanation so a
 * salesperson can see WHY a lead is hot.
 */

const AGENT = 'lead-scoring-agent';
const SKILL = 'lead-scoring';

// ─────────────────────────────────────────────────────────────────────────────
// Calibration constants (ARCHITECTURE §5 — binding)
// ─────────────────────────────────────────────────────────────────────────────

export const SCORING_FACTORS = [
  'explicit_purchase_intent',
  'transaction_questions',
  'model_match',
  'inventory_match',
  'location_match',
  'purchase_stage',
  'recency',
  'authenticity',
  'dealer_relevance',
] as const satisfies readonly (keyof ScoringWeights)[];
export type ScoringFactor = (typeof SCORING_FACTORS)[number];

export const THRESHOLD_KEYS = ['candidate', 'qualified', 'high_intent', 'immediate'] as const satisfies readonly (keyof ScoringThresholds)[];

/** Adjustment component emitted for an explicitly out-of-area buyer (ARCHITECTURE §5.2). */
export const OUT_OF_AREA_FACTOR = 'out_of_area_cap';

export const DEFAULT_WEIGHTS: ScoringWeights = Object.freeze({
  explicit_purchase_intent: 25,
  transaction_questions: 15,
  model_match: 12,
  inventory_match: 10,
  location_match: 10,
  purchase_stage: 12,
  recency: 6,
  authenticity: 5,
  dealer_relevance: 5,
});

export const DEFAULT_THRESHOLDS: ScoringThresholds = Object.freeze({
  candidate: 20,
  qualified: 60,
  high_intent: 80,
  immediate: 92,
});

/** Detection strength anchors per purchase stage (used when a stored signal carries no explicit strength). */
export const STRENGTH_ANCHORS: Readonly<Record<PurchaseStage, number>> = Object.freeze({
  awareness: 0.1,
  research: 0.2,
  comparison: 0.4,
  price_shopping: 0.88,
  active_shopping: 1,
  dealer_selection: 1,
  purchase_imminent: 1,
});

/** purchase_stage rule points on the default 12-point scale. */
const STAGE_POINTS: Readonly<Record<PurchaseStage, number>> = {
  awareness: 0,
  research: 3,
  comparison: 5,
  price_shopping: 8,
  active_shopping: 10,
  dealer_selection: 11,
  purchase_imminent: 12,
};

const STAGE_LABELS: Readonly<Record<PurchaseStage, string>> = {
  awareness: '认知了解',
  research: '调研了解',
  comparison: '对比选车',
  price_shopping: '询价比价',
  active_shopping: '积极选购',
  dealer_selection: '选择门店',
  purchase_imminent: '即将购买',
};

const TQ_LABELS: Readonly<Record<TransactionQuestion, string>> = {
  price: '询问价格',
  landing_price: '询问落地价',
  discount: '询问优惠',
  inventory: '询问现车/库存',
  color_trim_availability: '询问指定颜色/配置',
  finance: '询问贷款/分期',
  lease: '询问租赁',
  trade_in: '询问置换',
  dealer_location: '询问门店/购买地点',
  test_drive: '想到店看车/试驾',
};

/** Recency buckets: [max age in days, rule points on the default 6-point scale]. */
const RECENCY_BUCKETS: readonly (readonly [number, number, string])[] = [
  [3, 6, '≤3 天'],
  [7, 5, '≤7 天'],
  [14, 4, '≤14 天'],
  [30, 3, '≤30 天'],
  [90, 1, '≤90 天'],
];

/** Authenticity calibration scale: default 4 · verified real local user 5 · marketing/industry account 0. */
export const AUTHENTICITY_SCALE = 5;
export const AUTHENTICITY_DEFAULT = 4;

/** Evidence-code conventions used to reconstruct an IntentDetection from a stored lead_signals row. */
export const TQ_EVIDENCE_PREFIX = 'tq:';
export const STRENGTH_EVIDENCE_PREFIX = 'strength:';
const NEGATIVE_CODES = new Set(['negative', 'not_interested', 'negative_feedback']);
const NON_PURCHASE_CODES = new Set([
  'non_purchase',
  'non_purchase_signal',
  'not_purchase_signal',
  'prefilter_failed',
  'pure_praise',
  'emoji_only',
  'empty_or_emoji',
  'too_short',
  'no_signal',
  'marketing_account',
  'content_creator',
  'already_purchased',
]);
/** Author roles recoverable from evidence codes written by intent detection (ARCHITECTURE §5.1). */
const ROLE_BY_CODE: ReadonlyMap<string, AuthorRole> = new Map<string, AuthorRole>([
  ['marketing_account', 'marketing'],
  ['already_purchased', 'owner'],
  ['content_creator', 'creator'],
]);
const INDUSTRY_CODES = new Set(['industry_account', 'marketing_account']);
const VERIFIED_LOCAL_CODE = 'verified_local_user';

const TQ_SET: ReadonlySet<string> = new Set(TRANSACTION_QUESTIONS);
const STAGE_SET: ReadonlySet<string> = new Set(PURCHASE_STAGES);

// ─────────────────────────────────────────────────────────────────────────────
// Tiers
// ─────────────────────────────────────────────────────────────────────────────

export function tierFor(score: number, t: ScoringThresholds): ScoreTier {
  if (!Number.isFinite(score)) return 'none';
  if (score >= t.immediate) return 'immediate';
  if (score >= t.high_intent) return 'high_intent';
  if (score >= t.qualified) return 'qualified';
  if (score >= t.candidate) return 'candidate';
  return 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching helpers (case-insensitive, alias- and colour-tolerant)
// ─────────────────────────────────────────────────────────────────────────────

const compact = (s: string): string => normalizeText(s).replace(/[\s\-_·./]/g, '');

/** '3 Series' and '3系' compare equal; 'I3' and 'i3' compare equal. */
const modelKey = (s: string): string => compact(s).replace(/系列?/g, 'series');

const placeKey = (s: string): string =>
  compact(s).replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市)$/u, '');

const samePlace = (a: string | undefined, b: string | undefined): boolean =>
  !!a && !!b && placeKey(a) !== '' && placeKey(a) === placeKey(b);

/**
 * Brand alias groups (compacted canonical Latin name + Chinese names). Matching is symmetric, so a dealer
 * whose `brands` column holds '宝马' matches a detection saying 'BMW' and vice versa.
 */
const BRAND_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['bmw', '宝马'],
  ['mercedesbenz', 'mercedes', 'benz', '奔驰', '梅赛德斯奔驰'],
  ['audi', '奥迪'],
  ['tesla', '特斯拉'],
  ['byd', '比亚迪'],
  ['xiaomi', '小米'],
  ['nio', '蔚来'],
  ['volvo', '沃尔沃'],
  ['lexus', '雷克萨斯'],
];

function brandKeys(brand: string): string[] {
  const k = compact(brand);
  if (!k) return [];
  const group = BRAND_ALIAS_GROUPS.find((g) => g.includes(k));
  return group ? [...group] : [k];
}

function brandCarried(profile: DealerProfile, brand: string | undefined): string | null {
  if (!brand) return null;
  const k = compact(brand);
  for (const b of profile.brands) if (brandKeys(b).includes(k)) return b;
  return null;
}

function carriedModels(profile: DealerProfile): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (m: string) => {
    const k = modelKey(m);
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(m);
    }
  };
  profile.models.forEach(add);
  profile.trims.forEach((t) => add(t.model));
  profile.inventory.forEach((i) => add(i.model));
  return out;
}

/** Returns the dealer's canonical model name when `model` (optionally brand-prefixed) is carried. */
function carriedModel(profile: DealerProfile, model: string | undefined): string | null {
  if (!model) return null;
  const key = modelKey(model);
  if (!key) return null;
  const prefixes = profile.brands.flatMap(brandKeys).filter((p) => p.length > 0);
  for (const m of carriedModels(profile)) {
    const mk = modelKey(m);
    if (mk === key) return m;
    for (const p of prefixes) if (key.startsWith(p) && key.slice(p.length) === mk) return m;
  }
  return null;
}

const COLOR_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  白: ['白', 'white'],
  黑: ['黑', 'black'],
  灰: ['灰', 'grey', 'gray'],
  蓝: ['蓝', 'blue'],
  红: ['红', 'red'],
  棕: ['棕', '咖', '摩卡', 'brown', 'mocha'],
  银: ['银', 'silver'],
  绿: ['绿', 'green'],
  黄: ['黄', 'yellow'],
  橙: ['橙', 'orange'],
  紫: ['紫', 'purple'],
  米: ['米', '象牙', 'beige', 'ivory'],
};

const cleanColor = (s: string): string => compact(s).replace(/[色的款]/gu, '');

function colorFamilies(s: string): Set<string> {
  const out = new Set<string>();
  for (const [family, words] of Object.entries(COLOR_FAMILIES)) if (words.some((w) => s.includes(w))) out.add(family);
  return out;
}

/** Tolerant colour comparison: '白色' ≈ '白' ≈ '珍珠白' ≈ 'white'. */
export function colorMatches(wanted: string | undefined, actual: string): boolean {
  if (!wanted) return true;
  const w = cleanColor(wanted);
  if (!w) return true;
  const a = cleanColor(actual);
  if (!a) return false;
  if (w === a || a.includes(w) || w.includes(a)) return true;
  const wf = colorFamilies(w);
  if (wf.size === 0) return false;
  const af = colorFamilies(a);
  for (const f of wf) if (af.has(f)) return true;
  return false;
}

export interface ColorSpec {
  exterior?: string;
  interior?: string;
}

const EXT_MARK = '(?:外观|外饰|车身|外)';
const INT_MARK = '(?:内饰|内)';
const COLOR_SEP = '[,，、+和配;；]?';
/** A colour word never contains the exterior/interior markers or separators (NFKC maps '，' → ','). */
const COLOR_WORD = '([^外内饰观身,，、+;；/|]+?)';

/** Ordered colour-request patterns: [regex, index of exterior group (0 = none), index of interior group (0 = none)]. */
const COLOR_PATTERNS: readonly (readonly [RegExp, number, number])[] = [
  // 白外红内 · 白色外观红色内饰 · 白车身红内饰
  [new RegExp(`^${COLOR_WORD}色?${EXT_MARK}${COLOR_SEP}${COLOR_WORD}色?${INT_MARK}$`, 'u'), 1, 2],
  // 外白内红 · 外观白色内饰红色 · 车身白色内饰红色
  [new RegExp(`^${EXT_MARK}${COLOR_WORD}色?${COLOR_SEP}${INT_MARK}${COLOR_WORD}色?$`, 'u'), 1, 2],
  // 白色外观内饰红色
  [new RegExp(`^${COLOR_WORD}色?${EXT_MARK}${COLOR_SEP}${INT_MARK}${COLOR_WORD}色?$`, 'u'), 1, 2],
  // 外观白色，红色内饰
  [new RegExp(`^${EXT_MARK}${COLOR_WORD}色?${COLOR_SEP}${COLOR_WORD}色?${INT_MARK}$`, 'u'), 1, 2],
  // 白车红内饰
  [new RegExp(`^${COLOR_WORD}色?车${COLOR_SEP}${COLOR_WORD}色?${INT_MARK}$`, 'u'), 1, 2],
  // 白/红
  [/^([^/+|]+)[/+|]([^/+|]+)$/u, 1, 2],
  // 红色内饰 · 内饰红色
  [new RegExp(`^${COLOR_WORD}色?${INT_MARK}$`, 'u'), 0, 1],
  [new RegExp(`^${INT_MARK}${COLOR_WORD}色?$`, 'u'), 0, 1],
  // 白色外观 · 外观白色 · 白色车身
  [new RegExp(`^${COLOR_WORD}色?${EXT_MARK}$`, 'u'), 1, 0],
  [new RegExp(`^${EXT_MARK}${COLOR_WORD}色?$`, 'u'), 1, 0],
];

/**
 * Parses a colour request into exterior / interior parts:
 * '白外红内' → {exterior 白, interior 红} · '外白内红' / '白色外观红色内饰' / '外观白色内饰红色' / '白车红内饰' /
 * '白/红' → same · '红色内饰' / '内饰红色' → {interior 红} · '白色' / '外观白色' → {exterior 白}.
 */
export function parseColorIntent(text: string | undefined | null): ColorSpec {
  if (!text) return {};
  const t = normalizeText(text).replace(/\s+/g, '');
  if (!t) return {};
  const pick = (ext?: string, int?: string): ColorSpec => {
    const out: ColorSpec = {};
    const e = ext ? cleanColor(ext) : '';
    const i = int ? cleanColor(int) : '';
    if (e) out.exterior = e;
    if (i) out.interior = i;
    return out;
  };
  for (const [re, extGroup, intGroup] of COLOR_PATTERNS) {
    const m = re.exec(t);
    if (!m) continue;
    const spec = pick(extGroup ? m[extGroup] : undefined, intGroup ? m[intGroup] : undefined);
    if (spec.exterior || spec.interior) return spec;
  }
  return pick(t);
}

function stripModelPrefix(key: string, model: string): string {
  const mk = modelKey(model);
  return mk && key.startsWith(mk) && key.length > mk.length ? key.slice(mk.length) : key;
}

/** Resolve a user trim mention ('35L', 'i3 35L', 'edrive35l') to the dealer's canonical trim for `model`. */
function resolveTrim(profile: DealerProfile, model: string, trim: string): string | null {
  const key = stripModelPrefix(compact(trim), model);
  if (!key) return null;
  const candidates: { trim: string; aliases: string[] }[] = [];
  const seen = new Set<string>();
  for (const t of profile.trims) {
    if (modelKey(t.model) !== modelKey(model) || seen.has(compact(t.trim))) continue;
    seen.add(compact(t.trim));
    candidates.push({ trim: t.trim, aliases: t.aliases });
  }
  for (const i of profile.inventory) {
    if (modelKey(i.model) !== modelKey(model) || seen.has(compact(i.trim))) continue;
    seen.add(compact(i.trim));
    candidates.push({ trim: i.trim, aliases: [] });
  }
  for (const c of candidates) {
    const names = [c.trim, ...c.aliases].map((n) => stripModelPrefix(compact(n), model));
    if (names.includes(key)) return c.trim;
  }
  if (key.length >= 3) {
    for (const c of candidates) {
      const ct = compact(c.trim);
      if (ct.endsWith(key) || key.endsWith(ct)) return c.trim;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service area (ARCHITECTURE §5.2)
// ─────────────────────────────────────────────────────────────────────────────

export interface StatedArea {
  /** in_area: stated city/province inside the dealer's province · out_of_area: outside · unstated: nothing explicit */
  match: 'in_area' | 'out_of_area' | 'unstated';
  /** the stated place as the user wrote it (normalized city or province name) */
  place?: string;
}

/**
 * Compares an EXPLICITLY stated location (city or province not listed in `inferred_fields`) with the dealer's
 * province. IP 属地 is inferred, never "stated". An unknown place or a dealer without a province is `unstated`.
 */
export function statedAreaMatch(intent: AutomotiveIntent, dealer: DealerProfile): StatedArea {
  const inferred = new Set(intent.inferred_fields ?? []);
  const city = intent.location && !inferred.has('location') ? intent.location : undefined;
  const province = intent.province && !inferred.has('province') ? intent.province : undefined;
  if (!city && !province) return { match: 'unstated' };
  const place = city ?? province!;
  if (city && samePlace(city, dealer.city)) return { match: 'in_area', place };
  const statedProvince = (city ? provinceOfIp(city) : null) ?? province ?? null;
  if (!statedProvince || !dealer.province?.trim()) return { match: 'unstated', place };
  return { match: samePlace(statedProvince, dealer.province) ? 'in_area' : 'out_of_area', place };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure signal scoring
// ─────────────────────────────────────────────────────────────────────────────

export interface SignalScoreInput {
  detection: IntentDetection;
  signal_at: string;
  now: string;
  dealer: DealerProfile;
  /** score on the 0..5 calibration scale (default 4 · verified local 5 · industry 0) */
  authenticity?: { score: number; reasons: string[] };
}

type Maxima = Record<ScoringFactor, number>;

const EPSILON = 1e-9;

/**
 * Integer factor maxima derived from the configured weights.
 * - Integer weights summing to ≤ 100 are used as-is (the default calibration is untouched).
 * - Otherwise (sum > 100, or fractional weights) each factor gets its proportional share of
 *   `min(100, floor(sum))` points, apportioned to integers with the largest-remainder method (ties by factor
 *   order). Integer maxima guarantee that every factor's points stay ≤ its max and that the factor points
 *   always add up to a total ≤ 100, so the components shown to salespeople sum exactly to the score.
 */
export function effectiveMaxima(weights: ScoringWeights): Maxima {
  const raw = {} as Maxima;
  let sum = 0;
  for (const f of SCORING_FACTORS) {
    const w = Number(weights[f]);
    raw[f] = Number.isFinite(w) && w > 0 ? w : 0;
    sum += raw[f];
  }
  const out = {} as Maxima;
  if (sum <= 0 || (sum <= 100 && SCORING_FACTORS.every((f) => Number.isInteger(raw[f])))) {
    for (const f of SCORING_FACTORS) out[f] = raw[f];
    return out;
  }
  const total = sum > 100 ? 100 : Math.floor(sum + EPSILON);
  const shares = SCORING_FACTORS.map((factor, index) => {
    const exact = (raw[factor] * total) / sum;
    const base = Math.floor(exact + EPSILON);
    return { factor, index, base, remainder: exact - base };
  });
  let left = total - shares.reduce((acc, s) => acc + s.base, 0);
  const byRemainder = [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const s of byRemainder) {
    if (left <= 0) break;
    if (raw[s.factor] <= 0) continue;
    s.base += 1;
    left -= 1;
  }
  for (const s of shares) out[s.factor] = s.base;
  return out;
}

/** Rule points defined on the default scale, rescaled to the configured maximum. */
function scaled(rulePoints: number, defaultMax: number, max: number): number {
  return Math.round((rulePoints * max) / defaultMax);
}

function component(factor: ScoringFactor, points: number, max: number, reason: string): ScoreComponent {
  return { factor, points: clamp(points, 0, max), max, reason };
}

function distinctQuestions(questions: readonly string[]): TransactionQuestion[] {
  const out: TransactionQuestion[] = [];
  for (const q of questions) if (TQ_SET.has(q) && !out.includes(q as TransactionQuestion)) out.push(q as TransactionQuestion);
  return out;
}

function explicitIntentComponent(det: IntentDetection, max: number): ScoreComponent {
  const strength = Number.isFinite(det.strength) ? clamp(det.strength, 0, 1) : 0;
  const stage = det.intent.purchase_stage;
  const label = stage && STAGE_SET.has(stage) ? `（${STAGE_LABELS[stage]}）` : '';
  return component(
    'explicit_purchase_intent',
    Math.round(strength * max),
    max,
    strength > 0 ? `购买意向强度 ${round(strength, 2)}${label}` : '未表达明确购买意向',
  );
}

function transactionComponent(det: IntentDetection, max: number): ScoreComponent {
  const qs = distinctQuestions(det.transaction_questions ?? []);
  const rule = qs.length === 0 ? 0 : qs.length === 1 ? 12 : 15;
  const reason =
    qs.length === 0 ? '未提出交易类问题' : `提出 ${qs.length} 个交易类问题：${qs.map((q) => TQ_LABELS[q]).join('、')}`;
  return component('transaction_questions', scaled(rule, 15, max), max, reason);
}

function comparedCarriedModel(det: IntentDetection, profile: DealerProfile): string | null {
  for (const m of det.intent.competing_models ?? []) {
    const hit = carriedModel(profile, m);
    if (hit) return hit;
  }
  return null;
}

function modelComponent(det: IntentDetection, profile: DealerProfile, max: number): ScoreComponent {
  const intent = det.intent;
  const inferred = new Set(intent.inferred_fields ?? []);
  const carried = carriedModel(profile, intent.model);
  if (carried && !inferred.has('model'))
    return component('model_match', scaled(12, 12, max), max, `明确提到门店在售车型 ${carried}`);
  if (carried)
    return component('model_match', scaled(8, 12, max), max, `结合帖子上下文推断车型为 ${carried}（门店在售）`);
  const compared = comparedCarriedModel(det, profile);
  if (compared)
    return component(
      'model_match',
      scaled(6, 12, max),
      max,
      `对比讨论中涉及门店在售车型 ${compared}${intent.model ? `（与 ${intent.model} 对比）` : ''}`,
    );
  const brand = brandCarried(profile, intent.brand);
  if (brand)
    return component(
      'model_match',
      scaled(4, 12, max),
      max,
      intent.model ? `仅品牌匹配（${brand}），车型 ${intent.model} 非门店在售` : `仅品牌匹配（${brand}），未指明车型`,
    );
  return component(
    'model_match',
    0,
    max,
    intent.model ? `车型 ${intent.model} 非门店在售` : '未识别到门店相关车型或品牌',
  );
}

function inventoryComponent(det: IntentDetection, profile: DealerProfile, max: number): ScoreComponent {
  const intent = det.intent;
  const qs = new Set(distinctQuestions(det.transaction_questions ?? []));
  const asked = intent.inventory_intent === true || qs.has('inventory') || qs.has('color_trim_availability');
  const model = carriedModel(profile, intent.model);
  if (!model) {
    if (asked)
      return component(
        'inventory_match',
        scaled(2, 10, max),
        max,
        intent.model ? `询问现车，但门店不经营 ${intent.model}` : '询问现车，但未指明车型，暂无法匹配库存',
      );
    return component('inventory_match', 0, max, '未涉及库存，且未识别到门店在售车型');
  }

  const inferred = new Set(intent.inferred_fields ?? []);
  const trimStated = !!intent.trim && !inferred.has('trim');
  const colourStated = !!intent.color_intent?.trim() && !inferred.has('color_intent');
  const resolvedTrim = intent.trim ? resolveTrim(profile, model, intent.trim) : null;
  const colour = parseColorIntent(intent.color_intent);
  const rows = profile.inventory.filter(
    (r) => modelKey(r.model) === modelKey(model) && r.quantity > 0 && (r.status === 'in_stock' || r.status === 'in_transit'),
  );
  const trimOk = (trim: string) =>
    !intent.trim ? true : resolvedTrim ? compact(trim) === compact(resolvedTrim) : false;
  const specOk = (r: (typeof rows)[number]) =>
    trimOk(r.trim) && colorMatches(colour.exterior, r.exterior_color) && colorMatches(colour.interior, r.interior_color);

  const exactStock = rows.filter((r) => r.status === 'in_stock' && specOk(r));
  const exactTransit = rows.filter((r) => r.status === 'in_transit' && specOk(r));
  const modelStock = rows.filter((r) => r.status === 'in_stock');

  const trimLabel = resolvedTrim ?? intent.trim;
  const colourLabel = intent.color_intent?.trim();
  const desc = colourLabel ? `${colourLabel} ${trimLabel ?? model}` : trimLabel ? `${model} ${trimLabel}` : model;

  if (asked && exactStock.length > 0)
    return component('inventory_match', scaled(10, 10, max), max, `询问现车且店内有${desc} 现车`);
  if (asked && exactTransit.length > 0)
    return component('inventory_match', scaled(7, 10, max), max, `询问现车，${desc} 目前在途（暂无现车）`);
  if (!asked && trimStated && exactStock.length > 0)
    return component('inventory_match', scaled(7, 10, max), max, `指定配置 ${model} ${trimLabel}，店内有现车`);
  // "model in stock → 4" is the fallback for an inventory-relevant request (stock question, stated trim or
  // colour) whose exact spec is not available. A bare model mention without any inventory context earns 0:
  // this is what reproduces the §5 reference values ≈30 / ≈65 / ≈69 exactly.
  const inventoryContext = asked || trimStated || colourStated;
  if (inventoryContext && modelStock.length > 0)
    return component(
      'inventory_match',
      scaled(4, 10, max),
      max,
      asked ? `询问现车，${desc} 暂无匹配现车，但店内有 ${model} 其他现车` : `指定 ${desc}，暂无完全匹配现车，但店内有 ${model} 现车`,
    );
  if (asked) return component('inventory_match', scaled(2, 10, max), max, `询问现车，但店内暂无${desc} 库存`);
  if (modelStock.length > 0) return component('inventory_match', 0, max, `未询问库存或指定配置/颜色（店内有 ${model} 现车）`);
  return component('inventory_match', 0, max, `未涉及库存，店内暂无 ${model} 现车`);
}

function locationComponent(det: IntentDetection, profile: DealerProfile, max: number): ScoreComponent {
  const intent = det.intent;
  const inferred = new Set(intent.inferred_fields ?? []);
  const cityStated = !!intent.location && !inferred.has('location');
  const provinceStated = !!intent.province && !inferred.has('province');
  const provinceFromIp = !!intent.province && inferred.has('province');
  if (cityStated && samePlace(intent.location, profile.city))
    return component('location_match', scaled(10, 10, max), max, `用户所在城市（${intent.location}）与门店城市一致`);
  if (provinceStated && samePlace(intent.province, profile.province))
    return component(
      'location_match',
      scaled(6, 10, max),
      max,
      `用户提及${cityStated ? `城市（${intent.location}）所在` : ''}省份（${intent.province}）与门店所在省份一致`,
    );
  if (provinceFromIp && samePlace(intent.province, profile.province))
    return component('location_match', scaled(5, 10, max), max, `IP 属地（${intent.province}）与门店所在省份一致`);
  if (cityStated || provinceStated)
    return component(
      'location_match',
      0,
      max,
      `提及地点（${cityStated ? intent.location : intent.province}）与门店所在地（${profile.city}，${profile.province}）不一致`,
    );
  if (provinceFromIp)
    return component('location_match', 0, max, `IP 属地（${intent.province}）与门店所在省份（${profile.province}）不一致`);
  return component('location_match', 0, max, '未识别到用户位置信息');
}

function stageComponent(det: IntentDetection, max: number): ScoreComponent {
  const stage = det.intent.purchase_stage;
  if (!stage || !STAGE_SET.has(stage)) return component('purchase_stage', 0, max, '未识别购买阶段');
  return component('purchase_stage', scaled(STAGE_POINTS[stage], 12, max), max, `购买阶段：${STAGE_LABELS[stage]}`);
}

function recencyComponent(signalAt: string, now: string, max: number): ScoreComponent {
  const days = daysBetween(signalAt, now);
  if (!Number.isFinite(days)) return component('recency', 0, max, '信号时间无效，无法计算时效');
  const age = Math.max(0, days);
  const shown = age < 1 ? '不足 1' : String(Math.floor(age));
  for (const [limit, points, label] of RECENCY_BUCKETS) {
    if (age <= limit) return component('recency', scaled(points, 6, max), max, `信号距今 ${shown} 天（${label}）`);
  }
  return component('recency', 0, max, `信号距今 ${shown} 天（超过 90 天）`);
}

function authenticityComponent(auth: SignalScoreInput['authenticity'], max: number): ScoreComponent {
  const rawScore = auth && Number.isFinite(auth.score) ? auth.score : AUTHENTICITY_DEFAULT;
  const score = clamp(rawScore, 0, AUTHENTICITY_SCALE);
  const reasons = (auth?.reasons ?? []).filter((r) => r.trim().length > 0);
  const fallback =
    score <= 0
      ? '疑似营销号/行业账号'
      : score >= AUTHENTICITY_SCALE
        ? '已核实为本地真实用户'
        : '未发现账号异常，按默认真实性计分';
  return component(
    'authenticity',
    Math.round((score * max) / AUTHENTICITY_SCALE),
    max,
    reasons.length > 0 ? reasons.join('；') : fallback,
  );
}

function relevanceComponent(det: IntentDetection, profile: DealerProfile, max: number): ScoreComponent {
  const intent = det.intent;
  const brand = brandCarried(profile, intent.brand);
  const model = carriedModel(profile, intent.model);
  if (brand || model) {
    const shown = brand ?? profile.brands[0] ?? model;
    return component('dealer_relevance', scaled(5, 5, max), max, `品牌 ${shown} 为门店经营品牌`);
  }
  const compared = comparedCarriedModel(det, profile);
  if (compared)
    return component(
      'dealer_relevance',
      scaled(3, 5, max),
      max,
      `竞品${intent.brand ? `品牌 ${intent.brand}` : intent.model ? `车型 ${intent.model}` : ''}，但与门店在售车型 ${compared} 对比`,
    );
  return component(
    'dealer_relevance',
    0,
    max,
    intent.brand ? `品牌 ${intent.brand} 非门店经营品牌` : '未涉及门店经营品牌或车型',
  );
}

const NON_SIGNAL_ROLE_REASONS: Readonly<Partial<Record<AuthorRole, string>>> = {
  owner: '已购车车主，非在市买家',
  creator: '内容创作/经验分享，非本人购车询问',
  marketing: '营销/同行销售账号',
};

function nonSignalReason(det: IntentDetection): string {
  const byRole = det.author_role ? NON_SIGNAL_ROLE_REASONS[det.author_role] : undefined;
  if (byRole) return byRole;
  if (det.is_marketing === true) return NON_SIGNAL_ROLE_REASONS.marketing!;
  return det.negative ? '用户明确表示无意向/拒绝' : '未检测到购车意向';
}

/**
 * Pure, deterministic signal scoring. Components always sum to the score: non-purchase signals (incl. owners,
 * creators and marketing accounts) carry a negative `non_purchase_signal` adjustment, and an explicitly out-of-area
 * buyer carries a negative `out_of_area_cap` adjustment that keeps the score below the qualified threshold (§5.2).
 */
export function scoreSignal(
  input: SignalScoreInput,
  cfg: Pick<ScoringConfig, 'weights' | 'thresholds'>,
): { score: number; tier: ScoreTier; components: ScoreComponent[] } {
  const max = effectiveMaxima(cfg.weights);
  const det = input.detection;
  const recency = recencyComponent(input.signal_at, input.now, max.recency);
  const authenticity = authenticityComponent(input.authenticity, max.authenticity);

  if (!det.is_purchase_signal || det.negative || isNonBuyerRole(det.author_role) || det.is_marketing === true) {
    const base = recency.points + authenticity.points;
    const score = clamp(Math.round(base * 0.2), 0, 100);
    return {
      score,
      tier: tierFor(score, cfg.thresholds),
      components: [
        recency,
        authenticity,
        {
          factor: 'non_purchase_signal',
          points: score - base,
          max: 0,
          reason: `非购车信号（${nonSignalReason(det)}）：得分 = (时效 ${recency.points} + 真实性 ${authenticity.points}) × 0.2`,
        },
      ],
    };
  }

  const components = [
    explicitIntentComponent(det, max.explicit_purchase_intent),
    transactionComponent(det, max.transaction_questions),
    modelComponent(det, input.dealer, max.model_match),
    inventoryComponent(det, input.dealer, max.inventory_match),
    locationComponent(det, input.dealer, max.location_match),
    stageComponent(det, max.purchase_stage),
    recency,
    authenticity,
    relevanceComponent(det, input.dealer, max.dealer_relevance),
  ];
  let score = clamp(
    components.reduce((sum, c) => sum + c.points, 0),
    0,
    100,
  );

  const area = statedAreaMatch(det.intent, input.dealer);
  if (area.match === 'out_of_area') {
    const cap = Math.max(0, cfg.thresholds.qualified - 1);
    const delta = Math.min(0, cap - score);
    components.push({
      factor: OUT_OF_AREA_FACTOR,
      points: delta,
      max: 0,
      reason: `异地买家（${area.place}），不在本店服务范围${delta < 0 ? `，得分封顶 ${cap}` : ''}`,
    });
    score += delta;
  }
  return { score, tier: tierFor(score, cfg.thresholds), components };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal reconstruction & authenticity
// ─────────────────────────────────────────────────────────────────────────────

/** A stored signal: intent + evidence, plus the migration-v2 detection columns when the writer provided them. */
export type StoredSignal = Pick<LeadSignal, 'intent' | 'evidence' | 'engine'> &
  Partial<Pick<LeadSignal, 'is_purchase_signal' | 'strength' | 'transaction_questions' | 'author_role'>>;

/**
 * True for rows whose migration-v2 columns still hold the defaults (`strength = 0`, no transaction questions,
 * `is_purchase_signal = 1`, `author_role = NULL`): they were written before v2 and must be read from evidence codes.
 * `is_purchase_signal = false` or a non-null `author_role` can only come from a v2 writer, so such rows are v2 even
 * with strength 0 (non-purchase signals are stored with strength 0).
 */
export function isLegacySignalRow(signal: StoredSignal): boolean {
  if (signal.author_role != null) return false;
  if (signal.is_purchase_signal === false) return false;
  const strength = Number(signal.strength);
  if (Number.isFinite(strength) && strength > 0) return false;
  if (Array.isArray(signal.transaction_questions) && signal.transaction_questions.length > 0) return false;
  return true;
}

function roleFromCodes(codes: readonly string[]): AuthorRole | undefined {
  for (const role of ['marketing', 'owner', 'creator'] as const) {
    if (codes.some((c) => ROLE_BY_CODE.get(c) === role)) return role;
  }
  return undefined;
}

/**
 * Rebuild the IntentDetection a stored signal was scored from (see SKILL.md "Stored-signal conventions").
 * - v2 rows: `is_purchase_signal`, `strength`, `transaction_questions` and `author_role` come from the columns;
 *   negative feedback still comes from evidence codes; owner / creator / marketing roles are never purchase signals.
 * - legacy rows ({@link isLegacySignalRow}): transaction questions from `tq:<question>` codes or codes equal to a
 *   TRANSACTION_QUESTIONS value (else derived from intent flags), strength from `strength:<0..1>` or the stage
 *   anchor, negative from `negative` / `not_interested` / `negative_feedback`, non-purchase from `non_purchase`,
 *   a prefilter reason, `content_creator` / `already_purchased`, or no stage and no questions.
 */
export function detectionFromSignal(signal: StoredSignal): IntentDetection {
  const intent = signal.intent ?? {};
  const evidence = Array.isArray(signal.evidence) ? signal.evidence : [];
  const codes = evidence.map((e) => (typeof e?.code === 'string' ? e.code.trim() : '')).filter((c) => c.length > 0);
  const stage = intent.purchase_stage && STAGE_SET.has(intent.purchase_stage) ? intent.purchase_stage : undefined;
  const negative = codes.some((c) => NEGATIVE_CODES.has(c));
  const marketingCode = codes.includes('marketing_account');

  if (!isLegacySignalRow(signal)) {
    const role = signal.author_role ?? roleFromCodes(codes);
    const questions = distinctQuestions(Array.isArray(signal.transaction_questions) ? signal.transaction_questions : []);
    const stored = Number(signal.strength);
    const strength = Number.isFinite(stored) && stored > 0 ? clamp(stored, 0, 1) : stage ? STRENGTH_ANCHORS[stage] : 0;
    const nonBuyer = isNonBuyerRole(role) || marketingCode;
    const purchase = signal.is_purchase_signal !== false && !negative && !nonBuyer && (stage !== undefined || questions.length > 0);
    return {
      is_purchase_signal: purchase,
      intent,
      evidence,
      transaction_questions: questions,
      strength: purchase ? strength : 0,
      negative,
      engine: signal.engine,
      is_marketing: role === 'marketing' || marketingCode,
      ...(role ? { author_role: role } : {}),
    };
  }

  const stored: string[] = [];
  let storedStrength: number | null = null;
  for (const code of codes) {
    if (code.startsWith(TQ_EVIDENCE_PREFIX)) stored.push(code.slice(TQ_EVIDENCE_PREFIX.length));
    else if (TQ_SET.has(code)) stored.push(code);
    else if (code.startsWith(STRENGTH_EVIDENCE_PREFIX)) {
      const n = Number(code.slice(STRENGTH_EVIDENCE_PREFIX.length));
      if (Number.isFinite(n) && n >= 0 && n <= 1) storedStrength = n;
    }
  }
  let questions = distinctQuestions(stored);
  if (questions.length === 0) {
    const derived: TransactionQuestion[] = [];
    if (intent.price_intent) derived.push('price');
    if (intent.discount_intent) derived.push('discount');
    if (intent.inventory_intent) derived.push('inventory');
    if (intent.inventory_intent && intent.color_intent) derived.push('color_trim_availability');
    if (intent.financing_intent) derived.push('finance');
    if (intent.leasing_intent) derived.push('lease');
    if (intent.trade_in_intent) derived.push('trade_in');
    if (intent.dealer_selection_intent) derived.push('dealer_location');
    if (intent.visit_intent) derived.push('test_drive');
    questions = derived;
  }

  const nonPurchase = codes.some((c) => NON_PURCHASE_CODES.has(c));
  const strength = storedStrength ?? (stage ? STRENGTH_ANCHORS[stage] : 0);
  const role = roleFromCodes(codes);

  return {
    is_purchase_signal: !negative && !nonPurchase && (stage !== undefined || questions.length > 0),
    intent,
    evidence,
    transaction_questions: questions,
    strength,
    negative,
    engine: signal.engine,
    is_marketing: marketingCode,
    ...(role ? { author_role: role } : {}),
  };
}

/** Authenticity from lead-research evidence codes: industry_account → 0 · verified_local_user → 5 · otherwise 4. */
export function authenticityFromEvidence(evidence: readonly Evidence[]): { score: number; reasons: string[] } {
  const list = Array.isArray(evidence) ? evidence : [];
  const industry = list.filter((e) => INDUSTRY_CODES.has(e.code));
  if (industry.length > 0) {
    const detail = industry.map((e) => e.label).filter(Boolean).join('；') || industry.map((e) => e.code).join('、');
    return { score: 0, reasons: [`疑似营销号/行业账号：${detail}`] };
  }
  const verified = list.filter((e) => e.code === VERIFIED_LOCAL_CODE);
  if (verified.length > 0)
    return {
      score: AUTHENTICITY_SCALE,
      reasons: [`已核实为本地真实用户${verified[0].label ? `：${verified[0].label}` : ''}`],
    };
  return { score: AUTHENTICITY_DEFAULT, reasons: ['未发现营销号/行业账号特征，按默认真实性计分'] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring configuration (versioned per dealer)
// ─────────────────────────────────────────────────────────────────────────────

function normalizeConfig(row: ScoringConfig): ScoringConfig {
  return {
    ...row,
    weights: { ...DEFAULT_WEIGHTS, ...(row.weights ?? {}) },
    thresholds: { ...DEFAULT_THRESHOLDS, ...(row.thresholds ?? {}) },
  };
}

/** Returns the dealer's active scoring config, creating version 1 with the defaults when none exists. */
export function getScoringConfig(ctx: AppContext, dealerId: string): ScoringConfig {
  const table = ctx.db.table('scoring_configs');
  const active = table.findOne({ dealer_id: dealerId, active: true });
  if (active) return normalizeConfig(active);

  return ctx.db.tx(() => {
    const again = table.findOne({ dealer_id: dealerId, active: true });
    if (again) return normalizeConfig(again);
    if (!ctx.db.table('dealers').get(dealerId)) throw new NotFoundError('dealer', dealerId);

    const latest = table.findOne({ dealer_id: dealerId }, { orderBy: 'version DESC' });
    if (latest) {
      const row = table.update(latest.id, { active: true });
      ctx.audit.event({
        actor: `agent:${AGENT}`,
        action: 'scoring.config_reactivated',
        entity_type: 'scoring_config',
        entity_id: row.id,
        details: { dealer_id: dealerId, version: row.version, reason: 'no active scoring config found' },
      });
      return normalizeConfig(row);
    }

    const row = table.insert({
      id: newId('scfg'),
      dealer_id: dealerId,
      version: 1,
      weights: { ...DEFAULT_WEIGHTS },
      thresholds: { ...DEFAULT_THRESHOLDS },
      active: true,
      created_at: ctx.clock.iso(),
    });
    ctx.audit.event({
      actor: `agent:${AGENT}`,
      action: 'scoring.config_initialized',
      entity_type: 'scoring_config',
      entity_id: row.id,
      details: { dealer_id: dealerId, version: 1, weights: row.weights, thresholds: row.thresholds },
    });
    return normalizeConfig(row);
  });
}

function assertPlainObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ValidationError(path, 'expected object');
  return value as Record<string, unknown>;
}

function readNumberPatch(
  value: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, number> {
  const obj = assertPlainObject(value, path);
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(obj)) {
    if (raw === undefined) continue;
    if (!allowed.includes(key)) throw new ValidationError(`${path}.${key}`, `unknown key (allowed: ${allowed.join('|')})`);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new ValidationError(`${path}.${key}`, 'expected finite number');
    if (raw < 0) throw new ValidationError(`${path}.${key}`, 'must be >= 0');
    if (raw > 100) throw new ValidationError(`${path}.${key}`, 'must be <= 100');
    out[key] = raw;
  }
  return out;
}

/** Creates version N+1 as the single active config (previous version deactivated in the same transaction). */
export function updateScoringConfig(
  ctx: AppContext,
  dealerId: string,
  patch: { weights?: Partial<ScoringWeights>; thresholds?: Partial<ScoringThresholds> },
  actor: string,
): ScoringConfig {
  if (typeof actor !== 'string' || actor.trim() === '') throw new ValidationError('actor', 'actor is required');
  const body = assertPlainObject(patch, 'patch');
  for (const key of Object.keys(body)) {
    if (key !== 'weights' && key !== 'thresholds' && body[key] !== undefined)
      throw new ValidationError(`patch.${key}`, 'unknown key (allowed: weights|thresholds)');
  }
  const weightPatch = body.weights === undefined ? {} : readNumberPatch(body.weights, 'weights', SCORING_FACTORS);
  const thresholdPatch =
    body.thresholds === undefined ? {} : readNumberPatch(body.thresholds, 'thresholds', THRESHOLD_KEYS);
  if (Object.keys(weightPatch).length === 0 && Object.keys(thresholdPatch).length === 0)
    throw new ValidationError('patch', 'nothing to update: provide weights and/or thresholds');

  return ctx.db.tx(() => {
    const table = ctx.db.table('scoring_configs');
    const current = getScoringConfig(ctx, dealerId);
    const weights: ScoringWeights = { ...current.weights, ...weightPatch };
    const thresholds: ScoringThresholds = { ...current.thresholds, ...thresholdPatch };

    const weightSum = SCORING_FACTORS.reduce((sum, f) => sum + weights[f], 0);
    if (weightSum <= 0) throw new ValidationError('weights', 'at least one weight must be greater than 0');
    if (!(thresholds.candidate > 0))
      throw new ValidationError(
        'thresholds.candidate',
        'candidate threshold must be greater than 0 (otherwise leads without any signal would become candidates)',
      );
    for (let i = 1; i < THRESHOLD_KEYS.length; i++) {
      const prev = THRESHOLD_KEYS[i - 1];
      const key = THRESHOLD_KEYS[i];
      if (!(thresholds[key] > thresholds[prev]))
        throw new ValidationError(
          `thresholds.${key}`,
          `thresholds must be strictly ascending (${prev} ${thresholds[prev]} < ${key} ${thresholds[key]})`,
        );
    }

    const latest = table.findOne({ dealer_id: dealerId }, { orderBy: 'version DESC' });
    const version = Math.max(current.version, latest?.version ?? 0) + 1;
    table.update(current.id, { active: false });
    const row = table.insert({
      id: newId('scfg'),
      dealer_id: dealerId,
      version,
      weights,
      thresholds,
      active: true,
      created_at: ctx.clock.iso(),
    });

    const changes: Record<string, { from: number; to: number }> = {};
    for (const f of SCORING_FACTORS)
      if (current.weights[f] !== weights[f]) changes[`weights.${f}`] = { from: current.weights[f], to: weights[f] };
    for (const k of THRESHOLD_KEYS)
      if (current.thresholds[k] !== thresholds[k])
        changes[`thresholds.${k}`] = { from: current.thresholds[k], to: thresholds[k] };

    ctx.audit.event({
      actor,
      action: 'scoring.config_updated',
      entity_type: 'scoring_config',
      entity_id: row.id,
      details: {
        dealer_id: dealerId,
        previous_config_id: current.id,
        from_version: current.version,
        to_version: version,
        changes,
        weights,
        thresholds,
        weight_sum: weightSum,
      },
    });
    return normalizeConfig(row);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Group-level dealer matching (ARCHITECTURE §5.3)
// ─────────────────────────────────────────────────────────────────────────────

/** Every dealer id of `dealerId`'s group, the given dealer first (others in listDealers order). */
export function listGroupDealerIds(ctx: AppContext, dealerId: string): string[] {
  const dealer = ctx.db.table('dealers').get(dealerId);
  if (!dealer) throw new NotFoundError('dealer', dealerId);
  return [dealer.id, ...listDealers(ctx, dealer.group_id).map((d) => d.id).filter((id) => id !== dealer.id)];
}

export interface DealerSignalEvaluation {
  dealer_id: string;
  detection: IntentDetection;
  score: number;
  tier: ScoreTier;
  components: ScoreComponent[];
}

export interface EvaluateSignalForDealersInput {
  dealer_ids: string[];
  text: string;
  context: SignalContext;
  signal_at: string;
  authenticity?: { score: number; reasons: string[] };
  /** wins ties (typically the dealer whose query surfaced the signal) */
  preferred_dealer_id?: string | null;
}

/**
 * Runs rules detection + signal scoring of ONE public signal against every given dealer profile (each dealer's own
 * active scoring config and timezone, evaluated at ctx.clock). `best` is the highest score; ties go to
 * `preferred_dealer_id`, then to input order. Duplicate ids are evaluated once. Read-only apart from initializing a
 * dealer's v1 scoring config on first use; callers record the per-dealer scores in their own decision.
 */
export function evaluateSignalForDealers(
  ctx: AppContext,
  input: EvaluateSignalForDealersInput,
): { results: DealerSignalEvaluation[]; best: DealerSignalEvaluation } {
  if (!input || !Array.isArray(input.dealer_ids)) throw new ValidationError('dealer_ids', 'expected an array of dealer ids');
  const ids: string[] = [];
  input.dealer_ids.forEach((id: unknown, i) => {
    // a malformed id is a caller bug: silently dropping it would route the signal among fewer dealers than intended
    if (typeof id !== 'string' || id.trim().length === 0) throw new ValidationError(`dealer_ids[${i}]`, 'expected a non-empty dealer id');
    if (!ids.includes(id)) ids.push(id);
  });
  if (ids.length === 0) throw new ValidationError('dealer_ids', 'at least one dealer id is required');
  if (typeof input.text !== 'string') throw new ValidationError('text', 'expected string');
  if (!input.context || typeof input.context !== 'object') throw new ValidationError('context', 'expected signal context');
  if (!(SIGNAL_SOURCE_TYPES as readonly string[]).includes(input.context.source_type))
    throw new ValidationError('context.source_type', `expected one of ${SIGNAL_SOURCE_TYPES.join('|')}`);
  if (typeof input.signal_at !== 'string') throw new ValidationError('signal_at', 'expected ISO timestamp string');

  const nowDate = ctx.clock.now();
  const now = ctx.clock.iso();
  const results = ids.map((dealerId): DealerSignalEvaluation => {
    const dealer = buildDealerProfile(ctx, dealerId);
    const cfg = getScoringConfig(ctx, dealerId);
    const tz = ctx.db.table('dealers').get(dealerId)?.settings?.timezone || DEFAULT_TZ;
    const detection = detectIntentRules(input.text, input.context, dealer, { now: nowDate, tz });
    const scored = scoreSignal({ detection, signal_at: input.signal_at, now, dealer, authenticity: input.authenticity }, cfg);
    return { dealer_id: dealerId, detection, ...scored };
  });

  const preferred = input.preferred_dealer_id ?? null;
  let best = results[0];
  for (const r of results.slice(1)) {
    if (r.score > best.score || (r.score === best.score && preferred !== null && r.dealer_id === preferred && best.dealer_id !== preferred)) {
      best = r;
    }
  }
  return { results, best };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lead aggregate scoring
// ─────────────────────────────────────────────────────────────────────────────

interface ScoredSignal {
  signal: LeadSignal;
  detection: IntentDetection;
  result: { score: number; tier: ScoreTier; components: ScoreComponent[] };
}

/** Best re-scored signal of the lead against every dealer of its group (§5.3), for the lead_score decision. */
function groupDealerScores(
  ctx: AppContext,
  lead: Lead,
  scored: readonly ScoredSignal[],
  authenticity: { score: number; reasons: string[] },
  now: string,
  own: { dealer: DealerProfile; config: ScoringConfig },
): { dealer_id: string; best_signal_id: string | null; best_signal_score: number; tier: ScoreTier }[] {
  return listGroupDealerIds(ctx, lead.dealer_id).map((dealerId) => {
    const isOwn = dealerId === lead.dealer_id;
    const dealer = isOwn ? own.dealer : buildDealerProfile(ctx, dealerId);
    const config = isOwn ? own.config : getScoringConfig(ctx, dealerId);
    let bestId: string | null = null;
    let bestScore = 0;
    for (const s of scored) {
      const score = isOwn ? s.result.score : scoreSignal({ detection: s.detection, signal_at: s.signal.signal_at, now, dealer, authenticity }, config).score;
      if (bestId === null || score > bestScore) {
        bestId = s.signal.id;
        bestScore = score;
      }
    }
    return { dealer_id: dealerId, best_signal_id: bestId, best_signal_score: bestScore, tier: tierFor(bestScore, config.thresholds) };
  });
}

/**
 * Re-scores every signal of the lead at ctx.clock.now() (recency decays), aggregates
 * `min(100, best + min(5, 2 × (qualifying − 1)))` where qualifying = PURCHASE signals ≥ candidate, keeps an
 * explicitly out-of-area buyer below qualified (§5.2), persists a lead_scores row, updates leads.score / leads.tier
 * (never the stage) and records a `lead_score` decision including the per-dealer scores of the group (§5.3).
 */
export function scoreLead(ctx: AppContext, leadId: string): LeadScore {
  const lead = ctx.db.table('leads').get(leadId);
  if (!lead) throw new NotFoundError('lead', leadId);

  const signals = ctx.db.table('lead_signals').findMany({ lead_id: leadId }, { orderBy: 'signal_at ASC, created_at ASC' });
  const dealer = buildDealerProfile(ctx, lead.dealer_id);
  const config = getScoringConfig(ctx, lead.dealer_id);
  const authenticity = authenticityFromEvidence(lead.evidence);
  const now = ctx.clock.iso();

  const scored: ScoredSignal[] = signals.map((signal) => {
    const detection = detectionFromSignal(signal);
    const result = scoreSignal({ detection, signal_at: signal.signal_at, now, dealer, authenticity }, config);
    return { signal, detection, result };
  });

  let best: ScoredSignal | null = null;
  for (const s of scored) {
    if (!best || s.result.score > best.result.score || (s.result.score === best.result.score && s.signal.signal_at >= best.signal.signal_at))
      best = s;
  }

  // corroboration only from purchase signals that reach candidate themselves (§5: owners/creators/praise never count)
  const purchaseSignals = scored.filter((s) => s.detection.is_purchase_signal && !s.detection.negative);
  const qualifyingSignals = purchaseSignals.filter((s) => s.result.score >= config.thresholds.candidate);
  const qualifying = qualifyingSignals.length;
  const bonus = qualifying >= 2 ? Math.min(5, 2 * (qualifying - 1)) : 0;
  const bestScore = best ? best.result.score : 0;

  // §5.2 at lead level: a buyer who explicitly states an out-of-area place in any purchase signal — and an in-area
  // place in none — is never qualified for this dealer, whichever of their signals happens to score best
  const areas = purchaseSignals.map((s) => statedAreaMatch(s.detection.intent, dealer));
  const outOfArea = areas.find((a) => a.match === 'out_of_area');
  const areaCapped = outOfArea !== undefined && !areas.some((a) => a.match === 'in_area');
  const areaCap = Math.max(0, config.thresholds.qualified - 1);
  const uncapped = best ? Math.min(100, bestScore + bonus) : 0;
  const score = areaCapped ? Math.min(uncapped, areaCap) : uncapped;
  const bonusApplied = clamp(score - bestScore, 0, bonus);
  /** < 0 only when the lead-level cap lowers the best signal itself (its own components do not carry the cap) */
  const capDelta = score - bestScore - bonusApplied;
  const tier = tierFor(score, config.thresholds);

  const components: ScoreComponent[] = best
    ? best.result.components.map((c) => ({ ...c }))
    : [{ factor: 'no_signals', points: 0, max: 0, reason: '该线索暂无可评分的公开信号' }];
  if (bonus > 0) {
    const capNote =
      bonusApplied >= bonus
        ? ''
        : areaCapped && uncapped > score
          ? `（应加 ${bonus} 分，异地买家总分封顶 ${areaCap}）`
          : `（应加 ${bonus} 分，总分封顶 100）`;
    components.push({
      factor: 'corroboration',
      points: bonusApplied,
      max: 5,
      reason: `${qualifying} 条信号达到候选阈值（≥${config.thresholds.candidate}），多条购车信号互相印证加 ${bonusApplied} 分${capNote}`,
    });
  }
  if (capDelta < 0 && outOfArea) {
    components.push({
      factor: OUT_OF_AREA_FACTOR,
      points: capDelta,
      max: 0,
      reason: `异地买家（${outOfArea.place ?? '外省'}），不在本店服务范围，线索总分封顶 ${areaCap}`,
    });
  }

  const rawConfidence = best?.detection.intent.confidence ?? lead.intent?.confidence;
  const confidence =
    typeof rawConfidence === 'number' && Number.isFinite(rawConfidence) ? clamp(rawConfidence, 0, 1) : 0.5;
  const evidence = lead.evidence.length > 0 ? lead.evidence : best ? best.signal.evidence : [];
  const dealerScores = groupDealerScores(ctx, lead, scored, authenticity, now, { dealer, config });

  return ctx.db.tx(() => {
    const row = ctx.db.table('lead_scores').insert({
      id: newId('lsc'),
      lead_id: lead.id,
      score,
      tier,
      components,
      config_version: config.version,
      computed_at: now,
    });

    if (lead.score !== score || lead.tier !== tier) {
      ctx.db.table('leads').update(lead.id, { score, tier });
      ctx.audit.event({
        actor: `agent:${AGENT}`,
        action: 'lead.score_updated',
        entity_type: 'lead',
        entity_id: lead.id,
        details: {
          from_score: lead.score,
          to_score: score,
          from_tier: lead.tier,
          to_tier: tier,
          lead_score_id: row.id,
          config_version: config.version,
        },
      });
    }

    ctx.audit.decision({
      agent: AGENT,
      skill: SKILL,
      decision_type: 'lead_score',
      subject_type: 'lead',
      subject_id: lead.id,
      inputs: {
        dealer_id: lead.dealer_id,
        scored_at: now,
        config_id: config.id,
        config_version: config.version,
        weights: config.weights,
        thresholds: config.thresholds,
        authenticity,
        group_dealer_scores: dealerScores,
        signals: scored.map((s) => ({
          signal_id: s.signal.id,
          signal_at: s.signal.signal_at,
          content: s.signal.content,
          score: s.result.score,
          tier: s.result.tier,
          transaction_questions: s.detection.transaction_questions,
          strength: s.detection.strength,
          is_purchase_signal: s.detection.is_purchase_signal,
          author_role: s.detection.author_role ?? null,
          legacy_row: isLegacySignalRow(s.signal),
        })),
      },
      evidence,
      output: {
        lead_score_id: row.id,
        score,
        tier,
        previous_score: lead.score,
        previous_tier: lead.tier,
        best_signal_id: best?.signal.id ?? null,
        best_signal_score: bestScore,
        qualifying_signals: qualifying,
        corroboration_bonus: bonusApplied,
        out_of_area_capped: areaCapped,
        out_of_area_place: areaCapped ? (outOfArea?.place ?? null) : null,
        components,
      },
      confidence,
      engine: 'rules',
    });

    return row;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill definition
// ─────────────────────────────────────────────────────────────────────────────

export const skill = defineSkill<{ lead_id: string }, LeadScore>({
  name: 'lead-scoring',
  category: 'acquisition',
  agent: 'lead-scoring-agent',
  description:
    '按经销商可配置权重，对线索的全部公开信号在当前时间重新评分（购买意向、交易问题、车型/库存/地域匹配、购买阶段、时效、真实性、品牌相关性），异地买家封顶、仅购车信号互相印证，聚合为线索分与分层，并记录含集团各门店得分的可审计评分依据。',
  input: v.object({ lead_id: v.string({ min: 1 }) }),
  run: (ctx, input) => scoreLead(ctx, input.lead_id),
  validateOutput(output) {
    if (!output || !Number.isFinite(output.score) || output.score < 0 || output.score > 100)
      throw new Error('lead-scoring: score must be a number within 0..100');
    if (!Array.isArray(output.components) || output.components.length === 0)
      throw new Error('lead-scoring: score components are required');
  },
});
