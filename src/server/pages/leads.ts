/** 线索: lead inbox cards (§18 — evidence never hidden) and the complete lead detail with outreach review workflow. */
import type { AppContext } from '../../app/context.ts';
import {
  LEAD_STAGES,
  SCORE_TIERS,
  SIGNAL_SOURCE_TYPES,
  type DmChannel,
  type GuardResult,
  type Lead,
  type LeadStage,
  type Outreach,
  type ScoreTier,
} from '../../core/types.ts';
import { getBrandInfo } from '../../domain/automotive-lexicon.ts';
import { avatarHtml as avatar } from './components.ts';
import { DM_SEND_UNKNOWN_MARK } from '../../providers/xhs/dm-send.ts';
import { SCREEN_ROLE_LABEL, type ScreenRole } from '../../skills/acquisition/lead-discovery/llm-screen.ts';
import { lostReasonText } from '../../skills/operations/crm/index.ts';
import { UNKNOWN_MODEL_LABEL, getLeadDetail, type LeadDetail } from '../../skills/operations/analytics/index.ts';
import { listOutreachQueue, type OutreachQueueItem } from '../../skills/sales/outreach/index.ts';
import type { Reply, RequestContext } from '../http.ts';
import { inboxQueryFrom, leadInbox, type LeadCardView } from '../api/leads.ts';
import {
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
  previewText,
  unfinishedButton,
} from '../render.ts';
import { hint } from '../hint.ts';
import { humanActor, humanAgent, scrubInternals } from '../humanize.ts';
import { decisionText, decisionTitle } from './decision-view.ts';
import { dealerTz, latestCapability, noDealerBody, renderPage, resolveDealer, type PageEnv } from './shell.ts';

const SOURCE_LABEL: Record<string, string> = { post: '发布笔记', comment: '评论', profile: '主页笔记', reply: '私信回复', import: '导入' };
const TIMEFRAME_LABEL: Record<string, string> = { this_week: '本周', soon: '近期', this_month: '本月内', within_3_months: '三个月内', later: '较晚/观望' };

/**
 * 「大模型复核」 is how the pipeline names itself in stored reasons and evidence labels. A salesperson reads what
 * actually happened: the AI read the person's own words. The stored text is untouched — this only rewrites the display.
 */
function sayHuman(text: string | null | undefined): string {
  return String(text ?? '')
    .replace(/大模型复核（不是本地在市买家）[：:]\s*/g, 'AI 看过他的原话：')
    .replace(/大模型复核[：:]\s*/g, 'AI 看过他的原话：')
    .replace(/大模型复核/g, 'AI 看过原话')
    // 「阈值」 is a word from the scoring config, not from a showroom: the number stays, the sentence changes.
    .replace(/线索分\s*(\d+)（[^）]*）达到(候选|合格)阈值\s*(\d+)/g, (_m, score, kind, cut) => `意向 ${score} 分，超过 ${cut} 分就算${kind}`)
    .replace(/达到(候选|合格)阈值\s*[（(]?≥?\s*(\d+)\s*[)）]?/g, (_m, kind, cut) => `超过 ${cut} 分就算${kind}`)
    .replace(/线索分\s*(\d+)\s*低于自动发送阈值\s*(\d+)[，,]?\s*需人工审核/g, (_m, score, cut) => `意向 ${score} 分，没超过 ${cut} 分，发之前要人工看一眼`)
    .replace(/线索分\s*(\d+)\s*低于合格阈值\s*(\d+)/g, (_m, score, cut) => `意向 ${score} 分，没超过 ${cut} 分`)
    .replace(/线索分\s*(\d+)/g, (_m, score) => `意向 ${score} 分`)
    // a scrubbed English state leaves a dangling separator behind: 「账号健康（，健康分100）」
    .replace(/[（(]\s*[，,、]\s*/g, '（')
    // an English state scrubbed out of the middle of a sentence leaves an empty bracket behind
    .replace(/[（(]\s*[)）]/g, '');
}

/**
 * Evidence comes in two lengths: a label ('询问现车') and a sentence ('AI 看过他的原话：本人在等车提车配置…').
 * A 20-character sentence in a tag is not a tag, so the short ones stay chips and the long ones become read-as-text
 * lines underneath. Mixing both in one wrapping chip row is what made this look like generated filler.
 */
function evidenceBlock(items: { label: string; quote?: string | null }[], limit: number): string {
  const seen = items.slice(0, limit).map((e) => ({ text: sayHuman(e.label), quote: e.quote ?? '' }));
  const chips = seen.filter((e) => Array.from(e.text).length <= 12);
  const lines = seen.filter((e) => Array.from(e.text).length > 12);
  return `${chips.length ? `<div class="chips">${chips.map((e) => `<span class="ev" title="${esc(e.quote)}">${esc(e.text)}</span>`).join('')}</div>` : ''}${
    lines.length ? `<ul class="ev-lines">${lines.map((e) => `<li title="${esc(e.quote)}">${esc(e.text)}</li>`).join('')}</ul>` : ''
  }`;
}

/** 一个车型名里的英文品牌一律显示中文：`XPeng G6` → `小鹏 G6`，`BMW` → `宝马`。 */
function zhModelLabel(label: string): string {
  const s = String(label ?? '').trim();
  if (!s) return label;
  const head = s.split(' ')[0] ?? '';
  const zh = getBrandInfo(head)?.brand_zh;
  if (!zh) return label;
  const rest = s.slice(head.length).trim();
  return rest ? `${zh} ${rest}` : zh;
}

/** The 10 pre-send guards (ARCHITECTURE §6), in the words of the person who has to act on them. */
const GUARD_LABEL: Record<GuardResult['check'], string> = {
  duplicate: '有没有重复私信',
  previous_contact: '以前联系过没有',
  factual_verification: '说的价格和政策对不对',
  account_health: '这个号状态好不好',
  rate_limit: '今天发得多不多',
  platform_rules: '有没有踩小红书的规矩',
  negative_feedback: '对方是不是说过别再联系',
  approval_policy: '需不需要人工审一遍',
  provider_capability: '这个号现在能不能发',
  ownership: '是不是该由这个号来发',
};

/**
 * Score factors are stored with the reason the engine wrote at the time, and older rows still carry English state
 * names. The page renders them through the same 说人话 pass as everything else.
 */
const humanFactors = <T extends { reason: string }>(factors: readonly T[]): T[] => factors.map((f) => ({ ...f, reason: sayHuman(scrubInternals(f.reason)) }));

/** 0–100% is a precision the system does not have; three plain words are honest. */
const confidenceWord = (confidence: number): string => (confidence >= 0.8 ? '很确定' : confidence >= 0.55 ? '比较确定' : '不太确定');

const ISO_TIME_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
const ACTOR_RE = /\b(?:operator|user|agent|system):[^\s，。、）)]+/g;

