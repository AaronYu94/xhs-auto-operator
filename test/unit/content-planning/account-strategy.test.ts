import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotFoundError, ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { ContentPillar, GoalSpec, ResearchBrief, ResearchKind } from '../../../src/core/types.ts';
import { updatePersona } from '../../../src/skills/operations/account-brain/index.ts';
import {
  GOAL_PILLARS,
  buildAccountStrategy,
  normalizePillarWeights,
  pillarAttribution,
  skill,
  type AccountStrategy,
} from '../../../src/skills/content/account-strategy/index.ts';
import { clusterLabel } from '../../../src/skills/research/shared.ts';
import { SkillRegistry } from '../../../src/skills/registry.ts';
import { TEST_NOW, createTestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture, seedLead, seedPublishedPost } from '../../helpers/fixtures.ts';

const HZ_ACCOUNTS = ['xhs-hz-official', 'xhs-hz-sales-wang', 'xhs-hz-sales-li', 'xhs-hz-i3', 'xhs-hz-guide', 'xhs-hz-story'];
const I3_GOAL: GoalSpec = { type: 'lead_generation', brand: 'BMW', models: ['i3'], location: '杭州' };

function setup() {
  const ctx = createTestContext();
  const s = loadDealerFixture(ctx);
  return { ctx, s, hz: dealerIdByKey(s, 'hz-bmw'), sh: dealerIdByKey(s, 'sh-bmw'), acc: (pid: string) => accountIdByPlatformId(s, pid) };
}

const weight = (st: AccountStrategy, pillar: ContentPillar) => st.pillars.find((p) => p.pillar === pillar)?.weight ?? 0;
const goalShare = (st: AccountStrategy) => GOAL_PILLARS.reduce((s, p) => s + weight(st, p), 0);
const signature = (st: AccountStrategy) => JSON.stringify(st.pillars.map((p) => [p.pillar, p.weight]).sort());

function assertWellFormed(st: AccountStrategy): void {
  assert.ok(st.pillars.length > 0);
  const sum = st.pillars.reduce((s, p) => s + p.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `weights sum to ${sum}`);
  for (let i = 0; i < st.pillars.length; i++) {
    const p = st.pillars[i];
    assert.ok(p.weight >= 0.05, `${p.pillar} ${p.weight}`);
    assert.ok(p.rationale.includes('最终权重'), p.rationale);
    if (i > 0) assert.ok(st.pillars[i - 1].weight >= p.weight, 'sorted by weight');
  }
  assert.equal(new Set(st.pillars.map((p) => p.pillar)).size, st.pillars.length);
}

function seedBrief(ctx: ReturnType<typeof createTestContext>, dealerId: string, kind: ResearchKind, findings: ResearchBrief['findings'], createdAt = TEST_NOW) {
  return ctx.db.table('research_briefs').insert({
    id: newId('rb'),
    dealer_id: dealerId,
    kind,
    scope: { models: ['i3', 'X3', '3 Series', '5 Series', 'X1', 'i4', 'iX3'], location: '杭州', window_days: 30 },
    findings,
    source_counts: { posts: 10, comments: 40, provider_searches: 6 },
    engine: 'rules',
    workflow_run_id: null,
    created_at: createdAt,
  });
}

