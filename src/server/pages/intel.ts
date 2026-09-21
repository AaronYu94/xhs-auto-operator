/**
 * 情报: which search words actually bring in buyers, what the last searches found, what the market is saying, 日报.
 *
 * A salesperson reads this to decide where to spend the day, so it says 搜索词 / 客户 / 成交, never 数据源、抓取、
 * 笔记 id or a provenance code. A search that came back empty says which of the three real causes it was.
 */
import type { ResearchBrief, SearchRun } from '../../core/types.ts';
import { getQueryEffectiveness } from '../../skills/acquisition/automotive-query-generation/index.ts';
import { getLatestReport } from '../../skills/operations/reporting/index.ts';
import type { Reply, RequestContext } from '../http.ts';
import { DATA_MODE, QUERY_CLASS, ago, dataBody, emptyState, esc, fmtTime, pill, sectionHead, table, unfinishedBlock, unfinishedTag } from '../render.ts';
import { humanProblem, scrubInternals } from '../humanize.ts';
import { hint } from '../hint.ts';
import { resultBox } from './components.ts';
import { dealerTz, noDealerBody, renderPage, resolveDealer, type PageEnv } from './shell.ts';

const RUN_STATUS: Record<SearchRun['status'], [string, 'green' | 'amber' | 'red' | 'violet']> = {
  RUNNING: ['运行中', 'violet'],
  SUCCEEDED: ['完成', 'green'],
  FAILED: ['失败', 'red'],
  UNAVAILABLE: ['不可用', 'red'],
};
const QUERY_STATUS: Record<string, [string, 'green' | 'neutral' | 'red']> = { active: ['启用', 'green'], paused: ['暂停', 'neutral'], retired: ['已退役', 'red'] };
/** The stored priority is a 0–1 float; a salesperson only needs to know whether the system leans on this word. */
const priorityLabel = (p: number): string => (p >= 0.6 ? '高' : p >= 0.35 ? '中' : '低');

const KIND: Record<ResearchBrief['kind'], string> = { xhs: '买家在问什么', competitor: '同行和竞品', market: '行情与价格', trend: '正在火的话题' };

/** Why a search came back empty, in the store's terms — never the integration's own error text. */
function runReason(run: SearchRun): string {
  const why = humanProblem(run.error);
  if (!why) return '';
  const needsLogin = /登录/.test(why);
  return `<div class="tiny ${needsLogin ? '' : 'muted'}"${needsLogin ? ' style="color:var(--amber)"' : ''}>${needsLogin ? '不是没有结果：' : ''}${esc(why)}</div>`;
}

function briefHtml(b: ResearchBrief, tz: string): string {
  const f = b.findings;
  const insights = f.insights
    .slice(0, 6)
    .map((i) => `<li>${esc(scrubInternals(i.text))}${i.evidence.length ? `<div class="tiny muted">${i.evidence.slice(0, 2).map((e) => (e.quote ? `“${esc(e.quote)}”` : esc(e.label))).join(' · ')}</div>` : ''}</li>`)
    .join('');
  const questions = f.top_questions?.length ? `<div class="small"><b>客户最常问：</b>${f.top_questions.slice(0, 5).map((q) => `${esc(q.question)}（${esc(q.count)}）`).join('、')}</div>` : '';
  const competitors = f.competitors?.length ? `<div class="small"><b>被拿来比的车：</b>${f.competitors.slice(0, 5).map((c) => `${esc(c.model)} vs ${esc(c.comparison_with)}（${esc(c.mentions)}）`).join('、')}</div>` : '';
  const trends = f.trends?.length ? `<div class="small"><b>热度变化：</b>${f.trends.slice(0, 6).map((t) => `${esc(t.term)} ${t.change >= 0 ? '↑' : '↓'}${esc(Math.round(Math.abs(t.change) * 100))}%`).join('、')}</div>` : '';
  return `<article class="card stack"><div class="row">${pill(KIND[b.kind], 'violet')}<span class="small muted">${esc(fmtTime(b.created_at, tz))} · 看了 ${esc(b.source_counts.posts)} 篇笔记、${esc(b.source_counts.comments)} 条评论</span></div>
  <div class="primary" style="font-size:16px">${esc(scrubInternals(f.headline))}</div>${insights ? `<ul class="timeline">${insights}</ul>` : ''}${questions}${competitors}${trends}</article>`;
}

