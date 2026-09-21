/**
 * notification-inbox — Xiaohongshu's own 消息中心, mirrored per managed account.
 *
 * Until this existed the system only saw people it went out and searched for. The platform, meanwhile, keeps telling
 * every account who commented on its notes, who @-mentioned it, who liked or collected a note and who started
 * following — the warmest inbound there is, and it was arriving nowhere. `syncAccountNotifications` reads the three
 * tabs through the provider, stores one row per notification (deduped on Xiaohongshu's own id) and turns comments that
 * are buyer signals into leads through the normal pipeline (screen → classifyActor → upsertLeadFromSignal), so a
 * comment on our note is scored, assigned and guarded exactly like a discovered one.
 *
 * Honesty rules kept here:
 * - Reading a tab clears its unread badge on Xiaohongshu; `unreadCounts` does not, so the console reads counts first.
 * - `filtered` (entries the platform hid: deleted comment, note under review) is carried through, never swallowed.
 * - Replies and likes go out only when a human asks for them here; drafting automatic public replies stays with the
 *   engagement skill, which owns the guards for that. A reply is recorded only when the provider confirmed it.
 * - A follower or a like is never a lead by itself: there is no text, so there is no purchase signal.
 */
import type { AppContext } from '../../../app/context.ts';
import { NotFoundError, PolicyError, ValidationError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import { truncate } from '../../../core/text.ts';
import {
  NOTIFICATION_TABS,
  type ActorType,
  type CapabilityStatus,
  type NotificationKind,
  type NotificationStatus,
  type NotificationTab,
  type XhsAccount,
  type XhsNotification,
} from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import { classifyActor } from '../../../domain/actor-classification.ts';
import { xhsProfileUrl } from '../../../providers/xhs/mcp-provider.ts';
import type { XhsNotificationItem, XhsUnreadCounts } from '../../../providers/xhs/types.ts';
import { detectIntentRules } from '../../acquisition/intent-detection/nlu.ts';
import { upsertLeadFromSignal } from '../../acquisition/lead-deduplication/index.ts';
import { SCREEN_ROLE_ACTOR, screenCandidates } from '../../acquisition/lead-discovery/llm-screen.ts';
import { getDealer, getDealerProfile } from '../dealer-brain/index.ts';
import { defineSkill } from '../../registry.ts';

export const NOTIFICATION_AGENT = 'lead-hunting-agent';
/** How many entries are read per tab on a sync (the platform pages them itself). */
export const DEFAULT_NOTIFICATION_LIMIT = 30;
const MAX_NOTIFICATION_LIMIT = 100;
const MAX_TEXT_CHARS = 2000;

export interface NotificationTabResult {
  tab: NotificationTab;
  status: CapabilityStatus;
  reason: string;
  fetched: number;
  /** rows this sync inserted (a re-sync of the same notifications inserts nothing) */
  created: number;
  /** entries Xiaohongshu hid from us (deleted comment, note under review) */
  filtered: number;
}

export interface SyncNotificationsResult {
  account_id: string;
  account_name: string;
  /** null when the counts could not be read (the tabs may still have been read) */
  unread: XhsUnreadCounts | null;
  tabs: NotificationTabResult[];
  created: number;
  leads_created: number;
  /** why nothing could be read, when that is the case */
  detail: string;
}

/** A comment notification that looked like a buyer and what came of it. */
interface LeadCandidate {
  row: XhsNotification;
  text: string;
}

const tabsOf = (tabs?: readonly NotificationTab[]): NotificationTab[] => (tabs && tabs.length > 0 ? [...new Set(tabs)] : [...NOTIFICATION_TABS]);

function requireLiveAccount(ctx: AppContext, accountId: string): XhsAccount {
  const account = ctx.db.table('xhs_accounts').get(accountId);
  if (!account) throw new NotFoundError('xhs_account', accountId);
  if (account.removed_at) throw new PolicyError('account_removed', '该账号已从车队移除，无法读取它的通知', { account_id: accountId });
  return account;
}

/** Unread badges per tab. Reading them does not clear anything — listing a tab does. */
export async function unreadCounts(ctx: AppContext, accountId: string): Promise<{ counts: XhsUnreadCounts | null; status: CapabilityStatus; reason: string }> {
  requireLiveAccount(ctx, accountId);
  if (!ctx.xhs.getUnreadCounts) return { counts: null, status: 'UNAVAILABLE', reason: `提供方 ${ctx.xhs.name} 没有通知中心` };
  const res = await ctx.xhs.getUnreadCounts(accountId);
  if (!res.ok) return { counts: null, status: res.status, reason: res.reason };
  return { counts: res.data, status: 'AVAILABLE', reason: '' };
}

/**
 * Read the account's notification centre and store what is new.
 *
 * Every tab is reported separately: one tab failing (or the provider not having the capability at all) never hides
 * what the others returned, and a tab that could not be read says so instead of looking empty.
 */
export async function syncAccountNotifications(
  ctx: AppContext,
  accountId: string,
  opts: { limit?: number; tabs?: readonly NotificationTab[] } = {},
): Promise<SyncNotificationsResult> {
  const account = requireLiveAccount(ctx, accountId);
  const base: SyncNotificationsResult = {
    account_id: account.id,
    account_name: account.nickname,
    unread: null,
    tabs: [],
    created: 0,
    leads_created: 0,
    detail: '',
  };
  if (!ctx.xhs.listNotifications) {
    return { ...base, detail: `提供方 ${ctx.xhs.name} 没有通知中心（小红书消息页只有真实登录会话才有）` };
  }
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_NOTIFICATION_LIMIT)), MAX_NOTIFICATION_LIMIT);

  // Counts first: listing a tab clears its badge, so the numbers must be read before anything is opened.
  const counts = await unreadCounts(ctx, accountId);
  base.unread = counts.counts;

  const candidates: LeadCandidate[] = [];
  for (const tab of tabsOf(opts.tabs)) {
    const res = await ctx.xhs.listNotifications(accountId, { tab, limit });
    if (!res.ok) {
      base.tabs.push({ tab, status: res.status, reason: res.reason, fetched: 0, created: 0, filtered: 0 });
      continue;
    }
    const stored = storeNotifications(ctx, account, tab, res.data.items);
    base.created += stored.created.length;
    base.tabs.push({ tab, status: 'AVAILABLE', reason: '', fetched: res.data.items.length, created: stored.created.length, filtered: res.data.filtered });
    for (const row of stored.created) {
      const text = (row.comment_text ?? '').trim();
      if ((row.kind === 'comment' || row.kind === 'mention') && text) candidates.push({ row, text });
    }
  }
  if (base.tabs.every((t) => t.status !== 'AVAILABLE')) {
    base.detail = base.tabs[0]?.reason ?? counts.reason;
  }
  base.leads_created = await leadsFromComments(ctx, account, candidates);

  ctx.audit.event({
    action: 'notifications_synced',
    actor: `agent:${NOTIFICATION_AGENT}`,
    entity_type: 'xhs_account',
    entity_id: account.id,
    details: { created: base.created, leads_created: base.leads_created, tabs: base.tabs, unread: base.unread },
  });
  return base;
}

