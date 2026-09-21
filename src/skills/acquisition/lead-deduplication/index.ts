/**
 * Lead Deduplication / identity resolution (spec §10, ARCHITECTURE §8 B1, §5.1, §5.3).
 *
 * One lead per Xiaohongshu user per dealer group. Every public signal of that user — comments on
 * different notes, their own posts, profile notes, replies, imports — is merged into that lead while
 * the original signal rows (verbatim content + evidence) are preserved for provenance.
 *
 * Persistence rules (binding):
 * - every stored signal writes `is_purchase_signal`, `strength`, `transaction_questions`, `author_role`
 *   from the detection and `evidence` unchanged, plus `signal_score` computed with `scoreSignal`;
 *   `is_purchase_signal` is normalized to false for negative, marketing and owner / creator / marketing-role
 *   detections (§5.1: those are never purchase signals, whatever an upstream refinement claimed);
 * - a non-purchase signal never CREATES a lead unless its source is `reply` / `import`; on an existing lead
 *   it is stored for history but never raises score or stage;
 * - identities equal to a managed account's `platform_account_id` (or its verified `platform_user_id`) in the
 *   group are rejected;
 * - suppressed identities are stored with `suppressed=true` and never advance.
 */
import type { AppContext } from '../../../app/context.ts';
import { dedupeEvidence } from '../../../core/evidence.ts';
import { NotFoundError, PolicyError, ValidationError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import { normalizeText } from '../../../core/text.ts';
import { DEFAULT_TZ, zonedTimeToUtc } from '../../../core/time.ts';
import {
  ACTOR_TYPES,
  AUTHOR_ROLES,
  DATA_MODES,
  ENGINES,
  PURCHASE_STAGES,
  SCORE_TIERS,
  SIGNAL_SOURCE_TYPES,
  TRANSACTION_QUESTIONS,
  type ActorType,
  type AuthorRole,
  type DataMode,
  type AutomotiveIntent,
  type ContactSuppression,
  type DealerProfile,
  type Evidence,
  type IntentDetection,
  type Lead,
  type LeadScore,
  type LeadSignal,
  type LeadStage,
  type PublicPost,
  type ScoreTier,
  type ScoringConfig,
  type SignalSourceType,
} from '../../../core/types.ts';
import { v, type Validator } from '../../../core/validate.ts';
import { CITY_PROVINCE, provinceOfIp } from '../../../domain/automotive-lexicon.ts';
import { aggregateActorType, classifyActor } from '../../../domain/actor-classification.ts';
import { buildDealerProfile } from '../../../domain/dealer-profile.ts';
import { isSuppressed, refreshNextAction, transitionLead } from '../../operations/crm/index.ts';
import { getDealer, resolveVehicle } from '../../operations/dealer-brain/index.ts';
import { defineSkill } from '../../registry.ts';
import { authenticityFromEvidence, getScoringConfig, scoreLead, scoreSignal } from '../lead-scoring/index.ts';

export const LEAD_DEDUP_AGENT = 'lead-hunting-agent';
const SKILL = 'lead-deduplication';
const ACTOR = `agent:${LEAD_DEDUP_AGENT}`;
const PLATFORM = 'xiaohongshu' as const;

/** Sources that may create a lead from a non-purchase signal (a user who replied to us / an operator import). */
export const NON_PURCHASE_CREATING_SOURCES: readonly SignalSourceType[] = ['reply', 'import'];

/** Author roles that are never purchase signals (ARCHITECTURE §5.1). */
export const NON_BUYER_AUTHOR_ROLES: readonly AuthorRole[] = ['owner', 'creator', 'marketing'];

/** Clock skew tolerated for a signal time slightly in the future; anything later is corrupt data and rejected. */
export const SIGNAL_FUTURE_TOLERANCE_MS = 15 * 60_000;

const SOURCE_LABELS: Readonly<Record<SignalSourceType, string>> = {
  post: '公开笔记',
  comment: '公开评论',
  profile: '主页笔记',
  reply: '私信回复',
  import: '人工导入',
};

const TIER_LABELS: Readonly<Record<ScoreTier, string>> = {
  none: '未达候选',
  candidate: '候选',
  qualified: '合格',
  high_intent: '高意向',
  immediate: '立即跟进',
};

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface SignalInput {
  source_type: SignalSourceType;
  /** internal public_posts.id (the note the signal was observed on / the user's own note) */
  public_post_id?: string | null;
  /** internal public_comments.id */
  public_comment_id?: string | null;
  post_title?: string | null;
  /** verbatim original signal text */
  content: string;
  /**
   * ISO-8601 with an offset (`2026-09-11T15:30:00Z`, `…+08:00`), or a wall-clock time without an offset
   * (`2026-09-11 23:30[:ss]`, `2026/09/11`), which is read in the dealer's timezone (Xiaohongshu shows Beijing time).
   */
  signal_at: string;
  search_run_id?: string | null;
  query_id?: string | null;
  detection: IntentDetection;
  /**
   * §10.1 provenance. When omitted: the linked public comment / post row's `data_mode`; else `import` for import
   * signals, `manual` for replies, the provider mode for profile signals, `unknown` otherwise.
   */
  data_mode?: DataMode | null;
}

export interface LeadIdentity {
  platform_user_id: string;
  username: string;
  profile_url?: string | null;
  /** public avatar observed with the signal (posts carry it; comments usually do not) */
  avatar_url?: string | null;
}

export interface UpsertLeadInput {
  dealer_id: string;
  identity: LeadIdentity;
  signal: SignalInput;
  attributed_post_id?: string | null;
}

export interface UpsertLeadResult {
  lead: Lead;
  signal: LeadSignal | null;
  created: boolean;
  merged: boolean;
  stage_changes: LeadStage[];
  /** additive: the signal was already stored for this lead (idempotent re-ingestion) */
  duplicate: boolean;
  /** additive: the lead moved to `input.dealer_id` under the group-level dealer matching rule (§5.3) */
  dealer_rerouted: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity lookup
// ─────────────────────────────────────────────────────────────────────────────

export function findLeadByIdentity(ctx: AppContext, groupId: string, platformUserId: string): Lead | undefined {
  if (!groupId || !platformUserId) return undefined;
  return ctx.db.table('leads').findOne({ group_id: groupId, platform: PLATFORM, platform_user_id: platformUserId });
}

// ─────────────────────────────────────────────────────────────────────────────
// Purchase-signal classification (§5.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why a detection is NOT a purchase signal (`null` when it is one): a refusal, a marketing account, an owner /
 * creator / marketing author role, or simply not flagged as a purchase signal.
 */
export function nonPurchaseReason(detection: IntentDetection): string | null {
  if (detection.negative === true) return 'negative';
  if (detection.is_marketing === true) return 'marketing';
  if (detection.author_role && NON_BUYER_AUTHOR_ROLES.includes(detection.author_role)) return `author_role:${detection.author_role}`;
  if (detection.is_purchase_signal !== true) return 'not_purchase_signal';
  return null;
}

/** A detection counts as a purchase signal only when flagged as one and not a refusal, marketing or non-buyer author. */
export function isPurchaseDetection(detection: IntentDetection): boolean {
  return nonPurchaseReason(detection) === null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent merging (pure)
// ─────────────────────────────────────────────────────────────────────────────

const compactKey = (s: string): string =>
  normalizeText(s)
    .replace(/[\s\-_·./]/g, '')
    .replace(/系列?/g, 'series');

const placeKey = (s: string): string =>
  compactKey(s).replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市)$/u, '');

const sameText = (a: unknown, b: unknown): boolean =>
  typeof a === 'string' && typeof b === 'string' ? compactKey(a) === compactKey(b) : a === b;

const samePlace = (a: string, b: string): boolean => placeKey(a) !== '' && placeKey(a) === placeKey(b);

const BOOLEAN_INTENT_KEYS = [
  'price_intent',
  'discount_intent',
  'inventory_intent',
  'financing_intent',
  'leasing_intent',
  'trade_in_intent',
  'dealer_selection_intent',
  'visit_intent',
] as const;
type BooleanIntentKey = (typeof BOOLEAN_INTENT_KEYS)[number];

/** Canonical key order used for `inferred_fields`. */
const INTENT_KEY_ORDER: readonly (keyof AutomotiveIntent)[] = [
  'brand',
  'model',
  'trim',
  'competing_models',
  'location',
  'province',
  'budget_min',
  'budget_max',
  'purchase_timeframe',
  'price_sensitivity',
  ...BOOLEAN_INTENT_KEYS,
  'color_intent',
  'purchase_stage',
  'confidence',
];

interface Side {
  intent: AutomotiveIntent;
  inferred: ReadonlySet<string>;
}

interface Sourced<T> {
  value: T;
  inferred: boolean;
}

type ScalarKey = 'brand' | 'model' | 'trim' | 'location' | 'province' | 'purchase_timeframe' | 'price_sensitivity' | 'color_intent';

function sideOf(intent: AutomotiveIntent | null | undefined): Side {
  const safe = intent && typeof intent === 'object' ? intent : {};
  return { intent: safe, inferred: new Set(Array.isArray(safe.inferred_fields) ? safe.inferred_fields : []) };
}

function scalar(side: Side, key: ScalarKey): Sourced<string> | undefined {
  const value = side.intent[key];
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return { value, inferred: side.inferred.has(key) };
}

/** Same value → stated if either side stated it; otherwise stated beats inferred; otherwise the newer side wins. */
function latest<T>(base: Sourced<T> | undefined, next: Sourced<T> | undefined, same: (a: T, b: T) => boolean): Sourced<T> | undefined {
  if (!next) return base;
  if (!base) return next;
  if (same(base.value, next.value)) return { value: next.value, inferred: base.inferred && next.inferred };
  if (!base.inferred && next.inferred) return base;
  return next;
}

/** Vehicle specificity: a trim beats none; then a stated model beats an inferred one. */
function vehicleRank(side: Side): number {
  const model = scalar(side, 'model');
  if (!model) return -1;
  return (scalar(side, 'trim') ? 2 : 0) + (model.inferred ? 0 : 1);
}

function hasStatedLocation(side: Side): boolean {
  return (
    (!!scalar(side, 'location') && !side.inferred.has('location')) ||
    (!!scalar(side, 'province') && !side.inferred.has('province'))
  );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Merge two structured intents; `next` is the chronologically newer one.
 * - vehicle (brand, model, trim, colour) is merged as a consistent unit: the same model on both sides combines
 *   (stated if either side stated it, trim/colour from whichever side has them); for different models the more
 *   specific side wins (trim over none, then stated over inferred, then the newer side) and the other side's
 *   trim/colour is dropped;
 * - location: the latest STATED location wins (city + province as a unit, a compatible city is kept when only a
 *   province is stated); IP-inferred locations never override a stated one;
 * - competing_models: union (without the merged model); boolean intents: OR (true wins, then false);
 * - purchase_stage: the most advanced stage; budget_min: minimum; budget_max: maximum; confidence: maximum;
 * - timeframe / price sensitivity: latest; `inferred_fields` lists exactly the merged fields whose value is inferred.
 */
export function mergeIntents(base: AutomotiveIntent, next: AutomotiveIntent): AutomotiveIntent {
  const b = sideOf(base);
  const n = sideOf(next);
  const out: AutomotiveIntent = {};
  const inferred = new Set<string>();
  const put = (key: ScalarKey, value: Sourced<string> | undefined) => {
    if (!value) return;
    (out as Record<string, unknown>)[key] = value.value;
    if (value.inferred) inferred.add(key);
  };

  // ── vehicle unit ────────────────────────────────────────────────────────────
  const bm = scalar(b, 'model');
  const nm = scalar(n, 'model');
  let owner: 'both' | 'base' | 'next' | 'none';
  if (bm && nm) owner = sameText(bm.value, nm.value) ? 'both' : vehicleRank(n) >= vehicleRank(b) ? 'next' : 'base';
  else owner = nm ? 'next' : bm ? 'base' : 'none';

  const attached = (key: 'brand' | 'trim' | 'color_intent'): Sourced<string> | undefined => {
    const bf = scalar(b, key);
    const nf = scalar(n, key);
    if (owner === 'next') return nf ?? (bm ? undefined : bf);
    if (owner === 'base') return bf ?? (nm ? undefined : nf);
    return latest(bf, nf, sameText);
  };
  put('model', owner === 'both' ? latest(bm, nm, sameText) : owner === 'next' ? nm : owner === 'base' ? bm : undefined);
  put('brand', attached('brand'));
  put('trim', attached('trim'));
  put('color_intent', attached('color_intent'));

  const competing: string[] = [];
  const competingKeys = new Set<string>(out.model ? [compactKey(out.model)] : []);
  for (const m of [...(b.intent.competing_models ?? []), ...(n.intent.competing_models ?? [])]) {
    if (typeof m !== 'string' || m.trim() === '') continue;
    const key = compactKey(m);
    if (competingKeys.has(key)) continue;
    competingKeys.add(key);
    competing.push(m);
  }
  if (competing.length > 0) out.competing_models = competing;

  // ── location unit ───────────────────────────────────────────────────────────
  const [primary, other] = hasStatedLocation(n)
    ? [n, b]
    : hasStatedLocation(b)
      ? [b, n]
      : scalar(n, 'location') || scalar(n, 'province')
        ? [n, b]
        : [b, n];
  let city = scalar(primary, 'location');
  let province = scalar(primary, 'province');
  const otherCity = scalar(other, 'location');
  const otherProvince = scalar(other, 'province');
  if (!city && province && otherCity) {
    const cityProvince = otherProvince?.value ?? CITY_PROVINCE[otherCity.value];
    if (cityProvince && samePlace(cityProvince, province.value)) city = otherCity;
  }
  if (!province && city) {
    const fromOther = otherCity && otherProvince && samePlace(otherCity.value, city.value) ? otherProvince.value : undefined;
    const cityProvince = fromOther ?? CITY_PROVINCE[city.value];
    if (cityProvince) province = { value: cityProvince, inferred: city.inferred };
  }
  put('location', city);
  put('province', province);

  // ── budget ──────────────────────────────────────────────────────────────────
  const bMin = finiteNumber(b.intent.budget_min);
  const nMin = finiteNumber(n.intent.budget_min);
  const bMax = finiteNumber(b.intent.budget_max);
  const nMax = finiteNumber(n.intent.budget_max);
  const pickNumber = (key: 'budget_min' | 'budget_max', bv: number | undefined, nv: number | undefined, prefer: (x: number, y: number) => boolean) => {
    if (bv === undefined && nv === undefined) return;
    let fromBase: boolean;
    let fromNext: boolean;
    if (bv === undefined) [fromBase, fromNext] = [false, true];
    else if (nv === undefined) [fromBase, fromNext] = [true, false];
    else if (bv === nv) [fromBase, fromNext] = [true, true];
    else [fromBase, fromNext] = prefer(bv, nv) ? [true, false] : [false, true];
    out[key] = (fromBase ? bv : nv) as number;
    const sources = [fromBase ? b : null, fromNext ? n : null].filter((s): s is Side => s !== null);
    if (sources.every((s) => s.inferred.has(key))) inferred.add(key);
  };
  pickNumber('budget_min', bMin, nMin, (x, y) => x < y);
  pickNumber('budget_max', bMax, nMax, (x, y) => x > y);

  put('purchase_timeframe', latest(scalar(b, 'purchase_timeframe'), scalar(n, 'purchase_timeframe'), sameText));
  const sensitivity = latest(scalar(b, 'price_sensitivity'), scalar(n, 'price_sensitivity'), sameText);
  if (sensitivity && (sensitivity.value === 'low' || sensitivity.value === 'medium' || sensitivity.value === 'high')) {
    out.price_sensitivity = sensitivity.value;
    if (sensitivity.inferred) inferred.add('price_sensitivity');
  }

  // ── boolean intents (OR) ────────────────────────────────────────────────────
  for (const key of BOOLEAN_INTENT_KEYS) {
    const values = [b, n].filter((s) => typeof s.intent[key] === 'boolean');
    if (values.length === 0) continue;
    const winner = values.some((s) => s.intent[key] === true);
    const contributing = values.filter((s) => s.intent[key] === winner);
    (out as Record<BooleanIntentKey, boolean>)[key] = winner;
    if (contributing.every((s) => s.inferred.has(key))) inferred.add(key);
  }

  // ── purchase stage (most advanced) ──────────────────────────────────────────
  const stageIdx = (s: Side) => {
    const stage = s.intent.purchase_stage;
    return stage ? PURCHASE_STAGES.indexOf(stage) : -1;
  };
  const bi = stageIdx(b);
  const ni = stageIdx(n);
  if (bi >= 0 || ni >= 0) {
    const top = Math.max(bi, ni);
    out.purchase_stage = PURCHASE_STAGES[top];
    const sources = [bi === top ? b : null, ni === top ? n : null].filter((s): s is Side => s !== null);
    if (sources.every((s) => s.inferred.has('purchase_stage'))) inferred.add('purchase_stage');
  }

  const confidences = [finiteNumber(b.intent.confidence), finiteNumber(n.intent.confidence)].filter((c): c is number => c !== undefined);
  if (confidences.length > 0) out.confidence = Math.max(...confidences);

  const fields = INTENT_KEY_ORDER.filter((k) => inferred.has(k) && out[k] !== undefined);
  if (fields.length > 0) out.inferred_fields = fields as string[];
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal time
// ─────────────────────────────────────────────────────────────────────────────

/** ISO-8601 instant with an explicit zone: `2026-09-11T15:30[:00[.123]](Z|+08:00|+0800|+08)`. */
const INSTANT_TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)$/i;
/** Wall-clock time without a zone: `2026-09-11 23:30[:05[.123]]`, `2026/9/11`, `2026-09-11T23:30`. */
const WALL_CLOCK_TS_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?$/;

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

type ParsedSignalTime = { kind: 'instant'; ms: number } | { kind: 'wall_clock'; parts: WallClock };

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
const millis = (digits: string | undefined): number => (digits ? Math.floor(Number(`0.${digits}`) * 1000) : 0);

function validWallClock(p: WallClock): boolean {
  return (
    p.month >= 1 &&
    p.month <= 12 &&
    p.day >= 1 &&
    p.day <= new Date(Date.UTC(p.year, p.month, 0)).getUTCDate() &&
    p.hour <= 23 &&
    p.minute <= 59 &&
    p.second <= 59
  );
}

/**
 * Strict signal-time parser. Never uses the host timezone: instants carry their own offset, wall-clock values are
 * resolved later in the dealer's timezone. Anything else (free text, day-first dates, impossible dates) is rejected.
 */
function parseSignalTime(raw: string, path: string): ParsedSignalTime {
  const s = raw.trim();
  const instant = INSTANT_TS_RE.exec(s);
  if (instant) {
    const parts: WallClock = {
      year: Number(instant[1]),
      month: Number(instant[2]),
      day: Number(instant[3]),
      hour: Number(instant[4]),
      minute: Number(instant[5]),
      second: Number(instant[6] ?? 0),
      ms: millis(instant[7]),
    };
    if (!validWallClock(parts)) throw new ValidationError(path, `invalid timestamp ${JSON.stringify(raw)}`);
    const zone = instant[8].toUpperCase();
    const offset = zone === 'Z' ? 'Z' : zone.length === 3 ? `${zone}:00` : zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    const ms = Date.parse(
      `${instant[1]}-${instant[2]}-${instant[3]}T${instant[4]}:${instant[5]}:${pad(parts.second)}.${pad(parts.ms, 3)}${offset}`,
    );
    if (Number.isNaN(ms)) throw new ValidationError(path, `invalid timestamp ${JSON.stringify(raw)}`);
    return { kind: 'instant', ms };
  }
  const wall = WALL_CLOCK_TS_RE.exec(s);
  if (wall) {
    const parts: WallClock = {
      year: Number(wall[1]),
      month: Number(wall[2]),
      day: Number(wall[3]),
      hour: Number(wall[4] ?? 0),
      minute: Number(wall[5] ?? 0),
      second: Number(wall[6] ?? 0),
      ms: millis(wall[7]),
    };
    if (!validWallClock(parts)) throw new ValidationError(path, `invalid timestamp ${JSON.stringify(raw)}`);
    return { kind: 'wall_clock', parts };
  }
  throw new ValidationError(
    path,
    `unsupported timestamp ${JSON.stringify(raw)} (use ISO-8601 with an offset, or 'YYYY-MM-DD HH:mm[:ss]' in the dealer's local time)`,
  );
}

/**
 * Resolve a signal time to canonical UTC ISO. Values with an offset are exact; wall-clock values without an offset
 * are read in `timezone` (the dealer's timezone — Xiaohongshu displays Beijing time).
 */
export function resolveSignalTime(value: string, timezone: string = DEFAULT_TZ, path = 'signal.signal_at'): string {
  const parsed = parseSignalTime(value, path);
  if (parsed.kind === 'instant') return new Date(parsed.ms).toISOString();
  const p = parsed.parts;
  let base: Date;
  try {
    base = zonedTimeToUtc(p.year, p.month, p.day, p.hour, p.minute, timezone);
  } catch {
    throw new ValidationError('dealer.settings.timezone', `invalid timezone ${JSON.stringify(timezone)}`);
  }
  const ms = base.getTime() + p.second * 1000 + p.ms;
  if (!Number.isFinite(ms)) throw new ValidationError(path, `invalid timestamp ${JSON.stringify(value)}`);
  return new Date(ms).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

const nonBlank =
  (max: number): Validator<string> =>
  (value, path = '') => {
    const s = v.string({ max })(value, path);
    if (s.trim() === '') throw new ValidationError(path, 'must not be blank');
    return s;
  };

/** Instants are canonicalized to UTC ISO; wall-clock values are kept (trimmed) until the dealer timezone is known. */
const signalTimestamp: Validator<string> = (value, path = '') => {
  const s = v.string({ min: 1, max: 64 })(value, path);
  const parsed = parseSignalTime(s, path);
  return parsed.kind === 'instant' ? new Date(parsed.ms).toISOString() : s.trim();
};

const optionalId = v.optional(v.nullable(v.string({ min: 1, max: 200 })));
const optionalText = v.optional(v.string({ max: 200 }));
const optionalFlag = v.optional(v.boolean());

export const evidenceValidator: Validator<Evidence> = v.object({
  code: v.string({ min: 1, max: 100 }),
  label: v.string({ max: 500 }),
  quote: v.optional(v.string({ max: 2000 })),
  source_ref: v.optional(v.string({ max: 500 })),
});

export const automotiveIntentValidator: Validator<AutomotiveIntent> = v.object({
  brand: optionalText,
  model: optionalText,
  trim: optionalText,
  competing_models: v.optional(v.array(v.string({ max: 200 }), { max: 50 })),
  location: optionalText,
  province: optionalText,
  budget_min: v.optional(v.number({ min: 0 })),
  budget_max: v.optional(v.number({ min: 0 })),
  purchase_timeframe: optionalText,
  price_sensitivity: v.optional(v.literal(['low', 'medium', 'high'])),
  price_intent: optionalFlag,
  discount_intent: optionalFlag,
  inventory_intent: optionalFlag,
  color_intent: optionalText,
  financing_intent: optionalFlag,
  leasing_intent: optionalFlag,
  trade_in_intent: optionalFlag,
  dealer_selection_intent: optionalFlag,
  visit_intent: optionalFlag,
  purchase_stage: v.optional(v.literal(PURCHASE_STAGES)),
  confidence: v.optional(v.number({ min: 0, max: 1 })),
  inferred_fields: v.optional(v.array(v.string({ min: 1, max: 50 }), { max: 50 })),
});

const detectionShape = v.object({
  is_purchase_signal: v.boolean(),
  intent: automotiveIntentValidator,
  evidence: v.array(evidenceValidator, { max: 200 }),
  transaction_questions: v.array(v.literal(TRANSACTION_QUESTIONS), { max: 20 }),
  strength: v.number({ min: 0, max: 1 }),
  negative: v.boolean(),
  engine: v.literal(ENGINES),
  is_marketing: optionalFlag,
  author_role: v.optional(v.nullable(v.literal(AUTHOR_ROLES))),
  actor_type: v.optional(v.nullable(v.literal(ACTOR_TYPES))),
});

/**
 * Validates a detection and enforces §5.1: a negative, marketing or owner / creator / marketing-role detection is
 * never a purchase signal (`is_purchase_signal` normalized to false), so neither lead creation nor re-scoring can
 * ever treat it as one.
 */
export const intentDetectionValidator: Validator<IntentDetection> = (value, path = '') => {
  const raw = detectionShape(value, path);
  const detection: IntentDetection = {
    is_purchase_signal: raw.is_purchase_signal,
    intent: raw.intent,
    evidence: raw.evidence,
    transaction_questions: raw.transaction_questions,
    strength: raw.strength,
    negative: raw.negative,
    engine: raw.engine,
  };
  if (raw.is_marketing !== undefined) detection.is_marketing = raw.is_marketing;
  if (raw.author_role !== undefined && raw.author_role !== null) detection.author_role = raw.author_role;
  if (raw.actor_type !== undefined && raw.actor_type !== null) detection.actor_type = raw.actor_type;
  detection.is_purchase_signal = isPurchaseDetection(detection);
  return detection;
};

const upsertShape = v.object({
  dealer_id: v.string({ min: 1, max: 200 }),
  identity: v.object({
    platform_user_id: nonBlank(200),
    username: v.string({ max: 200 }),
    profile_url: v.optional(v.nullable(v.string({ max: 2000 }))),
    avatar_url: v.optional(v.nullable(v.string({ max: 2000 }))),
  }),
  signal: v.object({
    source_type: v.literal(SIGNAL_SOURCE_TYPES),
    public_post_id: optionalId,
    public_comment_id: optionalId,
    post_title: v.optional(v.nullable(v.string({ max: 2000 }))),
    content: nonBlank(20000),
    signal_at: signalTimestamp,
    search_run_id: optionalId,
    query_id: optionalId,
    detection: intentDetectionValidator,
    data_mode: v.optional(v.nullable(v.literal(DATA_MODES))),
  }),
  attributed_post_id: optionalId,
});

/** Validates and normalizes an upsert request (instants → canonical ISO; unknown keys dropped). */
export const upsertLeadInputValidator: Validator<UpsertLeadInput> = (value, path = '') => {
  const raw = upsertShape(value, path);
  return {
    dealer_id: raw.dealer_id,
    identity: {
      platform_user_id: raw.identity.platform_user_id,
      username: raw.identity.username,
      profile_url: raw.identity.profile_url ?? null,
      avatar_url: raw.identity.avatar_url ?? null,
    },
    signal: {
      source_type: raw.signal.source_type,
      public_post_id: raw.signal.public_post_id ?? null,
      public_comment_id: raw.signal.public_comment_id ?? null,
      post_title: raw.signal.post_title ?? null,
      content: raw.signal.content,
      signal_at: raw.signal.signal_at,
      search_run_id: raw.signal.search_run_id ?? null,
      query_id: raw.signal.query_id ?? null,
      detection: raw.signal.detection,
      data_mode: raw.signal.data_mode ?? null,
    },
    attributed_post_id: raw.attributed_post_id ?? null,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const TERMINAL: readonly LeadStage[] = ['WON', 'LOST'];
const tierIndex = (tier: ScoreTier): number => SCORE_TIERS.indexOf(tier);
const earlier = (a: string, b: string): string => (Date.parse(b) < Date.parse(a) ? b : a);
const later = (a: string, b: string): string => (Date.parse(b) > Date.parse(a) ? b : a);

/**
 * Verify referenced public rows exist and belong to this identity (identity resolution must never cross users), and
 * complete the provenance of a comment signal from its stored comment (note id) and note (title).
 */
function resolveSourceRows(ctx: AppContext, signal: SignalInput, platformUserId: string): SignalInput {
  let publicPostId = signal.public_post_id ?? null;
  let post: PublicPost | undefined;
  if (publicPostId) {
    post = ctx.db.table('public_posts').get(publicPostId);
    if (!post) throw new NotFoundError('public_post', publicPostId);
    if (signal.source_type === 'post' && post.author_platform_user_id && post.author_platform_user_id !== platformUserId)
      throw new PolicyError('signal_identity_conflict', 'the public post was written by a different user than the given identity', {
        public_post_id: post.id,
        platform_user_id: platformUserId,
      });
  }
  if (signal.public_comment_id) {
    const comment = ctx.db.table('public_comments').get(signal.public_comment_id);
    if (!comment) throw new NotFoundError('public_comment', signal.public_comment_id);
    if (comment.author_platform_user_id && comment.author_platform_user_id !== platformUserId)
      throw new PolicyError('signal_identity_conflict', 'the public comment was written by a different user than the given identity', {
        public_comment_id: comment.id,
        platform_user_id: platformUserId,
      });
    if (publicPostId && comment.public_post_id !== publicPostId)
      throw new ValidationError('signal.public_comment_id', 'comment does not belong to signal.public_post_id');
    if (!publicPostId) {
      publicPostId = comment.public_post_id;
      post = ctx.db.table('public_posts').get(publicPostId);
    }
  }
  const title = signal.post_title ?? (post?.title?.trim() ? post.title : null);
  return { ...signal, public_post_id: publicPostId, post_title: title };
}

interface ExistingSignalLookup {
  duplicate: LeadSignal | null;
  /** the comment is already a signal of another group's lead (global unique index): store without the comment id */
  commentShared: boolean;
}

function findExistingSignal(ctx: AppContext, lead: Lead | undefined, groupId: string, signal: SignalInput): ExistingSignalLookup {
  const signals = ctx.db.table('lead_signals');
  let commentShared = false;
  if (signal.public_comment_id) {
    const existing = signals.findOne({ public_comment_id: signal.public_comment_id });
    if (!existing) return { duplicate: null, commentShared };
    if (lead && existing.lead_id === lead.id) return { duplicate: existing, commentShared };
    const owner = ctx.db.table('leads').get(existing.lead_id);
    if (owner && owner.group_id === groupId)
      throw new PolicyError('signal_identity_conflict', 'this public comment is already a signal of a different lead in the group', {
        public_comment_id: signal.public_comment_id,
        lead_id: owner.id,
      });
    commentShared = true;
  }
  if (!lead) return { duplicate: null, commentShared };
  if (signal.source_type === 'post' && signal.public_post_id) {
    const existing = signals.findOne({ lead_id: lead.id, source_type: 'post', public_post_id: signal.public_post_id });
    return { duplicate: existing ?? null, commentShared };
  }
  const key = normalizeText(signal.content);
  const postId = signal.public_post_id ?? null;
  const duplicate =
    signals
      .findMany({ lead_id: lead.id, source_type: signal.source_type, public_post_id: postId, public_comment_id: null })
      .find((s) => normalizeText(s.content) === key) ?? null;
  return { duplicate, commentShared };
}

/**
 * The lead's merged intent, folded chronologically (signal_at, then insertion order) over every purchase signal plus
 * the signal that created the lead. Folding the stored signals makes the result independent of ingestion order: an
 * older signal discovered late never overrides a newer stated value, and a newer one always does.
 */
function mergedIntentFromSignals(ctx: AppContext, leadId: string): AutomotiveIntent {
  const table = ctx.db.table('lead_signals');
  const rows = ctx.db.all('SELECT * FROM lead_signals WHERE lead_id = ? ORDER BY rowid ASC', leadId).map((r) => table.decode(r));
  if (rows.length === 0) return {};
  const creatingId = rows[0].id;
  return rows
    .map((signal, index) => ({ signal, index, at: Date.parse(signal.signal_at) }))
    .filter(({ signal }) => signal.is_purchase_signal || signal.id === creatingId)
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .reduce<AutomotiveIntent>((acc, { signal }) => mergeIntents(acc, signal.intent), {});
}

/** `verified_local_user` evidence only holds for a dealer in the IP province it was verified against. */
function localEvidenceHolds(evidence: Evidence, dealerProvince: string): boolean {
  if (evidence.code !== 'verified_local_user') return true;
  const ipProvince = provinceOfIp(evidence.quote ?? null);
  return ipProvince !== null && ipProvince === (provinceOfIp(dealerProvince) ?? dealerProvince);
}

/** Highest stored signal_score among purchase signals (ties → most recent); falls back to all signals. */
export function selectPrimarySignal(signals: readonly LeadSignal[]): LeadSignal | null {
  const purchase = signals.filter((s) => s.is_purchase_signal);
  const pool = purchase.length > 0 ? purchase : signals;
  let best: LeadSignal | null = null;
  for (const s of pool) {
    if (
      !best ||
      s.signal_score > best.signal_score ||
      (s.signal_score === best.signal_score && Date.parse(s.signal_at) > Date.parse(best.signal_at))
    )
      best = s;
  }
  return best;
}

/** Evidence codes ordered by how much they tell a salesperson (lower = shown first). */
const EVIDENCE_PRIORITY: Readonly<Record<string, number>> = {
  purchase_commitment: 0,
  inventory: 1,
  color_trim_availability: 1,
  landing_price: 1,
  test_drive: 1,
  dealer_location: 1,
  price: 2,
  discount: 2,
  finance: 2,
  lease: 2,
  trade_in: 2,
  specified_trim: 3,
  specified_color: 3,
  stated_location: 3,
  purchase_timeframe: 3,
  stated_model: 4,
  model_from_trim: 4,
  budget: 4,
  competing_model: 5,
  comparison: 5,
  verified_local_user: 5,
};

function topEvidenceLabels(evidence: readonly Evidence[], limit = 3): string[] {
  const ranked = evidence
    .map((e, i) => ({ e, i, p: EVIDENCE_PRIORITY[e.code] ?? 6 }))
    .filter((x) => typeof x.e.label === 'string' && x.e.label.trim() !== '')
    .sort((a, b) => a.p - b.p || a.i - b.i);
  const out: string[] = [];
  for (const { e } of ranked) {
    const label = e.label.trim();
    if (!out.includes(label)) out.push(label);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * What this lead is worth: the price of the trim they asked about, from the store's own line-up (车型库). A trim that
 * was archived is not in the line-up any more, so it never sets a lead's value — the model's live entry trim does.
 */
function estimateValue(ctx: AppContext, groupId: string, intent: AutomotiveIntent, fallback: number): number {
  if (!intent.model) return fallback;
  const vehicle =
    resolveVehicle(ctx, groupId, { brand: intent.brand, model: intent.model, trim: intent.trim }) ??
    (intent.trim ? resolveVehicle(ctx, groupId, { brand: intent.brand, model: intent.model }) : null);
  return vehicle ? (vehicle.current_price ?? vehicle.msrp) : fallback;
}

interface DealerMatch {
  evaluated_dealer_id: string;
  evaluated_signal_score: number;
  lead_dealer_id: string;
  previous_lead_score: number;
  moved: boolean;
  reason: string;
}

type TxOutcome =
  | { kind: 'duplicate'; lead: Lead }
  | {
      kind: 'stored';
      lead: Lead;
      previous: Lead | null;
      signal: LeadSignal;
      signalEvidence: Evidence[];
      dealerMatch: DealerMatch | null;
    };

// ─────────────────────────────────────────────────────────────────────────────
// Upsert
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the identity to the group's single lead, store the signal (idempotently) and merge it into the lead in
 * one transaction; then re-score, pick the primary signal, advance CANDIDATE / QUALIFIED (never demote, never for
 * suppressed users or non-purchase signals), record decisions and refresh the next action.
 */
export function upsertLeadFromSignal(ctx: AppContext, input: UpsertLeadInput): UpsertLeadResult {
  const req = upsertLeadInputValidator(input, 'input');
  const { identity } = req;
  const detection = req.signal.detection;
  const userId = identity.platform_user_id;
  const dealer = getDealer(ctx, req.dealer_id);
  const groupId = dealer.group_id;

  const signalAt = resolveSignalTime(req.signal.signal_at, dealer.settings?.timezone || DEFAULT_TZ, 'input.signal.signal_at');
  if (Date.parse(signalAt) > ctx.clock.now().getTime() + SIGNAL_FUTURE_TOLERANCE_MS)
    throw new ValidationError('input.signal.signal_at', `signal time ${signalAt} lies in the future (now ${ctx.clock.iso()})`);

  const managed = ctx.db
    .table('xhs_accounts')
    .queryOne('group_id = ? AND (platform_account_id = ? OR platform_user_id = ?)', [groupId, userId, userId]);
  if (managed)
    throw new PolicyError('managed_account_identity', 'identity belongs to a managed Xiaohongshu account of this dealer group and can never be a lead', {
      platform_user_id: userId,
      account_id: managed.id,
    });
  const signal: SignalInput = { ...resolveSourceRows(ctx, req.signal, userId), signal_at: signalAt };

  const purchase = isPurchaseDetection(detection);
  // §10.2 actor classification and §10.1 provenance, persisted for every signal path
  const actorType: ActorType = detection.actor_type ?? classifyActor(detection).actor_type;
  const knownMode = (mode: DataMode | null | undefined): DataMode | null => (mode && mode !== 'unknown' ? mode : null);
  const providerMode: DataMode = ctx.xhs.mode === 'live' || ctx.xhs.mode === 'simulation' ? ctx.xhs.mode : 'unknown';
  const signalMode: DataMode =
    knownMode(req.signal.data_mode) ??
    knownMode(signal.public_comment_id ? ctx.db.table('public_comments').get(signal.public_comment_id)?.data_mode : null) ??
    knownMode(signal.public_post_id ? ctx.db.table('public_posts').get(signal.public_post_id)?.data_mode : null) ??
    (signal.source_type === 'import' ? 'import' : signal.source_type === 'reply' ? 'manual' : signal.source_type === 'profile' ? providerMode : 'unknown');
  const now = ctx.clock.iso();
  const profiles = new Map<string, { profile: DealerProfile; config: ScoringConfig }>();
  const scoringFor = (dealerId: string) => {
    let entry = profiles.get(dealerId);
    if (!entry) {
      entry = { profile: buildDealerProfile(ctx, dealerId), config: getScoringConfig(ctx, dealerId) };
      profiles.set(dealerId, entry);
    }
    return entry;
  };
  scoringFor(dealer.id);

  const outcome = ctx.db.tx((): TxOutcome => {
    const leads = ctx.db.table('leads');
    const existing = findLeadByIdentity(ctx, groupId, userId);
    if (!existing && !purchase && !NON_PURCHASE_CREATING_SOURCES.includes(signal.source_type))
      throw new PolicyError('not_a_purchase_signal', 'a non-purchase signal cannot create a lead (only reply / import sources may)', {
        platform_user_id: userId,
        source_type: signal.source_type,
        reason: nonPurchaseReason(detection),
      });

    const lookup = findExistingSignal(ctx, existing, groupId, signal);
    if (existing && lookup.duplicate) return { kind: 'duplicate', lead: existing };

    const suppression: ContactSuppression | null = isSuppressed(ctx, userId, PLATFORM);
    let lead: Lead;
    const created = !existing;
    if (!existing) {
      lead = leads.insert({
        id: newId('lead'),
        group_id: groupId,
        dealer_id: dealer.id,
        platform: PLATFORM,
        platform_user_id: userId,
        username: identity.username.trim() || userId,
        profile_url: identity.profile_url?.trim() || null,
        avatar_url: identity.avatar_url?.trim() || null,
        stage: 'DISCOVERED',
        score: 0,
        tier: 'none',
        intent: {},
        evidence: [],
        primary_signal_id: null,
        signal_count: 0,
        first_seen_at: signal.signal_at,
        last_signal_at: signal.signal_at,
        suppressed: suppression !== null,
        suppression_reason: suppression?.reason ?? null,
        contact: {},
        lost_reason: null,
        estimated_value: 0,
        attributed_post_id: req.attributed_post_id ?? null,
        attributed_query_id: signal.query_id ?? null,
        next_action: null,
        created_at: now,
        updated_at: now,
      });
      ctx.db.table('lead_stage_transitions').insert({
        id: newId('trn'),
        lead_id: lead.id,
        from_stage: null,
        to_stage: 'DISCOVERED',
        reason: `首次发现${SOURCE_LABELS[signal.source_type]}信号`,
        actor: ACTOR,
        at: now,
      });
      ctx.audit.event({
        actor: ACTOR,
        action: 'lead.created',
        entity_type: 'lead',
        entity_id: lead.id,
        details: {
          group_id: groupId,
          dealer_id: dealer.id,
          platform: PLATFORM,
          platform_user_id: userId,
          username: lead.username,
          stage: 'DISCOVERED',
          source_type: signal.source_type,
          is_purchase_signal: detection.is_purchase_signal,
          suppressed: lead.suppressed,
          suppression_id: suppression?.id ?? null,
        },
      });
    } else {
      lead = existing;
      if (suppression && !lead.suppressed) {
        lead = leads.update(lead.id, { suppressed: true, suppression_reason: suppression.reason });
        ctx.audit.event({
          actor: ACTOR,
          action: 'lead.suppressed',
          entity_type: 'lead',
          entity_id: lead.id,
          details: { suppression_id: suppression.id, reason: suppression.reason, detected_by: SKILL },
        });
      }
    }
    const previous = created ? null : lead;

    // ── signal score & group-level dealer matching (§5.3) ───────────────────────
    const scoreFor = (dealerId: string) => {
      const { profile, config } = scoringFor(dealerId);
      const authenticity = authenticityFromEvidence(lead.evidence.filter((e) => localEvidenceHolds(e, profile.province)));
      return scoreSignal({ detection, signal_at: signal.signal_at, now, dealer: profile, authenticity }, config).score;
    };
    const evaluatedScore = scoreFor(dealer.id);
    let dealerMatch: DealerMatch | null = null;
    let signalScore = evaluatedScore;
    if (!created && lead.dealer_id !== dealer.id) {
      const active = ctx.db.table('lead_assignments').findOne({ lead_id: lead.id, active: true });
      let reason: string;
      if (!purchase) reason = 'not_a_purchase_signal';
      else if (TERMINAL.includes(lead.stage)) reason = `terminal_stage:${lead.stage}`;
      else if (active) reason = 'active_assignment';
      else if (!(evaluatedScore > lead.score)) reason = 'score_not_higher';
      else reason = 'higher_score_unassigned';
      const moved = reason === 'higher_score_unassigned';
      dealerMatch = {
        evaluated_dealer_id: dealer.id,
        evaluated_signal_score: evaluatedScore,
        lead_dealer_id: lead.dealer_id,
        previous_lead_score: lead.score,
        moved,
        reason,
      };
      if (!moved) signalScore = scoreFor(lead.dealer_id);
    }

    // ── store the signal ────────────────────────────────────────────────────────
    const signalId = newId('sig');
    const stored = ctx.db.table('lead_signals').insert({
      id: signalId,
      lead_id: lead.id,
      source_type: signal.source_type,
      public_post_id: signal.public_post_id ?? null,
      public_comment_id: lookup.commentShared ? null : (signal.public_comment_id ?? null),
      post_title: signal.post_title ?? null,
      content: signal.content,
      signal_at: signal.signal_at,
      search_run_id: signal.search_run_id ?? null,
      query_id: signal.query_id ?? null,
      intent: detection.intent,
      signal_score: signalScore,
      evidence: detection.evidence,
      engine: detection.engine,
      is_purchase_signal: detection.is_purchase_signal,
      strength: detection.strength,
      transaction_questions: detection.transaction_questions,
      author_role: detection.author_role ?? null,
      actor_type: actorType,
      created_at: now,
    });

    // ── merge into the lead ─────────────────────────────────────────────────────
    const signalEvidence = detection.evidence.map((e) => ({ ...e, source_ref: signalId }));
    const intent = created || purchase ? mergedIntentFromSignals(ctx, lead.id) : lead.intent;

    let baseEvidence = lead.evidence;
    let removedEvidence: string[] = [];
    if (dealerMatch?.moved) {
      baseEvidence = lead.evidence.filter((e) => localEvidenceHolds(e, dealer.province));
      removedEvidence = [...new Set(lead.evidence.filter((e) => !baseEvidence.includes(e)).map((e) => e.code))];
    }

    const patch: Partial<Lead> = {
      intent,
      evidence: dedupeEvidence([...baseEvidence, ...signalEvidence]),
      signal_count: ctx.db.table('lead_signals').count({ lead_id: lead.id }),
      first_seen_at: created ? signal.signal_at : earlier(lead.first_seen_at, signal.signal_at),
      last_signal_at: created ? signal.signal_at : later(lead.last_signal_at, signal.signal_at),
      estimated_value: estimateValue(ctx, groupId, intent, lead.estimated_value),
      attributed_post_id: lead.attributed_post_id ?? req.attributed_post_id ?? null,
      attributed_query_id: lead.attributed_query_id ?? signal.query_id ?? null,
    };
    // §10.2: the person is a BUYER once any buyer signal exists (industry evidence → DEALER_OR_SALES);
    // §10.1: the lead becomes 'live' with the first live signal and is never downgraded afterwards.
    const signalActors = ctx.db
      .table('lead_signals')
      .findMany({ lead_id: lead.id }, { orderBy: 'signal_at ASC, created_at ASC' })
      .map((s) => s.actor_type ?? null);
    patch.actor_type = aggregateActorType(signalActors, { industry_account: (patch.evidence ?? []).some((e) => e.code === 'industry_account') });
    const currentMode: DataMode = lead.data_mode ?? 'unknown';
    patch.data_mode = currentMode === 'live' || signalMode === 'live' ? 'live' : currentMode === 'unknown' ? signalMode : currentMode;
    const username = identity.username.trim();
    if (username && username !== lead.username) patch.username = username;
    const profileUrl = identity.profile_url?.trim();
    if (profileUrl && profileUrl !== lead.profile_url) patch.profile_url = profileUrl;
    const avatar = identity.avatar_url?.trim();
    if (avatar && avatar !== lead.avatar_url) patch.avatar_url = avatar;
    if (dealerMatch?.moved) patch.dealer_id = dealer.id;
    lead = leads.update(lead.id, patch);

    ctx.audit.event({
      actor: ACTOR,
      action: 'lead.signal_added',
      entity_type: 'lead',
      entity_id: lead.id,
      details: {
        signal_id: stored.id,
        source_type: stored.source_type,
        public_post_id: stored.public_post_id,
        public_comment_id: stored.public_comment_id,
        comment_shared_with_other_group: lookup.commentShared,
        is_purchase_signal: stored.is_purchase_signal,
        non_purchase_reason: nonPurchaseReason(detection),
        signal_score: stored.signal_score,
        signal_count: lead.signal_count,
      },
    });
    if (dealerMatch?.moved) {
      ctx.audit.event({
        actor: ACTOR,
        action: 'lead.dealer_rerouted',
        entity_type: 'lead',
        entity_id: lead.id,
        details: {
          from_dealer_id: dealerMatch.lead_dealer_id,
          to_dealer_id: dealer.id,
          signal_id: stored.id,
          signal_score: evaluatedScore,
          previous_lead_score: dealerMatch.previous_lead_score,
          removed_evidence: removedEvidence,
          reason: '新信号在该门店得分更高且线索尚未分配账号（集团内门店匹配）',
        },
      });
    }
    return { kind: 'stored', lead, previous, signal: stored, signalEvidence, dealerMatch };
  });

  if (outcome.kind === 'duplicate') {
    return {
      lead: outcome.lead,
      signal: null,
      created: false,
      merged: false,
      stage_changes: [],
      duplicate: true,
      dealer_rerouted: false,
    };
  }

  const created = outcome.previous === null;
  const leadsTable = ctx.db.table('leads');
  const leadId = outcome.lead.id;

  // Non-purchase signals on an existing lead are history only: they never re-score (never raise) the lead.
  let scoreRow: LeadScore | null = null;
  if (created || purchase) scoreRow = scoreLead(ctx, leadId);

  const primary = selectPrimarySignal(ctx.db.table('lead_signals').findMany({ lead_id: leadId }));
  let lead = leadsTable.require(leadId);
  if (primary && primary.id !== lead.primary_signal_id) lead = leadsTable.update(leadId, { primary_signal_id: primary.id });

  const stageChanges: LeadStage[] = [];
  if (scoreRow && purchase && !lead.suppressed) {
    const { thresholds, version } = getScoringConfig(ctx, lead.dealer_id);
    const labels = topEvidenceLabels(primary?.evidence ?? lead.evidence);
    const basis = labels.length > 0 ? `；依据：${labels.join('、')}` : '';
    const reached = tierIndex(scoreRow.tier);
    if (reached >= tierIndex('candidate')) {
      const res = transitionLead(ctx, leadId, 'CANDIDATE', {
        reason: `线索分 ${scoreRow.score}（${TIER_LABELS[scoreRow.tier]}）达到候选阈值 ${thresholds.candidate}${basis}`,
        actor: ACTOR,
      });
      if (res.changed) stageChanges.push('CANDIDATE');
    }
    if (reached >= tierIndex('qualified')) {
      const reason = `线索分 ${scoreRow.score}（${TIER_LABELS[scoreRow.tier]}）达到合格阈值 ${thresholds.qualified}${basis}`;
      const fromStage = leadsTable.require(leadId).stage;
      const res = transitionLead(ctx, leadId, 'QUALIFIED', { reason, actor: ACTOR });
      if (res.changed) {
        stageChanges.push('QUALIFIED');
        const qualified = res.lead;
        ctx.audit.decision({
          agent: LEAD_DEDUP_AGENT,
          skill: SKILL,
          decision_type: 'lead_qualification',
          subject_type: 'lead',
          subject_id: leadId,
          inputs: {
            dealer_id: qualified.dealer_id,
            trigger_signal_id: outcome.signal.id,
            primary_signal_id: primary?.id ?? null,
            primary_signal_content: primary?.content ?? null,
            signal_count: qualified.signal_count,
            thresholds,
            config_version: version,
            from_stage: fromStage,
          },
          evidence: qualified.evidence,
          output: {
            stage: 'QUALIFIED',
            score: scoreRow.score,
            tier: scoreRow.tier,
            lead_score_id: scoreRow.id,
            components: scoreRow.components,
            reason,
          },
          confidence: qualified.intent.confidence ?? detection.intent.confidence ?? 0.5,
          engine: 'rules',
        });
      }
    }
  }

  lead = refreshNextAction(ctx, leadId);

  if (!created && outcome.previous) {
    const before = outcome.previous;
    const s = outcome.signal;
    ctx.audit.decision({
      agent: LEAD_DEDUP_AGENT,
      skill: SKILL,
      decision_type: 'lead_dedup_merge',
      subject_type: 'lead',
      subject_id: leadId,
      inputs: {
        identity: { platform: PLATFORM, platform_user_id: userId, username: identity.username },
        evaluated_dealer_id: dealer.id,
        signal: {
          id: s.id,
          source_type: s.source_type,
          content: s.content,
          post_title: s.post_title,
          public_post_id: s.public_post_id,
          public_comment_id: s.public_comment_id,
          signal_at: s.signal_at,
          query_id: s.query_id,
          search_run_id: s.search_run_id,
          is_purchase_signal: s.is_purchase_signal,
          non_purchase_reason: nonPurchaseReason(detection),
          author_role: s.author_role,
          intent: s.intent,
        },
        previous: {
          dealer_id: before.dealer_id,
          stage: before.stage,
          intent: before.intent,
          signal_count: before.signal_count,
          score: before.score,
          tier: before.tier,
        },
      },
      evidence: outcome.signalEvidence,
      output: {
        matched_by: 'platform_user_id',
        merged_intent: lead.intent,
        intent_merged: purchase,
        signal_id: s.id,
        signal_score: s.signal_score,
        signal_count: lead.signal_count,
        score_before: before.score,
        score_after: lead.score,
        tier_before: before.tier,
        tier_after: lead.tier,
        rescored: scoreRow !== null,
        primary_signal_id: lead.primary_signal_id,
        dealer_match: outcome.dealerMatch,
        stage_changes: stageChanges,
      },
      confidence: 1,
      engine: 'rules',
    });
  }

  return {
    lead,
    signal: outcome.signal,
    created,
    merged: !created,
    stage_changes: stageChanges,
    duplicate: false,
    dealer_rerouted: outcome.dealerMatch?.moved === true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill definition
// ─────────────────────────────────────────────────────────────────────────────

export const skill = defineSkill<UpsertLeadInput, UpsertLeadResult>({
  name: 'lead-deduplication',
  category: 'acquisition',
  agent: 'lead-hunting-agent',
  description:
    '身份解析与线索去重：同一集团内同一小红书用户只保留一条线索，幂等存储每条公开信号并按时间顺序合并意向/证据/时间/归因，按线索分推进候选/合格阶段；拒绝托管账号身份与非购车信号（含车主/创作者/营销号）建线索，勿扰用户只存档不推进。',
  input: upsertLeadInputValidator,
  run: (ctx, input) => upsertLeadFromSignal(ctx, input),
  validateOutput(output) {
    if (!output?.lead?.id) throw new Error('lead-deduplication: result must contain the lead');
    if (output.signal && output.signal.lead_id !== output.lead.id)
      throw new Error('lead-deduplication: stored signal must belong to the returned lead');
    if (output.duplicate && output.signal !== null) throw new Error('lead-deduplication: a duplicate must not return a new signal');
  },
});
