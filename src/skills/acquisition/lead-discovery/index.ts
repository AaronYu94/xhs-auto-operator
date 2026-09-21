/**
 * Lead discovery (spec §4, §6; ARCHITECTURE §3 lead loop, §5.3, §8 C1, §10.1–10.2).
 *
 * search query → provider search → public note detail + comments (sequential calls: a live xiaohongshu-mcp instance
 * runs one headless-browser call at a time) → public_posts / public_comments with provenance → cheap prefilter →
 * group-level intent detection + scoring → actor classification → only BUYER signals ≥ candidate become lead signals
 * (identity resolution / dedup by lead-deduplication).
 *
 * Real data first: capability states are checked before any call, provider failures become explicit run states
 * (UNAVAILABLE / FAILED with the provider's reason) and nothing is fabricated. Assignment and outreach are NOT done
 * here — the operator workflow chains them.
 */
import type { AppContext } from '../../../app/context.ts';
import { AppError, PolicyError, ValidationError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import { DAY_MS } from '../../../core/time.ts';
import { truncate } from '../../../core/text.ts';
import {
  ACTOR_TYPES,
  SCORE_TIERS,
  type ActorType,
  type CapabilityStatus,
  type DataMode,
  type Dealer,
  type Evidence,
  type PrefilterResult,
  type PublicComment,
  type PublicPost,
  type ScoreTier,
  type SearchRun,
  type SignalContext,
} from '../../../core/types.ts';
import { type Validator, v } from '../../../core/validate.ts';
import { aggregateActorType, classifyActor } from '../../../domain/actor-classification.ts';
import { getBrandInfo, isDealerAccountName } from '../../../domain/automotive-lexicon.ts';
import { toCount, xhsNoteUrl, xhsProfileUrl } from '../../../providers/xhs/mcp-provider.ts';
import type { ProviderMode, ProviderResult, XhsAuthor, XhsComment, XhsNoteDetail, XhsNoteSummary } from '../../../providers/xhs/types.ts';
import { defineSkill } from '../../registry.ts';
import { getDealer } from '../../operations/dealer-brain/index.ts';
import { selectQueriesToRun } from '../automotive-query-generation/intelligence.ts';
import { analyzedTextFor, prefilter } from '../intent-detection/nlu.ts';
import { upsertLeadFromSignal } from '../lead-deduplication/index.ts';
import { GroupEvaluator, groupDealerIds, type DealerSignalResult } from './evaluate.ts';
import { SCREEN_ROLE_ACTOR, areaLabel, inTargetArea, screenCandidates, type TargetArea } from './llm-screen.ts';

export { GroupEvaluator, groupDealerIds, type DealerSignalResult } from './evaluate.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Constants & types
// ─────────────────────────────────────────────────────────────────────────────

export const DISCOVERY_AGENT = 'lead-hunting-agent';
const SKILL = 'lead-discovery';
const ACTOR = `agent:${DISCOVERY_AGENT}`;
const PLATFORM = 'xiaohongshu';

export const DEFAULT_MAX_POSTS = 10;
export const DEFAULT_MAX_COMMENTS_PER_POST = 50;
export const DEFAULT_MAX_QUERIES = 8;
export const MAX_POSTS_CAP = 50;
export const MAX_COMMENTS_CAP = 500;
/**
 * Only fresh content is worth a lead: notes published within this many days are searched (xiaohongshu-mcp maps it to
 * its 一周内 filter; the exact window is applied when a timestamp is known) and older comments are neither screened nor
 * turned into leads. A buyer's week-old question is usually settled.
 */
export const LEAD_FRESH_DAYS = 7;
/** @deprecated kept for callers: the search window is LEAD_FRESH_DAYS */
export const SEARCH_WINDOW_DAYS = LEAD_FRESH_DAYS;
/**
 * A note fetched this recently (by any query, including an earlier one in the same batch) is not re-read: its
 * comments were ingested then, and every re-read costs a live browser page load. The next day's run reads it again.
 */
export const REFETCH_AFTER_MS = 12 * 60 * 60 * 1000;
/**
 * Search ordering and how many results are considered before choosing which notes to read. '综合' (general) surfaces
 * the discussions buyers write and comment on; '最新' (latest) is dominated by dealer stores' daily promotion posts
 * (2026-09 live capture: 13 of 17 notes). One results page (~20) is considered; the notes read are chosen from it.
 */
export const SEARCH_SORT = 'general' as const;
export const SEARCH_RESULTS_CONSIDERED = 20;

/**
 * Which search results to read (pure): notes by dealer store / sales accounts (account name, see
 * DEALER_ACCOUNT_NAME_RE) are skipped, the rest are read most-commented first — buyers ask in the comments of popular
 * discussions — keeping the platform's order among equal / unknown counts.
 */
export function selectNotesToRead<T extends XhsNoteSummary>(results: T[], maxPosts: number): { notes: T[]; skipped_seller: number } {
  const open = results.filter((n) => !isDealerAccountName(n.author?.nickname));
  const ranked = open
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (b.n.comment_count ?? -1) - (a.n.comment_count ?? -1) || a.i - b.i)
    .map((x) => x.n);
  return { notes: ranked.slice(0, maxPosts), skipped_seller: results.length - open.length };
}
export const NO_QUERIES_REASON = '没有可运行的搜索词，请先下达经营目标生成搜索词';
/**
 * A retryable search failure on a reachable, logged-in instance (e.g. a xiaohongshu-mcp tool timeout) fails only that
 * query; this many in a row stop the batch, because then the instance is likely unhealthy and should not be hammered.
 */
export const MAX_CONSECUTIVE_TRANSIENT_FAILURES = 2;

/** Policy refusals from lead-deduplication that are expected outcomes of discovery, not failures. */
const EXPECTED_POLICY_CODES = new Set(['not_a_purchase_signal', 'managed_account_identity', 'signal_identity_conflict']);

