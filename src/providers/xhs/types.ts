import type { CapabilityStatus, NotificationKind, NotificationTab, XhsCapability, XhsOwnProfile } from '../../core/types.ts';

/**
 * Xiaohongshu integration layer (spec §23).
 *
 * Business logic NEVER talks to Xiaohongshu directly — only through XhsProvider.
 * Every capability explicitly reports AVAILABLE | UNAVAILABLE | REQUIRES_AUTH | REQUIRES_REVIEW,
 * and every call returns a ProviderResult so callers must handle unavailability.
 * Providers must never fabricate success for an action they cannot perform.
 */

export type ProviderMode = 'live' | 'simulation' | 'manual' | 'none';

export interface CapabilityState {
  capability: XhsCapability;
  status: CapabilityStatus;
  reason: string;
}

export interface CapabilityReport {
  provider: string;
  mode: ProviderMode;
  account_id: string | null;
  checked_at: string;
  capabilities: Record<XhsCapability, CapabilityState>;
}

export type ProviderFailure = {
  ok: false;
  status: Exclude<CapabilityStatus, 'AVAILABLE'>;
  reason: string;
  retryable?: boolean;
};
export type ProviderResult<T> = { ok: true; data: T } | ProviderFailure;

export interface XhsAuthor {
  platform_user_id: string | null;
  nickname: string | null;
  profile_url?: string | null;
  /** public avatar URL as the platform returned it (empty strings are normalised to null) */
  avatar_url?: string | null;
}

export interface XhsNoteRef {
  platform_post_id: string;
  xsec_token?: string | null;
}

export interface XhsNoteSummary extends XhsNoteRef {
  title: string;
  author: XhsAuthor;
  like_count: number;
  /** comment count shown on the search card, when the platform reports it (lets callers read discussions first) */
  comment_count?: number | null;
  url?: string | null;
  published_at?: string | null;
  raw?: Record<string, unknown>;
}

export interface XhsNoteDetail extends XhsNoteSummary {
  content: string;
  tags: string[];
  ip_location: string | null;
  comment_count: number;
  collect_count: number;
}

export interface XhsNoteWithComments {
  note: XhsNoteDetail;
  comments: XhsComment[];
}

export interface XhsComment {
  platform_comment_id: string;
  parent_comment_id: string | null;
  author: XhsAuthor;
  content: string;
  ip_location: string | null;
  like_count: number;
  published_at: string | null;
  sub_comments?: XhsComment[];
  raw?: Record<string, unknown>;
}

export interface XhsUserProfile {
  platform_user_id: string;
  nickname: string;
  profile_url: string | null;
  avatar_url: string | null;
  bio: string | null;
  ip_location: string | null;
  follower_count: number | null;
  note_count: number | null;
  recent_notes: XhsNoteSummary[];
  raw?: Record<string, unknown>;
}

export interface XhsSearchOptions {
  sort?: 'general' | 'latest' | 'popular';
  limit?: number;
  published_within_days?: number;
}

export interface XhsCommentOptions {
  limit?: number;
  include_replies?: boolean;
}

export interface XhsPublishDraft {
  title: string;
  body: string;
  tags: string[];
  images?: string[]; // local paths or URLs
  /**
   * Publish a video note instead of an image note: ONE absolute path to a video file on the host that runs this
   * account's session (Xiaohongshu's video publisher takes a local file, not a URL, and not several).
   */
  video?: string | null;
}

export interface XhsPublishResult {
  platform_note_id: string | null;
  url: string | null;
}

export interface XhsEngagement {
  platform_note_id: string;
  views: number | null;
  likes: number;
  collects: number;
  comments: number;
  shares: number;
}

export interface XhsInboundMessage {
  provider_message_id: string;
  account_id: string;
  from_user_id: string;
  from_nickname: string | null;
  content: string;
  sent_at: string;
}

export interface XhsSendResult {
  provider_message_id: string;
  /** the recipient's avatar as their conversation showed it, when the channel could see it */
  peer_avatar_url?: string | null;
}

/**
 * One row of the platform's notification centre, as the provider read it. The ids carried here are exactly what the
 * follow-up actions need: `comment_id` for a reply or a like, `note_id` + `note_xsec_token` to open the note,
 * `from_xsec_token` to open the sender's profile.
 */
