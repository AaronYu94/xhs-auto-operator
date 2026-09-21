import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StepStatus, WorkflowStep } from '../../../src/core/types.ts';
import { buildRunView, explainProblem, progressText, summarizeStep } from '../../../src/server/pages/run-view.ts';

const step = (step_key: string, status: StepStatus, output: Record<string, unknown> = {}, error: string | null = null): WorkflowStep => ({
  id: `s_${step_key}`,
  run_id: 'wf_x',
  step_key,
  seq: 0,
  agent: 'lead-hunting-agent',
  skill: 'lead-discovery',
  status,
  attempts: status === 'PENDING' ? 0 : 1,
  output,
  error,
  started_at: null,
  finished_at: null,
});
const DEFS = [
  { key: 'ensure_queries', description: '为目标生成搜索词' },
  { key: 'discover', description: '按搜索词在小红书搜索公开笔记与评论' },
  { key: 'custom_step', description: '自定义步骤：做点什么' },
];

describe('run view: what an operator sees instead of the raw run record', () => {
  it('an interrupted run names the step, explains it in Chinese and offers to continue', () => {
    const v = buildRunView(
      { status: 'FAILED', error: 'interrupted: process restarted', trigger: 'goal' },
      [step('ensure_queries', 'SUCCEEDED', { generated: 7, active: 7 }), step('discover', 'FAILED', {}, 'interrupted: process restarted'), step('assign_leads', 'PENDING')],
      DEFS,
      true,
    );
    assert.equal(v.headline, '在「搜索公开笔记和评论」这一步停下了');
    assert.equal(v.tone, 'bad');
    assert.match(v.advice ?? '', /系统重启时这一步被打断了，重新运行即可。点「从中断处继续」会从这一步接着做，前面已处理的 1 步不会重复。/);
    assert.deepEqual(
      v.steps.map((s) => [s.title, s.state, s.summary ?? s.problem]),
      [
        ['准备搜索词', 'done', '生成 7 个搜索词'],
        ['搜索公开笔记和评论', 'failed', '系统重启时这一步被打断了，重新运行即可。'],
        ['分配给最合适的账号', 'waiting', null],
      ],
    );
    assert.equal(v.trigger, '经营目标触发');
    assert.deepEqual([v.done, v.skipped, v.total, v.percent], [1, 0, 3, 33]);
    for (const s of v.steps) assert.doesNotMatch(`${s.title}${s.summary ?? ''}${s.problem ?? ''}`, /lead-hunting|lead-discovery|interrupted/, 'no raw ids in the user view');
  });

  it('a "successful" run with skipped steps is never presented as all done', () => {
    const v = buildRunView(
      { status: 'SUCCEEDED', error: null, trigger: 'goal' },
      [step('ensure_queries', 'SUCCEEDED', { generated: 7, active: 7 }), step('discover', 'SKIPPED', { skipped: true, reason: 'search_feeds: context deadline exceeded' })],
      DEFS,
      false,
    );
    assert.equal(v.headline, '已结束，但有 1 步被跳过');
    assert.equal(v.tone, 'warn');
    assert.match(v.advice ?? '', /「搜索公开笔记和评论」没有执行。小红书那边响应太慢/);
    assert.deepEqual([v.done, v.skipped, v.percent], [1, 1, 100]);
  });

  it('running and fully successful runs', () => {
    const running = buildRunView({ status: 'RUNNING', error: null, trigger: 'schedule' }, [step('ensure_queries', 'SUCCEEDED'), step('discover', 'RUNNING')], DEFS, false);
    assert.equal(running.headline, 'Steer 正在搜索公开笔记和评论');
    assert.equal(running.running, true);
    assert.equal(running.trigger, '按排班自动运行');
    const ok = buildRunView({ status: 'SUCCEEDED', error: null, trigger: 'manual' }, [step('custom_step', 'SUCCEEDED', { anything: 1 })], DEFS, false);
    assert.equal(ok.headline, '全部完成');
    assert.equal(ok.steps[0]?.title, '自定义步骤', 'unknown steps fall back to the definition text, never the raw key');
    assert.equal(ok.steps[0]?.summary, null, 'unknown outputs are not summarised (nothing invented)');
  });

  it('summaries come only from real output fields', () => {
    assert.equal(
      summarizeStep('discover', { runs: [{ status: 'SUCCEEDED', posts_discovered: 2, comments_scanned: 14, users_evaluated: 10, qualified: 4 }, { status: 'FAILED' }] }),
      '搜了 2 次，读了 2 篇笔记、14 条评论，看了 10 个人，找到 4 位像要买车的（有 1 次没搜成）',
    );
    assert.equal(summarizeStep('prepare_outreach', { prepared: 11, by_status: { READY_FOR_REVIEW: 9, BLOCKED: 2 } }), '写好 11 条私信草稿，9 条等你看一眼，2 条发之前被拦下了');
    assert.equal(summarizeStep('assign_leads', {}), null);
    assert.equal(explainProblem('ECONNREFUSED 127.0.0.1:18060'), '这台机器上的账号服务没在运行，去「账号」页点「重新连接」。');
    assert.equal(explainProblem('本次没有发现或更新的线索需要研究'), '本次没有发现或更新的线索需要研究');
    assert.equal(explainProblem('TypeError: x is undefined'), '这一步没执行成功，已记录下来。');
  });

  it('a running discovery step says where it is, from its live progress', () => {
    const progress = (p: Record<string, unknown>) => ({ progress: { queries_total: 4, query_index: 2, query_text: '小鹏落地价', notes_total: 5, notes_done: 2, done: { posts: 5, comments: 272, qualified: 3 }, ...p } });
    assert.equal(progressText('discover', progress({ phase: 'read' })), '第 2/4 个搜索词「小鹏落地价」：正在读第 3/5 篇笔记和评论；前面已读 5 篇笔记、272 条评论，找到 3 位像要买车的');
    assert.equal(progressText('discover', progress({ phase: 'search', done: { posts: 0 } })), '第 2/4 个搜索词「小鹏落地价」：正在搜索');
    assert.match(progressText('discover', progress({ phase: 'screen' })) ?? '', /已读完 5 篇笔记，正在挑出真要买车的人/);
    assert.equal(progressText('discover', {}), null);
    const v = buildRunView({ status: 'RUNNING', error: null, trigger: 'goal' }, [step('ensure_queries', 'SUCCEEDED'), step('discover', 'RUNNING', progress({ phase: 'read' }))], DEFS, false);
    assert.match(v.steps[1].summary ?? '', /正在读第 3\/5 篇笔记/);
  });
});

