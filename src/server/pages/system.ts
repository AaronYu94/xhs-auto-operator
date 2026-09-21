/**
 * 系统: the one page a technical colleague may need — 小红书连接, 自动任务, 运行时间, 门店资料, 评分, 勿扰名单, 记录.
 *
 * It is allowed to be denser than the rest of the console, but it still speaks the store's language: every block says
 * what it means for selling cars before it says anything else, and nothing here prints a tool name, an instance
 * address, an environment variable, a file path or an English status code. Whatever has no Chinese wording yet goes
 * through `scrubInternals`. This page is also the single place where the unfinished features are disclosed.
 */
import { INVENTORY_STATUSES, OFFER_TYPES } from '../../core/types.ts';
import { RESUMABLE_STATUSES } from '../../operator/workflow-engine.ts';
import { getScoringConfig } from '../../skills/acquisition/lead-scoring/index.ts';
import { isOfferActive } from '../../skills/operations/dealer-brain/index.ts';
import type { Reply, RequestContext } from '../http.ts';
import {
  FACTOR,
  ago,
  capabilityPill,
  dataBody,
  esc,
  fmtTime,
  href,
  pill,
  sectionHead,
  stepStatusPill,
  table,
  unfinishedButton,
  unfinishedTag,
  WORKFLOW_LABEL,
  workflowStatusPill,
} from '../render.ts';
import {
  CAPABILITY_NAME as CAP_NAME,
  humanAction,
  humanActor,
  humanAgent,
  humanCapability,
  humanEngine,
  humanLlm,
  humanProblem,
  humanProviderMode,
  humanSubject,
  scrubInternals,
} from '../humanize.ts';
import { hint } from '../hint.ts';
import { listDemoRequests } from '../demo-requests.ts';
import { UNFINISHED } from '../unfinished.ts';
import { decisionText, decisionTitle } from './decision-view.ts';
import { STEP_TITLE, TRIGGER_LABEL, buildRunView, type StepState } from './run-view.ts';
import { resultBox } from './components.ts';
import { dealerDecisions } from './overview.ts';
import { dealerTz, noDealerBody, renderPage, resolveDealer, type PageEnv } from './shell.ts';

const OFFER_TYPE_LABEL: Record<string, string> = { cash_discount: '现金优惠', finance: '金融方案', lease: '租赁方案', trade_in: '置换补贴', gift: '礼包', campaign: '活动' };
const INVENTORY_LABEL: Record<string, string> = { in_stock: '现车', in_transit: '在途', reserved: '已预订', sold: '已售' };
const KNOWLEDGE_LABEL: Record<string, string> = {
  brand: '品牌规范',
  communication_guideline: '沟通规范',
  prohibited_claim: '禁用说法',
  store: '门店',
  salesperson: '销售人员',
  campaign: '活动',
  faq: '常见问题',
  policy: '政策',
};

/** Where a row came from, as the store would say it — never the `console:操作人` / `import:…` string itself. */
function sourceLabel(source: string | null | undefined): string {
  const t = String(source ?? '');
  if (!t) return '未记录';
  if (/^console/i.test(t)) return '控制台录入';
  if (/import|bundle|backup/i.test(t)) return '批量导入';
  if (/^agent|^system/i.test(t)) return '系统自动';
  return scrubInternals(t) || '未记录';
}

/** `operator:console` is the console itself, not a colleague called “console”. */
function personLabel(actor: string | null | undefined): string {
  const t = humanActor(actor);
  return /^console$/i.test(t) ? '控制台操作' : t;
}

/** `08:00` → 每天 08:00 · `every:60` → 每小时一次. The stored expression is never shown. */
function runTimeLabel(cron: string): string {
  const every = /^every:(\d+)$/.exec(cron);
  if (every) {
    const mins = Number(every[1]);
    if (mins % 60 === 0 && mins >= 60) return mins === 60 ? '每小时一次' : `每 ${mins / 60} 小时一次`;
    return `每 ${mins} 分钟一次`;
  }
  if (/^\d{1,2}:\d{2}$/.test(cron)) return `每天 ${cron}`;
  return '按计划自动运行';
}

/** The word 「Dealer Brain」 is ours, not the store's. */
const storeWords = (text: string): string => text.replace(/Dealer ?Brain/gi, '门店资料');

