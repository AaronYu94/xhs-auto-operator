/**
 * Sales & fleet API: operator goals, managed accounts (sessions, QR login, endpoints, persona, operational limits),
 * the REVIEW_REQUIRED outreach queue and actions, conversations with manual reply capture, and the 聚光 lead webhook.
 * Nothing here reports a message as sent unless the provider confirmed it or a named operator recorded a manual send.
 */
import { AppError, ValidationError } from '../../core/errors.ts';
import {
  ACCOUNT_STATUSES,
  APPROVAL_POLICIES,
  GOAL_STATUSES,
  OUTREACH_KINDS,
  OUTREACH_STATUSES,
  type AccountPersona,
  type OutreachStatus,
  type XhsAccount,
} from '../../core/types.ts';
import { v } from '../../core/validate.ts';
import { getSetupStatus, requireReadyToRun } from '../../operator/onboarding.ts';
import { parseJuguangLeadPush } from '../../providers/xhs/index.ts';
import { getActiveAssignment } from '../../skills/acquisition/account-assignment/index.ts';
import { getAccountVoice, learnAccountVoice } from '../../skills/content/account-voice/index.ts';
import { updatePersona } from '../../skills/operations/account-brain/index.ts';
import {
  getAccountSessions,
  loginWindowStatus,
  setAccountEndpoint,
  logoutAccount,
  startAccountLogin,
  startAccountInstance,
  startLoginWindow,
  syncAccountAuth,
  syncFleetAuth,
} from '../../skills/operations/account-sessions/index.ts';
import { getAccountsOverview } from '../../skills/operations/analytics/index.ts';
import {
  approveReply,
  ingestJuguangLeads,
  listConversations,
  markReplySentManually,
  pollInbox,
  processInboundMessage,
} from '../../skills/sales/conversation/index.ts';
import { planFollowUps } from '../../skills/sales/follow-up/index.ts';
import {
  approveOutreach,
  cancelOutreach,
  listOutreachQueue,
  markOutreachSentManually,
  prepareOutreach,
  sendOutreach,
} from '../../skills/sales/outreach/index.ts';
import { safeEqual } from '../auth.ts';
import { humanProblem, scrubInternals } from '../humanize.ts';
import { queryString, type Router } from '../http.ts';
import type { ServerOptions, ServerRuntime } from '../runtime.ts';
import { dealerFromQuery, json, paging, readBody, requireDealer, requireRow } from './common.ts';

const goalBody = v.object({ dealer_id: v.string({ min: 1 }), text: v.string({ min: 2, max: 500 }) });
const goalStatusBody = v.object({ status: v.literal(GOAL_STATUSES) });
const endpointBody = v.object({ url: v.nullable(v.string({ min: 1, max: 300 })) });
const accountPatchBody = v.object({
  status: v.optional(v.literal(ACCOUNT_STATUSES)),
  outreach_approval_policy: v.optional(v.nullable(v.literal(APPROVAL_POLICIES))),
  daily_outreach_limit: v.optional(v.nullable(v.number({ int: true, min: 0, max: 500 }))),
  daily_publish_limit: v.optional(v.nullable(v.number({ int: true, min: 0, max: 50 }))),
});
const shortList = v.array(v.string({ min: 1, max: 120 }), { max: 30 });
const personaBody = v.object({
  persona_name: v.optional(v.string({ min: 1, max: 60 })),
  bio: v.optional(v.string({ max: 300 })),
  tone: v.optional(v.string({ max: 120 })),
  voice_rules: v.optional(shortList),
  target_customers: v.optional(shortList),
  focus_brands: v.optional(shortList),
  focus_models: v.optional(shortList),
  content_positioning: v.optional(v.string({ max: 300 })),
  signature_phrases: v.optional(shortList),
  taboo_topics: v.optional(shortList),
});
const prepareBody = v.object({ kind: v.optional(v.literal(OUTREACH_KINDS)) });
const approveBody = v.object({ message: v.optional(v.string({ min: 1, max: 1000 })) });
const reasonBody = v.object({ reason: v.string({ min: 1, max: 300 }) });
const inboundBody = v.object({
  account_id: v.string({ min: 1 }),
  platform_user_id: v.string({ min: 1, max: 300 }),
  username: v.optional(v.nullable(v.string({ max: 200 }))),
  content: v.string({ min: 1, max: 5000 }),
  received_at: v.optional(v.string({ min: 10, max: 40 })),
});
const leadInboundBody = v.object({ content: v.string({ min: 1, max: 5000 }), received_at: v.optional(v.string({ min: 10, max: 40 })) });
const replyApproveBody = v.object({ text: v.optional(v.string({ min: 1, max: 1000 })) });
const dealerBody = v.object({ dealer_id: v.string({ min: 1 }) });

