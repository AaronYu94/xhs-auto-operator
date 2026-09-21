/**
 * 对话: a Xiaohongshu-shaped message inbox. Left column = people, right column = the thread with them, composer at the
 * bottom, exactly where a salesperson expects them after using the app all day.
 *
 * Two things are deliberately NOT like the app, because the platform decides them, not us:
 * - The composer writes what the CUSTOMER said. Xiaohongshu opens no inbox API, so their words arrive by paste; the
 *   box says so in its own label.
 * - Our side of the thread is what we sent (the reviewed first DM) plus AI drafts that are not sent yet. A draft
 *   carries its own review buttons and never pretends to be delivered.
 */
import { listConversations } from '../../skills/sales/conversation/index.ts';
import type { Reply, RequestContext } from '../http.ts';
import { queryString } from '../http.ts';
import type { AppContext } from '../../app/context.ts';
import { NOTIFICATION_TABS, type ConversationMessage, type LeadStage, type NotificationTab, type XhsAccount } from '../../core/types.ts';
import { localDateKey } from '../../core/time.ts';
import { formatMonthDay } from '../../skills/operations/dealer-brain/shared.ts';
import { ago, appointmentStatusPill, esc, fmtTime, href, leadStagePill, messageStatusPill, pill } from '../render.ts';
import { hint } from '../hint.ts';
import { humanActor } from '../humanize.ts';
import { avatarHtml, slotsKv } from './components.ts';
import { NOTIFICATION_VIEWS, messageViewTabs, newCounts, notificationsPane } from './notifications.ts';
import { dealerTz, noDealerBody, renderPage, resolveDealer, type PageEnv } from './shell.ts';

/** The four steps a reply travels through, shown when no conversation is open. Step 2 is the one no API can do. */

/** What the customer was asking about — the reply drafts store these as machine codes. */
const INTENT_LABEL: Record<string, string> = {
  price_query: '问价格',
  inventory_query: '问现车',
  finance_query: '问贷款',
  trade_in: '想置换',
  test_drive: '想试驾',
  appointment: '想约到店',
  contact_exchange: '要联系方式',
  complaint: '有不满',
  negotiation: '在还价',
  other: '其他',
};
const intentText = (intents: readonly string[]): string =>
  [...new Set(intents.map((i) => INTENT_LABEL[i]).filter(Boolean))].join('、');

interface Person {
  lead_id: string;
  /** the Xiaohongshu user id: what an inbound message is keyed by */
  platform_user_id: string;
  username: string;
  avatar_url: string | null;
  stage: LeadStage;
  suppressed: boolean;
  account_id: string;
  account: string;
  conversation_id: string | null;
  needs_human: boolean;
  handoff_reason: string | null;
  has_draft: boolean;
  closed: boolean;
  /** last thing said by either side, or the DM we sent while waiting */
  preview: string;
  at: string;
  /** true while the customer has never written back */
  waiting: boolean;
}

interface ThreadEntry {
  at: string;
  side: 'in' | 'out';
  text: string;
  /** an AI reply that nobody has sent yet */
  draft: ConversationMessage | null;
  note: string;
}

// ── data ─────────────────────────────────────────────────────────────────────

/** Everyone this store has a thread with, plus everyone it messaged who has not written back. */
function inboxPeople(ctx: AppContext, dealerId: string): Person[] {
  const convs = listConversations(ctx, { dealer_id: dealerId, limit: 200 });
  const avatars = new Map<string, string | null>();
  for (const row of ctx.db.all<{ id: string; avatar_url: string | null }>('SELECT id, avatar_url FROM leads WHERE dealer_id = ?', dealerId)) {
    avatars.set(row.id, row.avatar_url);
  }
  const people: Person[] = convs.map((x) => ({
    lead_id: x.lead.id,
    platform_user_id: x.lead.platform_user_id,
    username: x.lead.username,
    avatar_url: avatars.get(x.lead.id) ?? null,
    stage: x.lead.stage,
    suppressed: x.lead.suppressed,
    account_id: x.account.id,
    account: x.account.nickname,
    conversation_id: x.conversation.id,
    needs_human: x.conversation.needs_human,
    handoff_reason: x.conversation.handoff_reason ?? null,
    has_draft: Boolean(x.pending_draft),
    closed: x.conversation.status === 'closed',
    preview: x.last_message?.content ?? '',
    at: x.conversation.last_message_at,
    waiting: false,
  }));
  const seen = new Set(people.map((p) => p.lead_id));
  for (const row of awaitingReply(ctx, dealerId)) {
    if (seen.has(row.lead_id)) continue;
    people.push({
      lead_id: row.lead_id,
      platform_user_id: row.platform_user_id,
      username: row.username,
      avatar_url: avatars.get(row.lead_id) ?? null,
      stage: row.stage,
      suppressed: false,
      account_id: row.account_id,
      account: row.account,
      conversation_id: null,
      needs_human: false,
      handoff_reason: null,
      has_draft: false,
      closed: false,
      preview: row.message,
      at: row.sent_at,
      waiting: true,
    });
  }
  // needs-human first, then the most recent activity — the same order the operator would triage by
  return people.sort((a, b) => Number(b.needs_human) - Number(a.needs_human) || b.at.localeCompare(a.at));
}

