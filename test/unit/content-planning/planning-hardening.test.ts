/**
 * Adversarial hardening regressions for content planning and account strategy: rolling daily planning (the operator's
 * `account_planning` workflow plans "tomorrow + 7 days" every day), posts outside a replaced period, unplanned posts
 * in the period, and research briefs without data.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newId } from '../../../src/core/ids.ts';
import { addDaysToKey } from '../../../src/core/time.ts';
import type { Post } from '../../../src/core/types.ts';
import { buildAccountStrategy } from '../../../src/skills/content/account-strategy/index.ts';
import { CANNIBALIZATION_WINDOW_DAYS, dayDiff, planContent } from '../../../src/skills/content/content-planning/index.ts';
import { clusterLabel } from '../../../src/skills/research/shared.ts';
import { createTestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

const START = '2026-09-14';
const CADENCE: Record<string, number> = {
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
  return { ctx, hz: dealerIdByKey(s, 'hz-bmw'), acc: (pid: string) => accountIdByPlatformId(s, pid) };
}

function assertNoCrossAccountClash(posts: readonly Post[]): void {
  for (const a of posts) {
    for (const b of posts) {
      if (a.id >= b.id || a.account_id === b.account_id || a.model !== b.model || a.pillar !== b.pillar) continue;
      assert.ok(Math.abs(dayDiff(a.slot_date, b.slot_date)) > CANNIBALIZATION_WINDOW_DAYS, `${a.topic}@${a.slot_date} vs ${b.topic}@${b.slot_date}`);
    }
  }
}

describe('content-planning hardening: rolling daily planning', () => {
  it('planning "tomorrow + 7 days" every day keeps every account at its cadence and never double-books a day', () => {
    const { ctx, hz, acc } = setup();
    const starts = [0, 1, 2, 3].map((d) => addDaysToKey(START, d));
    for (const periodStart of starts) {
      const { plans } = planContent(ctx, { dealer_id: hz, period_start: periodStart });
      assert.equal(plans.length, 6, `${periodStart}: every account has a plan for the period`);
    }
    const all = ctx.db.table('posts').findMany({ dealer_id: hz });
    for (const [pid, cadence] of Object.entries(CADENCE)) {
      const mine = all.filter((p) => p.account_id === acc(pid));
      assert.equal(new Set(mine.map((p) => p.slot_date)).size, mine.length, `${pid}: at most one post per day`);
      for (const periodStart of starts) {
        const end = addDaysToKey(periodStart, 6);
        const inPeriod = mine.filter((p) => p.slot_date >= periodStart && p.slot_date <= end).length;
        assert.equal(inPeriod, cadence, `${pid}: ${inPeriod} posts in ${periodStart}..${end}, cadence ${cadence}`);
      }
    }
    assertNoCrossAccountClash(all);
    for (const periodStart of starts) {
      const end = addDaysToKey(periodStart, 6);
      const topics = all.filter((p) => p.slot_date >= periodStart && p.slot_date <= end).map((p) => p.topic);
      assert.equal(new Set(topics).size, topics.length, `${periodStart}: unique topics`);
    }
    const total = all.length;
    assert.ok(total <= Object.values(CADENCE).reduce((s, n) => s + n, 0) + 4 * 6, `bounded growth, got ${total}`);
  });

  it('counts the account’s unplanned posts inside the period toward its cadence and keeps their day free', () => {
    const { ctx, hz, acc } = setup();
    const wang = acc('xhs-hz-sales-wang');
    const now = ctx.clock.iso();
    const manual = ctx.db.table('posts').insert({
      id: newId('post'),
      dealer_id: hz,
      account_id: wang,
      plan_id: null,
      slot_date: '2026-09-17',
      pillar: 'customer_story',
      topic: 'i3:customer_story:手工安排的提车故事',
      angle: '手工安排的提车故事',
      model: 'i3',
      title: '手工草稿',
      body: '正文',
      tags: [],
      cover_text: '',
      fact_refs: [],
      status: 'DRAFTED',
      review: null,
      approval_policy: 'REVIEW_REQUIRED',
      platform_note_id: null,
      scheduled_for: null,
      published_at: null,
      metrics: { views: 0, likes: 0, collects: 0, comments: 0, shares: 0 },
      metrics_updated_at: null,
      engine: 'human',
      created_at: now,
      updated_at: now,
    });
    const { posts } = planContent(ctx, { dealer_id: hz, period_start: START });
    const planned = posts.filter((p) => p.account_id === wang);
    assert.equal(planned.length, CADENCE['xhs-hz-sales-wang'] - 1, 'the manual draft uses one of the three slots');
    assert.ok(!planned.some((p) => p.slot_date === manual.slot_date), 'no second post on the manual draft’s day');
  });
});

describe('content-planning hardening: replace', () => {
  it('a progressed post outside a shorter replacement period does not consume one of its slots', () => {
    const { ctx, hz, acc } = setup();
    const wang = acc('xhs-hz-sales-wang');
    const first = planContent(ctx, { dealer_id: hz, period_start: START });
    const last = first.posts.filter((p) => p.account_id === wang).sort((a, b) => b.slot_date.localeCompare(a.slot_date))[0];
    assert.ok(last.slot_date > addDaysToKey(START, 2), `fixture assumption: last slot ${last.slot_date} is after day 3`);
    ctx.db.table('posts').update(last.id, { status: 'DRAFTED', title: '草稿', body: '正文' });

    const second = planContent(ctx, { dealer_id: hz, period_start: START, days: 3 }, { replace: true });
    const end = addDaysToKey(START, 2);
    const newInPeriod = second.posts.filter((p) => p.account_id === wang && p.status === 'PLANNED' && p.slot_date >= START && p.slot_date <= end);
    assert.equal(newInPeriod.length, 2, 'wang’s 3-day cadence is 2 posts');
    assert.ok(second.posts.some((p) => p.id === last.id), 'the progressed post is kept with its plan');
  });
});

describe('account-strategy hardening: research briefs without data', () => {
  it('a newer brief without public data neither masks an older informative brief nor becomes a strategy insight', () => {
    const { ctx, hz, acc } = setup();
    const wang = acc('xhs-hz-sales-wang');
    const base = buildAccountStrategy(ctx, wang);
    const insert = (createdAt: string, informative: boolean) =>
      ctx.db.table('research_briefs').insert({
        id: newId('rb'),
        dealer_id: hz,
        kind: 'xhs',
        scope: { models: ['i3', 'X3', '3 Series'], location: '杭州', window_days: 30 },
        findings: informative
          ? {
              headline: '买家最常问贷款方案',
              insights: [],
              top_questions: [
                { question: clusterLabel('finance'), count: 5, example_quote: 'i3贷款方案怎么样，首付多少' },
                { question: clusterLabel('discount'), count: 3, example_quote: '现在优惠多少' },
              ],
              topics: [],
            }
          : { headline: '暂无可分析的小红书公开数据：小红书搜索不可用（UNAVAILABLE）', insights: [], top_questions: [], topics: [] },
        source_counts: informative ? { posts: 8, comments: 30, provider_searches: 6 } : { posts: 0, comments: 0, provider_searches: 0 },
        engine: 'rules',
        workflow_run_id: null,
        created_at: createdAt,
      });
    insert('2026-09-09T02:00:00.000Z', true);
    insert('2026-09-12T01:30:00.000Z', false);
    const st = buildAccountStrategy(ctx, wang);
    const w = (pillar: string, s = st) => s.pillars.find((p) => p.pillar === pillar)?.weight ?? 0;
    assert.ok(w('finance_explainer') > w('finance_explainer', base), 'the older informative brief still drives finance_explainer');
    assert.deepEqual(st.research_insights, ['买家最常问贷款方案']);
  });
});
