import { constants as fsConstants, accessSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../../core/clock.ts';
import { DAY_MS } from '../../core/time.ts';
import { ValidationError } from '../../core/errors.ts';
import { NOTIFICATION_TABS, type NotificationKind, type NotificationTab, type XhsCapability, type XhsOwnNote, type XhsOwnProfile } from '../../core/types.ts';
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
  XhsNoteWithComments,
  XhsNotificationItem,
  XhsNotificationOptions,
  XhsNotificationPage,
  XhsProvider,
  XhsPublishDraft,
  XhsPublishResult,
  XhsSearchOptions,
  XhsSendResult,
  XhsUnreadCounts,
  XhsUserProfile,
  XhsUserRef,
  XhsLocalInstance,
  XhsLocalInstanceApi,
  XhsVisibleLoginApi,
  XhsVisibleLoginJob,
} from './types.ts';
import { buildReport } from './unavailable.ts';
import { DEFAULT_VISIBLE_LOGIN_TIMEOUT_MS, INSTANCE_NAME_RE, runVisibleLoginHelper, type VisibleLoginRunner } from './visible-login.ts';
import { DEFAULT_DM_SEND_TIMEOUT_MS, DM_SEND_UNKNOWN_MARK, runDmSendHelper, type DmSendRunner } from './dm-send.ts';
import {
  DEFAULT_BASE_PORT,
  findInstancePort,
  instanceUrl,
  isLoopbackHost,
  probePortFree,
  recordedPort,
  runningPid,
  startLocalInstanceProcess,
  waitForHealth,
  type LocalInstanceRunner,
  type PortProbe,
} from './local-instance.ts';

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
 * One call at a time per instance: every tool call launches a headless browser in xiaohongshu-mcp, and
 * overlapping calls on one instance pile up browsers on the same cookies (and leak them when a call
 * panics). Tool calls are therefore queued per instance URL; concurrent login-status probes of one
 * instance share a single probe.
 *
 * Login: Xiaohongshu rejects QR logins scanned from the instance's headless browser. When
 * `visible_login` is configured, `auth.visibleLogin` logs a local instance in through a visible
 * browser window instead (see visible-login.ts).
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
  /** visible-browser login for instances on this host (absent = only headless QR login) */
  visible_login?: McpVisibleLoginConfig;
  /** this host runs the instances itself: the console may start an account's own instance (absent = it may not) */
  local_instances?: McpLocalInstancesConfig;
  /**
   * Opt-in DM sending through the account's own logged-in session (tools/xhs-dm-send). Absent (the default) keeps
   * `send_messages` UNAVAILABLE: there is no authorized DM API, so without this the console never sends a DM itself.
   */
  dm_sender?: McpDmSenderConfig;
}

export interface McpDmSenderConfig {
  /** the built tools/xhs-dm-send binary */
  helper_path: string;
  /** instance state dir: <data_dir>/<instance>/cookies.json — the session the message is sent from */
  data_dir: string;
  timeout_ms?: number;
}

export interface McpLocalInstancesConfig {
  /** the xiaohongshu-mcp binary on this host */
  binary_path: string;
  /** state dir shared with the fleet script: <data_dir>/<instance>/{cookies.json,server.log,pid,port} */
  data_dir: string;
  /** address the instances listen on; loopback only */
  bind: string;
  /** the research instance's port; accounts take base_port + 1, + 2, … */
  base_port?: number;
  /** AUTH_TOKEN the started instance requires — the same token this process authenticates with */
  token: string;
}

export interface McpVisibleLoginConfig {
  /** the built tools/xhs-visible-login binary */
  helper_path: string;
  /** instance state dir: <data_dir>/<instance>/cookies.json, instance = 'research' or the platform account id */
  data_dir: string;
  timeout_ms?: number;
}

export interface McpProviderOptions {
  fetchImpl?: typeof fetch;
  /** runs the login helper (tests inject a fake); default spawns the helper process */
  runVisibleLogin?: VisibleLoginRunner;
  /** starts a local xiaohongshu-mcp instance (tests inject a fake); default spawns the process */
  startLocalInstance?: LocalInstanceRunner;
  /** sends one reviewed DM through the account's own session (tests inject a fake); default spawns tools/xhs-dm-send */
  runDmSend?: DmSendRunner;
  /** checks whether a port is free (tests inject a fake) */
  probePort?: PortProbe;
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
  read_notifications: 'list_notifications',
  reply_comments: 'reply_comment_in_feed',
};
const PUBLIC_CAPABILITIES: XhsCapability[] = ['search_public_content', 'read_public_post', 'read_public_comments', 'read_public_profile'];
const ACCOUNT_CAPABILITIES: XhsCapability[] = ['publish_content', 'read_engagement', 'read_notifications', 'reply_comments'];
const CAPABILITY_NOTES: Partial<Record<XhsCapability, string>> = {
  read_public_comments: 'load_all_comments',
  read_public_profile: 'requires the xsec_token observed with the user',
  publish_content: 'image note needs ≥1 image, video note needs one local video file (publish_with_video); no note id is returned (reconcile later)',
  read_engagement: "own notes via get_my_profile; no view counts",
  read_notifications: 'reading a tab clears its unread badge on Xiaohongshu (get_unread_count does not)',
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
  visible_login: v.optional(
    v.object({ helper_path: v.string({ min: 1 }), data_dir: v.string({ min: 1 }), timeout_ms: v.optional(v.number({ int: true, min: 1 })) }),
  ),
  local_instances: v.optional(
    v.object({
      binary_path: v.string({ min: 1 }),
      data_dir: v.string({ min: 1 }),
      bind: v.string({ min: 1 }),
      base_port: v.optional(v.number({ int: true, min: 1, max: 65_535 })),
      token: v.string({ min: 1 }),
    }),
  ),
  dm_sender: v.optional(
    v.object({ helper_path: v.string({ min: 1 }), data_dir: v.string({ min: 1 }), timeout_ms: v.optional(v.number({ int: true, min: 1 })) }),
  ),
});

