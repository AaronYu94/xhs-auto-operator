import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../../../src/core/errors.ts';
import type { Dealer } from '../../../src/core/types.ts';
import { goalTargets, parseGoal, resolveGoalTimeframe } from '../../../src/operator/goal-parser.ts';
import { TEST_NOW } from '../../helpers/context.ts';

// TEST_NOW = Saturday 2026-09-12 10:00 Asia/Shanghai
const NOW = new Date(TEST_NOW);

const dealer: Dealer = {
  id: 'dlr_test',
  group_id: 'grp_test',
  name: '杭州宝马中心',
  brands: ['BMW'],
  city: '杭州',
  province: '浙江',
  address: '',
  business_hours: '',
  phone: null,
  settings: {
    outreach_approval_policy: 'REVIEW_REQUIRED',
    publish_approval_policy: 'REVIEW_REQUIRED',
    daily_outreach_limit: 20,
    min_outreach_interval_minutes: 3,
    max_unanswered_touches: 2,
    follow_up_after_days: 2,
    daily_publish_limit: 2,
    max_ai_conversation_turns: 6,
    auto_send_min_score: 90,
    timezone: 'Asia/Shanghai',
  },
  created_at: TEST_NOW,
  updated_at: TEST_NOW,
};

const catalog = {
  models: [
    { brand: 'BMW', model: 'i3', aliases: ['35L'] },
    { brand: 'BMW', model: 'X3', aliases: ['25L'] },
    { brand: 'BMW', model: '3 Series', aliases: ['3系'] },
  ],
};

describe('parseGoal', () => {
  it('Chinese lead goal: brand, model, city, this month (clamped to now), target', () => {
    const spec = parseGoal('这个月在杭州获取宝马i3线索，目标30条', dealer, NOW, catalog);
    assert.equal(spec.type, 'lead_generation');
    assert.equal(spec.brand, 'BMW');
    assert.deepEqual(spec.models, ['i3']);
    assert.equal(spec.location, '杭州');
    assert.equal(spec.province, '浙江');
    assert.equal(spec.target_leads, 30);
    assert.ok(spec.timeframe);
    assert.equal(spec.timeframe.start, NOW.toISOString());
    assert.equal(spec.timeframe.end, '2026-09-30T16:00:00.000Z'); // 2026-10-01 00:00 Shanghai
    assert.match(spec.timeframe.label, /本月/);
    assert.ok(spec.notes?.some((n) => n.includes('目标车型：i3')));
  });

  it('English goal from the spec', () => {
    const spec = parseGoal('Generate BMW i3 leads in Hangzhou this month.', dealer, NOW, catalog);
    assert.equal(spec.type, 'lead_generation');
    assert.equal(spec.brand, 'BMW');
    assert.deepEqual(spec.models, ['i3']);
    assert.equal(spec.location, '杭州');
    assert.equal(spec.timeframe?.end, '2026-09-30T16:00:00.000Z');
  });

  it('content campaign: next week, per-account post count', () => {
    const spec = parseGoal('下周重点推X3，每个账号发3篇', dealer, NOW, catalog);
    assert.equal(spec.type, 'content_campaign');
    assert.deepEqual(spec.models, ['X3']);
    assert.equal(spec.timeframe?.start, '2026-09-13T16:00:00.000Z'); // Monday 2026-09-14 00:00 Shanghai
    assert.equal(spec.timeframe?.end, '2026-09-20T16:00:00.000Z');
    assert.deepEqual(goalTargets(spec), { posts_per_account: 3, appointments: null });
  });

  it('English target count, other city, next month', () => {
    const spec = parseGoal('Get 20 qualified leads for X3 in Shanghai next month', dealer, NOW, catalog);
    assert.equal(spec.target_leads, 20);
    assert.deepEqual(spec.models, ['X3']);
    assert.equal(spec.location, '上海');
    assert.equal(spec.timeframe?.start, '2026-09-30T16:00:00.000Z');
    assert.equal(spec.timeframe?.end, '2026-10-31T16:00:00.000Z');
    assert.ok(spec.notes?.some((n) => n.includes('不在门店所在省份')));
  });

  it('models the dealer does not carry are dropped with an explanation, competitor brand ignored', () => {
    const spec = parseGoal('这个月获取特斯拉Model 3线索', dealer, NOW, catalog);
    assert.deepEqual(spec.models, []);
    assert.equal(spec.brand, undefined);
    assert.ok(spec.notes?.some((n) => n.includes('不在本店车型库')));
  });

  it('never invents unstated fields', () => {
    const spec = parseGoal('多找一些线索', dealer, NOW, catalog);
    assert.equal(spec.type, 'lead_generation');
    assert.deepEqual(spec.models, []);
    assert.equal(spec.location, undefined);
    assert.equal(spec.timeframe, undefined);
    assert.equal(spec.target_leads, undefined);
  });

  it('reporting and daily operations goals', () => {
    assert.equal(parseGoal('生成本周经营报告', dealer, NOW).type, 'reporting');
    assert.equal(parseGoal('每天自动运营所有账号', dealer, NOW).type, 'daily_operations');
    // '本地' is a stated relative location: the dealer's own city (explained in notes), not an invented one
    const local = parseGoal('本地买X3的线索', dealer, NOW, catalog);
    assert.equal(local.location, '杭州');
    assert.ok(local.notes?.some((n) => n.includes('门店所在城市')));
    assert.equal(parseGoal('获取宝马i3线索', dealer, NOW, catalog).target_leads, undefined, 'the 3 of i3 is not a lead target');
  });

  it('rejects empty and over-long goals', () => {
    assert.throws(() => parseGoal('   ', dealer, NOW), ValidationError);
    assert.throws(() => parseGoal('线'.repeat(501), dealer, NOW), ValidationError);
  });
});

describe('resolveGoalTimeframe (Asia/Shanghai)', () => {
  it('this week is clamped to now and ends next Monday 00:00 local', () => {
    const tf = resolveGoalTimeframe('本周', NOW, 'Asia/Shanghai');
    assert.equal(tf?.start, NOW.toISOString());
    assert.equal(tf?.end, '2026-09-13T16:00:00.000Z');
  });
  it('today, tomorrow, N days, a named month', () => {
    assert.equal(resolveGoalTimeframe('今天', NOW)?.end, '2026-09-12T16:00:00.000Z');
    assert.equal(resolveGoalTimeframe('明天', NOW)?.start, '2026-09-12T16:00:00.000Z');
    const n = resolveGoalTimeframe('未来14天', NOW);
    assert.equal(Date.parse(n!.end) - Date.parse(n!.start), 14 * 86_400_000);
    const oct = resolveGoalTimeframe('10月杭州X3', NOW);
    assert.equal(oct?.start, '2026-09-30T16:00:00.000Z');
    assert.equal(oct?.end, '2026-10-31T16:00:00.000Z');
    assert.equal(resolveGoalTimeframe('买车', NOW), null);
  });
});
