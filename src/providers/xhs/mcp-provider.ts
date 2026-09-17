import type { Clock } from '../../core/clock.ts';
import { DAY_MS } from '../../core/time.ts';
import { ValidationError } from '../../core/errors.ts';
import type { XhsCapability } from '../../core/types.ts';
import { v } from '../../core/validate.ts';
import { McpError, McpHttpClient, type McpImageContent, type McpToolInfo } from './mcp-client.ts';
import type {
  CapabilityReport,
  CapabilityState,
  ProviderFailure,
  ProviderMode,
  ProviderResult,
  XhsAuthApi,
  XhsAuthor,
  XhsComment,
  XhsCommentOptions,
  XhsCommentReplyRef,
  XhsEndpointInfo,
  XhsEngagement,
  XhsInboundMessage,
  XhsLoginQrcode,
  XhsLoginStatus,
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
 * Live Xiaohongshu provider backed by xpzouying/xiaohongshu-mcp (streamable HTTP).
 *
 * Deployment model: ONE xiaohongshu-mcp instance per managed account (own port + COOKIES_PATH),
 * plus an optional research instance for public reads. Account endpoints come from configuration
 * (env) or, when not configured there, from `resolveEndpoint` (xhs_accounts.mcp_endpoint_url).
 * Capabilities are detected from `tools/list` and `check_login_status` — never assumed. DMs are not
 * supported by any authorized integration and are always reported UNAVAILABLE (or REQUIRES_REVIEW when
 * an unverified DM-like tool shows up).
 *
 * Logged-out honesty: a logged-out xiaohongshu-mcp does NOT say so in its read results — search_feeds
 * and get_my_profile time out ("context deadline exceeded"), get_feed_detail reports "笔记不可访问" and
 * user_profile returns an all-empty profile (captured from a real instance, see
 * test/unit/providers/fixtures/xhs-mcp-logged-out.json). Read tools therefore consult a short-lived
 * per-endpoint login state (≤ LOGIN_CACHE_TTL_MS) before calling, and re-verify the session whenever a
 * read fails or comes back empty, so a logged-out session surfaces as REQUIRES_AUTH instead of
 * "no posts found".
 *
 * Write actions (publish_content, reply_comment_in_feed) are never reported as successful unless the
 * tool confirms success ('…成功…'). When the outcome cannot be known (timeout after the tool call was
 * dispatched, gateway error, unrecognised result text) the result is REQUIRES_REVIEW and NOT
 * retryable, so callers do not publish or reply twice.
 *
 * This adapter deliberately does not configure proxies, fingerprint seeds, captcha handling or any
 * other anti-detection behaviour.
 */

export interface McpEndpointConfig {
  url: string;
  token?: string;
}

export interface McpProviderConfig {
  research_endpoint?: McpEndpointConfig;
  /** platform account id (e.g. 'xhs-hz-sales-wang') → that account's xiaohongshu-mcp instance (URLs must be distinct) */
  account_endpoints: Record<string, McpEndpointConfig>;
  timeout_ms?: number;
  /** even when true, DM-like tools are reported REQUIRES_REVIEW and never used */
  enable_dm_tools?: boolean;
}

export interface McpProviderOptions {
  fetchImpl?: typeof fetch;
  /** internal account id → platform account id (bootstrap passes a DB lookup); default identity */
  resolveAccount?: (internalAccountId: string) => string | null;
  /**
   * Endpoint of an account that has no env-configured instance (bootstrap passes a lookup of
   * xhs_accounts.mcp_endpoint_url plus the default bearer token). Env endpoints always win.
   */
  resolveEndpoint?: (accountId: string) => McpEndpointConfig | null;
}

export const XHS_WEB_ORIGIN = 'https://www.xiaohongshu.com';
export const TOOL_CACHE_TTL_MS = 5 * 60_000;
/** How long a verified login state is trusted before read tools probe `check_login_status` again. */
export const LOGIN_CACHE_TTL_MS = 60_000;
/** xiaohongshu-mcp waits 4 minutes for a QR scan. */
export const LOGIN_QRCODE_TTL_MS = 4 * 60_000;
/** How long the verified identity (user id from get_my_profile) of a session is reused for the same nickname. */
export const IDENTITY_CACHE_TTL_MS = 10 * 60_000;
/**
 * Tool names that look like direct-message tooling. Superset of the documented
 * /private.?message|direct.?message|send_?message|\bdm\b|chat/i that also catches snake/kebab-case
 * `send_dm`/`dm-list`, inbox/conversation tools and Chinese names. A match can only ever downgrade
 * the DM capabilities to REQUIRES_REVIEW — such tools are never called.
 */
export const DM_TOOL_PATTERN = /private.?message|direct.?message|send_?message|(?:^|[^a-z0-9])dms?(?:[^a-z0-9]|$)|chat|inbox|conversation|私信/i;

export const MCP_DM_REASONS = {
  receive_messages:
    'xiaohongshu-mcp exposes no DM inbox tool; official DM access exists only via 私信通 / approved 三方客服 vendors (inbound conversations only)',
  send_messages:
    'no authorized API for sending DMs to Xiaohongshu users (xiaohongshu-mcp has no DM tool; official DM access only via 私信通 / approved 三方客服 vendors) — outreach stays READY_FOR_REVIEW for a human to send',
} as const;

export const NO_ENDPOINT_REASON = 'no xiaohongshu-mcp endpoint configured for this account';
export const NO_PUBLIC_ENDPOINT_REASON =
  'no xiaohongshu-mcp endpoint configured for public reads (set XHS_MCP_RESEARCH_URL, XHS_MCP_ACCOUNTS or an account mcp_endpoint_url)';

export function xhsProfileUrl(userId: string): string {
  return `${XHS_WEB_ORIGIN}/user/profile/${encodeURIComponent(userId)}`;
}

export function xhsNoteUrl(noteId: string, xsecToken?: string | null): string {
  const base = `${XHS_WEB_ORIGIN}/explore/${encodeURIComponent(noteId)}`;
  return xsecToken ? `${base}?xsec_token=${encodeURIComponent(xsecToken)}` : base;
}

const CAPABILITY_TOOLS: Partial<Record<XhsCapability, string>> = {
  search_public_content: 'search_feeds',
  read_public_post: 'get_feed_detail',
  read_public_comments: 'get_feed_detail',
  read_public_profile: 'user_profile',
  publish_content: 'publish_content',
  read_engagement: 'get_my_profile',
  reply_comments: 'reply_comment_in_feed',
};
const PUBLIC_CAPABILITIES: XhsCapability[] = ['search_public_content', 'read_public_post', 'read_public_comments', 'read_public_profile'];
const ACCOUNT_CAPABILITIES: XhsCapability[] = ['publish_content', 'read_engagement', 'reply_comments'];
const CAPABILITY_NOTES: Partial<Record<XhsCapability, string>> = {
  read_public_comments: 'load_all_comments',
  read_public_profile: 'requires the xsec_token observed with the user',
  publish_content: 'at least one image required; no note id is returned (reconcile later)',
  read_engagement: "own notes via get_my_profile; no view counts",
};
const SORT_BY: Record<NonNullable<XhsSearchOptions['sort']>, string> = { general: '综合', latest: '最新', popular: '最多点赞' };
const LOGIN_REQUIRED_RE = /未登录|请先登录|登录已?过期|需要登录|扫码登录|not logged in|login required/i;
const SUCCESS_RE = /成功|\bsuccess(?:ful|fully)?\b/i;
const FAILURE_RE = /失败|\bfailed\b/i;
const ALREADY_LOGGED_IN_RE = /已处于登录状态|已登录/;
/** errno codes meaning the TCP connection was never established (request definitely not delivered) */
const CONNECT_FAILURE_RE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ERR_INVALID_URL/;

const endpointV = v.object({ url: v.string({ pattern: /^https?:\/\//i }), token: v.optional(v.string()) });
const configV = v.object({
  research_endpoint: v.optional(endpointV),
  account_endpoints: v.withDefault(v.record(endpointV), {}),
  timeout_ms: v.optional(v.number({ int: true, min: 1 })),
  enable_dm_tools: v.optional(v.boolean()),
});

interface Endpoint {
  key: string;
  label: string;
  client: McpHttpClient;
}

type LoginState = 'logged_in' | 'logged_out' | 'unknown';

interface Probe {
  endpoint: Endpoint;
  tools: McpToolInfo[] | null;
  unreachable: string | null;
  login: LoginState;
  loginDetail: string;
  username: string | null;
}

interface LoginCheck {
  state: LoginState;
  username: string | null;
  detail: string;
  /** true when this result came from a live check_login_status call (not the cache) */
  live: boolean;
}

interface AccountLookup {
  ep: Endpoint | null;
  error: string | null;
  retryable: boolean;
}

type Obj = Record<string, unknown>;
const isObject = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const obj = (x: unknown): Obj => (isObject(x) ? x : {});
const strOrNull = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x : typeof x === 'number' ? String(x) : null);

/** Xiaohongshu counts arrive as numbers or strings like "1234", "1.2万", "10w+". */
export function toCount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (typeof value !== 'string') return 0;
  const s = value.normalize('NFKC').trim().replace(/,/g, '');
  const m = /^(\d+(?:\.\d+)?)\s*(万|w|千|k)?\+?$/i.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  const mult = unit === '万' || unit === 'w' ? 10_000 : unit === '千' || unit === 'k' ? 1_000 : 1;
  return Math.floor(n * mult);
}

/** Epoch (ms, or seconds when small) → ISO; null when absent/invalid. */
export function epochToIso(value: unknown): string | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n < 1e11 ? n * 1000 : n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Tool results carry JSON inside a text block; tolerate leading/trailing prose. */
export function parseToolJson(text: string): Obj | unknown[] {
  const t = text.trim();
  try {
    const parsed = JSON.parse(t) as unknown;
    if (isObject(parsed) || Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to embedded JSON extraction
  }
  const start = t.search(/[{[]/);
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(t.slice(start, end + 1)) as unknown;
      if (isObject(parsed) || Array.isArray(parsed)) return parsed;
    } catch {
      // handled below
    }
  }
  throw new Error(`expected JSON tool output, got: ${t.slice(0, 200)}`);
}

export type ToolTextVerdict = 'success' | 'failure' | 'login_required' | 'none';

/**
 * Classify a tool's plain-text result by its EARLIEST marker. xiaohongshu-mcp echoes user content in
 * its confirmations ("内容发布成功: {Title:… Content:…砍价失败…}"), so a later '失败' inside echoed
 * content must not flip a confirmed success, and vice versa ("发布失败: 未能成功上传").
 */
export function classifyToolText(text: string): ToolTextVerdict {
  const marks: [ToolTextVerdict, number][] = [
    ['success', text.search(SUCCESS_RE)],
    ['failure', text.search(FAILURE_RE)],
    ['login_required', text.search(LOGIN_REQUIRED_RE)],
  ];
  const found = marks.filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]);
  return found[0]?.[0] ?? 'none';
}

/** Parse check_login_status text: "✅ 已登录\n用户名: xxx" / "❌ 未登录". */
export function parseLoginStatusText(text: string): { logged_in: boolean; username: string | null } {
  const loggedIn = text.includes('已登录') && !text.includes('未登录');
  const username = loggedIn ? (/用户名\s*[:：]\s*([^\n\r]+)/.exec(text)?.[1]?.trim() || null) : null;
  return { logged_in: loggedIn, username };
}

function mapAuthor(user: unknown): XhsAuthor {
  const u = obj(user);
  const id = strOrNull(u.userId ?? u.user_id ?? u.id);
  return {
    platform_user_id: id,
    nickname: strOrNull(u.nickname ?? u.nickName ?? u.nick_name),
    profile_url: id ? xhsProfileUrl(id) : null,
  };
}

/** search_feeds / user_profile / get_my_profile Feed → XhsNoteSummary (non-note model types are skipped). */
export function mapFeed(feed: unknown): XhsNoteSummary | null {
  if (!isObject(feed)) return null;
  if (typeof feed.modelType === 'string' && feed.modelType !== 'note') return null;
  const card = obj(feed.noteCard ?? feed.note_card);
  const id = strOrNull(feed.id ?? card.noteId ?? card.note_id);
  if (!id) return null;
  const token = strOrNull(feed.xsecToken ?? feed.xsec_token ?? card.xsecToken);
  const interact = obj(card.interactInfo ?? card.interact_info);
  return {
    platform_post_id: id,
    xsec_token: token,
    title: strOrNull(card.displayTitle ?? card.display_title ?? card.title) ?? '',
    author: mapAuthor(card.user),
    like_count: toCount(interact.likedCount ?? interact.liked_count),
    url: xhsNoteUrl(id, token),
    published_at: epochToIso(card.time ?? card.lastUpdateTime),
    raw: feed,
  };
}

function tagsFrom(note: Obj): string[] {
  if (Array.isArray(note.tagList)) {
    const tags = note.tagList.map((t) => strOrNull(obj(t).name)).filter((t): t is string => Boolean(t));
    if (tags.length > 0) return [...new Set(tags)];
  }
  const desc = typeof note.desc === 'string' ? note.desc : '';
  const out: string[] = [];
  for (const m of desc.matchAll(/#([^#\s[\]]+?)(?:\[话题\])?#/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** get_feed_detail data.note → XhsNoteDetail. */
export function mapNoteDetail(noteRaw: unknown, ref: XhsNoteRef): XhsNoteDetail {
  const note = obj(noteRaw);
  const id = strOrNull(note.noteId ?? note.note_id ?? note.id) ?? ref.platform_post_id;
  const token = strOrNull(note.xsecToken ?? note.xsec_token) ?? ref.xsec_token ?? null;
  const interact = obj(note.interactInfo ?? note.interact_info);
  const { imageList: _images, ...rawRest } = note;
  return {
    platform_post_id: id,
    xsec_token: token,
    title: strOrNull(note.title ?? note.displayTitle) ?? '',
    author: mapAuthor(note.user),
    like_count: toCount(interact.likedCount),
    url: xhsNoteUrl(id, token),
    published_at: epochToIso(note.time),
    content: typeof note.desc === 'string' ? note.desc : '',
    tags: tagsFrom(note),
    ip_location: strOrNull(note.ipLocation ?? note.ip_location),
    comment_count: toCount(interact.commentCount),
    collect_count: toCount(interact.collectedCount),
    raw: rawRest,
  };
}

/**
 * get_feed_detail Comment → XhsComment (sub-comments nested). A sub-comment's parent is the comment it
 * actually replies to (`targetComment.id`, e.g. a reply to a reply) when present, else its root comment.
 */
export function mapComment(raw: unknown, parentId: string | null = null): XhsComment | null {
  if (!isObject(raw)) return null;
  const id = strOrNull(raw.id ?? raw.commentId);
  if (!id) return null;
  const { subComments, ...rest } = raw;
  const subs = Array.isArray(subComments)
    ? subComments.map((s) => mapComment(s, id)).filter((s): s is XhsComment => s !== null)
    : [];
  const target = strOrNull(obj(raw.targetComment ?? raw.target_comment).id);
  return {
    platform_comment_id: id,
    parent_comment_id: target && target !== id ? target : parentId,
    author: mapAuthor(raw.userInfo ?? raw.user_info ?? raw.user),
    content: typeof raw.content === 'string' ? raw.content : '',
    ip_location: strOrNull(raw.ipLocation ?? raw.ip_location),
    like_count: toCount(raw.likeCount ?? raw.like_count),
    published_at: epochToIso(raw.createTime ?? raw.create_time),
    sub_comments: subs,
    raw: rest,
  };
}

function flattenComments(list: XhsComment[]): XhsComment[] {
  const out: XhsComment[] = [];
  const walk = (c: XhsComment) => {
    const { sub_comments, ...flat } = c;
    out.push(flat);
    for (const s of sub_comments ?? []) walk(s);
  };
  list.forEach(walk);
  return out;
}

function feedsOf(data: Obj | unknown[]): unknown[] {
  if (Array.isArray(data)) return data;
  const inner = obj(data.data);
  const feeds = data.feeds ?? data.items ?? inner.feeds ?? inner.items;
  return Array.isArray(feeds) ? feeds : [];
}

/**
 * Identity of the logged-in user from get_my_profile: redId from userBasicInfo; the user id from the author of
 * the account's own notes (the profile payload carries no user id of its own).
 */
export function identityFromMyProfile(data: Obj | unknown[]): { nickname: string | null; red_id: string | null; platform_user_id: string | null } {
  const root = Array.isArray(data) ? {} : isObject(data.userBasicInfo) ? data : obj(data.data);
  const basic = obj(root.userBasicInfo);
  let userId: string | null = null;
  for (const feed of feedsOf(root)) {
    const id = strOrNull(obj(obj(obj(feed).noteCard).user).userId);
    if (id) {
      userId = id;
      break;
    }
  }
  return { nickname: strOrNull(basic.nickname ?? basic.nickName), red_id: strOrNull(basic.redId ?? basic.red_id), platform_user_id: userId };
}

export function normalizeEndpointUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

function isConnectFailure(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth++) {
    const e = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof e.code === 'string' && CONNECT_FAILURE_RE.test(e.code)) return true;
    if (typeof e.message === 'string' && CONNECT_FAILURE_RE.test(e.message)) return true;
    cur = e.cause;
  }
  return false;
}

/** A write tool answered without a recognisable success/failure marker. */
class UnconfirmedWriteError extends Error {
  constructor(tool: string, text: string) {
    super(`${tool} returned no success confirmation: ${text.trim().slice(0, 200) || '(empty result)'}`);
    this.name = 'UnconfirmedWriteError';
  }
}

type CallMode = 'read' | 'write';

const fail = (status: ProviderFailure['status'], reason: string, retryable = false): ProviderFailure => ({
  ok: false,
  status,
  reason,
  retryable,
});

const isFailure = (x: unknown): x is ProviderFailure => isObject(x) && x.ok === false;

export class McpXhsProvider implements XhsProvider {
  readonly name = 'xiaohongshu-mcp';
  readonly mode: ProviderMode = 'live';
  /** Login-session API (QR login from the console, verified identity). */
  readonly auth: XhsAuthApi = {
    status: (accountId) => this.authStatus(accountId),
    loginQrcode: (accountId) => this.authLoginQrcode(accountId),
  };

  private readonly clock: Clock;
  private readonly cfg: McpProviderConfig;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly resolveAccount: (internalAccountId: string) => string | null;
  private readonly resolveEndpoint: ((accountId: string) => McpEndpointConfig | null) | null;
  /** normalized env account endpoint URL → platform account id */
  private readonly envOwners = new Map<string, string>();
  private readonly clients = new Map<string, McpHttpClient>();
  private readonly toolCache = new Map<string, { tools: McpToolInfo[]; at: number }>();
  private readonly loginCache = new Map<string, { state: 'logged_in' | 'logged_out'; username: string | null; detail: string; at: number }>();
  private readonly identityCache = new Map<string, { username: string | null; platform_user_id: string; red_id: string | null; at: number }>();

  constructor(clock: Clock, cfg: McpProviderConfig, fetchOrOptions?: typeof fetch | McpProviderOptions) {
    this.clock = clock;
    this.cfg = configV(cfg, 'mcp') as McpProviderConfig;
    // One instance per managed account: a shared endpoint would run account actions in another account's session.
    for (const [account, ep] of Object.entries(this.cfg.account_endpoints)) {
      const norm = normalizeEndpointUrl(ep.url);
      const other = this.envOwners.get(norm);
      if (other !== undefined) {
        throw new ValidationError(
          `mcp.account_endpoints.${account}.url`,
          `endpoint ${ep.url} is already configured for account ${other}; each managed account needs its own xiaohongshu-mcp instance (own port + COOKIES_PATH), otherwise actions would run in another account's session`,
        );
      }
      this.envOwners.set(norm, account);
    }
    const options: McpProviderOptions = typeof fetchOrOptions === 'function' ? { fetchImpl: fetchOrOptions } : (fetchOrOptions ?? {});
    this.fetchImpl = options.fetchImpl;
    this.resolveAccount = options.resolveAccount ?? ((id) => id);
    this.resolveEndpoint = options.resolveEndpoint ?? null;
  }

  /** Platform account ids that have an env-configured xiaohongshu-mcp instance. */
  configuredAccounts(): string[] {
    return Object.keys(this.cfg.account_endpoints);
  }

  clearToolCache(): void {
    this.toolCache.clear();
  }

  /** Forget cached login states / identities (e.g. after an operator logged an account in). */
  clearLoginCache(): void {
    this.loginCache.clear();
    this.identityCache.clear();
  }

  /** Where the account's instance is configured (env wins over DB); never includes the token. */
  endpointInfo(accountId: string): XhsEndpointInfo {
    const env = this.envEndpointConfig(accountId);
    if (env.cfg) return { source: 'env', url: env.cfg.url };
    if (env.error || !this.resolveEndpoint) return { source: 'none', url: null };
    try {
      const db = this.resolveEndpoint(accountId);
      return db?.url ? { source: 'db', url: db.url } : { source: 'none', url: null };
    } catch {
      return { source: 'none', url: null };
    }
  }

  // ── capabilities ───────────────────────────────────────────────────────────

  async capabilities(accountId: string | null = null): Promise<CapabilityReport> {
    const states: Partial<Record<XhsCapability, Omit<CapabilityState, 'capability'>>> = {};
    const probes: Probe[] = [];
    const lookup: AccountLookup = accountId ? this.lookupAccount(accountId) : { ep: null, error: null, retryable: false };

    if (lookup.ep) {
      const probe = await this.probe(lookup.ep);
      probes.push(probe);
      for (const cap of [...PUBLIC_CAPABILITIES, ...ACCOUNT_CAPABILITIES]) states[cap] = this.stateFor(cap, probe);
    } else {
      const publicEp = this.fallbackPublicEndpoint();
      if (publicEp) {
        const probe = await this.probe(publicEp);
        probes.push(probe);
        for (const cap of PUBLIC_CAPABILITIES) states[cap] = this.stateFor(cap, probe);
      } else {
        for (const cap of PUBLIC_CAPABILITIES) states[cap] = { status: 'UNAVAILABLE', reason: NO_PUBLIC_ENDPOINT_REASON };
      }
      const accountReason = lookup.error ?? (accountId ? NO_ENDPOINT_REASON : 'account-specific capability: request capabilities for a managed account id');
      for (const cap of ACCOUNT_CAPABILITIES) states[cap] = { status: 'UNAVAILABLE', reason: accountReason };
    }

    const dmTools = [...new Set(probes.flatMap((p) => dmToolNames(p.tools ?? [])))];
    for (const cap of ['receive_messages', 'send_messages'] as const) {
      states[cap] = dmTools.length > 0 ? { status: 'REQUIRES_REVIEW', reason: this.dmReviewReason(dmTools) } : { status: 'UNAVAILABLE', reason: MCP_DM_REASONS[cap] };
    }
    return buildReport(this.name, this.mode, accountId, this.clock, states);
  }

  // ── public reads ───────────────────────────────────────────────────────────

  async searchNotes(query: string, opts: XhsSearchOptions = {}, accountId: string | null = null): Promise<ProviderResult<XhsNoteSummary[]>> {
    const ep = this.publicEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    const keyword = (query ?? '').trim();
    if (!keyword) return fail('UNAVAILABLE', 'search query is empty');
    const filters: Record<string, string> = {};
    if (opts.sort) filters.sort_by = SORT_BY[opts.sort];
    const windowDays = opts.published_within_days;
    const hasWindow = windowDays !== undefined && Number.isFinite(windowDays);
    if (hasWindow) {
      const d = windowDays;
      filters.publish_time = d <= 1 ? '一天内' : d <= 7 ? '一周内' : d <= 183 ? '半年内' : '不限';
    }
    const args: Record<string, unknown> = { keyword };
    if (Object.keys(filters).length > 0) args.filters = filters;
    const limit = opts.limit !== undefined && Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 20;
    // The server filter is coarse (一天内/一周内/半年内); apply the exact window whenever a timestamp is known.
    const minMs = hasWindow ? this.clock.now().getTime() - windowDays * DAY_MS : Number.NEGATIVE_INFINITY;
    return this.readWithLogin(
      ep,
      async () => {
        const data = parseToolJson(await this.call(ep, 'search_feeds', args, 'read'));
        return feedsOf(data)
          .map(mapFeed)
          .filter((n): n is XhsNoteSummary => n !== null)
          .filter((n) => !n.published_at || Date.parse(n.published_at) >= minMs)
          .slice(0, limit);
      },
      (notes) => notes.length === 0,
    );
  }

  async getNote(ref: XhsNoteRef, accountId: string | null = null): Promise<ProviderResult<XhsNoteDetail>> {
    const ep = this.publicEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    if (!ref.xsec_token) return fail('UNAVAILABLE', 'xsec_token is required by xiaohongshu-mcp get_feed_detail (use the token returned with search results)');
    return this.readWithLogin(ep, async () => {
      const data = obj(
        parseToolJson(
          await this.call(ep, 'get_feed_detail', { feed_id: ref.platform_post_id, xsec_token: ref.xsec_token, load_all_comments: false }, 'read'),
        ),
      );
      const inner = obj(data.data);
      const note = inner.note ?? data.note;
      if (!isObject(note)) throw new Error('get_feed_detail returned no note');
      return mapNoteDetail(note, ref);
    });
  }

  async getComments(ref: XhsNoteRef, opts: XhsCommentOptions = {}, accountId: string | null = null): Promise<ProviderResult<XhsComment[]>> {
    const ep = this.publicEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    if (!ref.xsec_token) return fail('UNAVAILABLE', 'xsec_token is required by xiaohongshu-mcp get_feed_detail (use the token returned with search results)');
    const limit = opts.limit !== undefined && Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 20;
    const includeReplies = opts.include_replies === true;
    return this.readWithLogin(
      ep,
      async () => {
        const data = obj(
          parseToolJson(
            await this.call(
              ep,
              'get_feed_detail',
              {
                feed_id: ref.platform_post_id,
                xsec_token: ref.xsec_token,
                load_all_comments: true,
                limit,
                click_more_replies: includeReplies,
                reply_limit: 10,
              },
              'read',
            ),
          ),
        );
        const inner = obj(data.data);
        const comments = inner.comments ?? data.comments;
        const list = Array.isArray(comments) ? comments : Array.isArray(obj(comments).list) ? (obj(comments).list as unknown[]) : [];
        const tops = list
          .map((c) => mapComment(c))
          .filter((c): c is XhsComment => c !== null)
          .slice(0, limit);
        if (includeReplies) return flattenComments(tops);
        return tops.map(({ sub_comments: _subs, ...flat }) => flat);
      },
      (comments) => comments.length === 0,
    );
  }

  async getUserProfile(ref: XhsUserRef, accountId: string | null = null): Promise<ProviderResult<XhsUserProfile>> {
    const ep = this.publicEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    if (!ref.xsec_token) return fail('UNAVAILABLE', 'xsec_token is required by xiaohongshu-mcp user_profile (use the token observed with the note/comment)');
    return this.readWithLogin(ep, async () => {
      const data = obj(parseToolJson(await this.call(ep, 'user_profile', { user_id: ref.platform_user_id, xsec_token: ref.xsec_token }, 'read')));
      const root = isObject(data.userBasicInfo) ? data : obj(data.data);
      const basic = obj(root.userBasicInfo);
      const nickname = strOrNull(basic.nickname ?? basic.nickName);
      // A logged-out session returns an all-empty userBasicInfo; never map that to a profile.
      if (!nickname) throw new Error('user_profile returned no userBasicInfo.nickname');
      const interactions = Array.isArray(root.interactions) ? root.interactions.map(obj) : [];
      const fans = interactions.find((i) => i.type === 'fans' || i.name === '粉丝');
      return {
        platform_user_id: ref.platform_user_id,
        nickname,
        profile_url: xhsProfileUrl(ref.platform_user_id),
        bio: strOrNull(basic.desc),
        ip_location: strOrNull(basic.ipLocation ?? basic.ip_location),
        follower_count: fans ? toCount(fans.count) : null,
        note_count: null,
        recent_notes: feedsOf(root).map(mapFeed).filter((n): n is XhsNoteSummary => n !== null),
        raw: { userBasicInfo: basic, interactions },
      };
    });
  }

  // ── account actions ────────────────────────────────────────────────────────

  async publishNote(accountId: string, draft: XhsPublishDraft): Promise<ProviderResult<XhsPublishResult>> {
    const ep = this.requireAccountEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    const images = (draft.images ?? []).filter((i) => typeof i === 'string' && i.trim());
    if (images.length === 0) return fail('REQUIRES_REVIEW', 'xiaohongshu-mcp requires at least one image');
    return this.run(
      ep,
      async () => {
        await this.call(ep, 'publish_content', { title: draft.title, content: draft.body, images, tags: draft.tags }, 'write');
        // xiaohongshu-mcp confirms success in text only; the note id must be reconciled later.
        return { platform_note_id: null, url: null };
      },
      'publish_content',
    );
  }

  async getEngagement(accountId: string, platformNoteId: string): Promise<ProviderResult<XhsEngagement>> {
    const ep = this.requireAccountEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    const result = await this.readWithLogin(ep, async () => {
      const data = parseToolJson(await this.call(ep, 'get_my_profile', { tab: 'note' }, 'read'));
      const feed = feedsOf(data).find((f) => isObject(f) && strOrNull(f.id ?? obj(f.noteCard).noteId) === platformNoteId);
      if (!isObject(feed)) return null;
      const interact = obj(obj(feed.noteCard).interactInfo);
      return {
        platform_note_id: platformNoteId,
        views: null,
        likes: toCount(interact.likedCount),
        collects: toCount(interact.collectedCount),
        comments: toCount(interact.commentCount),
        shares: toCount(interact.sharedCount),
      } satisfies XhsEngagement;
    });
    if (!result.ok) return result;
    if (!result.data) return fail('UNAVAILABLE', `note ${platformNoteId} not found among this account's notes returned by get_my_profile`);
    return { ok: true, data: result.data };
  }

  async replyToComment(accountId: string, ref: XhsCommentReplyRef, text: string): Promise<ProviderResult<XhsSendResult>> {
    const ep = this.requireAccountEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    if (!ref.xsec_token) return fail('UNAVAILABLE', 'xsec_token is required by xiaohongshu-mcp reply_comment_in_feed');
    if (!text?.trim()) return fail('UNAVAILABLE', 'reply text is empty');
    return this.run(
      ep,
      async () => {
        const args: Record<string, unknown> = {
          feed_id: ref.platform_post_id,
          xsec_token: ref.xsec_token,
          content: text,
          comment_id: ref.platform_comment_id,
        };
        if (ref.platform_user_id) args.user_id = ref.platform_user_id;
        await this.call(ep, 'reply_comment_in_feed', args, 'write');
        // The tool returns no reply id; this local reference records the confirmed reply.
        return { provider_message_id: `xhs-mcp-reply:${ref.platform_comment_id}:${this.clock.now().getTime()}` };
      },
      'reply_comment_in_feed',
    );
  }

  async listInboundMessages(accountId: string, _since: string | null): Promise<ProviderResult<XhsInboundMessage[]>> {
    return this.dmFailure(accountId, 'receive_messages');
  }

  async sendMessage(accountId: string, _toPlatformUserId: string, _text: string): Promise<ProviderResult<XhsSendResult>> {
    return this.dmFailure(accountId, 'send_messages');
  }

  // ── login session API ──────────────────────────────────────────────────────

  private authEndpoint(accountId: string | null): Endpoint | ProviderFailure {
    // An account's login must never fall back to the research instance (that would log the wrong session in).
    if (accountId) return this.requireAccountEndpoint(accountId);
    return this.fallbackPublicEndpoint() ?? fail('UNAVAILABLE', NO_PUBLIC_ENDPOINT_REASON);
  }

  private async authStatus(accountId: string | null): Promise<ProviderResult<XhsLoginStatus>> {
    const ep = this.authEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    const login = await this.checkLogin(ep, true);
    if (isFailure(login)) return login;
    if (login.state === 'unknown') {
      return fail('REQUIRES_REVIEW', `login status could not be verified (${ep.label}): ${login.detail}`);
    }
    if (login.state === 'logged_out') {
      return { ok: true, data: { logged_in: false, username: null, platform_user_id: null, red_id: null, detail: login.detail, endpoint_label: ep.label } };
    }
    const nowMs = this.clock.now().getTime();
    const cached = this.identityCache.get(ep.key);
    if (cached && cached.username === login.username && nowMs - cached.at < IDENTITY_CACHE_TTL_MS) {
      return {
        ok: true,
        data: {
          logged_in: true,
          username: login.username,
          platform_user_id: cached.platform_user_id,
          red_id: cached.red_id,
          detail: `logged in as ${login.username ?? '(unknown nickname)'}; user id verified via get_my_profile`,
          endpoint_label: ep.label,
        },
      };
    }
    let platformUserId: string | null = null;
    let redId: string | null = null;
    let identityDetail: string;
    try {
      const tools = await this.tools(ep);
      if (!tools.some((t) => t.name === 'get_my_profile')) {
        identityDetail = 'user id not verified: get_my_profile tool not exposed';
      } else {
        const identity = identityFromMyProfile(parseToolJson(await this.call(ep, 'get_my_profile', { tab: 'note' }, 'read')));
        platformUserId = identity.platform_user_id;
        redId = identity.red_id;
        identityDetail = platformUserId
          ? 'user id verified via get_my_profile'
          : 'user id not verified: the account has no own notes on get_my_profile to read it from';
        if (platformUserId) this.identityCache.set(ep.key, { username: login.username, platform_user_id: platformUserId, red_id: redId, at: nowMs });
      }
    } catch (err) {
      identityDetail = `user id not verified: get_my_profile failed (${(err as Error)?.message ?? String(err)})`;
    }
    return {
      ok: true,
      data: {
        logged_in: true,
        username: login.username,
        platform_user_id: platformUserId,
        red_id: redId,
        detail: `logged in as ${login.username ?? '(unknown nickname)'}; ${identityDetail}`,
        endpoint_label: ep.label,
      },
    };
  }

  private async authLoginQrcode(accountId: string | null): Promise<ProviderResult<XhsLoginQrcode>> {
    const ep = this.authEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    try {
      const tools = await this.tools(ep);
      if (!tools.some((t) => t.name === 'get_login_qrcode')) {
        return fail('UNAVAILABLE', `tool get_login_qrcode not exposed by this xiaohongshu-mcp server (${ep.label})`);
      }
      const res = await ep.client.callTool('get_login_qrcode', {});
      // A new QR login replaces the instance's session state: re-probe before the next read.
      this.loginCache.delete(ep.key);
      this.identityCache.delete(ep.key);
      const image = res.content.find((c): c is McpImageContent => c.type === 'image' && typeof (c as McpImageContent).data === 'string');
      if (!image) {
        if (ALREADY_LOGGED_IN_RE.test(res.text) && !res.text.includes('未登录')) {
          return { ok: true, data: { already_logged_in: true, image_data_url: null, expires_at: null, detail: res.text.trim() || 'already logged in' } };
        }
        return fail('UNAVAILABLE', `get_login_qrcode returned no QR image (${ep.label}): ${res.text.trim().slice(0, 200) || '(empty result)'}`, true);
      }
      const base64 = image.data.replace(/^data:[^;,]+;base64,/, '');
      return {
        ok: true,
        data: {
          already_logged_in: false,
          image_data_url: `data:${image.mimeType || 'image/png'};base64,${base64}`,
          // The tool's deadline text is in the instance's local time without a zone; the instance waits 4 minutes.
          expires_at: new Date(this.clock.now().getTime() + LOGIN_QRCODE_TTL_MS).toISOString(),
          detail: res.text.trim() || 'scan with the Xiaohongshu app',
        },
      };
    } catch (err) {
      return this.toFailure(ep, err);
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private dmReviewReason(tools: string[]): string {
    const base = `DM-like tool detected (${tools.join(', ')}) but unverified; not enabled`;
    return this.cfg.enable_dm_tools
      ? `${base} — enable_dm_tools is set, but DM tools stay REQUIRES_REVIEW until an authorized DM integration is verified`
      : base;
  }

  /** DM methods never call any tool. The failure status mirrors what capabilities() reports for the endpoint. */
  private async dmFailure(accountId: string, cap: 'receive_messages' | 'send_messages'): Promise<ProviderFailure> {
    const { ep } = this.lookupAccount(accountId);
    if (ep) {
      let tools: McpToolInfo[] = [];
      try {
        tools = await this.tools(ep);
      } catch {
        // unreachable endpoint: fall through to the documented UNAVAILABLE reason
      }
      const dmTools = dmToolNames(tools);
      if (dmTools.length > 0) return fail('REQUIRES_REVIEW', this.dmReviewReason(dmTools));
    }
    return fail('UNAVAILABLE', MCP_DM_REASONS[cap]);
  }

  private endpointFor(label: string, cfg: McpEndpointConfig): Endpoint {
    const key = `${cfg.url}|${cfg.token ?? ''}`;
    let client = this.clients.get(key);
    if (!client) {
      client = new McpHttpClient({ url: cfg.url, token: cfg.token, fetchImpl: this.fetchImpl, timeoutMs: this.cfg.timeout_ms });
      this.clients.set(key, client);
    }
    return { key, label, client };
  }

  /** Env-configured endpoint of an account (by resolved platform id, then by the id as given). */
  private envEndpointConfig(accountId: string): { cfg: McpEndpointConfig | null; label: string; error: string | null } {
    const endpoints = this.cfg.account_endpoints;
    let platformId: string | null;
    try {
      platformId = this.resolveAccount(accountId);
    } catch (err) {
      return { cfg: null, label: '', error: `could not resolve account ${accountId} to a platform account id: ${(err as Error)?.message ?? String(err)}` };
    }
    if (platformId && Object.hasOwn(endpoints, platformId)) return { cfg: endpoints[platformId], label: `account ${platformId}`, error: null };
    if (Object.hasOwn(endpoints, accountId)) return { cfg: endpoints[accountId], label: `account ${accountId}`, error: null };
    return { cfg: null, label: platformId ?? accountId, error: null };
  }

  /** Resolve a managed account's endpoint; resolver exceptions become a reason instead of escaping. */
  private lookupAccount(accountId: string): AccountLookup {
    const env = this.envEndpointConfig(accountId);
    if (env.error) return { ep: null, error: env.error, retryable: true };
    if (env.cfg) return { ep: this.endpointFor(env.label, env.cfg), error: null, retryable: false };
    if (!this.resolveEndpoint) return { ep: null, error: null, retryable: false };
    let db: McpEndpointConfig | null;
    try {
      db = this.resolveEndpoint(accountId);
    } catch (err) {
      return { ep: null, error: `could not resolve the xiaohongshu-mcp endpoint of account ${accountId}: ${(err as Error)?.message ?? String(err)}`, retryable: true };
    }
    if (!db || typeof db.url !== 'string' || !db.url.trim()) return { ep: null, error: null, retryable: false };
    if (!/^https?:\/\//i.test(db.url.trim())) {
      return { ep: null, error: `invalid xiaohongshu-mcp endpoint url configured for account ${env.label}: ${db.url}`, retryable: false };
    }
    const owner = this.envOwners.get(normalizeEndpointUrl(db.url));
    if (owner !== undefined && owner !== env.label && owner !== accountId) {
      return {
        ep: null,
        error: `endpoint ${db.url} of account ${env.label} is already configured for account ${owner}; each managed account needs its own xiaohongshu-mcp instance (own port + COOKIES_PATH)`,
        retryable: false,
      };
    }
    return { ep: this.endpointFor(`account ${env.label} (db)`, { url: db.url.trim(), token: db.token }), error: null, retryable: false };
  }

  private requireAccountEndpoint(accountId: string): Endpoint | ProviderFailure {
    const { ep, error, retryable } = this.lookupAccount(accountId);
    if (error) return fail('UNAVAILABLE', error, retryable);
    return ep ?? fail('UNAVAILABLE', NO_ENDPOINT_REASON);
  }

  private fallbackPublicEndpoint(): Endpoint | null {
    if (this.cfg.research_endpoint) return this.endpointFor('research', this.cfg.research_endpoint);
    const first = Object.keys(this.cfg.account_endpoints)[0];
    return first ? this.endpointFor(`account ${first}`, this.cfg.account_endpoints[first]) : null;
  }

  private publicEndpoint(accountId: string | null | undefined): Endpoint | ProviderFailure {
    if (accountId) {
      const { ep } = this.lookupAccount(accountId);
      if (ep) return ep;
    }
    return this.fallbackPublicEndpoint() ?? fail('UNAVAILABLE', NO_PUBLIC_ENDPOINT_REASON);
  }

  private async tools(ep: Endpoint): Promise<McpToolInfo[]> {
    const nowMs = this.clock.now().getTime();
    const cached = this.toolCache.get(ep.key);
    if (cached && nowMs - cached.at < TOOL_CACHE_TTL_MS) return cached.tools;
    try {
      const tools = await ep.client.listTools();
      this.toolCache.set(ep.key, { tools, at: nowMs });
      return tools;
    } catch (err) {
      this.toolCache.delete(ep.key);
      throw err;
    }
  }

  private rememberLogin(ep: Endpoint, state: 'logged_in' | 'logged_out', username: string | null, detail: string): void {
    this.loginCache.set(ep.key, { state, username, detail, at: this.clock.now().getTime() });
    if (state === 'logged_out') this.identityCache.delete(ep.key);
  }

  /**
   * Login state of an endpoint: the cached state when fresh (unless `fresh`), else a live check_login_status.
   * Unreachable endpoints / failed probes return a ProviderFailure (UNAVAILABLE), never REQUIRES_AUTH.
   */
  private async checkLogin(ep: Endpoint, fresh = false): Promise<LoginCheck | ProviderFailure> {
    const nowMs = this.clock.now().getTime();
    const cached = this.loginCache.get(ep.key);
    if (!fresh && cached && nowMs - cached.at < LOGIN_CACHE_TTL_MS) {
      return { state: cached.state, username: cached.username, detail: cached.detail, live: false };
    }
    let tools: McpToolInfo[];
    try {
      tools = await this.tools(ep);
    } catch (err) {
      return this.toFailure(ep, err);
    }
    if (!tools.some((t) => t.name === 'check_login_status')) {
      return { state: 'unknown', username: null, detail: 'check_login_status tool not exposed', live: true };
    }
    try {
      const res = await ep.client.callTool('check_login_status', {});
      const parsed = parseLoginStatusText(res.text);
      const detail = res.text.trim().slice(0, 160);
      this.rememberLogin(ep, parsed.logged_in ? 'logged_in' : 'logged_out', parsed.username, detail);
      return { state: parsed.logged_in ? 'logged_in' : 'logged_out', username: parsed.username, detail, live: true };
    } catch (err) {
      if (err instanceof McpError && err.kind === 'tool' && LOGIN_REQUIRED_RE.test(err.message)) {
        this.rememberLogin(ep, 'logged_out', null, err.message.slice(0, 160));
        return { state: 'logged_out', username: null, detail: err.message.slice(0, 160), live: true };
      }
      this.loginCache.delete(ep.key);
      return this.toFailure(ep, err);
    }
  }

  private authFailure(ep: Endpoint, detail: string): ProviderFailure {
    return fail(
      'REQUIRES_AUTH',
      `Xiaohongshu session not logged in (${ep.label}): ${detail.replace(/\s+/g, ' ').trim() || '未登录'} — log in via QR code (get_login_qrcode) before reading public content`,
    );
  }

  /**
   * Run a read tool on a verified session. Logged out → REQUIRES_AUTH without calling the tool. A failed or
   * empty read re-verifies the session (unless it was verified live moments ago in this call), because a
   * logged-out xiaohongshu-mcp reports timeouts / "笔记不可访问" / empty payloads instead of a login error.
   */
  private async readWithLogin<T>(ep: Endpoint, fn: () => Promise<T>, isEmpty?: (data: T) => boolean): Promise<ProviderResult<T>> {
    const before = await this.checkLogin(ep);
    if (isFailure(before)) return before;
    if (before.state === 'logged_out') return this.authFailure(ep, before.detail);
    const result = await this.run(ep, fn);
    if (result.ok) {
      if (isEmpty?.(result.data) && !before.live) {
        const again = await this.checkLogin(ep, true);
        if (!isFailure(again) && again.state === 'logged_out') return this.authFailure(ep, again.detail);
      }
      return result;
    }
    if (result.status === 'REQUIRES_AUTH') return result;
    if (!before.live) {
      const again = await this.checkLogin(ep, true);
      if (!isFailure(again) && again.state === 'logged_out') return this.authFailure(ep, again.detail);
    }
    return result;
  }

  /**
   * Call a tool and classify its text result.
   * - read: JSON payloads pass through; non-JSON text whose earliest marker is 失败 / login-required fails.
   * - write: the earliest marker must be 成功; 失败 / login-required fail; anything else is UNCONFIRMED.
   * Login-required text marks the endpoint's session logged out.
   */
  private async call(ep: Endpoint, tool: string, args: Record<string, unknown>, mode: CallMode): Promise<string> {
    try {
      const result = await ep.client.callTool(tool, args);
      const text = result.text.trim();
      const isJson = text.startsWith('{') || text.startsWith('[');
      const verdict = classifyToolText(text);
      if (verdict === 'login_required' && !isJson) this.rememberLogin(ep, 'logged_out', null, text.slice(0, 160));
      if (mode === 'write') {
        if (verdict === 'success') return result.text;
        if (verdict === 'failure' || verdict === 'login_required') throw new McpError('tool', text, { data: result, method: 'tools/call' });
        throw new UnconfirmedWriteError(tool, text);
      }
      if (!isJson && (verdict === 'failure' || verdict === 'login_required')) {
        throw new McpError('tool', text, { data: result, method: 'tools/call' });
      }
      return result.text;
    } catch (err) {
      if (err instanceof McpError && err.kind === 'tool' && classifyToolText(err.message) === 'login_required') {
        this.rememberLogin(ep, 'logged_out', null, err.message.slice(0, 160));
      }
      this.toolCache.delete(ep.key);
      throw err;
    }
  }

  private async probe(ep: Endpoint): Promise<Probe> {
    let tools: McpToolInfo[];
    try {
      tools = await this.tools(ep);
    } catch (err) {
      return { endpoint: ep, tools: null, unreachable: (err as Error).message, login: 'unknown', loginDetail: '', username: null };
    }
    if (!tools.some((t) => t.name === 'check_login_status')) {
      return { endpoint: ep, tools, unreachable: null, login: 'unknown', loginDetail: 'check_login_status tool not exposed', username: null };
    }
    try {
      const res = await ep.client.callTool('check_login_status', {});
      const parsed = parseLoginStatusText(res.text);
      this.rememberLogin(ep, parsed.logged_in ? 'logged_in' : 'logged_out', parsed.username, res.text.trim().slice(0, 160));
      return { endpoint: ep, tools, unreachable: null, login: parsed.logged_in ? 'logged_in' : 'logged_out', loginDetail: res.text.slice(0, 120), username: parsed.username };
    } catch (err) {
      this.toolCache.delete(ep.key);
      this.loginCache.delete(ep.key);
      if (err instanceof McpError && (err.kind === 'network' || err.kind === 'timeout')) {
        return { endpoint: ep, tools: null, unreachable: err.message, login: 'unknown', loginDetail: '', username: null };
      }
      if (err instanceof McpError && err.kind === 'tool' && LOGIN_REQUIRED_RE.test(err.message)) {
        this.rememberLogin(ep, 'logged_out', null, err.message.slice(0, 160));
        return { endpoint: ep, tools, unreachable: null, login: 'logged_out', loginDetail: err.message.slice(0, 120), username: null };
      }
      return { endpoint: ep, tools, unreachable: null, login: 'unknown', loginDetail: (err as Error).message.slice(0, 160), username: null };
    }
  }

  private stateFor(cap: XhsCapability, probe: Probe): Omit<CapabilityState, 'capability'> {
    const tool = CAPABILITY_TOOLS[cap]!;
    if (probe.unreachable !== null || probe.tools === null) {
      return { status: 'UNAVAILABLE', reason: `xiaohongshu-mcp endpoint unreachable (${probe.endpoint.label}): ${probe.unreachable ?? 'unknown error'}` };
    }
    if (!probe.tools.some((t) => t.name === tool)) {
      return { status: 'UNAVAILABLE', reason: `tool ${tool} not exposed by this xiaohongshu-mcp server (${probe.endpoint.label})` };
    }
    if (probe.login === 'logged_out') {
      return {
        status: 'REQUIRES_AUTH',
        reason: `Xiaohongshu session not logged in on ${probe.endpoint.label} (log in via get_login_qrcode)`,
      };
    }
    if (probe.login === 'unknown') {
      return { status: 'REQUIRES_REVIEW', reason: `login status could not be verified on ${probe.endpoint.label}: ${probe.loginDetail}` };
    }
    const note = CAPABILITY_NOTES[cap];
    const who = probe.username ? `, logged in as ${probe.username}` : '';
    return { status: 'AVAILABLE', reason: `via xiaohongshu-mcp ${tool} (${probe.endpoint.label}${who})${note ? `; ${note}` : ''}` };
  }

  private async run<T>(ep: Endpoint, fn: () => Promise<T>, writeTool?: string): Promise<ProviderResult<T>> {
    try {
      return { ok: true, data: await fn() };
    } catch (err) {
      return this.toFailure(ep, err, writeTool);
    }
  }

  /** True when a write tool call may have been executed by the server although no confirmation arrived. */
  private isUnknownWriteOutcome(err: unknown): boolean {
    if (err instanceof UnconfirmedWriteError) return true;
    if (!(err instanceof McpError) || err.method !== 'tools/call') return false;
    switch (err.kind) {
      case 'timeout':
        return true;
      case 'network':
        return !isConnectFailure(err);
      case 'http':
        // 5xx (gateway timeout, proxy error, handler crash) may follow execution; 503 means "not processed".
        return (err.status ?? 0) >= 500 && err.status !== 503;
      case 'rpc':
        return err.code === null; // unparseable / result-less response (not a JSON-RPC rejection)
      default:
        return false;
    }
  }

  private toFailure(ep: Endpoint, err: unknown, writeTool?: string): ProviderFailure {
    if (writeTool && this.isUnknownWriteOutcome(err)) {
      return fail(
        'REQUIRES_REVIEW',
        `${writeTool} outcome unknown (${ep.label}): ${(err as Error).message} — the action may have been performed; verify on the Xiaohongshu account before retrying to avoid a duplicate`,
        false,
      );
    }
    if (err instanceof ValidationError) return fail('UNAVAILABLE', err.message);
    if (!(err instanceof McpError)) {
      return fail('UNAVAILABLE', `unexpected xiaohongshu-mcp response (${ep.label}): ${(err as Error)?.message ?? String(err)}`);
    }
    switch (err.kind) {
      case 'network':
      case 'timeout':
        return fail('UNAVAILABLE', `xiaohongshu-mcp ${err.kind} (${ep.label}): ${err.message}`, true);
      case 'http':
        if (err.status === 401 || err.status === 403) {
          return fail('UNAVAILABLE', `xiaohongshu-mcp rejected the request (${ep.label}): check AUTH_TOKEN — ${err.message}`);
        }
        return fail('UNAVAILABLE', `xiaohongshu-mcp HTTP error (${ep.label}): ${err.message}`, err.status === 429 || (err.status ?? 0) >= 500);
      case 'rpc':
        return fail('UNAVAILABLE', `xiaohongshu-mcp protocol error (${ep.label}): ${err.message}`);
      case 'tool':
        if (LOGIN_REQUIRED_RE.test(err.message) && classifyToolText(err.message) === 'login_required') {
          return fail('REQUIRES_AUTH', `Xiaohongshu session not logged in (${ep.label}): ${err.message}`);
        }
        return fail('UNAVAILABLE', `xiaohongshu-mcp tool failed (${ep.label}): ${err.message}`, true);
    }
  }
}

function dmToolNames(tools: McpToolInfo[]): string[] {
  return tools.map((t) => t.name).filter((n) => DM_TOOL_PATTERN.test(n));
}

function isEndpoint(x: Endpoint | ProviderFailure): x is Endpoint {
  return (x as ProviderFailure).ok !== false;
}
