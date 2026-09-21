/**
 * Server-side rendering helpers for the operator console: escaping, Chinese labels, status pills per
 * docs/UI_DESIGN.md §4, KPI cards, tables and the page layout (top bar, dealer switcher, tabs, honest banners).
 * Every piece of user, dealer or public Xiaohongshu content passes through `esc`.
 */
import { DEFAULT_TZ } from '../core/time.ts';
import { ASSET_VERSION } from './assets.ts';
import { UNFINISHED, type UnfinishedKey } from './unfinished.ts';
import { escapeHtml, formatCny } from '../core/text.ts';
import type {
  AccountType,
  ActorType,
  AppointmentStatus,
  CapabilityStatus,
  DataMode,
  HealthState,
  LeadStage,
  MessageStatus,
  OutreachStatus,
  PostStatus,
  PurchaseStage,
  ScoreTier,
  StepStatus,
  WorkflowStatus,
} from '../core/types.ts';
import { ACTOR_LABELS } from '../domain/actor-classification.ts';
import { BRANDS } from '../domain/automotive-lexicon.ts';

export const esc = (value: unknown): string => escapeHtml(value === null || value === undefined ? '' : value);

export type Tone = 'green' | 'amber' | 'red' | 'violet' | 'neutral' | 'coral' | 'coral-soft';

export function pill(label: string, tone: Tone = 'neutral', title?: string): string {
  return `<span class="status s-${tone}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</span>`;
}

type LabelMap<K extends string> = Record<K, [string, Tone]>;

export const TIER: LabelMap<ScoreTier> = {
  immediate: ['立即跟进', 'coral'],
  high_intent: ['高意向', 'coral-soft'],
  qualified: ['合格', 'violet'],
  candidate: ['候选', 'neutral'],
  none: ['未达候选', 'neutral'],
};

export const LEAD_STAGE: LabelMap<LeadStage> = {
  DISCOVERED: ['已发现', 'neutral'],
  CANDIDATE: ['候选', 'neutral'],
  QUALIFIED: ['合格', 'violet'],
  ASSIGNED: ['已分配', 'violet'],
  OUTREACH_READY: ['私信待发', 'amber'],
  CONTACTED: ['已发私信', 'neutral'],
  REPLIED: ['已回复', 'violet'],
  SALES_QUALIFIED: ['销售合格', 'violet'],
  CONTACT_ACQUIRED: ['已留资', 'green'],
  APPOINTMENT: ['已预约', 'coral-soft'],
  VISITED: ['已到店', 'green'],
  NEGOTIATING: ['洽谈中', 'coral-soft'],
  WON: ['成交', 'green'],
  LOST: ['流失', 'red'],
};

export const PURCHASE_STAGE: Record<PurchaseStage, string> = {
  awareness: '认知',
  research: '研究',
  comparison: '对比',
  price_shopping: '比价',
  active_shopping: '积极选购',
  dealer_selection: '选店',
  purchase_imminent: '即将购买',
};

export const OUTREACH_STATUS: LabelMap<OutreachStatus> = {
  DRAFT: ['草稿', 'neutral'],
  BLOCKED: ['被拦下了', 'red'],
  READY_FOR_REVIEW: ['等你看一眼', 'amber'],
  APPROVED: ['你已通过，等发送', 'amber'],
  SENT: ['已发出', 'green'],
  SENT_MANUALLY: ['已由人发出', 'green'],
  FAILED: ['发送失败', 'red'],
  CANCELLED: ['已取消', 'neutral'],
};

export const POST_STATUS: LabelMap<PostStatus> = {
  PLANNED: ['已计划', 'neutral'],
  DRAFTED: ['已生成', 'violet'],
  CHANGES_REQUIRED: ['要改', 'red'],
  IN_REVIEW: ['等你看一眼', 'amber'],
  APPROVED: ['已批准', 'green'],
  SCHEDULED: ['已排期', 'green'],
  READY_TO_PUBLISH: ['等人去发', 'amber'],
  PUBLISHED: ['已发布', 'green'],
  FAILED: ['发布失败', 'red'],
  REJECTED: ['已驳回', 'neutral'],
};

