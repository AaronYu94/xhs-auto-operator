/**
 * Operator-facing view of an `agent_decisions` row: what Steer decided, in one Chinese line.
 *
 * The rail on 今日 and the audit list on 系统 read from the same place. Every decision type that stores structured
 * output gets a summary built from it; anything else falls back to the decision's own `reason` / `summary` text, then
 * to its evidence. Raw ids are never shown here — they belong to 系统 → AI 决策审计, which prints the whole record.
 */
import type { AgentDecision, ScoreTier } from '../../core/types.ts';
import { humanGuardCheck, scrubInternals } from '../humanize.ts';

export const DECISION_TITLE: Record<string, string> = {
  lead_prefilter: '筛了一遍公开留言',
  intent_detection: '识别购车意图',
  lead_qualification: '这个人可以跟了',
  lead_score: '更新线索评分',
  lead_dedup_merge: '合并同一用户的信号',
  account_assignment: '分配负责账号',
  outreach_generation: '生成个性化私信',
  outreach_guard: '发私信前的检查',
  conversation_reply: '起草对话回复',
  sales_qualification: '判断他买车到哪一步了',
  appointment: '到店预约',
  content_strategy: '制定账号内容策略',
  content_plan: '生成内容计划',
  content_generation: '撰写笔记',
  content_fact_review: '核对说的是不是真的',
  content_duplicate_review: '查有没有和以前发重了',
  query_generation: '生成搜索词',
  query_optimization: '优化搜索词',
  goal_planning: '拆解经营目标',
  account_health: '看账号状态好不好',
  optimization: '怎么做能更好',
  research: '市场与竞品研究',
  engagement_reply: '起草评论回复',
  report: '生成运营简报',
  lead_research: '看了看他的主页',
};

// An unmapped decision type is an internal name; it is never printed as one.
export const decisionTitle = (type: string): string => DECISION_TITLE[type] ?? 'AI 判断';

const TIER_LABEL: Record<ScoreTier | string, string> = {
  immediate: '立即跟进',
  high_intent: '高意向',
  qualified: '合格',
  candidate: '候选',
  none: '未达候选',
};

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : {});
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x.trim() : null);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const signed = (n: number): string => (n > 0 ? `+${n}` : `${n}`);

/** Per-type summaries built from the stored output (the generic text keys cover the rest). */
const SUMMARY: Record<string, (out: Obj) => string | null> = {
  outreach_guard: (out) => {
    const guards = arr(out.guards).map(obj);
    if (guards.length === 0) return null;
    const status = str(out.status);
    // Only a blocking guard stops the message; 「需人工审核」/「私信能力不可用」 fail without blocking and are the
    // normal path (Steer never sends DMs itself), so they must not read as "被拦下".
    const blocked = guards.find((g) => g.passed === false && g.blocking === true) ?? (status === 'BLOCKED' ? guards.find((g) => g.passed === false) : undefined);
    if (blocked) return `被拦下了：${scrubInternals(str(blocked.detail)) || humanGuardCheck(str(blocked.check))}`;
    const next = status === 'READY_FOR_REVIEW' ? '草稿等你看一眼，再由人发出去' : status === 'APPROVED' ? '你已经通过了，等人发出去' : '可以发';
    return `发送前查了 ${guards.length} 项，都没问题，${next}`;
  },
  lead_score: (out) => {
    const score = num(out.score);
    if (score === null) return null;
    const tier = TIER_LABEL[String(out.tier)] ?? String(out.tier ?? '');
    const prev = num(out.previous_score);
    const delta = prev !== null && prev !== score ? `，较上次 ${signed(Math.round(score - prev))}` : '';
    const capped = out.out_of_area_capped === true ? '；不在本地，分数压低了' : '';
    return `评分 ${Math.round(score)}（${tier}）${delta}${capped}`;
  },
  lead_qualification: (out) => {
    const score = num(out.score);
    if (score === null) return null;
    const top = arr(out.components).map(obj).find((c) => (num(c.points) ?? 0) > 0);
    const why = top ? `：${str(top.reason) ?? ''}` : '';
    return `达到合格（${Math.round(score)} 分）${why}`;
  },
  lead_dedup_merge: (out) => {
    const by = str(out.matched_by);
    if (!by) return null;
    const how = by === 'platform_user_id' ? '同一个小红书用户' : by === 'profile_url' ? '同一个主页' : '同一个人';
    const score = num(out.signal_score);
    return `认出是${how}，${out.intent_merged === true ? '和之前的记到一起' : '记成一条新的'}${score !== null ? `（${Math.round(score)} 分）` : ''}`;
  },
  lead_prefilter: (out) => {
    const screen = obj(out.screen);
    const candidates = num(screen.candidates);
    if (candidates === null) return null;
    const buyers = num(screen.buyers) ?? 0;
    const rejected = Object.values(obj(screen.rejected)).reduce<number>((s, n) => s + (num(n) ?? 0), 0);
    const out_of_area = num(screen.out_of_area) ?? 0;
    const parts = [`AI 看了 ${candidates} 条留言，${buyers} 位像是要买车的`];
    if (rejected > 0) parts.push(`排掉同行、车主和闲聊 ${rejected} 条`);
    if (out_of_area > 0) parts.push(`${out_of_area} 位不在我们卖车的地方`);
    return parts.join('，');
  },
};

/** One line describing the decision; '' when the record carries nothing an operator could read. */
export function decisionText(d: Pick<AgentDecision, 'decision_type' | 'output' | 'evidence'>): string {
  const out = obj(d.output);
  const summary = SUMMARY[d.decision_type]?.(out);
  if (summary) return summary;
  for (const key of ['reason', 'summary', 'headline', 'message', 'next_action']) {
    const val = out[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'string') return val.slice(0, 2).join('；');
  }
  return (d.evidence ?? [])
    .map((e) => (e.quote ? `${e.label}：“${e.quote}”` : e.label))
    .slice(0, 2)
    .join('；');
}