/** Every active account of a dealer, in fleet order. */
export async function syncDealerNotifications(
  ctx: AppContext,
  dealerId: string,
  opts: { limit?: number; tabs?: readonly NotificationTab[] } = {},
): Promise<SyncNotificationsResult[]> {
  getDealer(ctx, dealerId);
  const accounts = ctx.db.table('xhs_accounts').findMany({ dealer_id: dealerId, removed_at: null }, { orderBy: 'created_at ASC, id ASC' });
  const out: SyncNotificationsResult[] = [];
  for (const account of accounts) {
    if (account.status === 'disabled') continue;
    out.push(await syncAccountNotifications(ctx, account.id, opts));
  }
  return out;
}

/** Insert the notifications this account has not stored yet (Xiaohongshu's own id is the key). */
function storeNotifications(ctx: AppContext, account: XhsAccount, tab: NotificationTab, items: XhsNotificationItem[]): { created: XhsNotification[] } {
  if (items.length === 0) return { created: [] };
  const now = ctx.clock.iso();
  return ctx.db.tx(() => {
    const table = ctx.db.table('xhs_notifications');
    const created: XhsNotification[] = [];
    for (const item of items) {
      const existing = table.findOne({ account_id: account.id, provider_notification_id: item.provider_notification_id });
      if (existing) {
        // The platform's own like state can change under us; nothing else about a past notification does.
        if (existing.comment_liked !== item.comment_liked) table.update(existing.id, { comment_liked: item.comment_liked });
        continue;
      }
      created.push(
        table.insert({
          id: newId('ntf'),
          dealer_id: account.dealer_id,
          account_id: account.id,
          provider_notification_id: item.provider_notification_id,
          tab,
          kind: item.kind,
          title: truncate(item.title, 200),
          occurred_at: item.occurred_at,
          from_user_id: item.from_user_id,
          from_nickname: truncate(item.from_nickname ?? '', 100),
          from_xsec_token: item.from_xsec_token,
          comment_id: item.comment_id,
          comment_text: item.comment_text ? truncate(item.comment_text, MAX_TEXT_CHARS) : null,
          comment_liked: item.comment_liked,
          note_id: item.note_id,
          note_xsec_token: item.note_xsec_token,
          note_title: item.note_title ? truncate(item.note_title, 200) : null,
          status: 'NEW',
          lead_id: null,
          reply_message_id: null,
          handled_at: null,
          handled_by: null,
          fetched_at: now,
        }),
      );
    }
    return { created };
  });
}