export const HEALTH: LabelMap<HealthState> = {
  HEALTHY: ['健康', 'green'],
  WATCH: ['关注', 'amber'],
  AT_RISK: ['有风险', 'amber'],
  RESTRICTED: ['被限流了', 'red'],
};

export const CAPABILITY: LabelMap<CapabilityStatus> = {
  AVAILABLE: ['可用', 'green'],
  UNAVAILABLE: ['不可用', 'red'],
  REQUIRES_AUTH: ['要重新登录', 'amber'],
  REQUIRES_REVIEW: ['要人来做', 'amber'],
};

export const CAPABILITY_NAME: Record<string, string> = {
  search_public_content: '搜索公开内容',
  read_public_post: '读取公开笔记',
  read_public_comments: '读取公开评论',
  read_public_profile: '读取公开主页',
  publish_content: '发布内容',
  read_engagement: '读取互动数据',
  receive_messages: '接收私信',
  send_messages: '发送私信',
  reply_comments: '公开回复评论',
  llm: '大模型',
};

export const ACCOUNT_TYPE: Record<AccountType, string> = {
  official: '官方号',
  salesperson: '销售号',
  model_specialist: '车型专家号',
  local_guide: '本地攻略号',
  customer_story: '车主故事号',
};

export const DATA_MODE: LabelMap<DataMode> = {
  live: ['真实数据', 'green'],
  simulation: ['模拟数据', 'violet'],
  import: ['导入数据', 'neutral'],
  manual: ['人工录入', 'neutral'],
  unknown: ['来源未知', 'amber'],
};

const ACTOR_TONE: Record<ActorType, Tone> = {
  BUYER: 'coral-soft',
  OWNER: 'neutral',
  CREATOR: 'neutral',
  DEALER_OR_SALES: 'red',
  ENTHUSIAST: 'neutral',
  UNKNOWN: 'neutral',
};

export const WORKFLOW_STATUS: LabelMap<WorkflowStatus> = {
  PENDING: ['等待', 'neutral'],
  RUNNING: ['运行中', 'violet'],
  SUCCEEDED: ['成功', 'green'],
  FAILED: ['失败', 'red'],
  PARTIAL: ['部分成功', 'amber'],
  CANCELLED: ['已取消', 'neutral'],
};

export const STEP_STATUS: LabelMap<StepStatus> = {
  PENDING: ['等待', 'neutral'],
  RUNNING: ['运行中', 'violet'],
  SUCCEEDED: ['成功', 'green'],
  FAILED: ['失败', 'red'],
  SKIPPED: ['已跳过', 'amber'],
};

export const APPOINTMENT_STATUS: LabelMap<AppointmentStatus> = {
  proposed: ['待确认', 'amber'],
  confirmed: ['已确认', 'green'],
  visited: ['已到店', 'green'],
  no_show: ['未到店', 'red'],
  cancelled: ['已取消', 'neutral'],
};

export const MESSAGE_STATUS: LabelMap<MessageStatus> = {
  received: ['已收到', 'neutral'],
  draft: ['等你看一眼', 'amber'],
  sent: ['已发出', 'green'],
  sent_manually: ['已由人发出', 'green'],
  discarded: ['已不用', 'neutral'],
};

export const QUERY_CLASS: Record<string, string> = {
  direct_model: '直接搜车型',
  competitor: '和别的车比',
  purchase_scenario: '什么情况下买车',
  transaction_intent: '正在准备买',
  location: '本地',
  derived: '顺带扩出来的',
};

export const FACTOR: Record<string, string> = {
  explicit_purchase_intent: '购买意向',
  transaction_questions: '交易问题',
  model_match: '车型匹配',
  inventory_match: '库存匹配',
  location_match: '地域匹配',
  purchase_stage: '购买阶段',
  recency: '时效',
  authenticity: '真实性',
  dealer_relevance: '品牌相关',
  corroboration: '多信号佐证',
  out_of_area_cap: '不在本地，扣分',
  location: '地域',
  model_specialization: '车型专长',
  persona_fit: '人设匹配',
  response_rate: '回复率',
  conversion_rate: '转化率',
  load: '负载',
  health: '健康度',
};

function labeled<K extends string>(map: LabelMap<K>, key: K | null | undefined, fallback = '—'): string {
  if (!key) return pill(fallback, 'neutral');
  const entry = map[key];
  return entry ? pill(entry[0], entry[1]) : pill(String(key), 'neutral');
}

