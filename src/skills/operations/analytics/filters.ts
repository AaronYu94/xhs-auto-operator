/**
 * Filter normalization, reporting periods and SQL scope fragments shared by every analytics view.
 * All fragments are parameterized (no user input is ever interpolated into SQL).
 */
import type { AppContext } from '../../../app/context.ts';
import { NotFoundError, ValidationError } from '../../../core/errors.ts';
import { DEFAULT_TZ, addDaysToKey, localDateKey, zonedTimeToUtc } from '../../../core/time.ts';
import {
  LEAD_STAGES,
  SIGNAL_SOURCE_TYPES,
  type LeadStage,
  type SignalSourceType,
} from '../../../core/types.ts';
import type { SqlParam } from '../../../db/database.ts';
import {
  CITY_ALIASES,
  CITY_PROVINCE,
  PROVINCES,
  getBrandInfo,
  resolveModelName,
} from '../../../domain/automotive-lexicon.ts';
import { STAGE_INDEX } from '../crm/index.ts';
import { getDealer } from '../dealer-brain/index.ts';
import type { AnalyticsFilters, AnalyticsPeriod } from './types.ts';

export interface SqlFragment {
  sql: string;
  params: SqlParam[];
}

/** Location filter resolved against the lexicon: `values` match intent.location, `province` matches intent.province. */
export interface LocationFilter {
  raw: string;
  /** normalized name compared with intent.province / search_queries.location */
  name: string;
  /** name plus every known city of that province (when `name` is a province) */
  values: string[];
}

