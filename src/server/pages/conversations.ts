/** 对话: conversations (needs-human first), thread with extracted slots, fact-grounded drafts and manual reply capture. */
import { listConversations } from '../../skills/sales/conversation/index.ts';
import type { Reply, RequestContext } from '../http.ts';
import { queryString } from '../http.ts';
import type { LeadStage } from '../../core/types.ts';
import { LEAD_STAGE, ago, appointmentStatusPill, emptyState, esc, fmtTime, href, leadStagePill, pill, sectionHead, table, tierPill } from '../render.ts';
import { slotsKv, threadHtml } from './components.ts';
import { dealerTz, noDealerBody, renderPage, resolveDealer, type PageEnv } from './shell.ts';

export function conversationsPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const { dealer, dealers } = resolveDealer(ctx, rc);
  if (!dealer) return renderPage(env, rc, { title: '对话', active: 'conversations', dealer: null, dealers, h1: '对话', subtitle: '尚未配置门店', body: noDealerBody() });
  const nh = queryString(rc.query, 'needs_human');
  const items = listConversations(ctx, { dealer_id: dealer.id, needs_human: nh === '1' ? true : undefined, limit: 200 });
  const nowMs = ctx.clock.now().getTime();
  const rows = items.map((x) => [
    `<div class="primary" style="font-size:15px">${esc(x.lead.username)}</div><div class="secondary">${leadStagePill(x.lead.stage)} ${tierPill(x.lead.tier)} ${x.lead.suppressed ? pill('勿扰', 'red') : ''}</div>`,
    esc(x.account.nickname),
    `<div class="quote-cell">${esc((x.last_message?.content ?? '').slice(0, 60))}</div><div class="tiny muted">${esc(ago(x.conversation.last_message_at, nowMs))} · ${esc(x.message_count)} 条</div>`,
    `${x.conversation.needs_human ? pill('需要人工', 'amber', x.conversation.handoff_reason ?? '') : pill(x.conversation.status === 'closed' ? '已关闭' : '进行中', x.conversation.status === 'closed' ? 'neutral' : 'violet')} ${x.pending_draft ? pill('回复待审核', 'amber') : ''}`,
    `<a class="btn btn-ghost btn-sm" href="${esc(href(`/conversations/${x.conversation.id}`, { dealer: dealer.id }))}">打开</a>`,
  ]);
  const accounts = ctx.db.table('xhs_accounts').findMany({ dealer_id: dealer.id }, { orderBy: 'created_at ASC' });
  const form = `<form class="card stack" data-api="/api/conversations/inbound" data-success="已登记并分析客户消息">
  <h3>登记客户在小红书私信中的消息</h3>
  <p class="small muted">系统无法读取小红书私信收件箱（无授权接口）。负责账号在 App 中收到回复后，把原话录入这里，AI 会识别意图、提取信息并起草有事实依据的回复。</p>
  <div class="form-grid">
    <label>负责账号<select name="account_id">${accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.nickname)}</option>`).join('')}</select></label>
    <label>客户小红书用户ID<input type="text" name="platform_user_id" required maxlength="200"></label>
    <label>客户昵称<input type="text" name="username" maxlength="200" data-optional></label>
  </div>
  <label>消息原文<textarea name="content" required maxlength="5000"></textarea></label>
  <div class="row"><span class="spacer"></span><button class="btn btn-ink btn-sm" type="submit">登记消息</button></div>
</form>`;
  const body = `${sectionHead('对话列表', { live: true, note: '需要人工处理的对话排在最前', right: `<a class="btn btn-ghost btn-sm" href="${esc(href('/conversations', { dealer: dealer.id, needs_human: nh === '1' ? undefined : '1' }))}">${nh === '1' ? '显示全部' : '只看需要人工'}</a>` })}
${rows.length ? table(['客户', '负责账号', '最新消息', '状态', ''], rows) : emptyState('还没有对话。私信发出后，客户的回复会出现在这里。')}
<div class="block">${form}</div>`;
  return renderPage(env, rc, { title: '对话', active: 'conversations', dealer, dealers, h1: '客户 <span class="grad">对话</span>', subtitle: `${dealer.name} · 目标是推进到留资、预约和到店，而不是让 AI 无休止聊天`, body });
}

export function conversationDetailPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const conversation = ctx.db.table('conversations').require(rc.params.id);
  const lead = ctx.db.table('leads').require(conversation.lead_id);
  const account = ctx.db.table('xhs_accounts').get(conversation.account_id);
  const { dealers } = resolveDealer(ctx, rc);
  const dealer = dealers.find((d) => d.id === lead.dealer_id) ?? null;
  const tz = dealerTz(dealer);
  const messages = ctx.db.table('conversation_messages').findMany({ conversation_id: conversation.id }, { orderBy: 'created_at ASC' });
  const appointments = ctx.db.table('appointments').findMany({ lead_id: lead.id }, { orderBy: 'created_at DESC' });
  const inbound = `<form class="stack" data-api="/api/conversations/inbound" data-success="已登记客户消息">
  <input type="hidden" name="account_id" value="${esc(conversation.account_id)}"><input type="hidden" name="platform_user_id" value="${esc(lead.platform_user_id)}"><input type="hidden" name="username" value="${esc(lead.username)}">
  <label>录入客户的新消息<textarea name="content" required maxlength="5000"></textarea></label>
  <div class="row"><span class="spacer"></span><button class="btn btn-ink btn-sm" type="submit">登记消息</button></div></form>`;
  const body = `<div class="detail-grid">
  <div class="panel stack"><div class="row"><h2 class="panel-title" style="margin:0">对话记录</h2>${conversation.needs_human ? pill('需要人工接管', 'amber') : ''}<span class="spacer"></span><a class="link small" href="${esc(href(`/leads/${lead.id}`, { dealer: lead.dealer_id }))}">查看线索详情 →</a></div>
    ${conversation.handoff_reason ? `<div class="banner banner-amber" style="margin:0">${esc(conversation.handoff_reason)}</div>` : ''}
    ${threadHtml(messages, tz)}${inbound}</div>
  <div class="stack">
    <div class="panel"><h2 class="panel-title">已提取信息</h2>${slotsKv(conversation.slots)}<p class="tiny muted">AI 轮次 ${esc(conversation.ai_turns)} · 最近消息 ${esc(fmtTime(conversation.last_message_at, tz))}</p></div>
    <div class="panel stack"><h2 class="panel-title">预约</h2>${appointments.length ? appointments.map((a) => `<div class="row">${appointmentStatusPill(a.status)}<span class="small">${esc(a.vehicle_interest)} · ${esc(a.scheduled_for ? fmtTime(a.scheduled_for, tz) : a.time_text ?? '时间待定')}</span></div>`).join('') : '<p class="muted small">暂无预约</p>'}</div>
  </div></div>`;
  return renderPage(env, rc, {
    title: `对话 ${lead.username}`,
    active: 'conversations',
    dealer,
    dealers,
    h1: `${esc(lead.username)} · <span class="grad">${esc(account?.nickname ?? '')}</span>`,
    subtitle: `${leadStageText(lead.stage)} · 负责账号 ${account?.nickname ?? conversation.account_id}`,
    body,
  });
}

function leadStageText(stage: LeadStage): string {
  return `当前阶段：${LEAD_STAGE[stage]?.[0] ?? stage}`;
}