export const tierPill = (t: ScoreTier | null | undefined) => labeled(TIER, t);
export const leadStagePill = (s: LeadStage | null | undefined) => labeled(LEAD_STAGE, s);
export const postStatusPill = (s: PostStatus | null | undefined) => labeled(POST_STATUS, s);
export const healthPill = (s: HealthState | null | undefined, score?: number | null) =>
  s ? pill(`${HEALTH[s][0]}${score !== null && score !== undefined ? ` ${Math.round(score)}` : ''}`, HEALTH[s][1]) : pill('未计算', 'neutral');
export const capabilityPill = (s: CapabilityStatus | null | undefined, title?: string) =>
  s ? pill(CAPABILITY[s][0], CAPABILITY[s][1], title) : pill('未知', 'neutral', title);
export const workflowStatusPill = (s: WorkflowStatus) => labeled(WORKFLOW_STATUS, s);
export const stepStatusPill = (s: StepStatus) => labeled(STEP_STATUS, s);
export const appointmentStatusPill = (s: AppointmentStatus) => labeled(APPOINTMENT_STATUS, s);
export const messageStatusPill = (s: MessageStatus) => labeled(MESSAGE_STATUS, s);
export const dataModePill = (m: DataMode | null | undefined) => labeled(DATA_MODE, m ?? 'unknown');
export const actorPill = (a: ActorType | null | undefined) => (a ? pill(ACTOR_LABELS[a] ?? a, ACTOR_TONE[a] ?? 'neutral') : pill('身份未分类', 'neutral'));

/**
 * Outreach status pill. APPROVED means "a human must send it" whenever the provider cannot send DMs;
 * nothing reads as sent unless the provider confirmed it (SENT) or a person recorded a manual send.
 */
export function outreachStatusPill(s: OutreachStatus | null | undefined, sendAvailable = false): string {
  if (!s) return pill('无私信', 'neutral');
  if (s === 'APPROVED' && !sendAvailable) return pill('你已通过，等人去发', 'amber');
  return labeled(OUTREACH_STATUS, s);
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

const partsFormatter = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string, withYear: boolean): Intl.DateTimeFormat {
  const key = `${tz}|${withYear}`;
  let f = partsFormatter.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz,
      year: withYear ? 'numeric' : undefined,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    partsFormatter.set(key, f);
  }
  return f;
}

/** '09/13 18:30' in the dealer timezone; '—' for empty/invalid. */
export function fmtTime(iso: string | null | undefined, tz: string = DEFAULT_TZ, withYear = false): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  return formatter(tz, withYear).format(new Date(t));
}

export function ago(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const mins = Math.round((nowMs - t) / 60000);
  if (mins < 0) return mins > -60 ? `${-mins}分钟后` : mins > -1440 ? `${Math.round(-mins / 60)}小时后` : `${Math.round(-mins / 1440)}天后`;
  if (mins < 2) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  if (mins < 1440) return `${Math.round(mins / 60)}小时前`;
  return `${Math.round(mins / 1440)}天前`;
}

export const pad2 = (n: number): string => (Number.isFinite(n) && n >= 0 && n < 10 ? `0${Math.floor(n)}` : String(Math.round(Number.isFinite(n) ? n : 0)));

export function cny(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
  const text = formatCny(Math.round(amount));
  // formatCny already carries a unit under 10k ('800元'); prefixing ¥ there produced '¥800元'.
  return text.endsWith('元') ? text : `¥${text}`;
}

export function pct(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}