describe('run view: blocked vs nothing to do', () => {
  const RESEARCH_LOGGED_OUT = 'REQUIRES_AUTH: Xiaohongshu session not logged in on research (log in via get_login_qrcode)';

  it('a step with nothing to do reads as done, and only blocked steps are called skipped', () => {
    const v = buildRunView(
      { status: 'SUCCEEDED', error: null, trigger: 'goal' },
      [
        step('ensure_queries', 'SUCCEEDED', { generated: 19, active: 24 }),
        step('discover', 'SKIPPED', { skipped: true, reason: `公开内容搜索被阻断：${RESEARCH_LOGGED_OUT}` }),
        step('research_leads', 'SKIPPED', { skipped: true, reason: `读取公开主页不可用（${RESEARCH_LOGGED_OUT}）` }),
        step('prepare_outreach', 'SKIPPED', { skipped: true, idle: true, reason: '没有待生成私信的已分配线索' }),
      ],
      DEFS,
      false,
    );
    assert.equal(v.headline, '已结束，但有 2 步被跳过');
    const idle = v.steps.find((s) => s.key === 'prepare_outreach')!;
    assert.equal(idle.state, 'done');
    assert.equal(idle.summary, '没有待生成私信的已分配线索');
    assert.doesNotMatch(v.advice ?? '', /写私信草稿/, 'the idle step is not listed next to the blocked ones');
    // both blocked steps share one cause, said once, and it names the session that logged out
    assert.equal((v.advice ?? '').match(/找客户用的号掉登录了/g)?.length, 1);
  });

  it('a logged-out search session is named, a logged-out account keeps the generic wording', () => {
    assert.match(explainProblem(RESEARCH_LOGGED_OUT) ?? '', /找客户用的号/);
    assert.match(explainProblem('REQUIRES_AUTH: Xiaohongshu session not logged in on account xhs-hz-official') ?? '', /^账号掉登录了/);
  });
});