/**
 * The manual-send steps are written by the outreach skill, which has no timezone and no display names. The page puts
 * them in the store's own clock and words: an ISO stamp becomes `09/20 09:18`, `operator:张三` becomes 张三.
 */
function humanInstruction(step: string, tz: string): string {
  return String(step ?? '')
    .replace(ISO_TIME_RE, (m) => fmtTime(m, tz))
    .replace(ACTOR_RE, (m) => humanActor(m))
    .replace(/\b(?:REQUIRES_REVIEW|REQUIRES_AUTH|UNAVAILABLE|AVAILABLE|SENT_MANUALLY|SENT|FAILED|PENDING)\b\s*[:：]?\s*/g, '')
    .trim();
}

function options<T extends string>(values: readonly T[], selected: string | undefined, label: (v: T) => string, empty: string): string {
  return `<option value="">${esc(empty)}</option>${values.map((x) => `<option value="${esc(x)}"${x === selected ? ' selected' : ''}>${esc(label(x))}</option>`).join('')}`;
}

/**
 * What the words on this page mean, for the states this store actually has (counted live). Every definition describes
 * a real rule in the pipeline: tiers come from the scoring thresholds, stages from the CRM funnel, and the close
 * reasons from what was recorded when the lead was closed.
 */
const TIER_MEANING: Partial<Record<ScoreTier, string>> = {
  immediate: '分数最高的一档：本人在问价格或现车，且就在目标地区，当天联系',
  high_intent: '有明确购车动作（问落地价、问提车周期、已试驾），优先联系',
  qualified: '达到合格线，可以分配账号并写私信',
  candidate: '有购车迹象但证据还不够，先继续观察，新的发言会重新评分',
  none: '未达候选线，只作为公开信号留存，不进入跟进',
};

const STAGE_MEANING: Partial<Record<LeadStage, string>> = {
  DISCOVERED: '刚从公开内容里发现，还没评分',
  CANDIDATE: '分数未到合格线，暂不联系',
  QUALIFIED: '已达合格线，等待分配负责账号',
  ASSIGNED: '已分配账号，等待生成私信',
  OUTREACH_READY: '私信草稿已写好，等你审核后在小红书人工发送',
  CONTACTED: '销售已发出私信，等待对方回复',
  REPLIED: '对方回复了，对话在「对话」页',
  SALES_QUALIFIED: '销售确认了预算、车型和时间，是真实购车需求',
  CONTACT_ACQUIRED: '已拿到联系方式',
  APPOINTMENT: '已约好到店时间',
  VISITED: '已到店',
  NEGOTIATING: '正在谈价',
  WON: '已成交',
  LOST: '不再跟进。可能是机器判定不是目标客户，也可能是销售跟进后放弃',
};

/** Close reasons (`lost_reason`) and the screen verdicts recorded with them. */
const CLOSE_MEANING: Record<string, string> = {
  llm_screen: 'AI 看过他的原话后，判断他不是本地要买车的人，自动关掉（具体判断见下一组）',
  industry_account: '研究对方主页时，按账号名认出是门店或销售账号',
  out_of_area: '本人确实在买车，但 IP 属地或本人写明的地点不在经营目标指定的地区',
  owner: '本人已经买了或已下订，不在市场上',
  dealer: '车商、销售或中介，在评论区招揽客户',
  advice: '在回答或建议别人，本人没有表达购车需求',
  chatter: '闲聊、吐槽、玩笑，与购车无关',
  buyer: '本人在买车（这一档只有在地区不符时才会被关闭）',
};

