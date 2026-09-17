import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotFoundError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import { clamp, round } from '../../../src/core/text.ts';
import type { GoalSpec, SearchQuery } from '../../../src/core/types.ts';
import {
  FEEDBACK,
  QUERY_CLASS_PRIORS,
  evolveQueries,
  generateQueries,
  queryKey,
  smoothedDensity,
  type PriorityChange,
} from '../../../src/skills/acquisition/automotive-query-generation/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

const GOAL: GoalSpec = { type: 'lead_generation', brand: 'BMW', models: ['i3', 'X3'], location: '杭州' };

function insertRuns(ctx: TestContext, query: SearchQuery, n: number, each: { users: number; candidates: number; qualified: number }): void {
  for (let i = 0; i < n; i++) {
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
      started_at: ctx.clock.iso(),
      finished_at: ctx.clock.iso(),
    });
  }
}

/** Fixture + generated goal queries + the run history used across the evolution tests. */
function seeded() {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  const hz = dealerIdByKey(summary, 'hz-bmw');
  const rows = generateQueries(ctx, { dealer_id: hz, goal: GOAL, goal_id: 'goal_hz' });
  const q = (text: string): SearchQuery => {
    const row = ctx.db.table('search_queries').findOne({ dealer_id: hz, text });
    assert.ok(row, `missing query ${text}`);
    return row;
  };
  insertRuns(ctx, q('杭州i3有现车吗'), 1, { users: 100, candidates: 45, qualified: 31 }); // 32/120
  insertRuns(ctx, q('杭州i3落地'), 1, { users: 100, candidates: 30, qualified: 17 }); // 18/120
  insertRuns(ctx, q('宝马X3'), 1, { users: 30, candidates: 9, qualified: 4 }); // 5/50 = 0.1
  insertRuns(ctx, q('宝马i3'), 1, { users: 100, candidates: 12, qualified: 2 }); // 3/120
  insertRuns(ctx, q('i3值得买吗'), 3, { users: 10, candidates: 0, qualified: 0 }); // 1/50, 0 candidates → pause
  insertRuns(ctx, q('i3 vs Model 3'), 5, { users: 30, candidates: 1, qualified: 0 }); // 1/170 → retire
  insertRuns(ctx, q('i3还是SU7'), 5, { users: 30, candidates: 0, qualified: 0 }); // retire wins over pause
  ctx.clock.advance({ hours: 10 });
  return { ctx, hz, rows, q };
}

const BEST = smoothedDensity(31, 100);
const expected = (prior: number, smoothed: number, best = BEST) =>
  round(clamp(FEEDBACK.prior_weight * prior + FEEDBACK.density_weight * (smoothed / best), FEEDBACK.min_priority, FEEDBACK.max_priority), 4);