describe('account-strategy: persona baseline', () => {
  it('gives the six Hangzhou accounts six distinct, normalized strategies with Chinese rationales', () => {
    const { ctx, acc } = setup();
    const strategies = HZ_ACCOUNTS.map((pid) => buildAccountStrategy(ctx, acc(pid)));
    for (const st of strategies) {
      assertWellFormed(st);
      assert.deepEqual(st.research_insights, []);
      assert.equal(st.goal_id, undefined);
      for (const p of st.pillars) assert.ok(p.rationale.includes('人设内容配比'), p.rationale);
    }
    assert.equal(new Set(strategies.map(signature)).size, 6, 'no two accounts share pillar sets and weights');
    const persona = ctx.db.table('account_personas').findOne({ account_id: acc('xhs-hz-sales-li') })!;
    assert.equal(strategies[2].positioning, persona.content_positioning);
    assert.deepEqual(strategies[1].focus_models, ['i3', '3 Series']);
    assert.deepEqual(strategies[2].focus_models, ['X3', 'X1']);
    assert.deepEqual(strategies[3].focus_models, ['i3', 'i4']);
    assert.deepEqual(strategies[5].focus_models, ['X3', 'i3', '5 Series']);
    assert.equal(strategies[0].focus_models.length, 7);
  });

  it('keeps only carried models in focus', () => {
    const { ctx, acc } = setup();
    const wang = acc('xhs-hz-sales-wang');
    updatePersona(ctx, wang, { focus_models: ['宝马i3', 'Model 3', 'X7'] }, 'operator:test');
    assert.deepEqual(buildAccountStrategy(ctx, wang).focus_models, ['i3']);
  });

  it('records an audited content_strategy decision', () => {
    const { ctx, acc } = setup();
    const i3 = acc('xhs-hz-i3');
    const st = buildAccountStrategy(ctx, i3, { goal: I3_GOAL });
    const decision = ctx.db.table('agent_decisions').findOne({ decision_type: 'content_strategy', subject_id: i3 }, { orderBy: 'created_at DESC' });
    assert.ok(decision);
    assert.equal(decision.agent, 'account-strategy-agent');
    assert.equal(decision.skill, 'account-strategy');
    assert.equal(decision.subject_type, 'account');
    assert.equal(decision.engine, 'rules');
    assert.deepEqual((decision.output as { strategy: AccountStrategy }).strategy, st);
    assert.deepEqual((decision.inputs as { goal: GoalSpec }).goal.models, ['i3']);
  });
});

describe('account-strategy: goal', () => {
  it('boosts model_review / price_offer / inventory_showcase most for i3 salespeople and specialists', () => {
    const { ctx, acc } = setup();
    const delta = (pid: string) => {
      const base = buildAccountStrategy(ctx, acc(pid));
      const withGoal = buildAccountStrategy(ctx, acc(pid), { goal: I3_GOAL });
      assertWellFormed(withGoal);
      return { base, withGoal, d: goalShare(withGoal) - goalShare(base) };
    };
    const wang = delta('xhs-hz-sales-wang');
    const specialist = delta('xhs-hz-i3');
    const official = delta('xhs-hz-official');
    const guide = delta('xhs-hz-guide');
    const li = delta('xhs-hz-sales-li');
    const story = delta('xhs-hz-story');
    assert.ok(wang.d > official.d && specialist.d > official.d, `salesperson ${wang.d} / specialist ${specialist.d} > official ${official.d}`);
    assert.ok(official.d > guide.d && guide.d > 0, `official ${official.d} > guide ${guide.d} > 0`);
    assert.deepEqual(li.withGoal.pillars, li.base.pillars, 'an X3/X1 account is not boosted by an i3 goal');
    assert.ok(weight(wang.withGoal, 'model_review') > 0, 'goal pillar added to the salesperson mix');
    assert.ok(wang.withGoal.pillars.find((p) => p.pillar === 'price_offer')!.rationale.includes('目标车型i3'));
    assert.deepEqual(story.withGoal.focus_models, ['i3', 'X3', '5 Series'], 'goal models first');
  });

  it('loads a stored goal by id and rejects goals of another dealer', () => {
    const { ctx, hz, sh, acc } = setup();
    const insertGoal = (dealerId: string, models: string[]) =>
      ctx.db.table('operator_goals').insert({
        id: newId('goal'),
        dealer_id: dealerId,
        text: '本月X3线索',
        spec: { type: 'lead_generation', models },
        status: 'active',
        plan: [],
        created_at: TEST_NOW,
        updated_at: TEST_NOW,
      });
    const goal = insertGoal(hz, ['X3']);
    const li = acc('xhs-hz-sales-li');
    const base = buildAccountStrategy(ctx, li);
    const st = buildAccountStrategy(ctx, li, { goal_id: goal.id });
    assert.equal(st.goal_id, goal.id);
    assert.ok(goalShare(st) > goalShare(base));
    const wang = acc('xhs-hz-sales-wang');
    assert.deepEqual(buildAccountStrategy(ctx, wang, { goal_id: goal.id }).pillars, buildAccountStrategy(ctx, wang).pillars);
    const other = insertGoal(sh, ['X3']);
    assert.throws(() => buildAccountStrategy(ctx, li, { goal_id: other.id }), ValidationError);
    assert.throws(() => buildAccountStrategy(ctx, li, { goal_id: 'goal_missing' }), NotFoundError);
  });
});

