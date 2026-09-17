/** 线索: lead inbox cards (§18 — evidence never hidden) and the complete lead detail with outreach review workflow. */
import type { AppContext } from '../../app/context.ts';
import { ACTOR_TYPES, DATA_MODES, LEAD_STAGES, SCORE_TIERS, SIGNAL_SOURCE_TYPES, type Lead, type Outreach } from '../../core/types.ts';
import { ACTOR_LABELS } from '../../domain/actor-classification.ts';
import { getLeadDetail, type LeadDetail } from '../../skills/operations/analytics/index.ts';
import { listOutreachQueue, type OutreachQueueItem } from '../../skills/sales/outreach/index.ts';
import type { Reply, RequestContext } from '../http.ts';
import { inboxQueryFrom, leadInbox, type LeadCardView } from '../api/leads.ts';
import {
  CAPABILITY,
  DATA_MODE,
  LEAD_STAGE,
  PURCHASE_STAGE,
  TIER,
  actorPill,
  ago,
  appointmentStatusPill,
  cny,
  dataBody,
  dataModePill,
  emptyState,
  esc,
  fmtTime,
  href,
  leadStagePill,
  messageStatusPill,
  outreachStatusPill,
  pill,
  scoreBars,
  sectionHead,
  sourceLink,
  table,
  tierPill,
} from '../render.ts';
import { dealerTz, latestCapability, noDealerBody, renderPage, resolveDealer, type PageEnv } from './shell.ts';

const SOURCE_LABEL: Record<string, string> = { post: '发布笔记', comment: '评论', profile: '主页笔记', reply: '私信回复', import: '导入' };
const TIMEFRAME_LABEL: Record<string, string> = { this_week: '本周', soon: '近期', this_month: '本月内', within_3_months: '三个月内', later: '较晚/观望' };

function options<T extends string>(values: readonly T[], selected: string | undefined, label: (v: T) => string, empty: string): string {
  return `<option value="">${esc(empty)}</option>${values.map((x) => `<option value="${esc(x)}"${x === selected ? ' selected' : ''}>${esc(label(x))}</option>`).join('')}`;
}

function leadCard(c: LeadCardView, dealerId: string, nowMs: number): string {
  const hot = c.tier === 'high_intent' || c.tier === 'immediate';
  const source = c.source.type ? SOURCE_LABEL[c.source.type] ?? c.source.type : '来源未知';
  return `<article class="lead-card">
  <div class="lead-top">
    <span class="lead-score${hot ? ' hot' : ''}">${esc(Math.round(c.score))}</span>
    ${tierPill(c.tier)} ${leadStagePill(c.stage)} ${dataModePill(c.data_mode)} ${actorPill(c.actor_type)}
    ${c.suppressed ? pill('勿扰', 'red') : ''}
    <span class="lead-owner">${c.assigned_account ? esc(c.assigned_account.nickname) : '<span class="muted">未分配</span>'}</span>
  </div>
  <div class="lead-model">${esc(c.model_label)} · ${esc(c.location_label)}${c.purchase_stage_label ? ` · ${esc(c.purchase_stage_label)}` : ''}</div>
  <div class="quote"><p>“${esc(c.original_signal || '（无原始信号）')}”</p>
    <small>${esc(c.username)} · ${esc(source)}${c.source.post_title ? ` ·《${esc(c.source.post_title)}》` : ''} · ${esc(ago(c.source.signal_at, nowMs))} · ${sourceLink(c.source.url)}</small></div>
  ${c.signal_count > 1 ? `<div class="merged">已合并同一用户的 ${esc(c.signal_count)} 条信号，只由一个账号负责联系</div>` : ''}
  <div class="chips">${c.intent_chips.map((x) => `<span class="ev">${esc(x)}</span>`).join('')}</div>
  <div class="next"><span><b>下一步：</b>${esc(c.next_action)}</span>${c.outreach_status ? outreachStatusPill(c.outreach_status) : ''}<a class="btn btn-ink btn-sm" href="${esc(href(`/leads/${c.lead_id}`, { dealer: dealerId }))}">详情 →</a></div>
</article>`;
}

