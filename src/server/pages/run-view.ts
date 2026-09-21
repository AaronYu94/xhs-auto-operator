/**
 * User-facing view of a workflow run: step names, results and failures in plain Chinese, plus progress. The raw
 * record (run id, agents, skills, input / output JSON, raw errors) stays available under 技术详情 on the page; nothing
 * here invents data: every summary is read from the step's stored output, and unknown outputs produce no summary.
 */
import type { StepStatus, WorkflowRun, WorkflowStatus, WorkflowStep, WorkflowTrigger } from '../../core/types.ts';
import { humanProblem } from '../humanize.ts';

export type StepState = 'done' | 'running' | 'failed' | 'skipped' | 'waiting';

export interface StepView {
  key: string;
  title: string;
  /** what the step does, from the workflow definition */
  purpose: string | null;
  state: StepState;
  /** one line read from the step output, e.g. "生成 71 个搜索词" */
  summary: string | null;
  /** plain-language failure / skip reason and what to do */
  problem: string | null;
}

export interface RunView {
  headline: string;
  tone: 'ok' | 'warn' | 'bad' | 'running' | 'neutral';
  /** failure explanation and next step for the operator */
  advice: string | null;
  steps: StepView[];
  /** steps that did their work */
  done: number;
  /** steps that were skipped (did not do their work) */
  skipped: number;
  total: number;
  /** processed (done + skipped) ÷ total: how far the run got */
  percent: number;
  running: boolean;
  resumable: boolean;
  trigger: string;
}

export const STEP_TITLE: Record<string, string> = {
  check_dealer_facts: '检查门店资料',
  account_health: '看看每个号状态好不好',
  account_sessions: '检测账号登录',
  capability_snapshot: '看看这些号现在能做什么',
  xhs_research: '看看买车的人都在问什么',
  competitor_research: '研究竞品',
  market_research: '研究市场行情',
  trend_detection: '看最近什么话题火',
  plan_content: '制定内容计划',
  generate_posts: '撰写笔记',
  review_posts: '核对笔记里说的对不对',
  publish_due: '发布到期笔记',
  ensure_queries: '准备搜索词',
  discover: '搜索公开笔记和评论',
  research_leads: '看看这些人的主页',
  assign_leads: '分配给最合适的账号',
  prepare_outreach: '写私信草稿',
  evolve_queries: '把搜索词调得更准',
  poll_inbox: '查收客户回复',
  plan_follow_ups: '安排跟进',
  collect_performance: '看看发出去的笔记数据',
  collect_own_comments: '读取自家笔记的评论',
  draft_engagement_replies: '起草评论回复',
  optimize: '想想哪里还能做得更好',
  operator_report: '生成经营日报',
  update_goal_progress: '更新目标进度',
};

export const TRIGGER_LABEL: Record<WorkflowTrigger, string> = {
  schedule: '按排班自动运行',
  manual: '手动运行',
  goal: '经营目标触发',
  api: '在控制台运行',
  resume: '从中断处继续',
};

const STATE_OF: Record<StepStatus, StepState> = { PENDING: 'waiting', RUNNING: 'running', SUCCEEDED: 'done', FAILED: 'failed', SKIPPED: 'skipped' };

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : {});
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const sum = (rows: unknown[], key: string): number => rows.reduce<number>((s, r) => s + (num(obj(r)[key]) ?? 0), 0);

/** What went wrong, in the store's terms (`humanize.ts` owns the wording for the whole console). */
export const explainProblem = humanProblem;