function legend(ctx: AppContext, dealerId: string): string {
  const cells = (sql: string, label: (key: string) => string, meaning: Record<string, string | undefined>) =>
    ctx.db
      .all<{ k: string | null; n: number }>(sql, dealerId)
      .filter((r) => r.k !== null && meaning[r.k])
      .map((r) => `<div class="legend-term">${esc(label(r.k as string))}<span class="legend-n">${esc(r.n)}</span></div><div>${esc(meaning[r.k as string] ?? '')}</div>`);

  const tiers = cells(
    "SELECT tier AS k, COUNT(*) AS n FROM leads WHERE dealer_id = ? AND stage NOT IN ('LOST','WON') GROUP BY tier",
    (k) => TIER[k as ScoreTier]?.[0] ?? k,
    TIER_MEANING,
  );
  const stages = cells('SELECT stage AS k, COUNT(*) AS n FROM leads WHERE dealer_id = ? GROUP BY stage', (k) => LEAD_STAGE[k as LeadStage]?.[0] ?? k, STAGE_MEANING);
  const closed = cells("SELECT lost_reason AS k, COUNT(*) AS n FROM leads WHERE dealer_id = ? AND stage = 'LOST' GROUP BY lost_reason", (k) => sayHuman(lostReasonText(k)), CLOSE_MEANING);
  const verdicts = cells(
    `SELECT json_extract(e.details, '$.role') AS k, COUNT(*) AS n FROM audit_events e
     WHERE e.action = 'lead.rescreened' AND e.entity_id IN (SELECT id FROM leads WHERE dealer_id = ?) GROUP BY k`,
    (k) => (k === 'out_of_area' ? '不在目标地区' : (SCREEN_ROLE_LABEL[k as ScreenRole] ?? k)),
    CLOSE_MEANING,
  );
  const block = (title: string, list: string[]) => (list.length ? `<h4 class="legend-head">${esc(title)}</h4><div class="legend-grid">${list.join('')}</div>` : '');
  const body = [
    block('意向分层（数字是当前进行中的线索数）', tiers),
    block('阶段（数字含已关闭线索）', stages),
    block('关闭原因', closed),
    block('AI 看过原话后的判断', verdicts),
  ].join('');
  if (!body) return '';
  return `<details class="legend"><summary>这些状态代表什么</summary><div class="legend-body">${body}<div class="legend-note">关闭的线索不会被删除。${hint([
    '原话、出处和判断理由都留着，点「显示已流失 / 已成交」就能看到。',
    '要是判断错了，打开那条线索可以重新打开它。',
  ])}</div></div></details>`;
}

/**
 * How many different values each filter could pick from **in the list the operator is looking at** (open leads, or all
 * of them when 已流失 is shown). A dropdown that cannot split that list is dead furniture and is not rendered.
 */
function filterVariants(ctx: AppContext, dealerId: string, openOnly: boolean): { stage: number; source_type: number } {
  const scope = openOnly ? " AND l.stage NOT IN ('LOST', 'WON')" : '';
  const count = (expr: string, from = 'leads l') => Number(ctx.db.get<{ n: number }>(`SELECT COUNT(DISTINCT ${expr}) AS n FROM ${from} WHERE l.dealer_id = ?${scope}`, dealerId)?.n ?? 0);
  return {
    stage: count('l.stage'),
    source_type: count('s.source_type', 'lead_signals s JOIN leads l ON l.id = s.lead_id'),
  };
}

