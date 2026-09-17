/** 系统: provider/LLM capabilities, workflows & schedules, Dealer Brain maintenance, scoring, imports, DNC, audit. */
import { INVENTORY_STATUSES, OFFER_TYPES, WORKFLOW_STATUSES } from '../../core/types.ts';
import { RESUMABLE_STATUSES } from '../../operator/workflow-engine.ts';
import { getScoringConfig } from '../../skills/acquisition/lead-scoring/index.ts';
import { isOfferActive } from '../../skills/operations/dealer-brain/index.ts';
import type { Reply, RequestContext } from '../http.ts';
import {
  CAPABILITY_NAME,
  FACTOR,
  ago,
  capabilityPill,
  dataBody,
  emptyState,
  esc,
  fmtTime,
  href,
  pill,
  sectionHead,
  stepStatusPill,
  table,
  workflowStatusPill,
} from '../render.ts';
import { jsonDetails, resultBox } from './components.ts';
import { dealerDecisions } from './overview.ts';
import { dealerTz, noDealerBody, renderPage, resolveDealer, type PageEnv } from './shell.ts';

const WORKFLOW_LABEL: Record<string, string> = {
  refresh_dealer_data: '刷新门店数据与账号状态',
  market_research: '市场与竞品研究',
  account_planning: '账号内容计划',
  lead_discovery: '公开内容发现线索',
  signal_processing: '处理信号·分配·私信草稿',
  reply_processing: '处理回复与跟进',
  content_publishing: '撰写审核发布内容',
  performance_collection: '采集内容表现',
  evening_analysis: '晚间分析与日报',
  goal_execution: '经营目标执行',
};
const OFFER_TYPE_LABEL: Record<string, string> = { cash_discount: '现金优惠', finance: '金融方案', lease: '租赁方案', trade_in: '置换补贴', gift: '礼包', campaign: '活动' };
const INVENTORY_LABEL: Record<string, string> = { in_stock: '现车', in_transit: '在途', reserved: '已预订', sold: '已售' };