/** One-line result of a step, read from its stored output. */
export function summarizeStep(key: string, output: Obj): string | null {
  const o = obj(output);
  switch (key) {
    case 'ensure_queries': {
      const generated = num(o.generated);
      return generated === null ? null : `生成 ${generated} 个搜索词${num(o.active) !== null && o.active !== generated ? `，启用 ${o.active} 个` : ''}`;
    }
    case 'discover': {
      const runs = arr(o.runs);
      if (!runs.length) return null;
      const posts = sum(runs, 'posts_discovered');
      const comments = sum(runs, 'comments_scanned');
      const users = sum(runs, 'users_evaluated');
      const qualified = sum(runs, 'qualified');
      const failed = runs.filter((r) => obj(r).status && obj(r).status !== 'SUCCEEDED').length;
      return `搜了 ${runs.length} 次，读了 ${posts} 篇笔记、${comments} 条评论，看了 ${users} 个人，找到 ${qualified} 位像要买车的${failed ? `（有 ${failed} 次没搜成）` : ''}`;
    }
    case 'research_leads':
      return num(o.researched) === null ? null : `研究了 ${o.researched} 位线索的公开主页`;
    case 'assign_leads':
      return num(o.assigned) === null ? null : `${o.assigned} 位线索已分配${num(o.not_assigned) ? `，${o.not_assigned} 位暂未分配` : ''}`;
    case 'prepare_outreach': {
      if (num(o.prepared) === null) return null;
      const by = obj(o.by_status);
      const review = num(by.READY_FOR_REVIEW) ?? 0;
      const blocked = num(by.BLOCKED) ?? 0;
      return `写好 ${o.prepared} 条私信草稿${review ? `，${review} 条等你看一眼` : ''}${blocked ? `，${blocked} 条发之前被拦下了` : ''}`;
    }
    case 'evolve_queries': {
      if (num(o.evaluated) === null) return null;
      const derived = arr(o.derived).length;
      const paused = arr(o.paused).length;
      return `评估 ${o.evaluated} 个搜索词${derived ? `，新增 ${derived} 个` : ''}${paused ? `，暂停 ${paused} 个效果差的` : ''}`;
    }
    case 'update_goal_progress': {
      const q = num(o.qualified_leads);
      if (q === null) return null;
      const target = num(o.target_leads);
      return `目标进度：能跟的客户 ${q}${target ? ` / ${target}` : ''}${num(o.appointments) ? `，预约 ${o.appointments}` : ''}`;
    }
    case 'check_dealer_facts': {
      if (num(o.vehicles) === null) return null;
      const warnings = arr(o.warnings).length;
      return `在售车型 ${o.vehicles} 款，现车 ${num(o.in_stock_quantity) ?? 0} 台，有效优惠 ${num(o.offers_active) ?? 0} 个${warnings ? `，${warnings} 条需要注意` : ''}`;
    }
    case 'account_health': {
      const accounts = arr(o.accounts);
      if (!accounts.length) return null;
      const healthy = accounts.filter((a) => obj(a).state === 'HEALTHY').length;
      return `${accounts.length} 个号，${healthy} 个状态正常`;
    }
    case 'capability_snapshot': {
      const by = obj(o.by_status);
      if (!Object.keys(by).length) return null;
      return `${num(by.AVAILABLE) ?? 0} 项能做，${arr(o.not_available).length} 项现在做不了`;
    }
    case 'publish_due':
      return num(o.published) === null ? null : `发布 ${o.published} 篇${num(o.ready_to_publish) ? `，${o.ready_to_publish} 篇等人工发布` : ''}`;
    default:
      return null;
  }
}

/** What a RUNNING step is doing right now, from its live `output.progress` (null when it reports none). */
export function progressText(key: string, output: Obj): string | null {
  const p = obj(obj(output).progress);
  if (key !== 'discover' || num(p.queries_total) === null) return null;
  const total = num(p.notes_total) ?? 0;
  const doing =
    p.phase === 'search'
      ? '正在搜索'
      : p.phase === 'screen'
        ? `已读完 ${total} 篇笔记，正在挑出真要买车的人`
        : total > 0
          ? `正在读第 ${Math.min((num(p.notes_done) ?? 0) + 1, total)}/${total} 篇笔记和评论`
          : '没有需要读的新笔记';
  const done = obj(p.done);
  const before = (num(done.posts) ?? 0) > 0 ? `；前面已读 ${done.posts} 篇笔记、${num(done.comments) ?? 0} 条评论，找到 ${num(done.qualified) ?? 0} 位像要买车的` : '';
  const text = typeof p.query_text === 'string' && p.query_text ? `「${p.query_text}」` : '';
  return `第 ${num(p.query_index) ?? 1}/${num(p.queries_total)} 个搜索词${text}：${doing}${before}`;
}