export function leadsPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const { dealer, dealers } = resolveDealer(ctx, rc);
  if (!dealer) return renderPage(env, rc, { title: '线索', active: 'leads', dealer: null, dealers, h1: '线索', subtitle: '尚未配置门店', body: noDealerBody() });
  const q = inboxQueryFrom(rc, dealer.id);
  const cards = leadInbox(ctx, q);
  const nowMs = ctx.clock.now().getTime();
  const f = q.filters;
  const filters = `<form class="filters" method="get" action="/leads">
  <input type="hidden" name="dealer" value="${esc(dealer.id)}">
  <input type="text" name="q" value="${esc(q.q ?? '')}" placeholder="用户 / 原话 / 车型" aria-label="搜索">
  <select name="tier">${options(SCORE_TIERS, q.tier, (t) => TIER[t][0], '全部分层')}</select>
  <select name="stage">${options(LEAD_STAGES, f.stage, (s) => LEAD_STAGE[s][0], '全部阶段')}</select>
  <select name="data_mode">${options(DATA_MODES, q.data_mode, (m) => DATA_MODE[m][0], '全部数据来源')}</select>
  <select name="actor_type">${options(ACTOR_TYPES, q.actor_type, (a) => ACTOR_LABELS[a], '全部身份')}</select>
  <select name="source_type">${options(SIGNAL_SOURCE_TYPES, f.source_type, (s) => SOURCE_LABEL[s] ?? s, '全部信号类型')}</select>
  <input type="text" name="model" value="${esc(f.model ?? '')}" placeholder="车型">
  <input type="text" name="location" value="${esc(f.location ?? '')}" placeholder="地区">
  <button class="btn btn-ink btn-sm" type="submit">筛选</button>
  <a class="btn btn-ghost btn-sm" href="${esc(href('/leads', { dealer: dealer.id }))}">清除</a>
</form>`;
  const prev = q.offset > 0 ? `<a class="btn btn-ghost btn-sm" href="${esc(href('/leads', { ...Object.fromEntries(rc.query), offset: Math.max(0, q.offset - q.limit) }))}">上一页</a>` : '';
  const next = cards.length === q.limit ? `<a class="btn btn-ghost btn-sm" href="${esc(href('/leads', { ...Object.fromEntries(rc.query), offset: q.offset + q.limit }))}">下一页</a>` : '';
  const body = `${sectionHead('线索收件箱', { live: true, note: '原始信号、来源链接与判断依据直接可见' })}
${filters}
${cards.length ? `<div class="lead-grid">${cards.map((c) => leadCard(c, dealer.id, nowMs)).join('')}</div>` : emptyState('没有符合条件的线索。下达经营目标并完成一次发现后，合格的公开购买信号会出现在这里。')}
<div class="pager">${prev}${next}</div>`;
  return renderPage(env, rc, { title: '线索', active: 'leads', dealer, dealers, h1: '线索 <span class="grad">收件箱</span>', subtitle: `${dealer.name} · 每条线索都保留原帖出处与判断依据`, body });
}

// ─────────────────────────────────────────────────────────────────────────────
// Detail
// ─────────────────────────────────────────────────────────────────────────────