const closedCount = (ctx: AppContext, dealerId: string): number =>
  Number(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM leads WHERE dealer_id = ? AND stage IN ('LOST', 'WON')", dealerId)?.n ?? 0);

/**
 * The inbox is a work table, not a set of cards: every lead is one row, and the six things a salesperson needs are
 * aligned into columns (alignment does the grouping, so no coloured badge soup). The whole row links to the lead;
 * the 原帖 link inside it keeps working because the row link is a stretched pseudo-element, not a wrapping anchor.
 * Narrow screens drop the two reference columns (判断依据, 来源) first, then stack.
 */
const ROW_STATUS: Record<string, { text: string; tone: 'wait' | 'stop' | 'calm' }> = {
  READY_FOR_REVIEW: { text: '私信待审核', tone: 'wait' },
  APPROVED: { text: '待人工发送', tone: 'wait' },
  BLOCKED: { text: '私信被拦下', tone: 'stop' },
  FAILED: { text: '发送失败', tone: 'stop' },
  SENT: { text: '已发送', tone: 'calm' },
  SENT_MANUALLY: { text: '已发送', tone: 'calm' },
  DRAFT: { text: '草稿', tone: 'calm' },
  CANCELLED: { text: '私信已作废', tone: 'calm' },
};

/** What this lead is waiting for (the status column). */
function rowStatus(c: LeadCardView): { text: string; tone: 'wait' | 'stop' | 'calm' } {
  if (c.suppressed) return { text: '勿扰', tone: 'stop' };
  if (c.stage === 'LOST') return { text: '已流失', tone: 'calm' };
  if (c.stage === 'WON') return { text: '已成交', tone: 'calm' };
  const outreach = c.outreach_status ? ROW_STATUS[c.outreach_status] : undefined;
  if (outreach) return outreach;
  if (!c.assigned_account) return { text: c.tier === 'candidate' || c.tier === 'none' ? '继续观察' : '待分配账号', tone: 'calm' };
  return { text: '待写私信', tone: 'wait' };
}

/**
 * Row preview of the signal: Xiaohongshu topic tags (`#小鹏[话题]#`) and emoji codes (`[哭惹R]`) are dropped so the
 * sentence is readable at a glance. The stored text is untouched; the detail page shows it verbatim.
 */
/** 'IP属地：浙江' is long in a row; the qualifier stays (it is not a stated place), the punctuation goes. */
const shortPlace = (label: string): string => label.replace(/^IP属地[:：]\s*/, 'IP 属地 ');

/** A model label that only names the brand repeats on every row of a single-brand store: drop it. */
const namesModel = (label: string): boolean => label !== UNKNOWN_MODEL_LABEL && /[\s\d]/.test(label);

const ROW_COLUMNS = ['意向', '客户与原话', '判断依据', '来源', '负责账号', '状态'] as const;

/**
 * Avatar of a person or a managed account. Xiaohongshu images are fetched through the console's own proxy
 * (`/media/xhs-image`, xhscdn only); when the platform never showed an avatar the circle keeps the first character of
 * the name, so an unknown face never looks like a stock photo.
 */
function leadRow(c: LeadCardView, dealerId: string, nowMs: number): string {
  const hot = c.tier === 'high_intent' || c.tier === 'immediate';
  const status = rowStatus(c);
  const facts = [c.username, shortPlace(c.location_label), namesModel(c.model_label) ? zhModelLabel(c.model_label) : '', ago(c.source.signal_at, nowMs)].filter(Boolean);
  const chips = c.intent_chips.slice(0, 2).map(sayHuman);
  const restChips = c.intent_chips.slice(2).map(sayHuman);
  const sourceType = c.source.type ? (SOURCE_LABEL[c.source.type] ?? c.source.type) : '来源未知';
  const quote = c.original_signal ? previewText(c.original_signal) : '';
  // a note's own text already IS the quote: repeating its title in the source column says nothing
  const title = c.source.post_title && !quote.includes(c.source.post_title) ? c.source.post_title : '';
  const post = title ? `${esc(sourceType)}《${esc(title)}》` : esc(sourceType);
  return `<div class="lead-row${hot ? ' is-hot' : ''}">
  <div class="lead-col-score">
    <a class="lead-open" href="${esc(href(`/leads/${c.lead_id}`, { dealer: dealerId }))}"><span class="lead-score${hot ? ' hot' : ''}">${esc(Math.round(c.score))}</span></a>
    <span class="lead-tier">${esc(TIER[c.tier][0])}</span>
  </div>
  <div class="lead-col-signal">
    ${avatar(c.username, c.avatar_url)}
    <span class="lead-row-quote">${esc(quote || '（还没有他说的话）')}</span>
    <span class="lead-row-meta">${c.data_mode && c.data_mode !== 'live' ? `<span class="row-flag">${esc(DATA_MODE[c.data_mode][0])}</span>` : ''}${facts.map((f) => esc(f)).join(' · ')}${c.signal_count > 1 ? ` · ${esc(c.signal_count)} 条信号` : ''}</span>
  </div>
  <div class="lead-col-why">${chips.map((x) => `<span class="ev">${esc(x)}</span>`).join('')}${restChips.length ? `<span class="ev ev-more" title="${esc(restChips.join('；'))}">+${esc(restChips.length)}</span>` : ''}</div>
  <div class="lead-col-origin">
    <span class="lead-origin-post">${post}</span>
    <span class="lead-origin-query">${c.source.query_text ? `搜索词「${esc(c.source.query_text)}」` : '手动导入'}${c.source.url ? ` · <a class="link" href="${esc(c.source.url)}" target="_blank" rel="noopener noreferrer">原帖</a>` : ''}</span>
  </div>
  <div class="lead-col-owner">${
    c.assigned_account
      ? `${avatar(c.assigned_account.nickname, c.assigned_account.avatar_url, 'avatar-sm')}<span class="lead-owner-name">${esc(c.assigned_account.nickname)}</span>`
      : '<span class="muted">未分配</span>'
  }</div>
  <div class="lead-col-status is-${status.tone}">${esc(status.text)}<span class="lead-stage">${esc(LEAD_STAGE[c.stage][0])}</span></div>
</div>`;
}

export function leadsPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const { dealer, dealers } = resolveDealer(ctx, rc);
  if (!dealer) return renderPage(env, rc, { title: '线索', active: 'leads', dealer: null, dealers, h1: '线索', subtitle: '尚未配置门店', body: noDealerBody() });
  const q = inboxQueryFrom(rc, dealer.id);
  const cards = leadInbox(ctx, q);
  const nowMs = ctx.clock.now().getTime();
  const f = q.filters;
  // Only filters that can actually split this store's leads are shown; the rest live under 更多筛选 (and always appear
  // when they carry a value, so a filter from a bookmarked URL can still be seen and cleared).
  const variants = filterVariants(ctx, dealer.id, q.open_only !== false);
  const bar = [
    `<input type="text" name="q" value="${esc(q.q ?? '')}" placeholder="用户 / 原话 / 车型" aria-label="搜索">`,
    `<select name="tier" aria-label="分层">${options(SCORE_TIERS, q.tier, (t) => TIER[t][0], '全部分层')}</select>`,
    `<input type="text" name="location" value="${esc(f.location ?? '')}" placeholder="地区">`,
  ];
  const more: string[] = [];
  const offer = (html: string, usable: boolean) => {
    if (usable) more.push(html);
  };
  offer(
    `<select name="stage" aria-label="阶段">${options(LEAD_STAGES, f.stage, (x) => LEAD_STAGE[x][0], '全部阶段')}</select>`,
    Boolean(f.stage) || variants.stage > 1,
  );
  offer(
    `<select name="source_type" aria-label="信号类型">${options(SIGNAL_SOURCE_TYPES, f.source_type, (x) => SOURCE_LABEL[x] ?? x, '全部信号类型')}</select>`,
    Boolean(f.source_type) || variants.source_type > 1,
  );
  const moreActive = Boolean(f.stage || f.source_type);
  const filters = `<form class="filters" method="get" action="/leads">
  <input type="hidden" name="dealer" value="${esc(dealer.id)}">
  ${bar.join('\n  ')}
  <button class="btn btn-ink btn-sm" type="submit">筛选</button>
  <a class="btn btn-ghost btn-sm" href="${esc(href('/leads', { dealer: dealer.id }))}">清除</a>
  ${
    q.open_only === false || f.stage
      ? `<a class="btn btn-ghost btn-sm" href="${esc(href('/leads', { dealer: dealer.id }))}">只看进行中</a>`
      : `<a class="btn btn-ghost btn-sm" href="${esc(href('/leads', { ...Object.fromEntries(rc.query), closed: '1' }))}">显示已流失 / 已成交（${esc(closedCount(ctx, dealer.id))}）</a>`
  }
  ${
    more.length
      ? `<details class="filters-more"${moreActive ? ' open' : ''}><summary>更多筛选${moreActive ? '（已启用）' : ''}</summary><div class="filters-more-row">${more.join('')}${unfinishedButton('lead_filters_more', '品牌 · 负责账号 · 日期')}</div></details>`
      : unfinishedButton('lead_filters_more', '品牌 · 负责账号 · 日期')
  }
</form>`;
  const prev = q.offset > 0 ? `<a class="btn btn-ghost btn-sm" href="${esc(href('/leads', { ...Object.fromEntries(rc.query), offset: Math.max(0, q.offset - q.limit) }))}">上一页</a>` : '';
  const next = cards.length === q.limit ? `<a class="btn btn-ghost btn-sm" href="${esc(href('/leads', { ...Object.fromEntries(rc.query), offset: q.offset + q.limit }))}">下一页</a>` : '';
  // Filters, the extra filters and the legend used to sit on three separate lines above the list. They are one row.
  const body = `${sectionHead('线索收件箱', {
    live: true,
    help: ['每条线索都留着他自己说过的原话、原帖链接，和判断的依据。', '关掉的线索不会删掉，点「显示已流失 / 已成交」还能看到。'],
    right: legend(ctx, dealer.id),
  })}
${filters}
${cards.length ? `<div class="lead-list"><div class="lead-head">${ROW_COLUMNS.map((h) => `<span>${esc(h)}</span>`).join('')}</div>${cards.map((c) => leadRow(c, dealer.id, nowMs)).join('')}</div>` : emptyState('没有符合条件的线索。')}
<div class="pager">${prev}${next}</div>`;
  return renderPage(env, rc, {
    title: '线索',
    active: 'leads',
    dealer,
    dealers,
    h1: '线索',
    help: [
      '这里是系统在小红书上找到的、看起来正在买车的人，按有多少可能成交排好了队。',
      '每个人都留着他自己说过的原话和原帖链接，点进去能看到系统凭什么这么判断。',
      '私信要你看一眼才发得出去：系统写好草稿，你点头，再由人在小红书里发。',
    ],
    subtitle: dealer.name,
    body,
  });
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
  const rows: [string, string | null][] = [
    ['车型', zhModelLabel(detail.card.model_label)],
    ['地区', detail.card.location_label],
    ['购买阶段', i.purchase_stage ? PURCHASE_STAGE[i.purchase_stage] : null],
    ['预算', budget === '—' ? null : budget],
    ['购车时间', i.purchase_timeframe ? (TIMEFRAME_LABEL[i.purchase_timeframe] ?? i.purchase_timeframe) : null],
    ['他想干什么', flags.length ? flags.join('、') : null],
    ['指定颜色', i.color_intent ?? null],
    ['还在比的车', i.competing_models?.join('、') || null],
    ['他自己留的联系方式', contact || null],
    ['这单大概值', lead.estimated_value ? cny(lead.estimated_value) : null],
  ];
  const known = rows.filter((r): r is [string, string] => Boolean(r[1]));
  const missing = rows.filter((r) => !r[1]).map((r) => r[0]);
  return `<dl class="kv">${known.map(([k, x]) => `<dt>${esc(k)}</dt><dd>${esc(x)}</dd>`).join('')}</dl>${
    missing.length ? `<p class="kv-missing">还不知道：${esc(missing.join('、'))}${hint('这些是他自己还没说过的。等他回复之后，AI 会把新说的内容补到这里。')}</p>` : ''
  }`;
}

