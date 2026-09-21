/** 今日: Steer hero (real counts, command bar), needs-you bento, pipeline, account fleet, goals, briefing, activity rail. */
import type { AppContext } from '../../app/context.ts';
import type { AgentDecision, Dealer, LeadStage, OperatorGoal, WorkflowRun } from '../../core/types.ts';
import { localDateKey } from '../../core/time.ts';
import { getBrandInfo } from '../../domain/automotive-lexicon.ts';
import { getSetupStatus } from '../../operator/onboarding.ts';
import { getAccountSessions } from '../../skills/operations/account-sessions/index.ts';
import { getDashboard, getFunnel, getLeadInbox } from '../../skills/operations/analytics/index.ts';
import { enteredStageSql } from '../../skills/operations/analytics/filters.ts';
import { getLatestReport } from '../../skills/operations/reporting/index.ts';
import type { Reply, RequestContext } from '../http.ts';
import { xhsImageSrc } from '../api/media.ts';
import {
  ACCOUNT_TYPE,
  ICON,
  ago,
  cny,
  emptyState,
  esc,
  fmtTime,
  href,
  iconSvg,
  markSvg,
  pad2,
  pct,
  pill,
  sectionHead,
  stat,
  table,
  unfinishedButton,
  unfinishedTag,
  previewText,
  workflowStatusPill,
} from '../render.ts';
import { hint } from '../hint.ts';
import { scrubInternals } from '../humanize.ts';

import { decisionText, decisionTitle } from './decision-view.ts';
import { setupSteps } from './setup.ts';
import { agentStatus, dateLabel, dealerTz, noDealerBody, renderPage, resolveDealer, type PageEnv } from './shell.ts';


const SEVERITY_TONE = { high: 'red', medium: 'amber', low: 'neutral' } as const;
const SEVERITY_LABEL = { high: '紧急', medium: '待处理', low: '提醒' } as const;

/** A store reads 「北京时间」, never an IANA zone id. Anything unmapped keeps its own name rather than lying. */
const TZ_LABEL: Record<string, string> = {
  'Asia/Shanghai': '北京时间',
  'Asia/Chongqing': '北京时间',
  'Asia/Hong_Kong': '香港时间',
  'Asia/Taipei': '台北时间',
  'Asia/Urumqi': '新疆时间',
};
const tzLabel = (tz: string): string => TZ_LABEL[tz] ?? tz;

