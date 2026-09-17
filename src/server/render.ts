/**
 * Server-side rendering helpers for the operator console: escaping, Chinese labels, status pills per
 * docs/UI_DESIGN.md §4, KPI cards, tables and the page layout (top bar, dealer switcher, tabs, honest banners).
 * Every piece of user, dealer or public Xiaohongshu content passes through `esc`.
 */
import { DEFAULT_TZ } from '../core/time.ts';
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
  CONTACTED: ['已触达', 'neutral'],
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
  BLOCKED: ['已拦截', 'red'],
  READY_FOR_REVIEW: ['待审核', 'amber'],
  APPROVED: ['已通过·待发送', 'amber'],
  SENT: ['已发送（平台确认）', 'green'],
  SENT_MANUALLY: ['已人工发送', 'green'],
  FAILED: ['发送失败', 'red'],
  CANCELLED: ['已取消', 'neutral'],
};

export const POST_STATUS: LabelMap<PostStatus> = {
  PLANNED: ['已计划', 'neutral'],
  DRAFTED: ['已生成', 'violet'],
  CHANGES_REQUIRED: ['需修改', 'red'],
  IN_REVIEW: ['待审批', 'amber'],
  APPROVED: ['已批准', 'green'],
  SCHEDULED: ['已排期', 'green'],
  READY_TO_PUBLISH: ['待人工发布', 'amber'],
  PUBLISHED: ['已发布', 'green'],
  FAILED: ['发布失败', 'red'],
  REJECTED: ['已驳回', 'neutral'],
};

export const HEALTH: LabelMap<HealthState> = {
  HEALTHY: ['健康', 'green'],
  WATCH: ['关注', 'amber'],
  AT_RISK: ['风险', 'amber'],
  RESTRICTED: ['受限', 'red'],
};

export const CAPABILITY: LabelMap<CapabilityStatus> = {
  AVAILABLE: ['可用', 'green'],
  UNAVAILABLE: ['不可用', 'red'],
  REQUIRES_AUTH: ['需登录', 'amber'],
  REQUIRES_REVIEW: ['需人工', 'amber'],
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
  draft: ['草稿待审核', 'amber'],
  sent: ['已发送（平台确认）', 'green'],
  sent_manually: ['已人工发送', 'green'],
  discarded: ['已丢弃', 'neutral'],
};

export const QUERY_CLASS: Record<string, string> = {
  direct_model: '车型直搜',
  competitor: '竞品对比',
  purchase_scenario: '购车场景',
  transaction_intent: '交易意图',
  location: '地域',
  derived: '衍生查询',
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
  out_of_area_cap: '异地上限',
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
  if (s === 'APPROVED' && !sendAvailable) return pill('已通过·待人工发送', 'amber');
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
  return `¥${formatCny(Math.round(amount))}`;
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

export function sectionHead(title: string, opts: { live?: boolean; note?: string; right?: string } = {}): string {
  return `<div class="section-head"><h2 class="section-title">${esc(title)}</h2>${opts.live ? '<span class="live">实时</span>' : ''}${opts.note ? `<span class="muted small">${esc(opts.note)}</span>` : ''}${opts.right ? `<span class="spacer"></span>${opts.right}` : ''}</div>`;
}

/** `rows` cells are trusted HTML (callers escape their content); headers are escaped. */
export function table(headers: string[], rows: string[][], opts: { compact?: boolean; empty?: string } = {}): string {
  if (rows.length === 0) return emptyState(opts.empty ?? '暂无数据');
  return `<div class="table-wrap"><table class="data${opts.compact ? ' compact' : ''}"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

export const emptyState = (text: string): string => `<div class="empty">${esc(text)}</div>`;

export function stat(label: string, value: string | number): string {
  return `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-num">${esc(value)}</div></div>`;
}

export function scoreBars(components: { factor: string; points: number; max: number; reason: string }[]): string {
  return components
    .map((c) => {
      const width = c.max > 0 ? Math.max(0, Math.min(100, Math.round((c.points / c.max) * 100))) : 0;
      return `<div class="bar-row"><span>${esc(FACTOR[c.factor] ?? c.factor)}</span><span class="bar"><i style="width:${width}%"></i></span><span class="num">${esc(Math.round(c.points * 10) / 10)}/${esc(c.max)}</span></div><div class="bar-reason">${esc(c.reason)}</div>`;
    })
    .join('');
}

/** JSON for a data-body attribute (escaped for an HTML attribute). */
export const dataBody = (value: unknown): string => esc(JSON.stringify(value));

// ─────────────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────────────

export const TABS = [
  { key: 'overview', label: '总览', path: '/' },
  { key: 'leads', label: '线索', path: '/leads' },
  { key: 'conversations', label: '对话', path: '/conversations' },
  { key: 'content', label: '内容', path: '/content' },
  { key: 'accounts', label: '账号', path: '/accounts' },
  { key: 'intel', label: '情报', path: '/intel' },
  { key: 'system', label: '系统', path: '/system' },
  { key: 'setup', label: '设置', path: '/setup' },
] as const;
export type TabKey = (typeof TABS)[number]['key'];

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
  /** trusted HTML placed right of the tabs row (defaults to the tabs) */
  search?: string;
}