export interface DiscoveryLimits {
  max_posts?: number;
  max_comments_per_post?: number;
}

export type IngestDataMode = Exclude<DataMode, 'unknown'>;
export type IngestNote = XhsNoteDetail & { comments: XhsComment[] };

export interface IngestInput {
  dealer_id: string;
  notes: IngestNote[];
  search_run_id?: string | null;
  query_id?: string | null;
  data_mode?: IngestDataMode;
  /** where the goal wants buyers; null / absent = anywhere */
  area?: TargetArea | null;
  /** ISO time: texts published before it are stored but never screened or turned into leads */
  fresh_since?: string | null;
}

export interface IngestSummary {
  data_mode: IngestDataMode;
  posts: number;
  posts_new: number;
  comments: number;
  /** distinct non-managed authors (post authors and commenters) whose text was evaluated */
  users_evaluated: number;
  prefilter_rejected: number;
  by_actor_type: Record<ActorType, number>;
  /** BUYER signals below the candidate threshold (kept as public rows, not lead signals) */
  below_candidate: number;
  signals_created: number;
  /** distinct leads created by this ingest */
  leads_created: number;
  /** distinct pre-existing leads that received at least one new signal */
  leads_merged: number;
  /** every lead touched (created, merged or re-observed) */
  lead_ids: string[];
  public_post_ids: string[];
  skipped_managed: number;
  /** texts without an author id (cannot be attributed to a person) */
  skipped_anonymous: number;
  rejected_by_policy: number;
  /** who made the final buyer call: the LLM screen (when available) or the rules alone */
  screened_by: 'llm' | 'rules';
  /** candidates the LLM classified */
  llm_screened: number;
  /** candidates the LLM classified as owner / dealer / advice / chatter */
  llm_rejected: number;
  /** candidates left without a valid LLM verdict (call failed or output invalid): never leads */
  llm_unscreened: number;
  /** buyers outside the goal's area */
  out_of_area: number;
  /** texts published before `fresh_since` (stored, not evaluated) */
  stale_skipped: number;
  llm_model: string | null;
}

export interface DiscoveryBlock {
  status: Exclude<CapabilityStatus, 'AVAILABLE'>;
  reason: string;
  query_id: string | null;
}

export interface DiscoveryResult {
  runs: SearchRun[];
  leads_touched: string[];
  blocked: DiscoveryBlock | null;
}

