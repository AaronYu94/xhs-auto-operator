import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Clock } from '../../core/clock.ts';
import { ValidationError } from '../../core/errors.ts';
import { meaningfulChars, normalizeText, stripEmoji } from '../../core/text.ts';
import { DAY_MS } from '../../core/time.ts';
import type { XhsCapability } from '../../core/types.ts';
import { v, type Validator } from '../../core/validate.ts';
import { xhsNoteUrl, xhsProfileUrl } from './mcp-provider.ts';
import type {
  CapabilityReport,
  CapabilityState,
  ProviderFailure,
  ProviderMode,
  ProviderResult,
  XhsComment,
  XhsCommentOptions,
  XhsCommentReplyRef,
  XhsEngagement,
  XhsInboundMessage,
  XhsNoteDetail,
  XhsNoteRef,
  XhsNoteSummary,
  XhsProvider,
  XhsPublishDraft,
  XhsPublishResult,
  XhsSearchOptions,
  XhsSendResult,
  XhsUserProfile,
  XhsUserRef,
} from './types.ts';
import { buildReport } from './unavailable.ts';

/**
 * Simulation Xiaohongshu provider — for automated tests and demos ONLY (mode 'simulation').
 *
 * Serves a synthetic corpus of public notes/comments/profiles. Write-like capabilities are OFF by
 * default so the simulation mirrors the real platform's constraints (no authorized DM API); they can
 * be switched on explicitly to demo the full loop. Content whose timestamp lies after clock.now()
 * is not yet "published" and stays invisible.
 */

export interface SimAuthor {
  platform_user_id: string;
  nickname: string;
}

export interface SimComment {
  platform_comment_id: string;
  author: SimAuthor;
  content: string;
  ip_location: string | null;
  like_count: number;
  published_at: string;
  /** optional explicit parent (e.g. a reply to a reply in the same thread); defaults to the enclosing comment */
  parent_comment_id?: string | null;
  sub_comments: SimComment[];
}

export interface SimNote {
  platform_post_id: string;
  xsec_token: string;
  title: string;
  content: string;
  tags: string[];
  keywords: string[];
  author: SimAuthor;
  ip_location: string | null;
  like_count: number;
  comment_count: number;
  collect_count: number;
  published_at: string;
  comments: SimComment[];
}

export interface SimProfile {
  platform_user_id: string;
  nickname: string;
  bio: string | null;
  ip_location: string | null;
  follower_count: number | null;
  note_count: number | null;
  recent_note_ids: string[];
}

export interface SimInboxScript {
  from_user_id: string;
  /**
   * Explicit target account (platform id, or internal id), or null = replies to the managed account
   * that contacted the user FIRST (one conversation owner; never duplicated across accounts).
   */
  to_account_platform_id: string | null;
  /** minutes after the (first) contact by the receiving account */
  delay_minutes: number;
  content: string;
}

export interface SimulationCorpus {
  notes: SimNote[];
  profiles: SimProfile[];
  inbox_scripts: SimInboxScript[];
}

export interface SimulationOptions {
  /** default false → send_messages UNAVAILABLE (mirrors the live platform: no authorized DM API) */
  send_messages?: boolean;
  publish?: boolean;
  /** scripted inbox replies */
  receive_messages?: boolean;
  reply_comments?: boolean;
  /** platform account ids or internal account ids whose session "requires login" */
  auth_required_accounts?: string[];
  /** shift every corpus timestamp so the newest = clock.now() − 1h (computed at construction) */
  rebase_to_now?: boolean;
  /** internal account id → platform account id (resolves inbox script targets and published note authors) */
  account_platform_ids?: Record<string, string>;
  /** optional namespace inserted into generated ids ('sim-msg-<ns>-<n>') for persistent demo databases */
  id_namespace?: string;
}

export interface SimSentMessage {
  account_id: string;
  to: string;
  text: string;
  at: string;
  provider_message_id: string;
}

export interface SimSentReply {
  account_id: string;
  platform_post_id: string;
  platform_comment_id: string;
  text: string;
  at: string;
  provider_message_id: string;
}

export const DEFAULT_SIMULATION_CORPUS_PATH = fileURLToPath(
  new URL('../../../fixtures/xhs/simulation-corpus.json', import.meta.url),
);