export interface XhsNotificationItem {
  provider_notification_id: string;
  tab: NotificationTab;
  kind: NotificationKind;
  /** the platform's own type string, kept verbatim for diagnosing new kinds (`liked/item`, `follow/you`, …) */
  raw_type: string;
  title: string;
  occurred_at: string;
  from_user_id: string;
  from_nickname: string | null;
  from_xsec_token: string | null;
  comment_id: string | null;
  comment_text: string | null;
  comment_liked: boolean;
  note_id: string | null;
  note_xsec_token: string | null;
  note_title: string | null;
}

export interface XhsNotificationPage {
  tab: NotificationTab;
  /** entries the platform hid from us (deleted comment, note under review) — the list is shorter than reality */
  filtered: number;
  items: XhsNotificationItem[];
}

export interface XhsUnreadCounts {
  mentions: number;
  likes: number;
  connections: number;
  total: number;
}

export interface XhsNotificationOptions {
  tab?: NotificationTab;
  limit?: number;
}

export interface XhsProvider {
  readonly name: string;
  readonly mode: ProviderMode;

  /** Detect capabilities (optionally for a specific managed account's session). */
  capabilities(accountId?: string | null): Promise<CapabilityReport>;

  searchNotes(query: string, opts?: XhsSearchOptions, accountId?: string | null): Promise<ProviderResult<XhsNoteSummary[]>>;
  getNote(ref: XhsNoteRef, accountId?: string | null): Promise<ProviderResult<XhsNoteDetail>>;
  getComments(ref: XhsNoteRef, opts?: XhsCommentOptions, accountId?: string | null): Promise<ProviderResult<XhsComment[]>>;
  /**
   * Optional: a note's detail and its comments from ONE page load (a live provider opens a browser page per call, so
   * getNote + getComments reads the same page twice). Callers fall back to getNote + getComments when absent.
   */
  getNoteWithComments?(ref: XhsNoteRef, opts?: XhsCommentOptions, accountId?: string | null): Promise<ProviderResult<XhsNoteWithComments>>;
  /** xiaohongshu-mcp's user_profile requires the xsec_token observed alongside the user (note/comment context). */
  getUserProfile(ref: XhsUserRef, accountId?: string | null): Promise<ProviderResult<XhsUserProfile>>;

  /** Publishing may succeed without returning a note id (xiaohongshu-mcp); callers must handle platform_note_id=null. */
  publishNote(accountId: string, draft: XhsPublishDraft): Promise<ProviderResult<XhsPublishResult>>;
  getEngagement(accountId: string, platformNoteId: string): Promise<ProviderResult<XhsEngagement>>;

  /** Public reply to a comment on a note (engagement on our own notes). */
  replyToComment(accountId: string, ref: XhsCommentReplyRef, text: string): Promise<ProviderResult<XhsSendResult>>;

  /**
   * The platform's notification centre (optional: only providers that can read it implement these).
   * Reading a tab clears its unread badge on Xiaohongshu — `getUnreadCounts` is the one that does not.
   */
  getUnreadCounts?(accountId: string): Promise<ProviderResult<XhsUnreadCounts>>;
  listNotifications?(accountId: string, opts?: XhsNotificationOptions): Promise<ProviderResult<XhsNotificationPage>>;
  /** Public reply to a comment straight from the notification (no note id needed). */
  replyToNotification?(accountId: string, commentId: string, text: string): Promise<ProviderResult<XhsSendResult>>;
  /** Like (or unlike) the comment a notification points at. */
  likeNotificationComment?(accountId: string, commentId: string, unlike?: boolean): Promise<ProviderResult<{ liked: boolean }>>;

  listInboundMessages(accountId: string, since: string | null): Promise<ProviderResult<XhsInboundMessage[]>>;
  sendMessage(accountId: string, toPlatformUserId: string, text: string): Promise<ProviderResult<XhsSendResult>>;

  /**
   * Login-session API (ARCHITECTURE §10.3). Only providers that drive a real logged-in Xiaohongshu session implement it
   * (xiaohongshu-mcp). Simulation / none leave it undefined: there is no session to log into.
   */
  readonly auth?: XhsAuthApi;
  /** Where an account's session endpoint comes from (never includes a token). Live providers only. */
  endpointInfo?(accountId: string): XhsEndpointInfo;
}