export function intelPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const { dealer, dealers } = resolveDealer(ctx, rc);
  if (!dealer) return renderPage(env, rc, { title: '情报', active: 'intel', dealer: null, dealers, h1: '情报', subtitle: '还没有门店', body: noDealerBody() });
  const tz = dealerTz(dealer);
  const nowMs = ctx.clock.now().getTime();
  const eff = getQueryEffectiveness(ctx, dealer.id);
  const maxDensity = Math.max(0.0001, ...eff.map((e) => e.lead_density));
  const queryRows = eff.slice(0, 80).map((e) => {
    const [sl, st] = QUERY_STATUS[e.query.status] ?? [e.query.status, 'neutral'];
    return [
      `<span class="primary">${esc(e.query.text)}</span>`,
      `${pill(QUERY_CLASS[e.query.query_class] ?? e.query.query_class, 'neutral')} ${pill(sl, st)}`,
      `<span class="small">${esc(priorityLabel(e.query.priority))}</span>`,
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
    // 真实数据 is the normal case and needs no badge; anything else is flagged so nothing here looks realer than it is.
    const provenance = mode === 'live' ? '' : ` ${pill(DATA_MODE[mode][0], DATA_MODE[mode][1])}`;
    return [
      `<span class="primary">${esc(texts.get(r.query_id) ?? '已删除的搜索词')}</span>${runReason(r)}`,
      `${pill(label, tone)}${provenance}`,
      `<span class="num">${esc(r.posts_discovered)} / ${esc(r.comments_scanned)} / ${esc(r.users_evaluated)}</span>`,
      `<span class="num">${esc(r.candidates)} / ${esc(r.qualified)} / ${esc(r.high_intent)}</span>`,
      `<span class="small muted">${esc(ago(r.started_at, nowMs))}</span>`,
    ];
  });
  const briefs: ResearchBrief[] = [];
  for (const kind of ['xhs', 'competitor', 'market', 'trend'] as const) {
    const b = ctx.db.table('research_briefs').findOne({ dealer_id: dealer.id, kind }, { orderBy: 'created_at DESC' });
    if (b) briefs.push(b);
  }
  const report = getLatestReport(ctx, dealer.id);
  const summary = report && Array.isArray((report.report as { summary?: unknown }).summary) ? ((report.report as { summary: string[] }).summary) : [];
  const body = `${sectionHead('哪些搜索词带来客户', {
    help: [
      '按真实成交倒推，效果差的词会被自动换掉。',
      '系统靠这些词在小红书上找正在看车的人。每一行是一个词，右边是它到底捞上来多少合格客户、约到几个人、成交几单。',
      '「线索密度」是这个词评估过的人里有多少真的是买家：越高说明这个词越准，越低说明搜出来的多半是同行、车主或者看热闹的。',
      '点「优化搜索词」会照这些成绩单换词：效果差的暂停，效果好的衍生出新的。平时不用管，系统每天自己会调。',
    ],
    right: `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/queries/evolve" data-body="${dataBody({ dealer_id: dealer.id })}" data-success="已按效果调整搜索词">优化搜索词</button>`,
  })}
${table(['搜索词', '类型/状态', '系统看重', '搜过', '笔记/评论', '看过的人', '候选/合格/高意向', '线索密度', '预约/成交'], queryRows, { compact: true, empty: '还没有搜索词。下达一个经营目标，系统会自己生成。' })}
<div class="block">${sectionHead('最近几次搜索', {
    note: '没搜到东西时，这里会说是为什么',
    help: ['搜不到结果分三种：账号掉登录了、连不上、或者被小红书限流。系统不会把「没搜到」和「搜不了」混在一起说。'],
  })}${table(['搜索词', '结果', '笔记/评论/看过的人', '候选/合格/高意向', '时间'], runRows, { compact: true, empty: '还没有搜索记录' })}</div>
<div class="block">${sectionHead('市场上在说什么', {
    note: '买家的问题、同行的动作、在涨的话题',
    help: ['结论都是从小红书上的公开原文里读出来的，每条下面带着原话，不是 AI 拍脑袋编的。'],
    right: `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/workflows/market_research/run" data-body="${dataBody({ dealer_id: dealer.id })}" data-success="已开始研究">重新研究一次</button>`,
  })}${briefs.length ? `<div class="lead-grid">${briefs.map((b) => briefHtml(b, tz)).join('')}</div>` : emptyState('还没有研究结果')}</div>
<div class="block" id="report">${sectionHead('经营日报', {
    note: '今天进来多少人、跟进到哪一步',
    right: `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/reports/${esc(dealer.id)}" data-success="日报已生成">生成今日日报</button>`,
  })}${summary.length ? `<p class="small muted">${esc(report?.date ?? '')}</p><ul class="briefing">${summary.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : emptyState('还没有日报')}</div>
${unfinishedBlock('lost_reason_analysis')}
<div class="block">${sectionHead('系统给的调整建议', {
    note: '评分门槛、内容方向、账号负载',
    help: ['按最近的真实成绩算一遍：分数门槛是不是卡太严、哪类内容更能带来客户、哪个账号接得太多。建议目前只能看一次，不会存下来。'],
  })}${unfinishedTag('optimization_view')}<form data-api="/api/optimization/${esc(dealer.id)}" data-redirect="none" data-success="已生成建议"><button class="btn btn-ink btn-sm" type="submit">算一次</button>${resultBox}</form></div>`;
  return renderPage(env, rc, {
    title: '情报',
    active: 'intel',
    dealer,
    dealers,
    h1: '情报',
    help: [
      '这一页回答一个问题：哪些搜索词真正带来了客户和成交。',
      '系统靠搜索词在小红书上找正在看车的人，这里按真实成交给每个词算一笔账，效果差的自动换掉。',
      '下面还有同行和买家在聊什么、每天的经营日报，以及系统给的调整建议。',
    ],
    subtitle: dealer.name,
    body,
  });
}