/** `scrubInternals` leaves the punctuation that held the removed word: 「账号健康（，健康分100）」 → 「账号健康（健康分100）」. */
const readable = (text: string | null | undefined): string =>
  scrubInternals(text)
    .replace(/[（(]\s*[,，、·；;]\s*/g, '（')
    .replace(/\s*[,，、·；;]\s*[)）]/g, '）')
    .replace(/[（(]\s*[)）]/g, '');

/** Demo requests from the public site: the one place they are read, called back and ticked off. */
function demoRequestsBlock(ctx: PageEnv['runtime']['ctx'], nowMs: number): string {
  const all = listDemoRequests(ctx);
  const rows = all.map((d) => [
    `<div class="primary">${esc(d.name)}</div><div class="secondary">${esc(d.company)}${d.city ? ` · ${esc(d.city)}` : ''}</div>`,
    `<span class="small nowrap">${esc(d.phone)}</span>`,
    `<span class="small">${esc(d.accounts ?? '')}</span>${d.message ? `<div class="secondary">${esc(d.message)}</div>` : ''}`,
    `<span class="tiny muted nowrap">${esc(ago(d.created_at, nowMs))}</span>`,
    d.handled_at
      ? `<span class="tiny muted nowrap">${esc(d.handled_by ?? '')} 已联系</span>`
      : `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/demo-requests/${esc(d.id)}/handled" data-success="已标记">已联系</button>`,
  ]);
  const waiting = all.filter((d) => !d.handled_at).length;
  return `${sectionHead('官网预约', {
    note: waiting > 0 ? `${waiting} 个还没联系` : all.length ? '都联系过了' : '',
    help: ['在官网上点「预约演示」留下联系方式的人。打过电话之后点「已联系」，它就不会再算在待联系里。'],
  })}
${table(['谁', '电话', '账号数 / 想了解的', '时间', ''], rows, { compact: true, empty: '还没有人在官网预约演示。' })}`;
}