describe('account-strategy: research briefs', () => {
  it('raises finance_explainer for frequent finance questions and comparison for competitor discussion', () => {
    const { ctx, hz, acc } = setup();
    const wang = acc('xhs-hz-sales-wang');
    const li = acc('xhs-hz-sales-li');
    const baseWang = buildAccountStrategy(ctx, wang);
    const baseLi = buildAccountStrategy(ctx, li);
    seedBrief(ctx, hz, 'xhs', {
      headline: '买家最常问贷款方案',
      insights: [],
      top_questions: [
        { question: clusterLabel('finance'), count: 4, example_quote: 'i3贷款方案怎么样，首付多少' },
        { question: clusterLabel('trade_in'), count: 2, example_quote: '旧车置换宝马X3有补贴吗' },
        { question: clusterLabel('discount'), count: 4, example_quote: '现在优惠多少' },
      ],
      topics: [],
    });
    seedBrief(ctx, hz, 'competitor', {
      headline: 'i3 vs Model 3 同框最多',
      insights: [],
      competitors: [{ brand: 'Tesla', model: 'Model 3', mentions: 6, comparison_with: 'i3', example_quote: 'i3和Model 3怎么选？' }],
    });
    seedBrief(ctx, hz, 'market', { headline: '三十多天前的旧调研', insights: [] }, '2026-08-01T02:00:00.000Z');

    const stWang = buildAccountStrategy(ctx, wang);
    const stLi = buildAccountStrategy(ctx, li);
    assertWellFormed(stWang);
    assert.ok(weight(stWang, 'finance_explainer') > weight(baseWang, 'finance_explainer'), 'finance pillar added for the salesperson');
    assert.ok(stWang.pillars.find((p) => p.pillar === 'finance_explainer')!.rationale.includes('近期调研'));
    assert.ok(weight(stWang, 'comparison') > weight(baseWang, 'comparison'), 'i3 competitor discussion raises comparison');
    assert.ok(weight(stLi, 'finance_explainer') > weight(baseLi, 'finance_explainer'));
    assert.ok(!stLi.pillars.find((p) => p.pillar === 'comparison')!.rationale.includes('竞品同框'), 'i3 competitor talk does not drive an X3/X1 account');
    assert.deepEqual([...stWang.research_insights].sort(), ['i3 vs Model 3 同框最多', '买家最常问贷款方案'].sort(), 'latest fresh briefs only');
    assert.ok(!stWang.research_insights.includes('三十多天前的旧调研'));
  });
});