/**
 * Build the view. `defs` are the workflow's resolved step definitions (for the purpose text); a step recorded in the
 * run but no longer defined still shows, with its key as title.
 */
export function buildRunView(
  run: Pick<WorkflowRun, 'status' | 'error' | 'trigger'>,
  steps: WorkflowStep[],
  defs: { key: string; description: string }[],
  resumable: boolean,
): RunView {
  const purposeOf = new Map(defs.map((d) => [d.key, d.description]));
  const views: StepView[] = steps.map((s) => {
    const output = obj(s.output);
    const reason = typeof output.reason === 'string' ? output.reason : null;
    // A step that found nothing to do did its job: it reads as done, with the reason as its one-line result.
    const idle = s.status === 'SKIPPED' && output.idle === true;
    const state: StepState = idle ? 'done' : STATE_OF[s.status];
    return {
      key: s.step_key,
      // An unmapped step key is an internal name; the purpose line stands in for it, never the key itself.
      title: STEP_TITLE[s.step_key] ?? purposeOf.get(s.step_key)?.split(/[：:（(]/)[0] ?? '一个步骤',
      purpose: purposeOf.get(s.step_key) ?? null,
      state,
      summary: idle ? reason : state === 'done' ? summarizeStep(s.step_key, output) : state === 'running' ? progressText(s.step_key, output) : null,
      problem: state === 'failed' ? explainProblem(s.error ?? run.error) : state === 'skipped' ? explainProblem(reason) ?? '这一步被跳过了。' : null,
    };
  });
  const total = views.length;
  const done = views.filter((v) => v.state === 'done').length;
  const skippedCount = views.filter((v) => v.state === 'skipped').length;
  const processed = done + skippedCount;
  const current = views.find((v) => v.state === 'running');
  const failed = views.find((v) => v.state === 'failed');
  const status: WorkflowStatus = run.status;
  let headline: string;
  let tone: RunView['tone'];
  let advice: string | null = null;
  if (status === 'RUNNING' || status === 'PENDING') {
    headline = current ? `Steer 正在${current.title}` : 'Steer 正在准备';
    tone = 'running';
  } else if (status === 'SUCCEEDED') {
    // A skipped step did not do its work (e.g. search timed out): never present that as "all done".
    const skipped = views.filter((v) => v.state === 'skipped');
    if (skipped.length) {
      headline = `已结束，但有 ${skipped.length} 步被跳过`;
      tone = 'warn';
      // Steps skipped for the same reason share one sentence; different reasons are each said once.
      const byProblem = new Map<string, string[]>();
      for (const v of skipped) byProblem.set(v.problem ?? '', [...(byProblem.get(v.problem ?? '') ?? []), v.title]);
      advice = `${[...byProblem].map(([problem, titles]) => `「${titles.join('」「')}」没有执行。${problem}`).join('')}原因解决后可以再运行一次。`;
    } else {
      headline = '全部完成';
      tone = 'ok';
    }
  } else if (status === 'PARTIAL') {
    headline = '大部分完成，有步骤没有成功';
    tone = 'warn';
    advice = failed?.problem ?? null;
  } else if (status === 'CANCELLED') {
    headline = '任务已取消';
    tone = 'neutral';
  } else {
    headline = failed ? `在「${failed.title}」这一步停下了` : '任务没有完成';
    tone = 'bad';
    const cause = failed?.problem ?? explainProblem(run.error);
    advice = `${cause ?? ''}${resumable ? `点「从中断处继续」会从这一步接着做，前面已处理的 ${processed} 步不会重复。` : ''}`.trim() || null;
  }
  return {
    headline,
    tone,
    advice,
    steps: views,
    done,
    skipped: skippedCount,
    total,
    percent: total ? Math.round((processed / total) * 100) : 0,
    running: status === 'RUNNING' || status === 'PENDING',
    resumable,
    trigger: TRIGGER_LABEL[run.trigger] ?? '运行',
  };
}