export function systemPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx, engine, scheduler } = env.runtime;
  const { dealer, dealers } = resolveDealer(ctx, rc);
  const importForm = `<form class="card stack" data-api="/api/dealer-brain/import" data-success="Dealer Brain 已导入">
  <p class="small muted">导入门店、车型、库存、价格、优惠、销售、知识、账号与人设（JSON，格式见 fixtures/dealers 示例与部署文档）。库存默认按“快照”处理：未出现在文件中的库存会被置为 0，避免推荐已售车辆。</p>
  <label>Dealer Brain JSON<textarea class="code" name="bundle" data-type="json" data-label="Dealer Brain JSON" placeholder='{"group":{"key":"…","name":"…"},"dealers":[…],"vehicles":[…],"inventory":[…],"offers":[…],"knowledge":[…],"accounts":[…]}'></textarea></label>
  <label>或上传文件<input type="file" accept="application/json,.json" data-json-into="bundle"></label>
  <div class="form-grid">
    <label>库存模式<select name="inventory_mode"><option value="snapshot">快照（推荐）</option><option value="merge">合并</option></select></label>
    <label>人设模式<select name="persona_mode"><option value="seed">仅补充缺失人设</option><option value="overwrite">覆盖人设</option></select></label>
    <label class="row" style="flex-direction:row;align-items:center"><input type="checkbox" name="dry_run" checked> 只校验不导入</label>
  </div>
  <div class="row"><span class="spacer"></span><button class="btn btn-primary btn-sm" type="submit">校验 / 导入</button></div>
  ${resultBox}
</form>`;
  if (!dealer) {
    return renderPage(env, rc, { title: '系统', active: 'system', dealer: null, dealers, h1: '系统', subtitle: '导入 Dealer Brain 开始使用', body: `<div id="dealer-brain">${noDealerBody()}${importForm.replace('data-success="Dealer Brain 已导入"', 'data-success="Dealer Brain 已导入" data-redirect="/"')}</div>` });
  }
  const tz = dealerTz(dealer);
  const nowMs = ctx.clock.now().getTime();

  // capabilities
  const snaps = ctx.db.all<{ account_id: string | null; capability: string; status: 'AVAILABLE' | 'UNAVAILABLE' | 'REQUIRES_AUTH' | 'REQUIRES_REVIEW'; reason: string; checked_at: string }>(
    `SELECT s.account_id, s.capability, s.status, s.reason, s.checked_at FROM capability_snapshots s
     JOIN (SELECT IFNULL(account_id, '') AS acc, capability, MAX(checked_at) AS latest FROM capability_snapshots WHERE provider = ? GROUP BY IFNULL(account_id, ''), capability) m
       ON IFNULL(s.account_id, '') = m.acc AND s.capability = m.capability AND s.checked_at = m.latest
     WHERE s.provider = ? AND (s.account_id IS NULL OR s.account_id IN (SELECT id FROM xhs_accounts WHERE dealer_id = ?))
     ORDER BY s.account_id IS NOT NULL, s.account_id, s.capability`,
    ctx.xhs.name,
    ctx.xhs.name,
    dealer.id,
  );
  const accounts = ctx.db.table('xhs_accounts').findMany({ dealer_id: dealer.id }, { orderBy: 'created_at ASC' });
  const nickname = new Map(accounts.map((a) => [a.id, a.nickname]));
  const capRows = snaps.map((s) => [
    esc(s.account_id ? nickname.get(s.account_id) ?? s.account_id : '全局/研究实例'),
    esc(CAPABILITY_NAME[s.capability] ?? s.capability),
    capabilityPill(s.status),
    `<span class="small muted">${esc(s.reason)}</span>`,
    `<span class="tiny muted">${esc(ago(s.checked_at, nowMs))}</span>`,
  ]);
  const llm = ctx.llm.status();

  // workflows
  const defs = engine.list();
  const runs = engine.listRuns(ctx, { dealer_id: dealer.id, limit: 30 });
  const runRows = runs.map((r) => {
    const duration = r.finished_at ? Math.max(0, Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000)) : null;
    const resumable = RESUMABLE_STATUSES.includes(r.status) && r.status !== 'RUNNING';
    return [
      `<div class="primary" style="font-size:15px">${esc(WORKFLOW_LABEL[r.workflow] ?? r.workflow)}</div><div class="secondary mono">${esc(r.workflow)} · ${esc(r.trigger)}</div>`,
      workflowStatusPill(r.status),
      `<span class="small">${esc(fmtTime(r.started_at, tz))}${duration !== null ? ` · ${esc(duration)}s` : ''}</span>${r.error ? `<div class="tiny muted">${esc(r.error.slice(0, 160))}</div>` : ''}`,
      `<a class="btn btn-ghost btn-sm" href="${esc(href(`/system/runs/${r.id}`, { dealer: dealer.id }))}">步骤</a>${resumable ? ` <button class="btn btn-ink btn-sm" data-action="call" data-url="/api/workflow-runs/${esc(r.id)}/resume" data-success="已恢复运行">恢复</button>` : ''}${r.status === 'RUNNING' ? ` <button class="btn btn-danger btn-sm" data-action="call" data-url="/api/workflow-runs/${esc(r.id)}/cancel" data-body="${dataBody({ reason: '运营取消' })}" data-confirm="确认取消？" data-success="已请求取消">取消</button>` : ''}`,
    ];
  });
  const runButtons = defs
    .filter((d) => d.name !== 'goal_execution')
    .map((d) => `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/workflows/${esc(d.name)}/run" data-body="${dataBody({ dealer_id: dealer.id })}" data-success="任务已启动" title="${esc(d.description)}">${esc(WORKFLOW_LABEL[d.name] ?? d.name)}</button>`)
    .join('');
  const schedules = scheduler.listSchedules(ctx, { dealer_id: dealer.id });
  const scheduleRows = schedules.map((s) => [
    esc(WORKFLOW_LABEL[s.workflow] ?? s.workflow),
    `<span class="mono">${esc(s.cron)}</span>`,
    s.enabled ? pill('启用', 'green') : pill('停用', 'neutral'),
    `<span class="small muted">${esc(s.last_run_at ? ago(s.last_run_at, nowMs) : '从未运行')}</span>`,
    `<button class="btn btn-ghost btn-sm" data-action="call" data-method="PATCH" data-url="/api/schedules/${esc(s.id)}" data-body="${dataBody({ enabled: !s.enabled })}" data-success="已更新">${s.enabled ? '停用' : '启用'}</button>`,
  ]);

  // Dealer Brain
  const vehicles = new Map(ctx.db.table('vehicles').findMany({ group_id: dealer.group_id }).map((x) => [x.id, x]));
  const inventory = ctx.db.table('inventory').findMany({ dealer_id: dealer.id }, { orderBy: 'status ASC, vehicle_id ASC' });
  const invRows = inventory.map((r) => {
    const veh = vehicles.get(r.vehicle_id);
    const rowId = `inv-${r.id}`;
    return [
      `<div class="primary" style="font-size:15px">${esc(veh ? `${veh.brand_zh}${veh.model_zh} ${veh.trim}` : r.vehicle_id)}</div><div class="secondary">${esc(r.exterior_color)}外 / ${esc(r.interior_color)}内${r.vin ? ` · <span class="mono">${esc(r.vin)}</span>` : ''}</div>`,
      `<div class="inline-form" id="${esc(rowId)}"><select name="status">${INVENTORY_STATUSES.map((s) => `<option value="${s}"${s === r.status ? ' selected' : ''}>${esc(INVENTORY_LABEL[s])}</option>`).join('')}</select><input type="number" name="quantity" min="0" value="${esc(r.quantity)}" style="min-width:70px;width:80px"><input type="number" name="list_price" min="0" value="${esc(r.list_price ?? '')}" placeholder="标价" data-optional style="min-width:110px;width:120px"></div>`,
      `<span class="tiny muted">${esc(r.source)}</span>`,
      `<button class="btn btn-ghost btn-sm" data-action="call" data-method="PATCH" data-url="/api/inventory/${esc(r.id)}" data-form="#${esc(rowId)}" data-success="库存已更新">保存</button>`,
    ];
  });
  const offers = ctx.db.table('offers').findMany({ dealer_id: dealer.id }, { orderBy: 'valid_until DESC' });
  const now = ctx.clock.now();
  const offerRows = offers.map((o) => {
    const rowId = `ofr-${o.id}`;
    return [
      `<div class="primary" style="font-size:15px">${esc(o.title)}</div><div class="secondary">${esc(OFFER_TYPE_LABEL[o.type] ?? o.type)}${o.model ? ` · ${esc(o.model)}` : ''}${o.vehicle_id ? ` · ${esc(vehicles.get(o.vehicle_id)?.trim ?? '')}` : ''} · ${esc(o.conditions.slice(0, 40))}</div>`,
      isOfferActive(o, dealer, now) ? pill('生效中', 'green') : pill('未生效/已过期', 'neutral'),
      `<div class="inline-form" id="${esc(rowId)}"><input type="number" name="amount" min="0" value="${esc(o.amount ?? '')}" placeholder="金额" data-optional style="min-width:100px;width:110px"><input type="text" name="valid_until" value="${esc(o.valid_until)}" style="min-width:110px;width:120px"></div>`,
      `<button class="btn btn-ghost btn-sm" data-action="call" data-method="PATCH" data-url="/api/offers/${esc(o.id)}" data-form="#${esc(rowId)}" data-success="优惠已更新">保存</button>`,
    ];
  });
  const offerForm = `<form class="card stack" data-api="/api/dealers/${esc(dealer.id)}/offers" data-success="优惠已创建">
  <h3>新增优惠政策</h3>
  <div class="form-grid">
    <label>类型<select name="type">${OFFER_TYPES.map((t) => `<option value="${t}">${esc(OFFER_TYPE_LABEL[t])}</option>`).join('')}</select></label>
    <label>标题<input type="text" name="title" required maxlength="80"></label>
    <label>适用车型（可空）<input type="text" name="model" maxlength="60" data-optional placeholder="${esc([...vehicles.values()][0] ? `如 ${[...vehicles.values()][0].model_zh}` : '门店车型名称')}"></label>
    <label>金额（元）<input type="number" name="amount" min="0" data-optional></label>
    <label>开始日期<input type="text" name="valid_from" required placeholder="2026-09-01"></label>
    <label>结束日期<input type="text" name="valid_until" required placeholder="2026-09-30"></label>
  </div>
  <label>条件<input type="text" name="conditions" maxlength="500"></label>
  <label>说明<input type="text" name="description" maxlength="500"></label>
  <div class="row"><span class="small muted">价格、优惠只会引用这里的结构化数据，AI 不会编造。</span><span class="spacer"></span><button class="btn btn-ink btn-sm" type="submit">创建</button></div>
</form>`;
  const knowledge = ctx.db.table('dealer_knowledge').query('group_id = ? AND (dealer_id IS NULL OR dealer_id = ?)', [dealer.group_id, dealer.id], { orderBy: 'category ASC, key ASC' });
  const knowledgeRows = knowledge.map((k) => [pill(k.category, 'neutral'), `<div class="primary" style="font-size:14px">${esc(k.title)}</div><div class="secondary">${esc(k.content.slice(0, 90))}</div>`, `<span class="tiny muted">${esc(k.source)}</span>`]);

  // scoring
  const scoring = getScoringConfig(ctx, dealer.id);
  const scoringForm = `<form class="card stack" data-api="/api/scoring/${esc(dealer.id)}" data-method="PUT" data-success="评分配置已更新（新版本）">
  <div class="small muted">当前版本 v${esc(scoring.version)} · 权重总和建议 100</div>
  <div class="form-grid">${Object.entries(scoring.weights).map(([k, x]) => `<label>${esc(FACTOR[k] ?? k)}<input type="number" min="0" max="100" name="weights.${esc(k)}" value="${esc(x)}"></label>`).join('')}</div>
  <div class="form-grid">${Object.entries(scoring.thresholds).map(([k, x]) => `<label>${esc({ candidate: '候选阈值', qualified: '合格阈值', high_intent: '高意向阈值', immediate: '立即跟进阈值' }[k] ?? k)}<input type="number" min="0" max="100" name="thresholds.${esc(k)}" value="${esc(x)}"></label>`).join('')}</div>
  <div class="row"><span class="spacer"></span><button class="btn btn-ink btn-sm" type="submit">保存为新版本</button></div></form>`;

  // DNC
  const dnc = ctx.db.table('contact_suppressions').findMany({}, { orderBy: 'created_at DESC', limit: 50 });
  const dncRows = dnc.map((s) => [`<span class="mono">${esc(s.platform_user_id)}</span>`, esc(s.reason), `<span class="tiny muted">${esc(s.source)} · ${esc(fmtTime(s.created_at, tz))}</span>`]);

  // import public content
  const contentImport = `<form class="card stack" data-api="/api/public-content/import" data-success="已导入并分析公开内容">
  <input type="hidden" name="dealer_id" value="${esc(dealer.id)}">
  <p class="small muted">导入从小红书真实导出的公开笔记与评论（xiaohongshu-mcp get_feed_detail 格式映射后的 JSON 数组）。数据会标记为「导入数据」，不会冒充实时抓取。</p>
  <label>笔记 JSON 数组<textarea class="code" name="notes" data-type="json" data-label="笔记 JSON" placeholder='[{"platform_post_id":"…","xsec_token":"…","title":"…","content":"…","author":{"platform_user_id":"…","nickname":"…"},"comments":[…]}]'></textarea></label>
  <div class="row"><span class="spacer"></span><button class="btn btn-ink btn-sm" type="submit">导入并分析</button></div>${resultBox}</form>`;

  const decisions = dealerDecisions(ctx, dealer.id, 40);
  const decisionRows = decisions.map((d) => [
    `<b class="small">${esc(d.decision_type)}</b><div class="tiny muted">${esc(d.agent)}</div>`,
    `<span class="small mono">${esc(d.subject_type)}:${esc(d.subject_id.slice(0, 22))}</span>`,
    `<span class="num">${esc(Math.round(d.confidence * 100))}%</span> ${pill(d.engine, 'neutral')}`,
    jsonDetails('输出', d.output, 1500),
    `<span class="tiny muted">${esc(ago(d.created_at, nowMs))}</span>`,
  ]);
  const events = ctx.db.table('audit_events').findMany({}, { orderBy: 'created_at DESC', limit: 40 });
  const eventRows = events.map((e) => [`<span class="small mono">${esc(e.action)}</span>`, `<span class="small">${esc(e.actor)}</span>`, `<span class="tiny mono">${esc(e.entity_type)}:${esc(e.entity_id.slice(0, 22))}</span>`, `<span class="tiny muted">${esc(ago(e.created_at, nowMs))}</span>`]);

  const body = `
${sectionHead('数据源与能力', { note: `小红书：${ctx.xhs.name}（${ctx.xhs.mode}） · 大模型：${llm.provider} ${llm.status}${llm.model ? ` · ${llm.model}` : ''}`, right: `<button class="btn btn-ink btn-sm" data-action="call" data-url="/api/accounts/sync" data-body="${dataBody({ dealer_id: dealer.id })}" data-success="已重新检测">重新检测</button>` })}
<p class="small muted">${esc(llm.reason)}</p>
${table(['账号', '能力', '状态', '说明', '检测时间'], capRows, { compact: true, empty: '还没有能力检测记录，点击“重新检测”。' })}
<div class="block">${sectionHead('自动任务', { note: '每一步都持久化，可观察、可恢复' })}<div class="row" style="margin-bottom:16px">${runButtons}</div>${table(['任务', '状态', '时间', '操作'], runRows, { compact: true, empty: '还没有任务运行' })}</div>
<div class="block">${sectionHead('排班', { note: `门店时区 ${tz}` })}${table(['任务', '时间', '状态', '上次运行', ''], scheduleRows, { compact: true, empty: '没有排班' })}</div>
<div class="block" id="dealer-brain">${sectionHead('Dealer Brain', { note: '门店事实的唯一来源', right: `<a class="btn btn-ghost btn-sm" href="/api/dealer-brain/export?dealer_id=${esc(dealer.id)}">导出备份 JSON</a>` })}
  ${importForm}
  <div class="block" style="margin-top:28px">${sectionHead('库存')}${table(['车辆', '状态 / 数量 / 标价', '来源', ''], invRows, { compact: true, empty: '没有库存' })}</div>
  <div class="block" style="margin-top:28px">${sectionHead('优惠政策')}${table(['政策', '状态', '金额 / 截止', ''], offerRows, { compact: true, empty: '没有优惠' })}${offerForm}</div>
  <div class="block" style="margin-top:28px">${sectionHead('门店知识')}${table(['类别', '内容', '来源'], knowledgeRows, { compact: true, empty: '没有知识条目' })}</div>
</div>
<div class="block">${sectionHead('评分配置')}${scoringForm}</div>
<div class="block">${sectionHead('导入真实公开内容')}${contentImport}</div>
<div class="block">${sectionHead('全局勿扰名单', { note: '所有门店与账号共享，一旦加入不再联系' })}
  <form class="inline-form" data-api="/api/dnc" data-success="已加入勿扰" style="margin-bottom:12px"><input type="text" name="platform_user_id" placeholder="小红书用户ID" required><input type="text" name="reason" placeholder="原因" required><button class="btn btn-danger btn-sm" type="submit">加入勿扰</button></form>
  ${table(['用户ID', '原因', '来源'], dncRows, { compact: true, empty: '勿扰名单为空' })}</div>
<div class="block" id="decisions">${sectionHead('AI 决策审计')}${table(['决策', '对象', '置信度', '输出', '时间'], decisionRows, { compact: true, empty: '暂无决策' })}</div>
<div class="block">${sectionHead('操作审计')}${table(['动作', '操作人', '对象', '时间'], eventRows, { compact: true, empty: '暂无记录' })}</div>`;
  return renderPage(env, rc, { title: '系统', active: 'system', dealer, dealers, h1: '系统 <span class="grad">与数据</span>', subtitle: `${dealer.name} · 能力状态、自动任务、Dealer Brain 与审计`, body });
}