export function providerModePill(provider: { name: string; mode: string }): string {
  if (provider.mode === 'live') return `<span class="mode-pill mode-live" title="${esc(provider.name)}">真实数据 · ${esc(provider.name)}</span>`;
  if (provider.mode === 'simulation') return '<span class="mode-pill mode-simulation" title="合成语料，仅用于测试和演示">模拟数据模式</span>';
  return '<span class="mode-pill mode-none" title="未配置小红书数据源">未连接小红书</span>';
}

export function layout(i: LayoutInput): string {
  const dealerParam = i.dealerId ? { dealer: i.dealerId } : {};
  const tabs = TABS.map((t) => `<a class="tab${t.key === i.active ? ' active' : ''}" href="${esc(href(t.path, dealerParam))}">${esc(t.label)}</a>`).join('');
  const dealerSelect =
    i.dealers.length > 0
      ? `<select class="pill-select" data-dealer-switch aria-label="切换门店">${i.dealers
          .map((d) => `<option value="${esc(d.id)}"${d.id === i.dealerId ? ' selected' : ''}>${esc(d.name)}</option>`)
          .join('')}</select>`
      : '<span class="pill-select" style="display:flex;align-items:center">未导入门店</span>';
  const initial = Array.from(i.operator || '运')[0] ?? '运';
  const banners = i.banners.map((b) => `<div class="banner banner-${b.tone}">${b.html}</div>`).join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(i.title)} · AI 汽车运营官</title>
<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/app.js" defer></script>
</head>
<body>
<header class="container topbar">
  <a class="brand" href="${esc(href('/', dealerParam))}"><span class="logo"></span>AI 汽车运营官</a>${providerModePill(i.provider)}
  <form class="search" method="get" action="/leads" role="search">${ICON.search}<input name="q" placeholder="搜索线索、用户、车型、笔记…" aria-label="搜索">${i.dealerId ? `<input type="hidden" name="dealer" value="${esc(i.dealerId)}">` : ''}</form>
  <div class="top-actions">
    ${dealerSelect}
    <a class="icon-btn" href="${esc(href('/', dealerParam))}#exceptions" aria-label="需要你处理">${ICON.bell}${i.exceptions > 0 ? '<span class="dot"></span>' : ''}</a>
    <span class="avatar" title="${esc(i.operator)}">${esc(initial)}</span>
    ${i.authEnabled ? '<a class="small muted" href="/logout">退出</a>' : '<a class="small muted" href="/login">设置操作人</a>'}
  </div>
</header>
<main class="container">
  ${banners}
  <section class="page-head">
    <div><h1>${i.h1}</h1><p class="subtitle">${esc(i.subtitle)}</p></div>
    <nav class="tabs" aria-label="主导航">${tabs}</nav>
  </section>
  ${i.body}
</main>
</body></html>`;
}

/** Minimal standalone page (login, errors). */
export function bareLayout(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · AI 汽车运营官</title>
<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/app.js" defer></script>
</head><body><main class="container">${body}</main></body></html>`;
}