function guardList(o: Outreach): string {
  if (!o.guard_results?.length) return '';
  return `<ul class="guards">${o.guard_results
    .map((g) => {
      const cls = g.passed ? 'g-ok' : g.blocking ? 'g-block' : 'g-review';
      const mark = g.passed ? '✓' : g.blocking ? '✕' : '!';
      return `<li><span class="${cls}">${mark}</span><span><b>${esc(GUARD_LABEL[g.check] ?? g.check)}</b> ${esc(scrubInternals(g.detail))}</span></li>`;
    })
    .join('')}</ul>`;
}

/** where a salesperson of this store opens the conversation by hand */
const DM_CHANNEL_PLACE: Record<DmChannel, string> = { app: '小红书 App', pro: '专业号客服工作台' };

function outreachPanel(ctx: AppContext, env: PageEnv, detail: LeadDetail, queue: Map<string, OutreachQueueItem>, channel: DmChannel, tz: string): string {
  const lead = detail.lead;
  const assignment = detail.assignment;
  const sendCap = assignment ? latestCapability(ctx, 'send_messages', assignment.account_id) : latestCapability(ctx, 'send_messages', null);
  const sendAvailable = sendCap?.status === 'AVAILABLE';
  // What the store can do right now, in one line; why it works that way is behind the 「?」 (never the tool name).
  const capNote = sendAvailable
    ? `<div class="small muted">这条私信可以直接从这里发出去。${hint([
        '用这个账号自己的登录状态发，跟销售本人在小红书里点发送是一回事。',
        '发出去以后要在小红书的会话里看到这条消息，系统才会标成「已发送」。',
      ])}</div>`
    : `<div class="small muted">这条私信要由负责账号在${esc(DM_CHANNEL_PLACE[channel])}里自己发。${hint([
        '小红书没有开放给门店用的发私信接口，所以系统不替你发。',
        `销售在${DM_CHANNEL_PLACE[channel]}发完，回到这里点「我已在小红书发送」登记一下就行。`,
      ])}</div>`;
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
      if (q?.workbench_url)
        buttons.push(`<a class="btn btn-ghost btn-sm" href="${esc(q.workbench_url)}" target="_blank" rel="noreferrer noopener">打开客服工作台</a>`);
      if (editable) buttons.push(`<button class="btn btn-ink btn-sm" data-action="call" data-url="/api/outreach/${esc(o.id)}/approve" data-form="#wrap-${esc(o.id)}" data-success="已审核通过">审核通过</button>`);
      // An unknown send outcome is never sent again by a click: the message may already be with the customer.
      const outcomeUnknown = (o.blocked_reason ?? '').includes(DM_SEND_UNKNOWN_MARK);
      if (o.status === 'APPROVED' && sendAvailable && !outcomeUnknown)
        buttons.push(`<button class="btn btn-primary btn-sm" data-action="call" data-url="/api/outreach/${esc(o.id)}/send" data-success="已提交发送，结果以平台确认为准">通过平台发送</button>`);
      if (sendable) {
        buttons.push(
          `<button class="btn btn-primary btn-sm" data-action="call" data-url="/api/outreach/${esc(o.id)}/mark-sent" data-confirm="确认已由「${esc(q?.account.nickname ?? '负责账号')}」在小红书发出？再点一次" data-success="已登记为人工发送">我已在小红书发送</button>`,
        );
        buttons.push(`<button class="btn btn-danger btn-sm" data-action="call" data-url="/api/outreach/${esc(o.id)}/cancel" data-body="${dataBody({ reason: '运营取消' })}" data-confirm="确认取消这条私信？" data-success="已取消">取消</button>`);
      }
      const instructions = q?.manual_send_instructions?.length
        ? `<ol class="small" style="margin:8px 0 0;padding-left:18px">${q.manual_send_instructions.map((s) => `<li>${esc(humanInstruction(s, tz))}</li>`).join('')}</ol>`
        : '';
      return `<div class="card stack" id="wrap-${esc(o.id)}" style="box-shadow:inset 0 0 0 1px var(--border)">
  <div class="row">${outreachStatusPill(o.status, sendAvailable)} ${pill(o.kind === 'first_touch' ? '首次触达' : '跟进', 'neutral')} <span class="small muted">${esc(q?.account.nickname ?? '')} · ${esc(fmtTime(o.created_at, tz))}${o.sent_by ? ` · 发送人 ${esc(humanActor(o.sent_by))}` : ''}</span></div>
  ${editable ? `<textarea id="${esc(fieldId)}" name="message" maxlength="1000">${esc(o.message)}</textarea>` : `<div class="quote" id="${esc(fieldId)}"><p>${esc(o.message)}</p></div>`}
  ${o.blocked_reason ? `<div class="banner ${outcomeUnknown ? 'banner-amber' : 'banner-red'}" style="margin:0">${esc(scrubInternals(o.blocked_reason))}</div>` : ''}
  ${outcomeUnknown ? `<div class="small muted">这条私信不会自动重发。${hint('去小红书里看看这位客户的会话：已经发出去了就点「我已在小红书发送」登记，没发出去就点「取消」，再重新生成一条。')}</div>` : ''}
  ${o.personalization?.length ? `<div class="chips">${o.personalization.map((e) => `<span class="ev" title="${esc(e.quote ?? '')}">${esc(sayHuman(e.label))}</span>`).join('')}</div>` : ''}
  ${o.fact_refs?.length ? `<div class="small muted">引用门店事实：${o.fact_refs.map((fr) => esc(fr.claim)).join('、')}</div>` : ''}
  <details><summary class="small">发送前检查（${esc(o.guard_results?.length ?? 0)} 项）</summary>${guardList(o)}</details>
  ${instructions}
  <div class="row">${buttons.join('')}</div>
</div>`;
    })
    .join('');
  return `<div class="panel stack" id="outreach"><div class="row"><h2 class="panel-title" style="margin:0">私信</h2><span class="spacer"></span>${prepare}</div>${capNote}${
    rendered ||
    `<div class="muted small">还没有私信。${hint('等这条线索评上合格、并且分到一个负责的号之后，就能照着他自己说过的话和门店的真实信息写一条私信。')}</div>`
  }</div>`;
}

