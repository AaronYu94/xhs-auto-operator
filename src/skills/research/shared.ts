/**
 * Shared research engine (B3): scope resolution, bounded corpus gathering (provider search + already-ingested
 * public posts/comments), verbatim quoting helpers, buyer-comment analysis with the existing NLU, and audited
 * ResearchBrief persistence.
 *
 * Honesty rules
 * - Provider notes/comments are analysed IN MEMORY only (ingestion into public_posts belongs to lead-discovery).
 * - Every insight carries Evidence whose quote is a verbatim substring of the referenced source
 *   (`note:<platform_post_id>` → title/content, `comment:<platform_comment_id>` → comment text,
 *   `offer:<id>` → offer title, `inventory:<id>` → vehicle trim). Evidence that fails this check is dropped
 *   before persisting, and an insight left without evidence is dropped with it.
 * - With no corpus at all the brief says so in its headline; nothing is invented.
 */
import type { AppContext } from '../../app/context.ts';
import { ValidationError } from '../../core/errors.ts';
import { dedupeEvidence, isVerbatimQuote } from '../../core/evidence.ts';
import { newId } from '../../core/ids.ts';
import { meaningfulChars, round } from '../../core/text.ts';
import { DAY_MS } from '../../core/time.ts';
import { DATA_MODES } from '../../core/types.ts';
import type {
  CapabilityStatus,
  ConversationIntent,
  DataMode,
  Dealer,
  DealerProfile,
  Evidence,
  PublicComment,
  PublicPost,
  ResearchBrief,
  ResearchInsight,
  ResearchKind,
  SignalContext,
  TransactionQuestion,
} from '../../core/types.ts';
import { v, type Infer } from '../../core/validate.ts';
import {
  clauseAt,
  competitorsOf,
  findBrands,
  findModels,
  getBrandInfo,
  mapText,
  modelDisplayName,
  modelShortLabel,
  rawSlice,
  resolveModelName,
  type MappedText,
} from '../../domain/automotive-lexicon.ts';
import type { CapabilityReport, ProviderMode, XhsComment, XhsNoteDetail, XhsNoteSummary } from '../../providers/xhs/types.ts';
import { analyzeSignal, isNonBuyerRole, type SignalAnalysis } from '../acquisition/intent-detection/nlu.ts';
import { getActiveOffers, getDealer, getDealerProfile } from '../operations/dealer-brain/index.ts';
import { detectConversationIntents } from '../sales/conversation/nlu.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Constants & input
// ─────────────────────────────────────────────────────────────────────────────

export const RESEARCH_AGENT = 'research-agent';
export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 180;
/** Hard bounds on provider usage per research run. */
export const MAX_PROVIDER_QUERIES = 6;
export const MAX_NOTES_PER_QUERY = 10;
export const MAX_COMMENTS_PER_NOTE = 100;
/** Default number of prioritized models used to build provider queries. */
const QUERY_MODELS = 3;

export const researchInputValidator = v.object({
  dealer_id: v.string({ min: 1 }),
  models: v.optional(v.array(v.string({ min: 1, max: 40 }), { max: 20 })),
  location: v.optional(v.nullable(v.string({ min: 1, max: 20 }))),
  window_days: v.optional(v.number({ int: true, min: 1, max: MAX_WINDOW_DAYS })),
});
export type ResearchInput = Infer<typeof researchInputValidator>;

export interface ResearchScope {
  dealer: Dealer;
  profile: DealerProfile;
  /** canonical models, prioritized (input order, else in-stock inventory → in transit → active offers → catalog) */
  models: string[];
  /** true when models were given explicitly by the caller */
  explicit_models: boolean;
  brand: string;
  brand_zh: string;
  location: string | null;
  window_days: number;
  /** ISO bounds of the analysis window (to = now) */
  from: string;
  to: string;
  /** platform_account_id of every managed account in the dealer's group (never counted as buyers) */
  managed_ids: Set<string>;
}

const canonicalKey = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');

/** Carried models ordered by in-stock quantity, in-transit quantity, active model offers, then catalog order. */
export function prioritizedModels(ctx: AppContext, dealer: Dealer, profile: DealerProfile): string[] {
  const stock = new Map<string, { in_stock: number; in_transit: number; offers: number }>();
  const entry = (m: string) => {
    let e = stock.get(m);
    if (!e) {
      e = { in_stock: 0, in_transit: 0, offers: 0 };
      stock.set(m, e);
    }
    return e;
  };
  for (const inv of profile.inventory) {
    if (inv.status === 'in_stock') entry(inv.model).in_stock += inv.quantity;
    else if (inv.status === 'in_transit') entry(inv.model).in_transit += inv.quantity;
  }
  const vehicleModel = new Map(ctx.db.table('vehicles').findMany({ group_id: dealer.group_id }).map((veh) => [veh.id, veh.model]));
  for (const offer of getActiveOffers(ctx, dealer.id)) {
    const model = offer.vehicle_id ? vehicleModel.get(offer.vehicle_id) : offer.model ? (resolveModelName(offer.model) ?? offer.model) : null;
    if (model) entry(model).offers += 1;
  }
  return profile.models
    .map((model, index) => ({ model, index, e: stock.get(model) ?? { in_stock: 0, in_transit: 0, offers: 0 } }))
    .sort((a, b) => b.e.in_stock - a.e.in_stock || b.e.in_transit - a.e.in_transit || b.e.offers - a.e.offers || a.index - b.index)
    .map((x) => x.model);
}