interface AwaitingRow {
  lead_id: string;
  username: string;
  platform_user_id: string;
  stage: LeadStage;
  account_id: string;
  account: string;
  sent_at: string;
  message: string;
}

/** People the store messaged who have not written back: no thread yet, but they belong in the inbox. */
function awaitingReply(ctx: AppContext, dealerId: string): AwaitingRow[] {
  return ctx.db.all<AwaitingRow>(
    `SELECT l.id AS lead_id, l.username AS username, l.platform_user_id AS platform_user_id, l.stage AS stage,
            o.account_id AS account_id, a.nickname AS account, o.message AS message, MAX(COALESCE(o.sent_at, o.updated_at)) AS sent_at
       FROM outreach o
       JOIN leads l ON l.id = o.lead_id
       JOIN xhs_accounts a ON a.id = o.account_id
      WHERE l.dealer_id = ? AND o.status IN ('SENT', 'SENT_MANUALLY') AND l.suppressed = 0
        AND NOT EXISTS (
          SELECT 1 FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE c.lead_id = l.id AND m.direction = 'inbound')
      GROUP BY l.id
      ORDER BY sent_at DESC
      LIMIT 100`,
    dealerId,
  );
}

/** The thread with one person: the DMs this store sent, plus everything in the conversation. */
function threadEntries(ctx: AppContext, leadId: string, conversationId: string | null): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  const sent = ctx.db.all<{ message: string; sent_at: string | null; updated_at: string; kind: string; sent_by: string | null }>(
    `SELECT message, sent_at, updated_at, kind, sent_by FROM outreach
      WHERE lead_id = ? AND status IN ('SENT', 'SENT_MANUALLY') ORDER BY COALESCE(sent_at, updated_at) ASC`,
    leadId,
  );
  for (const o of sent) {
    entries.push({
      at: o.sent_at ?? o.updated_at,
      side: 'out',
      text: o.message,
      draft: null,
      note: `${o.kind === 'first_touch' ? '首次私信' : '跟进私信'}${o.sent_by ? ` · ${esc(humanActor(o.sent_by))}` : ''}`,
    });
  }
  if (conversationId) {
    for (const m of ctx.db.table('conversation_messages').findMany({ conversation_id: conversationId }, { orderBy: 'created_at ASC' })) {
      entries.push({
        at: m.created_at,
        side: m.direction === 'inbound' ? 'in' : 'out',
        text: m.content,
        draft: m.status === 'draft' ? m : null,
        note:
          m.direction === 'inbound'
            ? esc(intentText(m.intents ?? []))
            : m.status === 'draft'
              ? 'AI 草稿，未发送'
              : `${messageStatusPill(m.status)}${m.sent_by ? ` · ${esc(humanActor(m.sent_by))}` : ''}`,
      });
    }
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

// ── left column ──────────────────────────────────────────────────────────────

function personRow(p: Person, dealerId: string, openLead: string | null, nowMs: number): string {
  const url = p.conversation_id
    ? href(`/conversations/${p.conversation_id}`, { dealer: dealerId })
    : href('/conversations', { dealer: dealerId, lead: p.lead_id });
  const flag = p.needs_human
    ? '<span class="im-flag im-flag-warn">需要人工</span>'
    : p.has_draft
      ? '<span class="im-flag">待审核</span>'
      : p.waiting
        ? '<span class="im-flag im-flag-quiet">等回复</span>'
        : '';
  return `<a class="im-person${p.lead_id === openLead ? ' is-open' : ''}" href="${esc(url)}">
  ${avatarHtml(p.username, p.avatar_url, 'avatar-lg')}
  <span class="im-person-body">
    <span class="im-person-top"><span class="im-person-name">${esc(p.username)}</span><span class="im-person-time">${esc(ago(p.at, nowMs))}</span></span>
    <span class="im-person-preview">${p.waiting ? '你已发出私信，等待回复' : esc(p.preview.slice(0, 40))}</span>
    <span class="im-person-foot">${esc(p.account)}${flag}</span>
  </span>
</a>`;
}

function inboxList(people: Person[], dealerId: string, openLead: string | null, needsOnly: boolean, nowMs: number): string {
  const shown = needsOnly ? people.filter((p) => p.needs_human) : people;
  const needs = people.filter((p) => p.needs_human).length;
  const tab = (label: string, on: boolean, params: Record<string, string | undefined>) =>
    `<a class="im-tab${on ? ' is-on' : ''}" href="${esc(href('/conversations', { dealer: dealerId, ...params }))}">${esc(label)}</a>`;
  const rows = shown.length
    ? shown.map((p) => personRow(p, dealerId, openLead, nowMs)).join('')
    : `<p class="im-list-empty">${needsOnly ? '没有需要人工处理的对话。' : '还没有人可以对话。私信发出后，对方会出现在这里。'}</p>`;
  return `<div class="im-list">
  <div class="im-list-head"><span class="im-list-title">消息</span><span class="im-tabs">${tab('全部', !needsOnly, {})}${tab(`需要人工${needs > 0 ? ` ${needs}` : ''}`, needsOnly, { filter: 'needs_human' })}</span></div>
  <div class="im-people" data-scroll-keep>${rows}</div>
  <a class="im-new" href="${esc(href('/conversations', { dealer: dealerId, new: '1' }))}">＋ 新客户主动私信</a>
</div>`;
}

// ── right column ─────────────────────────────────────────────────────────────

function dayDivider(dateKey: string): string {
  return `<div class="im-day">${esc(formatMonthDay(dateKey))}</div>`;
}

function bubble(e: ThreadEntry, p: Person, accountAvatar: string | null, tz: string): string {
  const who = e.side === 'in' ? avatarHtml(p.username, p.avatar_url, 'avatar-sm') : avatarHtml(p.account, accountAvatar, 'avatar-sm');
  const draft = e.draft;
  const body = draft
    ? `<div class="im-draft">
    <div class="im-draft-head">AI 回复草稿 · 未发送</div>
    <div class="stack" id="reply-${esc(draft.id)}">
      <textarea name="text" id="reply-text-${esc(draft.id)}">${esc(draft.content)}</textarea>
      <div class="row">
        <button class="btn btn-ghost btn-sm" data-action="copy" data-target="#reply-text-${esc(draft.id)}">复制</button>
        <button class="btn btn-ink btn-sm" data-action="call" data-url="/api/messages/${esc(draft.id)}/approve" data-form="#reply-${esc(draft.id)}" data-success="回复已审核">审核通过</button>
        <button class="btn btn-primary btn-sm" data-action="call" data-url="/api/messages/${esc(draft.id)}/mark-sent" data-confirm="确认已在小红书发出？再点一次" data-success="已登记人工发送">我已发送</button>
      </div>
    </div>
  </div>`
    : `<div class="im-bubble">${esc(e.text)}</div>`;
  return `<div class="im-msg is-${e.side}">${who}<div class="im-msg-body">${body}<div class="im-msg-meta">${esc(fmtTime(e.at, tz))}${e.note ? ` · ${e.note}` : ''}</div></div></div>`;
}

function threadPane(ctx: AppContext, p: Person, dealerId: string, tz: string, nowMs: number): string {
  const entries = threadEntries(ctx, p.lead_id, p.conversation_id);
  const account = ctx.db.table('xhs_accounts').get(p.account_id);
  const accountAvatar = account?.platform_profile?.avatar_url ?? null;
  let day = '';
  const thread = entries
    .map((e) => {
      const key = localDateKey(new Date(e.at), tz);
      const divider = key === day ? '' : dayDivider(key);
      day = key;
      return divider + bubble(e, p, accountAvatar, tz);
    })
    .join('');
  const conversation = p.conversation_id ? ctx.db.table('conversations').get(p.conversation_id) : undefined;
  const appointments = ctx.db.table('appointments').findMany({ lead_id: p.lead_id }, { orderBy: 'created_at DESC', limit: 3 });
  const extracted = conversation
    ? `<details class="im-extract"><summary>客户透露了什么${conversation.ai_turns > 0 ? `（AI 已自动回 ${esc(conversation.ai_turns)} 次）` : ''}</summary><div class="im-extract-body">${slotsKv(conversation.slots)}${
        appointments.length
          ? `<div class="stack" style="margin-top:10px">${appointments
              .map((a) => `<div class="row">${appointmentStatusPill(a.status)}<span class="small">${esc(a.vehicle_interest)} · ${esc(a.scheduled_for ? fmtTime(a.scheduled_for, tz) : (a.time_text ?? '时间待定'))}</span></div>`)
              .join('')}</div>`
          : ''
      }</div></details>`
    : '';
  return `<div class="im-main">
  <div class="im-head">
    <a class="im-back" href="${esc(href('/conversations', { dealer: dealerId }))}">← 消息</a>
    ${avatarHtml(p.username, p.avatar_url)}
    <div class="im-head-body">
      <div class="im-head-name">${esc(p.username)} ${leadStagePill(p.stage)} ${p.suppressed ? pill('勿扰', 'red') : ''}</div>
      <div class="im-head-meta">负责账号 ${esc(p.account)} · 最近 ${esc(ago(p.at, nowMs))}</div>
    </div>
    <span class="spacer"></span>
    <a class="link small" href="${esc(href(`/leads/${p.lead_id}`, { dealer: dealerId }))}">查看线索 →</a>
  </div>
  ${p.needs_human && p.handoff_reason ? `<div class="im-handoff">${esc(p.handoff_reason)}</div>` : ''}
  ${extracted}
  <div class="im-thread" data-scroll-bottom>${thread || '<p class="im-list-empty">还没有消息。</p>'}</div>
  ${composer(p)}
</div>`;
}

/** The box at the bottom. It takes the customer's words, not ours: the label says so, every time. */
function composer(p: Person): string {
  if (p.suppressed) {
    return `<div class="im-compose is-blocked">该客户已加入勿扰名单，不再登记或回复消息。</div>`;
  }
  return `<form class="im-compose" data-api="/api/conversations/inbound" data-success="已登记，AI 正在读这条消息">
  <input type="hidden" name="account_id" value="${esc(p.account_id)}">
  <input type="hidden" name="platform_user_id" value="${esc(p.platform_user_id)}">
  <input type="hidden" name="username" value="${esc(p.username)}">
  <label class="im-compose-label" for="im-say-${esc(p.lead_id)}">客户说了什么（把他的原话贴进来）${hint([
    '小红书不让系统读私信收件箱，所以客户回的话要你贴进来。',
    '贴进来之后，AI 会看懂他想问什么，并按门店真实资料先写一版回复；发不发还是你说了算。',
  ])}</label>
  <textarea id="im-say-${esc(p.lead_id)}" name="content" required maxlength="5000" placeholder="把对方在小红书私信里发来的话原样粘贴，系统读不到收件箱"></textarea>
  <div class="im-compose-foot"><span class="spacer"></span><button class="btn btn-ink btn-sm" type="submit">保存客户的话</button></div>
</form>`;
}

/**
 * Nothing open. An empty right-hand pane is not a place for a four-card numbered diagram: it says the one thing that
 * is true right now and offers the one thing to do next. How a conversation flows lives behind the page's 「?」.
 */
function explainPane(dealerId: string, people: Person[], sent: number): string {
  const waiting = people.filter((p) => p.waiting).length;
  const [line, action] =
    people.length === 0
      ? sent === 0
        ? ['还没有发出过私信。', `<a class="btn btn-ink btn-sm" href="${esc(href('/leads', { dealer: dealerId }))}">去线索页发第一条</a>`]
        : ['已经发出去的私信还没有人回。', '']
      : [`左边选一个人开始。${waiting > 0 ? `有 ${waiting} 位收到私信还没回。` : ''}`, ''];
  return `<div class="im-main im-explain">
  <div class="im-explain-body">
    <p class="im-explain-text">${esc(line)}</p>
    ${action}
  </div>
</div>`;
}

/** A stranger who wrote first: the only place a user id is typed by hand. */
function newPersonPane(accounts: XhsAccount[], dealerId: string): string {
  return `<div class="im-main">
  <div class="im-head"><a class="im-back" href="${esc(href('/conversations', { dealer: dealerId }))}">← 消息</a><div class="im-head-body"><div class="im-head-name">新客户主动私信</div></div></div>
  <form class="im-compose im-compose-new" data-api="/api/conversations/inbound" data-success="已登记，AI 正在读这条消息">
    <div class="form-grid">
      <label>收到私信的账号<select name="account_id">${accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.nickname)}</option>`).join('')}</select></label>
      <label>客户主页链接${hint('在对方主页点右上角「分享」→「复制链接」，整条粘进来就行；也可以只填链接最后那一段。')}<input type="text" name="platform_user_id" required maxlength="300" placeholder="粘贴他的小红书主页链接"></label>
      <label>客户昵称<input type="text" name="username" maxlength="200" data-optional></label>
    </div>
    <label class="im-compose-label" for="im-say-new">客户说了什么（粘贴原话）</label>
    <textarea id="im-say-new" name="content" required maxlength="5000" placeholder="把对方发来的话原样粘贴"></textarea>
    <div class="im-compose-foot"><span class="spacer"></span><button class="btn btn-ink btn-sm" type="submit">登记客户消息</button></div>
  </form>