const SIM_TAG = '[simulation]';
export const SIMULATION_DISABLED_REASONS: Record<'send_messages' | 'receive_messages' | 'publish_content' | 'reply_comments', string> = {
  send_messages: `${SIM_TAG} send_messages disabled — mirrors the live platform: Xiaohongshu offers no authorized API for sending DMs to users (enable the send_messages option only for demos/tests)`,
  receive_messages: `${SIM_TAG} receive_messages disabled — mirrors the live platform: no DM inbox API (official DM access only via 私信通 / approved 三方客服 vendors); enable receive_messages for the scripted inbox`,
  publish_content: `${SIM_TAG} publishing disabled in this simulation (enable the publish option)`,
  reply_comments: `${SIM_TAG} comment replies disabled in this simulation (enable the reply_comments option)`,
};

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const DEFAULT_COMMENT_LIMIT = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Corpus validation
// ─────────────────────────────────────────────────────────────────────────────

const isoV: Validator<string> = (value, path = '') => {
  const s = v.string({ min: 10 })(value, path);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new ValidationError(path, `invalid ISO timestamp ${JSON.stringify(s)}`);
  return new Date(t).toISOString();
};
const countV = v.number({ int: true, min: 0 });
const authorV = v.object({ platform_user_id: v.string({ min: 1 }), nickname: v.string() });

/** Array with a FRESH empty default per parse (v.withDefault would share one array instance across corpora). */
const arrayOrEmpty =
  <T>(item: Validator<T>): Validator<T[]> =>
  (value, path = '') =>
    value === undefined ? [] : v.array(item)(value, path);

const commentV: Validator<SimComment> = (value, path = '') =>
  v.object({
    platform_comment_id: v.string({ min: 1 }),
    author: authorV,
    content: v.string(),
    ip_location: v.withDefault(v.nullable(v.string()), null),
    like_count: v.withDefault(countV, 0),
    published_at: isoV,
    parent_comment_id: v.optional(v.nullable(v.string({ min: 1 }))),
    sub_comments: arrayOrEmpty(commentV),
  })(value, path) as SimComment;

const noteV: Validator<SimNote> = (value, path = '') =>
  v.object({
    platform_post_id: v.string({ min: 1 }),
    xsec_token: v.string({ min: 1 }),
    title: v.string(),
    content: v.string(),
    tags: arrayOrEmpty(v.string()),
    keywords: arrayOrEmpty(v.string()),
    author: authorV,
    ip_location: v.withDefault(v.nullable(v.string()), null),
    like_count: v.withDefault(countV, 0),
    comment_count: v.withDefault(countV, 0),
    collect_count: v.withDefault(countV, 0),
    published_at: isoV,
    comments: arrayOrEmpty(commentV),
  })(value, path) as SimNote;

const profileV: Validator<SimProfile> = v.object({
  platform_user_id: v.string({ min: 1 }),
  nickname: v.string(),
  bio: v.withDefault(v.nullable(v.string()), null),
  ip_location: v.withDefault(v.nullable(v.string()), null),
  follower_count: v.withDefault(v.nullable(countV), null),
  note_count: v.withDefault(v.nullable(countV), null),
  recent_note_ids: arrayOrEmpty(v.string({ min: 1 })),
});

const scriptV: Validator<SimInboxScript> = v.object({
  from_user_id: v.string({ min: 1 }),
  to_account_platform_id: v.withDefault(v.nullable(v.string({ min: 1 })), null),
  delay_minutes: v.number({ min: 0 }),
  content: v.string({ min: 1 }),
});

const corpusV = v.object({
  notes: v.array(noteV),
  profiles: arrayOrEmpty(profileV),
  inbox_scripts: arrayOrEmpty(scriptV),
});

function walkComments(list: SimComment[], fn: (c: SimComment, parentId: string | null, path: string) => void, parentId: string | null = null, path = 'comments'): void {
  list.forEach((c, i) => {
    fn(c, parentId, `${path}[${i}]`);
    walkComments(c.sub_comments, fn, c.platform_comment_id, `${path}[${i}].sub_comments`);
  });
}

