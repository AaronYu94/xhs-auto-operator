import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withRun } from '../../../src/app/context.ts';
import { NotFoundError, ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { ContentPlan, Post } from '../../../src/core/types.ts';
import { effectivePublishPolicy } from '../../../src/skills/operations/account-brain/index.ts';
import {
  CANNIBALIZATION_WINDOW_DAYS,
  allocatePillars,
  anglesFor,
  dayDiff,
  pillarSequence,
  planContent,
  postsForPeriod,
  skill,
  spreadSlotDates,
  type ConflictResolution,
} from '../../../src/skills/content/content-planning/index.ts';
import { SkillRegistry } from '../../../src/skills/registry.ts';
import { TEST_NOW, createTestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture, seedPublishedPost } from '../../helpers/fixtures.ts';

const START = '2026-09-14';
const END = '2026-09-20';
const EXPECTED_POSTS: Record<string, number> = {
  'xhs-hz-official': 5,
  'xhs-hz-sales-wang': 3,
  'xhs-hz-sales-li': 2,
  'xhs-hz-i3': 4,
  'xhs-hz-guide': 4,
  'xhs-hz-story': 2,
};

function setup() {
  const ctx = createTestContext();
  const s = loadDealerFixture(ctx);
  return { ctx, hz: dealerIdByKey(s, 'hz-bmw'), sh: dealerIdByKey(s, 'sh-bmw'), acc: (pid: string) => accountIdByPlatformId(s, pid) };
}

/** No (model, pillar) on two accounts within 3 days. */
function assertNoModelPillarClash(posts: readonly Post[]): void {
  for (const a of posts) {
    for (const b of posts) {
      if (a.id >= b.id || a.account_id === b.account_id || a.model !== b.model || a.pillar !== b.pillar) continue;
      assert.ok(
        Math.abs(dayDiff(a.slot_date, b.slot_date)) > CANNIBALIZATION_WINDOW_DAYS,
        `${a.topic}@${a.slot_date} and ${b.topic}@${b.slot_date} cannibalize each other`,
      );
    }
  }
}

function assertUniqueTopics(posts: readonly Post[], from: string, to: string): void {
  const inPeriod = posts.filter((p) => p.slot_date >= from && p.slot_date <= to);
  assert.equal(new Set(inPeriod.map((p) => p.topic)).size, inPeriod.length, 'topic keys are unique within the period');
}

describe('content-planning: plan', () => {
  it('plans every active Hangzhou account with the persona cadence, de-cannibalized and audited', () => {
    const { ctx, hz, acc } = setup();
    const { plans, posts } = planContent(ctx, { dealer_id: hz, period_start: START });
    assert.equal(plans.length, 6);
    for (const [pid, n] of Object.entries(EXPECTED_POSTS)) {
      const account = acc(pid);
      const mine = posts.filter((p) => p.account_id === account);
      assert.equal(mine.length, n, `${pid} gets ${n} posts`);
      assert.ok(mine.length >= 2);
      assert.equal(new Set(mine.map((p) => p.slot_date)).size, mine.length, 'one post per day per account');
    }
    const planById = new Map(plans.map((p) => [p.id, p]));
    for (const plan of plans) {
      assert.equal(plan.status, 'active');
      assert.equal(plan.period_start, START);
      assert.equal(plan.period_end, END);
      assert.equal(plan.workflow_run_id, null);
      assert.ok(plan.strategy.pillars.length > 0);
      assert.deepEqual(ctx.db.table('content_plans').require(plan.id), plan);
    }
    for (const post of posts) {
      const plan = planById.get(post.plan_id!);
      assert.ok(plan && plan.account_id === post.account_id);
      assert.equal(post.status, 'PLANNED');
      assert.equal(post.title, '');
      assert.equal(post.body, '');
      assert.equal(post.engine, 'rules');
      assert.deepEqual(post.metrics, { views: 0, likes: 0, collects: 0, comments: 0, shares: 0 });
      assert.equal(post.approval_policy, effectivePublishPolicy(ctx, post.account_id).policy);
      assert.ok(post.slot_date >= START && post.slot_date <= END);
      assert.equal(post.topic, `${post.model ?? 'general'}:${post.pillar}:${post.angle}`);
      assert.ok(post.angle.length > 0);
      assert.ok(plan.strategy.pillars.some((p) => p.pillar === post.pillar), 'pillar comes from the strategy');
      if (post.model) assert.ok(plan.strategy.focus_models.includes(post.model), 'model comes from the focus models');
    }
    assertNoModelPillarClash(posts);
    assertUniqueTopics(posts, START, END);

    const decisions = ctx.db.table('agent_decisions').findMany({ decision_type: 'content_plan' });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].subject_id, hz);
    assert.equal(decisions[0].agent, 'account-strategy-agent');
    const output = decisions[0].output as { plans: { posts: number }[]; conflicts_resolved: ConflictResolution[]; excluded_accounts: unknown[] };
    assert.equal(output.plans.length, 6);
    assert.ok(Array.isArray(output.conflicts_resolved));
    assert.deepEqual(output.excluded_accounts, []);
    for (const c of output.conflicts_resolved) {
      assert.ok(['angle', 'pillar', 'model', 'date', 'dropped'].includes(c.resolution));
      assert.ok(c.original.topic !== c.resolved?.topic);
    }
    assert.equal(ctx.db.table('agent_decisions').count({ decision_type: 'content_strategy' }), 6);
    assert.equal(ctx.db.table('audit_events').count({ action: 'content_plan.created' }), 6);
  });

  it('is idempotent per account and period start', () => {
    const { ctx, hz } = setup();
    const first = planContent(ctx, { dealer_id: hz, period_start: START });
    const counts = () => [ctx.db.table('posts').count(), ctx.db.table('content_plans').count(), ctx.db.table('agent_decisions').count(), ctx.db.table('audit_events').count()];
    const before = counts();
    const second = planContent(ctx, { dealer_id: hz, period_start: START });
    assert.deepEqual(second.plans.map((p) => p.id).sort(), first.plans.map((p) => p.id).sort());
    assert.deepEqual(second.posts.map((p) => p.id).sort(), first.posts.map((p) => p.id).sort());
    assert.deepEqual(counts(), before, 'nothing is written on a repeated run');
  });

  it('replace deletes only still-PLANNED posts, keeps progressed ones and re-plans the rest', () => {
    const { ctx, hz, acc } = setup();
    const first = planContent(ctx, { dealer_id: hz, period_start: START });
    const wang = acc('xhs-hz-sales-wang');
    const wangPosts = first.posts.filter((p) => p.account_id === wang);
    const drafted = ctx.db.table('posts').update(wangPosts[0].id, { status: 'DRAFTED', title: '草稿标题', body: '草稿正文' });
    const wangPlan = first.plans.find((p) => p.account_id === wang)!;

    const second = planContent(ctx, { dealer_id: hz, period_start: START }, { replace: true });
    const secondWang = second.posts.filter((p) => p.account_id === wang);
    assert.equal(second.plans.find((p) => p.account_id === wang)!.id, wangPlan.id, 'the plan row is updated in place');
    assert.equal(secondWang.length, EXPECTED_POSTS['xhs-hz-sales-wang']);
    assert.deepEqual(secondWang.find((p) => p.id === drafted.id), ctx.db.table('posts').require(drafted.id), 'progressed post kept');
    assert.equal(new Set(secondWang.map((p) => p.slot_date)).size, secondWang.length, 'preserved post keeps its own date');
    for (const old of first.posts) {
      if (old.id === drafted.id) continue;
      assert.equal(ctx.db.table('posts').get(old.id), undefined, `old PLANNED post ${old.id} deleted`);
    }
    assert.equal(second.posts.length, first.posts.length);
    assertNoModelPillarClash(second.posts);
    assertUniqueTopics(second.posts, START, END);
    assert.equal(ctx.db.table('audit_events').count({ action: 'content_plan.replanned' }), 6);
    assert.equal(ctx.db.table('agent_decisions').count({ decision_type: 'content_plan' }), 2);
  });

  it('excludes disabled and inactive accounts and records why', () => {
    const { ctx, hz, acc } = setup();
    const li = acc('xhs-hz-sales-li');
    const story = acc('xhs-hz-story');
    ctx.db.table('xhs_accounts').update(li, { status: 'disabled' });
    ctx.db.table('xhs_accounts').update(story, { status: 'paused' });
    const { plans, posts } = planContent(ctx, { dealer_id: hz, period_start: START });
    assert.equal(plans.length, 4);
    assert.ok(!posts.some((p) => p.account_id === li || p.account_id === story));
    const output = ctx.db.table('agent_decisions').findOne({ decision_type: 'content_plan' })!.output as {
      excluded_accounts: { account_id: string; reason: string }[];
    };
    assert.deepEqual(output.excluded_accounts.map((e) => e.account_id).sort(), [li, story].sort());
    assert.ok(output.excluded_accounts.find((e) => e.account_id === li)!.reason.includes('disabled'));
  });

  it('avoids topics and (model, pillar) already used by existing posts, and records the resolution', () => {
    const { ctx, hz, acc } = setup();
    const guide = acc('xhs-hz-guide');
    const existing = seedPublishedPost(ctx, { dealer_id: hz, account_id: guide, published_at: '2026-09-15T02:00:00.000Z' });
    ctx.db.table('posts').update(existing.id, { topic: 'i3:model_review:深度技术拆解', angle: '深度技术拆解' });
    const { posts } = planContent(ctx, { dealer_id: hz, period_start: START });
    for (const p of posts) {
      assert.notEqual(p.topic, 'i3:model_review:深度技术拆解');
      if (p.account_id !== guide && p.model === 'i3' && p.pillar === 'model_review') {
        assert.ok(Math.abs(dayDiff(p.slot_date, '2026-09-15')) > CANNIBALIZATION_WINDOW_DAYS, `${p.topic}@${p.slot_date}`);
      }
    }
    assertNoModelPillarClash([...posts, ctx.db.table('posts').require(existing.id)]);
    const conflicts = (ctx.db.table('agent_decisions').findOne({ decision_type: 'content_plan' })!.output as { conflicts_resolved: ConflictResolution[] }).conflicts_resolved;
    assert.ok(conflicts.some((c) => c.conflict_with.post_id === existing.id), 'resolution against the existing post is recorded');
  });

  it('keeps de-cannibalization across an overlapping second period', () => {
    const { ctx, hz } = setup();
    planContent(ctx, { dealer_id: hz, period_start: START });
    const second = planContent(ctx, { dealer_id: hz, period_start: '2026-09-17' });
    assert.equal(second.plans.length, 6);
    const all = ctx.db.table('posts').findMany({ dealer_id: hz });
    assertNoModelPillarClash(all);
    const secondIds = new Set(second.posts.map((p) => p.id));
    for (const p of second.posts) {
      const clash = all.find((o) => !secondIds.has(o.id) && o.topic === p.topic && o.slot_date >= '2026-09-17' && o.slot_date <= '2026-09-23');
      assert.equal(clash, undefined, `topic ${p.topic} reused inside the second period`);
    }
  });

  it('applies a stored goal and stamps the workflow run', () => {
    const { ctx, hz, acc } = setup();
    const goal = ctx.db.table('operator_goals').insert({
      id: newId('goal'),
      dealer_id: hz,
      text: '本月杭州宝马i3获客',
      spec: { type: 'lead_generation', brand: 'BMW', models: ['i3'], location: '杭州' },
      status: 'active',
      plan: [],
      created_at: TEST_NOW,
      updated_at: TEST_NOW,
    });
    const runCtx = withRun(ctx, 'run_plan_1');
    const { plans } = planContent(runCtx, { dealer_id: hz, period_start: START, goal_id: goal.id });
    for (const plan of plans) {
      assert.equal(plan.strategy.goal_id, goal.id);
      assert.equal(plan.workflow_run_id, 'run_plan_1');
    }
    const story = plans.find((p: ContentPlan) => p.account_id === acc('xhs-hz-story'))!;
    assert.equal(story.strategy.focus_models[0], 'i3');
    assert.equal(ctx.db.table('agent_decisions').findOne({ decision_type: 'content_plan' })!.workflow_run_id, 'run_plan_1');
  });

  it('validates input', () => {
    const { ctx, hz, sh } = setup();
    assert.throws(() => planContent(ctx, { dealer_id: hz, period_start: '2026-02-30' }), ValidationError);
    assert.throws(() => planContent(ctx, { dealer_id: hz, period_start: '2026/09/14' }), ValidationError);
    assert.throws(() => planContent(ctx, { dealer_id: hz, period_start: START, days: 0 }), ValidationError);
    assert.throws(() => planContent(ctx, { dealer_id: hz, period_start: START, days: 32 }), ValidationError);
    assert.throws(() => planContent(ctx, { dealer_id: 'dlr_missing', period_start: START }), NotFoundError);
    const shGoal = ctx.db.table('operator_goals').insert({
      id: newId('goal'),
      dealer_id: sh,
      text: '上海X3',
      spec: { type: 'lead_generation', models: ['X3'] },
      status: 'active',
      plan: [],
      created_at: TEST_NOW,
      updated_at: TEST_NOW,
    });
    assert.throws(() => planContent(ctx, { dealer_id: hz, period_start: START, goal_id: shGoal.id }), ValidationError);
    assert.equal(ctx.db.table('content_plans').count(), 0, 'failed runs write nothing');
  });
});