/**
 * Turn buyer comments on our own notes into leads, through the same screen the discovery pipeline uses: with an LLM
 * configured only a screened `buyer` becomes a lead, and a failed screen leaves the notification unscreened — never a
 * rules fallback. Without an LLM the rules decide, exactly as discovery does.
 */
async function leadsFromComments(ctx: AppContext, account: XhsAccount, candidates: LeadCandidate[]): Promise<number> {
  if (candidates.length === 0) return 0;
  const dealer = getDealer(ctx, account.dealer_id);
  const profile = getDealerProfile(ctx, dealer.id);
  const llmOn = ctx.llm.status().status === 'AVAILABLE';
  const noteTitle = candidates[0].row.note_title ?? '';
  const screen = llmOn
    ? await screenCandidates(
        ctx,
        { title: noteTitle, content: '' },
        candidates.map((c, i) => ({
          id: `n${i}`,
          source_type: 'comment' as const,
          text: c.text,
          author_nickname: c.row.from_nickname || null,
          ip_location: null,
          reply_to: null,
        })),
        dealer.brands ?? [],
      )
    : null;

  let created = 0;
  for (const [idx, cand] of candidates.entries()) {
    const { row, text } = cand;
    const detection = detectIntentRules(
      text,
      { source_type: 'comment', post_title: row.note_title ?? undefined, author_nickname: row.from_nickname || undefined },
      profile,
    );
    let actorType: ActorType = classifyActor(detection).actor_type;
    let enriched = detection;
    if (llmOn) {
      const verdict = screen?.verdicts.get(`n${idx}`);
      if (!verdict) continue; // unscreened is never a lead
      actorType = SCREEN_ROLE_ACTOR[verdict.role];
      if (verdict.role !== 'buyer') continue;
      enriched = { ...detection, evidence: [...detection.evidence, { code: 'llm_screen', label: `大模型复核：${verdict.reason}`, quote: verdict.quote }] };
    } else if (actorType !== 'BUYER') {
      continue;
    }
    try {
      const result = upsertLeadFromSignal(ctx, {
        dealer_id: dealer.id,
        identity: {
          platform_user_id: row.from_user_id,
          username: row.from_nickname || row.from_user_id,
          profile_url: ctx.xhs.mode === 'live' ? xhsProfileUrl(row.from_user_id) : null,
          avatar_url: null,
        },
        signal: {
          source_type: 'comment',
          post_title: row.note_title,
          content: text,
          signal_at: row.occurred_at,
          detection: { ...enriched, actor_type: actorType },
          data_mode: ctx.xhs.mode === 'live' ? 'live' : ctx.xhs.mode === 'simulation' ? 'simulation' : 'unknown',
        },
      });
      ctx.db.table('xhs_notifications').update(row.id, { lead_id: result.lead.id });
      if (result.created) created++;
    } catch (err) {
      // A managed account of our own group commenting, a non-purchase signal, a suppressed contact: all expected here.
      if (!(err instanceof PolicyError)) throw err;
    }
  }
  return created;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read model + actions for the console
// ─────────────────────────────────────────────────────────────────────────────

export interface NotificationFilter {
  tab?: NotificationTab;
  kind?: NotificationKind;
  status?: NotificationStatus;
  account_id?: string;
  limit?: number;
}

export function listNotifications(ctx: AppContext, dealerId: string, filter: NotificationFilter = {}): XhsNotification[] {
  const where: Record<string, unknown> = { dealer_id: dealerId };
  if (filter.tab) where.tab = filter.tab;
  if (filter.kind) where.kind = filter.kind;
  if (filter.status) where.status = filter.status;
  if (filter.account_id) where.account_id = filter.account_id;
  return ctx.db
    .table('xhs_notifications')
    .findMany(where, { orderBy: 'occurred_at DESC, fetched_at DESC', limit: Math.min(Math.max(1, Math.floor(filter.limit ?? 100)), 500) });
}

export function countNewNotifications(ctx: AppContext, dealerId: string): Record<NotificationTab, number> {
  const out: Record<NotificationTab, number> = { mentions: 0, likes: 0, connections: 0 };
  for (const tab of NOTIFICATION_TABS) {
    out[tab] = ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM xhs_notifications WHERE dealer_id = ? AND tab = ? AND status = 'NEW'",
      dealerId,
      tab,
    )?.n ?? 0;
  }
  return out;
}

