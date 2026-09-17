/**
 * Search intelligence (spec §19): per-query effectiveness from search runs and lead attribution, and the feedback
 * loop that re-prioritizes, derives, pauses and retires queries so the Lead Hunter's search strategy improves with
 * discovered lead quality.
 */
import type { AppContext } from '../../../app/context.ts';
import { ValidationError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import { clamp, round } from '../../../core/text.ts';
import { DEFAULT_TZ, addDaysToKey, zonedTimeToUtc } from '../../../core/time.ts';
import { LEAD_STAGES } from '../../../core/types.ts';
import type { Dealer, Evidence, LeadStage, QueryClass, SearchQuery } from '../../../core/types.ts';
import { findLocation } from '../../../domain/automotive-lexicon.ts';
import { findInventory, getDealer } from '../../operations/dealer-brain/index.ts';
import { QUERY_CLASS_PRIORS, queryKey, trimAlias } from './plan.ts';

export const QUERY_AGENT = 'lead-hunting-agent';
export const QUERY_SKILL = 'automotive-query-generation';
export const QUERY_ACTOR = `agent:${QUERY_AGENT}`;

/** Feedback-loop calibration. */
export const FEEDBACK = Object.freeze({
  /** smoothed_density = (qualified + smoothing_qualified) / (users_evaluated + smoothing_users) */
  smoothing_qualified: 1,
  smoothing_users: 20,
  prior_weight: 0.35,
  density_weight: 0.65,
  min_priority: 0.05,
  max_priority: 1,
  derive_min_smoothed_density: 0.08,
  derive_min_runs: 1,
  max_derived_per_call: 5,
  max_derived_per_parent: 3,
  pause_min_runs: 3,
  retire_min_runs: 5,
  retire_max_smoothed_density: 0.01,
  /** at least one never-run query in every block of this many selected slots (when available) */
  exploration_slot_every: 4,
});

export interface QueryEffectiveness {
  query: SearchQuery;
  /** completed (SUCCEEDED) search runs in the window */
  runs: number;
  posts_discovered: number;
  comments_scanned: number;
  users_evaluated: number;
  candidates: number;
  qualified: number;
  high_intent: number;
  /** qualified / max(1, users_evaluated) */
  lead_density: number;
  /** candidates / max(1, users_evaluated) */
  candidate_rate: number;
  /** attributed leads that reached APPOINTMENT or deeper (APPOINTMENT, VISITED, NEGOTIATING, WON) */
  appointments: number;
  /** attributed leads that reached WON */
  won: number;
  /** appointments / max(1, qualified) */
  conversion_rate: number;
  /** (qualified + 1) / (users_evaluated + 20) */
  smoothed_density: number;
  /** FAILED / UNAVAILABLE runs in the window (not counted in `runs`) */
  failed_runs: number;
  last_run_at: string | null;
}

export interface PriorityChange {
  query_id: string;
  text: string;
  query_class: QueryClass;
  before: number;
  after: number;
  runs: number;
  smoothed_density: number;
  /** smoothed_density relative to the best query; null for never-run queries */
  relative_density: number | null;
  basis: 'density' | 'exploration';
}

export interface EvolveResult {
  /** active queries whose priority actually changed */
  reprioritized: number;
  derived: SearchQuery[];
  retired: SearchQuery[];
  paused: SearchQuery[];
  /** active queries evaluated */
  evaluated: number;
  best_smoothed_density: number;
  changes: PriorityChange[];
}

export function smoothedDensity(qualified: number, usersEvaluated: number): number {
  return (qualified + FEEDBACK.smoothing_qualified) / (usersEvaluated + FEEDBACK.smoothing_users);
}

const pct = (x: number) => `${round(x * 100, 1)}%`;

const APPOINTMENT_REACHED: ReadonlySet<LeadStage> = new Set(
  LEAD_STAGES.filter((s, i) => i >= LEAD_STAGES.indexOf('APPOINTMENT') && s !== 'LOST'),
);
const WON_REACHED: ReadonlySet<LeadStage> = new Set<LeadStage>(['WON']);

// ─────────────────────────────────────────────────────────────────────────────
// Effectiveness
// ─────────────────────────────────────────────────────────────────────────────

/** Completed (SUCCEEDED) run counts per query of a dealer. FAILED / UNAVAILABLE runs never count as exploration. */
export function completedRunCounts(ctx: AppContext, dealerId: string): Map<string, number> {
  const rows = ctx.db.all<{ query_id: string; n: number }>(
    `SELECT query_id, COUNT(*) AS n FROM search_runs WHERE dealer_id = ? AND status = 'SUCCEEDED' GROUP BY query_id`,
    dealerId,
  );
  return new Map(rows.map((r) => [r.query_id, Number(r.n)]));
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;
const BOUND_HINT = 'expected YYYY-MM-DD (dealer-local day) or an ISO-8601 timestamp with timezone (Z / +08:00)';

function isCalendarDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Effectiveness window bound → UTC ISO (inclusive). 'YYYY-MM-DD' is a dealer-local calendar day: `from` starts at its
 * local 00:00, `to` ends at its last millisecond. Datetimes must carry an explicit zone so a window never depends on
 * the server's timezone; anything else (e.g. '2026-09-12 10:00', 'Sep 12 2026', '2026-02-30') is rejected.
 */
function parseBound(value: unknown, kind: 'from' | 'to', tz: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError(kind, BOUND_HINT);
  const text = value.trim();
  if (text === '') return null;
  const date = DATE_ONLY_RE.exec(text);
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    if (!isCalendarDate(y, m, d)) throw new ValidationError(kind, `invalid date ${JSON.stringify(value)}`);
    if (kind === 'from') return zonedTimeToUtc(y, m, d, 0, 0, tz).toISOString();
    const [ny, nm, nd] = addDaysToKey(text, 1).split('-').map(Number);
    return new Date(zonedTimeToUtc(ny, nm, nd, 0, 0, tz).getTime() - 1).toISOString();
  }
  const dt = DATETIME_RE.exec(text);
  if (
    !dt ||
    !isCalendarDate(Number(dt[1]), Number(dt[2]), Number(dt[3])) ||
    Number(dt[4]) > 23 ||
    Number(dt[5]) > 59 ||
    Number(dt[6] ?? 0) > 59
  ) {
    throw new ValidationError(kind, `${BOUND_HINT}, got ${JSON.stringify(value)}`);
  }
  const zoneRaw = dt[7];
  const zone = zoneRaw.toUpperCase() === 'Z' ? 'Z' : zoneRaw.replace(/^([+-]\d{2}):?(\d{2})$/, '$1:$2');
  const ms = Date.parse(`${text.slice(0, text.length - zoneRaw.length).toUpperCase()}${zone}`);
  if (Number.isNaN(ms)) throw new ValidationError(kind, `invalid timestamp ${JSON.stringify(value)}`);
  return new Date(ms).toISOString();
}

const inWindow = (at: string, from: string | null, to: string | null) => (!from || at >= from) && (!to || at <= to);

interface RunAggregate {
  query_id: string;
  runs: number;
  posts_discovered: number;
  comments_scanned: number;
  users_evaluated: number;
  candidates: number;
  qualified: number;
  high_intent: number;
  last_run_at: string | null;
}

function attributionByQuery(
  ctx: AppContext,
  dealerId: string,
  from: string | null,
  to: string | null,
): Map<string, { appointments: number; won: number }> {
  const leads = ctx.db.all<{ id: string; attributed_query_id: string; stage: LeadStage; updated_at: string }>(
    `SELECT id, attributed_query_id, stage, updated_at FROM leads
     WHERE attributed_query_id IN (SELECT id FROM search_queries WHERE dealer_id = ?)`,
    dealerId,
  );
  const out = new Map<string, { appointments: number; won: number }>();
  if (leads.length === 0) return out;
  const transitions = ctx.db.all<{ lead_id: string; to_stage: LeadStage; at: string }>(
    `SELECT t.lead_id, t.to_stage, t.at FROM lead_stage_transitions t JOIN leads l ON l.id = t.lead_id
     WHERE l.attributed_query_id IN (SELECT id FROM search_queries WHERE dealer_id = ?)`,
    dealerId,
  );
  const byLead = new Map<string, { to_stage: LeadStage; at: string }[]>();
  for (const t of transitions) {
    const list = byLead.get(t.lead_id) ?? [];
    list.push(t);
    byLead.set(t.lead_id, list);
  }
  for (const lead of leads) {
    const history = byLead.get(lead.id) ?? [];
    const reached = (stages: ReadonlySet<LeadStage>) =>
      history.length > 0
        ? history.some((t) => stages.has(t.to_stage) && inWindow(t.at, from, to))
        : // rows imported without any transition history: the current stage is the only record
          stages.has(lead.stage) && inWindow(lead.updated_at, from, to);
    const entry = out.get(lead.attributed_query_id) ?? { appointments: 0, won: 0 };
    if (reached(APPOINTMENT_REACHED)) entry.appointments++;
    if (reached(WON_REACHED)) entry.won++;
    out.set(lead.attributed_query_id, entry);
  }
  return out;
}

function compareEffectiveness(a: QueryEffectiveness, b: QueryEffectiveness): number {
  return (
    b.smoothed_density - a.smoothed_density ||
    b.qualified - a.qualified ||
    b.runs - a.runs ||
    b.query.priority - a.query.priority ||
    a.query.text.localeCompare(b.query.text) ||
    a.query.id.localeCompare(b.query.id)
  );
}

/**
 * Per-query effectiveness for every query of the dealer (all statuses; never-run queries included with zeros),
 * sorted by smoothed_density desc. `from`/`to` (inclusive ISO bounds) filter runs by `started_at` and attribution
 * by transition time.
 */
export function getQueryEffectiveness(
  ctx: AppContext,
  dealerId: string,
  opts: { from?: string; to?: string } = {},
): QueryEffectiveness[] {
  const dealer = getDealer(ctx, dealerId);
  const tz = dealer.settings.timezone || DEFAULT_TZ;
  const from = parseBound(opts?.from, 'from', tz);
  const to = parseBound(opts?.to, 'to', tz);
  if (from && to && from > to) throw new ValidationError('from', 'from must not be after to');

  const queries = ctx.db.table('search_queries').findMany({ dealer_id: dealerId }, { orderBy: 'created_at ASC' });
  if (queries.length === 0) return [];

  const clauses = ['dealer_id = ?'];
  const params: string[] = [dealerId];
  if (from) {
    clauses.push('started_at >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('started_at <= ?');
    params.push(to);
  }
  const where = clauses.join(' AND ');
  const runs = new Map(
    ctx.db
      .all<RunAggregate>(
        `SELECT query_id, COUNT(*) AS runs,
                COALESCE(SUM(posts_discovered), 0) AS posts_discovered, COALESCE(SUM(comments_scanned), 0) AS comments_scanned,
                COALESCE(SUM(users_evaluated), 0) AS users_evaluated, COALESCE(SUM(candidates), 0) AS candidates,
                COALESCE(SUM(qualified), 0) AS qualified, COALESCE(SUM(high_intent), 0) AS high_intent,
                MAX(started_at) AS last_run_at
         FROM search_runs WHERE ${where} AND status = 'SUCCEEDED' GROUP BY query_id`,
        ...params,
      )
      .map((r) => [r.query_id, r]),
  );
  const failed = new Map(
    ctx.db
      .all<{ query_id: string; n: number; last_run_at: string | null }>(
        `SELECT query_id, COUNT(*) AS n, MAX(started_at) AS last_run_at FROM search_runs
         WHERE ${where} AND status IN ('FAILED', 'UNAVAILABLE') GROUP BY query_id`,
        ...params,
      )
      .map((r) => [r.query_id, r]),
  );
  const attribution = attributionByQuery(ctx, dealerId, from, to);

  const rows = queries.map((query): QueryEffectiveness => {
    const r = runs.get(query.id);
    const f = failed.get(query.id);
    const n = (x: number | undefined) => Number(x ?? 0);
    const users = n(r?.users_evaluated);
    const candidates = n(r?.candidates);
    const qualified = n(r?.qualified);
    const attr = attribution.get(query.id) ?? { appointments: 0, won: 0 };
    const lastRun = [r?.last_run_at ?? null, f?.last_run_at ?? null].filter((x): x is string => !!x).sort().pop() ?? null;
    return {
      query,
      runs: n(r?.runs),
      posts_discovered: n(r?.posts_discovered),
      comments_scanned: n(r?.comments_scanned),
      users_evaluated: users,
      candidates,
      qualified,
      high_intent: n(r?.high_intent),
      lead_density: qualified / Math.max(1, users),
      candidate_rate: candidates / Math.max(1, users),
      appointments: attr.appointments,
      won: attr.won,
      conversion_rate: attr.appointments / Math.max(1, qualified),
      smoothed_density: smoothedDensity(qualified, users),
      failed_runs: n(f?.n),
      last_run_at: lastRun,
    };
  });
  return rows.sort(compareEffectiveness);
}

// ─────────────────────────────────────────────────────────────────────────────
// Feedback loop
// ─────────────────────────────────────────────────────────────────────────────

function classPrior(query: SearchQuery, byId: Map<string, SearchQuery>): number {
  let q: SearchQuery | undefined = query;
  for (let depth = 0; q && q.query_class === 'derived' && q.parent_query_id && depth < 10; depth++) {
    const parent = byId.get(q.parent_query_id);
    if (!parent) break;
    q = parent;
  }
  return QUERY_CLASS_PRIORS[(q ?? query).query_class];
}

interface ModelCatalog {
  /** names of the model as they appear in query texts (model_zh, canonical model) */
  labels: string[];
  /** queryKey of every catalog trim name and alias of the model, whatever its stock status ('35l', 'edrive40l', 'i340l') */
  trim_keys: string[];
  /** the dealer has in_stock or in_transit units */
  sellable: boolean;
  /** in-stock trim aliases, most units first */
  in_stock_aliases: string[];
}

function modelCatalogIndex(ctx: AppContext, dealer: Dealer): Map<string, ModelCatalog> {
  const out = new Map<string, ModelCatalog>();
  for (const veh of ctx.db.table('vehicles').findMany({ group_id: dealer.group_id }, { orderBy: 'msrp ASC, trim ASC' })) {
    const entry = out.get(veh.model) ?? { labels: [], trim_keys: [], sellable: false, in_stock_aliases: [] };
    for (const label of [veh.model_zh, veh.model]) if (label && !entry.labels.includes(label)) entry.labels.push(label);
    const modelKeys = new Set([queryKey(veh.model), queryKey(veh.model_zh)]);
    for (const name of [veh.trim, ...veh.aliases]) {
      const key = queryKey(name ?? '');
      if (key.length >= 2 && !modelKeys.has(key) && !entry.trim_keys.includes(key)) entry.trim_keys.push(key);
    }
    out.set(veh.model, entry);
  }
  const units = new Map<string, Map<string, number>>();
  for (const m of findInventory(ctx, dealer.id, { statuses: ['in_stock', 'in_transit'] })) {
    const entry = out.get(m.vehicle.model);
    if (!entry) continue;
    entry.sellable = true;
    if (m.inventory.status !== 'in_stock') continue;
    const aliases = units.get(m.vehicle.model) ?? new Map<string, number>();
    const alias = trimAlias(m.vehicle);
    aliases.set(alias, (aliases.get(alias) ?? 0) + m.inventory.quantity);
    units.set(m.vehicle.model, aliases);
  }
  for (const [model, aliases] of units) {
    const entry = out.get(model);
    if (entry) entry.in_stock_aliases = [...aliases.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([a]) => a);
  }
  return out;
}

const LATIN_OR_DIGIT = /[a-z0-9]/;

/**
 * Where the model is named in a query text — case- and width-insensitive ('x3', 'Ｘ３'), never inside a longer Latin
 * token ('X3' is not found in 'iX3', 'i3' not in 'i30'). Returns UTF-16 offsets into `text`.
 */
function findModelSpan(text: string, labels: readonly string[]): { start: number; end: number } | null {
  const folded = text.normalize('NFKC').toLowerCase();
  const hay = folded.length === text.length ? folded : text.toLowerCase();
  if (hay.length !== text.length) return null;
  for (const label of [...labels].sort((a, b) => b.length - a.length)) {
    const needle = label.normalize('NFKC').toLowerCase();
    if (!needle) continue;
    for (let idx = hay.indexOf(needle); idx >= 0; idx = hay.indexOf(needle, idx + 1)) {
      const before = idx > 0 ? hay[idx - 1] : '';
      const after = hay[idx + needle.length] ?? '';
      if (LATIN_OR_DIGIT.test(needle[0]) && LATIN_OR_DIGIT.test(before)) continue;
      if (LATIN_OR_DIGIT.test(needle[needle.length - 1]) && LATIN_OR_DIGIT.test(after)) continue;
      return { start: idx, end: idx + needle.length };
    }
  }
  return null;
}

interface Variant {
  text: string;
  label: string;
  location?: string;
}

/** Comparisons — 'i3 vs Model 3', unspaced 'i3vsModel 3', 'X3还是GLC', '3系对比C级' — never get variants. */
const COMPARISON_RE = /(?<![a-z])vs|(?<![a-z])pk(?![a-z])|还是|对比|比较|区别|二选一|选哪/iu;
/**
 * Questions and attribute asks ('i3值得买吗', 'i3续航多少', 'i3怎么样', '家用SUV推荐') are not noun phrases, so a transaction
 * suffix would produce unnatural text ('i3续航多少落地'). 几何 / 哪吒 are car brands, not question words.
 */
const QUESTION_RE = /吗|呢|？|\?|推荐|怎么|怎样|如何|多少|几(?!何)|哪(?!吒)|什么|咋|值不值|值得|是否|能不能|要不要|好不好|求/u;
const TRANSACTION_RE = /落地|现车|库存|优惠|价格|报价|多少钱|贷款|分期|首付|置换|租|补贴|便宜|折扣|降价/u;
const TRANSACTION_SUFFIXES = ['落地', '有现车吗', '优惠'] as const;

/**
 * Candidate variants of a high-density query, in preference order: dealer city prefix → in-stock trim alias →
 * transaction suffixes. Only natural search phrases are produced: nothing for comparisons; no city on texts that
 * already name a place; a trim only after the model name and only when no catalog trim (in stock or not) is named yet;
 * suffixes only on noun phrases without a question or transaction term; '有现车吗' only for sellable models.
 */
function deriveVariants(parent: SearchQuery, dealer: Dealer, catalog: Map<string, ModelCatalog>): Variant[] {
  const text = parent.text;
  const out: Variant[] = [];
  const comparison = COMPARISON_RE.test(text);
  const model = parent.model ? catalog.get(parent.model) : undefined;

  if (dealer.city && !comparison && !text.includes(dealer.city) && !findLocation(text)) {
    out.push({ text: `${dealer.city}${text}`, label: `补充本店城市「${dealer.city}」`, location: dealer.city });
  }

  if (model && model.in_stock_aliases.length > 0 && !comparison) {
    const key = queryKey(text);
    const hasTrim = model.trim_keys.some((k) => key.includes(k));
    const span = hasTrim ? null : findModelSpan(text, model.labels);
    if (span) {
      for (const alias of model.in_stock_aliases) {
        out.push({
          text: `${text.slice(0, span.end)} ${alias}${text.slice(span.end)}`.replace(/\s+/g, ' ').trim(),
          label: `补充现车配置「${alias}」`,
        });
      }
    }
  }

  const nounPhrase =
    !comparison && !QUESTION_RE.test(text) && !TRANSACTION_RE.test(text) && parent.query_class !== 'purchase_scenario';
  if (nounPhrase && (parent.model !== null || parent.location !== null)) {
    for (const suffix of TRANSACTION_SUFFIXES) {
      if (suffix === '有现车吗' && !model?.sellable) continue;
      if (parent.model === null && suffix !== '优惠') continue;
      out.push({ text: `${text}${suffix}`, label: `追加交易后缀「${suffix}」` });
    }
  }
  return out;
}

/**
 * Feedback loop (spec §19): re-prioritize active queries by relative smoothed lead density, retire / pause poor
 * queries, derive variants of the best ones, and record a `query_optimization` decision with before/after priorities.
 */
export function evolveQueries(ctx: AppContext, dealerId: string): EvolveResult {
  const dealer = getDealer(ctx, dealerId);

  return ctx.db.tx(() => {
    // Evaluate inside the (BEGIN IMMEDIATE) transaction: statistics, decision and writes share one snapshot, so a
    // query or run committed by another process just before this call is never duplicated or judged from stale rows.
    const effectiveness = getQueryEffectiveness(ctx, dealerId);
    const byId = new Map(effectiveness.map((e) => [e.query.id, e.query]));
    const best = effectiveness
      .filter((e) => e.runs >= 1 && e.query.status !== 'retired')
      .reduce((mx, e) => Math.max(mx, e.smoothed_density), 0);
    const catalog = modelCatalogIndex(ctx, dealer);
    const table = ctx.db.table('search_queries');
    const current = new Map<string, SearchQuery>();
    const changes: PriorityChange[] = [];
    let reprioritized = 0;

    for (const e of effectiveness) {
      let row = e.query;
      if (row.status === 'active') {
        const before = row.priority;
        let after = before;
        let relative: number | null = null;
        if (e.runs >= 1 && best > 0) {
          relative = e.smoothed_density / best;
          after = round(
            clamp(FEEDBACK.prior_weight * classPrior(row, byId) + FEEDBACK.density_weight * relative, FEEDBACK.min_priority, FEEDBACK.max_priority),
            4,
          );
        }
        if (Math.abs(after - before) > 1e-9) {
          row = table.update(row.id, { priority: after });
          reprioritized++;
        }
        changes.push({
          query_id: row.id,
          text: row.text,
          query_class: row.query_class,
          before,
          after,
          runs: e.runs,
          smoothed_density: round(e.smoothed_density, 4),
          relative_density: relative === null ? null : round(relative, 4),
          basis: relative === null ? 'exploration' : 'density',
        });
      }
      current.set(row.id, row);
    }

    const paused: SearchQuery[] = [];
    const retired: SearchQuery[] = [];
    for (const e of effectiveness) {
      const row = current.get(e.query.id)!;
      if (row.status === 'retired') continue;
      const stats = { text: row.text, runs: e.runs, users_evaluated: e.users_evaluated, candidates: e.candidates, qualified: e.qualified, smoothed_density: round(e.smoothed_density, 4), previous_status: row.status };
      if (e.runs >= FEEDBACK.retire_min_runs && e.smoothed_density < FEEDBACK.retire_max_smoothed_density) {
        const updated = table.update(row.id, { status: 'retired' });
        current.set(row.id, updated);
        retired.push(updated);
        ctx.audit.event({ actor: QUERY_ACTOR, action: 'search_query.retired', entity_type: 'search_query', entity_id: row.id, details: stats });
      } else if (row.status === 'active' && e.runs >= FEEDBACK.pause_min_runs && e.candidates === 0) {
        const updated = table.update(row.id, { status: 'paused' });
        current.set(row.id, updated);
        paused.push(updated);
        ctx.audit.event({ actor: QUERY_ACTOR, action: 'search_query.paused', entity_type: 'search_query', entity_id: row.id, details: stats });
      }
    }

    const keys = new Set(effectiveness.map((e) => queryKey(e.query.text)));
    const derived: SearchQuery[] = [];
    const parents = effectiveness.filter(
      (e) =>
        current.get(e.query.id)!.status === 'active' &&
        e.runs >= FEEDBACK.derive_min_runs &&
        e.smoothed_density >= FEEDBACK.derive_min_smoothed_density,
    );
    for (const pe of parents) {
      if (derived.length >= FEEDBACK.max_derived_per_call) break;
      const parent = current.get(pe.query.id)!;
      let fromParent = 0;
      for (const variant of deriveVariants(parent, dealer, catalog)) {
        if (derived.length >= FEEDBACK.max_derived_per_call || fromParent >= FEEDBACK.max_derived_per_parent) break;
        const key = queryKey(variant.text);
        if (!key || keys.has(key)) continue;
        keys.add(key);
        const relative = best > 0 ? pe.smoothed_density / best : 1;
        const now = ctx.clock.iso();
        const row = table.insert({
          id: newId('q'),
          dealer_id: dealerId,
          goal_id: parent.goal_id,
          text: variant.text,
          query_class: 'derived',
          brand: parent.brand,
          model: parent.model,
          location: variant.location ?? parent.location,
          priority: parent.priority,
          status: 'active',
          parent_query_id: parent.id,
          generation_reason:
            `由高效查询「${parent.text}」派生（${variant.label}）：父查询${pe.runs}次搜索共评估${pe.users_evaluated}位用户、` +
            `合格线索${pe.qualified}个，线索密度${pct(pe.lead_density)}，平滑线索密度${pct(pe.smoothed_density)}（为当前最佳查询的${pct(relative)}）`,
          created_at: now,
          updated_at: now,
        });
        derived.push(row);
        fromParent++;
        ctx.audit.event({
          actor: QUERY_ACTOR,
          action: 'search_query.derived',
          entity_type: 'search_query',
          entity_id: row.id,
          details: { text: row.text, parent_query_id: parent.id, parent_text: parent.text, variant: variant.label, parent_smoothed_density: round(pe.smoothed_density, 4) },
        });
      }
    }

    const ran = effectiveness.filter((e) => e.runs >= 1);
    const totalRuns = ran.reduce((s, e) => s + e.runs, 0);
    const evidence: Evidence[] = [
      ...ran.slice(0, 3).map((e) => ({
        code: 'query_lead_density',
        label: `「${e.query.text}」${e.runs}次搜索，评估${e.users_evaluated}人，合格线索${e.qualified}个，线索密度${pct(e.lead_density)}，平滑密度${pct(e.smoothed_density)}`,
        source_ref: e.query.id,
      })),
      ...paused.map((q) => ({ code: 'query_paused', label: `「${q.text}」已搜索${FEEDBACK.pause_min_runs}次以上仍无候选线索，暂停`, source_ref: q.id })),
      ...retired.map((q) => ({ code: 'query_retired', label: `「${q.text}」已搜索${FEEDBACK.retire_min_runs}次以上且平滑线索密度低于${pct(FEEDBACK.retire_max_smoothed_density)}，停用`, source_ref: q.id })),
    ];
    ctx.audit.decision({
      agent: QUERY_AGENT,
      skill: QUERY_SKILL,
      decision_type: 'query_optimization',
      subject_type: 'dealer',
      subject_id: dealerId,
      inputs: {
        best_smoothed_density: round(best, 4),
        formula: 'priority = clamp(0.35 × class_prior + 0.65 × smoothed_density / best, 0.05, 1); never-run queries keep their prior',
        queries: effectiveness.map((e) => ({
          query_id: e.query.id,
          text: e.query.text,
          query_class: e.query.query_class,
          status: e.query.status,
          runs: e.runs,
          users_evaluated: e.users_evaluated,
          candidates: e.candidates,
          qualified: e.qualified,
          lead_density: round(e.lead_density, 4),
          smoothed_density: round(e.smoothed_density, 4),
          appointments: e.appointments,
          won: e.won,
        })),
      },
      evidence,
      output: {
        reprioritized,
        changes,
        derived: derived.map((q) => ({ query_id: q.id, text: q.text, parent_query_id: q.parent_query_id, priority: q.priority })),
        paused: paused.map((q) => ({ query_id: q.id, text: q.text })),
        retired: retired.map((q) => ({ query_id: q.id, text: q.text })),
      },
      confidence: clamp(0.3 + 0.03 * totalRuns, 0.3, 0.9),
      engine: 'rules',
    });
    if (reprioritized > 0 || derived.length > 0 || paused.length > 0 || retired.length > 0) {
      ctx.audit.event({
        actor: QUERY_ACTOR,
        action: 'search_queries.optimized',
        entity_type: 'dealer',
        entity_id: dealerId,
        details: { reprioritized, derived: derived.length, paused: paused.length, retired: retired.length },
      });
    }

    return {
      reprioritized,
      derived,
      retired,
      paused,
      evaluated: changes.length,
      best_smoothed_density: best,
      changes,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Active queries to run next: the goal's queries first (when `goalId` is given), then priority desc; never-run
 * queries are guaranteed at least one slot in every block of four (when available) so new and derived queries get
 * explored instead of starving behind proven ones.
 */
export function selectQueriesToRun(ctx: AppContext, dealerId: string, limit: number, goalId: string | null = null): SearchQuery[] {
  getDealer(ctx, dealerId);
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
    throw new ValidationError('limit', 'expected a non-negative integer');
  }
  if (limit === 0) return [];
  const active = ctx.db.table('search_queries').findMany({ dealer_id: dealerId, status: 'active' });
  if (active.length === 0) return [];

  const completed = completedRunCounts(ctx, dealerId);
  const explored = (q: SearchQuery) => (completed.get(q.id) ?? 0) > 0;
  const tier = (q: SearchQuery) => (goalId && q.goal_id === goalId ? 0 : 1);
  const rank = (a: SearchQuery, b: SearchQuery) =>
    tier(a) - tier(b) ||
    b.priority - a.priority ||
    a.created_at.localeCompare(b.created_at) ||
    a.text.localeCompare(b.text) ||
    a.id.localeCompare(b.id);

  const ordered = [...active].sort(rank);
  const selected = ordered.slice(0, limit);
  const every = FEEDBACK.exploration_slot_every;
  const unexplored = ordered.filter((q) => !explored(q));
  const need = Math.min(unexplored.length, Math.ceil(selected.length / every));
  const have = selected.filter((q) => !explored(q)).length;
  if (have < need) {
    const chosen = new Set(selected.map((q) => q.id));
    for (const extra of unexplored.filter((q) => !chosen.has(q.id)).slice(0, need - have)) {
      for (let i = selected.length - 1; i >= 0; i--) {
        if (explored(selected[i])) {
          selected.splice(i, 1);
          break;
        }
      }
      selected.push(extra);
    }
    selected.sort(rank);
  }

  for (let start = 0; start < selected.length; start += every) {
    const end = Math.min(start + every, selected.length);
    if (selected.slice(start, end).some((q) => !explored(q))) continue;
    const j = selected.findIndex((q, idx) => idx >= end && !explored(q));
    if (j < 0) break;
    const [item] = selected.splice(j, 1);
    selected.splice(end - 1, 0, item);
  }
  return selected;
}