interface Endpoint {
  key: string;
  label: string;
  client: McpHttpClient;
  /** normalized instance URL: calls on one lane never overlap */
  lane: string;
  url: string;
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

// ── notification centre ──────────────────────────────────────────────────────

/** Epoch seconds (what Xiaohongshu sends) or milliseconds → ISO-8601, null when it is neither. */
function notificationTime(value: unknown): string | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * What kind of event a notification is. The platform's own `type` (`liked/item`, `faved/item`, `follow/you`, …) decides
 * it; its Chinese wording is the fallback so a type string we have never seen still lands in the right bucket instead
 * of silently becoming a like.
 */
export function notificationKindOf(rawType: string, title: string, tab: NotificationTab, hasComment: boolean): NotificationKind {
  const t = rawType.toLowerCase();
  if (t.includes('follow')) return 'follow';
  if (t.includes('fav') || t.includes('collect')) return 'collect';
  if (t.includes('like')) return 'like';
  if (t.includes('mention') || t.includes('@')) return 'mention';
  if (t.includes('comment')) return 'comment';
  if (/关注/.test(title)) return 'follow';
  if (/收藏/.test(title)) return 'collect';
  if (/赞/.test(title)) return 'like';
  if (/回复|评论/.test(title)) return 'comment';
  if (/提到|@/.test(title)) return 'mention';
  if (hasComment) return 'comment';
  return tab === 'mentions' ? 'mention' : tab === 'connections' ? 'follow' : 'other';
}

/** One page of list_notifications. Entries without a sender or a usable time are dropped: they cannot be acted on. */
export function notificationsFrom(data: Obj | unknown[], tab: NotificationTab): XhsNotificationPage {
  const root = Array.isArray(data) ? { items: data } : obj(data);
  const rawTab = strOrNull(root.tab);
  const page: XhsNotificationPage = {
    tab: (NOTIFICATION_TABS as readonly string[]).includes(rawTab ?? '') ? (rawTab as NotificationTab) : tab,
    filtered: toCount(root.filtered),
    items: [],
  };
  const list = Array.isArray(root.items) ? root.items : [];
  for (const raw of list) {
    const item = obj(raw);
    const id = strOrNull(item.id);
    const from = obj(item.from);
    const userId = strOrNull(from.user_id ?? from.userId);
    const at = notificationTime(item.time);
    if (!id || !userId || !at) continue;
    const rawType = strOrNull(item.type) ?? '';
    const title = strOrNull(item.title) ?? '';
    const commentId = strOrNull(item.comment_id);
    page.items.push({
      provider_notification_id: id,
      tab: page.tab,
      kind: notificationKindOf(rawType, title, page.tab, Boolean(commentId)),
      raw_type: rawType,
      title,
      occurred_at: at,
      from_user_id: userId,
      from_nickname: strOrNull(from.nickname ?? from.nickName),
      from_xsec_token: strOrNull(from.xsec_token ?? from.xsecToken),
      comment_id: commentId,
      comment_text: strOrNull(item.comment_text),
      comment_liked: item.liked === true,
      note_id: strOrNull(item.feed_id),
      note_xsec_token: strOrNull(item.feed_xsec_token),
      note_title: strOrNull(item.feed_title),
    });
  }
  return page;
}

export function unreadCountsFrom(data: Obj | unknown[]): XhsUnreadCounts {
  const root = Array.isArray(data) ? {} : obj(data);
  const mentions = toCount(root.mentions);
  const likes = toCount(root.likes);
  const connections = toCount(root.connections);
  return { mentions, likes, connections, total: mentions + likes + connections };
}

function mapAuthor(user: unknown): XhsAuthor {
  const u = obj(user);
  const id = strOrNull(u.userId ?? u.user_id ?? u.id);
  return {
    platform_user_id: id,
    nickname: strOrNull(u.nickname ?? u.nickName ?? u.nick_name),
    profile_url: id ? xhsProfileUrl(id) : null,
    // comments carry an empty `avatar` string when the platform does not expose one: strOrNull keeps that null
    avatar_url: strOrNull(u.avatar ?? u.image ?? u.avatarUrl ?? u.avatar_url),
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
    comment_count: interact.commentCount ?? interact.comment_count ? toCount(interact.commentCount ?? interact.comment_count) : null,
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

function noteOf(data: Obj, ref: XhsNoteRef): XhsNoteDetail {
  const note = obj(data.data).note ?? data.note;
  if (!isObject(note)) throw new Error('get_feed_detail returned no note');
  return mapNoteDetail(note, ref);
}

const commentLimit = (opts: XhsCommentOptions): number =>
  opts.limit !== undefined && Number.isFinite(opts.limit) ? Math.max(1, Math.floor(opts.limit)) : 20;

function commentsOf(data: Obj, opts: XhsCommentOptions): XhsComment[] {
  const limit = commentLimit(opts);
  const comments = obj(data.data).comments ?? data.comments;
  const list = Array.isArray(comments) ? comments : Array.isArray(obj(comments).list) ? (obj(comments).list as unknown[]) : [];
  const tops = list
    .map((c) => mapComment(c))
    .filter((c): c is XhsComment => c !== null)
    .slice(0, limit);
  if (opts.include_replies === true) return flattenComments(tops);
  return tops.map(({ sub_comments: _subs, ...flat }) => flat);
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

/** A count the web payload may leave empty: '' / missing → null (unknown), never 0. */
function countOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return toCount(value);
}

/**
 * The account's own profile from get_my_profile: userBasicInfo (nickname, redId, avatar, desc, ipLocation),
 * interactions (follows / fans / 获赞与收藏) and the own notes shown on the profile page.
 */
export function profileFromMyProfile(data: Obj | unknown[]): XhsOwnProfile {
  const root = Array.isArray(data) ? {} : isObject(data.userBasicInfo) ? data : obj(data.data);
  const basic = obj(root.userBasicInfo);
  const interaction = (type: string): number | null => {
    const hit = (Array.isArray(root.interactions) ? root.interactions : []).map(obj).find((i) => i.type === type);
    return hit ? countOrNull(hit.count) : null;
  };
  const notes: XhsOwnNote[] = [];
  for (const raw of feedsOf(root)) {
    const feed = obj(raw);
    const card = obj(feed.noteCard);
    const id = strOrNull(feed.id ?? card.noteId);
    if (!id) continue;
    const cover = obj(card.cover);
    const info = obj(card.interactInfo);
    notes.push({
      platform_note_id: id,
      title: strOrNull(card.displayTitle ?? card.title) ?? '',
      // Kept as its own field: reading a note's body needs the token, and rebuilding it from the URL is lossy.
      xsec_token: strOrNull(feed.xsecToken ?? feed.xsec_token),
      url: xhsNoteUrl(id, strOrNull(feed.xsecToken ?? feed.xsec_token)),
      cover_url: strOrNull(cover.urlDefault ?? cover.urlPre ?? cover.url),
      liked_count: countOrNull(info.likedCount),
      collected_count: countOrNull(info.collectedCount),
      comment_count: countOrNull(info.commentCount),
    });
  }
  return {
    nickname: strOrNull(basic.nickname ?? basic.nickName),
    red_id: strOrNull(basic.redId ?? basic.red_id),
    avatar_url: strOrNull(basic.imageb ?? basic.images ?? basic.avatar),
    bio: strOrNull(basic.desc),
    ip_location: strOrNull(basic.ipLocation),
    follows: interaction('follows'),
    fans: interaction('fans'),
    liked_and_collected: interaction('interaction'),
    notes,
  };
}

/** True for http(s) URLs on this host (the only instances whose cookies a local login window can write). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url.trim()).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

/** TCP port an endpoint URL points at (80/443 when it is implied), or null when the URL is unusable. */
export function portOfUrl(url: string): number | null {
  try {
    const u = new URL(url.trim());
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : null;
  } catch {
    return null;
  }
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

/**
 * read: a JSON payload or non-failing text. write: the tool confirms in words (成功). write_json: the tool confirms by
 * returning the JSON record of what it did (reply_notification / like_notification do this) — an error result has
 * already thrown by then, so a JSON body without a failure marker is the confirmation.
 */
type CallMode = 'read' | 'write' | 'write_json';

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
  /** Login-session API (QR / login-window login from the console, verified identity). */
  readonly auth: XhsAuthApi;

  private readonly clock: Clock;
  private readonly cfg: McpProviderConfig;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly runVisibleLogin: VisibleLoginRunner;
  private readonly runLocalInstance: LocalInstanceRunner;
  private readonly runDmSend: DmSendRunner;
  private readonly probePort: PortProbe;
  /** instance name → the start in flight (a second click waits for the first instead of starting a second process) */
  private readonly localStarts = new Map<string, Promise<ProviderResult<XhsLocalInstance>>>();
  /** instance lane → tail of its call queue */
  private readonly lanes = new Map<string, Promise<unknown>>();
  /** endpoint key → the login-status probe in flight (concurrent callers share it) */
  private readonly statusInFlight = new Map<string, Promise<ProviderResult<XhsLoginStatus>>>();
  /** endpoint key → until when a login (QR or window) is pending: logged-out reports are expected, not stale */
  private readonly pendingLogin = new Map<string, number>();
  /** instance name → latest login-window job */
  private readonly visibleJobs = new Map<string, XhsVisibleLoginJob>();
  private readonly resolveAccount: (internalAccountId: string) => string | null;
  private readonly resolveEndpoint: ((accountId: string) => McpEndpointConfig | null) | null;
  /** normalized env account endpoint URL → platform account id */
  private readonly envOwners = new Map<string, string>();
  private readonly clients = new Map<string, McpHttpClient>();
  private readonly toolCache = new Map<string, { tools: McpToolInfo[]; at: number }>();
  private readonly loginCache = new Map<string, { state: 'logged_in' | 'logged_out'; username: string | null; detail: string; at: number }>();
  private readonly identityCache = new Map<
    string,
    { username: string | null; platform_user_id: string; red_id: string | null; profile: XhsOwnProfile | null; at: number }
  >();

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
    this.runVisibleLogin = options.runVisibleLogin ?? runVisibleLoginHelper;
    this.runLocalInstance = options.startLocalInstance ?? startLocalInstanceProcess;
    this.runDmSend = options.runDmSend ?? runDmSendHelper;
    this.probePort = options.probePort ?? probePortFree;
    const visibleLogin: XhsVisibleLoginApi | undefined = this.cfg.visible_login
      ? { start: (accountId) => this.startVisibleLogin(accountId), status: (accountId) => this.visibleLoginStatus(accountId) }
      : undefined;
    const localInstance: XhsLocalInstanceApi | undefined = this.cfg.local_instances
      ? { start: (accountId, opts) => this.startLocalInstance(accountId, opts?.reserved_ports ?? [], opts?.known_port ?? null) }
      : undefined;
    this.auth = {
      status: (accountId) => this.authStatus(accountId),
      loginQrcode: (accountId) => this.authLoginQrcode(accountId),
      logout: (accountId) => this.authLogout(accountId),
      ...(visibleLogin ? { visibleLogin } : {}),
      ...(localInstance ? { localInstance } : {}),
    };
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
    this.pendingLogin.clear();
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
    // Opt-in sending through the account's own session (tools/xhs-dm-send). Reading the inbox stays impossible, and a
    // DM-like tool on the instance still wins: an unknown tool is reviewed, never trusted because we also have a sender.
    if (this.cfg.dm_sender && accountId && dmTools.length === 0) {
      const ready = this.dmSenderReady(accountId, this.cfg.dm_sender);
      states.send_messages =
        typeof ready === 'string'
          ? { status: 'AVAILABLE', reason: `由该账号自己的登录会话发送（tools/xhs-dm-send，实例 ${ready}）：没有官方私信接口，发送后以会话中读回的消息为准` }
          : { status: ready.status, reason: ready.reason };
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
    return this.readWithLogin(ep, async () =>
      noteOf(
        obj(parseToolJson(await this.call(ep, 'get_feed_detail', { feed_id: ref.platform_post_id, xsec_token: ref.xsec_token, load_all_comments: false }, 'read'))),
        ref,
      ),
    );
  }

  async getComments(ref: XhsNoteRef, opts: XhsCommentOptions = {}, accountId: string | null = null): Promise<ProviderResult<XhsComment[]>> {
    const ep = this.publicEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    if (!ref.xsec_token) return fail('UNAVAILABLE', 'xsec_token is required by xiaohongshu-mcp get_feed_detail (use the token returned with search results)');
    return this.readWithLogin(
      ep,
      async () => commentsOf(await this.feedDetailWithComments(ep, ref, opts), opts),
      (comments) => comments.length === 0,
    );
  }

  /** Detail + comments from one get_feed_detail call (one page load instead of two). */
  async getNoteWithComments(ref: XhsNoteRef, opts: XhsCommentOptions = {}, accountId: string | null = null): Promise<ProviderResult<XhsNoteWithComments>> {
    const ep = this.publicEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    if (!ref.xsec_token) return fail('UNAVAILABLE', 'xsec_token is required by xiaohongshu-mcp get_feed_detail (use the token returned with search results)');
    // The note itself proves the page loaded (a logged-out session gets "笔记不可访问", i.e. no note), so a note
    // without comments is a real empty comment section, not a reason to re-check the login.
    return this.readWithLogin(ep, async () => {
      const data = await this.feedDetailWithComments(ep, ref, opts);
      return { note: noteOf(data, ref), comments: commentsOf(data, opts) };
    });
  }

  private async feedDetailWithComments(ep: Endpoint, ref: XhsNoteRef, opts: XhsCommentOptions): Promise<Obj> {
    return obj(
      parseToolJson(
        await this.call(
          ep,
          'get_feed_detail',
          {
            feed_id: ref.platform_post_id,
            xsec_token: ref.xsec_token,
            load_all_comments: true,
            limit: commentLimit(opts),
            click_more_replies: opts.include_replies === true,
            reply_limit: 10,
          },
          'read',
        ),
      ),
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
        avatar_url: strOrNull(basic.imageb ?? basic.images ?? basic.avatar ?? basic.image),
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

  /**
   * Publish an image note (`publish_content`) or, when the draft carries a video, a video note
   * (`publish_with_video`: one local file on the instance's host, no images). Neither returns a note id.
   */
  async publishNote(accountId: string, draft: XhsPublishDraft): Promise<ProviderResult<XhsPublishResult>> {
    const ep = this.requireAccountEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    const video = typeof draft.video === 'string' ? draft.video.trim() : '';
    if (video) {
      if (!video.startsWith('/')) return fail('UNAVAILABLE', 'xiaohongshu-mcp publish_with_video takes one absolute local path on the instance host, not a URL');
      const tools = await this.tools(ep).catch(() => [] as McpToolInfo[]);
      if (!tools.some((t) => t.name === 'publish_with_video')) {
        return fail('UNAVAILABLE', `tool publish_with_video not exposed by this xiaohongshu-mcp server (${ep.label})`);
      }
      return this.run(
        ep,
        async () => {
          await this.call(ep, 'publish_with_video', { title: draft.title, content: draft.body, video, tags: draft.tags }, 'write');
          return { platform_note_id: null, url: null };
        },
        'publish_with_video',
      );
    }
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

  // ── notification centre ────────────────────────────────────────────────────

  /** Unread badges per tab. This is the one call that does NOT clear them. */
  async getUnreadCounts(accountId: string): Promise<ProviderResult<XhsUnreadCounts>> {
    const ep = this.requireAccountEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    return this.readWithLogin(ep, async () => unreadCountsFrom(parseToolJson(await this.call(ep, 'get_unread_count', {}, 'read'))));
  }

  /**
   * One tab of the notification centre. Reading it clears that tab's unread badge on Xiaohongshu — the same thing
   * opening the page in the app does. `filtered` counts entries the platform hid from us (deleted comment, note under
   * review), so callers can say the list is shorter than reality instead of pretending it is complete.
   */
  async listNotifications(accountId: string, opts: XhsNotificationOptions = {}): Promise<ProviderResult<XhsNotificationPage>> {
    const ep = this.requireAccountEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    const tab: NotificationTab = opts.tab ?? 'mentions';
    const args: Record<string, unknown> = { tab };
    if (opts.limit && opts.limit > 0) args.limit = Math.floor(opts.limit);
    return this.readWithLogin(
      ep,
      async () => notificationsFrom(parseToolJson(await this.call(ep, 'list_notifications', args, 'read')), tab),
      (page) => page.items.length === 0 && page.filtered === 0,
    );
  }

  /** Public reply to the comment a notification points at (no note id needed). */
  async replyToNotification(accountId: string, commentId: string, text: string): Promise<ProviderResult<XhsSendResult>> {
    const ep = this.requireAccountEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    const comment = (commentId ?? '').trim();
    if (!comment) return fail('UNAVAILABLE', 'no comment id: this notification cannot be replied to');
    const body = (text ?? '').trim();
    if (!body) return fail('UNAVAILABLE', 'reply text is empty');
    return this.run(
      ep,
      async () => {
        await this.call(ep, 'reply_notification', { comment_id: comment, content: body }, 'write_json');
        // The tool returns the reply it made, not an id of its own; this local reference records the confirmed reply.
        return { provider_message_id: `xhs-mcp-notify-reply:${comment}:${this.clock.now().getTime()}` };
      },
      'reply_notification',
    );
  }

  /** Like (or unlike) the comment a notification points at. The tool skips when it is already in that state. */
  async likeNotificationComment(accountId: string, commentId: string, unlike = false): Promise<ProviderResult<{ liked: boolean }>> {
    const ep = this.requireAccountEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    const comment = (commentId ?? '').trim();
    if (!comment) return fail('UNAVAILABLE', 'no comment id: this notification cannot be liked');
    return this.run(
      ep,
      async () => {
        await this.call(ep, 'like_notification', { comment_id: comment, unlike }, 'write_json');
        return { liked: !unlike };
      },
      'like_notification',
    );
  }

  async listInboundMessages(accountId: string, _since: string | null): Promise<ProviderResult<XhsInboundMessage[]>> {
    return this.dmFailure(accountId, 'receive_messages');
  }

  /**
   * Send one reviewed DM from this account's own logged-in session (tools/xhs-dm-send), when the deployment opted in.
   * Without `dm_sender` this stays the documented UNAVAILABLE: there is no authorized DM API.
   *
   * The result is only `ok` when the helper read the message back inside the conversation — that id is what makes an
   * outreach SENT. An outcome that could not be established comes back as REQUIRES_REVIEW and never retryable: the
   * message may already be with a real person.
   */
  async sendMessage(accountId: string, toPlatformUserId: string, text: string): Promise<ProviderResult<XhsSendResult>> {
    const cfg = this.cfg.dm_sender;
    if (!cfg) return this.dmFailure(accountId, 'send_messages');
    const body = (text ?? '').trim();
    if (!body) return fail('UNAVAILABLE', 'refusing to send an empty message');
    const target = (toPlatformUserId ?? '').trim();
    if (!target) return fail('UNAVAILABLE', 'no Xiaohongshu user id for this lead: cannot open a conversation');
    const review = await this.dmToolReview(accountId);
    if (review) return review;
    const ready = this.dmSenderReady(accountId, cfg);
    if (typeof ready !== 'string') return ready;
    const outcome = await this.runOnLane(ready, () =>
      this.runDmSend({
        helperPath: cfg.helper_path,
        cookiesPath: join(cfg.data_dir, ready, 'cookies.json'),
        profileUrl: xhsProfileUrl(target),
        text: body,
        timeoutMs: cfg.timeout_ms ?? DEFAULT_DM_SEND_TIMEOUT_MS,
      }),
    );
    if (outcome.state === 'sent' && outcome.message_id) {
      // The instance and the helper share one session: a fresh login state is safer than the cached one.
      this.clearLoginCache();
      return { ok: true, data: { provider_message_id: `xhs-dm:${outcome.message_id}`, peer_avatar_url: outcome.peer_avatar_url } };
    }
    if (outcome.state === 'failed') return fail('UNAVAILABLE', `私信未发出：${outcome.detail}`, true);
    return fail('REQUIRES_REVIEW', `私信${DM_SEND_UNKNOWN_MARK}，请在小红书中确认后再登记，不要重试：${outcome.detail}`);
  }

  /** The instance name whose session may send for this account, or why it may not. */
  private dmSenderReady(accountId: string, cfg: McpDmSenderConfig): string | ProviderFailure {
    const instance = this.instanceName(accountId);
    if (typeof instance !== 'string') return instance;
    const ep = this.requireAccountEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    if (!isLoopbackUrl(ep.url)) {
      return fail('UNAVAILABLE', `账号「${instance}」的实例在其他机器上（${ep.url}），本机没有它的登录会话，无法代为发送私信`);
    }
    try {
      accessSync(cfg.helper_path, fsConstants.X_OK);
    } catch {
      return fail('UNAVAILABLE', `私信发送助手 ${cfg.helper_path} 不存在或不可执行（XHS_DM_SENDER）`);
    }
    if (!existsSync(join(cfg.data_dir, instance, 'cookies.json'))) {
      return fail('REQUIRES_AUTH', `账号「${instance}」在本机没有登录会话文件，请先扫码登录后再发送私信`);
    }
    return instance;
  }

  /** Run something on an instance's lane: a browser started by the helper must not overlap the instance's own calls. */
  private runOnLane<T>(instance: string, fn: () => Promise<T>): Promise<T> {
    const lane = `dm:${instance}`;
    const prev = this.lanes.get(lane) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.catch(() => undefined);
    this.lanes.set(lane, tail);
    void tail.then(() => {
      if (this.lanes.get(lane) === tail) this.lanes.delete(lane);
    });
    return run;
  }

  // ── login session API ──────────────────────────────────────────────────────

  private authEndpoint(accountId: string | null): Endpoint | ProviderFailure {
    // An account's login must never fall back to the research instance (that would log the wrong session in).
    if (accountId) return this.requireAccountEndpoint(accountId);
    return this.fallbackPublicEndpoint() ?? fail('UNAVAILABLE', NO_PUBLIC_ENDPOINT_REASON);
  }

  /** Concurrent status requests for one instance (console polling, fleet sync) share a single live probe. */
  private authStatus(accountId: string | null): Promise<ProviderResult<XhsLoginStatus>> {
    const ep = this.authEndpoint(accountId);
    if (!isEndpoint(ep)) return Promise.resolve(ep);
    const inFlight = this.statusInFlight.get(ep.key);
    if (inFlight) return inFlight;
    const probe = this.probeAuthStatus(ep).finally(() => this.statusInFlight.delete(ep.key));
    this.statusInFlight.set(ep.key, probe);
    return probe;
  }

  private loginPending(ep: Endpoint): boolean {
    const until = this.pendingLogin.get(ep.key);
    if (until === undefined) return false;
    if (this.clock.now().getTime() < until) return true;
    this.pendingLogin.delete(ep.key);
    return false;
  }

  private async probeAuthStatus(ep: Endpoint): Promise<ProviderResult<XhsLoginStatus>> {
    const login = await this.checkLogin(ep, true);
    if (isFailure(login)) return login;
    if (login.state === 'unknown') {
      return fail('REQUIRES_REVIEW', `login status could not be verified (${ep.label}): ${login.detail}`);
    }
    // A logged-out report can come from a stale selector: only a user id read from get_my_profile overrides it.
    const loginReportedLoggedOut = login.state === 'logged_out';
    const loggedOut = (detail: string): ProviderResult<XhsLoginStatus> => ({
      ok: true,
      data: { logged_in: false, username: null, platform_user_id: null, red_id: null, profile: null, detail: `${login.detail}; ${detail}`, endpoint_label: ep.label },
    });
    if (!loginReportedLoggedOut) this.pendingLogin.delete(ep.key);
    // While a login is pending, "logged out" is the expected answer, and on a logged-out instance get_my_profile
    // hangs until its 60 s deadline: polling it would pile browsers onto the session being logged in.
    if (loginReportedLoggedOut && this.loginPending(ep)) return loggedOut('login pending; identity check skipped until the session logs in');
    const nowMs = this.clock.now().getTime();
    const cached = this.identityCache.get(ep.key);
    if (!loginReportedLoggedOut && cached && cached.username === login.username && nowMs - cached.at < IDENTITY_CACHE_TTL_MS) {
      return {
        ok: true,
        data: {
          logged_in: true,
          username: login.username,
          platform_user_id: cached.platform_user_id,
          red_id: cached.red_id,
          profile: cached.profile,
          detail: `logged in as ${login.username ?? '(unknown nickname)'}; user id verified via get_my_profile`,
          endpoint_label: ep.label,
        },
      };
    }
    let platformUserId: string | null = null;
    let redId: string | null = null;
    let profile: XhsOwnProfile | null = null;
    let identityDetail: string;
    try {
      const tools = await this.tools(ep);
      if (!tools.some((t) => t.name === 'get_my_profile')) {
        identityDetail = 'user id not verified: get_my_profile tool not exposed';
        if (loginReportedLoggedOut) return loggedOut(identityDetail);
      } else {
        const payload = parseToolJson(await this.call(ep, 'get_my_profile', { tab: 'note' }, 'read'));
        const identity = identityFromMyProfile(payload);
        profile = profileFromMyProfile(payload);
        platformUserId = identity.platform_user_id;
        redId = identity.red_id;
        identityDetail = platformUserId
          ? 'user id verified via get_my_profile'
          : 'user id not verified: the account has no own notes on get_my_profile to read it from';
        if (loginReportedLoggedOut && !platformUserId) return loggedOut(identityDetail);
        if (platformUserId) this.identityCache.set(ep.key, { username: login.username, platform_user_id: platformUserId, red_id: redId, profile, at: nowMs });
      }
    } catch (err) {
      identityDetail = `user id not verified: get_my_profile failed (${(err as Error)?.message ?? String(err)})`;
      if (loginReportedLoggedOut) return loggedOut(identityDetail);
    }
    return {
      ok: true,
      data: {
        logged_in: true,
        username: login.username,
        platform_user_id: platformUserId,
        red_id: redId,
        profile,
        detail: `logged in as ${login.username ?? '(unknown nickname)'}; ${identityDetail}`,
        endpoint_label: ep.label,
      },
    };
  }

  /** Delete the instance's cookies: the account is logged out until someone logs it in again. */
  private async authLogout(accountId: string | null): Promise<ProviderResult<{ detail: string }>> {
    const ep = this.authEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    const tools = await this.tools(ep).catch(() => [] as McpToolInfo[]);
    if (!tools.some((t) => t.name === 'delete_cookies')) {
      return fail('UNAVAILABLE', `tool delete_cookies not exposed by this xiaohongshu-mcp server (${ep.label})`);
    }
    const result = await this.run(
      ep,
      async () => {
        const res = await this.callTool(ep, 'delete_cookies', {});
        return { detail: res.text.trim().slice(0, 200) || '已删除登录状态' };
      },
      'delete_cookies',
    );
    // Whatever happened, what we believed about this session is no longer safe to reuse.
    this.loginCache.delete(ep.key);
    this.toolCache.delete(ep.key);
    this.pendingLogin.delete(ep.key);
    return result;
  }

  private async authLoginQrcode(accountId: string | null): Promise<ProviderResult<XhsLoginQrcode>> {
    const ep = this.authEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    try {
      const tools = await this.tools(ep);
      if (!tools.some((t) => t.name === 'get_login_qrcode')) {
        return fail('UNAVAILABLE', `tool get_login_qrcode not exposed by this xiaohongshu-mcp server (${ep.label})`);
      }
      const res = await this.callTool(ep, 'get_login_qrcode', {});
      // A new QR login replaces the instance's session state: re-probe before the next read.
      this.loginCache.delete(ep.key);
      this.identityCache.delete(ep.key);
      const image = res.content.find((c): c is McpImageContent => c.type === 'image' && typeof (c as McpImageContent).data === 'string');
      if (!image) {
        if (ALREADY_LOGGED_IN_RE.test(res.text) && !res.text.includes('未登录')) {
          this.pendingLogin.delete(ep.key);
          return { ok: true, data: { already_logged_in: true, image_data_url: null, expires_at: null, detail: res.text.trim() || 'already logged in' } };
        }
        return fail('UNAVAILABLE', `get_login_qrcode returned no QR image (${ep.label}): ${res.text.trim().slice(0, 200) || '(empty result)'}`, true);
      }
      this.pendingLogin.set(ep.key, this.clock.now().getTime() + LOGIN_QRCODE_TTL_MS);
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

  /**
   * Instance name of an auth target: 'research', or the account's platform account id (fleet script layout). Without a
   * research instance, public reads (and so the research login) fall back to the first env account's instance.
   */
  private instanceName(accountId: string | null): string | ProviderFailure {
    if (accountId === null) {
      const fallback = this.cfg.research_endpoint ? 'research' : Object.keys(this.cfg.account_endpoints)[0];
      if (!fallback) return fail('UNAVAILABLE', NO_PUBLIC_ENDPOINT_REASON);
      return INSTANCE_NAME_RE.test(fallback) ? fallback : fail('UNAVAILABLE', `account id ${JSON.stringify(fallback)} cannot name an instance directory`);
    }
    let name: string | null;
    try {
      name = this.resolveAccount(accountId) ?? accountId;
    } catch (err) {
      return fail('UNAVAILABLE', `could not resolve account ${accountId} to a platform account id: ${(err as Error)?.message ?? String(err)}`, true);
    }
    return INSTANCE_NAME_RE.test(name) ? name : fail('UNAVAILABLE', `account id ${JSON.stringify(name)} cannot name an instance directory (letters, digits, . _ - only)`);
  }

  private async startVisibleLogin(accountId: string | null): Promise<ProviderResult<XhsVisibleLoginJob>> {
    const cfg = this.cfg.visible_login;
    if (!cfg) return fail('UNAVAILABLE', 'visible login is not configured (XHS_LOGIN_HELPER / XHS_MCP_DATA_DIR)');
    const ep = this.authEndpoint(accountId);
    if (!isEndpoint(ep)) return ep;
    const instance = this.instanceName(accountId);
    if (typeof instance !== 'string') return instance;
    if (!isLoopbackUrl(ep.url)) {
      return fail(
        'UNAVAILABLE',
        `the instance of ${ep.label} (${ep.url}) is not on this host; open the login window on the instance's host: scripts/xhs-mcp-fleet.sh login ${instance}`,
      );
    }
    const running = this.visibleJobs.get(instance);
    if (running?.state === 'running') return { ok: true, data: { ...running } };
    try {
      accessSync(cfg.helper_path, fsConstants.X_OK);
    } catch {
      return fail('UNAVAILABLE', `login helper ${cfg.helper_path} is missing or not executable; build it with scripts/xhs-mcp-fleet.sh build-login-helper`);
    }
    const instanceDir = join(cfg.data_dir, instance);
    if (!existsSync(instanceDir)) {
      return fail('UNAVAILABLE', `no state directory ${instanceDir} for instance ${instance}; start the instance with scripts/xhs-mcp-fleet.sh first`);
    }
    const timeoutMs = cfg.timeout_ms ?? DEFAULT_VISIBLE_LOGIN_TIMEOUT_MS;
    const nowMs = this.clock.now().getTime();
    const job: XhsVisibleLoginJob = {
      state: 'running',
      instance,
      started_at: new Date(nowMs).toISOString(),
      finished_at: null,
      expires_at: new Date(nowMs + timeoutMs).toISOString(),
      detail: `login window opened on this host for ${ep.label}; scan the QR code in that window`,
    };
    this.visibleJobs.set(instance, job);
    this.pendingLogin.set(ep.key, nowMs + timeoutMs);
    void this.runVisibleLogin({ helperPath: cfg.helper_path, cookiesPath: join(instanceDir, 'cookies.json'), timeoutMs })
      .catch((err: unknown) => ({ ok: false, detail: `login helper failed: ${(err as Error)?.message ?? String(err)}` }))
      .then((outcome) => {
        job.state = outcome.ok ? 'succeeded' : 'failed';
        job.finished_at = this.clock.iso();
        job.detail = outcome.detail;
        // The instance reads the new cookies on its next browser launch: re-probe instead of trusting caches.
        this.loginCache.delete(ep.key);
        this.identityCache.delete(ep.key);
        this.pendingLogin.delete(ep.key);
      });
    return { ok: true, data: { ...job } };
  }

  /**
   * Start (or reuse) this account's own instance on this host. One start per instance at a time; a healthy instance
   * that is already running is reused, so a double click can never leave two processes on one cookies file.
   */
  private startLocalInstance(accountId: string, reserved: number[], knownPort: number | null): Promise<ProviderResult<XhsLocalInstance>> {
    const cfg = this.cfg.local_instances;
    if (!cfg) {
      return Promise.resolve(fail('UNAVAILABLE', 'this host is not configured to run xiaohongshu-mcp instances (XHS_MCP_BIN + XHS_MCP_DATA_DIR + XHS_MCP_TOKEN)'));
    }
    const instance = this.instanceName(accountId);
    if (typeof instance !== 'string') return Promise.resolve(instance);
    const pinned = this.cfg.account_endpoints[instance];
    if (pinned) {
      return Promise.resolve(
        fail('UNAVAILABLE', `account ${instance} is pinned to ${pinned.url} by XHS_MCP_ACCOUNTS; start or stop that instance where it is configured`),
      );
    }
    if (!isLoopbackHost(cfg.bind)) {
      return Promise.resolve(fail('UNAVAILABLE', `instances would listen on ${cfg.bind}, which is not this host; the console only starts loopback instances`));
    }
    const inFlight = this.localStarts.get(instance);
    if (inFlight) return inFlight;
    const run = this.runLocalInstanceStart(cfg, instance, reserved, knownPort).finally(() => this.localStarts.delete(instance));
    this.localStarts.set(instance, run);
    return run;
  }

  private async runLocalInstanceStart(
    cfg: McpLocalInstancesConfig,
    instance: string,
    reserved: number[],
    knownPort: number | null,
  ): Promise<ProviderResult<XhsLocalInstance>> {
    try {
      accessSync(cfg.binary_path, fsConstants.X_OK);
    } catch {
      return fail('UNAVAILABLE', `xiaohongshu-mcp binary ${cfg.binary_path} is missing or not executable (XHS_MCP_BIN)`);
    }
    const fetchImpl = this.fetchImpl ?? fetch;
    const instanceDir = join(cfg.data_dir, instance);
    const known = recordedPort(instanceDir) ?? knownPort;
    const pid = runningPid(instanceDir);
    // One process per cookies file: a live instance is reused, and a live process that does not answer is reported
    // instead of being duplicated — two processes on one session would log the account out of one of them.
    if (pid !== null) {
      if (known !== null && (await waitForHealth(cfg.bind, known, 0, fetchImpl))) {
        return {
          ok: true,
          data: { instance, url: instanceUrl(cfg.bind, known), port: known, pid, started: false, detail: `实例已在运行（pid ${pid}，端口 ${known}）` },
        };
      }
      return fail(
        'UNAVAILABLE',
        `an instance process for ${instance} is still running (pid ${pid}${known === null ? ', port unknown' : `, port ${known} not answering /health`}); stop it first (kill ${pid}) or save its URL by hand — a second process on the same cookies file would break the session`,
      );
    }
    const taken = new Set<number>(reserved.filter((p) => Number.isInteger(p) && p > 0));
    for (const ep of Object.values(this.cfg.account_endpoints)) {
      const port = portOfUrl(ep.url);
      if (port !== null) taken.add(port);
    }
    const researchPort = this.cfg.research_endpoint ? portOfUrl(this.cfg.research_endpoint.url) : null;
    if (researchPort !== null) taken.add(researchPort);
    const basePort = cfg.base_port ?? DEFAULT_BASE_PORT;
    taken.delete(known ?? -1);
    const port = await findInstancePort(cfg.bind, basePort, taken, known, this.probePort);
    if (port === null) return fail('UNAVAILABLE', `no free port for a new instance in ${basePort + 1}–${basePort + 64} on ${cfg.bind}`);
    const outcome = await this.runLocalInstance({ binaryPath: cfg.binary_path, instanceDir, bind: cfg.bind, port, token: cfg.token });
    if (!outcome.ok) return fail('UNAVAILABLE', outcome.detail);
    return {
      ok: true,
      data: { instance, url: instanceUrl(cfg.bind, port), port, pid: outcome.pid, started: true, detail: outcome.detail },
    };
  }

  private visibleLoginStatus(accountId: string | null): XhsVisibleLoginJob | null {
    const instance = this.instanceName(accountId);
    if (typeof instance !== 'string') return null;
    const job = this.visibleJobs.get(instance);
    return job ? { ...job } : null;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Every tools/call goes through here: calls on one instance run one at a time (each launches a headless browser;
   * overlapping calls pile browsers onto one session). A failed call does not block the queue.
   */
  private callTool(ep: Endpoint, tool: string, args: Record<string, unknown>): ReturnType<McpHttpClient['callTool']> {
    const prev = this.lanes.get(ep.lane) ?? Promise.resolve();
    const run = prev.then(() => ep.client.callTool(tool, args));
    const tail = run.catch(() => undefined);
    this.lanes.set(ep.lane, tail);
    void tail.then(() => {
      if (this.lanes.get(ep.lane) === tail) this.lanes.delete(ep.lane);
    });
    return run;
  }

  private dmReviewReason(tools: string[]): string {
    const base = `DM-like tool detected (${tools.join(', ')}) but unverified; not enabled`;
    return this.cfg.enable_dm_tools
      ? `${base} — enable_dm_tools is set, but DM tools stay REQUIRES_REVIEW until an authorized DM integration is verified`
      : base;
  }

  /** DM methods never call any tool. The failure status mirrors what capabilities() reports for the endpoint. */
  private async dmFailure(accountId: string, cap: 'receive_messages' | 'send_messages'): Promise<ProviderFailure> {
    const review = await this.dmToolReview(accountId);
    if (review) return review;
    return fail('UNAVAILABLE', MCP_DM_REASONS[cap]);
  }

  /**
   * REQUIRES_REVIEW when the instance exposes a DM-like tool we did not put there. Such a tool is never called, and
   * an instance behaving unexpectedly is not one this process sends customer messages from either.
   */
  private async dmToolReview(accountId: string): Promise<ProviderFailure | null> {
    const { ep } = this.lookupAccount(accountId);
    if (!ep) return null;
    let tools: McpToolInfo[] = [];
    try {
      tools = await this.tools(ep);
    } catch {
      // unreachable endpoint: the caller falls through to its own reason
    }
    const dmTools = dmToolNames(tools);
    return dmTools.length > 0 ? fail('REQUIRES_REVIEW', this.dmReviewReason(dmTools)) : null;
  }

  private endpointFor(label: string, cfg: McpEndpointConfig): Endpoint {
    const key = `${cfg.url}|${cfg.token ?? ''}`;
    let client = this.clients.get(key);
    if (!client) {
      client = new McpHttpClient({ url: cfg.url, token: cfg.token, fetchImpl: this.fetchImpl, timeoutMs: this.cfg.timeout_ms });
      this.clients.set(key, client);
    }
    return { key, label, client, lane: normalizeEndpointUrl(cfg.url), url: cfg.url };
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

  /**
   * A read that returned real content is evidence the session works (logged-out reads time out, report
   * "笔记不可访问" or come back empty), so it extends a logged_in state instead of re-probing before every read.
   * It never turns an unknown or logged_out state into logged_in, and failed / empty reads still re-probe.
   */
  private renewLogin(ep: Endpoint): void {
    const cached = this.loginCache.get(ep.key);
    if (cached?.state === 'logged_in') cached.at = this.clock.now().getTime();
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
      const res = await this.callTool(ep, 'check_login_status', {});
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
      if (isEmpty?.(result.data)) {
        if (!before.live) {
          const again = await this.checkLogin(ep, true);
          if (!isFailure(again) && again.state === 'logged_out') return this.authFailure(ep, again.detail);
        }
      } else {
        this.renewLogin(ep);
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
      const result = await this.callTool(ep, tool, args);
      const text = result.text.trim();
      const isJson = text.startsWith('{') || text.startsWith('[');
      const verdict = classifyToolText(text);
      if (verdict === 'login_required' && !isJson) this.rememberLogin(ep, 'logged_out', null, text.slice(0, 160));
      if (mode === 'write' || mode === 'write_json') {
        if (verdict === 'failure' || verdict === 'login_required') throw new McpError('tool', text, { data: result, method: 'tools/call' });
        if (verdict === 'success') return result.text;
        if (mode === 'write_json' && isJson) return result.text;
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
      const res = await this.callTool(ep, 'check_login_status', {});
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