export function requireNotification(ctx: AppContext, id: string): XhsNotification {
  const row = ctx.db.table('xhs_notifications').get(id);
  if (!row) throw new NotFoundError('xhs_notification', id);
  return row;
}

function close(ctx: AppContext, row: XhsNotification, status: NotificationStatus, actor: string, extra: Partial<XhsNotification> = {}): XhsNotification {
  return ctx.db.tx(() =>
    ctx.db.table('xhs_notifications').update(row.id, { status, handled_at: ctx.clock.iso(), handled_by: actor, ...extra }),
  );
}

export function markNotificationHandled(ctx: AppContext, id: string, actor: string): XhsNotification {
  const row = requireNotification(ctx, id);
  const updated = close(ctx, row, 'HANDLED', actor);
  ctx.audit.event({ action: 'notification_handled', actor, entity_type: 'xhs_notification', entity_id: row.id, details: { kind: row.kind } });
  return updated;
}

export function ignoreNotification(ctx: AppContext, id: string, actor: string): XhsNotification {
  const row = requireNotification(ctx, id);
  const updated = close(ctx, row, 'IGNORED', actor);
  ctx.audit.event({ action: 'notification_ignored', actor, entity_type: 'xhs_notification', entity_id: row.id, details: { kind: row.kind } });
  return updated;
}

export interface NotificationActionResult {
  notification: XhsNotification;
  status: CapabilityStatus;
  reason: string;
}

/**
 * Public reply to the comment a notification points at. It becomes HANDLED only when the provider confirmed the reply;
 * an unconfirmed outcome stays NEW with the reason, and is never retried automatically.
 */
export async function replyToNotification(ctx: AppContext, id: string, text: string, actor: string): Promise<NotificationActionResult> {
  const row = requireNotification(ctx, id);
  const body = (text ?? '').trim();
  if (!body) throw new ValidationError('text', '回复内容不能为空');
  if (!row.comment_id) throw new PolicyError('not_repliable', '这条通知没有可回复的评论（点赞、收藏和关注不能回复）', { notification_id: row.id });
  if (!ctx.xhs.replyToNotification) return { notification: row, status: 'UNAVAILABLE', reason: `提供方 ${ctx.xhs.name} 不能回复通知里的评论` };
  const res = await ctx.xhs.replyToNotification(row.account_id, row.comment_id, body);
  if (!res.ok) {
    ctx.audit.event({
      action: 'notification_reply_failed',
      actor,
      entity_type: 'xhs_notification',
      entity_id: row.id,
      details: { status: res.status, reason: res.reason },
    });
    return { notification: row, status: res.status, reason: res.reason };
  }
  const updated = close(ctx, row, 'HANDLED', actor, { reply_message_id: res.data.provider_message_id });
  ctx.audit.event({
    action: 'notification_replied',
    actor,
    entity_type: 'xhs_notification',
    entity_id: row.id,
    details: { provider_message_id: res.data.provider_message_id, text: truncate(body, 200) },
  });
  return { notification: updated, status: 'AVAILABLE', reason: '' };
}

