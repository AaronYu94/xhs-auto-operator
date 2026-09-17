/** 总览: TODAY dashboard — KPIs, exceptions that need a human, goal input, AI employee activity, funnel, stat groups. */
import type { AppContext } from '../../app/context.ts';
import type { AgentDecision, Dealer, OperatorGoal, WorkflowRun } from '../../core/types.ts';
import { getBrandInfo } from '../../domain/automotive-lexicon.ts';
import { getSetupStatus } from '../../operator/onboarding.ts';
import { getDashboard, getFunnel } from '../../skills/operations/analytics/index.ts';
import { getLatestReport } from '../../skills/operations/reporting/index.ts';
import type { Reply, RequestContext } from '../http.ts';
import {
  ICON,
  LEAD_STAGE,
  ago,
  cny,
  emptyState,
  esc,
  href,
  kpiCard,
  pad2,
  pct,
  pill,
  sectionHead,
  stat,
  table,
  workflowStatusPill,
} from '../render.ts';
import { setupSteps } from './setup.ts';
import { dateLabel, dealerTz, noDealerBody, renderPage, resolveDealer, type PageEnv } from './shell.ts';

const DECISION_TITLE: Record<string, string> = {
  lead_prefilter: '初筛公开内容',
  intent_detection: '识别购车意图',
  lead_qualification: '线索达到合格',
  lead_score: '更新线索评分',
  lead_dedup_merge: '合并同一用户的信号',
  account_assignment: '分配负责账号',
  outreach_generation: '生成个性化私信',
  outreach_guard: '私信发送前检查',
  conversation_reply: '起草对话回复',
  sales_qualification: '销售资格判断',
  appointment: '到店预约',
  content_strategy: '制定账号内容策略',
  content_plan: '生成内容计划',
  content_generation: '撰写笔记',
  content_fact_review: '事实核查',
  content_duplicate_review: '内容查重',
  query_generation: '生成搜索词',
  query_optimization: '优化搜索词',
  goal_planning: '拆解经营目标',
  account_health: '账号健康检查',
  optimization: '策略优化建议',
  research: '市场与竞品研究',
  engagement_reply: '起草评论回复',
  report: '生成运营简报',
  lead_research: '研究线索公开主页',
};

const SEVERITY_TONE = { high: 'red', medium: 'amber', low: 'neutral' } as const;
const SEVERITY_LABEL = { high: '紧急', medium: '待处理', low: '提醒' } as const;

function decisionKind(d: AgentDecision): 'ai' | 'alert' | 'win' {
  const out = d.output ?? {};
  const status = typeof out.status === 'string' ? out.status : '';
  if (status === 'BLOCKED' || d.decision_type === 'account_health' || out.blocked === true) return 'alert';
  if (d.decision_type === 'appointment' || d.decision_type === 'sales_qualification' || d.decision_type === 'lead_qualification') return 'win';
  return 'ai';
}

function decisionText(d: AgentDecision): string {
  const out = d.output ?? {};
  for (const key of ['reason', 'summary', 'headline', 'message', 'next_action']) {
    const val = out[key];
    if (typeof val === 'string' && val.trim()) return val;
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'string') return val.slice(0, 2).join('；');
  }
  const labels = (d.evidence ?? []).map((e) => (e.quote ? `${e.label}：“${e.quote}”` : e.label)).slice(0, 2);
  return labels.join('；') || `${d.subject_type} ${d.subject_id}`;
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
    ];
  });
}