export function systemPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx, engine, scheduler } = env.runtime;
  const { dealer, dealers } = resolveDealer(ctx, rc);
  const importForm = `<form class="card stack" data-api="/api/dealer-brain/import" data-success="门店资料已导入">
  <label>粘贴备份内容${hint([
    '一次性导入门店、车型、库存、价格、优惠、销售、门店知识、账号与人设，用于换机器、恢复备份或从别的系统迁过来。',
    '库存按「快照」处理：文件里没出现的库存会被清零，这样不会把已经卖掉的车推荐给客户；选「合并」则只更新文件里写到的部分。',
    '建议先勾上「只校验不导入」跑一次，确认条数对得上再正式导入。文件格式不确定时找技术同事。',
  ])}<textarea class="code" name="bundle" data-type="json" data-label="备份内容" placeholder="把备份文件的内容粘贴到这里"></textarea></label>
  <label>或上传备份文件<input type="file" accept="application/json,.json" data-json-into="bundle"></label>
  <div class="form-grid">
    <label>库存模式<select name="inventory_mode"><option value="snapshot">快照（推荐）</option><option value="merge">合并</option></select></label>
    <label>人设模式<select name="persona_mode"><option value="seed">仅补充缺失人设</option><option value="overwrite">覆盖人设</option></select></label>
    <label class="row" style="flex-direction:row;align-items:center"><input type="checkbox" name="dry_run" checked> 只校验不导入</label>
  </div>
  <div class="row"><span class="spacer"></span><button class="btn btn-primary btn-sm" type="submit">校验 / 导入</button></div>
  ${resultBox}
</form>`;
  if (!dealer) {
    // Demo requests belong to the installation, not to a store: they are shown before any store exists too.
    const demos = listDemoRequests(ctx).length > 0 ? `${demoRequestsBlock(ctx, ctx.clock.now().getTime())}<div class="block"></div>` : '';
    return renderPage(env, rc, { title: '系统', active: 'system', dealer: null, dealers, h1: '系统', subtitle: '先导入门店资料，或者去「设置」新建门店', body: `${demos}<div id="dealer-brain">${noDealerBody()}${importForm.replace('data-success="门店资料已导入"', 'data-success="门店资料已导入" data-redirect="/"')}</div>` });
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
  // The account name is identical down the whole column. Printing it nine times reads as filler: it is printed once,
  // on the first row of each account, and left blank underneath.
  let lastAccount: string | null = null;
  const capRows = snaps.map((s) => {
    const who = s.account_id ? (nickname.get(s.account_id) ?? '已移除的账号') : '全店通用';
    const repeat = who === lastAccount;
    lastAccount = who;
    return [
    `<span class="nowrap">${repeat ? '' : esc(who)}</span>`,
    `<span class="nowrap">${esc(CAP_NAME[s.capability as keyof typeof CAP_NAME] ?? s.capability)}</span>`,
    capabilityPill(s.status),
    `<span class="small muted">${esc(humanCapability(s.capability, s.status, s.reason))}</span>`,
    `<span class="tiny muted nowrap">${esc(ago(s.checked_at, nowMs))}</span>`,
    ];
  });
  const llm = ctx.llm.status();
  const source = humanProviderMode(ctx.xhs.mode);
  const ai = humanLlm(llm.status);

  // workflows
  const defs = engine.list();
  const runs = engine.listRuns(ctx, { dealer_id: dealer.id, limit: 30 });
  const runRows = runs.map((r) => {
    const duration = r.finished_at ? Math.max(0, Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000)) : null;
    const resumable = RESUMABLE_STATUSES.includes(r.status) && r.status !== 'RUNNING';
    return [
      `<div class="primary">${esc(WORKFLOW_LABEL[r.workflow] ?? r.workflow)}</div><div class="secondary">${esc(TRIGGER_LABEL[r.trigger] ?? r.trigger)}</div>`,
      workflowStatusPill(r.status),
      `<span class="small">${esc(fmtTime(r.started_at, tz))}${duration !== null ? ` · 用时 ${esc(duration)} 秒` : ''}</span>${r.error ? `<div class="tiny muted">${esc(humanProblem(r.error) ?? '')}</div>` : ''}`,
      `<a class="btn btn-ghost btn-sm" href="${esc(href(`/system/runs/${r.id}`, { dealer: dealer.id }))}">查看进度</a>${resumable ? ` <button class="btn btn-ink btn-sm" data-action="call" data-url="/api/workflow-runs/${esc(r.id)}/resume" data-success="已恢复运行">恢复</button>` : ''}${r.status === 'RUNNING' ? ` <button class="btn btn-danger btn-sm" data-action="call" data-url="/api/workflow-runs/${esc(r.id)}/cancel" data-body="${dataBody({ reason: '运营取消' })}" data-confirm="确认取消？" data-success="已请求取消">取消</button>` : ''}`,
    ];
  });
  const runButtons = defs
    .filter((d) => d.name !== 'goal_execution')
    .map((d) => `<button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/workflows/${esc(d.name)}/run" data-body="${dataBody({ dealer_id: dealer.id })}" data-success="任务已启动">${esc(WORKFLOW_LABEL[d.name] ?? d.name)}</button>`)
    .join('');
  const schedules = scheduler.listSchedules(ctx, { dealer_id: dealer.id });
  const scheduleRows = schedules.map((s) => [
    esc(WORKFLOW_LABEL[s.workflow] ?? s.workflow),
    `<span class="small">${esc(runTimeLabel(s.cron))}</span>`,
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
      `<span class="tiny muted">${esc(sourceLabel(r.source))}</span>`,
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
  <div class="row"><span class="small muted">AI 只按这里填的数字讲优惠，不会自己编。</span><span class="spacer"></span><button class="btn btn-ink btn-sm" type="submit">创建</button></div>
</form>`;
  const knowledge = ctx.db.table('dealer_knowledge').query('group_id = ? AND (dealer_id IS NULL OR dealer_id = ?)', [dealer.group_id, dealer.id], { orderBy: 'category ASC, key ASC' });
  const knowledgeRows = knowledge.map((k) => [
    pill(KNOWLEDGE_LABEL[k.category] ?? k.category, 'neutral'),
    `<div class="primary" style="font-size:14px">${esc(k.title)}</div><div class="secondary">${esc(k.content.slice(0, 90))}</div>`,
    `<span class="tiny muted">${esc(sourceLabel(k.source))}</span>`,
  ]);

  // scoring
  const scoring = getScoringConfig(ctx, dealer.id);
  const scoringForm = `<form class="card stack" data-api="/api/scoring/${esc(dealer.id)}" data-method="PUT" data-success="评分规则已保存">
  <div class="small muted">权重加起来建议 100 分</div>
  <div class="form-grid">${Object.entries(scoring.weights).map(([k, x]) => `<label>${esc(FACTOR[k] ?? k)}<input type="number" min="0" max="100" name="weights.${esc(k)}" value="${esc(x)}"></label>`).join('')}</div>
  <div class="form-grid">${Object.entries(scoring.thresholds).map(([k, x]) => `<label>${esc({ candidate: '候选阈值', qualified: '合格阈值', high_intent: '高意向阈值', immediate: '立即跟进阈值' }[k] ?? k)}<input type="number" min="0" max="100" name="thresholds.${esc(k)}" value="${esc(x)}"></label>`).join('')}</div>
  <div class="row"><span class="spacer"></span><button class="btn btn-ink btn-sm" type="submit">保存</button></div></form>`;

  // DNC
  const dnc = ctx.db.table('contact_suppressions').findMany({}, { orderBy: 'created_at DESC', limit: 50 });
  const dncRows = dnc.map((s) => [
    `<span class="nowrap">${esc(s.platform_user_id)}</span>`,
    esc(readable(s.reason)),
    `<span class="tiny muted">${esc(personLabel(s.source))} · ${esc(fmtTime(s.created_at, tz))}</span>`,
  ]);

  // import public content
  const contentImport = `<form class="card stack" data-api="/api/public-content/import" data-success="已导入并分析公开内容">
  <input type="hidden" name="dealer_id" value="${esc(dealer.id)}">
  <label>粘贴笔记与评论${hint([
    '手上已经有一批导出的小红书公开笔记和评论时，可以直接倒进来让系统分析意向、生成线索，不用再搜一遍。',
    '这样进来的内容会被标成「导入」，不会冒充是刚刚实时抓到的。导出文件的格式找技术同事确认。',
  ])}<textarea class="code" name="notes" data-type="json" data-label="笔记内容" placeholder="把导出的内容粘贴到这里"></textarea></label>
  <div class="row"><span class="spacer"></span><button class="btn btn-ink btn-sm" type="submit">导入并分析</button></div>${resultBox}</form>`;

  const decisions = dealerDecisions(ctx, dealer.id, 40);
  const subjectCell = (type: string, id: string) => {
    const s2 = humanSubject(ctx, type, id, dealer.id);
    return s2.href ? `<a class="link small" href="${esc(s2.href)}">${esc(s2.label)}</a>` : `<span class="small">${esc(s2.label)}</span>`;
  };
  const decisionRows = decisions.map((d) => {
    const why = readable(decisionText(d));
    return [
      `<b class="small">${esc(decisionTitle(d.decision_type))}</b><div class="tiny muted">${esc(humanAgent(d.agent))}</div>${why ? `<div class="tiny">${esc(why.slice(0, 160))}</div>` : ''}`,
      subjectCell(d.subject_type, d.subject_id),
      `<span class="num">${esc(Math.round(d.confidence * 100))}%</span> ${pill(humanEngine(d.engine), 'neutral')}`,
      `<span class="tiny muted">${esc(ago(d.created_at, nowMs))}</span>`,
    ];
  });
  const events = ctx.db.table('audit_events').findMany({}, { orderBy: 'created_at DESC', limit: 40 });
  const eventRows = events.map((e) => [
    `<span class="small">${esc(humanAction(e.action))}</span>`,
    `<span class="small">${esc(personLabel(e.actor))}</span>`,
    subjectCell(e.entity_type, e.entity_id),
    `<span class="tiny muted">${esc(ago(e.created_at, nowMs))}</span>`,
  ]);


  const body = `
${demoRequestsBlock(ctx, nowMs)}
<div class="block">${sectionHead('小红书连接', {
    note: `${source.label} · ${ai.label}`,
    help: [
      `${source.note}。${ai.note}。`,
      '下面每一行说明 AI 现在能替门店做哪一类动作。某一项不可用时，靠它吃饭的自动动作会停下来等人，不会偷偷跳过。',
      '账号掉登录是最常见的原因，去「账号」页重新扫码就能恢复；如果提示需要技术同事处理，说明是这台机器上的服务没起来。',
    ],
    right: `<button class="btn btn-ink btn-sm" data-action="call" data-url="/api/accounts/sync" data-body="${dataBody({ dealer_id: dealer.id })}" data-success="已重新检测">重新检测</button>`,
  })}
${table(['账号', '能力', '状态', '说明', '检测时间'], capRows, { compact: true, empty: '还没有检测记录，点右上角「重新检测」。' })}</div>
<div class="block">${sectionHead('自动任务', {
    note: '系统每天替门店做的事',
    help: [
      '找线索、写内容、处理回复这些活儿由系统按点自己跑，不用人盯着。',
      '下面的按钮是立刻手动跑一次，通常只在排查问题或者想马上出结果时才点。',
      '每一步的结果都存下来了：中途断了可以「恢复」，从断的那一步接着做，不会重复发私信或者重复发笔记。',
    ],
    // Nine run-now buttons across two wrapped lines read as a tag cloud. They are a rare action, so they fold away.
    right: `<details class="filters-more"><summary>手动跑一次</summary><div class="filters-more-row">${runButtons}</div></details>`,
  })}${table(['任务', '状态', '时间', '操作'], runRows, { compact: true, empty: '还没有任务运行' })}</div>
<div class="block">${sectionHead('运行时间', {
    note: '按门店所在城市的时间',
    help: ['这里只决定上面的自动任务什么时候跑。停用之后这项任务不会自己运行，只能手动点。', '执行的具体时间暂时改不了，需要调整先找技术同事。'],
    right: unfinishedButton('schedule_edit_time', '修改时间'),
  })}${table(['任务', '运行时间', '状态', '上次运行', ''], scheduleRows, { compact: true, empty: '还没有安排' })}</div>
<div class="block" id="dealer-brain">${sectionHead('门店资料', {
    note: '价格、参数、库存、优惠的唯一出处',
    help: [
      'AI 写笔记、发私信、回客户时报的每一个价格、参数、颜色和库存，只能从这里取，取不到就不说——所以这里不准，外面全都不准。',
      '「导出备份」把当前全部门店资料存成一个文件；换机器、系统出问题或者要交给技术同事排查时，用它整包导回来。',
    ],
    right: `${unfinishedButton('inventory_sync', '外部库存同步')} <a class="btn btn-ghost btn-sm" href="/api/dealer-brain/export?dealer_id=${esc(dealer.id)}">导出备份</a>`,
  })}
  ${importForm}
  <div class="block" style="margin-top:28px">${sectionHead('库存', { note: '影响 AI 敢不敢向客户推荐这台车', right: unfinishedButton('inventory_create', '新增库存') })}${table(['车辆', '状态 / 数量 / 标价', '来源', ''], invRows, { compact: true, empty: '还没有库存' })}</div>
  <div class="block" style="margin-top:28px">${sectionHead('优惠政策', { note: '只有这里写了的优惠，AI 才敢对客户讲' })}${table(['政策', '状态', '金额 / 截止', ''], offerRows, { compact: true, empty: '还没有优惠' })}${offerForm}</div>
  <div class="block" style="margin-top:28px">${sectionHead('门店知识', {
    note: '品牌规范、禁用说法、常见问题',
    help: ['这些条目会进到 AI 的写作和回复里：写了「禁用说法」的内容，AI 不会说；写了常见问题的答案，AI 会照着答。'],
    right: unfinishedButton('knowledge_edit', '新增 / 编辑知识'),
  })}${table(['类别', '内容', '来源'], knowledgeRows, { compact: true, empty: '还没有知识条目' })}</div>
</div>
<div class="block">${sectionHead('线索评分规则', {
    note: '决定一条线索算不算值得跟',
    help: [
      '系统给每个人打 0–100 分，下面的权重决定各项因素占多少分：比如把「购买意向」调高，说得越像马上要买的人排得越靠前。',
      '阈值决定分数到多少算候选、合格、高意向、要立刻跟。调高会更准但线索更少，调低线索更多但要销售自己筛。',
      '改动保存后对新线索立刻生效，已有线索的分数不会倒回去重算。',
    ],
  })}${scoringForm}</div>
<div class="block">${sectionHead('导入公开内容', { note: '手上已有导出的笔记和评论时用' })}${contentImport}</div>
<div class="block">${sectionHead('不再联系名单', {
    note: '全部门店和账号共用',
    help: ['加进来的人，任何账号都不会再给他发私信，也不会再被当成线索推给销售。客户明确说了别再联系，就加进来。', '加进来之后目前不能在这里删除，需要技术同事处理。'],
  })}
  <form class="inline-form" data-api="/api/dnc" data-success="已加入不再联系" style="margin-bottom:12px"><input type="text" name="platform_user_id" placeholder="小红书用户主页 ID" required><input type="text" name="reason" placeholder="原因" required><button class="btn btn-danger btn-sm" type="submit">加入名单</button></form>
  ${table(['小红书用户', '原因', '谁加的'], dncRows, { compact: true, empty: '名单是空的' })}</div>
<div class="block" id="decisions">${sectionHead('AI 做过的判断', {
    note: '每一条都记着，可以逐条回看',
    help: ['AI 每判断一次——这个人是不是买家、这条私信怎么写、这篇笔记能不能发——都会记下依据和把握程度。客户投诉或者结果不对时，从这里往回查。'],
  })}${table(['AI 做了什么', '对象', '把握', '时间'], decisionRows, { compact: true, empty: '暂无记录' })}</div>
<div class="block">${sectionHead('操作记录', {
    note: '谁在什么时候动了什么',
    help: ['门店资料、账号、线索、内容上的每一次改动都记在这里，人做的和系统做的都记。'],
  })}${table(['做了什么', '谁', '对象', '时间'], eventRows, { compact: true, empty: '暂无记录' })}</div>
<div class="block" id="unfinished">${sectionHead('还没做完的功能', {
    note: `${Object.keys(UNFINISHED).length} 项`,
    help: ['这些功能界面上看不到，也不会假装能用。小红书本身不支持的能力（比如读私信收件箱）不在这张表里。'],
  })}${table(
  ['页面', '功能', '还缺什么'],
  Object.entries(UNFINISHED).map(([key, f]) => [
    `<span class="nowrap">${esc(f.page)}</span>`,
    `${esc(storeWords(f.title))}${unfinishedTag(key as keyof typeof UNFINISHED)}`,
    `<span class="small muted">${esc(storeWords(f.missing))}</span>`,
  ]),
  { compact: true },
)}</div>`;
  return renderPage(env, rc, { title: '系统', active: 'system', dealer, dealers, h1: '系统',
    help: [
      '这一页是给你和技术同事排查问题用的：小红书连上了没有、每天的自动任务跑没跑、门店资料全不全、系统都做过什么。',
      '平时不用来这里。只有当某件事没按预期发生——没找到客户、笔记没发出去、私信没生成——才过来看一眼是哪一环停了。',
      '出现「需要技术同事处理」的时候，把这一页给他们看就行。',
    ],
    subtitle: dealer.name,
    body });
}

const STEP_STATE_LABEL: Record<StepState, string> = { done: '完成', running: '进行中', failed: '未完成', skipped: '已跳过', waiting: '等待中' };

function minutesLabel(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return '不到 1 分钟';
  if (mins < 60) return `${mins} 分钟`;
  return `${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟`;
}

export function runDetailPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx, engine } = env.runtime;
  const { run, steps } = engine.getRun(ctx, rc.params.id);
  const { dealers } = resolveDealer(ctx, rc);
  const dealer = dealers.find((d) => d.id === run.dealer_id) ?? null;
  const tz = dealerTz(dealer);
  const nowMs = ctx.clock.now().getTime();
  let defs: { key: string; description: string }[] = [];
  try {
    defs = engine.has(run.workflow) ? engine.resolveSteps(engine.get(run.workflow), run.input) : [];
  } catch {
    defs = [];
  }
  const resumable = RESUMABLE_STATUSES.includes(run.status) && run.status !== 'RUNNING';
  const view = buildRunView(run, steps, defs, resumable);
  const goal = run.goal_id ? ctx.db.table('operator_goals').get(run.goal_id) : null;
  const startedMs = Date.parse(run.started_at);
  const timing = run.finished_at ? `用时 ${minutesLabel(Date.parse(run.finished_at) - startedMs)}` : `已运行 ${minutesLabel(nowMs - startedMs)}`;
  const dealerParam = dealer ? { dealer: dealer.id } : {};

  const actions = [
    resumable ? `<button class="btn btn-primary" data-action="call" data-url="/api/workflow-runs/${esc(run.id)}/resume" data-success="已从中断处继续">从中断处继续</button>` : '',
    view.running ? `<button class="btn btn-danger" data-action="call" data-url="/api/workflow-runs/${esc(run.id)}/cancel" data-body="${dataBody({ reason: '运营取消' })}" data-confirm="确认取消这个任务？再点一次" data-success="已请求取消">取消任务</button>` : '',
  ].join('');
  const segments = view.steps.map((st) => `<span class="run-seg is-${st.state}" title="${esc(`${st.title}：${STEP_STATE_LABEL[st.state]}`)}"></span>`).join('');
  const summary = `<section class="st-card run-summary is-${view.tone}"${view.running ? ' data-autorefresh="5000"' : ''}>
  <div class="run-head">
    <div class="run-head-text">
      <p class="run-meta">${esc(view.trigger)}，${esc(fmtTime(run.started_at, tz))} 开始，${esc(timing)}</p>
      <h2 class="run-headline">${esc(view.headline)}</h2>
      ${goal ? `<p class="run-goal">经营目标：${esc(goal.text)}</p>` : ''}
    </div>
    ${actions ? `<div class="run-actions">${actions}</div>` : ''}
  </div>
  <div class="run-progress" role="progressbar" aria-label="任务进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(view.percent)}">${segments}</div>
  <p class="run-progress-text"><b class="num">${esc(view.done)}</b> / ${esc(view.total)} 步完成${view.skipped ? `，跳过 ${esc(view.skipped)} 步` : ''}${view.running ? `<span class="num">进度 ${esc(view.percent)}%</span><span class="run-live">页面每 5 秒自动更新</span>` : ''}</p>
  ${view.advice ? `<div class="banner banner-${view.tone === 'bad' ? 'red' : 'amber'}">${esc(view.advice)}</div>` : ''}
</section>`;

  const timeline = `<ol class="run-steps">${view.steps
    .map(
      (st) => `<li class="run-step is-${st.state}"><span class="run-step-mark" aria-hidden="true"></span><div class="run-step-body">
  <div class="run-step-top"><span class="run-step-title">${esc(st.title)}</span><span class="run-step-state">${esc(STEP_STATE_LABEL[st.state])}</span></div>
  ${st.summary ? `<p class="run-step-summary">${esc(st.summary)}</p>` : ''}${st.problem ? `<p class="run-step-problem">${esc(st.problem)}</p>` : ''}${st.purpose && !st.summary && !st.problem ? `<p class="run-step-purpose">${esc(st.purpose)}</p>` : ''}
</div></li>`,
    )
    .join('')}</ol>`;

  // The full step log stays one click away; the raw record itself belongs to the server log, not to this page.
  const techRows = steps.map((s) => [
    `<span class="small">${esc(STEP_TITLE[s.step_key] ?? scrubInternals(s.step_key.replace(/_/g, ' ')) ?? '一个步骤')}</span>`,
    `<span class="small">${esc(humanAgent(s.agent))}</span>`,
    stepStatusPill(s.status),
    `<span class="small">${esc(s.started_at ? fmtTime(s.started_at, tz) : '未开始')}${s.attempts > 1 ? ` · 试了 ${esc(s.attempts)} 次` : ''}</span>`,
    `<span class="tiny muted">${esc(humanProblem(s.error) ?? '')}</span>`,
  ]);
  const tech = `<details class="tech-details"><summary>每一步的执行记录</summary>
  <p class="small muted">${esc(view.trigger)} · 状态 ${workflowStatusPill(run.status)}</p>
  ${run.error ? `<p class="small">${esc(humanProblem(run.error) ?? '')}</p>` : ''}
  ${table(['步骤', '执行者', '状态', '时间', '说明'], techRows, { compact: true, empty: '没有步骤记录' })}
</details>`;

  const body = `${summary}
<section class="st-section run-section"><div class="section-head"><h2 class="section-title">步骤</h2><a class="st-link" href="${esc(href('/system', dealerParam))}">返回任务列表</a></div>${timeline}</section>
${tech}`;
  return renderPage(env, rc, {
    title: '任务进度',
    active: 'system',
    dealer,
    dealers,
    h1: esc(WORKFLOW_LABEL[run.workflow] ?? '自动任务'),
    help: ['这一次任务的每一步做了什么、结果怎么样。中途断了可以从断的那一步接着做，不会重复发私信或者重复发笔记。'],
    subtitle: dealer?.name ?? '',
    body,
  });
}