/**
 * Nobody in a store knows what a Xiaohongshu user id is, so the console asks for the profile link they can copy from
 * the app. A pasted link is reduced to the id it ends with; anything else is passed through as typed.
 */
export function userIdFromProfileLink(raw: string): string {
  const text = raw.trim();
  if (!text.includes('/')) return text;
  const path = text.split('?')[0]!.split('#')[0]!;
  const last = path.split('/').filter(Boolean).pop() ?? '';
  return /^[A-Za-z0-9_-]{4,64}$/.test(last) ? last : text;
}

const account = (runtime: ServerRuntime, id: string): XhsAccount => requireRow(runtime.ctx.db.table('xhs_accounts').get(id), 'xhs_account', id);

export function registerSalesRoutes(router: Router, runtime: ServerRuntime, options: ServerOptions): void {
  const { ctx, operator } = runtime;

  // ── goals ───────────────────────────────────────────────────────────────────
  router.get('/api/goals', (rc) => json({ goals: operator.listGoals(ctx, dealerFromQuery(rc, ctx)) }));

  router.post('/api/goals', async (rc) => {
    const input = await readBody(rc, goalBody);
    requireDealer(ctx, input.dealer_id);
    requireReadyToRun(ctx, input.dealer_id);
    const result = await operator.submitGoal(ctx, { dealer_id: input.dealer_id, text: input.text, actor: rc.actor }, { background: true });
    return json(result, 202);
  });

  router.patch('/api/goals/:id', async (rc) => {
    const { status } = await readBody(rc, goalStatusBody);
    return json({ goal: operator.setGoalStatus(ctx, rc.params.id, status, rc.actor) });
  });

  // ── managed accounts & Xiaohongshu sessions ─────────────────────────────────
  router.get('/api/accounts', (rc) => {
    const dealerId = dealerFromQuery(rc, ctx);
    return json({ sessions: getAccountSessions(ctx, dealerId), overview: getAccountsOverview(ctx, dealerId) });
  });

  /** A store's daily schedules start once it can actually run (an account is logged in), never for an unconfigured store. */
  const ensureSchedulesWhenReady = (dealerId: string) => {
    if (getSetupStatus(ctx, dealerId).ready) runtime.scheduler.ensureSchedules(ctx, dealerId);
  };

  router.post('/api/accounts/sync', async (rc) => {
    const { dealer_id } = await readBody(rc, dealerBody);
    const results = await syncFleetAuth(ctx, requireDealer(ctx, dealer_id));
    ensureSchedulesWhenReady(dealer_id);
    return json({
      results: results.map((r) => ({ account_id: r.account.id, nickname: r.account.nickname, auth_state: r.account.auth_state, status: r.status, reason: r.reason, applicable: r.applicable })),
    });
  });

  // A login check drives a browser on the account's instance: concurrent checks of one account (console polling,
  // double clicks) share the one in flight instead of queueing more browsers.
  const syncInFlight = new Map<string, ReturnType<typeof syncAccountAuth>>();
  const syncOnce = (accountId: string) => {
    let p = syncInFlight.get(accountId);
    if (!p) {
      p = syncAccountAuth(ctx, accountId).finally(() => syncInFlight.delete(accountId));
      syncInFlight.set(accountId, p);
    }
    return p;
  };

  router.post('/api/accounts/:id/sync', async (rc) => {
    account(runtime, rc.params.id);
    const r = await syncOnce(rc.params.id);
    ensureSchedulesWhenReady(r.account.dealer_id);
    return json({ account_id: r.account.id, auth_state: r.account.auth_state, status: r.status, reason: r.reason, applicable: r.applicable, capabilities: r.capabilities });
  });

  const loginReply = (qr: { already_logged_in: boolean; image_data_url: string | null; expires_at: string | null; detail: string }) => ({
    already_logged_in: qr.already_logged_in,
    image_data_url: typeof qr.image_data_url === 'string' && qr.image_data_url.startsWith('data:image/') ? qr.image_data_url : null,
    expires_at: qr.expires_at,
    detail: qr.detail,
  });

  router.post('/api/accounts/:id/login', async (rc) => {
    account(runtime, rc.params.id);
    return json(loginReply(await startAccountLogin(ctx, rc.params.id, rc.actor)));
  });

  router.post('/api/research-session/login', async (rc) => json(loginReply(await startAccountLogin(ctx, null, rc.actor))));

  /** 账号语言风格: read this account's own notes and (re)build its writing profile. */
  router.post('/api/accounts/:id/voice', async (rc) => {
    account(runtime, rc.params.id);
    const result = await learnAccountVoice(ctx, rc.params.id, rc.actor, { limit: 20 });
    return json({
      ...result,
      detail:
        result.status === 'AVAILABLE'
          ? `看完了 ${result.used} 篇笔记，总结出 ${result.profile?.rules.length ?? 0} 条它自己的写法`
          : (humanProblem(result.reason) ?? scrubInternals(result.reason) ?? '这次没读成，稍后再试'),
    });
  });

  router.get('/api/accounts/:id/voice', (rc) => {
    account(runtime, rc.params.id);
    return json({ profile: getAccountVoice(ctx, rc.params.id) });
  });

  router.post('/api/accounts/:id/logout', async (rc) => {
    account(runtime, rc.params.id);
    const { account: row, detail } = await logoutAccount(ctx, rc.params.id, rc.actor);
    // What the session teardown said is infrastructure; the store only needs to know it has to scan again.
    return json({ account: row, detail: humanProblem(detail) ?? '这个号已经退出登录，要用它就得重新扫码' });
  });

  // Login window: a visible browser on this host (Xiaohongshu rejects QR logins scanned from the headless instance).
  router.post('/api/accounts/:id/login-window', async (rc) => {
    account(runtime, rc.params.id);
    return json({ job: await startLoginWindow(ctx, rc.params.id, rc.actor) }, 202);
  });
  router.post('/api/accounts/:id/login-window/status', async (rc) => {
    account(runtime, rc.params.id);
    return json({ job: loginWindowStatus(ctx, rc.params.id) });
  });
  router.post('/api/research-session/login-window', async (rc) => json({ job: await startLoginWindow(ctx, null, rc.actor) }, 202));
  router.post('/api/research-session/login-window/status', async () => json({ job: loginWindowStatus(ctx, null) }));

  router.post('/api/research-session/status', async () => {
    if (!ctx.xhs.auth) return json({ applicable: false, reason: `${ctx.xhs.name} 不需要扫码登录` });
    const res = await ctx.xhs.auth.status(null);
    if (!res.ok) return json({ applicable: true, logged_in: false, status: res.status, reason: res.reason });
    return json({ applicable: true, logged_in: res.data.logged_in, username: res.data.username, detail: res.data.detail, auth_state: res.data.logged_in ? 'authenticated' : 'requires_auth' });
  });

  // Start this account's own instance on this host (only where the console runs the instances itself).
  router.post('/api/accounts/:id/instance', async (rc) => {
    account(runtime, rc.params.id);
    const { account: bound, instance } = await startAccountInstance(ctx, rc.params.id, rc.actor);
    return json({ account_id: bound.id, endpoint_url: bound.mcp_endpoint_url, instance: instance.instance, port: instance.port, started: instance.started, detail: instance.detail });
  });

  router.put('/api/accounts/:id/endpoint', async (rc) => {
    account(runtime, rc.params.id);
    const { url } = await readBody(rc, endpointBody);
    return json({ account: setAccountEndpoint(ctx, rc.params.id, url, rc.actor) });
  });

  router.patch('/api/accounts/:id', async (rc) => {
    const current = account(runtime, rc.params.id);
    const patch = await readBody(rc, accountPatchBody);
    if (Object.keys(patch).length === 0) throw new ValidationError('body', 'nothing to update');
    const updated = ctx.db.tx(() => {
      const nullCols = (['outreach_approval_policy', 'daily_outreach_limit', 'daily_publish_limit'] as const).filter((k) => patch[k] === null);
      const nonNull = Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== null)) as Partial<XhsAccount>;
      let row = Object.keys(nonNull).length > 0 ? ctx.db.table('xhs_accounts').update(current.id, nonNull) : current;
      if (nullCols.length > 0) row = ctx.db.table('xhs_accounts').setNull(current.id, [...nullCols]);
      ctx.audit.event({
        actor: rc.actor,
        action: 'account.settings_updated',
        entity_type: 'xhs_account',
        entity_id: current.id,
        details: {
          before: { status: current.status, outreach_approval_policy: current.outreach_approval_policy, daily_outreach_limit: current.daily_outreach_limit, daily_publish_limit: current.daily_publish_limit },
          after: patch,
        },
      });
      return row;
    });
    return json({ account: updated });
  });

  router.patch('/api/accounts/:id/persona', async (rc) => {
    account(runtime, rc.params.id);
    const patch = await readBody(rc, personaBody);
    if (Object.keys(patch).length === 0) throw new ValidationError('body', 'nothing to update');
    return json({ persona: updatePersona(ctx, rc.params.id, patch as Partial<AccountPersona>, rc.actor) });
  });

  router.post('/api/accounts/:id/poll-inbox', async (rc) => {
    account(runtime, rc.params.id);
    return json(await pollInbox(ctx, rc.params.id));
  });

  // ── outreach (REVIEW_REQUIRED workflow) ─────────────────────────────────────
  router.get('/api/outreach', (rc) => {
    const dealerId = dealerFromQuery(rc, ctx);
    const statusRaw = queryString(rc.query, 'status');
    const statuses = statusRaw ? (statusRaw.split(',') as OutreachStatus[]) : undefined;
    if (statuses) for (const s of statuses) if (!OUTREACH_STATUSES.includes(s)) throw new ValidationError('status', `unknown status ${s}`);
    return json({ items: listOutreachQueue(ctx, { dealer_id: dealerId, statuses, account_id: queryString(rc.query, 'account_id'), limit: paging(rc, 100, 500).limit }) });
  });

  router.post('/api/leads/:id/outreach', async (rc) => {
    requireRow(ctx.db.table('leads').get(rc.params.id), 'lead', rc.params.id);
    const { kind } = await readBody(rc, prepareBody);
    return json({ outreach: await prepareOutreach(ctx, rc.params.id, { kind, actor: rc.actor }) }, 201);
  });

  router.post('/api/outreach/:id/approve', async (rc) => {
    const { message } = await readBody(rc, approveBody);
    return json({ outreach: await approveOutreach(ctx, rc.params.id, rc.actor, message) });
  });

  router.post('/api/outreach/:id/send', async (rc) => json({ outreach: await sendOutreach(ctx, rc.params.id) }));

  router.post('/api/outreach/:id/mark-sent', (rc) => json({ outreach: markOutreachSentManually(ctx, rc.params.id, rc.actor) }));

  router.post('/api/outreach/:id/cancel', async (rc) => {
    const { reason } = await readBody(rc, reasonBody);
    return json({ outreach: cancelOutreach(ctx, rc.params.id, rc.actor, reason) });
  });

  router.post('/api/follow-ups/plan', async (rc) => {
    const { dealer_id } = await readBody(rc, dealerBody);
    return json({ outreach: await planFollowUps(ctx, requireDealer(ctx, dealer_id)) });
  });

  // ── conversations ───────────────────────────────────────────────────────────
  router.get('/api/conversations', (rc) => {
    const dealerId = dealerFromQuery(rc, ctx);
    const nh = queryString(rc.query, 'needs_human');
    return json({
      conversations: listConversations(ctx, {
        dealer_id: dealerId,
        needs_human: nh === undefined ? undefined : nh === 'true' || nh === '1',
        account_id: queryString(rc.query, 'account_id'),
        limit: paging(rc, 100, 500).limit,
      }),
    });
  });

  router.get('/api/conversations/:id', (rc) => {
    const conversation = requireRow(ctx.db.table('conversations').get(rc.params.id), 'conversation', rc.params.id);
    return json({
      conversation,
      messages: ctx.db.table('conversation_messages').findMany({ conversation_id: conversation.id }, { orderBy: 'created_at ASC' }),
      lead: ctx.db.table('leads').get(conversation.lead_id) ?? null,
      account: ctx.db.table('xhs_accounts').get(conversation.account_id) ?? null,
      appointments: ctx.db.table('appointments').findMany({ lead_id: conversation.lead_id }, { orderBy: 'created_at DESC' }),
    });
  });

  router.post('/api/conversations/inbound', async (rc) => {
    const input = await readBody(rc, inboundBody);
    account(runtime, input.account_id);
    const platform_user_id = userIdFromProfileLink(input.platform_user_id);
    return json(await processInboundMessage(ctx, { ...input, platform_user_id, source: 'manual', actor: rc.actor }), 201);
  });

  router.post('/api/leads/:id/inbound', async (rc) => {
    const lead = requireRow(ctx.db.table('leads').get(rc.params.id), 'lead', rc.params.id);
    const input = await readBody(rc, leadInboundBody);
    const assignment = getActiveAssignment(ctx, lead.id);
    const existing = ctx.db.table('conversations').findOne({ lead_id: lead.id }, { orderBy: 'last_message_at DESC' });
    const accountId = assignment?.account_id ?? existing?.account_id;
    if (!accountId) throw new AppError('no_owning_account', '该线索还没有负责账号，无法登记回复：请先分配账号', 409);
    return json(
      await processInboundMessage(ctx, {
        account_id: accountId,
        platform_user_id: lead.platform_user_id,
        username: lead.username,
        content: input.content,
        received_at: input.received_at,
        source: 'manual',
        actor: rc.actor,
      }),
      201,
    );
  });

  router.post('/api/messages/:id/approve', async (rc) => {
    const { text } = await readBody(rc, replyApproveBody);
    return json({ message: await approveReply(ctx, rc.params.id, rc.actor, text) });
  });

  router.post('/api/messages/:id/mark-sent', (rc) => json({ message: markReplySentManually(ctx, rc.params.id, rc.actor) }));

  // ── 聚光 私信API对接 lead push ──────────────────────────────────────────────────
  router.post(
    '/webhooks/juguang',
    async (rc) => {
      if (!options.juguang_token) throw new AppError('not_found', 'webhook disabled', 404);
      const token = rc.query.get('token') ?? (typeof rc.req.headers['x-webhook-token'] === 'string' ? rc.req.headers['x-webhook-token'] : '');
      if (!token || !safeEqual(token, options.juguang_token)) throw new AppError('unauthorized', 'invalid webhook token', 401);
      const dealerId = queryString(rc.query, 'dealer_id') ?? options.juguang_default_dealer_id;
      if (!dealerId) throw new AppError('webhook_misconfigured', 'JUGUANG_DEFAULT_DEALER_ID is not configured', 500);
      requireDealer(ctx, dealerId);
      const leads = parseJuguangLeadPush(await rc.json());
      const result = ingestJuguangLeads(ctx, leads, { dealer_id: dealerId, actor: 'webhook:juguang' });
      return json({ ok: true, received: leads.length, ...result });
    },
    { public: true },
  );
}