export function leadDetailPage(env: PageEnv, rc: RequestContext): Reply {
  const { ctx } = env.runtime;
  const detail = getLeadDetail(ctx, rc.params.id);
  const lead = detail.lead;
  const { dealers } = resolveDealer(ctx, rc);
  const dealer = dealers.find((x) => x.id === lead.dealer_id) ?? null;
  const tz = dealerTz(dealer);
  const channel: DmChannel = dealer?.settings.dm_channel ?? 'app';
  const nowMs = ctx.clock.now().getTime();
  const pending = dealer ? listOutreachQueue(ctx, { dealer_id: dealer.id, statuses: ['READY_FOR_REVIEW', 'APPROVED', 'FAILED', 'BLOCKED', 'SENT', 'SENT_MANUALLY'], limit: 500 }) : [];
  const queue = new Map(pending.filter((x) => x.lead.id === lead.id).map((x) => [x.outreach.id, x]));
  const latestScore = detail.scores[detail.scores.length - 1];
  // Assignable accounts are the live fleet; the name map also covers removed accounts so past owners still read as names.
  const accounts = ctx.db.table('xhs_accounts').findMany({ dealer_id: lead.dealer_id, removed_at: null }, { orderBy: 'created_at ASC' });
  const accountName = new Map(ctx.db.table('xhs_accounts').findMany({ group_id: lead.group_id }).map((a) => [a.id, a.nickname]));

  const header = `<div class="panel stack">
  <div class="lead-top"><span class="lead-score${lead.score >= 80 ? ' hot' : ''}">${esc(Math.round(lead.score))}</span>${tierPill(lead.tier)} ${leadStagePill(lead.stage)} ${lead.data_mode === 'live' ? '' : dataModePill(lead.data_mode)} ${actorPill(lead.actor_type)} ${lead.suppressed ? pill('勿扰', 'red', lead.suppression_reason ?? '') : ''}
    <span class="lead-owner">${detail.assignment ? `负责账号：${esc(accountName.get(detail.assignment.account_id) ?? detail.assignment.account_id)}` : '<span class="muted">未分配</span>'}</span></div>
  <div class="primary">${esc(lead.username)} ${sourceLink(lead.profile_url, '查看主页')}</div>
  <div class="small"><b>下一步：</b>${esc(sayHuman(detail.card.next_action))}</div>
  ${intentKv(lead, detail)}
  ${evidenceBlock(lead.evidence, 12)}
</div>`;

  const signals = detail.signals
    .map((s) => {
      const url = s.public_post?.url ?? null;
      // One score per person is enough: the row and the header already carry 意向分, so the per-signal number is a tooltip.
      return `<li><div class="row" title="${esc(`这句话本身打了 ${Math.round(s.signal.signal_score)} 分`)}">${pill(SOURCE_LABEL[s.signal.source_type] ?? s.signal.source_type, 'neutral')} ${s.is_primary ? pill('主要依据', 'coral-soft') : ''} ${actorPill(s.signal.actor_type)} ${s.public_post?.data_mode && s.public_post.data_mode !== 'live' ? dataModePill(s.public_post.data_mode) : ''}<span class="spacer"></span><span class="tiny muted">${esc(fmtTime(s.signal.signal_at, tz))}</span></div>
  <div class="quote" style="margin-top:8px"><p>“${esc(previewText(s.signal.content))}”</p><small>${s.signal.post_title ? `《${esc(s.signal.post_title)}》 · ` : ''}${sourceLink(url)}</small></div>
  <div style="margin-top:6px">${evidenceBlock(s.signal.evidence, 8)}</div></li>`;
    })
    .join('');

  const assignmentRows = detail.candidates.map((c) => [
    `<div class="primary" style="font-size:15px">${esc(c.nickname)}</div>${c.excluded_reason ? `<div class="secondary">${esc(scrubInternals(c.excluded_reason))}</div>` : ''}`,
    `<span class="id-pill${detail.assignment?.account_id === c.account_id ? ' hot' : ''}">${esc(Math.round(c.score))}</span>`,
    c.eligible ? pill('可分配', 'green') : pill('不可分配', 'red'),
    `<details><summary class="small">评分因素</summary>${scoreBars(humanFactors(c.factors))}</details>`,
  ]);
  // Unassigned: one button that picks the account. Assigned: one control that moves it. Never both at once.
  const reassign = detail.assignment
    ? `<div class="inline-form" id="reassign"><select name="reassign_to" aria-label="换成哪个号">${accounts
        .map((a) => `<option value="${esc(a.id)}"${detail.assignment?.account_id === a.id ? ' selected' : ''}>${esc(a.nickname)}</option>`)
        .join('')}</select><input type="text" name="reason" placeholder="为什么换人（选填）" data-optional>
  <button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/leads/${esc(lead.id)}/assign" data-form="#reassign" data-success="已更新负责账号">换人</button></div>`
    : `<div class="inline-form" id="reassign"><button class="btn btn-ink btn-sm" data-action="call" data-url="/api/leads/${esc(lead.id)}/assign" data-success="已完成分配">自动分配</button></div>`;

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
      return `<div class="msg ${inbound ? 'msg-in' : 'msg-out'}">${m.status === 'draft' ? '' : esc(m.content)}${draftActions}<div class="msg-meta">${inbound ? '客户' : '我方'} · ${messageStatusPill(m.status)} · ${esc(fmtTime(m.created_at, tz))}${m.intents?.length ? ` · ${esc(m.intents.join('/'))}` : ''}${m.sent_by ? ` · ${esc(humanActor(m.sent_by))}` : ''}</div></div>`;
    })
    .join('');
  const inboundForm = `<form class="stack" data-api="/api/leads/${esc(lead.id)}/inbound" data-success="已登记客户回复，AI 已分析意图"><label>录入客户在小红书中的回复<textarea name="content" required maxlength="5000" placeholder="粘贴客户在私信中的原话"></textarea></label><div class="row"><span class="small muted">由负责账号在${esc(DM_CHANNEL_PLACE[channel])}查看私信后录入（系统无法读取私信收件箱）。</span><span class="spacer"></span><button class="btn btn-ink btn-sm" type="submit">登记回复</button></div></form>`;

  const appointments = detail.appointments.length
    ? detail.appointments
        .map(
          (a) => `<div class="row card" style="box-shadow:inset 0 0 0 1px var(--border)">${appointmentStatusPill(a.status)} <span>${esc(a.vehicle_interest)} · ${esc(a.store)}</span><span class="small muted">${esc(a.scheduled_for ? fmtTime(a.scheduled_for, tz) : a.time_text ?? '时间待定')}</span><span class="spacer"></span>
  ${a.status === 'proposed' ? `<button class="btn btn-ink btn-sm" data-action="call" data-url="/api/appointments/${esc(a.id)}/confirm" data-success="预约已确认">确认预约</button>` : ''}
  ${a.status === 'proposed' || a.status === 'confirmed' ? `<button class="btn btn-primary btn-sm" data-action="call" data-url="/api/appointments/${esc(a.id)}/visited" data-success="已登记到店">已到店</button><button class="btn btn-danger btn-sm" data-action="call" data-url="/api/appointments/${esc(a.id)}/no-show" data-confirm="确认未到店？" data-success="已登记未到店">未到店</button>` : ''}</div>`,
        )
        .join('')
    : `<div class="muted small">暂无预约。${hint('客户在对话里说要来店里看车时，系统会自动生成一条待确认的预约。')}</div>`;
  const appointmentsBlock = `${appointments}<div class="row" style="margin-top:8px">${unfinishedButton('appointment_cancel_list', '取消预约 · 预约列表')}</div>`;

  const actions = `<div class="panel stack"><h2 class="panel-title">线索操作</h2>
  <div class="row"><button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/leads/${esc(lead.id)}/research" data-success="已完成公开主页研究">研究公开主页</button>
  <button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/leads/${esc(lead.id)}/qualify" data-success="已更新销售资格">判断销售资格</button>
  ${unfinishedButton('lead_stage_negotiating', '标记洽谈中')}</div>
  <div class="inline-form" id="won-form"><input type="number" name="amount" placeholder="成交金额（元）" min="0" data-optional><button class="btn btn-primary btn-sm" data-action="call" data-url="/api/leads/${esc(lead.id)}/won" data-form="#won-form" data-confirm="确认登记成交？" data-success="已登记成交">登记成交</button></div>
  <div class="inline-form" id="lost-form"><input type="text" name="reason" placeholder="流失原因"><button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/leads/${esc(lead.id)}/lost" data-form="#lost-form" data-confirm="确认标记流失？" data-success="已标记流失">标记流失</button></div>
  <div class="inline-form" id="dnc-form"><input type="text" name="reason" placeholder="勿扰原因，如：用户要求不再联系"><button class="btn btn-danger btn-sm" data-action="call" data-url="/api/leads/${esc(lead.id)}/suppress" data-form="#dnc-form" data-confirm="加入全局勿扰后所有账号都不会再联系此人，确认？" data-success="已加入全局勿扰">加入勿扰</button></div>
  ${lead.stage === 'LOST' && !lead.suppressed ? `<div class="inline-form" id="reopen-form"><input type="hidden" name="to" value="QUALIFIED"><input type="text" name="reason" placeholder="重新打开原因"><button class="btn btn-ghost btn-sm" data-action="call" data-url="/api/leads/${esc(lead.id)}/reopen" data-form="#reopen-form" data-success="线索已重新打开">重新打开</button></div>` : ''}
</div>`;

  const transitions = detail.transitions
    .map(
      (t) =>
        `<li>${t.from_stage ? `${leadStagePill(t.from_stage)} → ` : ''}${leadStagePill(t.to_stage)} <span class="small">${esc(sayHuman(scrubInternals(t.reason)))}</span> <span class="tiny muted">${esc(humanActor(t.actor))} · ${esc(fmtTime(t.at, tz))}</span></li>`,
    )
    .join('');
  // What the AI decided about this customer, in the words of the console — the skill and agent names stay internal,
  // and a confidence is one of three words, because a percent suggests a precision this does not have.
  const decisions = detail.decisions
    .slice(-30)
    .reverse()
    .map(
      (x) =>
        `<li><b class="small">${esc(decisionTitle(x.decision_type))}</b> <span class="tiny muted">${esc(humanAgent(x.agent))} · ${esc(confidenceWord(x.confidence))} · ${esc(ago(x.created_at, nowMs))}</span>${
          decisionText(x) ? `<div class="tiny muted">${esc(sayHuman(scrubInternals(decisionText(x))))}</div>` : ''
        }</li>`,
    )
    .join('');

  const body = `<div class="detail-grid">
  <div class="stack">
    ${header}
    <div class="panel"><h2 class="panel-title">他说过的话（${esc(detail.signals.length)}）${hint('这些都是他自己在小红书公开发的笔记和评论，原话照抄，没有改动。')}</h2><ul class="timeline">${signals || '<li class="muted">还没有抓到他说的话</li>'}</ul></div>
    ${outreachPanel(ctx, env, detail, queue, channel, tz)}
    <div class="panel stack" id="conversation"><h2 class="panel-title">对话${convo?.needs_human ? ` ${pill('需要人工接管', 'amber', convo.handoff_reason ?? '')}` : ''}</h2>${thread ? `<div class="thread">${thread}</div>` : '<p class="muted small">还没有对话记录。</p>'}${inboundForm}</div>
    <div class="panel stack"><h2 class="panel-title">到店预约</h2>${appointmentsBlock}</div>
  </div>
  <div class="stack">
    <div class="panel"><h2 class="panel-title">这个分怎么来的${hint('下面几项加起来就是他的购车意向分。分数越高越该先联系，过了合格线才会分一个号去写私信。')}</h2>${latestScore ? `<p class="small muted">意向 ${esc(Math.round(latestScore.score))} · ${esc(fmtTime(latestScore.computed_at, tz))}</p>${scoreBars(humanFactors(latestScore.components))}` : '<p class="muted small">暂无评分</p>'}</div>
    <div class="panel"><h2 class="panel-title">账号分配</h2>${table(['账号', '得分', '资格', '因素'], assignmentRows, { compact: true, empty: '尚未计算分配排名' })}${reassign}</div>
    ${actions}
    <div class="panel"><h2 class="panel-title">这条线索走到哪一步了</h2><ul class="timeline">${transitions || '<li class="muted">无</li>'}</ul></div>
    <div class="panel"><details><summary class="panel-title" style="cursor:pointer">它为什么这么判断（${esc(detail.decisions.length)}）</summary><ul class="timeline">${decisions}</ul></details></div>
  </div>
</div>`;
  return renderPage(env, rc, {
    title: `线索 ${lead.username}`,
    active: 'leads',
    dealer,
    dealers,
    h1: `${esc(lead.username)}<span class="h1-meta">${esc(Math.round(lead.score))} 分</span>`,
    subtitle: `${detail.dealer.name} · ${zhModelLabel(detail.card.model_label)} · ${detail.card.location_label} · 首次发现 ${fmtTime(lead.first_seen_at, tz)}`,
    body,
  });
}
