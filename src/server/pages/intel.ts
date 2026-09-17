/** 情报: search intelligence (lead density per query), search runs with honest failure reasons, research briefs, report. */
import type { ResearchBrief, SearchRun } from '../../core/types.ts';
import { getQueryEffectiveness } from '../../skills/acquisition/automotive-query-generation/index.ts';
import { getLatestReport } from '../../skills/operations/reporting/index.ts';
import type { Reply, RequestContext } from '../http.ts';
import { DATA_MODE, QUERY_CLASS, ago, dataBody, emptyState, esc, fmtTime, pill, sectionHead, table } from '../render.ts';
import { resultBox } from './components.ts';
import { dealerTz, noDealerBody, renderPage, resolveDealer, type PageEnv } from './shell.ts';

const RUN_STATUS: Record<SearchRun['status'], [string, 'green' | 'amber' | 'red' | 'violet']> = {
  RUNNING: ['运行中', 'violet'],
  SUCCEEDED: ['完成', 'green'],
  FAILED: ['失败', 'red'],
  UNAVAILABLE: ['不可用', 'red'],
};
const QUERY_STATUS: Record<string, [string, 'green' | 'neutral' | 'red']> = { active: ['启用', 'green'], paused: ['暂停', 'neutral'], retired: ['已退役', 'red'] };
const KIND: Record<ResearchBrief['kind'], string> = { xhs: '小红书内容研究', competitor: '竞品研究', market: '市场与价格研究', trend: '趋势' };

function runReason(run: SearchRun): string {
  if (!run.error) return '';
  const needsLogin = /REQUIRES_AUTH|未登录|login/i.test(run.error);
  return `<div class="tiny ${needsLogin ? '' : 'muted'}" style="color:${needsLogin ? 'var(--amber)' : ''}">${needsLogin ? '需要扫码登录（不是没有结果）：' : ''}${esc(run.error.slice(0, 200))}</div>`;
}

function briefHtml(b: ResearchBrief, tz: string): string {
  const f = b.findings;
  const insights = f.insights
    .slice(0, 6)
    .map((i) => `<li>${esc(i.text)}${i.evidence.length ? `<div class="tiny muted">${i.evidence.slice(0, 2).map((e) => (e.quote ? `“${esc(e.quote)}”` : esc(e.label))).join(' · ')}</div>` : ''}</li>`)
    .join('');
  const questions = f.top_questions?.length ? `<div class="small"><b>高频购车问题：</b>${f.top_questions.slice(0, 5).map((q) => `${esc(q.question)}（${esc(q.count)}）`).join('、')}</div>` : '';
  const competitors = f.competitors?.length ? `<div class="small"><b>竞品提及：</b>${f.competitors.slice(0, 5).map((c) => `${esc(c.model)} vs ${esc(c.comparison_with)}（${esc(c.mentions)}）`).join('、')}</div>` : '';
  const trends = f.trends?.length ? `<div class="small"><b>趋势：</b>${f.trends.slice(0, 6).map((t) => `${esc(t.term)} ${t.change >= 0 ? '↑' : '↓'}${esc(Math.round(Math.abs(t.change) * 100))}%`).join('、')}</div>` : '';
  return `<article class="card stack"><div class="row">${pill(KIND[b.kind], 'violet')}<span class="small muted">${esc(fmtTime(b.created_at, tz))} · 笔记 ${esc(b.source_counts.posts)} · 评论 ${esc(b.source_counts.comments)} · 搜索 ${esc(b.source_counts.provider_searches)}</span></div>
  <div class="primary" style="font-size:16px">${esc(f.headline)}</div>${insights ? `<ul class="timeline">${insights}</ul>` : ''}${questions}${competitors}${trends}</article>`;
}