describe('automotive-query-generation: evolveQueries (spec §19 feedback loop)', () => {
  it('re-prioritizes run queries by relative smoothed density and keeps priors for never-run queries', () => {
    const { ctx, hz, rows, q } = seeded();
    const result = evolveQueries(ctx, hz);

    assert.ok(Math.abs(result.best_smoothed_density - BEST) < 1e-12);
    assert.equal(q('杭州i3有现车吗').priority, expected(QUERY_CLASS_PRIORS.location, BEST));
    assert.equal(q('杭州i3有现车吗').priority, 0.93);
    assert.equal(q('杭州i3落地').priority, expected(QUERY_CLASS_PRIORS.location, smoothedDensity(17, 100)));
    assert.equal(q('宝马X3').priority, expected(QUERY_CLASS_PRIORS.direct_model, smoothedDensity(4, 30)));
    assert.equal(q('宝马i3').priority, expected(QUERY_CLASS_PRIORS.direct_model, smoothedDensity(2, 100)));
    assert.equal(q('i3值得买吗').priority, expected(QUERY_CLASS_PRIORS.direct_model, smoothedDensity(0, 30)));
    assert.equal(q('i3 vs Model 3').priority, expected(QUERY_CLASS_PRIORS.competitor, smoothedDensity(0, 150)));

    const order = ['杭州i3有现车吗', '杭州i3落地', '宝马X3', '宝马i3'].map((t) => q(t).priority);
    for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] > order[i], 'priority follows lead density');

    // never-run: exploration keeps the generated prior
    assert.equal(q('杭州宝马').priority, 0.8);
    assert.equal(q('杭州X3有现车吗').priority, 0.9);
    assert.equal(q('家用SUV推荐').priority, 0.5);

    assert.equal(result.reprioritized, 7);
    assert.equal(result.evaluated, rows.length, 'every generated query was active when evaluated');
    const explore = result.changes.find((c) => c.text === '杭州宝马');
    assert.deepEqual([explore?.basis, explore?.before, explore?.after, explore?.relative_density], ['exploration', 0.8, 0.8, null]);
  });

  it('pauses queries without candidates and retires persistently poor ones', () => {
    const { ctx, hz, q } = seeded();
    const result = evolveQueries(ctx, hz);
    assert.deepEqual(result.paused.map((x) => x.text), ['i3值得买吗']);
    assert.deepEqual(new Set(result.retired.map((x) => x.text)), new Set(['i3 vs Model 3', 'i3还是SU7']));
    assert.equal(q('i3值得买吗').status, 'paused');
    assert.equal(q('i3 vs Model 3').status, 'retired');
    assert.equal(q('i3还是SU7').status, 'retired');
    assert.equal(q('宝马i3').status, 'active', '3/120 is poor but above the retire threshold and has candidates');
    assert.equal(ctx.db.table('audit_events').count({ action: 'search_query.paused' }), 1);
    assert.equal(ctx.db.table('audit_events').count({ action: 'search_query.retired' }), 2);

    // a paused query that later accumulates poor evidence is retired too
    insertRuns(ctx, q('i3值得买吗'), 2, { users: 60, candidates: 0, qualified: 0 });
    const again = evolveQueries(ctx, hz);
    assert.deepEqual(again.retired.map((x) => x.text), ['i3值得买吗']);
    assert.equal(again.paused.length, 0);
    assert.equal(q('i3值得买吗').status, 'retired');
  });

  it('derives variants from the best queries: city, in-stock trim, transaction suffix, capped and never duplicated', () => {
    const { ctx, hz, q } = seeded();
    const result = evolveQueries(ctx, hz);
    assert.deepEqual(result.derived.map((d) => d.text), ['杭州i3 35L有现车吗', '杭州i3 35L落地', '杭州宝马X3', '宝马X3 25L', '宝马X3 30L']);
    assert.equal(result.derived.length, FEEDBACK.max_derived_per_call);

    const best = result.derived[0];
    assert.equal(best.query_class, 'derived');
    assert.equal(best.parent_query_id, q('杭州i3有现车吗').id);
    assert.equal(best.priority, q('杭州i3有现车吗').priority);
    assert.equal(best.goal_id, 'goal_hz');
    assert.equal(best.model, 'i3');
    assert.equal(best.location, '杭州');
    assert.equal(best.status, 'active');
    assert.match(best.generation_reason, /杭州i3有现车吗/u);
    assert.match(best.generation_reason, /平滑线索密度26\.7%/u);
    assert.match(best.generation_reason, /合格线索31个/u);
    assert.match(best.generation_reason, /35L/u);

    const city = result.derived.find((d) => d.text === '杭州宝马X3');
    assert.equal(city?.location, '杭州');
    assert.equal(city?.parent_query_id, q('宝马X3').id);
    assert.equal(ctx.db.table('audit_events').count({ action: 'search_query.derived' }), 5);

    // second pass: already-derived texts are skipped; remaining candidates of the X3 parent are used
    const second = evolveQueries(ctx, hz);
    assert.deepEqual(second.derived.map((d) => d.text), ['宝马X3有现车吗', '宝马X3优惠']);
    assert.equal(second.reprioritized, 0, 'no new evidence → no priority change');
    const third = evolveQueries(ctx, hz);
    assert.equal(third.derived.length, 0);

    const all = ctx.db.table('search_queries').findMany({ dealer_id: hz });
    const keys = all.map((r) => queryKey(r.text));
    assert.equal(new Set(keys).size, keys.length, 'no duplicate texts after repeated evolution');
    assert.ok(!all.some((r) => r.text === '宝马X3落地' && r.query_class === 'derived'), 'generated text is not re-created');
    assert.ok(!all.some((r) => r.query_class === 'derived' && r.text.includes('vs')), 'comparisons are not derived');
  });

  it('does not derive from paused, retired or low-density queries', () => {
    const { ctx, hz, q } = seeded();
    ctx.db.table('search_queries').update(q('宝马X3').id, { status: 'paused' });
    const result = evolveQueries(ctx, hz);
    assert.deepEqual(result.derived.map((d) => d.text), ['杭州i3 35L有现车吗', '杭州i3 35L落地']);
    assert.ok(result.derived.every((d) => d.parent_query_id !== q('宝马i3').id), '3/120 < 0.08');
    assert.equal(q('宝马X3').priority, 0.7, 'paused queries are not re-prioritized');
  });

  it('uses the root class prior for derived queries once they have evidence', () => {
    const { ctx, hz, q } = seeded();
    evolveQueries(ctx, hz);
    const derived = q('杭州i3 35L有现车吗');
    insertRuns(ctx, derived, 1, { users: 100, candidates: 50, qualified: 40 }); // new best: 41/120
    const result = evolveQueries(ctx, hz);
    const best = smoothedDensity(40, 100);
    assert.ok(Math.abs(result.best_smoothed_density - best) < 1e-12);
    assert.equal(q('杭州i3 35L有现车吗').priority, expected(QUERY_CLASS_PRIORS.location, best, best));
    assert.equal(q('杭州i3有现车吗').priority, expected(QUERY_CLASS_PRIORS.location, smoothedDensity(31, 100), best));
    assert.equal(q('宝马X3 25L').priority, expected(QUERY_CLASS_PRIORS.direct_model, smoothedDensity(4, 30)), 'never run: keeps inherited priority');
  });

  it('records a query_optimization decision with before/after priorities and an optimization event', () => {
    const { ctx, hz, q } = seeded();
    const before = q('杭州i3有现车吗').priority;
    const result = evolveQueries(ctx, hz);
    const dec = ctx.db.table('agent_decisions').findOne({ decision_type: 'query_optimization' });
    assert.ok(dec);
    assert.equal(dec.agent, 'lead-hunting-agent');
    assert.equal(dec.skill, 'automotive-query-generation');
    assert.equal(dec.subject_type, 'dealer');
    assert.equal(dec.subject_id, hz);
    assert.equal(dec.engine, 'rules');
    const changes = dec.output.changes as PriorityChange[];
    const best = changes.find((c) => c.text === '杭州i3有现车吗');
    assert.ok(best);
    assert.equal(best.before, before);
    assert.equal(best.after, 0.93);
    assert.equal(best.basis, 'density');
    assert.equal(best.relative_density, 1);
    assert.equal(dec.output.reprioritized, result.reprioritized);
    assert.equal((dec.output.derived as unknown[]).length, 5);
    assert.deepEqual((dec.output.paused as { text: string }[]).map((p) => p.text), ['i3值得买吗']);
    assert.equal((dec.output.retired as unknown[]).length, 2);
    assert.equal(dec.evidence[0].code, 'query_lead_density');
    assert.match(dec.evidence[0].label, /杭州i3有现车吗/u);
    assert.ok(dec.evidence.some((e) => e.code === 'query_retired'));
    assert.ok(dec.confidence > 0.3 && dec.confidence <= 0.9);
    const event = ctx.db.table('audit_events').findOne({ action: 'search_queries.optimized', entity_id: hz });
    assert.deepEqual(event?.details, { reprioritized: 7, derived: 5, paused: 1, retired: 2 });
  });

  it('is a recorded no-op for a dealer whose queries never ran', () => {
    const ctx = createTestContext();
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const rows = generateQueries(ctx, { dealer_id: hz, goal: GOAL });
    const result = evolveQueries(ctx, hz);
    assert.equal(result.reprioritized, 0);
    assert.equal(result.best_smoothed_density, 0);
    assert.deepEqual([result.derived, result.paused, result.retired], [[], [], []]);
    assert.equal(result.evaluated, rows.length);
    assert.ok(result.changes.every((c) => c.basis === 'exploration' && c.before === c.after));
    assert.equal(ctx.db.table('agent_decisions').count({ decision_type: 'query_optimization' }), 1);
    assert.equal(ctx.db.table('audit_events').count({ action: 'search_queries.optimized' }), 0);
    assert.throws(() => evolveQueries(ctx, 'dlr_missing'), NotFoundError);
  });
});