/** Build `path?k=v` keeping only defined, non-empty params. */
export function href(path: string, params: Record<string, string | number | null | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    q.set(k, String(value));
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** External link to a Xiaohongshu source; only https://www.xiaohongshu.com URLs are linked. */
export function sourceLink(url: string | null | undefined, label = '查看原帖'): string {
  if (!url) return '<span class="muted small">无原帖链接</span>';
  let ok = false;
  try {
    const u = new URL(url);
    ok = u.protocol === 'https:' && (u.hostname === 'www.xiaohongshu.com' || u.hostname === 'xiaohongshu.com' || u.hostname.endsWith('.xiaohongshu.com'));
  } catch {
    ok = false;
  }
  if (!ok) return `<span class="muted small mono">${esc(url)}</span>`;
  return `<a class="link small" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)} ↗</a>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Components
// ─────────────────────────────────────────────────────────────────────────────

export const ICON = {
  search: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  bell: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>',
  chevron: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  ai: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.2 6.3L20.5 10l-6.3 2.2L12 18.5l-2.2-6.3L3.5 10l6.3-1.7z"/></svg>',
  alert: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3 1.8 20.5h20.4z"/></svg>',
  win: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  inbox: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 13h4l2 3h4l2-3h4"/><path d="M5 5h14l1 8v6H4v-6z"/></svg>',
};

export interface KpiInput {
  variant: 'coral' | 'lavender' | 'ink' | 'outline';
  label: string;
  value: string;
  chip?: string;
  foot?: string;
}

export function kpiCard(k: KpiInput): string {
  return `<article class="kpi ${k.variant}"><span class="kpi-dot"></span><div class="kpi-label">${esc(k.label)}</div><div class="kpi-num">${esc(k.value)}</div><div class="kpi-foot">${k.chip ? `<span class="chip">${esc(k.chip)}</span>` : ''}${esc(k.foot ?? '')}</div></article>`;
}

export function sectionHead(title: string, opts: { live?: boolean; note?: string; help?: string | readonly string[]; right?: string } = {}): string {
  // `note` is a short line that belongs on the page; `help` is an explanation that belongs behind the 「?」.
  const help = opts.help ? hint(opts.help) : '';
  return `<div class="section-head"><h2 class="section-title">${esc(title)}${help}</h2>${opts.live ? '<span class="live">实时</span>' : ''}${opts.note ? `<span class="muted small">${esc(opts.note)}</span>` : ''}${opts.right ? `<span class="spacer"></span>${opts.right}` : ''}</div>`;
}

/**
 * 「?」: the explanation lives one click away. Defined here (not in hint.ts) so `sectionHead` can use it without a
 * circular import; `src/server/hint.ts` re-exports it for pages.
 */
export function hint(text: string | readonly string[], label = '说明'): string {
  const parts = (Array.isArray(text) ? text : [text]).map((x) => String(x ?? '').trim()).filter(Boolean);
  if (parts.length === 0) return '';
  return `<details class="hint"><summary title="${esc(label)}" aria-label="${esc(label)}">?</summary><div class="hint-body">${parts
    .map((p) => `<p>${esc(p)}</p>`)
    .join('')}</div></details>`;
}

/** `rows` cells are trusted HTML (callers escape their content); headers are escaped. */
/**
 * Customer words as they arrive from Xiaohongshu carry the platform's own markup (`#买车推荐[话题]#`, `[哭惹R]`).
 * Printing it raw is the difference between a product and a dump of a database column.
 */
export function previewText(text: string): string {
  const stripped = String(text ?? '')
    .replace(/#[^#\n]{1,30}\[话题\]#/g, ' ')
    .replace(/\[[^\[\]\s]{1,8}\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || String(text ?? '').trim();
}

/**
 * A table sits on the page, not inside a card. Its frame is the header rule and the hairlines between rows: a border
 * drawn around data that is already a grid is the box-inside-a-box that makes a console look generated.
 */
export function table(headers: string[], rows: string[][], opts: { compact?: boolean; empty?: string } = {}): string {
  if (rows.length === 0) return emptyState(opts.empty ?? '暂无数据');
  return `<div class="table-wrap"><table class="data${opts.compact ? ' compact' : ''}"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

export const emptyState = (text: string): string => `<div class="empty">${esc(text)}</div>`;

// ── unfinished features ──────────────────────────────────────────────────────
/**
 * What is not built yet is still disclosed — but in ONE place (系统 → 还没做完的功能), not as a dead button on every
 * screen. A disabled control a salesperson keeps clicking teaches them the product is broken; a single honest list
 * tells them what is coming without getting in the way. The registry (`unfinished.ts`) is unchanged, and these three
 * helpers stay so the call sites keep documenting where the gap is.
 */
export const unfinishedTag = (_key: UnfinishedKey): string => '';
export const unfinishedButton = (_key: UnfinishedKey, _label?: string): string => '';
export const unfinishedBlock = (_key: UnfinishedKey): string => '';

export function stat(label: string, value: string | number): string {
  return `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-num">${esc(value)}</div></div>`;
}

/**
 * Scoring reasons are stored with the canonical English brand ('仅品牌匹配（XPeng）'). A salesperson reads 小鹏, so the
 * brand is translated on the way out. Only whole words match, so a model code like G6 is never touched.
 */
export function zhBrands(text: string): string {
  let out = String(text ?? '');
  for (const b of BRANDS) {
    if (b.brand === b.brand_zh) continue;
    out = out.replace(new RegExp(`\\b${b.brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), b.brand_zh);
  }
  return out;
}

export function scoreBars(components: { factor: string; points: number; max: number; reason: string }[]): string {
  return components
    .map((c) => {
      const width = c.max > 0 ? Math.max(0, Math.min(100, Math.round((c.points / c.max) * 100))) : 0;
      return `<div class="bar-row"><span>${esc(FACTOR[c.factor] ?? c.factor)}</span><span class="bar"><i style="width:${width}%"></i></span><span class="num">${esc(Math.round(c.points * 10) / 10)}/${esc(c.max)}</span></div><div class="bar-reason">${esc(zhBrands(c.reason))}</div>`;
    })
    .join('');
}

/** JSON for a data-body attribute (escaped for an HTML attribute). */
export const dataBody = (value: unknown): string => esc(JSON.stringify(value));

// ─────────────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────────────

export const TABS = [
  { key: 'overview', label: '今日', path: '/' },
  { key: 'leads', label: '线索', path: '/leads' },
  { key: 'conversations', label: '对话', path: '/conversations' },
  { key: 'content', label: '内容', path: '/content' },
  { key: 'vehicles', label: '车型', path: '/vehicles' },
  { key: 'accounts', label: '账号', path: '/accounts' },
  { key: 'intel', label: '情报', path: '/intel' },
  { key: 'system', label: '系统', path: '/system' },
  { key: 'setup', label: '设置', path: '/setup' },
] as const;
export type TabKey = (typeof TABS)[number]['key'];

/**
 * The nav is grouped the way the day is: what you work in, what the work reads from, and what you only open when
 * something is wrong. Nine flat icons are unmemorable; three short labelled groups are scannable.
 */
export const NAV_GROUPS: { label: string; keys: readonly TabKey[] }[] = [
  { label: '每天', keys: ['overview', 'leads', 'conversations', 'content'] },
  { label: '门店资料', keys: ['vehicles', 'accounts', 'setup'] },
  { label: '回看', keys: ['intel', 'system'] },
];

export interface Banner {
  tone: 'amber' | 'red' | 'violet' | 'green';
  /** trusted HTML */
  html: string;
}

export interface LayoutInput {
  title: string;
  active: TabKey | null;
  dealerId: string | null;
  dealers: { id: string; name: string }[];
  operator: string;
  authEnabled: boolean;
  provider: { name: string; mode: string };
  exceptions: number;
  banners: Banner[];
  /** trusted HTML for the H1 */
  h1: string;
  subtitle: string;
  /** trusted HTML */
  body: string;
  /** 'light' / 'dark' when the operator picked one (cookie st_theme); absent = follow the system */
  theme?: Theme | null;
  /** what Steer is doing now (status bar) */
  agent?: AgentStatus | null;
  /** the operator collapsed the nav to icons (cookie st_rail) */
  railCollapsed?: boolean;
  /** pages with their own hero (今日) render no page head */
  hideHead?: boolean;
}

export function providerModePill(provider: { name: string; mode: string }): string {
  // What the badge means for the store — the integration's own name belongs in the logs, not in the header.
  if (provider.mode === 'live') return '<span class="mode-pill mode-live" title="内容来自你们自己登录的小红书账号">真实数据</span>';
  if (provider.mode === 'simulation') return '<span class="mode-pill mode-simulation" title="演示语料，不是真实的小红书数据">模拟数据模式</span>';
  return '<span class="mode-pill mode-none" title="还没有连接小红书账号">未连接小红书</span>';
}

/** Human names of the workflows (status bar, 系统 page). */
export const WORKFLOW_LABEL: Record<string, string> = {
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

export const BRAND = '驭客 Steer';

/**
 * The Steer S mark (vector approximation of docs/design/steer-logo.png from docs/design/steer-ui-kit.html; replace with
 * the designer's exported SVG) and the Feather icons (MIT) used by the shell, defined once per page.
 */
const SVG_DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<linearGradient id="st-gU" x1="250" y1="30" x2="60" y2="220" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:var(--st-mark-a)"/><stop offset="1" style="stop-color:var(--st-mark-b)"/></linearGradient>
<radialGradient id="st-gF" cx="95" cy="205" r="80" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:var(--st-mark-fold)"/><stop offset="1" style="stop-color:var(--st-mark-a)"/></radialGradient>
<linearGradient id="st-gL" x1="272" y1="205" x2="55" y2="355" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#D8C29F"/><stop offset=".4" stop-color="#B69A70"/><stop offset=".8" style="stop-color:var(--st-mark-b)"/><stop offset="1" style="stop-color:var(--st-mark-end)"/></linearGradient>
</defs>
<symbol id="st-mark" viewBox="28 12 256 368"><path fill="url(#st-gU)" d="M234 22C256 14 274 36 265 61C261 72 253 80 243 86L101 167L56 202C38 189 28 169 31 147C34 125 46 109 63 100Z"/><path fill="url(#st-gF)" d="M106 171L212 186L108 234L58 205C50 200 44 194 40 187C52 178 78 172 106 171Z"/><path fill="url(#st-gL)" d="M213 184C247 176 276 196 279 226C281 246 272 258 257 267L86 367C64 379 44 372 42 350C40 328 48 309 66 297Z"/></symbol>
<symbol id="i-moon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></symbol>
<symbol id="i-rail" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9.5" y1="4" x2="9.5" y2="20"/></symbol>
<symbol id="i-enter" viewBox="0 0 24 24"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></symbol>
<symbol id="i-arrow" viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></symbol>
</svg>`;

export const markSvg = (cls = 'st-mark'): string => `<svg class="${cls}" aria-hidden="true"><use href="#st-mark"/></svg>`;
export const iconSvg = (id: 'moon' | 'enter' | 'arrow' | 'rail', cls = 'st-icon'): string => `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

/** Sidebar navigation icons: Feather Icons (MIT, feathericons.com), 24px grid, stroked with currentColor. */
const NAV_ICON: Record<TabKey, string> = {
  overview: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  leads: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  conversations: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  content: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  vehicles:
    '<path d="M5 17h14"/><path d="M3 17v-4.2a2 2 0 0 1 .3-1L6 7.4A2 2 0 0 1 7.7 6.5h8.6a2 2 0 0 1 1.7.9l2.7 4.4a2 2 0 0 1 .3 1V17"/><circle cx="7.5" cy="17" r="1.8"/><circle cx="16.5" cy="17" r="1.8"/><line x1="3" y1="12.5" x2="21" y2="12.5"/>',
  accounts: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  intel: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  system: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  setup: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
};
const navIcon = (key: TabKey) => `<svg class="st-icon" viewBox="0 0 24 24" aria-hidden="true">${NAV_ICON[key]}</svg>`;

/** What Steer is doing right now, from real workflow runs (never a sample feed). */
export interface AgentStatus {
  running: boolean;
  /** trusted HTML (callers escape their content) */
  html: string;
  since: string | null;
  sinceLabel: string | null;
}

export type Theme = 'light' | 'dark';

export function layout(i: LayoutInput): string {
  const dealerParam = i.dealerId ? { dealer: i.dealerId } : {};
  const byKey = new Map(TABS.map((t) => [t.key as TabKey, t]));
  const nav = NAV_GROUPS.map((g) => {
    const items = g.keys
      .map((key) => {
        const t = byKey.get(key)!;
        const badge = key === 'overview' && i.exceptions > 0 ? `<span class="nav-badge" title="需要你处理">${esc(i.exceptions > 99 ? '99+' : i.exceptions)}</span>` : '';
        const current = key === i.active ? ' aria-current="page"' : '';
        // The label is the accessible name when the rail is collapsed to icons, and the tooltip either way.
        return `<a class="nav-item${key === i.active ? ' active' : ''}" href="${esc(href(t.path, dealerParam))}"${current} title="${esc(t.label)}"><span class="nav-glyph">${navIcon(key)}</span><span class="nav-label">${esc(t.label)}</span>${badge}</a>`;
      })
      .join('');
    return `<div class="nav-group"><span class="nav-group-label">${esc(g.label)}</span>${items}</div>`;
  }).join('');
  const dealerSelect =
    i.dealers.length > 0
      ? `<label class="store-pill"><select class="store-select" data-dealer-switch aria-label="切换门店">${i.dealers
          .map((d) => `<option value="${esc(d.id)}"${d.id === i.dealerId ? ' selected' : ''}>${esc(d.name)}</option>`)
          .join('')}</select></label>`
      : '<span class="store-pill"><span class="store-empty">未配置门店</span></span>';
  const initial = Array.from(i.operator || '运')[0] ?? '运';
  const banners = i.banners.map((b) => `<div class="banner banner-${b.tone}">${b.html}</div>`).join('');
  const agent = i.agent
    ? `<div class="agent-now"><span class="st-dot ${i.agent.running ? 'st-dot-ai is-running' : 'st-dot-idle'}" aria-hidden="true"></span><span class="agent-text">${i.agent.html}</span>${
        i.agent.since ? `<span class="agent-ago" data-since="${esc(i.agent.since)}"${i.agent.running ? ' data-suffix="开始"' : ''}>· ${esc(i.agent.sinceLabel ?? '')}</span>` : ''
      }</div>`
    : '<div class="agent-now"></div>';
  const operatorLink = i.authEnabled
    ? `<a class="operator" href="/logout" title="操作人：${esc(i.operator)} · 点击退出">${esc(initial)}</a>`
    : `<a class="operator" href="/login" title="操作人：${esc(i.operator)} · 点击设置操作人">${esc(initial)}</a>`;
  return `<!doctype html>
<html lang="zh-CN"${i.theme ? ` data-theme="${i.theme}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(i.title)} · ${BRAND}</title>
<link rel="stylesheet" href="/assets/app.css?v=${ASSET_VERSION}">
<script src="/assets/app.js?v=${ASSET_VERSION}" defer></script>
</head>
<body class="app${i.railCollapsed ? ' is-rail' : ''}">
${SVG_DEFS}
<aside class="sidebar" aria-label="主导航">
  <div class="sidebar-head">
    <a class="brand" href="${esc(href('/', dealerParam))}" aria-label="${BRAND} 今日">${markSvg()}<span class="brand-name">${BRAND}</span></a>
    <button class="icon-btn rail-btn" type="button" data-action="rail" title="收起 / 展开导航" aria-label="收起或展开导航">${iconSvg('rail')}</button>
  </div>
  <nav class="nav">${nav}</nav>
  <div class="sidebar-foot">
    <button class="icon-btn" type="button" data-action="theme" title="切换深浅色" aria-label="切换深浅色">${iconSvg('moon')}</button>
    ${operatorLink}
  </div>
</aside>
<div class="workspace">
  <header class="topbar">
    ${agent}
    <div class="topbar-right">
      <form class="search" method="get" action="/leads" role="search">${ICON.search}<input name="q" placeholder="搜索线索、用户、车型" aria-label="搜索">${i.dealerId ? `<input type="hidden" name="dealer" value="${esc(i.dealerId)}">` : ''}</form>
      ${providerModePill(i.provider)}
      ${dealerSelect}
      <a class="btn btn-primary btn-sm" href="${esc(href('/', dealerParam))}#exceptions">待你处理 <span class="num">${esc(i.exceptions)}</span></a>
    </div>
  </header>
  <main class="content">
    ${i.hideHead ? '' : `<section class="page-head"><h1>${i.h1}</h1><p class="subtitle">${esc(i.subtitle)}</p></section>`}
    ${banners}
    ${i.body}
  </main>
</div>
</body></html>`;
}

export function bareLayout(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${BRAND}</title>
<link rel="stylesheet" href="/assets/app.css?v=${ASSET_VERSION}">
<script src="/assets/app.js?v=${ASSET_VERSION}" defer></script>
</head><body class="bare">${SVG_DEFS}<main class="bare-main">${body}</main></body></html>`;
}