/** Validate an untrusted corpus (shape + referential integrity). Timestamps are normalized to toISOString(). */
export function parseSimulationCorpus(input: unknown): SimulationCorpus {
  const corpus = corpusV(input, 'corpus') as SimulationCorpus;
  const noteIds = new Set<string>();
  const commentIds = new Set<string>();
  corpus.notes.forEach((note, i) => {
    const p = `corpus.notes[${i}]`;
    if (noteIds.has(note.platform_post_id)) throw new ValidationError(`${p}.platform_post_id`, `duplicate note id ${note.platform_post_id}`);
    noteIds.add(note.platform_post_id);
    note.comments.forEach((root, ri) => {
      const rootPath = `comments[${ri}]`;
      if (root.parent_comment_id) {
        throw new ValidationError(`${p}.${rootPath}.parent_comment_id`, 'a top-level comment cannot reference a parent comment');
      }
      // Explicit parent references must stay inside the same thread (root + its replies).
      const thread = new Set<string>();
      walkComments([root], (c) => thread.add(c.platform_comment_id));
      walkComments([root], (c, _parent, cp) => {
        const at = `${p}.${rootPath}${cp.slice('comments[0]'.length)}`;
        if (commentIds.has(c.platform_comment_id)) {
          throw new ValidationError(`${at}.platform_comment_id`, `duplicate comment id ${c.platform_comment_id}`);
        }
        commentIds.add(c.platform_comment_id);
        if (c.parent_comment_id && (c.parent_comment_id === c.platform_comment_id || !thread.has(c.parent_comment_id))) {
          throw new ValidationError(`${at}.parent_comment_id`, `unknown parent comment ${c.parent_comment_id} (must be another comment in the same thread)`);
        }
      });
    });
  });
  const profileIds = new Set<string>();
  corpus.profiles.forEach((prof, i) => {
    if (profileIds.has(prof.platform_user_id)) {
      throw new ValidationError(`corpus.profiles[${i}].platform_user_id`, `duplicate profile ${prof.platform_user_id}`);
    }
    profileIds.add(prof.platform_user_id);
    prof.recent_note_ids.forEach((id, j) => {
      if (!noteIds.has(id)) throw new ValidationError(`corpus.profiles[${i}].recent_note_ids[${j}]`, `unknown note ${id}`);
    });
  });
  return corpus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const QUERY_STOPWORDS = new Set(['vs', 'v', 'pk', 'or', 'and']);
/** comparison connectors inside Chinese queries ("3系还是C级", "X3和GLC") separate token groups */
const CJK_CONNECTOR_RE = /还是|或者|对比|和|与/g;
/** a token group is a maximal run of CJK ideographs, or a maximal run of other letters/digits */
const TOKEN_GROUP_RE = /\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu;

/**
 * Query → token groups (normalized: NFKC full-width→half-width, lower-case, emoji stripped).
 * "杭州i3落地" → ["杭州", "i3", "落地"]; "i3 vs Model 3" → ["i3", "model", "3"].
 */
export function simulationQueryGroups(query: string): string[] {
  const text = stripEmoji(normalizeText(query ?? '')).replace(CJK_CONNECTOR_RE, ' ');
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN_GROUP_RE)) {
    const token = m[0];
    if (QUERY_STOPWORDS.has(token) || out.includes(token)) continue;
    out.push(token);
  }
  return out;
}

function occurrences(hay: string, needle: string, cap = 3): number {
  let n = 0;
  let from = 0;
  while (n < cap) {
    const idx = hay.indexOf(needle, from);
    if (idx < 0) break;
    n++;
    from = idx + needle.length;
  }
  return n;
}

function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function positiveInt(value: number | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

const fail = (status: ProviderFailure['status'], reason: string, retryable = false): ProviderFailure => ({
  ok: false,
  status,
  reason,
  retryable,
});

function shiftTimestamps(corpus: SimulationCorpus, offsetMs: number): SimulationCorpus {
  const shift = (ts: string) => new Date(Date.parse(ts) + offsetMs).toISOString();
  const shiftComment = (c: SimComment): SimComment => ({
    ...c,
    author: { ...c.author },
    published_at: shift(c.published_at),
    sub_comments: c.sub_comments.map(shiftComment),
  });
  return {
    notes: corpus.notes.map((n) => ({
      ...n,
      tags: [...n.tags],
      keywords: [...n.keywords],
      author: { ...n.author },
      published_at: shift(n.published_at),
      comments: n.comments.map(shiftComment),
    })),
    profiles: corpus.profiles.map((p) => ({ ...p, recent_note_ids: [...p.recent_note_ids] })),
    inbox_scripts: corpus.inbox_scripts.map((s) => ({ ...s })),
  };
}

function newestTimestamp(corpus: SimulationCorpus): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const note of corpus.notes) {
    max = Math.max(max, Date.parse(note.published_at));
    walkComments(note.comments, (c) => {
      max = Math.max(max, Date.parse(c.published_at));
    });
  }
  return max;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

type GatedCapability = keyof typeof SIMULATION_DISABLED_REASONS;

interface Contact {
  /** resolved account key (platform account id when known) */
  account: string;
  user: string;
  /** first contact ISO */
  at: string;
  /** insertion order, breaks ties between contacts at the same instant */
  seq: number;
}

export class SimulationXhsProvider implements XhsProvider {
  readonly name = 'simulation';
  readonly mode: ProviderMode = 'simulation';
  /** milliseconds added to every corpus timestamp (0 unless rebase_to_now) */
  readonly rebaseOffsetMs: number;

