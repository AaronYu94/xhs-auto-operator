/**
 * TODAY dashboard (spec §17) and the "AI employee" briefing (spec §26): real counts over the period, snapshot
 * queues that need a human, pipeline value and fleet health — every line of the briefing is built from these numbers.
 */
import type { AppContext } from '../../../app/context.ts';
import { formatCny, round } from '../../../core/text.ts';
import { LEAD_STAGES, type LeadStage } from '../../../core/types.ts';
import { STAGE_INDEX, STAGE_WIN_PROBABILITY } from '../crm/index.ts';
import { accountsInScope, summarizeAccounts } from './accounts.ts';
import {
  consoleHref,
  enteredStageSql,
  leadScope,
  localDayWindow,
  normalizeFilters,
  num,
  periodDateKeys,
  periodFor,
  postScope,
  reachedStageSql,
  searchRunScope,
} from './filters.ts';
import {
  EXCEPTION_KINDS,
  type AnalyticsFilters,
  type DashboardException,
  type DashboardMetrics,
  type ExceptionKind,
  type ExceptionSeverity,
} from './types.ts';

/** Open pipeline stages: QUALIFIED … NEGOTIATING (WON/LOST excluded). */
export const OPEN_PIPELINE_STAGES: readonly LeadStage[] = LEAD_STAGES.filter(
  (s) => s !== 'WON' && s !== 'LOST' && STAGE_INDEX[s] >= STAGE_INDEX.QUALIFIED,
);

/** Outreach BLOCKED within this many days is listed as an exception. */
export const BLOCKED_WINDOW_DAYS = 7;
/** Proposed (unconfirmed) appointments scheduled within this many hours are listed as an exception. */
export const APPOINTMENT_WINDOW_HOURS = 48;

const EXCEPTION_DEFS: Record<ExceptionKind, { title: string; severity: ExceptionSeverity; path: string }> = {
  conversations_needs_human: { title: '对话需要人工接管', severity: 'high', path: '/conversations?needs_human=1' },
  outreach_review: { title: '私信待审核', severity: 'high', path: '/leads?outreach_status=READY_FOR_REVIEW' },
  appointments_unconfirmed: { title: '48小时内到店预约待确认', severity: 'high', path: '/leads?stage=APPOINTMENT' },
  outreach_manual_send: { title: '已审核私信待在小红书发送', severity: 'medium', path: '/leads?outreach_status=APPROVED' },
  posts_in_review: { title: '内容待审批', severity: 'medium', path: '/content?status=IN_REVIEW' },
  reply_drafts: { title: '对话回复草稿待审核', severity: 'medium', path: '/conversations?drafts=1' },
  engagement_replies_review: { title: '评论回复待审核', severity: 'medium', path: '/content?engagement_status=READY_FOR_REVIEW' },
  qualified_unassigned: { title: '合格线索尚未分配账号', severity: 'medium', path: '/leads?unassigned=1' },
  accounts_attention: { title: '账号需要关注', severity: 'medium', path: '/accounts' },
  workflow_failed: { title: '今日自动任务运行失败', severity: 'high', path: '/system?run_status=FAILED' },
  outreach_blocked: { title: '近7天被拦截的私信', severity: 'low', path: '/leads?outreach_status=BLOCKED' },
};

const SEVERITY_RANK: Record<ExceptionSeverity, number> = { high: 0, medium: 1, low: 2 };