/** Provenance of rows produced through a provider (ARCHITECTURE §10.1). */
export function dataModeForProvider(mode: ProviderMode): DataMode {
  switch (mode) {
    case 'live':
      return 'live';
    case 'simulation':
      return 'simulation';
    case 'manual':
      return 'manual';
    default:
      return 'unknown';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

const arrayOrEmpty =
  <T>(item: Validator<T>): Validator<T[]> =>
  (value, path = '') =>
    value === undefined || value === null ? [] : v.array(item)(value, path);

const countV: Validator<number> = (value, path = '') => {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' && typeof value !== 'string') throw new ValidationError(path, 'expected a count (number or "1.2万")');
  return toCount(value);
};

const timestampV: Validator<string | null> = (value, path = '') => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new ValidationError(path, 'expected an ISO timestamp, epoch ms or null');
  const t = typeof value === 'number' ? value : /^\d{10,13}$/.test(value.trim()) ? Number(value.trim()) : Date.parse(value);
  const ms = typeof value === 'number' || /^\d{10}$/.test(String(value).trim()) ? (t < 1e11 ? t * 1000 : t) : t;
  if (!Number.isFinite(ms)) throw new ValidationError(path, `invalid timestamp ${JSON.stringify(value)}`);
  return new Date(ms).toISOString();
};

const nullableString = v.withDefault(v.nullable(v.string()), null);

const authorV: Validator<XhsAuthor> = v.object({
  platform_user_id: nullableString,
  nickname: nullableString,
  profile_url: v.optional(v.nullable(v.string())),
});

const commentV: Validator<XhsComment> = (value, path = '') =>
  v.object({
    platform_comment_id: v.string({ min: 1 }),
    parent_comment_id: nullableString,
    author: authorV,
    content: v.string(),
    ip_location: nullableString,
    like_count: countV,
    published_at: timestampV,
    sub_comments: v.optional(arrayOrEmpty(commentV)),
    raw: v.optional(v.record(v.unknown())),
  })(value, path) as XhsComment;

const noteV: Validator<IngestNote> = v.object({
  platform_post_id: v.string({ min: 1 }),
  xsec_token: v.optional(v.nullable(v.string())),
  title: v.withDefault(v.string(), ''),
  content: v.withDefault(v.string(), ''),
  tags: arrayOrEmpty(v.string()),
  author: authorV,
  like_count: countV,
  comment_count: countV,
  collect_count: countV,
  ip_location: nullableString,
  url: v.optional(v.nullable(v.string())),
  published_at: timestampV,
  raw: v.optional(v.record(v.unknown())),
  comments: arrayOrEmpty(commentV),
}) as Validator<IngestNote>;

const dataModeV = v.literal(['live', 'simulation', 'import', 'manual'] as const);

export const ingestInputValidator: Validator<IngestInput> = v.object({
  dealer_id: v.string({ min: 1 }),
  notes: v.array(noteV),
  search_run_id: v.optional(v.nullable(v.string({ min: 1 }))),
  query_id: v.optional(v.nullable(v.string({ min: 1 }))),
  data_mode: v.optional(dataModeV),
  area: v.optional(v.nullable(v.object({ city: nullableString, province: nullableString }))),
  fresh_since: v.optional(v.nullable(v.string({ min: 1 }))),
});

const limitsV: Validator<DiscoveryLimits> = v.object({
  max_posts: v.optional(v.number({ int: true, min: 1, max: MAX_POSTS_CAP })),
  max_comments_per_post: v.optional(v.number({ int: true, min: 0, max: MAX_COMMENTS_CAP })),
});

const runSearchQueryInputV = v.object({
  dealer_id: v.string({ min: 1 }),
  query_id: v.string({ min: 1 }),
  limits: v.optional(limitsV),
});

export const discoveryInputValidator = v.object({
  dealer_id: v.string({ min: 1 }),
  goal_id: v.optional(v.nullable(v.string({ min: 1 }))),
  max_queries: v.optional(v.number({ int: true, min: 1, max: 50 })),
  limits: v.optional(limitsV),
});

export type DiscoveryInput = { dealer_id: string; goal_id?: string | null; max_queries?: number; limits?: DiscoveryLimits };

// ─────────────────────────────────────────────────────────────────────────────
// Public rows
// ─────────────────────────────────────────────────────────────────────────────

const emptyActorCounts = (): Record<ActorType, number> =>
  Object.fromEntries(ACTOR_TYPES.map((t) => [t, 0])) as Record<ActorType, number>;

/** 'live' provenance is never downgraded by a later non-live fetch of the same row. */
const mergeMode = (existing: DataMode | undefined, next: IngestDataMode): IngestDataMode => (existing === 'live' ? 'live' : next);

function managedIdentities(ctx: AppContext, groupId: string): Set<string> {
  const ids = new Set<string>();
  for (const a of ctx.db.table('xhs_accounts').findMany({ group_id: groupId })) {
    if (a.platform_account_id) ids.add(a.platform_account_id);
    if (a.platform_user_id) ids.add(a.platform_user_id);
  }
  return ids;
}

function upsertPublicPost(
  ctx: AppContext,
  note: IngestNote,
  mode: IngestDataMode,
  runId: string | null,
): { post: PublicPost; created: boolean } {
  const table = ctx.db.table('public_posts');
  const existing = table.findOne({ platform: PLATFORM, platform_post_id: note.platform_post_id });
  const own = ctx.db.table('posts').findOne({ platform_note_id: note.platform_post_id });
  const token = note.xsec_token ?? existing?.xsec_token ?? null;
  const realIds = mode !== 'simulation';
  const authorId = note.author.platform_user_id ?? existing?.author_platform_user_id ?? null;
  const row = {
    xsec_token: token,
    url: note.url ?? (realIds ? xhsNoteUrl(note.platform_post_id, token) : (existing?.url ?? null)),
    title: note.title || existing?.title || '',
    content: note.content || existing?.content || '',
    author_platform_user_id: authorId,
    author_nickname: note.author.nickname ?? existing?.author_nickname ?? null,
    author_profile_url: note.author.profile_url ?? (authorId && realIds ? xhsProfileUrl(authorId) : (existing?.author_profile_url ?? null)),
    ip_location: note.ip_location ?? existing?.ip_location ?? null,
    tags: note.tags.length > 0 ? note.tags : (existing?.tags ?? []),
    like_count: toCount(note.like_count),
    comment_count: toCount(note.comment_count),
    collect_count: toCount(note.collect_count),
    published_at: note.published_at ?? existing?.published_at ?? null,
    own_post_id: own?.id ?? existing?.own_post_id ?? null,
    fetched_at: ctx.clock.iso(),
    raw: note.raw ?? existing?.raw ?? {},
    data_mode: mergeMode(existing?.data_mode, mode),
  };
  if (existing) return { post: table.update(existing.id, row), created: false };
  return {
    post: table.insert({ id: newId('ppost'), platform: PLATFORM, platform_post_id: note.platform_post_id, first_search_run_id: runId, ...row }),
    created: true,
  };
}

function upsertPublicComment(
  ctx: AppContext,
  post: PublicPost,
  c: XhsComment,
  pf: PrefilterResult,
  mode: IngestDataMode,
  runId: string | null,
): PublicComment {
  const table = ctx.db.table('public_comments');
  const existing = table.findOne({ platform: PLATFORM, platform_comment_id: c.platform_comment_id });
  const row = {
    parent_comment_id: c.parent_comment_id ?? existing?.parent_comment_id ?? null,
    author_platform_user_id: c.author.platform_user_id ?? existing?.author_platform_user_id ?? null,
    author_nickname: c.author.nickname ?? existing?.author_nickname ?? null,
    content: c.content || existing?.content || '',
    ip_location: c.ip_location ?? existing?.ip_location ?? null,
    like_count: toCount(c.like_count),
    published_at: c.published_at ?? existing?.published_at ?? null,
    prefilter_passed: pf.passed,
    prefilter_reason: pf.reason,
    fetched_at: ctx.clock.iso(),
    raw: c.raw ?? existing?.raw ?? {},
    data_mode: mergeMode(existing?.data_mode, mode),
  };
  if (existing) return table.update(existing.id, row);
  return table.insert({
    id: newId('pcmt'),
    platform: PLATFORM,
    platform_comment_id: c.platform_comment_id,
    public_post_id: post.id,
    first_search_run_id: runId,
    ...row,
  });
}

/** Flatten nested sub_comments (xiaohongshu-mcp without include_replies flattening) and drop repeated ids. */
function flattenComments(list: readonly XhsComment[]): XhsComment[] {
  const out: XhsComment[] = [];
  const seen = new Set<string>();
  const walk = (c: XhsComment, parentId: string | null) => {
    if (!seen.has(c.platform_comment_id)) {
      seen.add(c.platform_comment_id);
      const { sub_comments: _subs, ...flat } = c;
      out.push({ ...flat, parent_comment_id: c.parent_comment_id ?? parentId });
    }
    for (const s of c.sub_comments ?? []) walk(s, c.platform_comment_id);
  };
  for (const c of list) walk(c, null);
  return out;
}

/** After lead-deduplication stored a signal: actor type on signal + lead, and lead provenance (§10.1–10.2). */
function applyProvenance(ctx: AppContext, leadId: string, signalId: string, actor: ActorType, mode: IngestDataMode): void {
  ctx.db.tx(() => {
    const signals = ctx.db.table('lead_signals');
    const leads = ctx.db.table('leads');
    signals.update(signalId, { actor_type: actor });
    const lead = leads.require(leadId);
    const rows = signals.findMany({ lead_id: leadId }, { orderBy: 'signal_at ASC, created_at ASC' });
    const industry = lead.evidence.some((e) => e.code === 'industry_account');
    const actorType = aggregateActorType(
      rows.map((r) => r.actor_type ?? null),
      { industry_account: industry },
    );
    const current = lead.data_mode ?? 'unknown';
    const dataMode: DataMode = current === 'live' || mode === 'live' ? 'live' : current === 'unknown' ? mode : current;
    if (actorType !== lead.actor_type || dataMode !== current) leads.update(leadId, { actor_type: actorType, data_mode: dataMode });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingestion
// ─────────────────────────────────────────────────────────────────────────────

interface TextItem {
  source_type: 'post' | 'comment';
  author: XhsAuthor;
  /** exact text stored as the signal content (posts: title + '\n' + content) */
  content: string;
  /** text handed to the NLU (posts: content; the NLU prepends the title from context) */
  nlu_text: string;
  context: SignalContext;
  signal_at: string;
  comment: PublicComment | null;
  prefilter: PrefilterResult;
  /** text of the comment this one replies to (context for the LLM screen) */
  reply_to: string | null;
}

/**
 * Persist public notes/comments with provenance and turn BUYER signals into lead signals.
 * Also the manual JSON import path (data_mode defaults to 'import' when no search run is given).
 */
export async function ingestPublicContent(ctx: AppContext, input: IngestInput): Promise<IngestSummary> {
  const req = ingestInputValidator(input, 'input');
  const dealer = getDealer(ctx, req.dealer_id);
  const run = req.search_run_id ? ctx.db.table('search_runs').get(req.search_run_id) : undefined;
  if (req.search_run_id && !run) throw new ValidationError('input.search_run_id', `search run not found: ${req.search_run_id}`);
  if (run && run.dealer_id !== dealer.id) throw new ValidationError('input.search_run_id', 'search run belongs to another dealer');
  const runMode = run?.data_mode && run.data_mode !== 'unknown' ? run.data_mode : null;
  const mode: IngestDataMode = req.data_mode ?? runMode ?? 'import';
  const runId = run?.id ?? null;
  const queryId = req.query_id ?? run?.query_id ?? null;

  const managed = managedIdentities(ctx, dealer.group_id);
  const evaluator = new GroupEvaluator(ctx, groupDealerIds(ctx, dealer.id));
  const summary: IngestSummary = {
    data_mode: mode,
    posts: 0,
    posts_new: 0,
    comments: 0,
    users_evaluated: 0,
    prefilter_rejected: 0,
    by_actor_type: emptyActorCounts(),
    below_candidate: 0,
    signals_created: 0,
    leads_created: 0,
    leads_merged: 0,
    lead_ids: [],
    public_post_ids: [],
    skipped_managed: 0,
    skipped_anonymous: 0,
    rejected_by_policy: 0,
    screened_by: ctx.llm.status().status === 'AVAILABLE' ? 'llm' : 'rules',
    llm_screened: 0,
    llm_rejected: 0,
    llm_unscreened: 0,
    out_of_area: 0,
    stale_skipped: 0,
    llm_model: null,
  };
  const llmOn = summary.screened_by === 'llm';
  const area = req.area ?? null;
  const freshSince = req.fresh_since ?? null;
  const brands = dealer.brands.map((b) => getBrandInfo(b)?.brand_zh ?? b);
  const users = new Set<string>();
  const touched = new Set<string>();
  const created = new Set<string>();
  const merged = new Set<string>();

  for (const note of req.notes) {
    const { post, created: postCreated } = ctx.db.tx(() => upsertPublicPost(ctx, note, mode, runId));
    summary.posts++;
    if (postCreated) summary.posts_new++;
    summary.public_post_ids.push(post.id);

    const postContext = { post_title: post.title, post_content: post.content };
    const items: TextItem[] = [];
    if (note.title.trim() || note.content.trim()) {
      const context: SignalContext = {
        source_type: 'post',
        ...postContext,
        ip_location: note.ip_location,
        author_nickname: note.author.nickname,
      };
      items.push({
        source_type: 'post',
        author: note.author,
        content: analyzedTextFor(note.content, context),
        nlu_text: note.content,
        context,
        signal_at: note.published_at ?? ctx.clock.iso(),
        comment: null,
        prefilter: prefilter(note.content, context),
        reply_to: null,
      });
    }
    const comments = flattenComments(note.comments);
    const commentText = new Map(comments.map((c) => [c.platform_comment_id, c.content]));
    ctx.db.tx(() => {
      for (const c of comments) {
        const context: SignalContext = { source_type: 'comment', ...postContext, ip_location: c.ip_location, author_nickname: c.author.nickname };
        const pf = prefilter(c.content, context);
        const row = upsertPublicComment(ctx, post, c, pf, mode, runId);
        summary.comments++;
        items.push({
          source_type: 'comment',
          author: c.author,
          content: c.content,
          nlu_text: c.content,
          context,
          signal_at: c.published_at ?? ctx.clock.iso(),
          comment: row,
          prefilter: pf,
          reply_to: c.parent_comment_id ? (commentText.get(c.parent_comment_id) ?? null) : null,
        });
      }
    });

    const rejectedByReason: Record<string, number> = {};
    const noteActors = emptyActorCounts();
    const rejectedSamples: Evidence[] = [];
    const noteLeads = new Set<string>();
    let noteSignals = 0;
    let noteBelow = 0;
    const noteScreen = { stale: 0, candidates: 0, buyers: 0, rejected: {} as Record<string, number>, unscreened: 0, out_of_area: 0, failures: [] as string[] };
    const candidates: { item: TextItem; best: DealerSignalResult; actor: ActorType }[] = [];

    for (const item of items) {
      const uid = item.author.platform_user_id;
      if (!uid) {
        summary.skipped_anonymous++;
        continue;
      }
      if (managed.has(uid)) {
        summary.skipped_managed++;
        continue;
      }
      if (freshSince && Date.parse(item.signal_at) < Date.parse(freshSince)) {
        summary.stale_skipped++;
        noteScreen.stale++;
        continue;
      }
      users.add(uid);

      if (!item.prefilter.passed) {
        summary.prefilter_rejected++;
        rejectedByReason[item.prefilter.reason] = (rejectedByReason[item.prefilter.reason] ?? 0) + 1;
        const actor: ActorType = item.prefilter.is_marketing ? 'DEALER_OR_SALES' : 'UNKNOWN';
        summary.by_actor_type[actor]++;
        noteActors[actor]++;
        const quote = truncate(item.content.trim(), 40);
        if (rejectedSamples.length < 5 && quote && item.content.includes(quote)) {
          rejectedSamples.push({
            code: item.prefilter.reason,
            label: `预过滤未通过（${item.prefilter.reason}）`,
            quote,
            source_ref: item.comment?.id ?? post.id,
          });
        }
        continue;
      }

      const evaluation = evaluator.evaluate(item.nlu_text, item.context, item.signal_at, item.prefilter, dealer.id);
      if (!evaluation) continue;
      const { best } = evaluation;
      const actor = classifyActor(best.detection, item.prefilter);
      if (actor.actor_type !== 'BUYER' || best.score < evaluator.config(best.dealer_id).thresholds.candidate) {
        summary.by_actor_type[actor.actor_type]++;
        noteActors[actor.actor_type]++;
        if (actor.actor_type === 'BUYER') {
          summary.below_candidate++;
          noteBelow++;
        }
        continue;
      }
      candidates.push({ item, best, actor: actor.actor_type });
    }

    // The rules only nominate: with an LLM, a candidate is a buyer only if the LLM screen says so (llm-screen.ts).
    noteScreen.candidates = candidates.length;
    const screen =
      llmOn && candidates.length > 0
        ? await screenCandidates(
            ctx,
            { title: post.title, content: post.content },
            candidates.map((c, i) => ({
              id: `i${i}`,
              source_type: c.item.source_type,
              text: c.item.content,
              author_nickname: c.item.author.nickname ?? null,
              ip_location: c.item.context.ip_location ?? null,
              reply_to: c.item.reply_to,
            })),
            brands,
          )
        : null;
    if (screen) {
      summary.llm_model = screen.model ?? summary.llm_model;
      noteScreen.failures = screen.failures.slice(0, 3);
    }

    for (const [idx, cand] of candidates.entries()) {
      const { item, best } = cand;
      const uid = item.author.platform_user_id as string;
      let actorType: ActorType = cand.actor;
      let detection = best.detection;
      let stated: string | null = null;
      if (llmOn) {
        const verdict = screen?.verdicts.get(`i${idx}`);
        if (!verdict) {
          summary.llm_unscreened++;
          noteScreen.unscreened++;
          summary.by_actor_type.UNKNOWN++;
          noteActors.UNKNOWN++;
          continue;
        }
        summary.llm_screened++;
        actorType = SCREEN_ROLE_ACTOR[verdict.role];
        if (verdict.role !== 'buyer') {
          summary.llm_rejected++;
          noteScreen.rejected[verdict.role] = (noteScreen.rejected[verdict.role] ?? 0) + 1;
          summary.by_actor_type[actorType]++;
          noteActors[actorType]++;
          continue;
        }
        detection = { ...detection, evidence: [...detection.evidence, { code: 'llm_screen', label: `大模型复核：${verdict.reason}`, quote: verdict.quote }] };
        stated = verdict.location;
      }
      summary.by_actor_type[actorType]++;
      noteActors[actorType]++;
      const where = inTargetArea(area, item.context.ip_location ?? null, stated);
      if (!where.inside) {
        summary.out_of_area++;
        noteScreen.out_of_area++;
        continue;
      }
      noteScreen.buyers++;

      let result;
      try {
        result = upsertLeadFromSignal(ctx, {
          dealer_id: best.dealer_id,
          identity: {
            platform_user_id: uid,
            username: item.author.nickname?.trim() || uid,
            profile_url: item.author.profile_url ?? (mode === 'simulation' ? null : xhsProfileUrl(uid)),
            avatar_url: item.author.avatar_url ?? null,
          },
          signal: {
            source_type: item.source_type,
            public_post_id: item.comment ? item.comment.public_post_id : post.id,
            public_comment_id: item.comment?.id ?? null,
            post_title: post.title || null,
            content: item.content,
            signal_at: item.signal_at,
            search_run_id: runId,
            query_id: queryId,
            detection: { ...detection, actor_type: actorType },
          },
          attributed_post_id: post.own_post_id,
        });
      } catch (err) {
        if (err instanceof PolicyError && EXPECTED_POLICY_CODES.has(err.code)) {
          summary.rejected_by_policy++;
          continue;
        }
        throw err;
      }

      touched.add(result.lead.id);
      noteLeads.add(result.lead.id);
      if (result.duplicate || !result.signal) continue;
      summary.signals_created++;
      noteSignals++;
      if (result.created) created.add(result.lead.id);
      else if (!created.has(result.lead.id)) merged.add(result.lead.id);
      applyProvenance(ctx, result.lead.id, result.signal.id, actorType, mode);
    }

    ctx.audit.decision({
      agent: DISCOVERY_AGENT,
      skill: SKILL,
      decision_type: 'lead_prefilter',
      subject_type: 'public_post',
      subject_id: post.id,
      inputs: {
        platform_post_id: post.platform_post_id,
        title: post.title,
        url: post.url,
        data_mode: mode,
        search_run_id: runId,
        query_id: queryId,
        texts: items.length,
        comments: comments.length,
      },
      evidence: rejectedSamples,
      output: {
        prefilter_rejected: rejectedByReason,
        by_actor_type: noteActors,
        below_candidate: noteBelow,
        signals_created: noteSignals,
        lead_ids: [...noteLeads],
        screen: { by: summary.screened_by, target_area: areaLabel(area), ...noteScreen },
      },
      confidence: 1,
      engine: 'rules',
    });
  }

  summary.users_evaluated = users.size;
  summary.lead_ids = [...touched];
  summary.leads_created = created.size;
  summary.leads_merged = merged.size;
  if (!runId) {
    ctx.audit.event({
      actor: ACTOR,
      action: 'public_content.ingested',
      entity_type: 'dealer',
      entity_id: dealer.id,
      details: { ...summary, lead_ids: summary.lead_ids.slice(0, 50), public_post_ids: summary.public_post_ids.slice(0, 50) },
    });
  }
  return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search runs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the query's goal wants buyers: the goal's place, else the store's city / province; `null` when the goal said
 * 全国 (GoalSpec.nationwide). Queries without a goal serve the store's own area.
 */
export function targetAreaFor(ctx: AppContext, dealer: Dealer, goalId: string | null): TargetArea | null {
  const spec = goalId ? ctx.db.table('operator_goals').get(goalId)?.spec : undefined;
  if (spec?.nationwide) return null;
  const city = spec?.location ?? (spec?.province ? null : dealer.city) ?? null;
  const province = spec?.province ?? (spec?.location ? null : dealer.province) ?? null;
  return city || province ? { city, province } : null;
}

const failureStatus = (status: string): Exclude<CapabilityStatus, 'AVAILABLE'> =>
  status === 'REQUIRES_AUTH' || status === 'REQUIRES_REVIEW' ? status : 'UNAVAILABLE';

function tierAtLeast(tier: ScoreTier, min: ScoreTier): boolean {
  return SCORE_TIERS.indexOf(tier) >= SCORE_TIERS.indexOf(min);
}

interface ExecutedRun {
  run: SearchRun;
  lead_ids: string[];
  block: Omit<DiscoveryBlock, 'query_id'> | null;
  /** the search itself failed transiently (retryable UNAVAILABLE): only this query failed */
  transient: boolean;
}

/** Live progress of one search query (see DiscoveryProgress). */
export interface QueryProgress {
  phase: 'search' | 'read' | 'screen';
  notes_total: number;
  notes_done: number;
}

/** Live progress of a discovery batch, reported while it runs (workflow step `progress`). */
export interface DiscoveryProgress extends QueryProgress {
  queries_total: number;
  /** 1-based index of the query being run */
  query_index: number;
  query_text: string;
  /** totals of the queries already finished in this batch */
  done: { posts: number; comments: number; qualified: number };
}

async function executeSearchQuery(
  ctx: AppContext,
  rawInput: { dealer_id: string; query_id: string; limits?: DiscoveryLimits },
  onProgress: (p: QueryProgress) => void = () => {},
): Promise<ExecutedRun> {
  const req = runSearchQueryInputV(rawInput, 'input');
  const dealer = getDealer(ctx, req.dealer_id);
  const query = ctx.db.table('search_queries').get(req.query_id);
  if (!query) throw new ValidationError('input.query_id', `search query not found: ${req.query_id}`);
  if (query.dealer_id !== dealer.id) throw new ValidationError('input.query_id', 'search query belongs to another dealer');
  const maxPosts = req.limits?.max_posts ?? DEFAULT_MAX_POSTS;
  const maxComments = req.limits?.max_comments_per_post ?? DEFAULT_MAX_COMMENTS_PER_POST;
  const provider = ctx.xhs;
  const mode = dataModeForProvider(provider.mode);
  const runs = ctx.db.table('search_runs');

  const run = runs.insert({
    id: newId('run'),
    query_id: query.id,
    dealer_id: dealer.id,
    workflow_run_id: ctx.runId,
    provider: provider.name,
    status: 'RUNNING',
    posts_discovered: 0,
    posts_new: 0,
    comments_scanned: 0,
    users_evaluated: 0,
    candidates: 0,
    qualified: 0,
    high_intent: 0,
    error: null,
    started_at: ctx.clock.iso(),
    finished_at: null,
    data_mode: mode,
  });

  const finish = (patch: Partial<SearchRun>, details: Record<string, unknown>): SearchRun => {
    const done = runs.update(run.id, { ...patch, finished_at: ctx.clock.iso() });
    ctx.audit.event({
      actor: ACTOR,
      action: done.status === 'UNAVAILABLE' ? 'search_run.unavailable' : 'search_run.completed',
      entity_type: 'search_run',
      entity_id: run.id,
      details: {
        query_id: query.id,
        query_text: query.text,
        provider: provider.name,
        data_mode: mode,
        status: done.status,
        error: done.error,
        posts_discovered: done.posts_discovered,
        posts_new: done.posts_new,
        comments_scanned: done.comments_scanned,
        users_evaluated: done.users_evaluated,
        candidates: done.candidates,
        qualified: done.qualified,
        high_intent: done.high_intent,
        ...details,
      },
    });
    return done;
  };

  let capability: { status: CapabilityStatus; reason: string };
  try {
    capability = (await provider.capabilities(null)).capabilities.search_public_content;
  } catch (err) {
    capability = { status: 'UNAVAILABLE', reason: `capability check failed: ${(err as Error)?.message ?? String(err)}` };
  }
  if (capability.status !== 'AVAILABLE') {
    const status = failureStatus(capability.status);
    const reason = `${capability.status}: ${capability.reason}`;
    return { run: finish({ status: 'UNAVAILABLE', error: reason }, { stage: 'capability' }), lead_ids: [], block: { status, reason }, transient: false };
  }

  const searchOpts = { sort: SEARCH_SORT, limit: Math.max(maxPosts, SEARCH_RESULTS_CONSIDERED), published_within_days: LEAD_FRESH_DAYS } as const;
  let search = await provider.searchNotes(query.text, searchOpts, null);
  // A retryable search failure is usually the search page not being ready (filter panel, slow render): reading is safe
  // to repeat, so one more attempt before the query counts as failed.
  if (!search.ok && search.status === 'UNAVAILABLE' && search.retryable === true) {
    search = await provider.searchNotes(query.text, searchOpts, null);
  }
  if (!search.ok) {
    const status = failureStatus(search.status);
    const reason = `${search.status}: ${search.reason}`;
    // The capability check just passed and the provider re-verifies the login after a failed read, so a retryable
    // UNAVAILABLE here is a transient tool failure (timeout) of this query, not an unreachable or logged-out instance.
    const transient = search.status === 'UNAVAILABLE' && search.retryable === true;
    const blocking = !transient && (search.status === 'UNAVAILABLE' || search.status === 'REQUIRES_AUTH');
    const done = finish({ status: blocking ? 'UNAVAILABLE' : 'FAILED', error: reason }, { stage: 'search', retryable: search.retryable === true });
    return { run: done, lead_ids: [], block: blocking ? { status, reason } : null, transient };
  }

  const selection = selectNotesToRead(search.data, maxPosts);
  const found = selection.notes;
  const collected: IngestNote[] = [];
  const failures: { platform_post_id: string; stage: 'detail' | 'comments'; status: string; reason: string }[] = [];
  let authStop: { status: Exclude<CapabilityStatus, 'AVAILABLE'>; reason: string } | null = null;

  const refetchCutoff = new Date(ctx.clock.now().getTime() - REFETCH_AFTER_MS).toISOString();
  const toRead = found.filter(
    (n) => !ctx.db.get('SELECT 1 FROM public_posts WHERE platform = ? AND platform_post_id = ? AND fetched_at >= ?', PLATFORM, n.platform_post_id, refetchCutoff),
  );
  const commentOpts = { include_replies: true, limit: maxComments };
  // One page load per note when the provider supports it (detail + comments together).
  const combined = maxComments > 0 && typeof provider.getNoteWithComments === 'function';

  onProgress({ phase: 'read', notes_total: toRead.length, notes_done: 0 });
  for (const [noteIdx, summary] of toRead.entries()) {
    if (noteIdx > 0) onProgress({ phase: 'read', notes_total: toRead.length, notes_done: noteIdx });
    const ref = { platform_post_id: summary.platform_post_id, xsec_token: summary.xsec_token ?? null };
    const both = combined ? await provider.getNoteWithComments!(ref, commentOpts, null) : null;
    const detail: ProviderResult<XhsNoteDetail> = both ? (both.ok ? { ok: true, data: both.data.note } : both) : await provider.getNote(ref, null);
    if (!detail.ok) {
      failures.push({ platform_post_id: ref.platform_post_id, stage: 'detail', status: detail.status, reason: truncate(detail.reason, 300) });
      if (detail.status === 'REQUIRES_AUTH') {
        authStop = { status: 'REQUIRES_AUTH', reason: `REQUIRES_AUTH: ${detail.reason}` };
        break;
      }
      continue;
    }
    let comments: XhsComment[] = both?.ok ? both.data.comments : [];
    if (!combined && maxComments > 0) {
      const res = await provider.getComments(
        { platform_post_id: detail.data.platform_post_id, xsec_token: detail.data.xsec_token ?? ref.xsec_token },
        commentOpts,
        null,
      );
      if (res.ok) comments = res.data;
      else {
        failures.push({ platform_post_id: ref.platform_post_id, stage: 'comments', status: res.status, reason: truncate(res.reason, 300) });
        if (res.status === 'REQUIRES_AUTH') authStop = { status: 'REQUIRES_AUTH', reason: `REQUIRES_AUTH: ${res.reason}` };
      }
    }
    collected.push({ ...detail.data, url: detail.data.url ?? summary.url ?? null, comments });
    if (authStop) break;
  }

  onProgress({ phase: 'screen', notes_total: toRead.length, notes_done: collected.length });
  const ingestMode: IngestDataMode = mode === 'unknown' ? 'import' : mode;
  let ingest: IngestSummary | null = null;
  try {
    if (collected.length > 0) {
      ingest = await ingestPublicContent(ctx, {
        dealer_id: dealer.id,
        notes: collected,
        search_run_id: run.id,
        query_id: query.id,
        data_mode: ingestMode,
        area: targetAreaFor(ctx, dealer, query.goal_id),
        fresh_since: new Date(ctx.clock.now().getTime() - LEAD_FRESH_DAYS * DAY_MS).toISOString(),
      });
    }
  } catch (err) {
    const message = err instanceof AppError ? `${err.code}: ${err.message}` : ((err as Error)?.message ?? String(err));
    const done = finish(
      { status: 'FAILED', error: truncate(`ingest failed: ${message}`, 1000), posts_discovered: found.length },
      { stage: 'ingest', notes_failed: failures.length, failures: failures.slice(0, 5) },
    );
    return { run: done, lead_ids: [], block: null, transient: false };
  }

  const leadIds = ingest?.lead_ids ?? [];
  const leadRows = leadIds.map((id) => ctx.db.table('leads').get(id)).filter((l) => l !== undefined);
  const counters = {
    posts_discovered: found.length,
    posts_new: ingest?.posts_new ?? 0,
    comments_scanned: ingest?.comments ?? 0,
    users_evaluated: ingest?.users_evaluated ?? 0,
    candidates: leadRows.filter((l) => tierAtLeast(l.tier, 'candidate')).length,
    qualified: leadRows.filter((l) => tierAtLeast(l.tier, 'qualified')).length,
    high_intent: leadRows.filter((l) => tierAtLeast(l.tier, 'high_intent')).length,
  };
  const details = {
    notes_fetched: collected.length,
    notes_skipped_recent: found.length - toRead.length,
    search_results: search.data.length,
    notes_skipped_seller: selection.skipped_seller,
    notes_failed: failures.length,
    failures: failures.slice(0, 5),
    prefilter_rejected: ingest?.prefilter_rejected ?? 0,
    by_actor_type: ingest?.by_actor_type ?? emptyActorCounts(),
    signals_created: ingest?.signals_created ?? 0,
    leads_created: ingest?.leads_created ?? 0,
    leads_merged: ingest?.leads_merged ?? 0,
  };

  if (authStop) {
    return { run: finish({ ...counters, status: 'UNAVAILABLE', error: authStop.reason }, { stage: 'read', ...details }), lead_ids: leadIds, block: authStop, transient: false };
  }
  if (toRead.length > 0 && collected.length === 0) {
    const first = failures[0];
    const error = truncate(`${toRead.length} 篇笔记均读取失败：${first ? `${first.status}: ${first.reason}` : 'unknown'}`, 1000);
    return { run: finish({ ...counters, status: 'FAILED', error }, { stage: 'read', ...details }), lead_ids: [], block: null, transient: false };
  }
  return { run: finish({ ...counters, status: 'SUCCEEDED', error: null }, { stage: 'done', ...details }), lead_ids: leadIds, block: null, transient: false };
}

/** Run one stored search query through the provider and ingest what it returns (never throws for provider failures). */
export async function runSearchQuery(
  ctx: AppContext,
  input: { dealer_id: string; query_id: string; limits?: DiscoveryLimits },
): Promise<SearchRun> {
  return (await executeSearchQuery(ctx, input)).run;
}

/**
 * Run the dealer's next queries sequentially. Stops at the first UNAVAILABLE / REQUIRES_AUTH run and reports it as
 * `blocked` (a logged-out or unreachable instance must not be hammered with the remaining queries). A transient search
 * failure (retryable, e.g. a tool timeout) only fails its own query; MAX_CONSECUTIVE_TRANSIENT_FAILURES in a row block.
 */
export async function runDiscovery(ctx: AppContext, input: DiscoveryInput, onProgress: (p: DiscoveryProgress) => void = () => {}): Promise<DiscoveryResult> {
  const req = discoveryInputValidator(input, 'input');
  const dealer = getDealer(ctx, req.dealer_id);
  const queries = selectQueriesToRun(ctx, dealer.id, req.max_queries ?? DEFAULT_MAX_QUERIES, req.goal_id ?? null);
  if (queries.length === 0) {
    const blocked: DiscoveryBlock = { status: 'UNAVAILABLE', reason: NO_QUERIES_REASON, query_id: null };
    ctx.audit.event({ actor: ACTOR, action: 'discovery.blocked', entity_type: 'dealer', entity_id: dealer.id, details: { ...blocked, goal_id: req.goal_id ?? null } });
    return { runs: [], leads_touched: [], blocked };
  }

  const runs: SearchRun[] = [];
  const touched = new Set<string>();
  let blocked: DiscoveryBlock | null = null;
  let transientInARow = 0;
  for (const q of queries) {
    const done = runs.reduce((t, r) => ({ posts: t.posts + r.posts_discovered, comments: t.comments + r.comments_scanned, qualified: t.qualified + r.qualified }), {
      posts: 0,
      comments: 0,
      qualified: 0,
    });
    const report = (p: QueryProgress) => onProgress({ ...p, queries_total: queries.length, query_index: runs.length + 1, query_text: q.text, done });
    report({ phase: 'search', notes_total: 0, notes_done: 0 });
    const executed = await executeSearchQuery(ctx, { dealer_id: dealer.id, query_id: q.id, limits: req.limits }, report);
    runs.push(executed.run);
    for (const id of executed.lead_ids) touched.add(id);
    transientInARow = executed.transient ? transientInARow + 1 : 0;
    const block =
      executed.block ??
      (transientInARow >= MAX_CONSECUTIVE_TRANSIENT_FAILURES
        ? { status: 'UNAVAILABLE' as const, reason: `连续 ${transientInARow} 个搜索词都失败了，其余搜索词本次暂停：${executed.run.error ?? ''}` }
        : null);
    if (block) {
      blocked = { ...block, query_id: q.id };
      ctx.audit.event({
        actor: ACTOR,
        action: 'discovery.blocked',
        entity_type: 'dealer',
        entity_id: dealer.id,
        details: { ...blocked, runs_completed: runs.length, queries_skipped: queries.length - runs.length, goal_id: req.goal_id ?? null },
      });
      break;
    }
  }
  return { runs, leads_touched: [...touched], blocked };
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill
// ─────────────────────────────────────────────────────────────────────────────

export const skill = defineSkill<DiscoveryInput, DiscoveryResult>({
  name: 'lead-discovery',
  category: 'acquisition',
  agent: 'lead-hunting-agent',
  description:
    '按搜索词调用小红书服务搜索公开笔记与评论，保存来源（真实/模拟/导入），先廉价预过滤，再按集团门店识别意向、评分并判定发帖人身份；只有潜在买家信号进入线索去重。',
  input: discoveryInputValidator as Validator<DiscoveryInput>,
  run: (ctx, input) => runDiscovery(ctx, input),
});
