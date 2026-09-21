/**
 * Account sessions (ARCHITECTURE §10.3) — keeps every managed Xiaohongshu account bound to ITS OWN live session.
 *
 * - syncAccountAuth / syncFleetAuth: probe the provider (capabilities + login status) and persist the real login state
 *   on xhs_accounts (auth_state, auth_checked_at, auth_detail, platform_user_id) plus capability snapshots. Nothing is
 *   assumed: a logged-out instance becomes requires_auth, an unreachable one unknown, a session logged into a different
 *   Xiaohongshu user than recorded requires_auth with an explicit mismatch detail.
 * - startAccountLogin: request a login QR code on the account's instance for the console (the image is returned, never stored).
 * - startLoginWindow / loginWindowStatus: log a local instance in through a visible browser window on this host
 *   (Xiaohongshu rejects QR logins scanned from the instance's headless browser); only when the provider offers it.
 * - startAccountInstance: on a host that runs the instances itself, start this account's own instance (own port, own
 *   cookies file) and bind the account to it — the console equivalent of scripts/xhs-mcp-fleet.sh start <id>.
 * - setAccountEndpoint: bind an account to its xiaohongshu-mcp instance URL (unique; no credentials in URLs — tokens only via env).
 * - getAccountSessions: read model for the console (endpoint source, login state, latest capability per capability).
 *
 * Providers without a login-session API (simulation, none) are reported honestly as "not applicable".
 */