/** A scrubbed English state leaves a dangling separator behind: 「账号健康（，健康分100）」. */
const tidy = (text: string): string => text.replace(/[（(]\s*[，,、]\s*/g, '（');

/** 车型名里的英文品牌一律显示中文：`XPeng G6` → `小鹏 G6`。 */
function zhModelLabel(label: string): string {
  const s = String(label ?? '').trim();
  if (!s) return label;
  const head = s.split(' ')[0] ?? '';
  const zh = getBrandInfo(head)?.brand_zh;
  if (!zh) return label;
  const rest = s.slice(head.length).trim();
  return rest ? `${zh} ${rest}` : zh;
}

export function dealerDecisions(ctx: AppContext, dealerId: string, limit = 8): AgentDecision[] {
  const rows = ctx.db.all(
    `SELECT * FROM agent_decisions d WHERE
       (d.subject_type = 'lead' AND d.subject_id IN (SELECT id FROM leads WHERE dealer_id = ?))
       OR (d.subject_type = 'goal' AND d.subject_id IN (SELECT id FROM operator_goals WHERE dealer_id = ?))
       OR (d.subject_type = 'post' AND d.subject_id IN (SELECT id FROM posts WHERE dealer_id = ?))
       OR (d.subject_type = 'outreach' AND d.subject_id IN (SELECT o.id FROM outreach o JOIN leads l ON l.id = o.lead_id WHERE l.dealer_id = ?))
       OR (d.workflow_run_id IN (SELECT id FROM workflow_runs WHERE dealer_id = ?))
     ORDER BY d.created_at DESC LIMIT ${Math.max(1, Math.min(100, limit))}`,
    dealerId,
    dealerId,
    dealerId,
    dealerId,
    dealerId,
  );
  return rows.map((r) => ctx.db.table('agent_decisions').decode(r));
}

/** Exceptions whose link target does not apply the filter yet (UNFINISHED.exception_filters). */
const UNFILTERED_EXCEPTION_LINKS = new Set([
  'outreach_review',
  'outreach_manual_send',
  'outreach_blocked',
  'posts_in_review',
  'reply_drafts',
  'engagement_replies_review',
  'qualified_unassigned',
  'workflow_failed',
]);

function goalRows(ctx: AppContext, dealer: Dealer): string[][] {
  const goals: OperatorGoal[] = ctx.db.table('operator_goals').findMany({ dealer_id: dealer.id }, { orderBy: 'created_at DESC', limit: 5 });
  const nowMs = ctx.clock.now().getTime();
  return goals.map((g) => {
    const run: WorkflowRun | undefined = ctx.db.table('workflow_runs').findOne({ goal_id: g.id }, { orderBy: 'started_at DESC' });
    const models = g.spec.models.length ? g.spec.models.join('、') : '全部在售车型';
    return [
      `<div class="primary" style="font-size:15px">${esc(g.text)}</div><div class="secondary">${esc(models)}${g.spec.location ? ` · ${esc(g.spec.location)}` : ''}${g.spec.timeframe ? ` · ${esc(g.spec.timeframe.label)}` : ''}</div>`,
      pill(g.status === 'active' ? '进行中' : g.status === 'completed' ? '已完成' : g.status === 'paused' ? '已暂停' : '失败', g.status === 'active' ? 'violet' : g.status === 'completed' ? 'green' : g.status === 'failed' ? 'red' : 'neutral'),
      run ? `${workflowStatusPill(run.status)} <a class="link small" href="${esc(href(`/system/runs/${run.id}`, { dealer: dealer.id }))}">任务详情</a>` : '<span class="muted small">未启动</span>',
      `<span class="small muted">${esc(ago(g.created_at, nowMs))}</span>`,
      unfinishedButton('goal_pause', '暂停 / 恢复'),
    ];
  });
}

export function overviewPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const { dealer, dealers } = resolveDealer(ctx, rc);
  if (!dealer) {
    return renderPage(env, rc, { title: '今日', active: 'overview', dealer: null, dealers, h1: '今日', subtitle: '尚未配置门店', body: noDealerBody() });
  }
  const d = getDashboard(ctx, { dealer_id: dealer.id });
  const funnel = getFunnel(ctx, { dealer_id: dealer.id });
  const nowIso = ctx.clock.iso();
  const nowMs = ctx.clock.now().getTime();
  const tz = dealerTz(dealer);
  const today = localDateKey(ctx.clock.now(), tz);
  const exceptionsTotal = d.exceptions.reduce((s, e) => s + e.count, 0);
  const exceptionCount = (kind: string) => d.exceptions.find((e) => e.kind === kind)?.count ?? 0;
  const decisions = dealerDecisions(ctx, dealer.id, 8);
  const report = getLatestReport(ctx, dealer.id);
  const running = agentStatus(ctx, dealer.id).running;

  /**
   * A to-do list, not a data table. A table gave this four columns for two facts: the count went into a bordered box,
   * the severity column repeated what the row already said, and the action was a play triangle in a square. One row,
   * one job: how many, what, and go.
   */
  const exceptionList = d.exceptions
    .map(
      (e) =>
        `<a class="todo${e.severity === 'high' ? ' is-urgent' : ''}" href="${esc(e.href)}">
  <span class="todo-n st-num">${esc(e.count)}</span>
  <span class="todo-title">${esc(e.title)}${UNFILTERED_EXCEPTION_LINKS.has(e.kind) ? unfinishedTag('exception_filters') : ''}</span>
  <span class="todo-go">去处理${ICON.chevron}</span>
</a>`,
    )
    .join('');

  const setup = getSetupStatus(ctx, dealer.id);
  // Examples are built only from this store's own data (its city and cheapest model, else its first brand).
  const dealerBrands = new Set(dealer.brands.map((b) => b.toLowerCase()));
  const exampleVehicle = ctx.db
    .table('vehicles')
    .findMany({ group_id: dealer.group_id }, { orderBy: 'msrp ASC', limit: 50 })
    .find((x) => dealerBrands.has(x.brand.toLowerCase()) || dealerBrands.has(x.brand_zh.toLowerCase()));
  const exampleTarget = exampleVehicle
    ? exampleVehicle.brand_zh === exampleVehicle.model_zh
      ? exampleVehicle.model_zh
      : `${exampleVehicle.brand_zh}${exampleVehicle.model_zh}`
    : (dealer.brands.map((b) => getBrandInfo(b)?.brand_zh ?? b)[0] ?? '');
  const sessions = getAccountSessions(ctx, dealer.id);

  // Leads that reached 合格 today but were later rejected — dealer / sales accounts, or closed by the LLM screen /
  // lead research — are not buyers to work: today's counts and the lead tile leave them out, the funnel stats keep them.
  const sellerMoves = ctx.db.get<{ qualified: number; high_intent: number }>(
    `SELECT COUNT(DISTINCT CASE WHEN ${enteredStageSql('QUALIFIED', 't')} THEN t.lead_id END) AS qualified,
            COUNT(DISTINCT CASE WHEN ${enteredStageSql('QUALIFIED', 't')} AND l.tier IN ('high_intent', 'immediate') THEN t.lead_id END) AS high_intent
     FROM lead_stage_transitions t JOIN leads l ON l.id = t.lead_id
     WHERE l.dealer_id = ? AND (l.actor_type = 'DEALER_OR_SALES' OR l.stage = 'LOST') AND t.at >= ? AND t.at < ?`,
    dealer.id,
    d.period.from,
    d.period.to,
  );
  const excludedSellers = Number(sellerMoves?.qualified ?? 0);
  const buyersToday = Math.max(0, d.discovery.qualified - excludedSellers);
  const highIntentToday = Math.max(0, d.discovery.high_intent - Number(sellerMoves?.high_intent ?? 0));
  // The page says the short fact; why those people were left out lives behind the 「?」 (it used to repeat three times).
  const sellersNote = excludedSellers > 0 ? `（已排除 <span class="st-num">${esc(excludedSellers)}</span> 位）` : '';
  const sellersHelp = excludedSellers > 0 ? `另有 ${excludedSellers} 位核实下来不是本地要买车的人（门店号、销售号，或者不在你们做生意的地方），今天的人数里没有算他们。` : '';
  const sellerIds = new Set(
    ctx.db.all<{ id: string }>("SELECT id FROM leads WHERE dealer_id = ? AND actor_type = 'DEALER_OR_SALES'", dealer.id).map((r) => r.id),
  );
  /** open buyer leads only: closed leads and dealer / sales accounts never show up as today's buyers */
  const buyerLeads = (limit: number) =>
    getLeadInbox(ctx, { dealer_id: dealer.id, limit: 50 })
      .filter((l) => l.stage !== 'LOST' && l.stage !== 'WON' && !sellerIds.has(l.lead_id))
      .slice(0, limit);

  // ── hero: real counts of today's work ──────────────────────────────────────
  const read = d.discovery.posts_scanned + d.discovery.comments_scanned;
  const lede =
    read > 0
      ? `今天读了 <span class="st-num">${esc(read)}</span> 条公开笔记和评论，看过 <span class="st-num">${esc(d.discovery.users_evaluated)}</span> 位用户，找到 <span class="st-num">${esc(buyersToday)}</span> 位像要买车的人${sellersNote}。${exceptionsTotal > 0 ? `其中有 <span class="st-num">${esc(exceptionsTotal)}</span> 件事需要你处理。` : ''}${hint(['「像要买车的人」是指本人在公开内容里问价格、问现车、问提车，并且在你们做生意的地方。', sellersHelp].filter(Boolean))}`
      : `今天还没有读取公开内容。${exceptionsTotal > 0 ? `有 <span class="st-num">${esc(exceptionsTotal)}</span> 件事需要你处理。` : ''}${hint('给它派一个活，它就会开始在公开笔记和评论里找买车的人。')}`;
  // Today's discovery, as a ruled strip of real counts: what it read, who it looked at, who looks like a buyer.
  const stage = (n: number, label: string, final = false) =>
    `<div class="funnel-step${final ? ' is-final' : ''}"><span class="num">${esc(n)}</span><span class="tiny muted">${esc(label)}</span></div>`;
  const stages = `<div class="funnel">${stage(read, '读了公开内容')}${stage(d.discovery.users_evaluated, '看过的人')}${stage(buyersToday, '像要买车的人')}${stage(highIntentToday, '高意向')}${stage(d.outreach.outreach_ready, '私信草稿等你发', true)}</div>`;
  // Every chip is a goal this store can actually hand over — all of them about finding buyers, never a report request.
  const suggestions = [
    exampleTarget ? `这个月在${dealer.city}获取${exampleTarget}线索` : `这个月在${dealer.city}获取线索`,
    sessions[0] ? `下周为${sessions[0].platform_profile?.nickname ?? sessions[0].nickname}排 3 篇笔记` : null,
    `本周在${dealer.city}找 20 位高意向买家`,
  ].filter((x): x is string => Boolean(x));
  const command = setup.ready
    ? `<div class="st-command"><form data-api="/api/goals" data-success="目标已交给 Steer，可在经营目标里查看进度">
  <input type="hidden" name="dealer_id" value="${esc(dealer.id)}">
  <label class="st-label" for="st-command-input">给它派活</label>
  <div class="st-command-box">${markSvg()}<input class="st-command-input" id="st-command-input" name="text" required minlength="2" maxlength="500" autocomplete="off" placeholder="${esc(`例如：${suggestions[0]}`)}"><button class="btn btn-primary btn-lg" type="submit"><span class="st-command-btn-label">交给 Steer</span>${iconSvg('enter')}</button></div>
  <div class="st-suggest">${suggestions.map((x) => `<button class="st-chip" type="button" data-action="suggest" data-target="#st-command-input">${esc(x)}</button>`).join('')}</div>
</form></div>`
    : `<div class="st-command"><p class="st-label">给它派活</p><p class="small muted" style="margin:6px 0 10px">完成设置后才能派活：${esc(setup.blocker ?? '')}</p><a class="btn btn-primary btn-sm" href="${esc(href('/accounts', { dealer: dealer.id }))}#add-account">去添加账号 / 扫码登录</a></div>`;
  // The first thing on the page is the work, not a greeting: what waits for a person, then what happened today.
  const queue = `<section class="st-section" id="exceptions" aria-labelledby="needs-title">
  <div class="section-head"><h2 class="section-title" id="needs-title">${exceptionsTotal > 0 ? `今天要你处理 <span class="st-num">${esc(exceptionsTotal)}</span> 件事` : '今天没有要你处理的事'}</h2><span class="muted small">其余的 Steer 会继续做</span></div>
  ${exceptionList ? `<div class="todo-list">${exceptionList}</div>` : emptyState('该你点头的事都处理完了。新的会出现在这里，也会在左边「今日」上标红点。')}
</section>`;
  const progress = `<section class="st-section">
  <div class="section-head"><h2 class="section-title">今天的进展</h2></div>
  <div class="st-lede">${lede}</div>
  ${stages}
</section>`;

  // ── what is on the store's plate right now ─────────────────────────────────
  // Four identical boxes said four unrelated things at the same volume. The people are the substance, so they get the
  // column; the three one-number facts sit beside them as a ruled stack, on the page rather than in boxes of their own.
  const leads = buyerLeads(5);
  const leadTile = `<div class="now-main">
  <div class="now-head"><h3 class="now-title">今天找到的人</h3><span class="now-n st-num">${esc(buyersToday)}</span><span class="now-note">其中 <b class="st-num">${esc(highIntentToday)}</b> 位高意向${sellersNote}${hint(['下面是还在跟进的人，按购车意向从高到低排。', sellersHelp].filter(Boolean))}</span><a class="st-link" href="${esc(href('/leads', { dealer: dealer.id }))}">全部线索</a></div>
  ${
    leads.length
      ? `<div class="now-leads">${leads
          .map(
            (l) => `<a class="st-mini-lead" href="${esc(href(`/leads/${l.lead_id}`, { dealer: dealer.id }))}"><span class="st-mini-score st-num">${esc(Math.round(l.score))}<small>购车意向</small></span><span class="st-mini-body"><span class="st-mini-line"><strong>${esc(l.username)}</strong><span>${esc(zhModelLabel(l.model_label))}</span><span>${esc(l.location_label)}</span></span><span class="st-mini-quote">${l.original_signal ? esc(previewText(l.original_signal)) : ''}</span></span></a>`,
          )
          .join('')}</div>`
      : `<div class="st-empty-inline">还没有线索。${hint('给它派一个获客的活，它找到的人会按购车意向排在这里。')}</div>`
  }
</div>`;
  const repliesWaiting = exceptionCount('conversations_needs_human') + exceptionCount('reply_drafts');
  const lastInbound = ctx.db.get<{ content: string; created_at: string; username: string }>(
    `SELECT m.content, m.created_at, l.username FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id JOIN leads l ON l.id = c.lead_id
     WHERE l.dealer_id = ? AND m.direction = 'inbound' ORDER BY m.created_at DESC LIMIT 1`,
    dealer.id,
  );
  const replyTile = `<a class="fact" href="${esc(href('/conversations', { dealer: dealer.id }))}">
  <span class="fact-head"><span class="fact-label">待处理回复</span><span class="fact-n st-num">${esc(repliesWaiting)}</span></span>
  ${lastInbound ? `<span class="fact-body">“${esc(previewText(clip(lastInbound.content, 52)))}”<span class="fact-meta">${esc(lastInbound.username)} · ${esc(ago(lastInbound.created_at, nowMs))}</span></span>` : '<span class="fact-body fact-quiet">还没有客户回复</span>'}
</a>`;
  const todayPosts = ctx.db.all<{ status: string }>("SELECT status FROM posts WHERE dealer_id = ? AND slot_date = ? AND status <> 'REJECTED'", dealer.id, today);
  const postBucket = (s: string) => (s === 'PUBLISHED' ? 'done' : s === 'IN_REVIEW' || s === 'READY_TO_PUBLISH' || s === 'APPROVED' || s === 'SCHEDULED' ? 'review' : 'draft');
  const buckets = { done: 0, review: 0, draft: 0 };
  for (const p of todayPosts) buckets[postBucket(p.status)]++;
  const contentTile = `<a class="fact" href="${esc(href('/content', { dealer: dealer.id }))}">
  <span class="fact-head"><span class="fact-label">今日笔记</span><span class="fact-n st-num">${esc(todayPosts.length)}</span></span>
  ${
    todayPosts.length
      ? `<span class="st-segs" aria-hidden="true">${todayPosts.map((p) => `<span class="st-seg st-seg-${postBucket(p.status)}"></span>`).join('')}</span><span class="fact-meta">已发布 ${buckets.done} · 等你看 ${buckets.review} · 草稿 ${buckets.draft}</span>`
      : '<span class="fact-body fact-quiet">今天没有排期的笔记</span>'
  }
</a>`;
  const nextAppt = ctx.db.get<{ scheduled_for: string | null; time_text: string | null; store: string; vehicle_interest: string; username: string }>(
    `SELECT a.scheduled_for, a.time_text, a.store, a.vehicle_interest, l.username FROM appointments a JOIN leads l ON l.id = a.lead_id
     WHERE a.dealer_id = ? AND a.status IN ('proposed', 'confirmed') AND (a.scheduled_for IS NULL OR a.scheduled_for >= ?) ORDER BY a.scheduled_for IS NULL, a.scheduled_for LIMIT 1`,
    dealer.id,
    nowIso,
  );
  const apptTile = `<div class="fact">
  <span class="fact-head"><span class="fact-label">今天预约 / 成交</span><span class="fact-n st-num">${esc(d.sales.appointments)}<span class="fact-n-sep">/</span>${esc(d.sales.won)}</span></span>
  <span class="fact-body${nextAppt ? '' : ' fact-quiet'}">${nextAppt ? `下一个 ${esc(nextAppt.scheduled_for ? fmtTime(nextAppt.scheduled_for, tz) : (nextAppt.time_text ?? '时间待定'))}<span class="fact-meta">${esc(nextAppt.username)} · ${esc(nextAppt.vehicle_interest)}</span>` : '还没有待到店的预约'}</span>
</div>`;

  // ── pipeline (cumulative reach per stage) ───────────────────────────────────
  const PIPE: [LeadStage, string][] = [
    ['DISCOVERED', '发现'],
    ['QUALIFIED', '合格'],
    ['CONTACTED', '已联系'],
    ['REPLIED', '有回复'],
    ['APPOINTMENT', '预约'],
    ['VISITED', '到店'],
    ['WON', '成交'],
  ];
  const pipeline = `<div class="st-pipeline">${PIPE.map(([s, label]) => {
    const f = funnel.find((x) => x.stage === s);
    return `<div class="st-pipe${s === 'WON' ? ' is-won' : ''}"><span class="st-pipe-label">${esc(label)}</span><span class="st-pipe-num st-num">${esc(f?.reached ?? 0)}</span><span class="st-pipe-delta">当前 ${esc(f?.count ?? 0)}</span></div>`;
  }).join('')}</div>`;

  // ── account fleet ───────────────────────────────────────────────────────────
  const pendingByAccount = new Map<string, number>(
    ctx.db
      .all<{ account_id: string; n: number }>(
        "SELECT o.account_id, COUNT(*) AS n FROM outreach o JOIN leads l ON l.id = o.lead_id WHERE l.dealer_id = ? AND o.status IN ('READY_FOR_REVIEW', 'APPROVED') GROUP BY o.account_id",
        dealer.id,
      )
      .map((r) => [r.account_id, Number(r.n)]),
  );
  const postsTodayByAccount = new Map<string, number>(
    ctx.db
      .all<{ account_id: string; n: number }>("SELECT account_id, COUNT(*) AS n FROM posts WHERE dealer_id = ? AND slot_date = ? AND status <> 'REJECTED' GROUP BY account_id", dealer.id, today)
      .map((r) => [r.account_id, Number(r.n)]),
  );
  const fleet = sessions.length
    ? `<div class="st-fleet">${sessions
        .map((sn) => {
          const name = sn.platform_profile?.nickname ?? sn.nickname;
          const avatarSrc = xhsImageSrc(sn.platform_profile?.avatar_url);
          const [dot, state] = !sn.auth_checked_at
            ? ['st-dot-idle', '登录未检测']
            : sn.auth_state === 'authenticated'
              ? ['st-dot-ok', '已登录']
              : sn.auth_state === 'requires_auth'
                ? ['st-dot-warn', '需要扫码登录']
                : ['st-dot-idle', '登录状态未知'];
          const pending = pendingByAccount.get(sn.account_id) ?? 0;
          const posts = postsTodayByAccount.get(sn.account_id) ?? 0;
          const task = pending || posts ? `${pending ? `<b>${esc(pending)} 条私信</b>等你发送` : ''}${pending && posts ? '，' : ''}${posts ? `今日 <b>${esc(posts)} 篇笔记</b>` : ''}` : '今天没有待办';
          return `<a class="st-card st-fleet-item is-interactive" href="${esc(href('/accounts', { dealer: dealer.id }))}"><div class="st-fleet-top"><span class="st-avatar">${esc(Array.from(name)[0] ?? '号')}${avatarSrc ? `<img src="${esc(avatarSrc)}" alt="" loading="lazy">` : ''}<span class="st-dot ${dot}"></span></span><div><div class="st-fleet-name">${esc(name)}</div><div class="st-fleet-role">${esc(ACCOUNT_TYPE[sn.account_type])}</div></div></div><div class="st-fleet-state">${esc(state)}</div><p class="st-fleet-task">${task}</p></a>`;
        })
        .join('')}</div>`
    : emptyState('还没有小红书账号。');

  // ── Steer activity rail (real decisions) ────────────────────────────────────
  const activity = decisions.length
    ? `<ul class="activity">${decisions
        .map((x) => `<li><span class="act-time">${esc(ago(x.created_at, nowMs))}</span><div class="act-title">${esc(decisionTitle(x.decision_type))}</div>${decisionText(x) ? `<div class="act-desc">${esc(clip(tidy(scrubInternals(decisionText(x))), 90))}</div>` : ''}</li>`)
        .join('')}</ul>`
    : `<div class="st-help" style="padding:4px 0 12px">它还没有做过判断。${hint('给它派个活，或者等每天的例行任务跑起来，这里会按时间列出每一步的判断和依据。')}</div>`;
  const rail = `<aside class="rail" aria-label="Steer 动态"><div class="rail-card"><div class="rail-head"><span class="st-dot st-dot-ai${running ? ' is-running' : ''}" aria-hidden="true"></span><h2>Steer 动态</h2><span class="live">${running ? '运行中' : '最近'}</span></div>${activity}<a class="btn-muted" href="${esc(href('/system', { dealer: dealer.id }))}#decisions">查看全部动态</a></div>
  <div class="rail-note">私信不会自动发出去。${hint('每条私信都由负责这条线索的销售本人在小红书里发，发完回到线索详情页点一下登记。')}</div></aside>`;

  const group = (title: string, stats: string) => `<div class="stat-group-title">${esc(title)}</div><div class="stat-grid">${stats}</div>`;
  const statGroups = [
    group('内容', stat('已发布', d.content.posts_published) + stat('计划内容', d.content.posts_planned) + stat('待审批', d.content.posts_pending_approval) + stat('浏览量', ctx.xhs.mode === 'live' ? '小红书不公开' : d.content.views) + stat('互动', d.content.engagement)),
    group('发现', stat('扫描笔记', d.discovery.posts_scanned) + stat('扫描评论', d.discovery.comments_scanned) + stat('评估用户', d.discovery.users_evaluated) + stat('候选线索', d.discovery.candidates) + stat('合格线索', d.discovery.qualified) + stat('高意向', d.discovery.high_intent)),
    group('触达', stat('私信待处理', d.outreach.outreach_ready) + stat('已触达', d.outreach.contacted) + stat('收到回复', d.outreach.replies) + stat('回复率', pct(d.outreach.reply_rate))),
    group('销售', stat('销售合格', d.sales.sales_qualified) + stat('获得联系方式', d.sales.contacts_acquired) + stat('新增预约', d.sales.appointments) + stat('到店', d.sales.visits) + stat('成交', d.sales.won) + stat('流失', d.sales.lost)),
    group('账号', stat('活跃账号', d.accounts.active) + stat('健康账号', d.accounts.healthy) + stat('需要关注', d.accounts.requiring_attention.length)),
  ].join('');

  const body = `<div class="today"><div class="today-main">
${setup.ready ? '' : setupSteps(setup, dealer.id)}
${queue}
${progress}
<section class="st-section">
  <div class="section-head"><h2 class="section-title">现在的情况</h2></div>
  <div class="now">${leadTile}<div class="now-side">${replyTile}${contentTile}${apptTile}</div></div>
</section>
<section class="st-section">
  <div class="section-head"><h2 class="section-title">给它派活</h2><span class="muted small">用一句话说你要什么，它自己拆成每天的任务</span></div>
  ${command}
</section>
<section class="st-section">
  <div class="section-head"><h2 class="section-title">客户进度${hint(['大数字是到今天为止一共走到这一步的人数，小字是现在还停在这一步的人数。', '「这些客户预计能卖多少钱」是按每个人现在走到哪一步估的，不是已经收到的钱。'])}</h2><span class="muted small">这些客户预计能卖多少钱：${esc(cny(d.pipeline.estimated_value))}</span><a class="st-link" href="${esc(href('/leads', { dealer: dealer.id }))}">打开线索</a></div>
  ${pipeline}
</section>
<section class="st-section">
  <div class="section-head"><h2 class="section-title">你们的小红书号</h2><span class="muted small">${esc(sessions.length)} 个账号，各自独立登录</span><a class="st-link" href="${esc(href('/accounts', { dealer: dealer.id }))}">管理账号</a></div>
  ${fleet}
</section>
<section class="st-section">
  <div class="section-head"><h2 class="section-title">经营目标</h2></div>
  ${table(['目标', '状态', '执行', '时间', '操作'], goalRows(ctx, dealer), { compact: true, empty: '还没有下达经营目标' })}
</section>
<section class="st-section">
  <div class="section-head"><h2 class="section-title">今日简报${hint(`下面的数字只统计今天（${tzLabel(d.period.timezone)}）：从 ${d.period.from.slice(0, 16).replace('T', ' ')} 起。`)}</h2>${unfinishedButton('dashboard_filters', '筛选：账号 · 车型 · 地区 · 日期')}</div>
  ${d.briefing.length ? `<ul class="briefing">${d.briefing.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : emptyState('今日暂无运营数据')}
  ${report ? `<p class="small muted">最新运营日报：${esc(report.date)} · <a class="link" href="${esc(href('/intel', { dealer: dealer.id }))}#report">查看</a></p>` : ''}
  <div>${statGroups}</div>
</section>
<div class="footnote">页面上的数字都是打开这一刻实时算出来的。${hint(['私信一律由销售本人在小红书里发出去，再回来登记——小红书没有开放给门店用的发私信接口。', '没有在小红书里看到的私信，系统不会标成「已发送」。'])}</div>
</div>${rail}</div>`;

  return renderPage(env, rc, {
    title: '今日',
    active: 'overview',
    dealer,
    dealers,
    exceptions: exceptionsTotal,
    h1: '今日',
    help: [
      '打开就干活：最上面是今天要你点头的事，处理完这一页就没你的事了。',
      '下面是它今天替你做了什么——读了多少公开内容、看过多少人、找到几个像要买车的。',
      '私信一律由销售本人在小红书里发，发完回来登记一下。',
    ],
    subtitle: `${dateLabel(nowIso, tz)} · ${dealer.name}`,
    body,
  });
}

const clip = (text: string, max: number): string => {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
};