describe('account-strategy: content → lead attribution', () => {
  it('shifts weight toward pillars whose published posts produced qualified leads, even against far more likes', () => {
    const { ctx, hz, acc } = setup();
    const wang = acc('xhs-hz-sales-wang');
    const baseline = buildAccountStrategy(ctx, wang);
    const publishedAt = '2026-09-02T02:00:00.000Z';
    const post = (pillar: ContentPillar, likes: number, title: string) => {
      const p = seedPublishedPost(ctx, { dealer_id: hz, account_id: wang, published_at: publishedAt, likes });
      return ctx.db.table('posts').update(p.id, { pillar, topic: `i3:${pillar}:${title}`, title });
    };
    const stories = [post('customer_story', 5000, '客户提车故事一'), post('customer_story', 5000, '客户提车故事二'), post('customer_story', 5000, '客户提车故事三')];
    const priceA = post('price_offer', 10, 'i3这个月政策怎么用最划算');
    const priceB = post('price_offer', 12, 'i3优惠之外还要算的费用');
    const lead = (uid: string, stage: Parameters<typeof seedLead>[1]['stage'], postId: string) => {
      const l = seedLead(ctx, { dealer_id: hz, platform_user_id: uid, stage });
      return ctx.db.table('leads').update(l.id, { attributed_post_id: postId });
    };
    lead('u-attr-1', 'QUALIFIED', priceA.id);
    lead('u-attr-2', 'ASSIGNED', priceB.id);
    const lostQualified = lead('u-attr-3', 'LOST', priceA.id);
    ctx.db.table('lead_stage_transitions').insert({
      id: newId('trn'),
      lead_id: lostQualified.id,
      from_stage: 'CANDIDATE',
      to_stage: 'QUALIFIED',
      reason: 'test',
      actor: 'test',
      at: publishedAt,
    });
    lead('u-attr-4', 'LOST', stories[0].id);
    lead('u-attr-5', 'CANDIDATE', stories[1].id);

    const attribution = pillarAttribution(ctx, wang);
    assert.deepEqual(
      attribution.map((a) => [a.pillar, a.posts, a.qualified_leads]),
      [
        ['price_offer', 2, 3],
        ['customer_story', 3, 0],
      ],
      'LOST counts only after qualifying; CANDIDATE never counts',
    );
    assert.equal(attribution.find((a) => a.pillar === 'customer_story')!.engagement, 15000);

    const after = buildAccountStrategy(ctx, wang);
    assertWellFormed(after);
    assert.ok(weight(after, 'price_offer') > weight(baseline, 'price_offer'), 'lead-producing pillar gains');
    assert.ok(weight(after, 'customer_story') < weight(baseline, 'customer_story'), 'high-likes pillar without leads loses');
    assert.ok(weight(after, 'price_offer') > weight(after, 'customer_story'), 'leads outweigh likes');
    assert.ok(after.pillars.find((p) => p.pillar === 'price_offer')!.rationale.includes('3条合格线索'));
    assert.ok(after.pillars.find((p) => p.pillar === 'customer_story')!.rationale.includes('未带来合格线索'));
    const decision = ctx.db.table('agent_decisions').findOne({ decision_type: 'content_strategy', subject_id: wang }, { orderBy: 'created_at DESC' })!;
    const evidence = decision.evidence.filter((e) => e.code === 'post_attribution');
    assert.ok(evidence.length > 0);
    for (const e of evidence) assert.ok([priceA.title, priceB.title].includes(e.quote!));
  });
});

describe('account-strategy: helpers and skill', () => {
  it('normalizes, drops pillars below 5% and keeps the sum at exactly 1', () => {
    const { kept, dropped } = normalizePillarWeights(
      new Map<ContentPillar, number>([
        ['model_review', 0.5],
        ['price_offer', 0.47],
        ['comparison', 0.03],
      ]),
    );
    assert.deepEqual(dropped.map(([p]) => p), ['comparison']);
    assert.deepEqual(kept.map(([p]) => p), ['model_review', 'price_offer']);
    assert.ok(Math.abs(kept.reduce((s, [, w]) => s + w, 0) - 1) < 1e-9);
    assert.deepEqual(normalizePillarWeights(new Map()), { kept: [], dropped: [] });
  });

  it('runs through the registry with validated input', async () => {
    const { ctx, acc } = setup();
    const registry = new SkillRegistry().register(skill);
    const st = await registry.invoke<AccountStrategy>(ctx, 'account-strategy', { account_id: acc('xhs-hz-sales-wang'), goal: I3_GOAL });
    assertWellFormed(st);
    await assert.rejects(registry.invoke(ctx, 'account-strategy', { account_id: acc('xhs-hz-sales-wang'), goal: { type: 'nope', models: [] } }), ValidationError);
    await assert.rejects(registry.invoke(ctx, 'account-strategy', {}), ValidationError);
    await assert.rejects(registry.invoke(ctx, 'account-strategy', { account_id: 'acc_missing' }), NotFoundError);
  });
});
