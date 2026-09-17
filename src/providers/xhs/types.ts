import type { CapabilityStatus, XhsCapability } from '../../core/types.ts';

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
}

export interface XhsNoteRef {
  platform_post_id: string;
  xsec_token?: string | null;
}

export interface XhsNoteSummary extends XhsNoteRef {
  title: string;
  author: XhsAuthor;
  like_count: number;
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
}

export interface XhsProvider {
  readonly name: string;
  readonly mode: ProviderMode;

  /** Detect capabilities (optionally for a specific managed account's session). */
  capabilities(accountId?: string | null): Promise<CapabilityReport>;

  searchNotes(query: string, opts?: XhsSearchOptions, accountId?: string | null): Promise<ProviderResult<XhsNoteSummary[]>>;
  getNote(ref: XhsNoteRef, accountId?: string | null): Promise<ProviderResult<XhsNoteDetail>>;
  getComments(ref: XhsNoteRef, opts?: XhsCommentOptions, accountId?: string | null): Promise<ProviderResult<XhsComment[]>>;
  /** xiaohongshu-mcp's user_profile requires the xsec_token observed alongside the user (note/comment context). */
  getUserProfile(ref: XhsUserRef, accountId?: string | null): Promise<ProviderResult<XhsUserProfile>>;

  /** Publishing may succeed without returning a note id (xiaohongshu-mcp); callers must handle platform_note_id=null. */
  publishNote(accountId: string, draft: XhsPublishDraft): Promise<ProviderResult<XhsPublishResult>>;
  getEngagement(accountId: string, platformNoteId: string): Promise<ProviderResult<XhsEngagement>>;

  /** Public reply to a comment on a note (engagement on our own notes). */
  replyToComment(accountId: string, ref: XhsCommentReplyRef, text: string): Promise<ProviderResult<XhsSendResult>>;

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