export interface XhsLoginStatus {
  logged_in: boolean;
  /** nickname reported by the session (null when logged out or unknown) */
  username: string | null;
  /** Xiaohongshu user id of the logged-in user when it could be verified (own notes on get_my_profile) */
  platform_user_id: string | null;
  /** 小红书号 (redId) of the logged-in user when readable */
  red_id: string | null;
  /** the session's own profile (get_my_profile) when it was read; null when logged out / unreadable */
  profile: XhsOwnProfile | null;
  detail: string;
  /** which instance answered, e.g. 'account xhs-hz-i3' / 'research' (no URL token) */
  endpoint_label: string;
}

export interface XhsLoginQrcode {
  already_logged_in: boolean;
  /** data:image/png;base64,… — show it, never persist or log it */
  image_data_url: string | null;
  expires_at: string | null;
  detail: string;
}

export interface XhsAuthApi {
  /** Fresh login probe of the account's instance (accountId null = research instance). */
  status(accountId: string | null): Promise<ProviderResult<XhsLoginStatus>>;
  /** Request a login QR code on the account's instance (replaces any pending QR login there). */
  loginQrcode(accountId: string | null): Promise<ProviderResult<XhsLoginQrcode>>;
  /**
   * Log the instance's session out (delete its cookies). Present only where the provider can do it; the account then
   * needs a new QR / window login before anything else works.
   */
  logout?(accountId: string | null): Promise<ProviderResult<{ detail: string }>>;
  /**
   * Log in through a visible browser window on this host (Xiaohongshu rejects QR logins scanned from a headless
   * browser). Present only when a login helper is configured for local instances.
   */
  readonly visibleLogin?: XhsVisibleLoginApi;
  /**
   * Start an account's own xiaohongshu-mcp instance on this host. Present only when this host was configured to run
   * instances itself (binary + state dir + token, loopback only).
   */
  readonly localInstance?: XhsLocalInstanceApi;
}

export const VISIBLE_LOGIN_STATES = ['running', 'succeeded', 'failed'] as const;
export type VisibleLoginState = (typeof VISIBLE_LOGIN_STATES)[number];

export interface XhsVisibleLoginJob {
  state: VisibleLoginState;
  /** instance whose cookies the window writes: 'research' or the account's platform account id */
  instance: string;
  started_at: string;
  finished_at: string | null;
  /** the helper gives up at this time */
  expires_at: string;
  detail: string;
}

/** A xiaohongshu-mcp instance this host runs for one account (started by the console or by the fleet script). */
export interface XhsLocalInstance {
  /** instance name = state directory under the data dir = the account's platform account id */
  instance: string;
  /** the instance's endpoint, ready to bind to the account (never contains a token) */
  url: string;
  port: number;
  /** pid on this host when known */
  pid: number | null;
  /** false = an instance was already running for this account and was reused */
  started: boolean;
  detail: string;
}

export interface XhsLocalInstanceApi {
  /**
   * Start (or reuse) this account's own instance on this host and report the endpoint it listens on. Idempotent:
   * a healthy instance is reused, never duplicated. `reserved_ports` are ports other accounts are bound to,
   * `known_port` the port this account is already bound to (an instance started by the fleet script).
   */
  start(accountId: string, opts?: { reserved_ports?: number[]; known_port?: number }): Promise<ProviderResult<XhsLocalInstance>>;
}

export interface XhsVisibleLoginApi {
  /** Open the login window for the account's instance (accountId null = research); a running job is returned as is. */
  start(accountId: string | null): Promise<ProviderResult<XhsVisibleLoginJob>>;
  /** The latest job for that instance in this process, or null. */
  status(accountId: string | null): XhsVisibleLoginJob | null;
}

export interface XhsEndpointInfo {
  source: 'env' | 'db' | 'none';
  url: string | null;
}

export interface XhsUserRef {
  platform_user_id: string;
  xsec_token?: string | null;
}

export interface XhsCommentReplyRef extends XhsNoteRef {
  platform_comment_id: string;
  platform_user_id?: string | null;
}