export function intelPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const { dealer, dealers } = resolveDealer(ctx, rc);
  if (!dealer) return renderPage(env, rc, { title: '情报', active: 'intel', dealer: null, dealers, h1: '情报', subtitle: '尚未配置门店', body: noDealerBody() });
  const tz = dealerTz(dealer);
  const nowMs = ctx.clock.now().getTime();
  const eff = getQueryEffectiveness(ctx, dealer.id);
  const maxDensity = Math.max(0.0001, ...eff.map((e) => e.lead_density));
  const queryRows = eff.slice(0, 80).map((e) => {
    const [sl, st] = QUERY_STATUS[e.query.status] ?? [e.query.status, 'neutral'];
    return [
      `<span class="mono">${esc(e.query.text)}</span><div class="tiny muted">${esc(e.query.generation_reason.slice(0, 80))}</div>`,
      `${pill(QUERY_CLASS[e.query.query_class] ?? e.query.query_class, 'neutral')} ${pill(sl, st)}`,
      `<span class="num">${esc(e.query.priority.toFixed(2))}</span>`,
      `<span class="num">${esc(e.runs)}</span>`,
      `<span class="num">${esc(e.posts_discovered)} / ${esc(e.comments_scanned)}</span>`,
      `<span class="num">${esc(e.users_evaluated)}</span>`,
      `<span class="num">${esc(e.candidates)} / ${esc(e.qualified)} / ${esc(e.high_intent)}</span>`,
      `<div class="density"><span class="bar"><i style="width:${Math.round((e.lead_density / maxDensity) * 100)}%"></i></span><span class="num">${esc(Math.round(e.lead_density * 100))}%</span></div>`,
      `<span class="num">${esc(e.appointments)} / ${esc(e.won)}</span>`,
    ];
  });
  const texts = new Map(ctx.db.table('search_queries').findMany({ dealer_id: dealer.id }).map((q) => [q.id, q.text]));
  const runs = ctx.db.table('search_runs').findMany({ dealer_id: dealer.id }, { orderBy: 'started_at DESC', limit: 25 });
  const runRows = runs.map((r) => {
    const [label, tone] = RUN_STATUS[r.status];
    const mode = r.data_mode ?? 'unknown';
    return [
      `<span class="mono">${esc(texts.get(r.query_id) ?? r.query_id)}</span>${runReason(r)}`,
      `${pill(label, tone)} ${pill(DATA_MODE[mode][0], DATA_MODE[mode][1])}`,
      `<span class="num">${esc(r.posts_discovered)} / ${esc(r.comments_scanned)} / ${esc(r.users_evaluated)}</span>`,
      `<span class="num">${esc(r.candidates)} / ${esc(r.qualified)} / ${esc(r.high_intent)}</span>`,
      `<span class="small muted">${esc(r.provider)} · ${esc(ago(r.started_at, nowMs))}</span>`,
    ];
  });
  const briefs: ResearchBrief[] = [];
  for (const kind of ['xhs', 'competitor', 'market', 'trend'] as const) {
    const b = ctx.db.table('research_briefs').findOne({ dealer_id: dealer.id, kind }, { orderBy: 'created_at DESC' });
    if (b) briefs.push(b);
  }
  const report = getLatestReport(ctx, dealer.id);
  const summary = report && Array.isArray((report.report as { summary?: unknown }).summary) ? ((report.report as { summary: string[] }).summary) : [];
  const body = `${sectionHead('搜索情报', {
    note: '线索密度 = 合格用户 ÷ 评估用户；搜索策略会按真实线索质量自动调整',
    right: `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/queries/evolve" data-body="${dataBody({ dealer_id: dealer.id })}" data-success="已按线索质量调整搜索词">优化搜索词</button>`,
  })}
${table(['查询', '类型/状态', '优先级', '运行', '笔记/评论', '用户', '候选/合格/高意向', '线索密度', '预约/成交'], queryRows, { compact: true, empty: '还没有搜索词。下达经营目标后会自动生成五类汽车搜索词。' })}
<div class="block">${sectionHead('最近搜索任务', { note: '失败原因如实显示：需要登录、实例不可达、平台限制' })}${table(['查询', '状态/数据来源', '笔记/评论/用户', '候选/合格/高意向', '数据源'], runRows, { compact: true, empty: '还没有运行过搜索' })}</div>
<div class="block">${sectionHead('研究简报', { right: `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/workflows/market_research/run" data-body="${dataBody({ dealer_id: dealer.id })}" data-success="研究任务已启动">运行市场研究</button>` })}${briefs.length ? `<div class="lead-grid">${briefs.map((b) => briefHtml(b, tz)).join('')}</div>` : emptyState('还没有研究简报')}</div>
<div class="block" id="report">${sectionHead('运营日报', { right: `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/reports/${esc(dealer.id)}" data-success="日报已生成">生成今日日报</button>` })}${summary.length ? `<p class="small muted">${esc(report?.date ?? '')}</p><ul class="briefing">${summary.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : emptyState('还没有日报')}</div>
<div class="block">${sectionHead('策略优化', { right: `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/optimization/${esc(dealer.id)}" data-redirect="none" data-form="#opt-none" data-success="已生成优化建议">运行优化分析</button>` })}<div id="opt-none"></div><form data-api="/api/optimization/${esc(dealer.id)}" data-redirect="none" data-success="已生成优化建议"><button class="btn btn-ink btn-sm" type="submit">查看阈值、内容与账号负载建议</button>${resultBox}</form></div>`;
  return renderPage(env, rc, { title: '情报', active: 'intel', dealer, dealers, h1: '搜索 <span class="grad">情报</span>', subtitle: `${dealer.name} · 哪些搜索词真正带来合格线索和成交`, body });
}