import type { AppContext } from '../../../app/context.ts';
import { NotFoundError, PolicyError, ValidationError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import { truncate } from '../../../core/text.ts';
import {
  XHS_CAPABILITIES,
  type AccountStatus,
  type AccountType,
  type AuthState,
  type CapabilitySnapshot,
  type CapabilityStatus,
  type XhsAccount,
  type XhsCapability,
  type XhsOwnProfile,
} from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import { normalizeEndpointUrl, portOfUrl } from '../../../providers/xhs/mcp-provider.ts';
import type { CapabilityReport, XhsEndpointInfo, XhsLocalInstance, XhsLoginQrcode, XhsVisibleLoginJob } from '../../../providers/xhs/types.ts';
import { defineSkill } from '../../registry.ts';

export const ACCOUNT_SESSIONS_AGENT = 'fleet-controller';
export const ACCOUNT_MISMATCH_DETAIL = '登录的小红书账号与该账号记录不一致';
export const ACCOUNT_BOUND_ELSEWHERE_DETAIL = '该小红书账号已绑定到另一个托管账号';
const MAX_DETAIL_CHARS = 500;

export interface AccountAuthSyncResult {
  account: XhsAccount;
  /** AVAILABLE = logged in on its own verified session; REQUIRES_AUTH = needs (re-)login; other = probe failed / not applicable */
  status: CapabilityStatus;
  reason: string;
  /** false for providers without a login-session API (simulation / none) */
  applicable: boolean;
  capabilities: CapabilityReport;
}

export interface CapabilityView {
  status: CapabilityStatus;
  reason: string;
  checked_at: string;
  provider: string;
}

export interface AccountSessionRow {
  account_id: string;
  nickname: string;
  account_type: AccountType;
  status: AccountStatus;
  platform_account_id: string | null;
  /** effective endpoint as the current provider resolves it (env wins over the DB row); never contains a token */
  endpoint: XhsEndpointInfo;
  /** URL stored on the account row (may be overridden by env) */
  configured_endpoint_url: string | null;
  auth_state: AuthState;
  auth_checked_at: string | null;
  auth_detail: string | null;
  platform_user_id: string | null;
  capabilities: Partial<Record<XhsCapability, CapabilityView>>;
  provider: { name: string; mode: string; login_api: boolean; login_window: boolean; local_instances: boolean };
  /** the account's own Xiaohongshu profile from its last confirmed login check (null until then) */
  platform_profile: XhsOwnProfile | null;
  platform_profile_at: string | null;
}

function requireAccount(ctx: AppContext, accountId: string): XhsAccount {
  const account = ctx.db.table('xhs_accounts').get(accountId);
  if (!account) throw new NotFoundError('xhs_account', accountId);
  return account;
}

/** Persist one snapshot row per capability of a report (the capability history behind the console's status table). */
export function recordCapabilitySnapshots(ctx: AppContext, report: CapabilityReport, accountId: string | null = report.account_id): CapabilitySnapshot[] {
  return ctx.db.tx(() =>
    XHS_CAPABILITIES.map((cap) => {
      const state = report.capabilities[cap];
      return ctx.db.table('capability_snapshots').insert({
        id: newId('cap'),
        provider: report.provider,
        account_id: accountId,
        capability: cap,
        status: state.status,
        reason: truncate(state.reason, MAX_DETAIL_CHARS),
        checked_at: report.checked_at,
      });
    }),
  );
}

/** Probe the account's live session and persist its real login state. Never throws for provider failures. */
export async function syncAccountAuth(ctx: AppContext, accountId: string): Promise<AccountAuthSyncResult> {
  const account = requireAccount(ctx, accountId);
  const report = await ctx.xhs.capabilities(account.id);
  const search = report.capabilities.search_public_content;
  const publish = report.capabilities.publish_content;

  let status: CapabilityStatus;
  let reason: string;
  let authState: AuthState;
  let platformUserId: string | null = account.platform_user_id ?? null;
  /** only set when THIS account's own session is confirmed (never another user's profile) */
  let profile: XhsOwnProfile | null = null;
  const applicable = Boolean(ctx.xhs.auth);

  if (!ctx.xhs.auth) {
    const requiresAuth = search.status === 'REQUIRES_AUTH' || publish.status === 'REQUIRES_AUTH';
    status = requiresAuth ? 'REQUIRES_AUTH' : search.status;
    reason = `不适用：当前小红书接入 ${report.provider}（${report.mode}）没有真实登录会话接口；能力检测 ${status}：${search.reason}`;
    authState = requiresAuth ? 'requires_auth' : account.auth_state;
  } else {
    const res = await ctx.xhs.auth.status(account.id);
    if (!res.ok) {
      status = res.status;
      reason = `无法确认登录状态：${res.reason}`;
      authState = res.status === 'REQUIRES_AUTH' ? 'requires_auth' : 'unknown';
    } else if (!res.data.logged_in) {
      status = 'REQUIRES_AUTH';
      reason = `未登录（${res.data.endpoint_label}）：${res.data.detail.replace(/\s+/g, ' ').trim()}`;
      authState = 'requires_auth';
    } else {
      const verified = res.data.platform_user_id;
      const who = res.data.username ? `「${res.data.username}」` : '';
      const boundElsewhere = verified
        ? ctx.db
            .table('xhs_accounts')
            .query('platform_user_id = ? AND id <> ?', [verified, account.id], { limit: 1 })[0]
        : undefined;
      if (verified && platformUserId && verified !== platformUserId) {
        status = 'REQUIRES_AUTH';
        authState = 'requires_auth';
        reason = `${ACCOUNT_MISMATCH_DETAIL}（记录 ${platformUserId}，当前登录 ${verified}${who}），请用正确的账号重新扫码登录`;
      } else if (boundElsewhere) {
        status = 'REQUIRES_AUTH';
        authState = 'requires_auth';
        reason = `${ACCOUNT_BOUND_ELSEWHERE_DETAIL}「${boundElsewhere.nickname}」（当前登录 ${verified}${who}），每个托管账号必须登录自己的小红书账号`;
      } else {
        status = 'AVAILABLE';
        authState = 'authenticated';
        if (verified && !platformUserId) platformUserId = verified;
        profile = res.data.profile;
        reason = `已登录${who}（${res.data.endpoint_label}）${verified ? `，用户ID ${verified} 已校验` : '，用户ID未能校验'}：${res.data.detail}`;
      }
    }
  }

  const now = ctx.clock.iso();
  const detail = truncate(reason, MAX_DETAIL_CHARS);
  const updated = ctx.db.tx(() => {
    recordCapabilitySnapshots(ctx, report, account.id);
    const row = ctx.db.table('xhs_accounts').update(account.id, {
      auth_state: authState,
      auth_checked_at: now,
      auth_detail: detail,
      ...(platformUserId !== (account.platform_user_id ?? null) ? { platform_user_id: platformUserId } : {}),
      ...(profile ? { platform_profile: profile, platform_profile_at: now } : {}),
    });
    if (authState !== account.auth_state || platformUserId !== (account.platform_user_id ?? null)) {
      ctx.audit.event({
        actor: `agent:${ACCOUNT_SESSIONS_AGENT}`,
        action: 'account.auth_synced',
        entity_type: 'xhs_account',
        entity_id: account.id,
        details: {
          from: account.auth_state,
          to: authState,
          status,
          provider: report.provider,
          mode: report.mode,
          platform_user_id_verified: platformUserId !== (account.platform_user_id ?? null) ? platformUserId : undefined,
          reason: detail,
        },
      });
    }
    return row;
  });
  return { account: updated, status, reason: detail, applicable, capabilities: report };
}

/** Sync every non-disabled account of a dealer, one after another (xiaohongshu-mcp runs one browser call at a time). */
export async function syncFleetAuth(ctx: AppContext, dealerId: string): Promise<AccountAuthSyncResult[]> {
  if (!ctx.db.table('dealers').get(dealerId)) throw new NotFoundError('dealer', dealerId);
  const accounts = ctx.db
    .table('xhs_accounts')
    .findMany({ dealer_id: dealerId, removed_at: null }, { orderBy: 'created_at ASC, id ASC' })
    .filter((a) => a.status !== 'disabled');
  const out: AccountAuthSyncResult[] = [];
  for (const account of accounts) out.push(await syncAccountAuth(ctx, account.id));
  return out;
}

/** Logging in needs the account's own instance: refuse early, in the operator's language, with the fix. */
function requireAccountInstance(ctx: AppContext, account: XhsAccount): void {
  if (!ctx.xhs.endpointInfo || ctx.xhs.endpointInfo(account.id).source !== 'none') return;
  const name = account.platform_account_id ?? account.id;
  throw new PolicyError(
    'xhs_account_no_endpoint',
    // Operator-facing: what to click, not what runs underneath (see src/server/humanize.ts for the same rule in pages).
    `账号「${account.nickname}」还没有连接：在账号卡片上点「连接这个账号」，或在「高级设置」里填写它的账号服务地址，然后再扫码登录`,
    { account_id: account.id },
  );
}

/**
 * Request a login QR code on the account's own instance (accountId null = research instance).
 * Throws PolicyError when the provider has no login API or the instance cannot produce a QR code.
 */
export async function startAccountLogin(ctx: AppContext, accountId: string | null, actor: string): Promise<XhsLoginQrcode> {
  const account = accountId ? requireAccount(ctx, accountId) : null;
  if (!ctx.xhs.auth) {
    throw new PolicyError('xhs_login_not_applicable', `当前小红书接入 ${ctx.xhs.name}（${ctx.xhs.mode}）没有真实登录会话，无法扫码登录`, {
      provider: ctx.xhs.name,
      mode: ctx.xhs.mode,
    });
  }
  if (account) requireAccountInstance(ctx, account);
  const res = await ctx.xhs.auth.loginQrcode(account?.id ?? null);
  if (!res.ok) {
    throw new PolicyError(`xhs_login_${res.status.toLowerCase()}`, `无法获取登录二维码：${res.reason}`, {
      status: res.status,
      retryable: res.retryable === true,
      account_id: account?.id ?? null,
    });
  }
  ctx.audit.event({
    actor,
    action: 'account.login_qrcode_requested',
    entity_type: account ? 'xhs_account' : 'xhs_provider',
    entity_id: account?.id ?? 'research',
    details: {
      already_logged_in: res.data.already_logged_in,
      expires_at: res.data.expires_at,
      endpoint_source: account && ctx.xhs.endpointInfo ? ctx.xhs.endpointInfo(account.id).source : null,
    },
  });
  return res.data;
}

/**
 * Log an account's instance out (delete its cookies). The console offers it for handing an account back, moving it to
 * another machine, or clearing a session that was logged into the wrong Xiaohongshu user. Afterwards the account is
 * `requires_auth` until someone logs it in again — never silently "still fine".
 */
export async function logoutAccount(ctx: AppContext, accountId: string, actor: string): Promise<{ account: XhsAccount; detail: string }> {
  const account = requireAccount(ctx, accountId);
  const logout = ctx.xhs.auth?.logout;
  if (!logout) {
    throw new PolicyError('xhs_logout_not_applicable', `当前小红书接入 ${ctx.xhs.name}（${ctx.xhs.mode}）没有真实登录会话，无法退出登录`, {
      provider: ctx.xhs.name,
      mode: ctx.xhs.mode,
    });
  }
  requireAccountInstance(ctx, account);
  const res = await logout(account.id);
  if (!res.ok) {
    throw new PolicyError(`xhs_logout_${res.status.toLowerCase()}`, `退出登录失败：${res.reason}`, { status: res.status, account_id: account.id });
  }
  const detail = truncate(res.data.detail || '已退出登录', MAX_DETAIL_CHARS);
  const updated = ctx.db.tx(() => {
    const row = ctx.db.table('xhs_accounts').update(account.id, {
      auth_state: 'requires_auth',
      auth_checked_at: ctx.clock.iso(),
      auth_detail: detail,
    });
    ctx.audit.event({ actor, action: 'account.logged_out', entity_type: 'xhs_account', entity_id: account.id, details: { detail } });
    return row;
  });
  return { account: updated, detail };
}

/**
 * Open a visible login window on this host for the account's instance (accountId null = research instance). The window
 * writes the instance's cookies; the running instance picks them up on its next call. A job already running is returned.
 */
export async function startLoginWindow(ctx: AppContext, accountId: string | null, actor: string): Promise<XhsVisibleLoginJob> {
  const account = accountId ? requireAccount(ctx, accountId) : null;
  const api = ctx.xhs.auth?.visibleLogin;
  if (!api) {
    throw new PolicyError('xhs_login_window_not_configured', `当前小红书接入 ${ctx.xhs.name}（${ctx.xhs.mode}）没有配置本机登录窗口（XHS_LOGIN_HELPER / XHS_MCP_DATA_DIR）`, {
      provider: ctx.xhs.name,
      mode: ctx.xhs.mode,
    });
  }
  if (account) requireAccountInstance(ctx, account);
  const res = await api.start(account?.id ?? null);
  if (!res.ok) {
    throw new PolicyError(`xhs_login_window_${res.status.toLowerCase()}`, `无法打开登录窗口：${res.reason}`, { status: res.status, account_id: account?.id ?? null });
  }
  ctx.audit.event({
    actor,
    action: 'account.login_window_opened',
    entity_type: account ? 'xhs_account' : 'xhs_provider',
    entity_id: account?.id ?? 'research',
    details: { instance: res.data.instance, state: res.data.state, expires_at: res.data.expires_at },
  });
  return res.data;
}

/** Latest login-window job of the account's instance in this process (null when none / not configured). */
export function loginWindowStatus(ctx: AppContext, accountId: string | null): XhsVisibleLoginJob | null {
  const account = accountId ? requireAccount(ctx, accountId) : null;
  return ctx.xhs.auth?.visibleLogin?.status(account?.id ?? null) ?? null;
}

export interface AccountInstanceResult {
  account: XhsAccount;
  instance: XhsLocalInstance;
}

/**
 * Start (or reuse) this account's own xiaohongshu-mcp instance on this host and bind the account to it. Only possible
 * where the console runs the instances itself (XHS_MCP_BIN + XHS_MCP_DATA_DIR + XHS_MCP_TOKEN, loopback); elsewhere the
 * instance is started on its own host and its URL is saved here by hand. Logging in is still a separate, human step.
 */
export async function startAccountInstance(ctx: AppContext, accountId: string, actor: string): Promise<AccountInstanceResult> {
  const account = requireAccount(ctx, accountId);
  const api = ctx.xhs.auth?.localInstance;
  if (!api) {
    throw new PolicyError(
      'xhs_local_instance_not_configured',
      `这台机器没有开启「一键连接账号」：请在账号服务所在的机器上把它启动起来，再到账号卡片的「高级设置」里填写地址（部署文档里有具体步骤）`,
      { provider: ctx.xhs.name, mode: ctx.xhs.mode, account_id: account.id },
    );
  }
  // Ports other accounts are already bound to: a new instance never lands on another account's port.
  const reserved: number[] = [];
  for (const other of ctx.db.table('xhs_accounts').query('mcp_endpoint_url IS NOT NULL AND id <> ?', [account.id])) {
    const port = portOfUrl(other.mcp_endpoint_url ?? '');
    if (port !== null) reserved.push(port);
  }
  const bound = portOfUrl(account.mcp_endpoint_url ?? '');
  const res = await api.start(account.id, { reserved_ports: reserved, ...(bound === null ? {} : { known_port: bound }) });
  if (!res.ok) {
    throw new PolicyError(`xhs_local_instance_${res.status.toLowerCase()}`, `无法启动实例：${res.reason}`, { status: res.status, account_id: account.id });
  }
  ctx.audit.event({
    actor,
    action: 'account.instance_started',
    entity_type: 'xhs_account',
    entity_id: account.id,
    details: { instance: res.data.instance, url: res.data.url, port: res.data.port, pid: res.data.pid, reused: !res.data.started },
  });
  // Env-pinned accounts are refused by the provider, so binding here can only write this account's own new instance.
  return { account: setAccountEndpoint(ctx, account.id, res.data.url, actor), instance: res.data };
}

/** Validate and normalize an instance URL: http(s) only, no embedded credentials (tokens come from env). */
export function validateEndpointUrl(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ValidationError('mcp_endpoint_url', `不是有效的地址：${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError('mcp_endpoint_url', '只支持 http(s) 地址，例如 http://10.0.0.5:18061/mcp');
  }
  if (url.username || url.password) {
    throw new ValidationError('mcp_endpoint_url', '地址中不得包含用户名或密码；访问令牌只能通过环境变量 XHS_MCP_TOKEN / XHS_MCP_ACCOUNTS 配置');
  }
  return normalizeEndpointUrl(trimmed);
}

/** Bind (or unbind with null) an account to its xiaohongshu-mcp instance. One instance per managed account. */
export function setAccountEndpoint(ctx: AppContext, accountId: string, url: string | null, actor: string): XhsAccount {
  const account = requireAccount(ctx, accountId);
  const next = url === null || !url.trim() ? null : validateEndpointUrl(url);
  const previous = account.mcp_endpoint_url ?? null;
  if (next !== null) {
    const clash = ctx.db
      .table('xhs_accounts')
      .query('mcp_endpoint_url IS NOT NULL AND id <> ?', [account.id])
      .find((other) => normalizeEndpointUrl(other.mcp_endpoint_url ?? '') === next);
    if (clash) {
      throw new PolicyError('endpoint_in_use', `这个地址已经被账号「${clash.nickname}」占用了；每个账号必须用自己独立的登录环境，否则操作会发到别的账号上`, {
        account_id: clash.id,
      });
    }
  }
  if (next === previous) return account;
  try {
    return ctx.db.tx(() => {
      const row = next === null ? ctx.db.table('xhs_accounts').setNull(account.id, ['mcp_endpoint_url']) : ctx.db.table('xhs_accounts').update(account.id, { mcp_endpoint_url: next });
      // A different instance means a different session: the stored login state no longer applies.
      const reset = ctx.db.table('xhs_accounts').update(account.id, {
        auth_state: 'unknown',
        auth_detail: next === null ? '已解除实例绑定' : '实例地址已变更，待重新检测登录状态',
      });
      ctx.audit.event({
        actor,
        action: 'account.endpoint_updated',
        entity_type: 'xhs_account',
        entity_id: account.id,
        details: {
          from: previous,
          to: next,
          overridden_by_env: ctx.xhs.endpointInfo ? ctx.xhs.endpointInfo(account.id).source === 'env' : false,
        },
      });
      return { ...row, ...reset };
    });
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed: xhs_accounts\.mcp_endpoint_url/.test(err.message)) {
      throw new PolicyError('endpoint_in_use', '这个地址已经被别的账号占用了；每个账号必须用自己独立的登录环境');
    }
    throw err;
  }
}

/** Console read model: every account of the dealer with its session binding and latest capability snapshot per capability. */
export function getAccountSessions(ctx: AppContext, dealerId: string): AccountSessionRow[] {
  if (!ctx.db.table('dealers').get(dealerId)) throw new NotFoundError('dealer', dealerId);
  // Accounts removed from the fleet are kept only so their history has an author; they are not part of the console fleet.
  const accounts = ctx.db.table('xhs_accounts').findMany({ dealer_id: dealerId, removed_at: null }, { orderBy: 'created_at ASC, id ASC' });
  return accounts.map((account) => {
    const capabilities: Partial<Record<XhsCapability, CapabilityView>> = {};
    const snapshots = ctx.db
      .table('capability_snapshots')
      .findMany({ account_id: account.id }, { orderBy: 'checked_at DESC, id DESC', limit: XHS_CAPABILITIES.length * 20 });
    for (const snap of snapshots) {
      const cap = snap.capability as XhsCapability;
      if (!XHS_CAPABILITIES.includes(cap) || capabilities[cap]) continue;
      capabilities[cap] = { status: snap.status, reason: snap.reason, checked_at: snap.checked_at, provider: snap.provider };
    }
    const endpoint: XhsEndpointInfo = ctx.xhs.endpointInfo ? ctx.xhs.endpointInfo(account.id) : { source: 'none', url: null };
    return {
      account_id: account.id,
      nickname: account.nickname,
      account_type: account.account_type,
      status: account.status,
      platform_account_id: account.platform_account_id,
      endpoint,
      configured_endpoint_url: account.mcp_endpoint_url ?? null,
      auth_state: account.auth_state,
      auth_checked_at: account.auth_checked_at ?? null,
      auth_detail: account.auth_detail ?? null,
      platform_user_id: account.platform_user_id ?? null,
      capabilities,
      provider: {
        name: ctx.xhs.name,
        mode: ctx.xhs.mode,
        login_api: Boolean(ctx.xhs.auth),
        login_window: Boolean(ctx.xhs.auth?.visibleLogin),
        local_instances: Boolean(ctx.xhs.auth?.localInstance),
      },
      platform_profile: account.platform_profile ?? null,
      platform_profile_at: account.platform_profile_at ?? null,
    };
  });
}

export const ACCOUNT_SESSION_ACTIONS = ['sync', 'sessions'] as const;
export type AccountSessionAction = (typeof ACCOUNT_SESSION_ACTIONS)[number];

export interface AccountSessionsSkillInput {
  action: AccountSessionAction;
  dealer_id?: string;
  account_id?: string;
}

export type AccountSessionsSkillOutput =
  | { action: 'sync'; results: AccountAuthSyncResult[] }
  | { action: 'sessions'; sessions: AccountSessionRow[] };

export const skill = defineSkill<AccountSessionsSkillInput, AccountSessionsSkillOutput>({
  name: 'account-sessions',
  category: 'operations',
  agent: ACCOUNT_SESSIONS_AGENT,
  description: '检测每个托管小红书账号自己的 xiaohongshu-mcp 会话是否真实登录、是否登录到正确的账号，并记录能力快照；不适用的接入方式如实标注。',
  input: v.object({
    action: v.literal(ACCOUNT_SESSION_ACTIONS),
    dealer_id: v.optional(v.string({ min: 1 })),
    account_id: v.optional(v.string({ min: 1 })),
  }),
  async run(ctx, input) {
    if (input.action === 'sessions') {
      if (!input.dealer_id) throw new ValidationError('dealer_id', 'required for action "sessions"');
      return { action: 'sessions', sessions: getAccountSessions(ctx, input.dealer_id) };
    }
    if (input.account_id) return { action: 'sync', results: [await syncAccountAuth(ctx, input.account_id)] };
    if (input.dealer_id) return { action: 'sync', results: await syncFleetAuth(ctx, input.dealer_id) };
    throw new ValidationError('dealer_id', 'dealer_id or account_id is required for action "sync"');
  },
  validateOutput(output) {
    if (output.action === 'sync') {
      for (const r of output.results) {
        if (r.status === 'AVAILABLE' && r.account.auth_state !== 'authenticated') {
          throw new Error(`account-sessions: ${r.account.id} reported AVAILABLE without an authenticated session`);
        }
      }
    }
  },
});