export interface NormalizedFilters {
  dealer_id?: string;
  account_id?: string;
  /** canonical brand ('宝马' → 'BMW') */
  brand?: string;
  /** canonical model ('3系' → '3 Series') */
  model?: string;
  location?: LocationFilter;
  /** explicit bounds only (normalized UTC ISO); undefined when not given */
  from?: string;
  to?: string;
  source_type?: SignalSourceType;
  stage?: LeadStage;
  /** dealer for dealer-level data: dealer_id, else the filtered account's dealer, else null (all dealers) */
  scope_dealer_id: string | null;
  timezone: string;
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
const ADMIN_SUFFIX_RE = /(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|省|市)$/;

function optionalText(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationError(path, `expected string, got ${typeof value}`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function optionalLiteral<T extends string>(value: unknown, allowed: readonly T[], path: string): T | undefined {
  const text = optionalText(value, path);
  if (text === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(text))
    throw new ValidationError(path, `expected one of ${allowed.join('|')}, got ${JSON.stringify(text)}`);
  return text as T;
}

function localMidnight(dateKey: string, tz: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  return zonedTimeToUtc(y, m, d, 0, 0, tz).toISOString();
}

/** 'YYYY-MM-DD' (dealer-local; `to` inclusive) or ISO-8601 datetime with zone → UTC ISO. */
function parseBound(value: unknown, tz: string, kind: 'from' | 'to'): string | undefined {
  const path = `filters.${kind}`;
  const text = optionalText(value, path);
  if (text === undefined) return undefined;
  const dateOnly = DATE_ONLY_RE.exec(text);
  if (dateOnly) {
    const [y, m, d] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d)
      throw new ValidationError(path, `invalid date ${JSON.stringify(text)}`);
    return localMidnight(kind === 'from' ? text : addDaysToKey(text, 1), tz);
  }
  if (!DATETIME_RE.test(text)) throw new ValidationError(path, 'expected YYYY-MM-DD or an ISO-8601 datetime with timezone');
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new ValidationError(path, `invalid datetime ${JSON.stringify(text)}`);
  return new Date(ms).toISOString();
}

function normalizeLocation(raw: string): LocationFilter {
  let name = CITY_ALIASES[raw] ?? raw;
  const stripped = name.replace(ADMIN_SUFFIX_RE, '');
  if (stripped !== name && stripped !== '' && (CITY_PROVINCE[stripped] !== undefined || PROVINCES.includes(stripped))) name = stripped;
  const values = new Set<string>([name]);
  if (PROVINCES.includes(name)) {
    for (const [city, province] of Object.entries(CITY_PROVINCE)) if (province === name) values.add(city);
  }
  return { raw, name, values: [...values] };
}

/**
 * Validate and canonicalize filters. Unknown dealer/account ids → NotFoundError; malformed values → ValidationError.
 * Empty strings are treated as "not set" (query-string friendly).
 */
export function normalizeFilters(ctx: AppContext, f: AnalyticsFilters | null | undefined): NormalizedFilters {
  if (f !== undefined && f !== null && (typeof f !== 'object' || Array.isArray(f)))
    throw new ValidationError('filters', 'expected object');
  const src = (f ?? {}) as Record<string, unknown>;

  const dealerId = optionalText(src.dealer_id, 'filters.dealer_id');
  const accountId = optionalText(src.account_id, 'filters.account_id');
  let timezone = DEFAULT_TZ;
  let scopeDealerId: string | null = null;
  if (dealerId !== undefined) {
    const dealer = getDealer(ctx, dealerId);
    timezone = dealer.settings.timezone || DEFAULT_TZ;
    scopeDealerId = dealer.id;
  }
  if (accountId !== undefined) {
    const account = ctx.db.table('xhs_accounts').get(accountId);
    if (!account) throw new NotFoundError('xhs_account', accountId);
    // Mixing two scopes would report dealer-level data (search runs, runs) for one store and zero leads for the other.
    if (scopeDealerId !== null && account.dealer_id !== scopeDealerId)
      throw new ValidationError('filters.account_id', 'account does not belong to filters.dealer_id');
    if (scopeDealerId === null) {
      const dealer = getDealer(ctx, account.dealer_id);
      timezone = dealer.settings.timezone || DEFAULT_TZ;
      scopeDealerId = dealer.id;
    }
  }

  const brandRaw = optionalText(src.brand, 'filters.brand');
  const modelRaw = optionalText(src.model, 'filters.model');
  const locationRaw = optionalText(src.location, 'filters.location');

  const out: NormalizedFilters = { scope_dealer_id: scopeDealerId, timezone };
  if (dealerId !== undefined) out.dealer_id = dealerId;
  if (accountId !== undefined) out.account_id = accountId;
  // NFKC first so full-width input (ＢＭＷ, Ｍ７６０Ｌｉ) also matches names outside the lexicon.
  if (brandRaw !== undefined) {
    const brand = brandRaw.normalize('NFKC').trim();
    out.brand = getBrandInfo(brand)?.brand ?? brand;
  }
  if (modelRaw !== undefined) {
    const model = modelRaw.normalize('NFKC').trim();
    out.model = resolveModelName(model) ?? model;
  }
  if (locationRaw !== undefined) out.location = normalizeLocation(locationRaw.normalize('NFKC').trim());
  const from = parseBound(src.from, timezone, 'from');
  const to = parseBound(src.to, timezone, 'to');
  if (from !== undefined) out.from = from;
  if (to !== undefined) out.to = to;
  if (from !== undefined && to !== undefined && from >= to) throw new ValidationError('filters.to', 'must be after filters.from');
  const sourceType = optionalLiteral(src.source_type, SIGNAL_SOURCE_TYPES, 'filters.source_type');
  if (sourceType !== undefined) out.source_type = sourceType;
  const stage = optionalLiteral(src.stage, LEAD_STAGES, 'filters.stage');
  if (stage !== undefined) out.stage = stage;
  return out;
}

/** Dealer-local calendar day containing `at`, as a half-open UTC window. */
export function localDayWindow(at: Date, tz: string): { from: string; to: string; date: string } {
  const date = localDateKey(at, tz);
  return { date, from: localMidnight(date, tz), to: localMidnight(addDaysToKey(date, 1), tz) };
}

/**
 * Reporting window. Default: dealer-local today `[00:00, next 00:00)`. `from` only → until the end of today
 * (or one day when `from` is later); `to` only → the local day that ends at `to`.
 */
export function periodFor(n: NormalizedFilters, now: Date): AnalyticsPeriod {
  const today = localDayWindow(now, n.timezone);
  let from = n.from;
  let to = n.to;
  if (from === undefined && to === undefined) {
    from = today.from;
    to = today.to;
  } else if (to === undefined) {
    to = (from as string) < today.to ? today.to : localDayWindow(new Date(from as string), n.timezone).to;
    if ((from as string) >= to) to = new Date(Date.parse(from as string) + 86_400_000).toISOString();
  } else if (from === undefined) {
    from = localDayWindow(new Date(Date.parse(to) - 1), n.timezone).from;
  }
  if ((from as string) >= (to as string)) throw new ValidationError('filters.to', 'must be after filters.from');
  return {
    from: from as string,
    to: to as string,
    timezone: n.timezone,
    is_today: from === today.from && to === today.to,
  };
}

/** Local date keys (inclusive) covered by a period — used for `posts.slot_date`. */
export function periodDateKeys(period: AnalyticsPeriod): { first: string; last: string } {
  return {
    first: localDateKey(new Date(period.from), period.timezone),
    last: localDateKey(new Date(Date.parse(period.to) - 1), period.timezone),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL fragments
// ─────────────────────────────────────────────────────────────────────────────

export function joinAnd(parts: SqlFragment[]): SqlFragment {
  const used = parts.filter((p) => p.sql !== '');
  if (used.length === 0) return { sql: '1 = 1', params: [] };
  return { sql: used.map((p) => `(${p.sql})`).join(' AND '), params: used.flatMap((p) => p.params) };
}

export const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/**
 * Lead filters applied to a `leads` alias: dealer, account (active assignment), brand, model, location,
 * source_type, stage. Period bounds are NOT included (each view decides which timestamp they bound).
 */
export function leadScope(n: NormalizedFilters, alias = 'l'): SqlFragment {
  const parts: SqlFragment[] = [];
  if (n.dealer_id !== undefined) parts.push({ sql: `${alias}.dealer_id = ?`, params: [n.dealer_id] });
  if (n.account_id !== undefined)
    parts.push({
      sql: `EXISTS (SELECT 1 FROM lead_assignments fa WHERE fa.lead_id = ${alias}.id AND fa.active = 1 AND fa.account_id = ?)`,
      params: [n.account_id],
    });
  if (n.brand !== undefined)
    parts.push({ sql: `LOWER(json_extract(${alias}.intent, '$.brand')) = LOWER(?)`, params: [n.brand] });
  if (n.model !== undefined)
    parts.push({ sql: `LOWER(json_extract(${alias}.intent, '$.model')) = LOWER(?)`, params: [n.model] });
  if (n.location !== undefined)
    parts.push({
      sql: `json_extract(${alias}.intent, '$.location') IN (${placeholders(n.location.values.length)})
            OR json_extract(${alias}.intent, '$.province') = ?`,
      params: [...n.location.values, n.location.name],
    });
  if (n.source_type !== undefined)
    parts.push({
      sql: `EXISTS (SELECT 1 FROM lead_signals fs WHERE fs.lead_id = ${alias}.id AND fs.source_type = ?)`,
      params: [n.source_type],
    });
  if (n.stage !== undefined) parts.push({ sql: `${alias}.stage = ?`, params: [n.stage] });
  return joinAnd(parts);
}

/** Post filters (dealer, account, model). Brand/location/source/stage do not apply to our own posts. */
export function postScope(n: NormalizedFilters, alias = 'p'): SqlFragment {
  const parts: SqlFragment[] = [];
  if (n.dealer_id !== undefined) parts.push({ sql: `${alias}.dealer_id = ?`, params: [n.dealer_id] });
  if (n.account_id !== undefined) parts.push({ sql: `${alias}.account_id = ?`, params: [n.account_id] });
  if (n.model !== undefined) parts.push({ sql: `LOWER(${alias}.model) = LOWER(?)`, params: [n.model] });
  return joinAnd(parts);
}

/** Search-run filters: scope dealer (dealer or the account's dealer) plus the query's brand/model/location. */
export function searchRunScope(n: NormalizedFilters, runAlias = 'sr', queryAlias = 'q'): SqlFragment {
  const parts: SqlFragment[] = [];
  if (n.scope_dealer_id !== null) parts.push({ sql: `${runAlias}.dealer_id = ?`, params: [n.scope_dealer_id] });
  if (n.brand !== undefined) parts.push({ sql: `LOWER(${queryAlias}.brand) = LOWER(?)`, params: [n.brand] });
  if (n.model !== undefined) parts.push({ sql: `LOWER(${queryAlias}.model) = LOWER(?)`, params: [n.model] });
  if (n.location !== undefined)
    parts.push({ sql: `${queryAlias}.location IN (${placeholders(n.location.values.length)})`, params: [...n.location.values] });
  return joinAnd(parts);
}

/** SQL expression mapping a stage column to its funnel depth (unknown → -1). */
export function stageIndexSql(col: string): string {
  return `(CASE ${col} ${LEAD_STAGES.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ')} ELSE -1 END)`;
}

/**
 * A transition row (alias) that ENTERS `stage` or deeper: WON/LOST only by an explicit move to them; any other stage
 * when a non-terminal move lands at that depth or deeper from a shallower stage (a reopened LOST lead re-enters).
 * Forward jumps (e.g. DISCOVERED → QUALIFIED) therefore count for every stage they cross.
 */
export function enteredStageSql(stage: LeadStage, alias = 't'): string {
  if (stage === 'WON' || stage === 'LOST') return `${alias}.to_stage = '${stage}'`;
  const i = STAGE_INDEX[stage];
  return `(${alias}.to_stage NOT IN ('WON', 'LOST') AND ${stageIndexSql(`${alias}.to_stage`)} >= ${i}
    AND (${alias}.from_stage IS NULL OR ${alias}.from_stage = 'LOST' OR ${stageIndexSql(`${alias}.from_stage`)} < ${i}))`;
}

/** A stage column currently at `stage` or deeper, LOST excluded from the chain (WON counts as deepest). */
export function reachedStageSql(stage: LeadStage, col: string): string {
  if (stage === 'LOST') return `${col} = 'LOST'`;
  return `(${col} <> 'LOST' AND ${stageIndexSql(col)} >= ${STAGE_INDEX[stage]})`;
}

/** Finite number from a SQL aggregate row (null/undefined/NaN → 0). */
export function num(row: Record<string, unknown> | undefined, key: string): number {
  const value = Number(row?.[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/** Run a query per chunk of ids (keeps IN lists well below SQLite's variable limit). */
export function chunked<T>(ids: readonly string[], size: number, run: (chunk: string[]) => T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...run(ids.slice(i, i + size)));
  return out;
}

/** Console link with the dealer scope preserved. */
export function consoleHref(path: string, dealerId: string | null): string {
  if (!dealerId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}dealer_id=${encodeURIComponent(dealerId)}`;
}