/** Like (or unlike) the comment a notification points at. */
export async function likeNotification(ctx: AppContext, id: string, actor: string, unlike = false): Promise<NotificationActionResult> {
  const row = requireNotification(ctx, id);
  if (!row.comment_id) throw new PolicyError('not_likeable', '这条通知没有可点赞的评论', { notification_id: row.id });
  if (!ctx.xhs.likeNotificationComment) return { notification: row, status: 'UNAVAILABLE', reason: `提供方 ${ctx.xhs.name} 不能给评论点赞` };
  const res = await ctx.xhs.likeNotificationComment(row.account_id, row.comment_id, unlike);
  if (!res.ok) return { notification: row, status: res.status, reason: res.reason };
  const updated = ctx.db.tx(() => ctx.db.table('xhs_notifications').update(row.id, { comment_liked: res.data.liked }));
  ctx.audit.event({ action: 'notification_liked', actor, entity_type: 'xhs_notification', entity_id: row.id, details: { liked: res.data.liked } });
  return { notification: updated, status: 'AVAILABLE', reason: '' };
}

/**
 * Turn one notification into a lead by hand (a follower, or a comment the screen did not call a buyer). The signal is
 * the notification's own text; a notification without text (a like, a follow) carries the platform's own wording, so
 * the lead records what actually happened rather than an invented sentence.
 */
export function promoteNotificationToLead(ctx: AppContext, id: string, actor: string): { notification: XhsNotification; lead_id: string } {
  const row = requireNotification(ctx, id);
  if (row.lead_id) return { notification: row, lead_id: row.lead_id };
  const account = requireLiveAccount(ctx, row.account_id);
  const profile = getDealerProfile(ctx, account.dealer_id);
  const text = (row.comment_text ?? '').trim() || `${row.title}${row.note_title ? `：${row.note_title}` : ''}`;
  const detection = detectIntentRules(text, { source_type: 'comment', post_title: row.note_title ?? undefined }, profile);
  const result = upsertLeadFromSignal(ctx, {
    dealer_id: account.dealer_id,
    identity: {
      platform_user_id: row.from_user_id,
      username: row.from_nickname || row.from_user_id,
      profile_url: ctx.xhs.mode === 'live' ? xhsProfileUrl(row.from_user_id) : null,
      avatar_url: null,
    },
    signal: {
      // A human vouched for this one: `reply` is the source type that may create a lead without a purchase signal.
      source_type: 'reply',
      post_title: row.note_title,
      content: text,
      signal_at: row.occurred_at,
      detection: { ...detection, actor_type: detection.actor_type ?? classifyActor(detection).actor_type },
      data_mode: 'manual',
    },
  });
  const updated = ctx.db.tx(() => ctx.db.table('xhs_notifications').update(row.id, { lead_id: result.lead.id, status: 'HANDLED', handled_at: ctx.clock.iso(), handled_by: actor }));
  ctx.audit.event({
    action: 'notification_promoted',
    actor,
    entity_type: 'xhs_notification',
    entity_id: row.id,
    details: { lead_id: result.lead.id, created: result.created },
  });
  return { notification: updated, lead_id: result.lead.id };
}

// ─────────────────────────────────────────────────────────────────────────────

interface NotificationSkillInput {
  dealer_id?: string;
  account_id?: string;
  limit?: number;
  tabs?: NotificationTab[];
}

export const skill = defineSkill<NotificationSkillInput, SyncNotificationsResult[]>({
  name: 'notification-inbox',
  category: 'operations',
  agent: NOTIFICATION_AGENT,
  description: '读取每个托管账号在小红书消息中心收到的评论和@、赞和收藏、新增关注，存为可处理的收件箱，并把有购车意向的评论按正常流程变成线索。',
  input: v.object({
    dealer_id: v.optional(v.string({ min: 1 })),
    account_id: v.optional(v.string({ min: 1 })),
    limit: v.optional(v.number({ int: true, min: 1, max: MAX_NOTIFICATION_LIMIT })),
    tabs: v.optional(v.array(v.literal(NOTIFICATION_TABS))),
  }),
  async run(ctx, input) {
    if (input.account_id) return [await syncAccountNotifications(ctx, input.account_id, { limit: input.limit, tabs: input.tabs })];
    if (input.dealer_id) return syncDealerNotifications(ctx, input.dealer_id, { limit: input.limit, tabs: input.tabs });
    throw new ValidationError('dealer_id', 'dealer_id 或 account_id 必填');
  },
});