  private readonly clock: Clock;
  private readonly opts: SimulationOptions;
  private readonly notes: SimNote[];
  private readonly noteById = new Map<string, SimNote>();
  private readonly profiles = new Map<string, SimProfile>();
  private readonly scripts: SimInboxScript[];
  private readonly publishedBy = new Map<string, string>(); // note id → account key
  private readonly contacts = new Map<string, Contact>(); // contactKey → first contact
  private readonly sent: SimSentMessage[] = [];
  private readonly replies: SimSentReply[] = [];
  private msgSeq = 0;
  private noteSeq = 0;
  private replySeq = 0;
  private contactSeq = 0;

  constructor(clock: Clock, corpus: SimulationCorpus, opts: SimulationOptions = {}) {
    this.clock = clock;
    this.opts = {
      ...opts,
      auth_required_accounts: [...(opts.auth_required_accounts ?? [])],
      account_platform_ids: { ...(opts.account_platform_ids ?? {}) },
    };
    let data = parseSimulationCorpus(corpus);
    const newest = newestTimestamp(data);
    this.rebaseOffsetMs = opts.rebase_to_now && Number.isFinite(newest) ? clock.now().getTime() - 3_600_000 - newest : 0;
    data = shiftTimestamps(data, this.rebaseOffsetMs);
    this.notes = data.notes;
    for (const n of this.notes) this.noteById.set(n.platform_post_id, n);
    for (const p of data.profiles) this.profiles.set(p.platform_user_id, p);
    this.scripts = data.inbox_scripts;
  }