export function getDashboard(ctx: AppContext, f: AnalyticsFilters = {}): DashboardMetrics {
  const n = normalizeFilters(ctx, f);
  const now = ctx.clock.now();
  const nowIso = now.toISOString();
  const period = periodFor(n, now);
  const leads = leadScope(n, 'l');
  const posts = postScope(n, 'p');
  const db = ctx.db;

  // ── content ───────────────────────────────────────────────────────────────
  const metric = (key: string) => `COALESCE(json_extract(p.metrics, '$.${key}'), 0)`;
  const published = db.get(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(${metric('views')}), 0) AS views,
            COALESCE(SUM(${metric('likes')} + ${metric('collects')} + ${metric('comments')} + ${metric('shares')}), 0) AS engagement
     FROM posts p
     WHERE p.status = 'PUBLISHED' AND p.published_at IS NOT NULL AND p.published_at >= ? AND p.published_at < ? AND ${posts.sql}`,
    period.from,
    period.to,
    ...posts.params,
  );
  const days = periodDateKeys(period);
  const planned = db.get(
    `SELECT COUNT(*) AS n FROM posts p WHERE p.slot_date >= ? AND p.slot_date <= ? AND p.status <> 'REJECTED' AND ${posts.sql}`,
    days.first,
    days.last,
    ...posts.params,
  );
  const inReview = db.get(`SELECT COUNT(*) AS n FROM posts p WHERE p.status = 'IN_REVIEW' AND ${posts.sql}`, ...posts.params);

  // ── discovery ─────────────────────────────────────────────────────────────
  const runs = searchRunScope(n, 'sr', 'q');
  const scanned = db.get(
    `SELECT COALESCE(SUM(sr.posts_discovered), 0) AS posts, COALESCE(SUM(sr.comments_scanned), 0) AS comments,
            COALESCE(SUM(sr.users_evaluated), 0) AS users
     FROM search_runs sr LEFT JOIN search_queries q ON q.id = sr.query_id
     WHERE sr.started_at >= ? AND sr.started_at < ? AND ${runs.sql}`,
    period.from,
    period.to,
    ...runs.params,
  );

  // ── funnel movements in period (lead_stage_transitions) ──────────────────
  const entered = (stage: LeadStage) => enteredStageSql(stage, 't');
  const distinctIf = (cond: string, alias: string) => `COUNT(DISTINCT CASE WHEN ${cond} THEN t.lead_id END) AS ${alias}`;
  const moves = db.get(
    `SELECT ${[
      distinctIf(entered('CANDIDATE'), 'candidates'),
      distinctIf(entered('QUALIFIED'), 'qualified'),
      distinctIf(`${entered('QUALIFIED')} AND l.tier IN ('high_intent', 'immediate')`, 'high_intent'),
      distinctIf(entered('CONTACTED'), 'contacted'),
      distinctIf(entered('SALES_QUALIFIED'), 'sales_qualified'),
      distinctIf(entered('CONTACT_ACQUIRED'), 'contacts_acquired'),
      distinctIf(entered('APPOINTMENT'), 'appointments'),
      distinctIf(entered('VISITED'), 'visits'),
      distinctIf(entered('WON'), 'won'),
      distinctIf(entered('LOST'), 'lost'),
    ].join(',\n')}
     FROM lead_stage_transitions t JOIN leads l ON l.id = t.lead_id
     WHERE t.at >= ? AND t.at < ? AND ${leads.sql}`,
    period.from,
    period.to,
    ...leads.params,
  );

  // ── outreach ──────────────────────────────────────────────────────────────
  // Drafts of closed leads (lost / won) need no action: they never count as something waiting for a human.
  const blockedSince = new Date(now.getTime() - BLOCKED_WINDOW_DAYS * 86_400_000).toISOString();
  const outreach = db.get(
    `SELECT SUM(CASE WHEN o.status IN ('READY_FOR_REVIEW', 'APPROVED') THEN 1 ELSE 0 END) AS ready,
            SUM(CASE WHEN o.status = 'READY_FOR_REVIEW' THEN 1 ELSE 0 END) AS review,
            SUM(CASE WHEN o.status = 'APPROVED' AND o.capability_status <> 'AVAILABLE' THEN 1 ELSE 0 END) AS manual_send,
            SUM(CASE WHEN o.status = 'BLOCKED' AND o.updated_at >= ? THEN 1 ELSE 0 END) AS blocked
     FROM outreach o JOIN leads l ON l.id = o.lead_id
     WHERE o.status IN ('READY_FOR_REVIEW', 'APPROVED', 'BLOCKED') AND l.stage NOT IN ('LOST', 'WON') AND ${leads.sql}`,
    blockedSince,
    ...leads.params,
  );
  const replies = db.get(
    `SELECT COUNT(m.id) AS replies, COUNT(DISTINCT c.lead_id) AS replied_leads
     FROM conversation_messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN leads l ON l.id = c.lead_id
     WHERE m.direction = 'inbound' AND m.created_at >= ? AND m.created_at < ? AND ${leads.sql}`,
    period.from,
    period.to,
    ...leads.params,
  );
  const contacted = num(moves, 'contacted');
  const repliedLeads = num(replies, 'replied_leads');
  const replyRate = contacted > 0 ? Math.min(1, round(repliedLeads / contacted, 4)) : 0;

  // ── pipeline ──────────────────────────────────────────────────────────────
  const pipelineRows = db.all(
    `SELECT l.stage AS stage, COUNT(*) AS n, COALESCE(SUM(l.estimated_value), 0) AS value
     FROM leads l
     WHERE l.suppressed = 0 AND l.stage IN (${OPEN_PIPELINE_STAGES.map((s) => `'${s}'`).join(', ')}) AND ${leads.sql}
     GROUP BY l.stage`,
    ...leads.params,
  );
  const byStage = OPEN_PIPELINE_STAGES.map((stage) => {
    const row = pipelineRows.find((r) => r.stage === stage);
    return { stage, count: num(row, 'n'), value: Math.round(num(row, 'value') * STAGE_WIN_PROBABILITY[stage]) };
  });
  const pipelineValue = byStage.reduce((sum, s) => sum + s.value, 0);

  // ── accounts ──────────────────────────────────────────────────────────────
  const accounts = summarizeAccounts(ctx, accountsInScope(ctx, n));

  // ── exception queues (current state) ─────────────────────────────────────
  const needsHuman = db.get(
    `SELECT COUNT(*) AS n FROM conversations c JOIN leads l ON l.id = c.lead_id
     WHERE c.needs_human = 1 AND c.status <> 'closed' AND ${leads.sql}`,
    ...leads.params,
  );
  const replyDrafts = db.get(
    `SELECT COUNT(*) AS n FROM conversation_messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN leads l ON l.id = c.lead_id
     WHERE m.direction = 'outbound' AND m.status = 'draft' AND c.status <> 'closed' AND ${leads.sql}`,
    ...leads.params,
  );
  const engagementReview = db.get(
    `SELECT COUNT(*) AS n FROM engagement_replies e JOIN posts p ON p.id = e.post_id
     WHERE e.status = 'READY_FOR_REVIEW' AND ${posts.sql}`,
    ...posts.params,
  );
  const appointmentsUnconfirmed = db.get(
    `SELECT COUNT(*) AS n FROM appointments a JOIN leads l ON l.id = a.lead_id
     WHERE a.status = 'proposed' AND a.scheduled_for IS NOT NULL AND a.scheduled_for >= ? AND a.scheduled_for < ? AND ${leads.sql}`,
    nowIso,
    new Date(now.getTime() + APPOINTMENT_WINDOW_HOURS * 3_600_000).toISOString(),
    ...leads.params,
  );
  const unassigned = db.get(
    `SELECT COUNT(*) AS n FROM leads l
     WHERE ${reachedStageSql('QUALIFIED', 'l.stage')} AND l.stage <> 'WON' AND l.suppressed = 0
       AND NOT EXISTS (SELECT 1 FROM lead_assignments a WHERE a.lead_id = l.id AND a.active = 1)
       AND ${leads.sql}`,
    ...leads.params,
  );
  const today = localDayWindow(now, n.timezone);
  const failedRuns = db.get(
    `SELECT COUNT(*) AS n FROM workflow_runs w
     WHERE w.status = 'FAILED' AND COALESCE(w.finished_at, w.started_at) >= ? AND COALESCE(w.finished_at, w.started_at) < ?
       ${n.scope_dealer_id !== null ? 'AND w.dealer_id = ?' : ''}`,
    today.from,
    today.to,
    ...(n.scope_dealer_id !== null ? [n.scope_dealer_id] : []),
  );

  const counts: Record<ExceptionKind, number> = {
    conversations_needs_human: num(needsHuman, 'n'),
    outreach_review: num(outreach, 'review'),
    appointments_unconfirmed: num(appointmentsUnconfirmed, 'n'),
    outreach_manual_send: num(outreach, 'manual_send'),
    posts_in_review: num(inReview, 'n'),
    reply_drafts: num(replyDrafts, 'n'),
    engagement_replies_review: num(engagementReview, 'n'),
    qualified_unassigned: num(unassigned, 'n'),
    accounts_attention: accounts.requiring_attention.length,
    workflow_failed: num(failedRuns, 'n'),
    outreach_blocked: num(outreach, 'blocked'),
  };
  const severeAccounts = accounts.requiring_attention.some((a) => a.state === 'RESTRICTED' || a.state === 'AT_RISK');
  const exceptions: DashboardException[] = EXCEPTION_KINDS.filter((kind) => counts[kind] > 0)
    .map((kind) => {
      const def = EXCEPTION_DEFS[kind];
      const severity: ExceptionSeverity = kind === 'accounts_attention' && severeAccounts ? 'high' : def.severity;
      return { kind, title: def.title, count: counts[kind], severity, href: consoleHref(def.path, n.scope_dealer_id) };
    })
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || EXCEPTION_KINDS.indexOf(a.kind) - EXCEPTION_KINDS.indexOf(b.kind));

  const metrics: Omit<DashboardMetrics, 'briefing'> = {
    period,
    generated_at: nowIso,
    content: {
      posts_published: num(published, 'n'),
      views: num(published, 'views'),
      engagement: num(published, 'engagement'),
      posts_planned: num(planned, 'n'),
      posts_pending_approval: num(inReview, 'n'),
    },
    discovery: {
      posts_scanned: num(scanned, 'posts'),
      comments_scanned: num(scanned, 'comments'),
      users_evaluated: num(scanned, 'users'),
      candidates: num(moves, 'candidates'),
      qualified: num(moves, 'qualified'),
      high_intent: num(moves, 'high_intent'),
    },
    outreach: {
      outreach_ready: num(outreach, 'ready'),
      contacted,
      replies: num(replies, 'replies'),
      reply_rate: replyRate,
    },
    sales: {
      sales_qualified: num(moves, 'sales_qualified'),
      contacts_acquired: num(moves, 'contacts_acquired'),
      appointments: num(moves, 'appointments'),
      visits: num(moves, 'visits'),
      won: num(moves, 'won'),
      lost: num(moves, 'lost'),
    },
    pipeline: { estimated_value: pipelineValue, by_stage: byStage },
    accounts,
    exceptions,
  };
  return { ...metrics, briefing: buildBriefing(metrics, counts) };
}

/**
 * Chinese "AI employee" lines built ONLY from the computed numbers. Zero-valued facts are omitted; when nothing
 * happened a single honest line says so. Prefix '今日' for the default period, '本期' for custom windows.
 */
export function buildBriefing(m: Omit<DashboardMetrics, 'briefing'>, counts: Record<ExceptionKind, number>): string[] {
  const p = m.period.is_today ? '今日' : '本期';
  const lines: string[] = [];
  const { content, discovery, outreach, sales } = m;

  if (content.posts_planned > 0) {
    lines.push(`${p}计划 ${content.posts_planned} 篇内容${content.posts_pending_approval > 0 ? `，${content.posts_pending_approval} 篇待审批` : ''}`);
  } else if (content.posts_pending_approval > 0) {
    lines.push(`${content.posts_pending_approval} 篇内容待审批`);
  }
  if (content.posts_published > 0) {
    const parts = [`${p}已发布 ${content.posts_published} 篇内容`];
    if (content.views > 0) parts.push(`浏览 ${content.views} 次`);
    if (content.engagement > 0) parts.push(`互动 ${content.engagement} 次`);
    lines.push(parts.join('，'));
  }

  const signals = discovery.posts_scanned + discovery.comments_scanned;
  if (signals > 0) {
    const prefix = m.period.is_today ? '' : '本期';
    lines.push(`${prefix}分析了 ${signals} 条公开信号${discovery.users_evaluated > 0 ? `，评估了 ${discovery.users_evaluated} 位用户` : ''}`);
  }
  if (discovery.qualified > 0) {
    lines.push(`发现 ${discovery.qualified} 条合格线索${discovery.high_intent > 0 ? `，其中 ${discovery.high_intent} 条高意向` : ''}`);
  } else if (discovery.candidates > 0) {
    lines.push(`发现 ${discovery.candidates} 条候选线索，暂无合格线索`);
  }

  if (counts.outreach_review > 0) lines.push(`${counts.outreach_review} 条私信待你审核`);
  if (counts.outreach_manual_send > 0) lines.push(`${counts.outreach_manual_send} 条已审核私信待你在小红书发送`);
  if (outreach.contacted > 0) {
    lines.push(
      `${p}触达 ${outreach.contacted} 位潜在客户${
        outreach.replies > 0 ? `，收到 ${outreach.replies} 条回复（回复率 ${round(outreach.reply_rate * 100, 1)}%）` : ''
      }`,
    );
  } else if (outreach.replies > 0) {
    lines.push(`收到 ${outreach.replies} 条客户回复`);
  }
  if (counts.conversations_needs_human > 0) lines.push(`${counts.conversations_needs_human} 条回复需要人工处理`);
  if (counts.reply_drafts > 0) lines.push(`${counts.reply_drafts} 条回复草稿待审核`);
  if (counts.engagement_replies_review > 0) lines.push(`${counts.engagement_replies_review} 条评论回复待审核`);

  if (sales.sales_qualified > 0) lines.push(`${sales.sales_qualified} 位客户通过销售资格确认`);
  if (sales.contacts_acquired > 0) lines.push(`获取 ${sales.contacts_acquired} 位客户的联系方式`);
  if (sales.appointments > 0) lines.push(`新增 ${sales.appointments} 个到店预约`);
  if (sales.visits > 0) lines.push(`${sales.visits} 位客户到店看车`);
  if (sales.won > 0) lines.push(`成交 ${sales.won} 台`);
  if (sales.lost > 0) lines.push(`${sales.lost} 条线索流失`);
  if (counts.appointments_unconfirmed > 0) lines.push(`${counts.appointments_unconfirmed} 个48小时内的到店预约尚未确认`);

  if (m.pipeline.estimated_value > 0) lines.push(`预计管道价值 ${formatCny(m.pipeline.estimated_value)}`);
  if (counts.qualified_unassigned > 0) lines.push(`${counts.qualified_unassigned} 条合格线索尚未分配账号`);
  if (counts.accounts_attention > 0) lines.push(`${counts.accounts_attention} 个账号需要关注`);
  if (counts.workflow_failed > 0) lines.push(`${counts.workflow_failed} 个自动任务今日运行失败`);
  if (counts.outreach_blocked > 0) lines.push(`近7天有 ${counts.outreach_blocked} 条私信被发送前检查拦截`);

  if (lines.length === 0) lines.push(`${p}暂无新的运营进展`);
  return lines;
}