</div>`;
}

// ── pages ────────────────────────────────────────────────────────────────────

function inbox(env: PageEnv, rc: RequestContext, openConversationId: string | null): Reply {
  const { ctx } = env.runtime;
  const resolved = resolveDealer(ctx, rc);
  const dealers = resolved.dealers;
  // An opened thread decides the store: a link from another store's lead must not land on the wrong inbox.
  let dealer = resolved.dealer;
  if (openConversationId) {
    const conv = ctx.db.table('conversations').get(openConversationId);
    const lead = conv ? ctx.db.table('leads').get(conv.lead_id) : undefined;
    if (lead) dealer = dealers.find((d) => d.id === lead.dealer_id) ?? dealer;
  }
  if (!dealer) return renderPage(env, rc, { title: '对话', active: 'conversations', dealer: null, dealers, h1: '对话', subtitle: '尚未配置门店', body: noDealerBody() });

  const tz = dealerTz(dealer);
  const nowMs = ctx.clock.now().getTime();
  const viewParam = queryString(rc.query, 'view');
  const view = (NOTIFICATION_TABS as readonly string[]).includes(viewParam ?? '') ? (viewParam as NotificationTab) : null;
  const counts = newCounts(ctx, dealer.id);
  const tabs = messageViewTabs(dealer.id, view ?? 'dm', counts);
  if (view) {
    return renderPage(env, rc, {
      title: `消息 ${NOTIFICATION_VIEWS[view]}`,
      active: 'conversations',
      dealer,
      dealers,
      h1: '对话',
      help: [
        '这里是跟客户的私信，加上小红书「消息」里的三栏通知：谁在我们笔记下留言、谁点赞收藏、谁新关注了我们。',
        '看过之后，小红书 App 里的红点也会跟着消掉。',
        '留言里像要买车的，会自动变成线索；点赞、收藏、关注本身不算线索，要你自己看一眼再「转为线索」。',
      ],
      subtitle: dealer.name,
      body: `${tabs}${notificationsPane(ctx, dealer, view, nowMs)}