function intentKv(lead: Lead, detail: LeadDetail): string {
  const i = lead.intent ?? {};
  const flags = [
    i.price_intent && '询价/落地价',
    i.discount_intent && '问优惠',
    i.inventory_intent && '问现车',
    i.financing_intent && '贷款',
    i.leasing_intent && '租赁',
    i.trade_in_intent && '置换',
    i.dealer_selection_intent && '选店',
    i.visit_intent && '想到店',
  ].filter(Boolean) as string[];
  const budget =
    i.budget_min !== undefined || i.budget_max !== undefined
      ? `${i.budget_min !== undefined ? cny(i.budget_min) : ''}${i.budget_min !== undefined && i.budget_max !== undefined ? ' – ' : ''}${i.budget_max !== undefined ? cny(i.budget_max) : ''}`
      : '—';
  const contact = [lead.contact?.phone && `电话 ${lead.contact.phone}`, lead.contact?.wechat && `微信 ${lead.contact.wechat}`].filter(Boolean).join(' · ');
  const rows: [string, string][] = [
    ['车型', esc(detail.card.model_label)],
    ['地区', esc(detail.card.location_label)],
    ['购买阶段', esc(i.purchase_stage ? PURCHASE_STAGE[i.purchase_stage] : '—')],
    ['预算', esc(budget)],
    ['购车时间', esc(i.purchase_timeframe ? TIMEFRAME_LABEL[i.purchase_timeframe] ?? i.purchase_timeframe : '—')],
    ['交易意图', flags.length ? flags.map((x) => `<span class="chip-neutral">${esc(x)}</span>`).join(' ') : '—'],
    ['指定颜色', esc(i.color_intent ?? '—')],
    ['对比车型', esc(i.competing_models?.join('、') || '—')],
    ['推断字段', esc(i.inferred_fields?.join('、') || '无')],
    ['主动留资', contact ? `${esc(contact)} <span class="tiny muted">（用户自愿提供）</span>` : '—'],
    ['预计价值', esc(cny(lead.estimated_value))],
  ];
  return `<dl class="kv">${rows.map(([k, x]) => `<dt>${esc(k)}</dt><dd>${x}</dd>`).join('')}</dl>`;
}

function guardList(o: Outreach): string {
  if (!o.guard_results?.length) return '';
  return `<ul class="guards">${o.guard_results
    .map((g) => {
      const cls = g.passed ? 'g-ok' : g.blocking ? 'g-block' : 'g-review';
      const mark = g.passed ? '✓' : g.blocking ? '✕' : '!';
      return `<li><span class="${cls}">${mark}</span><span><b>${esc(g.check)}</b> ${esc(g.detail)}</span></li>`;
    })
    .join('')}</ul>`;
}