  static fromFile(clock: Clock, path: string = DEFAULT_SIMULATION_CORPUS_PATH, opts: SimulationOptions = {}): SimulationXhsProvider {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      throw new ValidationError('corpus_path', `cannot read simulation corpus ${path}: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ValidationError('corpus_path', `simulation corpus ${path} is not valid JSON: ${(err as Error).message}`);
    }
    // The constructor validates (parseSimulationCorpus) — no second pass here.
    return new SimulationXhsProvider(clock, parsed as SimulationCorpus, opts);
  }

  // ── demo harness / inspection ──────────────────────────────────────────────

  /** demo harness: record that a human sent a message so scripted replies can be released */
  recordManualContact(accountId: string, platformUserId: string): void {
    if (!accountId) throw new ValidationError('accountId', 'required');
    if (!platformUserId) throw new ValidationError('platformUserId', 'required');
    this.markContacted(accountId, platformUserId);
  }

  sentMessages(): { account_id: string; to: string; text: string; at: string }[] {
    return this.sent.map((m) => ({ account_id: m.account_id, to: m.to, text: m.text, at: m.at }));
  }

  sentReplies(): SimSentReply[] {
    return this.replies.map((r) => ({ ...r }));
  }

  publishedNotes(): XhsNoteDetail[] {
    return [...this.publishedBy.keys()].map((id) => this.toDetail(this.noteById.get(id)!));
  }

  /** first contact time of (account, user), or null */
  contactedAt(accountId: string, platformUserId: string): string | null {
    return this.contacts.get(this.contactKey(accountId, platformUserId))?.at ?? null;
  }

  // ── capabilities ───────────────────────────────────────────────────────────

  async capabilities(accountId: string | null = null): Promise<CapabilityReport> {
    const auth = accountId !== null && this.requiresAuth(accountId);
    const authState: Omit<CapabilityState, 'capability'> = {
      status: 'REQUIRES_AUTH',
      reason: `${SIM_TAG} account ${accountId} is configured as requiring login (auth_required_accounts)`,
    };
    const read = (what: string): Omit<CapabilityState, 'capability'> =>
      auth ? authState : { status: 'AVAILABLE', reason: `${SIM_TAG} ${what} from the synthetic corpus (not live Xiaohongshu data)` };
    const gated = (cap: GatedCapability, enabled: boolean | undefined, what: string): Omit<CapabilityState, 'capability'> => {
      if (!enabled) return { status: 'UNAVAILABLE', reason: SIMULATION_DISABLED_REASONS[cap] };
      return auth ? authState : { status: 'AVAILABLE', reason: `${SIM_TAG} ${what} (simulated, nothing reaches Xiaohongshu)` };
    };
    const states: Partial<Record<XhsCapability, Omit<CapabilityState, 'capability'>>> = {
      search_public_content: read('keyword search'),
      read_public_post: read('note detail'),
      read_public_comments: read('comments'),
      read_public_profile: read('user profiles'),
      read_engagement: read('engagement metrics'),
      publish_content: gated('publish_content', this.opts.publish, 'publishing'),
      reply_comments: gated('reply_comments', this.opts.reply_comments, 'comment replies'),
      receive_messages: gated('receive_messages', this.opts.receive_messages, 'scripted inbox'),
      send_messages: gated('send_messages', this.opts.send_messages, 'direct messages'),
    };
    return buildReport(this.name, this.mode, accountId, this.clock, states);
  }

  // ── public reads ───────────────────────────────────────────────────────────

  async searchNotes(query: string, opts: XhsSearchOptions = {}, accountId: string | null = null): Promise<ProviderResult<XhsNoteSummary[]>> {
    const denied = this.authGate(accountId);
    if (denied) return denied;
    const normalizedQuery = normalizeText(query ?? '');
    const groups = simulationQueryGroups(query ?? '');
    if (!normalizedQuery || groups.length === 0) return fail('UNAVAILABLE', 'search query has no searchable terms');
    const compactQuery = meaningfulChars(query);
    const limit = positiveInt(opts.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const nowMs = this.clock.now().getTime();
    const windowDays = opts.published_within_days;
    const minMs = windowDays !== undefined && Number.isFinite(windowDays) ? nowMs - windowDays * DAY_MS : Number.NEGATIVE_INFINITY;

    const hits: { note: SimNote; relevance: number; likes: number; at: number }[] = [];
    for (const note of this.visibleNotes()) {
      const at = Date.parse(note.published_at);
      if (at < minMs) continue;
      const title = normalizeText(note.title);
      const labels = normalizeText([...note.tags, ...note.keywords].join(' '));
      const content = normalizeText(note.content);
      const hay = `${title}\n${labels}\n${content}`;
      const keywordExact = note.keywords.some((k) => meaningfulChars(k) === compactQuery);
      const allGroups = groups.every((g) => hay.includes(g));
      if (!keywordExact && !allGroups) continue;
      let relevance = keywordExact ? 100 : 0;
      if (title.includes(normalizedQuery) || meaningfulChars(note.title).includes(compactQuery)) relevance += 20;
      if (meaningfulChars(`${note.title}${note.content}${note.tags.join('')}${note.keywords.join('')}`).includes(compactQuery)) relevance += 10;
      for (const g of groups) {
        if (title.includes(g)) relevance += 6;
        if (labels.includes(g)) relevance += 4;
        relevance += 2 * occurrences(content, g);
      }
      hits.push({ note, relevance, likes: this.likesOf(note), at });
    }
    const sort = opts.sort ?? 'general';
    hits.sort((a, b) => {
      if (sort === 'latest') return b.at - a.at || b.relevance - a.relevance;
      if (sort === 'popular') return b.likes - a.likes || b.relevance - a.relevance;
      return b.relevance - a.relevance || b.likes - a.likes || b.at - a.at;
    });
    return { ok: true, data: hits.slice(0, limit).map((h) => this.toSummary(h.note)) };
  }

  async getNote(ref: XhsNoteRef, accountId: string | null = null): Promise<ProviderResult<XhsNoteDetail>> {
    const denied = this.authGate(accountId);
    if (denied) return denied;
    const note = this.findVisibleNote(ref.platform_post_id);
    if (!note) return fail('UNAVAILABLE', `${SIM_TAG} note not found: ${ref.platform_post_id}`);
    return { ok: true, data: this.toDetail(note) };
  }

  async getComments(ref: XhsNoteRef, opts: XhsCommentOptions = {}, accountId: string | null = null): Promise<ProviderResult<XhsComment[]>> {
    const denied = this.authGate(accountId);
    if (denied) return denied;
    const note = this.findVisibleNote(ref.platform_post_id);
    if (!note) return fail('UNAVAILABLE', `${SIM_TAG} note not found: ${ref.platform_post_id}`);
    const limit = positiveInt(opts.limit, DEFAULT_COMMENT_LIMIT);
    const nowMs = this.clock.now().getTime();
    const visible = (c: SimComment) => Date.parse(c.published_at) <= nowMs;
    const tops = note.comments
      .filter(visible)
      .map((c, i) => ({ c, i }))
      .sort((a, b) => Date.parse(a.c.published_at) - Date.parse(b.c.published_at) || a.i - b.i)
      .slice(0, limit)
      .map((x) => x.c);
    const out: XhsComment[] = [];
    const flatten = (c: SimComment, parentId: string | null) => {
      out.push(this.toComment(c, parentId === null ? null : (c.parent_comment_id ?? parentId)));
      if (!opts.include_replies) return;
      for (const sub of c.sub_comments.filter(visible)) flatten(sub, c.platform_comment_id);
    };
    for (const c of tops) flatten(c, null);
    return { ok: true, data: out };
  }

  async getUserProfile(ref: XhsUserRef, accountId: string | null = null): Promise<ProviderResult<XhsUserProfile>> {
    const denied = this.authGate(accountId);
    if (denied) return denied;
    const userId = ref.platform_user_id;
    const authored = this.visibleNotes().filter((n) => n.author.platform_user_id === userId);
    const profile = this.profiles.get(userId);
    if (profile) {
      const ids = [...new Set([...profile.recent_note_ids, ...authored.map((n) => n.platform_post_id)])];
      const recent = ids.map((id) => this.findVisibleNote(id)).filter((n): n is SimNote => Boolean(n));
      return {
        ok: true,
        data: {
          platform_user_id: userId,
          nickname: profile.nickname,
          profile_url: xhsProfileUrl(userId),
          bio: profile.bio,
          ip_location: profile.ip_location,
          follower_count: profile.follower_count,
          note_count: profile.note_count,
          recent_notes: recent.map((n) => this.toSummary(n)),
          raw: { source: 'simulation', derived: false },
        },
      };
    }
    // No stored profile: derive a minimal one from the user's visible public activity.
    const nowMs = this.clock.now().getTime();
    let latest: SimComment | null = null;
    let latestWithIp: SimComment | null = null;
    const newer = (c: SimComment, than: SimComment | null) => !than || Date.parse(c.published_at) >= Date.parse(than.published_at);
    for (const note of this.visibleNotes()) {
      walkComments(note.comments, (c) => {
        if (c.author.platform_user_id !== userId || Date.parse(c.published_at) > nowMs) return;
        if (newer(c, latest)) latest = c;
        if (c.ip_location && newer(c, latestWithIp)) latestWithIp = c;
      });
    }
    const found = latest as SimComment | null;
    const withIp = latestWithIp as SimComment | null;
    const latestAuthored = [...authored].sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
    if (!found && latestAuthored.length === 0) return fail('UNAVAILABLE', `${SIM_TAG} user not found: ${userId}`);
    const authoredIp = latestAuthored.find((n) => n.ip_location)?.ip_location ?? null;
    return {
      ok: true,
      data: {
        platform_user_id: userId,
        nickname: found?.author.nickname ?? latestAuthored[0].author.nickname,
        profile_url: xhsProfileUrl(userId),
        bio: null,
        ip_location: withIp?.ip_location ?? authoredIp,
        follower_count: null,
        note_count: null,
        recent_notes: latestAuthored.map((n) => this.toSummary(n)),
        raw: { source: 'simulation', derived: true },
      },
    };
  }

  // ── account actions ────────────────────────────────────────────────────────

  async publishNote(accountId: string, draft: XhsPublishDraft): Promise<ProviderResult<XhsPublishResult>> {
    const denied = this.optionGate('publish_content', this.opts.publish, accountId);
    if (denied) return denied;
    if (!draft.title?.trim()) return fail('UNAVAILABLE', 'draft title is empty');
    if (!draft.body?.trim()) return fail('UNAVAILABLE', 'draft body is empty');
    const n = ++this.noteSeq;
    const id = this.genId('sim-note', n);
    const token = this.genId('sim-xsec', n);
    const accountKey = this.accountKey(accountId);
    const profile = this.profiles.get(accountKey);
    const note: SimNote = {
      platform_post_id: id,
      xsec_token: token,
      title: draft.title,
      content: draft.body,
      tags: [...(draft.tags ?? [])],
      keywords: [...(draft.tags ?? [])],
      author: { platform_user_id: accountKey, nickname: profile?.nickname ?? accountKey },
      ip_location: profile?.ip_location ?? null,
      like_count: 0,
      comment_count: 0,
      collect_count: 0,
      published_at: this.clock.iso(),
      comments: [],
    };
    this.notes.push(note);
    this.noteById.set(id, note);
    this.publishedBy.set(id, accountKey);
    return { ok: true, data: { platform_note_id: id, url: xhsNoteUrl(id, token) } };
  }

  async getEngagement(accountId: string, platformNoteId: string): Promise<ProviderResult<XhsEngagement>> {
    const denied = this.authGate(accountId);
    if (denied) return denied;
    const note = this.findVisibleNote(platformNoteId);
    if (!note) return fail('UNAVAILABLE', `${SIM_TAG} note not found: ${platformNoteId}`);
    if (this.publishedBy.has(platformNoteId)) return { ok: true, data: this.simulatedEngagement(note) };
    return {
      ok: true,
      data: {
        platform_note_id: platformNoteId,
        views: null,
        likes: note.like_count,
        collects: note.collect_count,
        comments: note.comment_count,
        shares: 0,
      },
    };
  }

  async replyToComment(accountId: string, ref: XhsCommentReplyRef, text: string): Promise<ProviderResult<XhsSendResult>> {
    const denied = this.optionGate('reply_comments', this.opts.reply_comments, accountId);
    if (denied) return denied;
    if (!text?.trim()) return fail('UNAVAILABLE', 'reply text is empty');
    const note = this.findVisibleNote(ref.platform_post_id);
    if (!note) return fail('UNAVAILABLE', `${SIM_TAG} note not found: ${ref.platform_post_id}`);
    const nowMs = this.clock.now().getTime();
    let exists = false;
    walkComments(note.comments, (c) => {
      if (c.platform_comment_id === ref.platform_comment_id && Date.parse(c.published_at) <= nowMs) exists = true;
    });
    if (!exists) return fail('UNAVAILABLE', `${SIM_TAG} comment not found: ${ref.platform_comment_id}`);
    const id = this.genId('sim-reply', ++this.replySeq);
    this.replies.push({
      account_id: accountId,
      platform_post_id: ref.platform_post_id,
      platform_comment_id: ref.platform_comment_id,
      text,
      at: this.clock.iso(),
      provider_message_id: id,
    });
    return { ok: true, data: { provider_message_id: id } };
  }

  /**
   * Scripted inbox. A script with an explicit target is delivered to that account (if it contacted
   * the user); a null-target script is delivered only to the account that contacted the user FIRST.
   * This keeps the deterministic ids ('sim-in-<user>-<index>') globally unique — the same inbound
   * message never appears in two accounts' inboxes (conversation_messages.provider_message_id is unique).
   */
  async listInboundMessages(accountId: string, since: string | null): Promise<ProviderResult<XhsInboundMessage[]>> {
    const denied = this.optionGate('receive_messages', this.opts.receive_messages, accountId);
    if (denied) return denied;
    const sinceMs = since ? Date.parse(since) : null;
    if (sinceMs !== null && Number.isNaN(sinceMs)) return fail('UNAVAILABLE', `invalid since timestamp: ${since}`);
    const accountKey = this.accountKey(accountId);
    const nowMs = this.clock.now().getTime();
    const byUser = new Map<string, { script: SimInboxScript; index: number }[]>();
    for (const script of this.scripts) {
      const list = byUser.get(script.from_user_id) ?? [];
      list.push({ script, index: list.length });
      byUser.set(script.from_user_id, list);
    }
    const out: XhsInboundMessage[] = [];
    for (const [userId, list] of byUser) {
      const contact = this.contacts.get(this.keyFor(accountKey, userId));
      if (!contact) continue;
      const isFirstContact = this.firstContactOf(userId)?.account === accountKey;
      const contactMs = Date.parse(contact.at);
      let prevMs = Number.NEGATIVE_INFINITY;
      for (const { script, index } of list) {
        const target = script.to_account_platform_id;
        const deliver = target === null ? isFirstContact : this.accountKey(target) === accountKey || target === accountId;
        if (!deliver) continue;
        const sentMs = Math.max(prevMs, contactMs + script.delay_minutes * 60_000);
        prevMs = sentMs;
        if (sentMs > nowMs) break;
        if (sinceMs !== null && sentMs <= sinceMs) continue;
        out.push({
          provider_message_id: `sim-in-${userId}-${index}`,
          account_id: accountId,
          from_user_id: userId,
          from_nickname: this.nicknameOf(userId),
          content: script.content,
          sent_at: new Date(sentMs).toISOString(),
        });
      }
    }
    out.sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at) || a.provider_message_id.localeCompare(b.provider_message_id));
    return { ok: true, data: out };
  }

  async sendMessage(accountId: string, toPlatformUserId: string, text: string): Promise<ProviderResult<XhsSendResult>> {
    const denied = this.optionGate('send_messages', this.opts.send_messages, accountId);
    if (denied) return denied;
    if (!toPlatformUserId) return fail('UNAVAILABLE', 'recipient platform user id is empty');
    if (!text?.trim()) return fail('UNAVAILABLE', 'message text is empty');
    const id = this.genId('sim-msg', ++this.msgSeq);
    const at = this.clock.iso();
    this.sent.push({ account_id: accountId, to: toPlatformUserId, text, at, provider_message_id: id });
    this.markContacted(accountId, toPlatformUserId);
    return { ok: true, data: { provider_message_id: id } };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private genId(prefix: string, n: number): string {
    return this.opts.id_namespace ? `${prefix}-${this.opts.id_namespace}-${n}` : `${prefix}-${n}`;
  }

  private accountKey(accountId: string): string {
    return this.opts.account_platform_ids?.[accountId] ?? accountId;
  }

  private keyFor(accountKey: string, userId: string): string {
    return JSON.stringify([accountKey, userId]);
  }

  private contactKey(accountId: string, userId: string): string {
    return this.keyFor(this.accountKey(accountId), userId);
  }

  private markContacted(accountId: string, userId: string): void {
    const key = this.contactKey(accountId, userId);
    if (this.contacts.has(key)) return;
    this.contacts.set(key, { account: this.accountKey(accountId), user: userId, at: this.clock.iso(), seq: ++this.contactSeq });
  }

  private firstContactOf(userId: string): Contact | null {
    let first: Contact | null = null;
    for (const c of this.contacts.values()) {
      if (c.user !== userId) continue;
      const t = Date.parse(c.at);
      if (!first || t < Date.parse(first.at) || (t === Date.parse(first.at) && c.seq < first.seq)) first = c;
    }
    return first;
  }

  private requiresAuth(accountId: string): boolean {
    const list = this.opts.auth_required_accounts ?? [];
    return list.includes(accountId) || list.includes(this.accountKey(accountId));
  }

  private authGate(accountId: string | null): ProviderFailure | null {
    if (accountId !== null && accountId !== undefined && this.requiresAuth(accountId)) {
      return fail('REQUIRES_AUTH', `${SIM_TAG} account ${accountId} is configured as requiring login (auth_required_accounts)`);
    }
    return null;
  }

  private optionGate(cap: GatedCapability, enabled: boolean | undefined, accountId: string): ProviderFailure | null {
    if (!enabled) return fail('UNAVAILABLE', SIMULATION_DISABLED_REASONS[cap]);
    return this.authGate(accountId);
  }

  private visibleNotes(): SimNote[] {
    const nowMs = this.clock.now().getTime();
    return this.notes.filter((n) => Date.parse(n.published_at) <= nowMs);
  }

  private findVisibleNote(id: string): SimNote | undefined {
    const note = this.noteById.get(id);
    if (!note || Date.parse(note.published_at) > this.clock.now().getTime()) return undefined;
    return note;
  }

  private nicknameOf(userId: string): string | null {
    const profile = this.profiles.get(userId);
    if (profile) return profile.nickname;
    let nickname: string | null = null;
    for (const note of this.notes) {
      if (note.author.platform_user_id === userId) return note.author.nickname;
      walkComments(note.comments, (c) => {
        if (!nickname && c.author.platform_user_id === userId) nickname = c.author.nickname;
      });
      if (nickname) return nickname;
    }
    return null;
  }

  private likesOf(note: SimNote): number {
    return this.publishedBy.has(note.platform_post_id) ? this.simulatedEngagement(note).likes : note.like_count;
  }

  private simulatedEngagement(note: SimNote): XhsEngagement {
    const hours = Math.max(0, (this.clock.now().getTime() - Date.parse(note.published_at)) / 3_600_000);
    const factor = 0.8 + (fnv1a(note.platform_post_id) % 41) / 100;
    const views = Math.floor(factor * 150 * Math.sqrt(hours));
    return {
      platform_note_id: note.platform_post_id,
      views,
      likes: Math.floor(views * 0.08),
      collects: Math.floor(views * 0.03),
      comments: Math.floor(views * 0.012),
      shares: Math.floor(views * 0.006),
    };
  }

  private toSummary(note: SimNote): XhsNoteSummary {
    return {
      platform_post_id: note.platform_post_id,
      xsec_token: note.xsec_token,
      title: note.title,
      author: {
        platform_user_id: note.author.platform_user_id,
        nickname: note.author.nickname,
        profile_url: xhsProfileUrl(note.author.platform_user_id),
      },
      like_count: this.likesOf(note),
      url: xhsNoteUrl(note.platform_post_id, note.xsec_token),
      published_at: note.published_at,
      raw: { source: 'simulation', keywords: [...note.keywords] },
    };
  }

  private toDetail(note: SimNote): XhsNoteDetail {
    const published = this.publishedBy.has(note.platform_post_id) ? this.simulatedEngagement(note) : null;
    return {
      ...this.toSummary(note),
      content: note.content,
      tags: [...note.tags],
      ip_location: note.ip_location,
      comment_count: published ? published.comments : note.comment_count,
      collect_count: published ? published.collects : note.collect_count,
    };
  }

  private toComment(c: SimComment, parentId: string | null): XhsComment {
    return {
      platform_comment_id: c.platform_comment_id,
      parent_comment_id: parentId,
      author: {
        platform_user_id: c.author.platform_user_id,
        nickname: c.author.nickname,
        profile_url: xhsProfileUrl(c.author.platform_user_id),
      },
      content: c.content,
      ip_location: c.ip_location,
      like_count: c.like_count,
      published_at: c.published_at,
      raw: { source: 'simulation' },
    };
  }
}