`,
    });
  }
  const people = inboxPeople(ctx, dealer.id);
  const filter = queryString(rc.query, 'filter') ?? (queryString(rc.query, 'needs_human') === '1' ? 'needs_human' : undefined);
  const needsOnly = filter === 'needs_human';
  const wantNew = queryString(rc.query, 'new') === '1';
  const leadParam = queryString(rc.query, 'lead');
  const open = openConversationId
    ? (people.find((p) => p.conversation_id === openConversationId) ?? null)
    : leadParam
      ? (people.find((p) => p.lead_id === leadParam) ?? null)
      : null;

  const accounts = ctx.db.table('xhs_accounts').findMany({ dealer_id: dealer.id, removed_at: null }, { orderBy: 'created_at ASC' });
  const sent = Number(
    ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM outreach o JOIN leads l ON l.id = o.lead_id WHERE l.dealer_id = ? AND o.status IN ('SENT', 'SENT_MANUALLY')`,
      dealer.id,
    )?.n ?? 0,
  );
  const right = open ? threadPane(ctx, open, dealer.id, tz, nowMs) : wantNew ? newPersonPane(accounts, dealer.id) : explainPane(dealer.id, people, sent);
  const body = `${tabs}<div class="im${open || wantNew ? ' has-open' : ''}">${inboxList(people, dealer.id, open?.lead_id ?? null, needsOnly, nowMs)}${right}</div>
`;
  return renderPage(env, rc, {
    title: open ? `对话 ${open.username}` : '对话',
    active: 'conversations',
    dealer,
    dealers,
    h1: '对话',
    help: [
      '跟客户的私信都在这里，旁边三栏是小红书「消息」里的留言、点赞收藏和新关注。',
      '系统能替你把私信发出去，但读不到收件箱（小红书只对做过资质审核的客服服务商开放读取）。',
      '所以客户回的话要你贴进来，AI 看懂之后按门店真实资料写一版回复，你点头再发。',
      '还价、投诉、AI 来回聊太多次还没定下来的，会标「需要人工」排到最前面。',
    ],
    subtitle: dealer.name,
    body,
  });
}

export function conversationsPage(env: PageEnv, rc: RequestContext): Reply {
  return inbox(env, rc, null);
}

export function conversationDetailPage(env: PageEnv, rc: RequestContext): Reply {
  return inbox(env, rc, rc.params.id);
}
