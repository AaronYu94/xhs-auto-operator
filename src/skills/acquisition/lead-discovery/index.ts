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
import { truncate } from '../../../core/text.ts';
import {
  ACTOR_TYPES,
  SCORE_TIERS,
  type ActorType,
  type CapabilityStatus,
  type DataMode,
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
import { toCount, xhsNoteUrl, xhsProfileUrl } from '../../../providers/xhs/mcp-provider.ts';
import type { ProviderMode, XhsAuthor, XhsComment, XhsNoteDetail } from '../../../providers/xhs/types.ts';
import { defineSkill } from '../../registry.ts';
import { getDealer } from '../../operations/dealer-brain/index.ts';
import { selectQueriesToRun } from '../automotive-query-generation/intelligence.ts';
import { analyzedTextFor, prefilter } from '../intent-detection/nlu.ts';
import { upsertLeadFromSignal } from '../lead-deduplication/index.ts';
import { GroupEvaluator, groupDealerIds } from './evaluate.ts';

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
/** search window sent to the provider (xiaohongshu-mcp maps it to its coarse 半年内 filter) */
export const SEARCH_WINDOW_DAYS = 90;
export const NO_QUERIES_REASON = '没有可运行的搜索词，请先下达经营目标生成搜索词';

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
  };
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
      });
    }
    const comments = flattenComments(note.comments);
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
        });
      }
    });

    const rejectedByReason: Record<string, number> = {};
    const noteActors = emptyActorCounts();
    const rejectedSamples: Evidence[] = [];
    const noteLeads = new Set<string>();
    let noteSignals = 0;
    let noteBelow = 0;

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
      summary.by_actor_type[actor.actor_type]++;
      noteActors[actor.actor_type]++;
      if (actor.actor_type !== 'BUYER') continue;
      if (best.score < evaluator.config(best.dealer_id).thresholds.candidate) {
        summary.below_candidate++;
        noteBelow++;
        continue;
      }

      let result;
      try {
        result = upsertLeadFromSignal(ctx, {
          dealer_id: best.dealer_id,
          identity: {
            platform_user_id: uid,
            username: item.author.nickname?.trim() || uid,
            profile_url: item.author.profile_url ?? (mode === 'simulation' ? null : xhsProfileUrl(uid)),
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
            detection: { ...best.detection, actor_type: actor.actor_type },
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
      applyProvenance(ctx, result.lead.id, result.signal.id, actor.actor_type, mode);
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

const failureStatus = (status: string): Exclude<CapabilityStatus, 'AVAILABLE'> =>
  status === 'REQUIRES_AUTH' || status === 'REQUIRES_REVIEW' ? status : 'UNAVAILABLE';

function tierAtLeast(tier: ScoreTier, min: ScoreTier): boolean {
  return SCORE_TIERS.indexOf(tier) >= SCORE_TIERS.indexOf(min);
}

interface ExecutedRun {
  run: SearchRun;
  lead_ids: string[];
  block: Omit<DiscoveryBlock, 'query_id'> | null;
}

async function executeSearchQuery(ctx: AppContext, rawInput: { dealer_id: string; query_id: string; limits?: DiscoveryLimits }): Promise<ExecutedRun> {
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
    return { run: finish({ status: 'UNAVAILABLE', error: reason }, { stage: 'capability' }), lead_ids: [], block: { status, reason } };
  }

  const search = await provider.searchNotes(query.text, { sort: 'latest', limit: maxPosts, published_within_days: SEARCH_WINDOW_DAYS }, null);
  if (!search.ok) {
    const status = failureStatus(search.status);
    const reason = `${search.status}: ${search.reason}`;
    const blocking = search.status === 'UNAVAILABLE' || search.status === 'REQUIRES_AUTH';
    const done = finish({ status: blocking ? 'UNAVAILABLE' : 'FAILED', error: reason }, { stage: 'search', retryable: search.retryable === true });
    return { run: done, lead_ids: [], block: blocking ? { status, reason } : null };
  }

  const found = search.data.slice(0, maxPosts);
  const collected: IngestNote[] = [];
  const failures: { platform_post_id: string; stage: 'detail' | 'comments'; status: string; reason: string }[] = [];
  let authStop: { status: Exclude<CapabilityStatus, 'AVAILABLE'>; reason: string } | null = null;

  for (const summary of found) {
    const ref = { platform_post_id: summary.platform_post_id, xsec_token: summary.xsec_token ?? null };
    const detail = await provider.getNote(ref, null);
    if (!detail.ok) {
      failures.push({ platform_post_id: ref.platform_post_id, stage: 'detail', status: detail.status, reason: truncate(detail.reason, 300) });
      if (detail.status === 'REQUIRES_AUTH') {
        authStop = { status: 'REQUIRES_AUTH', reason: `REQUIRES_AUTH: ${detail.reason}` };
        break;
      }
      continue;
    }
    let comments: XhsComment[] = [];
    if (maxComments > 0) {
      const res = await provider.getComments(
        { platform_post_id: detail.data.platform_post_id, xsec_token: detail.data.xsec_token ?? ref.xsec_token },
        { include_replies: true, limit: maxComments },
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

  const ingestMode: IngestDataMode = mode === 'unknown' ? 'import' : mode;
  let ingest: IngestSummary | null = null;
  try {
    if (collected.length > 0) {
      ingest = await ingestPublicContent(ctx, { dealer_id: dealer.id, notes: collected, search_run_id: run.id, query_id: query.id, data_mode: ingestMode });
    }
  } catch (err) {
    const message = err instanceof AppError ? `${err.code}: ${err.message}` : ((err as Error)?.message ?? String(err));
    const done = finish(
      { status: 'FAILED', error: truncate(`ingest failed: ${message}`, 1000), posts_discovered: found.length },
      { stage: 'ingest', notes_failed: failures.length, failures: failures.slice(0, 5) },
    );
    return { run: done, lead_ids: [], block: null };
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
    notes_failed: failures.length,
    failures: failures.slice(0, 5),
    prefilter_rejected: ingest?.prefilter_rejected ?? 0,
    by_actor_type: ingest?.by_actor_type ?? emptyActorCounts(),
    signals_created: ingest?.signals_created ?? 0,
    leads_created: ingest?.leads_created ?? 0,
    leads_merged: ingest?.leads_merged ?? 0,
  };

  if (authStop) {
    return { run: finish({ ...counters, status: 'UNAVAILABLE', error: authStop.reason }, { stage: 'read', ...details }), lead_ids: leadIds, block: authStop };
  }
  if (found.length > 0 && collected.length === 0) {
    const first = failures[0];
    const error = truncate(`${found.length} 篇笔记均读取失败：${first ? `${first.status}: ${first.reason}` : 'unknown'}`, 1000);
    return { run: finish({ ...counters, status: 'FAILED', error }, { stage: 'read', ...details }), lead_ids: [], block: null };
  }
  return { run: finish({ ...counters, status: 'SUCCEEDED', error: null }, { stage: 'done', ...details }), lead_ids: leadIds, block: null };
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
 * `blocked` (a logged-out or unreachable instance must not be hammered with the remaining queries).
 */
export async function runDiscovery(ctx: AppContext, input: DiscoveryInput): Promise<DiscoveryResult> {
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
  for (const q of queries) {
    const executed = await executeSearchQuery(ctx, { dealer_id: dealer.id, query_id: q.id, limits: req.limits });
    runs.push(executed.run);
    for (const id of executed.lead_ids) touched.add(id);
    if (executed.block) {
      blocked = { ...executed.block, query_id: q.id };
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
