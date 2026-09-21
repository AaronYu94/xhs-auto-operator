/**
 * 消息中心: the three notification tabs Xiaohongshu itself shows an account — 评论和@, 赞和收藏, 新增关注 — rendered in the
 * same 对话 page as 私信, because in the app they are one place.
 *
 * Every row is actionable where the platform allows it: a comment can be replied to and liked, anyone can be turned
 * into a lead by hand, and anything can be marked done or ignored. What the platform hid from us (deleted comments,
 * notes under review) is stated rather than silently missing, and a row that already produced a lead links to it.
 */
import type { AppContext } from '../../app/context.ts';
import { NOTIFICATION_TABS, type Dealer, type NotificationKind, type NotificationTab, type XhsNotification } from '../../core/types.ts';
import { countNewNotifications, listNotifications } from '../../skills/operations/notification-inbox/index.ts';
import { ago, esc, href, pill, type Tone } from '../render.ts';
import { avatarHtml } from './components.ts';

export const NOTIFICATION_VIEWS: Record<NotificationTab, string> = {
  mentions: '评论和@',
  likes: '赞和收藏',
  connections: '新增关注',
};

const KIND: Record<NotificationKind, [string, Tone]> = {
  comment: ['评论', 'violet'],
  mention: ['@ 提到', 'violet'],
  like: ['赞', 'neutral'],
  collect: ['收藏', 'neutral'],
  follow: ['关注', 'green'],
  other: ['消息', 'neutral'],
};

export function newCounts(ctx: AppContext, dealerId: string): Record<NotificationTab, number> {
  return countNewNotifications(ctx, dealerId);
}

/** The platform's own wording is kept verbatim ("赞了你的笔记"): it is what the account holder saw in the app. */
function headline(n: XhsNotification): string {
  if (n.title.trim()) return n.title.trim();
  return n.kind === 'follow' ? '开始关注你了' : n.kind === 'collect' ? '收藏了你的笔记' : n.kind === 'like' ? '赞了你的笔记' : '给你留言了';
}

/** What the platform gave us as a name; a raw platform id is not one, so it becomes a plain placeholder. */
function who(n: XhsNotification): string {
  const name = (n.from_nickname ?? '').trim();
  return name || '小红书用户';
}

function actions(n: XhsNotification, dealerId: string): string {
  const id = esc(n.id);
  const out: string[] = [];
  if (n.comment_id) {
    out.push(`<details class="ntf-reply">
  <summary class="btn btn-ghost btn-sm">回复</summary>
  <div class="ntf-reply-body" id="ntf-reply-${id}">
    <textarea name="text" maxlength="500" placeholder="公开回复这条评论（所有人都能看到）"></textarea>
    <div class="row">
      <button class="btn btn-ink btn-sm" data-action="call" data-url="/api/notifications/${id}/reply" data-form="#ntf-reply-${id}" data-success-detail data-success="已回复" data-pending="发送中…">发出回复</button>
    </div>
  </div>
</details>`);
    out.push(
      n.comment_liked
        ? `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/notifications/${id}/like" data-body='{"unlike":true}' data-success-detail data-success="已取消点赞">已赞 ✓</button>`
        : `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/notifications/${id}/like" data-success-detail data-success="已点赞">点赞</button>`,
    );
  }
  out.push(
    n.lead_id
      ? `<a class="link small" href="${esc(href(`/leads/${n.lead_id}`, { dealer: dealerId }))}">查看线索 →</a>`
      : `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/notifications/${id}/promote" data-success="已转为线索">转为线索</button>`,
  );
  if (n.status === 'NEW') {
    out.push(`<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/notifications/${id}/handled" data-success="已标记处理完">处理完</button>`);
    out.push(`<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/notifications/${id}/ignore" data-success="已忽略">忽略</button>`);
  }
  return `<div class="ntf-actions">${out.join('')}</div>`;
}

function row(n: XhsNotification, accountName: string, dealerId: string, nowMs: number): string {
  const [label, tone] = KIND[n.kind];
  const noteLink = n.note_id
    ? `<a class="ntf-note" href="${esc(`https://www.xiaohongshu.com/explore/${encodeURIComponent(n.note_id)}${n.note_xsec_token ? `?xsec_token=${encodeURIComponent(n.note_xsec_token)}` : ''}`)}" target="_blank" rel="noreferrer noopener">${esc(n.note_title || '打开这篇笔记')} ↗</a>`
    : n.note_title
      ? `<span class="ntf-note">${esc(n.note_title)}</span>`
      : '';
  return `<article class="ntf${n.status === 'NEW' ? ' is-new' : ''}">
  ${avatarHtml(who(n), null, 'avatar-lg')}
  <div class="ntf-body">
    <div class="ntf-top">
      <span class="ntf-name">${esc(who(n))}</span>
      ${pill(label, tone)}
      <span class="ntf-said">${esc(headline(n))}</span>
      <span class="spacer"></span>
      <span class="ntf-time">${esc(ago(n.occurred_at, nowMs))}</span>
    </div>
    ${n.comment_text ? `<blockquote class="ntf-text">${esc(n.comment_text)}</blockquote>` : ''}
    <div class="ntf-foot">收到的账号 ${esc(accountName)}${noteLink ? ` · ${noteLink}` : ''}${n.status === 'IGNORED' ? ' · 已忽略' : n.status === 'HANDLED' ? ' · 已处理' : ''}</div>
    ${actions(n, dealerId)}
  </div>
</article>`;
}

/** The pane that replaces the DM inbox when one of the notification tabs is open. */
export function notificationsPane(ctx: AppContext, dealer: Dealer, tab: NotificationTab, nowMs: number): string {
  const rows = listNotifications(ctx, dealer.id, { tab, limit: 200 });
  const names = new Map(ctx.db.table('xhs_accounts').findMany({ dealer_id: dealer.id }).map((a) => [a.id, a.nickname]));
  const list = rows.length
    ? rows.map((n) => row(n, names.get(n.account_id) ?? '（已移除的账号）', dealer.id, nowMs)).join('')
    : `<p class="im-list-empty">还没有${esc(NOTIFICATION_VIEWS[tab])}。点右上角「同步消息」去小红书读一次。</p>`;
  return `<div class="ntf-pane">
  <div class="ntf-head">
    <span class="ntf-head-title">${esc(NOTIFICATION_VIEWS[tab])}</span>
    <span class="muted small">${rows.length} 条</span>
    <span class="spacer"></span>
    <button class="btn btn-ink btn-sm" data-action="call" data-url="/api/notifications/sync" data-body='${esc(JSON.stringify({ dealer_id: dealer.id }))}' data-pending="读取中…" data-success="已同步">同步消息</button>
  </div>
  <div class="ntf-list">${list}</div>
</div>`;
}

/** 私信 + the three notification tabs, in the order the app shows them. */
export function messageViewTabs(dealerId: string, active: NotificationTab | 'dm', counts: Record<NotificationTab, number>): string {
  const tab = (label: string, on: boolean, params: Record<string, string | undefined>, n = 0) =>
    `<a class="im-tab${on ? ' is-on' : ''}" href="${esc(href('/conversations', { dealer: dealerId, ...params }))}">${esc(label)}${n > 0 ? `<span class="tab-n">${esc(n)}</span>` : ''}</a>`;
  return `<nav class="view-tabs" aria-label="消息分区">
  ${tab('私信', active === 'dm', {})}
  ${NOTIFICATION_TABS.map((t) => tab(NOTIFICATION_VIEWS[t], active === t, { view: t }, counts[t])).join('')}
</nav>`;
}