function outreachPanel(ctx: AppContext, env: PageEnv, detail: LeadDetail, queue: Map<string, OutreachQueueItem>): string {
  const lead = detail.lead;
  const assignment = detail.assignment;
  const sendCap = assignment ? latestCapability(ctx, 'send_messages', assignment.account_id) : latestCapability(ctx, 'send_messages', null);
  const sendAvailable = sendCap?.status === 'AVAILABLE';
  const capNote = sendAvailable
    ? '<span class="small muted">发送私信能力：可用（平台确认后才会标记为已发送）</span>'
    : `<span class="small muted">发送私信能力：${esc(sendCap ? CAPABILITY[sendCap.status][0] : '未检测')} — 没有获授权的私信接口，需由负责账号在小红书 App 中人工发送后登记。</span>`;
  const items = [...detail.outreach].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const prepare =
    assignment && !lead.suppressed && !items.some((o) => ['READY_FOR_REVIEW', 'APPROVED', 'SENT', 'SENT_MANUALLY'].includes(o.status) && o.kind === 'first_touch')
      ? `<button class="btn btn-primary btn-sm" data-action="call" data-url="/api/leads/${esc(lead.id)}/outreach" data-success="已生成个性化私信草稿">生成个性化私信</button>`
      : '';
  const rendered = items
    .map((o) => {
      const q = queue.get(o.id);
      const editable = o.status === 'READY_FOR_REVIEW';
      const sendable = ['READY_FOR_REVIEW', 'APPROVED', 'FAILED'].includes(o.status);
      const fieldId = `msg-${o.id}`;
      const buttons: string[] = [];
      if (q?.copy_text) buttons.push(`<button class="btn btn-ghost btn-sm" data-action="copy" data-target="#${esc(fieldId)}">复制私信</button>`);
      if (editable) buttons.push(`<button class="btn btn-ink btn-sm" data-action="call" data-url="/api/outreach/${esc(o.id)}/approve" data-form="#wrap-${esc(o.id)}" data-success="已审核通过">审核通过</button>`);
      if (o.status === 'APPROVED' && sendAvailable) buttons.push(`<button class="btn btn-primary btn-sm" data-action="call" data-url="/api/outreach/${esc(o.id)}/send" data-success="已提交发送，结果以平台确认为准">通过平台发送</button>`);
      if (sendable) {
        buttons.push(
          `<button class="btn btn-primary btn-sm" data-action="call" data-url="/api/outreach/${esc(o.id)}/mark-sent" data-confirm="确认已由「${esc(q?.account.nickname ?? '负责账号')}」在小红书发出？再点一次" data-success="已登记为人工发送">${sendAvailable ? '我已在小红书发送' : '复制私信 · 我已在小红书发送'}</button>`,
        );
        buttons.push(`<button class="btn btn-danger btn-sm" data-action="call" data-url="/api/outreach/${esc(o.id)}/cancel" data-body="${dataBody({ reason: '运营取消' })}" data-confirm="确认取消这条私信？" data-success="已取消">取消</button>`);
      }
      const instructions = q?.manual_send_instructions?.length ? `<ol class="small" style="margin:8px 0 0;padding-left:18px">${q.manual_send_instructions.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : '';
      return `<div class="card stack" id="wrap-${esc(o.id)}" style="box-shadow:inset 0 0 0 1px var(--border)">
  <div class="row">${outreachStatusPill(o.status, sendAvailable)} ${pill(o.kind === 'first_touch' ? '首次触达' : '跟进', 'neutral')} <span class="small muted">${esc(q?.account.nickname ?? '')} · ${esc(fmtTime(o.created_at))}${o.sent_by ? ` · 发送人 ${esc(o.sent_by)}` : ''}</span></div>
  ${editable ? `<textarea id="${esc(fieldId)}" name="message" maxlength="1000">${esc(o.message)}</textarea>` : `<textarea id="${esc(fieldId)}" readonly>${esc(o.message)}</textarea>`}
  ${o.blocked_reason ? `<div class="banner banner-red" style="margin:0">${esc(o.blocked_reason)}</div>` : ''}
  ${o.personalization?.length ? `<div class="chips">${o.personalization.map((e) => `<span class="ev" title="${esc(e.quote ?? '')}">${esc(e.label)}</span>`).join('')}</div>` : ''}
  ${o.fact_refs?.length ? `<div class="small muted">引用门店事实：${o.fact_refs.map((fr) => esc(fr.claim)).join('、')}</div>` : ''}
  <details><summary class="small">发送前检查（${esc(o.guard_results?.length ?? 0)} 项）</summary>${guardList(o)}</details>
  ${instructions}
  <div class="row">${buttons.join('')}</div>
</div>`;
    })
    .join('');
  return `<div class="panel stack" id="outreach"><div class="row"><h2 class="panel-title" style="margin:0">私信</h2><span class="spacer"></span>${prepare}</div>${capNote}${rendered || '<p class="muted small">还没有私信。线索达到合格并分配负责账号后，可生成基于用户原话和门店真实信息的个性化私信。</p>'}</div>`;
}

export function leadDetailPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const detail = getLeadDetail(ctx, rc.params.id);
  const lead = detail.lead;
  const { dealers } = resolveDealer(ctx, rc);
  const dealer = dealers.find((x) => x.id === lead.dealer_id) ?? null;
  const tz = dealerTz(dealer);
  const nowMs = ctx.clock.now().getTime();
  const pending = dealer ? listOutreachQueue(ctx, { dealer_id: dealer.id, statuses: ['READY_FOR_REVIEW', 'APPROVED', 'FAILED', 'BLOCKED', 'SENT', 'SENT_MANUALLY'], limit: 500 }) : [];
  const queue = new Map(pending.filter((x) => x.lead.id === lead.id).map((x) => [x.outreach.id, x]));
  const latestScore = detail.scores[detail.scores.length - 1];
  const accounts = ctx.db.table('xhs_accounts').findMany({ dealer_id: lead.dealer_id }, { orderBy: 'created_at ASC' });
  const accountName = new Map(ctx.db.table('xhs_accounts').findMany({ group_id: lead.group_id }).map((a) => [a.id, a.nickname]));

  const header = `<div class="panel stack">
  <div class="lead-top"><span class="lead-score${lead.score >= 80 ? ' hot' : ''}">${esc(Math.round(lead.score))}</span>${tierPill(lead.tier)} ${leadStagePill(lead.stage)} ${dataModePill(lead.data_mode)} ${actorPill(lead.actor_type)} ${lead.suppressed ? pill('勿扰', 'red', lead.suppression_reason ?? '') : ''}
    <span class="lead-owner">${detail.assignment ? `负责账号：${esc(accountName.get(detail.assignment.account_id) ?? detail.assignment.account_id)}` : '<span class="muted">未分配</span>'}</span></div>
  <div class="primary">${esc(lead.username)} <span class="secondary mono">${esc(lead.platform_user_id)}</span> ${sourceLink(lead.profile_url, '查看主页')}</div>
  <div class="small"><b>下一步：</b>${esc(detail.card.next_action)}</div>
  ${intentKv(lead, detail)}
  <div class="chips">${lead.evidence.slice(0, 12).map((e) => `<span class="ev" title="${esc(e.quote ?? '')}">${esc(e.label)}</span>`).join('')}</div>
</div>`;

  const signals = detail.signals
    .map((s) => {
      const url = s.public_post?.url ?? null;
      return `<li><div class="row">${pill(SOURCE_LABEL[s.signal.source_type] ?? s.signal.source_type, 'neutral')} ${s.is_primary ? pill('主信号', 'coral-soft') : ''} ${actorPill(s.signal.actor_type)} ${pill(`信号分 ${Math.round(s.signal.signal_score)}`, s.signal.is_purchase_signal ? 'violet' : 'neutral')} ${s.public_post?.data_mode ? dataModePill(s.public_post.data_mode) : ''}<span class="spacer"></span><span class="tiny muted">${esc(fmtTime(s.signal.signal_at, tz))}</span></div>
  <div class="quote" style="margin-top:8px"><p>“${esc(s.signal.content)}”</p><small>${s.signal.post_title ? `《${esc(s.signal.post_title)}》 · ` : ''}${s.public_comment ? `评论ID ${esc(s.public_comment.platform_comment_id)} · ` : ''}${sourceLink(url)}</small></div>
  <div class="chips" style="margin-top:6px">${s.signal.evidence.slice(0, 8).map((e) => `<span class="ev" title="${esc(e.quote ?? '')}">${esc(e.label)}</span>`).join('')}</div></li>`;
    })
    .join('');

  const assignmentRows = detail.candidates.map((c) => [
    `<div class="primary" style="font-size:15px">${esc(c.nickname)}</div>${c.excluded_reason ? `<div class="secondary">${esc(c.excluded_reason)}</div>` : ''}`,
    `<span class="id-pill${detail.assignment?.account_id === c.account_id ? ' hot' : ''}">${esc(Math.round(c.score))}</span>`,
    c.eligible ? pill('可分配', 'green') : pill('不可分配', 'red'),
    `<details><summary class="small">评分因素</summary>${scoreBars(c.factors)}</details>`,
  ]);
  const reassign = `<div class="inline-form" id="reassign"><select name="reassign_to" aria-label="重新分配到">${accounts.map((a) => `<option value="${esc(a.id)}"${detail.assignment?.account_id === a.id ? ' selected' : ''}>${esc(a.nickname)}</option>`).join('')}</select><input type="text" name="reason" placeholder="原因（必填）" data-optional>
  <button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/leads/${esc(lead.id)}/assign" data-form="#reassign" data-success="已更新负责账号">重新分配</button>
  ${detail.assignment ? '' : `<button class="btn btn-ink btn-sm" data-action="call" data-url="/api/leads/${esc(lead.id)}/assign" data-success="已完成分配">自动分配</button>`}</div>`;

  const convo = detail.conversation;
  const thread = detail.messages
    .map((m) => {
      const inbound = m.direction === 'inbound';
      const draftActions =
        m.status === 'draft'
          ? `<div class="row" style="margin-top:8px" id="reply-${esc(m.id)}"><textarea name="text" id="reply-text-${esc(m.id)}">${esc(m.content)}</textarea>
  <button class="btn btn-ghost btn-sm" data-action="copy" data-target="#reply-text-${esc(m.id)}">复制</button>
  <button class="btn btn-ink btn-sm" data-action="call" data-url="/api/messages/${esc(m.id)}/approve" data-form="#reply-${esc(m.id)}" data-success="回复已审核">审核回复</button>
  <button class="btn btn-primary btn-sm" data-action="call" data-url="/api/messages/${esc(m.id)}/mark-sent" data-confirm="确认已在小红书发出？再点一次" data-success="已登记人工发送">我已在小红书发送</button></div>`
          : '';
      return `<div class="msg ${inbound ? 'msg-in' : 'msg-out'}">${m.status === 'draft' ? '' : esc(m.content)}${draftActions}<div class="msg-meta">${inbound ? '客户' : '我方'} · ${messageStatusPill(m.status)} · ${esc(fmtTime(m.created_at, tz))}${m.intents?.length ? ` · ${esc(m.intents.join('/'))}` : ''}${m.sent_by ? ` · ${esc(m.sent_by)}` : ''}</div></div>`;
    })
    .join('');
  const inboundForm = `<form class="stack" data-api="/api/leads/${esc(lead.id)}/inbound" data-success="已登记客户回复，AI 已分析意图"><label>录入客户在小红书中的回复<textarea name="content" required maxlength="5000" placeholder="粘贴客户在私信中的原话"></textarea></label><div class="row"><span class="small muted">由负责账号所在的小红书 App 查看私信后录入（系统无法读取私信收件箱）。</span><span class="spacer"></span><button class="btn btn-ink btn-sm" type="submit">登记回复</button></div></form>`;

  const appointments = detail.appointments.length
    ? detail.appointments
        .map(
          (a) => `<div class="row card" style="box-shadow:inset 0 0 0 1px var(--border)">${appointmentStatusPill(a.status)} <span>${esc(a.vehicle_interest)} · ${esc(a.store)}</span><span class="small muted">${esc(a.scheduled_for ? fmtTime(a.scheduled_for, tz) : a.time_text ?? '时间待定')}</span><span class="spacer"></span>
  ${a.status === 'proposed' ? `<button class="btn btn-ink btn-sm" data-action="call" data-url="/api/appointments/${esc(a.id)}/confirm" data-success="预约已确认">确认预约</button>` : ''}
  ${a.status === 'proposed' || a.status === 'confirmed' ? `<button class="btn btn-primary btn-sm" data-action="call" data-url="/api/appointments/${esc(a.id)}/visited" data-success="已登记到店">已到店</button><button class="btn btn-danger btn-sm" data-action="call" data-url="/api/appointments/${esc(a.id)}/no-show" data-confirm="确认未到店？" data-success="已登记未到店">未到店</button>` : ''}</div>`,
        )
        .join('')
    : '<p class="muted small">暂无预约。客户在对话中表达到店意向时会自动生成待确认预约。</p>';

  const actions = `<div class="panel stack"><h2 class="panel-title">线索操作</h2>
  <div class="row"><button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/leads/${esc(lead.id)}/research" data-success="已完成公开主页研究">研究公开主页</button>
  <button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/leads/${esc(lead.id)}/qualify" data-success="已更新销售资格">判断销售资格</button></div>
  <div class="inline-form" id="won-form"><input type="number" name="amount" placeholder="成交金额（元）" min="0" data-optional><button class="btn btn-primary btn-sm" data-action="call" data-url="/api/leads/${esc(lead.id)}/won" data-form="#won-form" data-confirm="确认登记成交？" data-success="已登记成交">登记成交</button></div>
  <div class="inline-form" id="lost-form"><input type="text" name="reason" placeholder="流失原因"><button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/leads/${esc(lead.id)}/lost" data-form="#lost-form" data-confirm="确认标记流失？" data-success="已标记流失">标记流失</button></div>
  <div class="inline-form" id="dnc-form"><input type="text" name="reason" placeholder="勿扰原因，如：用户要求不再联系"><button class="btn btn-danger btn-sm" data-action="call" data-url="/api/leads/${esc(lead.id)}/suppress" data-form="#dnc-form" data-confirm="加入全局勿扰后所有账号都不会再联系此人，确认？" data-success="已加入全局勿扰">加入勿扰</button></div>
  ${lead.stage === 'LOST' && !lead.suppressed ? `<div class="inline-form" id="reopen-form"><input type="hidden" name="to" value="QUALIFIED"><input type="text" name="reason" placeholder="重新打开原因"><button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/leads/${esc(lead.id)}/reopen" data-form="#reopen-form" data-success="线索已重新打开">重新打开</button></div>` : ''}
</div>`;

  const transitions = detail.transitions.map((t) => `<li>${t.from_stage ? `${leadStagePill(t.from_stage)} → ` : ''}${leadStagePill(t.to_stage)} <span class="small">${esc(t.reason)}</span> <span class="tiny muted">${esc(t.actor)} · ${esc(fmtTime(t.at, tz))}</span></li>`).join('');
  const decisions = detail.decisions
    .slice(-30)
    .reverse()
    .map((x) => `<li><b class="small">${esc(x.decision_type)}</b> <span class="tiny muted">${esc(x.agent)} · 置信度 ${esc(Math.round(x.confidence * 100))}% · ${esc(ago(x.created_at, nowMs))}</span><div class="tiny muted">${esc(JSON.stringify(x.output).slice(0, 240))}</div></li>`)
    .join('');

  const body = `<div class="detail-grid">
  <div class="stack">
    ${header}
    <div class="panel"><h2 class="panel-title">原始信号（${esc(detail.signals.length)}）</h2><ul class="timeline">${signals || '<li class="muted">无信号</li>'}</ul></div>
    ${outreachPanel(ctx, env, detail, queue)}
    <div class="panel stack" id="conversation"><h2 class="panel-title">对话${convo?.needs_human ? ` ${pill('需要人工接管', 'amber', convo.handoff_reason ?? '')}` : ''}</h2>${thread ? `<div class="thread">${thread}</div>` : '<p class="muted small">还没有对话记录。</p>'}${inboundForm}</div>
    <div class="panel stack"><h2 class="panel-title">到店预约</h2>${appointments}</div>
  </div>
  <div class="stack">
    <div class="panel"><h2 class="panel-title">评分依据</h2>${latestScore ? `<p class="small muted">评分 ${esc(Math.round(latestScore.score))} · 配置 v${esc(latestScore.config_version)} · ${esc(fmtTime(latestScore.computed_at, tz))}</p>${scoreBars(latestScore.components)}` : '<p class="muted small">暂无评分</p>'}</div>
    <div class="panel"><h2 class="panel-title">账号分配</h2>${table(['账号', '得分', '资格', '因素'], assignmentRows, { compact: true, empty: '尚未计算分配排名' })}${reassign}</div>
    ${actions}
    <div class="panel"><h2 class="panel-title">漏斗记录</h2><ul class="timeline">${transitions || '<li class="muted">无</li>'}</ul></div>
    <div class="panel"><details><summary class="panel-title" style="cursor:pointer">AI 决策记录（${esc(detail.decisions.length)}）</summary><ul class="timeline">${decisions}</ul></details></div>
  </div>
</div>`;
  return renderPage(env, rc, {
    title: `线索 ${lead.username}`,
    active: 'leads',
    dealer,
    dealers,
    h1: `${esc(lead.username)} <span class="grad">${esc(Math.round(lead.score))}</span>`,
    subtitle: `${detail.dealer.name} · ${detail.card.model_label} · ${detail.card.location_label} · 首次发现 ${fmtTime(lead.first_seen_at, tz)}`,
    body,
  });
}