describe('content-planning: pure helpers', () => {
  it('computes the per-account cadence', () => {
    assert.equal(postsForPeriod(12, 7), 3);
    assert.equal(postsForPeriod(undefined, 7), 3);
    assert.equal(postsForPeriod(0, 7), 2);
    assert.equal(postsForPeriod(20, 7), 5);
    assert.equal(postsForPeriod(100, 3), 3);
    assert.equal(postsForPeriod(12, 1), 1);
  });

  it('spreads slots evenly inside the period', () => {
    assert.deepEqual(spreadSlotDates(START, 7, 2), ['2026-09-15', '2026-09-19']);
    assert.deepEqual(spreadSlotDates(START, 7, 7), ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20']);
    assert.deepEqual(spreadSlotDates('2026-09-29', 3, 3), ['2026-09-29', '2026-09-30', '2026-10-01']);
  });

  it('allocates pillars by largest remainder and interleaves them', () => {
    const counts = allocatePillars(
      [
        { pillar: 'comparison', weight: 0.4 },
        { pillar: 'price_offer', weight: 0.3 },
        { pillar: 'model_review', weight: 0.3 },
      ],
      5,
    );
    assert.deepEqual(Object.fromEntries(counts), { comparison: 2, model_review: 2, price_offer: 1 });
    const seq = pillarSequence(counts, new Map([['comparison', 0.4], ['price_offer', 0.3], ['model_review', 0.3]]));
    assert.equal(seq.length, 5);
    for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1]);
    assert.deepEqual(Object.fromEntries(allocatePillars([{ pillar: 'customer_story', weight: 1 }], 2)), { customer_story: 2 });
    assert.equal(allocatePillars([], 3).size, 0);
  });

  it('builds persona- and powertrain-specific angles', () => {
    const specialist = { account_type: 'model_specialist' as const, city: '杭州', brand_zh: '宝马', taboo_topics: [] };
    assert.ok(anglesFor(specialist, 'model_review', 'i3').includes('续航实测'));
    assert.ok(anglesFor(specialist, 'model_review', 'X3').includes('油耗实测'));
    const guide = { account_type: 'local_guide' as const, city: '杭州', brand_zh: '宝马', taboo_topics: [] };
    assert.ok(anglesFor(guide, 'buying_guide', 'i3').includes('杭州买车避坑'));
    assert.ok(anglesFor({ ...guide, account_type: 'salesperson' }, 'price_offer', null).includes('销售视角真实报价拆解'));
    assert.ok(anglesFor({ ...guide, account_type: 'official' }, 'price_offer', null).includes('官方权益解读'));
    assert.ok(anglesFor({ ...guide, account_type: 'customer_story' }, 'customer_story', null).includes('车主提车故事'));
    const filtered = anglesFor({ ...guide, taboo_topics: ['上牌流程'] }, 'buying_guide', 'i3');
    assert.ok(!filtered.some((a) => a.includes('上牌流程')));
  });
});

describe('content-planning: skill', () => {
  it('runs through the registry, including replace', async () => {
    const { ctx, hz } = setup();
    const registry = new SkillRegistry().register(skill);
    const out = await registry.invoke<{ plans: ContentPlan[]; posts: Post[] }>(ctx, 'content-planning', { dealer_id: hz, period_start: START, days: 3 });
    assert.equal(out.plans.length, 6);
    assert.equal(out.posts.length, 12, 'two posts per account in a 3-day period');
    assertNoModelPillarClash(out.posts);
    assertUniqueTopics(out.posts, START, '2026-09-16');
    const replaced = await registry.invoke<{ plans: ContentPlan[]; posts: Post[] }>(ctx, 'content-planning', { dealer_id: hz, period_start: START, days: 3, replace: true });
    assert.equal(replaced.posts.length, 12);
    await assert.rejects(registry.invoke(ctx, 'content-planning', { dealer_id: hz, period_start: 'tomorrow' }), ValidationError);
    await assert.rejects(registry.invoke(ctx, 'content-planning', { dealer_id: hz, period_start: START, replace: 'yes' }), ValidationError);
  });
});