export function runDetailPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx, engine } = env.runtime;
  const { run, steps } = engine.getRun(ctx, rc.params.id);
  const { dealers } = resolveDealer(ctx, rc);
  const dealer = dealers.find((d) => d.id === run.dealer_id) ?? null;
  const tz = dealerTz(dealer);
  const rows = steps.map((s) => [
    `<div class="primary" style="font-size:15px">${esc(s.step_key)}</div><div class="secondary mono">${esc(s.agent)} · ${esc(s.skill)}</div>`,
    stepStatusPill(s.status),
    `<span class="small">${esc(s.attempts)} 次 · ${esc(fmtTime(s.started_at, tz))}</span>`,
    `${s.error ? `<div class="small" style="color:var(--red)">${esc(s.error.slice(0, 300))}</div>` : ''}${typeof s.output.reason === 'string' ? `<div class="small muted">${esc(s.output.reason)}</div>` : ''}${jsonDetails('输出', s.output, 3000)}`,
  ]);
  const resumable = RESUMABLE_STATUSES.includes(run.status) && run.status !== 'RUNNING';
  const body = `<div class="panel stack"><div class="row">${workflowStatusPill(run.status)} <span class="mono small">${esc(run.id)}</span> <span class="small muted">${esc(run.trigger)} · 开始 ${esc(fmtTime(run.started_at, tz))}${run.finished_at ? ` · 结束 ${esc(fmtTime(run.finished_at, tz))}` : ''}</span><span class="spacer"></span>${resumable ? `<button class="btn btn-ink btn-sm" data-action="call" data-url="/api/workflow-runs/${esc(run.id)}/resume" data-success="已恢复">恢复运行</button>` : ''}</div>
  ${run.error ? `<div class="banner banner-red" style="margin:0">${esc(run.error)}</div>` : ''}
  ${jsonDetails('输入', run.input)}</div>
<div class="block">${table(['步骤', '状态', '尝试', '结果'], rows)}</div>`;
  return renderPage(env, rc, {
    title: '任务详情',
    active: 'system',
    dealer,
    dealers,
    h1: `${esc(WORKFLOW_LABEL[run.workflow] ?? run.workflow)}`,
    subtitle: `任务状态 ${WORKFLOW_STATUSES.includes(run.status) ? run.status : ''} · 已跳过的步骤会写明原因（例如能力不可用）`,
    body,
  });
}