/** Validate input and resolve the research scope (dealer, canonical models, location, window). */
export function resolveScope(ctx: AppContext, rawInput: ResearchInput, defaultWindowDays = DEFAULT_WINDOW_DAYS): ResearchScope {
  const input = researchInputValidator(rawInput, 'input');
  const dealer = getDealer(ctx, input.dealer_id);
  const profile = getDealerProfile(ctx, dealer.id);
  let models: string[];
  const explicit = !!input.models && input.models.length > 0;
  if (explicit) {
    const seen = new Set<string>();
    models = [];
    for (const raw of input.models ?? []) {
      const canonical = resolveModelName(raw.trim()) ?? raw.trim();
      const key = canonicalKey(canonical);
      if (!canonical || seen.has(key)) continue;
      seen.add(key);
      models.push(canonical);
    }
  } else {
    models = prioritizedModels(ctx, dealer, profile);
  }
  const brand = dealer.brands[0] ?? profile.brands[0] ?? '';
  const windowDays = input.window_days ?? defaultWindowDays;
  const now = ctx.clock.now();
  const managed = new Set(
    ctx.db
      .table('xhs_accounts')
      .findMany({ group_id: dealer.group_id })
      .map((a) => a.platform_account_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  return {
    dealer,
    profile,
    models,
    explicit_models: explicit,
    brand,
    brand_zh: getBrandInfo(brand)?.brand_zh ?? brand,
    location: input.location === undefined ? dealer.city : input.location,
    window_days: windowDays,
    from: new Date(now.getTime() - windowDays * DAY_MS).toISOString(),
    to: now.toISOString(),
    managed_ids: managed,
  };
}

export function modelsLabel(scope: ResearchScope, max = 3): string {
  if (scope.models.length === 0) return `${scope.brand_zh}全系`;
  const names = scope.models.slice(0, max).map((m) => modelShortLabel(m));
  return scope.models.length > max ? `${names.join('、')}等${scope.models.length}款车型` : names.join('、');
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider queries
// ─────────────────────────────────────────────────────────────────────────────

function pushQuery(out: string[], q: string): void {
  const t = q.replace(/\s+/g, ' ').trim();
  if (!t || out.length >= MAX_PROVIDER_QUERIES) return;
  if (out.some((x) => canonicalKey(x) === canonicalKey(t))) return;
  out.push(t);
}

/** Bounded (≤ 6) search queries built from the dealer's prioritized models and location, per research kind. */
export function buildResearchQueries(kind: ResearchKind, scope: ResearchScope): string[] {
  const out: string[] = [];
  const models = scope.models.slice(0, QUERY_MODELS);
  const city = scope.location ?? '';
  const brandZh = scope.brand_zh;
  const short = (m: string) => modelShortLabel(m);
  const display = (m: string) => (scope.brand ? modelDisplayName(scope.brand, m, 'zh') : short(m));
  switch (kind) {
    case 'xhs': {
      for (const m of models) {
        pushQuery(out, display(m));
        if (city) pushQuery(out, `${city}${short(m)}`);
      }
      if (city && brandZh) pushQuery(out, `${city}买${brandZh}`);
      break;
    }
    case 'competitor': {
      const lists = models.map((m) => ({ m, competitors: competitorsOf(scope.brand, m) }));
      const depth = Math.max(0, ...lists.map((l) => l.competitors.length));
      for (let i = 0; i < depth && out.length < MAX_PROVIDER_QUERIES; i++) {
        for (const l of lists) {
          const c = l.competitors[i];
          if (c) pushQuery(out, `${short(l.m)} vs ${modelShortLabel(c.model)}`);
        }
      }
      break;
    }
    case 'market': {
      const [m1, m2, m3] = models;
      if (m1) {
        pushQuery(out, `${short(m1)}落地`);
        pushQuery(out, `${short(m1)}优惠`);
      }
      if (m2) {
        pushQuery(out, `${short(m2)}落地`);
        pushQuery(out, `${short(m2)}优惠`);
      }
      if (city && brandZh) pushQuery(out, `${city}${brandZh}优惠`);
      if (m3) pushQuery(out, `${short(m3)}落地`);
      break;
    }
    case 'trend': {
      for (const m of models) pushQuery(out, display(m));
      if (city && brandZh) pushQuery(out, `${city}${brandZh}`);
      if (city && models[0]) pushQuery(out, `${city}${short(models[0])}`);
      break;
    }
  }
  if (out.length === 0 && brandZh) pushQuery(out, city ? `${city}${brandZh}` : brandZh);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Corpus
// ─────────────────────────────────────────────────────────────────────────────

export type CorpusOrigin = 'provider' | 'db' | 'provider+db';

export interface ResearchComment {
  platform_comment_id: string;
  public_comment_id: string | null;
  parent_comment_id: string | null;
  author_user_id: string | null;
  author_nickname: string | null;
  content: string;
  ip_location: string | null;
  like_count: number;
  published_at: string | null;
  /** published_at, or fetched_at for DB rows without a publish time */
  observed_at: string | null;
  /** authored by one of the group's managed accounts */
  managed_author: boolean;
  /** authored by the note's author (creator replies) */
  note_author: boolean;
  /** provenance (ARCHITECTURE §10.1): DB row data_mode, or derived from the provider mode */
  data_mode: DataMode;
}

export interface ResearchNote {
  platform_post_id: string;
  public_post_id: string | null;
  origin: CorpusOrigin;
  title: string;
  content: string;
  tags: string[];
  author_user_id: string | null;
  author_nickname: string | null;
  ip_location: string | null;
  like_count: number;
  collect_count: number;
  comment_count: number;
  published_at: string | null;
  observed_at: string | null;
  own_post_id: string | null;
  managed_author: boolean;
  /** provenance (ARCHITECTURE §10.1): DB row data_mode, or derived from the provider mode */
  data_mode: DataMode;
  comments: ResearchComment[];
}

export interface ProviderQueryLog {
  query: string;
  ok: boolean;
  notes: number;
  status: CapabilityStatus;
  reason: string | null;
}

export interface ProviderUsage {
  provider: string;
  mode: ProviderMode;
  /** NOT_QUERIED when the synchronous DB-only path ran without a provider corpus */
  search_status: CapabilityStatus | 'NOT_QUERIED';
  reason: string;
  queries: ProviderQueryLog[];
  /** successful search calls */
  searches: number;
  notes: number;
  comments: number;
}

export interface ResearchCorpus {
  notes: ResearchNote[];
  provider: ProviderUsage;
  db: { posts: number; comments: number };
  lookback: { from: string; to: string; days: number };
}

export const noteRef = (n: Pick<ResearchNote, 'platform_post_id'>) => `note:${n.platform_post_id}`;
export const commentRef = (c: Pick<ResearchComment, 'platform_comment_id'>) => `comment:${c.platform_comment_id}`;
export const noteText = (n: Pick<ResearchNote, 'title' | 'content'>) => (n.title ? `${n.title}\n${n.content}` : n.content);

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function inWindow(iso: string | null, fromMs: number, toMs: number): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  return t >= fromMs && t <= toMs;
}

export interface RelevanceOptions {
  /** also accept threads that mention a competitor of a scope model (trend detection) */
  include_competitors?: boolean;
}

/**
 * Relevance of a text to the scope: it mentions a scope model (or, optionally, a competitor of one), or it is
 * brand-level content for the dealer's brand that names no specific model ('杭州买宝马攻略').
 */
export function makeRelevance(scope: ResearchScope, opts: RelevanceOptions = {}): (text: string, context?: string | null) => boolean {
  const wanted = new Set(scope.models.map(canonicalKey));
  if (opts.include_competitors) {
    for (const m of scope.models) for (const c of competitorsOf(scope.brand, m)) wanted.add(canonicalKey(c.model));
  }
  const brands = new Set(scope.dealer.brands.length > 0 ? scope.dealer.brands : scope.profile.brands);
  return (text, context) => {
    if (!text) return false;
    const models = findModels(text, { context: context ?? null });
    if (models.some((m) => wanted.has(canonicalKey(m.model)))) return true;
    if (models.length === 0 && findBrands(text).some((b) => brands.has(b.brand))) return true;
    return false;
  };
}

/**
 * True when a comment explicitly names at least one vehicle model and none of them is a scope model, e.g.
 * '上海X3现在什么价' under a brand-level note in an i3-scoped brief. A note enters the corpus when ANY of its texts is
 * relevant, so its other comments must not be counted for the scope blindly; text that names no model inherits its
 * note's relevance ('现在优惠多少'). An empty scope never excludes anything.
 */
export function namesOnlyOutOfScopeModels(scope: Pick<ResearchScope, 'models'>, text: string): boolean {
  if (scope.models.length === 0 || !text) return false;
  const named = findModels(text);
  if (named.length === 0) return false;
  const wanted = new Set(scope.models.map(canonicalKey));
  return !named.some((m) => wanted.has(canonicalKey(m.model)));
}

function flattenProviderComments(list: readonly XhsComment[], parent: string | null, out: XhsComment[], seen: Set<string>): void {
  for (const c of list) {
    if (!c || typeof c.platform_comment_id !== 'string' || seen.has(c.platform_comment_id)) continue;
    seen.add(c.platform_comment_id);
    out.push({ ...c, parent_comment_id: c.parent_comment_id ?? parent });
    if (c.sub_comments && c.sub_comments.length > 0) flattenProviderComments(c.sub_comments, c.platform_comment_id, out, seen);
  }
}

/** Provenance of data returned by a provider of the given mode (ARCHITECTURE §10.1). */
export function providerDataMode(mode: ProviderMode): DataMode {
  if (mode === 'live') return 'live';
  if (mode === 'simulation') return 'simulation';
  if (mode === 'manual') return 'manual';
  return 'unknown';
}

function toResearchComment(c: XhsComment, noteAuthor: string | null, managed: Set<string>, mode: DataMode): ResearchComment {
  const author = c.author?.platform_user_id ?? null;
  return {
    platform_comment_id: c.platform_comment_id,
    public_comment_id: null,
    parent_comment_id: c.parent_comment_id ?? null,
    author_user_id: author,
    author_nickname: c.author?.nickname ?? null,
    content: typeof c.content === 'string' ? c.content : '',
    ip_location: c.ip_location ?? null,
    like_count: Number.isFinite(c.like_count) ? c.like_count : 0,
    published_at: c.published_at ?? null,
    observed_at: c.published_at ?? null,
    managed_author: author !== null && managed.has(author),
    note_author: author !== null && noteAuthor !== null && author === noteAuthor,
    data_mode: mode,
  };
}

/**
 * Bounded provider gathering: ≤ 6 searches (≤ 10 notes each, published within `lookbackDays`), note detail and
 * comments (with replies) per distinct note. Nothing is persisted. Provider failures are logged, never thrown.
 * Returned notes pass the same relevance rule as the DB corpus (`opts`), so each research kind analyses the same
 * kind of threads whichever source they came from.
 */
export async function fetchProviderCorpus(
  ctx: AppContext,
  scope: ResearchScope,
  queries: readonly string[],
  lookbackDays: number = scope.window_days,
  opts: RelevanceOptions = {},
): Promise<{ notes: ResearchNote[]; usage: ProviderUsage }> {
  const mode = providerDataMode(ctx.xhs.mode);
  const usage: ProviderUsage = {
    provider: ctx.xhs.name,
    mode: ctx.xhs.mode,
    search_status: 'UNAVAILABLE',
    reason: '',
    queries: [],
    searches: 0,
    notes: 0,
    comments: 0,
  };
  let report: CapabilityReport;
  try {
    report = await ctx.xhs.capabilities(null);
  } catch (err) {
    usage.reason = `能力检测失败：${errorMessage(err)}`;
    return { notes: [], usage };
  }
  const search = report.capabilities.search_public_content;
  usage.search_status = search.status;
  usage.reason = search.reason;
  if (search.status !== 'AVAILABLE') return { notes: [], usage };
  const canReadPost = report.capabilities.read_public_post?.status === 'AVAILABLE';
  const canReadComments = report.capabilities.read_public_comments?.status === 'AVAILABLE';

  const nowMs = ctx.clock.now().getTime();
  const fromMs = nowMs - lookbackDays * DAY_MS;
  const byId = new Map<string, ResearchNote>();
  for (const query of queries.slice(0, MAX_PROVIDER_QUERIES)) {
    let summaries: XhsNoteSummary[];
    try {
      const res = await ctx.xhs.searchNotes(query, { limit: MAX_NOTES_PER_QUERY, published_within_days: lookbackDays, sort: 'general' }, null);
      if (!res.ok) {
        usage.queries.push({ query, ok: false, notes: 0, status: res.status, reason: res.reason });
        continue;
      }
      summaries = res.data.slice(0, MAX_NOTES_PER_QUERY);
    } catch (err) {
      usage.queries.push({ query, ok: false, notes: 0, status: 'UNAVAILABLE', reason: errorMessage(err) });
      continue;
    }
    usage.searches += 1;
    usage.queries.push({ query, ok: true, notes: summaries.length, status: 'AVAILABLE', reason: null });
    for (const summary of summaries) {
      if (!summary || typeof summary.platform_post_id !== 'string' || byId.has(summary.platform_post_id)) continue;
      if (!inWindow(summary.published_at ?? null, fromMs, nowMs)) continue;
      let detail: XhsNoteDetail | null = null;
      if (canReadPost) {
        try {
          const res = await ctx.xhs.getNote({ platform_post_id: summary.platform_post_id, xsec_token: summary.xsec_token ?? null }, null);
          if (res.ok) detail = res.data;
        } catch (err) {
          ctx.log.debug('research: getNote failed', { note: summary.platform_post_id, error: errorMessage(err) });
        }
      }
      const base = detail ?? summary;
      const noteAuthor = base.author?.platform_user_id ?? null;
      const comments: ResearchComment[] = [];
      if (canReadComments) {
        try {
          const res = await ctx.xhs.getComments(
            { platform_post_id: summary.platform_post_id, xsec_token: summary.xsec_token ?? null },
            { limit: MAX_COMMENTS_PER_NOTE, include_replies: true },
            null,
          );
          if (res.ok) {
            const flat: XhsComment[] = [];
            flattenProviderComments(res.data, null, flat, new Set());
            for (const c of flat) {
              const rc = toResearchComment(c, noteAuthor, scope.managed_ids, mode);
              if (inWindow(rc.observed_at, fromMs, nowMs)) comments.push(rc);
            }
          }
        } catch (err) {
          ctx.log.debug('research: getComments failed', { note: summary.platform_post_id, error: errorMessage(err) });
        }
      }
      byId.set(summary.platform_post_id, {
        platform_post_id: summary.platform_post_id,
        public_post_id: null,
        origin: 'provider',
        title: base.title ?? '',
        content: detail?.content ?? '',
        tags: detail?.tags ? [...detail.tags] : [],
        author_user_id: noteAuthor,
        author_nickname: base.author?.nickname ?? null,
        ip_location: detail?.ip_location ?? null,
        like_count: Number.isFinite(base.like_count) ? base.like_count : 0,
        collect_count: detail && Number.isFinite(detail.collect_count) ? detail.collect_count : 0,
        comment_count: detail && Number.isFinite(detail.comment_count) ? detail.comment_count : comments.length,
        published_at: base.published_at ?? null,
        observed_at: base.published_at ?? null,
        own_post_id: null,
        managed_author: noteAuthor !== null && scope.managed_ids.has(noteAuthor),
        data_mode: mode,
        comments,
      });
    }
  }
  const relevant = makeRelevance(scope, opts);
  const notes = [...byId.values()].filter(
    (n) => relevant(`${noteText(n)}\n${n.tags.join(' ')}`) || n.comments.some((c) => relevant(c.content, n.title)),
  );
  usage.notes = notes.length;
  usage.comments = notes.reduce((sum, n) => sum + n.comments.length, 0);
  return { notes, usage };
}

/** Public posts/comments already ingested (by lead-discovery) that are relevant to the scope within the lookback. */
export function loadDbCorpus(ctx: AppContext, scope: ResearchScope, lookbackDays: number = scope.window_days, opts: RelevanceOptions = {}): ResearchNote[] {
  const nowMs = ctx.clock.now().getTime();
  const fromMs = nowMs - lookbackDays * DAY_MS;
  // coarse SQL filter with a one-day margin (timestamp formats vary), precise filter below
  const coarseFrom = new Date(fromMs - DAY_MS).toISOString();
  const coarseTo = new Date(nowMs + DAY_MS).toISOString();
  const posts = ctx.db
    .table('public_posts')
    .query(
      `(COALESCE(published_at, fetched_at) >= ? AND COALESCE(published_at, fetched_at) <= ?)
       OR id IN (SELECT public_post_id FROM public_comments WHERE COALESCE(published_at, fetched_at) >= ? AND COALESCE(published_at, fetched_at) <= ?)`,
      [coarseFrom, coarseTo, coarseFrom, coarseTo],
      { orderBy: 'platform_post_id ASC' },
    );
  const relevant = makeRelevance(scope, opts);
  const out: ResearchNote[] = [];
  for (const post of posts) {
    const postObserved = post.published_at ?? post.fetched_at;
    const postInWindow = inWindow(postObserved, fromMs, nowMs);
    const rows: PublicComment[] = ctx.db.table('public_comments').findMany({ public_post_id: post.id }, { orderBy: 'platform_comment_id ASC' });
    const comments = rows
      .map((c) => dbComment(c, post, scope.managed_ids))
      .filter((c) => inWindow(c.observed_at, fromMs, nowMs));
    if (!postInWindow && comments.length === 0) continue;
    const postText = `${post.title}\n${post.content}\n${post.tags.join(' ')}`;
    if (!relevant(postText) && !comments.some((c) => relevant(c.content, post.title))) continue;
    out.push({
      platform_post_id: post.platform_post_id,
      public_post_id: post.id,
      origin: 'db',
      title: post.title,
      content: post.content,
      tags: [...post.tags],
      author_user_id: post.author_platform_user_id,
      author_nickname: post.author_nickname,
      ip_location: post.ip_location,
      like_count: post.like_count,
      collect_count: post.collect_count,
      comment_count: post.comment_count,
      published_at: post.published_at,
      observed_at: postObserved,
      own_post_id: post.own_post_id,
      managed_author: post.author_platform_user_id !== null && scope.managed_ids.has(post.author_platform_user_id),
      data_mode: post.data_mode ?? 'unknown',
      comments,
    });
  }
  return out;
}

function dbComment(c: PublicComment, post: PublicPost, managed: Set<string>): ResearchComment {
  const author = c.author_platform_user_id;
  return {
    platform_comment_id: c.platform_comment_id,
    public_comment_id: c.id,
    parent_comment_id: c.parent_comment_id,
    author_user_id: author,
    author_nickname: c.author_nickname,
    content: c.content,
    ip_location: c.ip_location,
    like_count: c.like_count,
    published_at: c.published_at,
    observed_at: c.published_at ?? c.fetched_at,
    managed_author: author !== null && managed.has(author),
    note_author: author !== null && post.author_platform_user_id !== null && author === post.author_platform_user_id,
    data_mode: c.data_mode ?? 'unknown',
  };
}

const byDateDescThenId = (a: ResearchNote, b: ResearchNote) =>
  (b.observed_at ?? '').localeCompare(a.observed_at ?? '') || a.platform_post_id.localeCompare(b.platform_post_id);
const commentOrder = (a: ResearchComment, b: ResearchComment) =>
  (a.observed_at ?? '').localeCompare(b.observed_at ?? '') || a.platform_comment_id.localeCompare(b.platform_comment_id);

/** Union of provider and DB notes by platform_post_id (provider counts win; DB ids kept); comments unioned by id. */
export function mergeCorpora(providerNotes: readonly ResearchNote[], dbNotes: readonly ResearchNote[]): ResearchNote[] {
  const byId = new Map<string, ResearchNote>();
  for (const n of dbNotes) byId.set(n.platform_post_id, { ...n, comments: [...n.comments] });
  for (const p of providerNotes) {
    const existing = byId.get(p.platform_post_id);
    if (!existing) {
      byId.set(p.platform_post_id, { ...p, comments: [...p.comments] });
      continue;
    }
    const comments = new Map(existing.comments.map((c) => [c.platform_comment_id, c]));
    for (const c of p.comments) {
      const prev = comments.get(c.platform_comment_id);
      comments.set(c.platform_comment_id, prev ? { ...c, public_comment_id: prev.public_comment_id } : c);
    }
    byId.set(p.platform_post_id, {
      ...p,
      public_post_id: existing.public_post_id,
      own_post_id: existing.own_post_id,
      content: p.content || existing.content,
      tags: p.tags.length > 0 ? p.tags : existing.tags,
      ip_location: p.ip_location ?? existing.ip_location,
      origin: 'provider+db',
      comments: [...comments.values()],
    });
  }
  return [...byId.values()]
    .map((n) => ({ ...n, comments: [...n.comments].sort(commentOrder) }))
    .sort(byDateDescThenId);
}

/**
 * Copies of a comment: the same author posting the same text again (ignoring case, punctuation and emoji), e.g. one
 * question pasted under several notes. Only the earliest copy counts in research statistics; the later copies are
 * returned as `comment:<platform_comment_id>` refs. Comments without an author id are never treated as copies.
 */
export function repeatedCommentRefs(notes: readonly ResearchNote[]): Set<string> {
  const all = notes.flatMap((n) => n.comments).filter((c) => c.author_user_id !== null && c.author_user_id !== '');
  all.sort(commentOrder);
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const c of all) {
    const text = meaningfulChars(c.content);
    if (!text) continue;
    const k = `${c.author_user_id}\u0000${text}`;
    if (seen.has(k)) out.add(commentRef(c));
    else seen.add(k);
  }
  return out;
}

/** Notes and comments per provenance (ARCHITECTURE §10.1). */
export function corpusDataModes(corpus: Pick<ResearchCorpus, 'notes'>): Record<DataMode, number> {
  const out = Object.fromEntries(DATA_MODES.map((m) => [m, 0])) as Record<DataMode, number>;
  const add = (m: DataMode | undefined) => {
    const mode: DataMode = m && (DATA_MODES as readonly string[]).includes(m) ? m : 'unknown';
    out[mode] += 1;
  };
  for (const n of corpus.notes) {
    add(n.data_mode);
    for (const c of n.comments) add(c.data_mode);
  }
  return out;
}

function notQueriedUsage(ctx: AppContext): ProviderUsage {
  return {
    provider: ctx.xhs.name,
    mode: ctx.xhs.mode,
    search_status: 'NOT_QUERIED',
    reason: '同步调用未访问小红书搜索，仅使用数据库已采集数据',
    queries: [],
    searches: 0,
    notes: 0,
    comments: 0,
  };
}

/** Assemble a corpus from optional provider results plus the DB (synchronous part). */
export function assembleCorpus(
  ctx: AppContext,
  scope: ResearchScope,
  provider: { notes: ResearchNote[]; usage: ProviderUsage } | null,
  lookbackDays: number = scope.window_days,
  opts: RelevanceOptions = {},
): ResearchCorpus {
  const dbNotes = loadDbCorpus(ctx, scope, lookbackDays, opts);
  const notes = mergeCorpora(provider?.notes ?? [], dbNotes);
  const now = ctx.clock.now();
  return {
    notes,
    provider: provider?.usage ?? notQueriedUsage(ctx),
    db: { posts: dbNotes.length, comments: dbNotes.reduce((s, n) => s + n.comments.length, 0) },
    lookback: { from: new Date(now.getTime() - lookbackDays * DAY_MS).toISOString(), to: now.toISOString(), days: lookbackDays },
  };
}

/** Full gathering path: bounded provider search (when AVAILABLE) + DB corpus. */
export async function gatherResearchCorpus(
  ctx: AppContext,
  scope: ResearchScope,
  queries: readonly string[],
  lookbackDays: number = scope.window_days,
  opts: RelevanceOptions = {},
): Promise<ResearchCorpus> {
  const provider = await fetchProviderCorpus(ctx, scope, queries, lookbackDays, opts);
  return assembleCorpus(ctx, scope, provider, lookbackDays, opts);
}

export function corpusCounts(corpus: ResearchCorpus): ResearchBrief['source_counts'] {
  return {
    posts: corpus.notes.length,
    comments: corpus.notes.reduce((s, n) => s + n.comments.length, 0),
    provider_searches: corpus.provider.searches,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Verbatim quoting
// ─────────────────────────────────────────────────────────────────────────────

const MAX_CLAUSE_CHARS = 60;

/** Verbatim trimmed prefix (≤ max code points). */
export function excerpt(text: string, max = MAX_CLAUSE_CHARS): string {
  return Array.from(text.trim()).slice(0, max).join('').trim();
}

/** Clauses shorter than this (e.g. a bare '、Model 3、' list item) are widened by one clause on each side. */
const MIN_CLAUSE_CHARS = 8;

/**
 * Verbatim clause around normalized offsets [start, end), trimmed to ≈ 30 chars of context on each side. A very
 * short clause is widened with its neighbouring clauses on the same line (never across a line break).
 */
export function clauseQuote(mt: MappedText, start: number, end: number): string {
  const clause = clauseAt(mt, start);
  let s = clause.start;
  let e = Math.max(end, clause.end);
  if (e - s < MIN_CLAUSE_CHARS) {
    const lineStart = mt.norm.lastIndexOf('\n', start - 1) + 1;
    const nl = mt.norm.indexOf('\n', end);
    const lineEnd = nl < 0 ? mt.norm.length : nl;
    if (s - 1 > lineStart) s = clauseAt(mt, s - 2).start;
    if (e + 1 < lineEnd) e = Math.min(lineEnd, Math.max(e, clauseAt(mt, e + 1).end));
    s = Math.max(s, lineStart);
  }
  if (e - s > MAX_CLAUSE_CHARS) {
    s = Math.max(s, start - 30);
    e = Math.min(e, end + 30);
  }
  const raw = rawSlice(mt, s, e).trim();
  return raw || rawSlice(mt, start, end);
}

/** Verbatim clause containing the first occurrence of `needle` (NFKC/case-insensitive), or null. */
export function clauseAround(text: string, needle: string): string | null {
  if (!text || !needle) return null;
  const mt = mapText(text);
  const n = needle.normalize('NFKC').toLowerCase();
  const idx = mt.norm.indexOf(n);
  if (idx < 0) return null;
  return clauseQuote(mt, idx, idx + n.length);
}

export function commentEvidence(code: string, label: string, comment: ResearchComment, quote: string | null | undefined): Evidence {
  return { code, label, quote: quote && quote.trim() ? quote : excerpt(comment.content), source_ref: commentRef(comment) };
}

export function noteEvidence(code: string, label: string, note: ResearchNote, quote: string | null | undefined): Evidence {
  const q = quote && quote.trim() ? quote : note.title.trim() ? excerpt(note.title) : excerpt(note.content);
  return { code, label, quote: q, source_ref: noteRef(note) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Buyer analysis (existing NLU)
// ─────────────────────────────────────────────────────────────────────────────

export interface AnalyzedComment {
  note: ResearchNote;
  comment: ResearchComment;
  analysis: SignalAnalysis;
  conversation_intents: ConversationIntent[];
  /** a prospective buyer's signal (not marketing, refusal/owner-negative, creator reply or managed account) */
  buyer: boolean;
  /** buyer signal phrased as a question/request ('多少', '吗', '哪家', '还是') — owner statements never count */
  question: boolean;
}

/**
 * Question / request phrasing on normalized text. Statements such as '开了两年，保养也不贵，推荐' carry product or
 * transaction keywords but ask nothing; research only counts actual buyer questions.
 */
const QUESTION_FORM_RE =
  /[?]|吗|嘛|么(?=$|[,。!?\s~])|呢(?=$|[,。!?\s~])|怎么|咋|多少|几(?:个|台|万|期|年|天|号|成|折|折扣)|哪|什么|啥|有没有|能不能|能否|可不可以|是不是|要不要|值不值|请问|问一下|同问|蹲一?个|如何|求(?:推荐|透露|问|分享|解答|告知|带|助)/;

export function isQuestionForm(text: string): boolean {
  return QUESTION_FORM_RE.test(text.normalize('NFKC').toLowerCase());
}

/** Buyer voice per the intent NLU: prefilter passed, not marketing, not negative, author role not owner/creator/marketing. */
export function isBuyerDetection(analysis: SignalAnalysis): boolean {
  const d = analysis.detection;
  if (!analysis.prefilter.passed || analysis.prefilter.is_marketing || d.is_marketing) return false;
  if (d.negative || isNonBuyerRole(d.author_role)) return false;
  return d.is_purchase_signal || d.transaction_questions.length > 0;
}

/** Solicitation / dealer-sales voice by content (prefilter) or nickname / role (intent NLU). */
export function isMarketingAnalysis(analysis: SignalAnalysis): boolean {
  return analysis.prefilter.is_marketing || analysis.detection.is_marketing === true || analysis.detection.author_role === 'marketing';
}

/** A note analysed as a post signal (title + content, author nickname and IP). */
export function analyzeNoteSignal(note: ResearchNote, scope: ResearchScope): SignalAnalysis {
  const context: SignalContext = { source_type: 'post', post_title: note.title, ip_location: note.ip_location, author_nickname: note.author_nickname };
  return analyzeSignal(note.content, context, scope.profile);
}

/** A comment analysed as a comment signal (post context, commenter nickname and IP). */
export function analyzeCommentSignal(note: ResearchNote, comment: ResearchComment, scope: ResearchScope): SignalAnalysis {
  const context: SignalContext = {
    source_type: 'comment',
    post_title: note.title,
    post_content: note.content,
    ip_location: comment.ip_location,
    author_nickname: comment.author_nickname,
  };
  return analyzeSignal(comment.content, context, scope.profile);
}

/** Every comment (copies of the same author's comment excluded) analysed with the intent NLU and the conversation NLU. */
export function analyzeComments(corpus: ResearchCorpus, scope: ResearchScope): AnalyzedComment[] {
  const out: AnalyzedComment[] = [];
  const repeats = repeatedCommentRefs(corpus.notes);
  for (const note of corpus.notes) {
    for (const comment of note.comments) {
      if (!comment.content.trim() || repeats.has(commentRef(comment))) continue;
      const analysis = analyzeCommentSignal(note, comment, scope);
      const conversationIntents = detectConversationIntents(comment.content).intents;
      const buyer = !comment.managed_author && !comment.note_author && isBuyerDetection(analysis);
      const question = buyer && (isQuestionForm(comment.content) || conversationIntents.includes('model_comparison'));
      out.push({ note, comment, analysis, conversation_intents: conversationIntents, buyer, question });
    }
  }
  return out;
}

/** Posts analysed as signals; only explicit `asker` roles (when the NLU classifies authors) count as buyer posts. */
export function buyerNotes(corpus: ResearchCorpus, scope: ResearchScope): { note: ResearchNote; analysis: SignalAnalysis }[] {
  const out: { note: ResearchNote; analysis: SignalAnalysis }[] = [];
  for (const note of corpus.notes) {
    if (note.managed_author) continue;
    const analysis = analyzeNoteSignal(note, scope);
    if (analysis.detection.author_role === 'asker' && isBuyerDetection(analysis)) out.push({ note, analysis });
  }
  return out;
}

export const QUESTION_CLUSTERS = [
  { key: 'discount', label: '现在优惠多少' },
  { key: 'landing_price', label: '落地价多少' },
  { key: 'price', label: '价格多少' },
  { key: 'inventory', label: '有没有现车/多久提车' },
  { key: 'color_trim_availability', label: '指定颜色/配置有没有车' },
  { key: 'finance', label: '贷款/首付/利率方案' },
  { key: 'lease', label: '能否以租代购/租赁' },
  { key: 'trade_in', label: '置换补贴多少' },
  { key: 'dealer_location', label: '去哪家店买/推荐销售' },
  { key: 'test_drive', label: '试驾/到店看车' },
  { key: 'model_comparison', label: '车型怎么选（对比）' },
  { key: 'product_research', label: '产品细节（空间/续航/油耗等）' },
  { key: 'purchase_scenario', label: '预算/场景选车咨询' },
] as const satisfies readonly { key: TransactionQuestion | 'model_comparison' | 'product_research' | 'purchase_scenario'; label: string }[];
export type QuestionClusterKey = (typeof QUESTION_CLUSTERS)[number]['key'];
export const FINANCE_CLUSTER_KEYS: readonly QuestionClusterKey[] = ['finance', 'lease', 'trade_in'];

export function clusterLabel(key: QuestionClusterKey): string {
  return QUESTION_CLUSTERS.find((c) => c.key === key)?.label ?? key;
}

export function clusterKeyForLabel(label: string): QuestionClusterKey | null {
  return QUESTION_CLUSTERS.find((c) => c.label === label)?.key ?? null;
}

/** Question clusters a buyer comment belongs to, each with the verbatim keyword that triggered it. */
export function questionClustersOf(item: Pick<AnalyzedComment, 'analysis' | 'conversation_intents'>): { key: QuestionClusterKey; keyword: string | null }[] {
  const d = item.analysis.detection;
  const out: { key: QuestionClusterKey; keyword: string | null }[] = [];
  const quoteOf = (code: string) => d.evidence.find((e) => e.code === code && e.source_ref === undefined)?.quote ?? null;
  for (const q of d.transaction_questions) out.push({ key: q, keyword: quoteOf(q) });
  if ((d.intent.competing_models?.length ?? 0) > 0 || item.conversation_intents.includes('model_comparison')) {
    out.push({ key: 'model_comparison', keyword: quoteOf('comparison') });
  }
  if (d.evidence.some((e) => e.code === 'product_research')) out.push({ key: 'product_research', keyword: quoteOf('product_research') });
  if (d.evidence.some((e) => e.code === 'purchase_scenario')) out.push({ key: 'purchase_scenario', keyword: quoteOf('purchase_scenario') });
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true)));
}

/** Best example first: most liked, then most recent, then shortest, then id. */
export function exampleOrder(a: AnalyzedComment, b: AnalyzedComment): number {
  return (
    b.comment.like_count - a.comment.like_count ||
    (b.comment.observed_at ?? '').localeCompare(a.comment.observed_at ?? '') ||
    Array.from(a.comment.content).length - Array.from(b.comment.content).length ||
    a.comment.platform_comment_id.localeCompare(b.comment.platform_comment_id)
  );
}

export const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

// ─────────────────────────────────────────────────────────────────────────────
// Brief persistence
// ─────────────────────────────────────────────────────────────────────────────

/** Source texts addressable by evidence source_ref. */
export function corpusSources(corpus: ResearchCorpus | null): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const n of corpus?.notes ?? []) {
    map.set(noteRef(n), [n.title, n.content]);
    for (const c of n.comments) map.set(commentRef(c), [c.content]);
  }
  return map;
}

/** Keep only evidence whose quote is verbatim in its referenced source; drop insights left without evidence. */
export function verifyInsights(insights: readonly ResearchInsight[], sources: Map<string, string[]>): { insights: ResearchInsight[]; dropped: number } {
  let dropped = 0;
  const out: ResearchInsight[] = [];
  for (const insight of insights) {
    const seen = new Set<string>();
    const evidence = insight.evidence.filter((e) => {
      if (!e.quote || !e.source_ref) {
        dropped++;
        return false;
      }
      const texts = sources.get(e.source_ref);
      if (!texts || !isVerbatimQuote(texts, e.quote)) {
        dropped++;
        return false;
      }
      // identical quotes from different sources are distinct evidence
      const k = `${e.code}|${e.source_ref}|${e.quote}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (evidence.length > 0) out.push({ ...insight, evidence });
  }
  return { insights: out, dropped };
}

export function sampleConfidence(items: number): number {
  if (items <= 0) return 0;
  return round(Math.min(0.9, 0.3 + 0.6 * (1 - Math.exp(-items / 40))), 2);
}

/**
 * Headline prefix marking synthetic data (ARCHITECTURE §7/§10.1): '【模拟数据】' when every analysed note/comment is
 * simulation data (from the simulation provider OR simulation rows already ingested into the DB), '【含模拟数据】' when
 * simulation data is mixed with other provenance, '' otherwise.
 */
export function simulationPrefix(corpus: ResearchCorpus | null): string {
  if (!corpus) return '';
  const modes = corpusDataModes(corpus);
  if (modes.simulation === 0) return '';
  const total = DATA_MODES.reduce((s, m) => s + modes[m], 0);
  return modes.simulation === total ? '【模拟数据】' : '【含模拟数据】';
}

/** Honest headline when there is nothing to analyse. */
export function noDataHeadline(scope: ResearchScope, corpus: ResearchCorpus, days: number = scope.window_days): string {
  const p = corpus.provider;
  let providerPart: string;
  if (p.search_status === 'NOT_QUERIED') providerPart = '本次未调用小红书搜索';
  else if (p.search_status !== 'AVAILABLE') providerPart = `小红书搜索不可用（${p.search_status}${p.reason ? `：${p.reason}` : ''}）`;
  else if (p.searches === 0) providerPart = `小红书搜索调用失败（${p.queries.length}次均未成功）`;
  else providerPart = `${p.searches}次小红书搜索未返回与${modelsLabel(scope)}相关的笔记`;
  return `暂无可分析的小红书公开数据：${providerPart}；数据库中近${days}天也没有与${modelsLabel(scope)}相关的帖子或评论，本简报不包含任何结论。`;
}

/** Suffix clarifying the data basis when the provider was not used successfully. */
export function dataBasisNote(corpus: ResearchCorpus): string {
  const p = corpus.provider;
  if (p.searches > 0) return '';
  if (p.search_status === 'NOT_QUERIED') return '（仅基于数据库已采集数据）';
  return `（小红书搜索当前不可用，仅基于数据库已采集数据）`;
}

export interface PersistBriefInput {
  kind: ResearchKind;
  skill: string;
  scope: ResearchScope;
  corpus: ResearchCorpus;
  findings: ResearchBrief['findings'];
  queries: readonly string[];
  /** extra addressable sources for dealer facts (offer:/inventory: refs) */
  extra_sources?: Map<string, string[]>;
  source_counts?: ResearchBrief['source_counts'];
  extra_inputs?: Record<string, unknown>;
}

/** Verify evidence, insert the brief, record the `research` decision and a `research.brief_created` event. */
export function persistBrief(ctx: AppContext, input: PersistBriefInput): ResearchBrief {
  const sources = corpusSources(input.corpus);
  for (const [k, texts] of input.extra_sources ?? []) sources.set(k, texts);
  const verified = verifyInsights(input.findings.insights, sources);
  const findings: ResearchBrief['findings'] = { ...input.findings, insights: verified.insights };
  const counts = input.source_counts ?? corpusCounts(input.corpus);
  if (!findings.headline.trim()) throw new ValidationError('findings.headline', 'headline must not be empty');
  const scope = input.scope;
  const now = ctx.clock.iso();

  return ctx.db.tx(() => {
    const brief = ctx.db.table('research_briefs').insert({
      id: newId('rb'),
      dealer_id: scope.dealer.id,
      kind: input.kind,
      scope: { models: [...scope.models], location: scope.location, window_days: scope.window_days },
      findings,
      source_counts: counts,
      engine: 'rules',
      workflow_run_id: ctx.runId,
      created_at: now,
    });
    const evidence = dedupeEvidence(findings.insights.flatMap((i) => i.evidence)).slice(0, 40);
    ctx.audit.decision({
      agent: RESEARCH_AGENT,
      skill: input.skill,
      decision_type: 'research',
      subject_type: 'research_brief',
      subject_id: brief.id,
      inputs: {
        dealer_id: scope.dealer.id,
        kind: input.kind,
        scope: brief.scope,
        explicit_models: scope.explicit_models,
        window: { from: scope.from, to: scope.to },
        lookback: input.corpus.lookback,
        queries: [...input.queries],
        provider: {
          name: input.corpus.provider.provider,
          mode: input.corpus.provider.mode,
          search_status: input.corpus.provider.search_status,
          reason: input.corpus.provider.reason,
          queries: input.corpus.provider.queries,
          notes: input.corpus.provider.notes,
          comments: input.corpus.provider.comments,
        },
        db_corpus: input.corpus.db,
        data_modes: corpusDataModes(input.corpus),
        repeated_comments_ignored: repeatedCommentRefs(input.corpus.notes).size,
        ...(input.extra_inputs ?? {}),
      },
      evidence,
      output: {
        brief_id: brief.id,
        headline: findings.headline,
        insights: findings.insights.length,
        evidence_dropped_unverified: verified.dropped,
        source_counts: counts,
      },
      confidence: sampleConfidence(counts.posts + counts.comments),
      engine: 'rules',
      workflow_run_id: ctx.runId,
    });
    ctx.audit.event({
      actor: `agent:${RESEARCH_AGENT}`,
      action: 'research.brief_created',
      entity_type: 'research_brief',
      entity_id: brief.id,
      details: { dealer_id: scope.dealer.id, kind: input.kind, headline: findings.headline, source_counts: counts },
    });
    return brief;
  });
}

export interface LatestBriefOptions {
  /** skip briefs whose corpus was empty (e.g. a run during a provider outage), so they never mask an informative one */
  with_data?: boolean;
}

/** Briefs scanned for `with_data` (a daily brief per kind stays far below this within any sensible age limit). */
const LATEST_BRIEF_SCAN = 200;

/** Latest brief of a kind for a dealer (optionally not older than `maxAgeDays`, optionally only briefs with data). */
export function latestBrief(ctx: AppContext, dealerId: string, kind: ResearchKind, maxAgeDays?: number, opts: LatestBriefOptions = {}): ResearchBrief | null {
  const since = maxAgeDays !== undefined ? new Date(ctx.clock.now().getTime() - maxAgeDays * DAY_MS).toISOString() : '';
  const rows = ctx.db
    .table('research_briefs')
    .query('dealer_id = ? AND kind = ? AND created_at >= ?', [dealerId, kind, since], {
      orderBy: 'created_at DESC, id DESC',
      limit: opts.with_data ? LATEST_BRIEF_SCAN : 1,
    });
  const hit = opts.with_data ? rows.find((b) => (b.source_counts?.posts ?? 0) + (b.source_counts?.comments ?? 0) > 0) : rows[0];
  return hit ?? null;
}

/** Output post-condition shared by the research skills. */
export function assertBriefShape(brief: ResearchBrief): void {
  if (!brief.findings.headline.trim()) throw new Error('research: empty headline');
  const c = brief.source_counts;
  if (c.posts < 0 || c.comments < 0 || c.provider_searches < 0) throw new Error('research: negative source counts');
  if (c.provider_searches > MAX_PROVIDER_QUERIES) throw new Error('research: provider search budget exceeded');
  if (c.posts === 0 && c.comments === 0 && brief.findings.insights.length > 0) throw new Error('research: insights without any corpus');
  for (const insight of brief.findings.insights) {
    if (insight.evidence.length === 0) throw new Error('research: insight without evidence');
    for (const e of insight.evidence) if (!e.quote || !e.source_ref) throw new Error('research: evidence must quote a referenced source');
  }
}