export function overviewPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const { dealer, dealers } = resolveDealer(ctx, rc);
  if (!dealer) {
    return renderPage(env, rc, { title: '总览', active: 'overview', dealer: null, dealers, h1: '今天的 <span class="grad">获客进展</span>', subtitle: '尚未配置门店', body: noDealerBody() });
  }
  const d = getDashboard(ctx, { dealer_id: dealer.id });
  const funnel = getFunnel(ctx, { dealer_id: dealer.id });
  const nowIso = ctx.clock.iso();
  const nowMs = ctx.clock.now().getTime();
  const exceptionsTotal = d.exceptions.reduce((s, e) => s + e.count, 0);
  const unconfirmed = d.exceptions.find((e) => e.kind === 'appointments_unconfirmed')?.count ?? 0;
  const decisions = dealerDecisions(ctx, dealer.id, 8);
  const report = getLatestReport(ctx, dealer.id);

  const kpis = [
    kpiCard({ variant: 'coral', label: '高意向线索', value: String(d.discovery.high_intent), chip: `合格 ${d.discovery.qualified}`, foot: `今日评估 ${d.discovery.users_evaluated} 位公开用户` }),
    kpiCard({ variant: 'lavender', label: '预计管道价值', value: cny(d.pipeline.estimated_value), chip: '阶段加权', foot: `${d.pipeline.by_stage.reduce((s, x) => s + x.count, 0)} 条在途线索` }),
    kpiCard({ variant: 'ink', label: '今日到店预约', value: String(d.sales.appointments), foot: `待确认 ${unconfirmed} · 到店 ${d.sales.visits}` }),
    kpiCard({ variant: 'outline', label: '需要你处理', value: pad2(exceptionsTotal), foot: '待审核私信 · 待审批内容 · 人工接管' }),
  ].join('');

  const exceptionRows = d.exceptions.map((e) => [
    `<span class="id-pill${e.severity === 'high' ? ' hot' : ''}">${esc(pad2(e.count))}</span>`,
    `<div class="primary" style="font-size:16px">${esc(e.title)}</div>`,
    pill(SEVERITY_LABEL[e.severity], SEVERITY_TONE[e.severity]),
    `<a class="circle-btn" href="${esc(e.href)}" aria-label="去处理">${ICON.chevron}</a>`,
  ]);

  const setup = getSetupStatus(ctx, dealer.id);
  // The example goal is built only from this store's own data (its city and cheapest model, else its first brand).
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
  const goalForm = setup.ready
    ? `<form class="card stack" data-api="/api/goals" data-success="目标已下达，AI 员工开始执行" style="margin-top:24px">
  <input type="hidden" name="dealer_id" value="${esc(dealer.id)}">
  <label>下达经营目标<textarea name="text" required minlength="2" maxlength="500" placeholder="${esc(`例如：这个月在${dealer.city}获取${exampleTarget}线索`)}"></textarea></label>
  <div class="row"><span class="small muted">AI 员工会拆解为搜索词、发现、评分、分配、私信草稿和内容计划，全部步骤可在「系统」页追踪。</span><span class="spacer"></span><button class="btn btn-primary" type="submit">+ 下达经营目标</button></div>
</form>`
    : `<div class="card stack" style="margin-top:24px"><h3>下达经营目标</h3><p class="small muted">完成设置后才能下达：${esc(setup.blocker ?? '')}</p><div class="row"><span class="spacer"></span><a class="btn btn-primary btn-sm" href="${esc(href('/accounts', { dealer: dealer.id }))}#add-account">去添加账号 / 扫码登录</a></div></div>`;
  const setupCard = setup.ready
    ? ''
    : `<div style="margin-bottom:28px">${setupSteps(setup, dealer.id)}</div>`;

  const activity = decisions.length
    ? `<ul class="activity">${decisions
        .map((x) => {
          const kind = decisionKind(x);
          return `<li><span class="act-icon act-${kind}">${ICON[kind]}</span><div><div class="act-title">${esc(DECISION_TITLE[x.decision_type] ?? x.decision_type)}</div><div class="act-desc">${esc(decisionText(x).slice(0, 140))}</div><div class="act-time">${esc(ago(x.created_at, nowMs))} · ${esc(x.agent)}</div></div></li>`;
        })
        .join('')}</ul>`
    : '<p class="muted small">AI 员工还没有做出决策。下达经营目标或运行每日任务后，这里会显示每一步的判断与依据。</p>';

  const funnelStrip = `<div class="funnel">${funnel
    .filter((f) => f.stage !== 'LOST')
    .map((f) => `<div class="funnel-step"><div class="stat-label">${esc(LEAD_STAGE[f.stage][0])}</div><div class="num">${esc(f.count)}</div><div class="tiny muted">累计 ${esc(f.reached)} · ${esc(pct(f.conversion_from_prev))}</div></div>`)
    .join('')}<div class="funnel-step"><div class="stat-label">流失</div><div class="num">${esc(funnel.find((f) => f.stage === 'LOST')?.count ?? 0)}</div></div></div>`;

  const group = (title: string, stats: string) => `<div class="stat-group-title">${esc(title)}</div><div class="stat-grid">${stats}</div>`;
  const statGroups = [
    group('内容', stat('已发布', d.content.posts_published) + stat('计划内容', d.content.posts_planned) + stat('待审批', d.content.posts_pending_approval) + stat('浏览量', d.content.views) + stat('互动', d.content.engagement)),
    group('发现', stat('扫描笔记', d.discovery.posts_scanned) + stat('扫描评论', d.discovery.comments_scanned) + stat('评估用户', d.discovery.users_evaluated) + stat('候选线索', d.discovery.candidates) + stat('合格线索', d.discovery.qualified) + stat('高意向', d.discovery.high_intent)),
    group('触达', stat('私信待处理', d.outreach.outreach_ready) + stat('已触达', d.outreach.contacted) + stat('收到回复', d.outreach.replies) + stat('回复率', pct(d.outreach.reply_rate))),
    group('销售', stat('销售合格', d.sales.sales_qualified) + stat('获得联系方式', d.sales.contacts_acquired) + stat('新增预约', d.sales.appointments) + stat('到店', d.sales.visits) + stat('成交', d.sales.won) + stat('流失', d.sales.lost)),
    group('账号', stat('活跃账号', d.accounts.active) + stat('健康账号', d.accounts.healthy) + stat('需要关注', d.accounts.requiring_attention.length)),
  ].join('');

  const body = `
${setupCard}
<section class="kpis">${kpis}</section>
<section class="main-grid">
  <div id="exceptions">
    ${sectionHead('需要你处理', { live: true })}
    ${exceptionRows.length ? table(['数量', '事项', '优先级', '操作'], exceptionRows) : emptyState('暂时没有需要你处理的事项')}
    ${goalForm}
    <div class="block" style="margin-top:32px">${sectionHead('经营目标')}${table(['目标', '状态', '执行', '时间'], goalRows(ctx, dealer), { compact: true, empty: '还没有下达经营目标' })}</div>
  </div>
  <aside class="panel">
    <h2 class="panel-title">AI 员工动态</h2>
    ${activity}
    <a class="btn-muted" href="${esc(href('/system', { dealer: dealer.id }))}#decisions">查看全部动态</a>
  </aside>
</section>
<section class="block">
  ${sectionHead('今日简报', { note: `统计区间 ${d.period.from.slice(0, 16).replace('T', ' ')} 起（${d.period.timezone}）` })}
  ${d.briefing.length ? `<ul class="briefing">${d.briefing.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : emptyState('今日暂无运营数据')}
  ${report ? `<p class="small muted" style="margin-top:12px">最新运营日报：${esc(report.date)} · <a class="link" href="${esc(href('/intel', { dealer: dealer.id }))}#report">查看</a></p>` : ''}
</section>
<section class="block">${sectionHead('销售漏斗', { note: '当前各阶段线索数 · 累计到达 · 较上一阶段转化' })}${funnelStrip}</section>
<section class="block">${statGroups}</section>
<p class="footnote">所有数字均从数据库实时计算（${esc(nowIso.slice(0, 19).replace('T', ' '))} UTC）。私信在没有获得官方授权接口前一律由销售在小红书 App 中人工发送并登记，系统不会把未经平台确认的私信标记为“已发送”。</p>`;

  return renderPage(env, rc, {
    title: '总览',
    active: 'overview',
    dealer,
    dealers,
    exceptions: exceptionsTotal,
    h1: '今天的 <span class="grad">获客进展</span>',
    subtitle: `${dealer.name} · ${dateLabel(nowIso, dealerTz(dealer))} · 公开购买信号 → 线索 → 私信 → 到店`,
    body,
  });
}
