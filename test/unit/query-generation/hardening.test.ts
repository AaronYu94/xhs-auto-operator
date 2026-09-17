/**
 * Adversarial regression tests for automotive-query-generation (hardening pass).
 * Each test reproduces a defect found by running the module against the dealer fixture.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { AgentDecision, GoalSpec, SearchQuery } from '../../../src/core/types.ts';
import type { Db } from '../../../src/db/database.ts';
import {
  evolveQueries,
  generateQueries,
  getQueryEffectiveness,
  planQueries,
} from '../../../src/skills/acquisition/automotive-query-generation/index.ts';
import { transitionLead } from '../../../src/skills/operations/crm/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, seedLead } from '../../helpers/fixtures.ts';

const GOAL: GoalSpec = { type: 'lead_generation', brand: 'BMW', models: ['i3', 'X3'], location: '杭州' };

function setup(now?: string) {
  const ctx = createTestContext(now ? { now } : {});
  const summary = loadDealerFixture(ctx);
  return { ctx, hz: dealerIdByKey(summary, 'hz-bmw'), sh: dealerIdByKey(summary, 'sh-bmw') };
}

function row(ctx: TestContext, dealerId: string, text: string): SearchQuery {
  const r = ctx.db.table('search_queries').findOne({ dealer_id: dealerId, text });
  assert.ok(r, `missing query 「${text}」`);
  return r;
}

const texts = (rows: { text: string }[]) => rows.map((r) => r.text);

function insertRuns(
  ctx: TestContext,
  query: SearchQuery,
  n: number,
  each: { users: number; candidates: number; qualified: number; started_at?: string },
): void {
  for (let i = 0; i < n; i++) {
    const at = each.started_at ?? ctx.clock.iso();
    ctx.db.table('search_runs').insert({
      id: newId('run'),
      query_id: query.id,
      dealer_id: query.dealer_id,
      workflow_run_id: null,
      provider: 'simulation',
      status: 'SUCCEEDED',
      posts_discovered: 10,
      posts_new: 3,
      comments_scanned: 60,
      users_evaluated: each.users,
      candidates: each.candidates,
      qualified: each.qualified,
      high_intent: 0,
      error: null,
      started_at: at,
      finished_at: at,
    });
  }
}

function insertQuery(ctx: TestContext, dealerId: string, text: string, patch: Partial<SearchQuery> = {}): SearchQuery {
  const now = ctx.clock.iso();
  return ctx.db.table('search_queries').insert({
    id: newId('q'),
    dealer_id: dealerId,
    goal_id: null,
    text,
    query_class: 'direct_model',
    brand: 'BMW',
    model: 'i3',
    location: null,
    priority: 0.6,
    status: 'active',
    parent_query_id: null,
    generation_reason: '运营人员手工录入',
    created_at: now,
    updated_at: now,
    ...patch,
  });
}

function decisionFor(ctx: TestContext, goalId: string): AgentDecision {
  const dec = ctx.db.table('agent_decisions').findOne({ decision_type: 'query_generation', subject_id: goalId });
  assert.ok(dec, `no query_generation decision for ${goalId}`);
  return dec;
}

describe('automotive-query-generation: hardening regressions', () => {
  it('reactivates a paused query and lifts a learned priority once per new goal — never again on later runs of that goal', () => {
    const { ctx, hz } = setup();
    generateQueries(ctx, { dealer_id: hz, goal: GOAL, goal_id: 'goal_g1' });
    insertRuns(ctx, row(ctx, hz, '杭州i3有现车吗'), 1, { users: 100, candidates: 45, qualified: 31 });
    insertRuns(ctx, row(ctx, hz, '宝马i3'), 1, { users: 100, candidates: 12, qualified: 2 });
    insertRuns(ctx, row(ctx, hz, 'i3值得买吗'), 3, { users: 10, candidates: 0, qualified: 0 });
    ctx.clock.advance({ hours: 10 });
    evolveQueries(ctx, hz);
    const learned = row(ctx, hz, '宝马i3').priority;
    assert.ok(learned < 0.7, `evolve lowers the low-density query (got ${learned})`);
    assert.equal(row(ctx, hz, 'i3值得买吗').status, 'paused');

    // a second, overlapping goal is planned for the first time: the paused query gets one more chance
    const g2: GoalSpec = { type: 'lead_generation', brand: 'BMW', models: ['i3'], location: '杭州' };
    ctx.clock.advance({ hours: 12 });
    generateQueries(ctx, { dealer_id: hz, goal: g2, goal_id: 'goal_g2' });
    assert.equal(row(ctx, hz, 'i3值得买吗').status, 'active', 'a new goal reactivates a paused query');
    assert.equal(row(ctx, hz, '宝马i3').priority, 0.7, 'a new goal lifts the prior once');

    // evening: the evidence still says pause / lower
    ctx.clock.advance({ hours: 10 });
    evolveQueries(ctx, hz);
    assert.equal(row(ctx, hz, 'i3值得买吗').status, 'paused');
    assert.equal(row(ctx, hz, '宝马i3').priority, learned);

    // next morning the daily plan for the same goals runs again: learned state must survive
    ctx.clock.advance({ hours: 14 });
    generateQueries(ctx, { dealer_id: hz, goal: g2, goal_id: 'goal_g2' });
    generateQueries(ctx, { dealer_id: hz, goal: GOAL, goal_id: 'goal_g1' });
    generateQueries(ctx, { dealer_id: hz, goal: GOAL });
    assert.equal(row(ctx, hz, 'i3值得买吗').status, 'paused', 'an already-planned goal never reactivates a query paused by evidence');
    assert.equal(row(ctx, hz, '宝马i3').priority, learned, 'an already-planned goal never undoes a learned priority');
    assert.equal(ctx.db.table('audit_events').count({ action: 'search_query.reactivated' }), 1);
  });

  it('reads date-only effectiveness bounds as dealer-local (Asia/Shanghai) days and rejects ambiguous timestamps', () => {
    const { ctx, hz } = setup();
    const query = generateQueries(ctx, { dealer_id: hz, goal: GOAL })[0];
    const runAt = (iso: string) => insertRuns(ctx, query, 1, { users: 10, candidates: 2, qualified: 1, started_at: iso });
    runAt('2026-09-11T15:30:00.000Z'); // 09-11 23:30 Shanghai
    runAt('2026-09-11T16:30:00.000Z'); // 09-12 00:30
    runAt('2026-09-12T01:30:00.000Z'); // 09-12 09:30 (daily lead_discovery)
    runAt('2026-09-12T15:30:00.000Z'); // 09-12 23:30
    runAt('2026-09-12T16:30:00.000Z'); // 09-13 00:30
    const eff = (opts: { from?: string; to?: string }) => {
      const e = getQueryEffectiveness(ctx, hz, opts).find((x) => x.query.id === query.id);
      assert.ok(e);
      return e;
    };
    assert.equal(eff({ from: '2026-09-12', to: '2026-09-12' }).runs, 3, 'one local day, both bounds inclusive');
    assert.equal(eff({ from: '2026-09-12' }).runs, 4);
    assert.equal(eff({ to: '2026-09-11' }).runs, 1);
    assert.equal(eff({ from: '2026-09-12T00:00:00+08:00', to: '2026-09-12T23:59:59.999+08:00' }).runs, 3);

    const lead = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-local-day-001' });
    ctx.db.table('leads').update(lead.id, { attributed_query_id: query.id });
    ctx.clock.set('2026-09-12T15:45:00.000Z'); // 23:45 Shanghai
    transitionLead(ctx, lead.id, 'APPOINTMENT', { reason: '到店预约', actor: 'operator:tester' });
    assert.equal(eff({ from: '2026-09-12', to: '2026-09-12' }).appointments, 1);
    assert.equal(eff({ from: '2026-09-13' }).appointments, 0);

    for (const bad of ['2026-09-12T10:00:00', 'Sep 12 2026', '2026-02-30', '2026-09-12 10:00', '2026-13-01']) {
      assert.throws(() => getQueryEffectiveness(ctx, hz, { from: bad }), ValidationError, bad);
    }
    assert.throws(() => getQueryEffectiveness(ctx, hz, { from: '2026-09-13', to: '2026-09-12' }), ValidationError);
  });

  it('derives only natural variants: no second trim, no suffix on questions, nothing from unspaced comparisons, case-insensitive model match', () => {
    const { ctx, hz } = setup();
    const parents = [
      insertQuery(ctx, hz, '杭州i3 40L落地', { query_class: 'location', location: '杭州' }),
      insertQuery(ctx, hz, 'i3续航多少'),
      insertQuery(ctx, hz, 'i3怎么样'),
      insertQuery(ctx, hz, 'i3vsModel 3', { query_class: 'competitor' }),
      insertQuery(ctx, hz, 'x3', { model: 'X3' }),
    ];
    for (const q of parents) insertRuns(ctx, q, 1, { users: 100, candidates: 40, qualified: 30 });
    ctx.clock.advance({ hours: 1 });

    const derived: string[] = [];
    for (let i = 0; i < 6; i++) derived.push(...texts(evolveQueries(ctx, hz).derived));
    assert.ok(derived.length > 0);
    for (const t of derived) {
      assert.ok(!(t.includes('35L') && t.includes('40L')), `two trims in one query: ${t}`);
      assert.ok(!/(多少|怎么样)(落地|有现车吗|优惠)$/u.test(t), `transaction suffix on a question: ${t}`);
      assert.ok(!/vs/iu.test(t), `variant of a comparison: ${t}`);
    }
    assert.ok(derived.includes('x3 25L'), `trim inserted after a lower-case model: ${derived.join(' / ')}`);
    assert.ok(derived.includes('杭州i3续航多少'), 'a question still gets the dealer city');
  });

  it('normalizes goal provinces and lets the lexicon province of a known city win', () => {
    const { ctx, hz } = setup();
    const plan = (goal: Partial<GoalSpec>) =>
      planQueries(ctx, { dealer_id: hz, goal: { type: 'lead_generation', models: ['i3'], ...goal } });

    const suffixed = plan({ location: '杭州', province: '浙江省' });
    assert.ok(texts(suffixed).includes('浙江宝马价格'));
    assert.ok(!texts(suffixed).includes('浙江省宝马价格'));
    assert.equal(suffixed.find((q) => q.text === '浙江宝马价格')?.location, '浙江');

    const conflicting = plan({ location: '杭州市', province: '上海' });
    assert.ok(texts(conflicting).includes('浙江宝马价格'));
    assert.ok(!texts(conflicting).some((t) => t.startsWith('上海')), 'a stated city fixes its province');

    const district = plan({ location: '西湖区', province: '浙江省' });
    assert.ok(texts(district).includes('西湖区宝马'));
    assert.ok(texts(district).includes('浙江宝马价格'));

    const provinceOnly = plan({ province: '浙江省' });
    assert.ok(texts(provinceOnly).includes('浙江宝马价格') && texts(provinceOnly).includes('杭州宝马'));
  });

  it('resolves goal models through lexicon aliases the catalog does not list (三系, 五系)', () => {
    const { ctx, hz, sh } = setup();
    assert.ok(texts(planQueries(ctx, { dealer_id: hz, goal: { type: 'lead_generation', models: ['三系'] } })).includes('宝马3系'));
    const shPlan = planQueries(ctx, { dealer_id: sh, goal: { type: 'lead_generation', brand: '宝马', models: ['五系', 'Model Y'] } });
    assert.ok(texts(shPlan).includes('宝马5系'));
    assert.ok(!texts(shPlan).some((t) => t.includes('Model Y')));
  });

  it('flags goal locations no group dealer serves (§5.2) and notes group routing for another store’s province (§5.3)', () => {
    const { ctx, hz } = setup();
    generateQueries(ctx, { dealer_id: hz, goal: { type: 'lead_generation', models: ['i3'], location: '深圳' }, goal_id: 'goal_sz' });
    generateQueries(ctx, { dealer_id: hz, goal: { type: 'lead_generation', models: ['i3'], location: '上海' }, goal_id: 'goal_sh' });
    generateQueries(ctx, { dealer_id: hz, goal: { type: 'lead_generation', models: ['i3'], location: '宁波' }, goal_id: 'goal_nb' });

    const sz = decisionFor(ctx, 'goal_sz');
    const out = sz.evidence.find((e) => e.code === 'out_of_area_location');
    assert.ok(out, 'Shenzhen is outside every group dealer province');
    assert.match(out.label, /广东/u);
    assert.ok(sz.confidence <= 0.7 + 1e-9, `lower confidence for an unserved area (got ${sz.confidence})`);

    const shanghai = decisionFor(ctx, 'goal_sh');
    assert.ok(!shanghai.evidence.some((e) => e.code === 'out_of_area_location'));
    const routed = shanghai.evidence.find((e) => e.code === 'group_dealer_location');
    assert.ok(routed, 'Shanghai buyers are routed to the group’s Shanghai store');
    assert.match(routed.label, /上海宝马中心/u);

    const ningbo = decisionFor(ctx, 'goal_nb');
    assert.ok(!ningbo.evidence.some((e) => e.code === 'out_of_area_location' || e.code === 'group_dealer_location'));
    assert.ok(Math.abs(ningbo.confidence - 0.9) < 1e-9, 'same-province city keeps full confidence');
  });

  it('evaluates and writes in one transaction, so a query committed just before the run is never duplicated', () => {
    const { ctx, hz } = setup();
    generateQueries(ctx, { dealer_id: hz, goal: GOAL, goal_id: 'goal_hz' });
    insertRuns(ctx, row(ctx, hz, '杭州i3有现车吗'), 1, { users: 100, candidates: 45, qualified: 31 });
    ctx.clock.advance({ hours: 1 });

    // simulate another process committing the would-be variant between evolve's reads and its writes
    const db: Db = ctx.db;
    const realTx = db.tx.bind(db);
    let injected = false;
    db.tx = ((fn: () => unknown) => {
      if (!injected) {
        injected = true;
        insertQuery(ctx, hz, '杭州i3 35L有现车吗', { query_class: 'location', location: '杭州', generation_reason: '另一进程刚写入' });
      }
      return realTx(fn);
    }) as Db['tx'];

    const result = evolveQueries(ctx, hz);
    assert.ok(!texts(result.derived).includes('杭州i3 35L有现车吗'));
    assert.equal(ctx.db.table('search_queries').count({ dealer_id: hz, text: '杭州i3 35L有现车吗' }), 1);
  });

  it('without goal models or sellable stock, plans offer-backed and entry-priced models first and records omitted ones', () => {
    const { ctx, hz } = setup();
    ctx.db.run('DELETE FROM inventory WHERE dealer_id = ?', hz);
    const rows = generateQueries(ctx, { dealer_id: hz, goal: { type: 'daily_operations', models: [] } });
    const models = new Set(rows.map((r) => r.model).filter((m): m is string => m !== null));
    for (const m of ['i3', 'X3', '3 Series']) assert.ok(models.has(m), `model with an active offer is planned: ${m}`);
    assert.equal(models.size, 6);
    assert.ok(!models.has('5 Series'), 'highest-priced model without offers is the one omitted');
    assert.ok(!rows.some((r) => r.text.endsWith('有现车吗')), 'no stock → no 有现车吗 query');

    const [dec] = ctx.db.table('agent_decisions').findMany({ decision_type: 'query_generation' });
    assert.deepEqual((dec.inputs.resolved as { omitted_models: string[] }).omitted_models, ['5 Series']);
    assert.ok(dec.evidence.some((e) => e.code === 'models_omitted' && e.label.includes('5系')));
  });

  it('grounds offer-gated queries on dealer-local offer validity (Asia/Shanghai day boundary)', () => {
    const last = setup('2026-09-30T15:59:59.000Z'); // 09-30 23:59:59 Shanghai
    const lastTexts = texts(planQueries(last.ctx, { dealer_id: last.hz, goal: GOAL }));
    for (const t of ['i3贷款方案', 'X3以租代购', '宝马置换补贴', '25万买什么车']) assert.ok(lastTexts.includes(t), t);

    const next = setup('2026-09-30T16:00:00.000Z'); // 10-01 00:00 Shanghai
    const nextTexts = texts(planQueries(next.ctx, { dealer_id: next.hz, goal: GOAL }));
    for (const t of ['i3贷款方案', 'X3以租代购', '宝马置换补贴', '25万买什么车']) assert.ok(!nextTexts.includes(t), t);
    assert.ok(nextTexts.includes('35万买什么车'));
  });
});
