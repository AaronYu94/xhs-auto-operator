/**
 * Operator report (spec §20 "evening: generate operator report", §26 AI-employee briefing).
 *
 * Built only from real tables through the analytics module — TODAY dashboard, funnel snapshot, search intelligence,
 * account fleet, content attribution — plus the latest persisted capability snapshots and the lead data provenance
 * (live Xiaohongshu vs import vs simulation). Every summary line is derived from a number in the report; nothing is
 * estimated or invented. Reports are persisted (`operator_reports`) and recorded as a 'report' decision.
 */
import type { AppContext } from '../../../app/context.ts';
import { NotFoundError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import { formatCny } from '../../../core/text.ts';
import { DEFAULT_TZ, localDateKey } from '../../../core/time.ts';
import { DATA_MODES, type CapabilitySnapshot, type DataMode, type OperatorReport } from '../../../core/types.ts';
import { v } from '../../../core/validate.ts';
import { defineSkill } from '../../registry.ts';
import { getQueryEffectiveness } from '../../acquisition/automotive-query-generation/index.ts';
import { getAccountsOverview, getContentAttribution, getDashboard, getFunnel } from '../analytics/index.ts';

export const REPORT_AGENT = 'analytics-agent';
export const SKILL_NAME = 'reporting';

const CAPABILITY_LABELS: Record<string, string> = {
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
const STATUS_LABELS: Record<string, string> = {
  AVAILABLE: '可用',
  UNAVAILABLE: '不可用',
  REQUIRES_AUTH: '需要登录',
  REQUIRES_REVIEW: '需人工确认',
};
const DATA_MODE_LABELS: Record<DataMode, string> = { live: '真实小红书', import: '人工导入', manual: '手工录入', simulation: '模拟数据', unknown: '来源未知' };

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PROVIDER_LEVEL_CAPABILITIES: ReadonlySet<string> = new Set(['search_public_content', 'read_public_post', 'read_public_comments', 'read_public_profile', 'llm']);

export interface CapabilityBlock {
  capability: string;
  label: string;
  account_id: string | null;
  status: string;
  reason: string;
  checked_at: string;
}

/** Latest snapshot per (provider, account, capability) that is NOT available — the blocks an operator must know about. */
export function latestCapabilityBlocks(ctx: AppContext, dealerId: string): { provider: { name: string; mode: string }; blocks: CapabilityBlock[]; checked: number } {
  const accountIds = new Set(ctx.db.table('xhs_accounts').findMany({ dealer_id: dealerId }).map((a) => a.id));
  const rows = ctx.db.all<CapabilitySnapshot>(
    `SELECT s.* FROM capability_snapshots s
     JOIN (SELECT provider, IFNULL(account_id, '') AS acc, capability, MAX(checked_at) AS at
           FROM capability_snapshots GROUP BY provider, IFNULL(account_id, ''), capability) latest
       ON latest.provider = s.provider AND latest.acc = IFNULL(s.account_id, '') AND latest.capability = s.capability AND latest.at = s.checked_at
     WHERE s.provider = ?`,
    ctx.xhs.name,
  );
  // Provider-level probes (account_id null) are authoritative only for public reads and the LLM; account-scoped
  // capabilities (publish, engagement, DMs, comment replies) are judged from each account's own probe.
  const relevant = rows.filter((r) =>
    r.account_id === null ? PROVIDER_LEVEL_CAPABILITIES.has(r.capability) : accountIds.has(r.account_id),
  );
  const seen = new Set<string>();
  const blocks: CapabilityBlock[] = [];
  for (const r of relevant) {
    const key = `${r.account_id ?? ''}|${r.capability}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (r.status === 'AVAILABLE') continue;
    blocks.push({
      capability: r.capability,
      label: CAPABILITY_LABELS[r.capability] ?? r.capability,
      account_id: r.account_id,
      status: r.status,
      reason: r.reason,
      checked_at: r.checked_at,
    });
  }
  const llm = ctx.llm.status();
  if (llm.status !== 'AVAILABLE') {
    blocks.push({ capability: 'llm', label: CAPABILITY_LABELS.llm, account_id: null, status: llm.status, reason: llm.reason, checked_at: ctx.clock.iso() });
  }
  blocks.sort((a, b) => a.capability.localeCompare(b.capability) || (a.account_id ?? '').localeCompare(b.account_id ?? ''));
  return { provider: { name: ctx.xhs.name, mode: ctx.xhs.mode }, blocks, checked: relevant.length };
}

/** Lead counts by provenance: all open leads of the dealer and leads first seen within [from, to). */
export function leadProvenance(ctx: AppContext, dealerId: string, from: string, to: string): { all: Record<DataMode, number>; period: Record<DataMode, number> } {
  const zero = () => Object.fromEntries(DATA_MODES.map((m) => [m, 0])) as Record<DataMode, number>;
  const all = zero();
  const period = zero();
  for (const r of ctx.db.all<{ data_mode: DataMode; n: number }>('SELECT data_mode, COUNT(*) AS n FROM leads WHERE dealer_id = ? GROUP BY data_mode', dealerId)) {
    if (r.data_mode in all) all[r.data_mode] = Number(r.n);
  }
  for (const r of ctx.db.all<{ data_mode: DataMode; n: number }>(
    'SELECT data_mode, COUNT(*) AS n FROM leads WHERE dealer_id = ? AND created_at >= ? AND created_at < ? GROUP BY data_mode',
    dealerId,
    from,
    to,
  )) {
    if (r.data_mode in period) period[r.data_mode] = Number(r.n);
  }
  return { all, period };
}

export interface OperatorReportBody {
  dealer: { id: string; name: string };
  date: string;
  period: { from: string; to: string; timezone: string };
  summary: string[];
  dashboard: ReturnType<typeof getDashboard>;
  funnel: ReturnType<typeof getFunnel>;
  top_queries: { query_id: string; text: string; runs: number; users_evaluated: number; qualified: number; lead_density: number; smoothed_density: number }[];
  accounts: ReturnType<typeof getAccountsOverview>;
  top_content: ReturnType<typeof getContentAttribution>;
  provenance: ReturnType<typeof leadProvenance>;
  capabilities: ReturnType<typeof latestCapabilityBlocks>;
  workflow_runs: { total: number; succeeded: number; partial: number; failed: number; running: number };
}

function buildSummary(body: Omit<OperatorReportBody, 'summary'>): string[] {
  const d = body.dashboard;
  const lines: string[] = [];
  const { posts_scanned, comments_scanned, users_evaluated, candidates, qualified, high_intent } = d.discovery;
  if (posts_scanned + comments_scanned > 0) {
    lines.push(`今日扫描 ${posts_scanned} 篇公开笔记、${comments_scanned} 条评论，评估 ${users_evaluated} 位公开用户`);
  } else {
    lines.push('今日没有完成任何公开内容扫描');
  }
  lines.push(`新增候选线索 ${candidates} 条，合格线索 ${qualified} 条（其中高意向 ${high_intent} 条）`);
  const o = d.outreach;
  lines.push(`私信待审核/待人工发送 ${o.outreach_ready} 条；今日已触达 ${o.contacted} 位，收到回复 ${o.replies} 条`);
  const s = d.sales;
  if (s.sales_qualified + s.contacts_acquired + s.appointments + s.visits + s.won + s.lost > 0) {
    lines.push(`销售进展：销售合格 ${s.sales_qualified}，获得联系方式 ${s.contacts_acquired}，新增预约 ${s.appointments}，到店 ${s.visits}，成交 ${s.won}，流失 ${s.lost}`);
  } else {
    lines.push('今日暂无新的销售阶段推进（预约/到店/成交）');
  }
  lines.push(`管道预计价值 ¥${formatCny(d.pipeline.estimated_value)}（按阶段成交概率加权）`);
  const c = d.content;
  lines.push(`内容：计划 ${c.posts_planned} 篇，已发布 ${c.posts_published} 篇，待审批 ${c.posts_pending_approval} 篇，互动 ${c.engagement}`);
  const p = body.provenance.period;
  const periodTotal = DATA_MODES.reduce((sum, m) => sum + p[m], 0);
  if (periodTotal > 0) {
    const parts = DATA_MODES.filter((m) => p[m] > 0).map((m) => `${DATA_MODE_LABELS[m]} ${p[m]}`);
    lines.push(`今日新线索数据来源：${parts.join(' · ')}`);
  }
  if (body.provenance.all.simulation > 0) lines.push(`注意：库中有 ${body.provenance.all.simulation} 条模拟数据线索，不是真实客户`);
  const attention = d.accounts.requiring_attention.length;
  lines.push(`账号：活跃 ${d.accounts.active} 个，健康 ${d.accounts.healthy} 个${attention > 0 ? `，${attention} 个需要关注` : ''}`);
  const blocks = body.capabilities.blocks.filter((b) => b.capability !== 'llm');
  const byCap = new Map<string, CapabilityBlock[]>();
  for (const b of blocks) byCap.set(b.capability, [...(byCap.get(b.capability) ?? []), b]);
  for (const [cap, items] of byCap) {
    const statuses = [...new Set(items.map((i) => STATUS_LABELS[i.status] ?? i.status))].join('/');
    lines.push(`能力受限：${CAPABILITY_LABELS[cap] ?? cap}${statuses}（${items.length} 项检测）`);
  }
  const w = body.workflow_runs;
  if (w.failed > 0) lines.push(`今日有 ${w.failed} 个自动任务失败，需要查看`);
  return lines;
}

/**
 * Generate and persist the operator report for a dealer-local date (default: today in the dealer timezone).
 */
export function generateOperatorReport(ctx: AppContext, dealerId: string, date?: string): OperatorReport {
  const dealer = ctx.db.table('dealers').get(dealerId);
  if (!dealer) throw new NotFoundError('dealer', dealerId);
  const tz = dealer.settings?.timezone || DEFAULT_TZ;
  const day = date ?? localDateKey(ctx.clock.now(), tz);
  if (!DATE_KEY_RE.test(day)) throw new NotFoundError('report date', day);

  const dashboard = getDashboard(ctx, { dealer_id: dealerId, from: day, to: day });
  const { from, to } = dashboard.period;
  const funnel = getFunnel(ctx, { dealer_id: dealerId });
  const top_queries = getQueryEffectiveness(ctx, dealerId)
    .filter((q) => q.runs > 0)
    .slice(0, 5)
    .map((q) => ({
      query_id: q.query.id,
      text: q.query.text,
      runs: q.runs,
      users_evaluated: q.users_evaluated,
      qualified: q.qualified,
      lead_density: q.lead_density,
      smoothed_density: q.smoothed_density,
    }));
  const accounts = getAccountsOverview(ctx, dealerId);
  const top_content = getContentAttribution(ctx, { dealer_id: dealerId }).slice(0, 5);
  const provenance = leadProvenance(ctx, dealerId, from, to);
  const capabilities = latestCapabilityBlocks(ctx, dealerId);
  const runs = ctx.db.all<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM workflow_runs WHERE dealer_id = ? AND started_at >= ? AND started_at < ? GROUP BY status',
    dealerId,
    from,
    to,
  );
  const count = (s: string) => Number(runs.find((r) => r.status === s)?.n ?? 0);
  const workflow_runs = {
    total: runs.reduce((sum, r) => sum + Number(r.n), 0),
    succeeded: count('SUCCEEDED'),
    partial: count('PARTIAL'),
    failed: count('FAILED'),
    running: count('RUNNING'),
  };

  const partial: Omit<OperatorReportBody, 'summary'> = {
    dealer: { id: dealer.id, name: dealer.name },
    date: day,
    period: { from, to, timezone: dashboard.period.timezone },
    dashboard,
    funnel,
    top_queries,
    accounts,
    top_content,
    provenance,
    capabilities,
    workflow_runs,
  };
  const body: OperatorReportBody = { ...partial, summary: buildSummary(partial) };
  const report = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;

  return ctx.db.tx(() => {
    const row = ctx.db.table('operator_reports').insert({
      id: newId('rpt'),
      dealer_id: dealerId,
      date: day,
      report,
      workflow_run_id: ctx.runId,
      created_at: ctx.clock.iso(),
    });
    ctx.audit.decision({
      agent: REPORT_AGENT,
      skill: SKILL_NAME,
      decision_type: 'report',
      subject_type: 'dealer',
      subject_id: dealerId,
      inputs: { date: day, period: { from, to } },
      evidence: [],
      output: { report_id: row.id, summary: body.summary },
      confidence: 1,
      engine: 'rules',
    });
    return row;
  });
}

/** Most recent persisted report of a dealer (optionally for one date). */
export function getLatestReport(ctx: AppContext, dealerId: string, date?: string): OperatorReport | null {
  return (
    ctx.db.table('operator_reports').findOne(date ? { dealer_id: dealerId, date } : { dealer_id: dealerId }, { orderBy: 'created_at DESC, id DESC' }) ?? null
  );
}

export const skill = defineSkill<{ dealer_id: string; date?: string }, OperatorReport>({
  name: SKILL_NAME,
  category: 'operations',
  agent: REPORT_AGENT,
  description: '生成经营日报：发现/触达/销售/内容/账号/能力受限与数据来源，全部来自真实数据表',
  input: v.object({ dealer_id: v.string({ min: 1 }), date: v.optional(v.string({ pattern: DATE_KEY_RE })) }),
  run: (ctx, input) => generateOperatorReport(ctx, input.dealer_id, input.date),
  validateOutput: (out) => {
    if (!out || typeof out.id !== 'string' || !Array.isArray((out.report as { summary?: unknown }).summary)) {
      throw new Error('reporting: report row without summary');
    }
  },
});
