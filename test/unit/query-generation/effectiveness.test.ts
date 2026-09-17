import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotFoundError, ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { GoalSpec, SearchQuery, SearchRun } from '../../../src/core/types.ts';
import {
  generateQueries,
  getQueryEffectiveness,
  smoothedDensity,
  type QueryEffectiveness,
} from '../../../src/skills/acquisition/automotive-query-generation/index.ts';
import { recordConversion, transitionLead } from '../../../src/skills/operations/crm/index.ts';
import { TEST_NOW, createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, seedLead } from '../../helpers/fixtures.ts';

const GOAL: GoalSpec = { type: 'lead_generation', brand: 'BMW', models: ['i3', 'X3'], location: '杭州' };
const ACTOR = { reason: '测试推进', actor: 'operator:tester' };

function setup() {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  const hz = dealerIdByKey(summary, 'hz-bmw');
  const sh = dealerIdByKey(summary, 'sh-bmw');
  const rows = generateQueries(ctx, { dealer_id: hz, goal: GOAL, goal_id: 'goal_hz' });
  const q = (text: string): SearchQuery => {
    const row = rows.find((r) => r.text === text);
    assert.ok(row, `missing query ${text}`);
    return row;
  };
  return { ctx, hz, sh, rows, q };
}

type RunInput = Partial<Omit<SearchRun, 'id' | 'query_id' | 'dealer_id'>>;

function insertRun(ctx: TestContext, query: SearchQuery, r: RunInput): SearchRun {
  const at = r.started_at ?? ctx.clock.iso();
  return ctx.db.table('search_runs').insert({
    id: newId('run'),
    query_id: query.id,
    dealer_id: query.dealer_id,
    workflow_run_id: null,
    provider: 'simulation',
    status: r.status ?? 'SUCCEEDED',
    posts_discovered: r.posts_discovered ?? 10,
    posts_new: r.posts_new ?? 4,
    comments_scanned: r.comments_scanned ?? 50,
    users_evaluated: r.users_evaluated ?? 0,
    candidates: r.candidates ?? 0,
    qualified: r.qualified ?? 0,
    high_intent: r.high_intent ?? 0,
    error: r.error ?? null,
    started_at: at,
    finished_at: r.finished_at === undefined ? at : r.finished_at,
  });
}

function find(list: QueryEffectiveness[], text: string): QueryEffectiveness {
  const e = list.find((x) => x.query.text === text);
  assert.ok(e, `no effectiveness row for ${text}`);
  return e;
}

const close = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} ≠ ${expected}`);

function attribute(ctx: TestContext, leadId: string, query: SearchQuery): void {
  ctx.db.table('leads').update(leadId, { attributed_query_id: query.id });
}

describe('automotive-query-generation: getQueryEffectiveness (spec §19)', () => {
  it('computes the spec lead densities (宝马i3 2% · 杭州i3落地 17% · 杭州i3有现车吗 31%) and sorts by smoothed density', () => {
    const { ctx, hz, rows, q } = setup();
    insertRun(ctx, q('宝马i3'), { users_evaluated: 60, candidates: 8, qualified: 1, high_intent: 0, posts_discovered: 12, comments_scanned: 70 });
    insertRun(ctx, q('宝马i3'), { users_evaluated: 40, candidates: 4, qualified: 1, high_intent: 1, posts_discovered: 8, comments_scanned: 30 });
    insertRun(ctx, q('杭州i3落地'), { users_evaluated: 100, candidates: 30, qualified: 17, high_intent: 6 });
    insertRun(ctx, q('杭州i3有现车吗'), { users_evaluated: 100, candidates: 45, qualified: 31, high_intent: 12 });

    const list = getQueryEffectiveness(ctx, hz);
    assert.equal(list.length, rows.length, 'every query of the dealer, never-run included');

    const brand = find(list, '宝马i3');
    assert.equal(brand.runs, 2);
    assert.equal(brand.posts_discovered, 20);
    assert.equal(brand.comments_scanned, 100);
    assert.equal(brand.users_evaluated, 100);
    assert.equal(brand.candidates, 12);
    assert.equal(brand.qualified, 2);
    assert.equal(brand.high_intent, 1);
    close(brand.lead_density, 0.02, 'lead_density 宝马i3');
    close(brand.candidate_rate, 0.12, 'candidate_rate 宝马i3');
    close(brand.smoothed_density, 3 / 120, 'smoothed 宝马i3');

    const landing = find(list, '杭州i3落地');
    close(landing.lead_density, 0.17, 'lead_density 杭州i3落地');
    close(landing.candidate_rate, 0.3, 'candidate_rate 杭州i3落地');
    close(landing.smoothed_density, 18 / 120, 'smoothed 杭州i3落地');

    const stock = find(list, '杭州i3有现车吗');
    close(stock.lead_density, 0.31, 'lead_density 杭州i3有现车吗');
    close(stock.smoothed_density, 32 / 120, 'smoothed 杭州i3有现车吗');
    assert.equal(stock.high_intent, 12);

    assert.equal(list[0].query.text, '杭州i3有现车吗');
    assert.equal(list[1].query.text, '杭州i3落地');
    const idx = (t: string) => list.findIndex((e) => e.query.text === t);
    assert.ok(idx('杭州i3有现车吗') < idx('杭州i3落地') && idx('杭州i3落地') < idx('宝马i3'));
    for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].smoothed_density >= list[i].smoothed_density, 'sorted desc');

    const never = find(list, '杭州宝马');
    assert.deepEqual(
      [never.runs, never.users_evaluated, never.qualified, never.lead_density, never.candidate_rate, never.appointments, never.won, never.conversion_rate, never.failed_runs, never.last_run_at],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, null],
    );
    close(never.smoothed_density, 0.05, 'never-run prior density');
    close(smoothedDensity(31, 100), 32 / 120, 'smoothedDensity helper');
  });

  it('counts only SUCCEEDED runs; failed and unavailable runs are reported separately; running runs are ignored', () => {
    const { ctx, hz, q } = setup();
    insertRun(ctx, q('杭州宝马'), { status: 'FAILED', error: 'timeout', started_at: '2026-09-11T01:00:00.000Z' });
    insertRun(ctx, q('杭州宝马'), { status: 'UNAVAILABLE', error: 'search_public_content UNAVAILABLE', started_at: '2026-09-11T03:00:00.000Z' });
    insertRun(ctx, q('杭州宝马'), { status: 'RUNNING', users_evaluated: 40, qualified: 5, finished_at: null, started_at: '2026-09-12T01:00:00.000Z' });
    insertRun(ctx, q('杭州买宝马'), { users_evaluated: 10, candidates: 1, qualified: 0, started_at: '2026-09-10T01:00:00.000Z' });
    insertRun(ctx, q('杭州买宝马'), { status: 'FAILED', started_at: '2026-09-11T05:00:00.000Z' });

    const list = getQueryEffectiveness(ctx, hz);
    const failedOnly = find(list, '杭州宝马');
    assert.equal(failedOnly.runs, 0);
    assert.equal(failedOnly.failed_runs, 2);
    assert.equal(failedOnly.users_evaluated, 0, 'RUNNING run is not aggregated');
    assert.equal(failedOnly.last_run_at, '2026-09-11T03:00:00.000Z');

    const mixed = find(list, '杭州买宝马');
    assert.equal(mixed.runs, 1);
    assert.equal(mixed.failed_runs, 1);
    assert.equal(mixed.last_run_at, '2026-09-11T05:00:00.000Z');
    close(mixed.candidate_rate, 0.1, 'candidate_rate');
    close(mixed.smoothed_density, 1 / 30, 'smoothed');
  });

  it('filters runs and attribution by an inclusive time window and validates bounds', () => {
    const { ctx, hz, q } = setup();
    insertRun(ctx, q('杭州i3'), { users_evaluated: 50, qualified: 5, candidates: 10, started_at: '2026-09-01T02:00:00.000Z' });
    insertRun(ctx, q('杭州i3'), { users_evaluated: 30, qualified: 9, candidates: 12, started_at: '2026-09-10T02:00:00.000Z' });
    const lead = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-window-001' });
    attribute(ctx, lead.id, q('杭州i3'));
    transitionLead(ctx, lead.id, 'APPOINTMENT', ACTOR);

    const all = find(getQueryEffectiveness(ctx, hz), '杭州i3');
    assert.equal(all.runs, 2);
    assert.equal(all.users_evaluated, 80);
    assert.equal(all.appointments, 1);

    const late = find(getQueryEffectiveness(ctx, hz, { from: '2026-09-05T00:00:00.000Z' }), '杭州i3');
    assert.equal(late.runs, 1);
    assert.equal(late.qualified, 9);
    assert.equal(late.appointments, 1);

    const early = find(getQueryEffectiveness(ctx, hz, { to: '2026-09-05T00:00:00.000Z' }), '杭州i3');
    assert.equal(early.runs, 1);
    assert.equal(early.qualified, 5);
    assert.equal(early.appointments, 0, 'the appointment happened after the window');

    const exact = find(getQueryEffectiveness(ctx, hz, { from: '2026-09-10T02:00:00.000Z', to: TEST_NOW }), '杭州i3');
    assert.equal(exact.runs, 1, 'bounds are inclusive');
    assert.equal(exact.appointments, 1);

    // later lead updates (e.g. a score refresh) never move an earlier appointment into a later window
    ctx.clock.advance({ days: 1 });
    ctx.db.table('leads').update(lead.id, { score: 88 });
    const afterwards = find(getQueryEffectiveness(ctx, hz, { from: new Date(ctx.clock.now().getTime() - 3_600_000).toISOString() }), '杭州i3');
    assert.equal(afterwards.runs, 0);
    assert.equal(afterwards.appointments, 0);

    assert.throws(() => getQueryEffectiveness(ctx, hz, { from: 'yesterday' }), ValidationError);
    assert.throws(() => getQueryEffectiveness(ctx, hz, { from: '2026-09-10T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' }), ValidationError);
    assert.throws(() => getQueryEffectiveness(ctx, 'dlr_missing'), NotFoundError);
  });

  it('isolates dealers and returns an empty list for a dealer without queries', () => {
    const { ctx, hz, sh, q } = setup();
    assert.deepEqual(getQueryEffectiveness(ctx, sh), []);
    const shRows = generateQueries(ctx, { dealer_id: sh, goal: { type: 'lead_generation', models: ['X3'] } });
    const shQuery = shRows.find((r) => r.text === '上海X3');
    assert.ok(shQuery);
    insertRun(ctx, shQuery, { users_evaluated: 90, qualified: 20, candidates: 30 });
    insertRun(ctx, q('宝马X3'), { users_evaluated: 10, qualified: 1, candidates: 2 });

    const hzList = getQueryEffectiveness(ctx, hz);
    assert.ok(hzList.every((e) => e.query.dealer_id === hz));
    assert.equal(find(hzList, '宝马X3').users_evaluated, 10);
    const shList = getQueryEffectiveness(ctx, sh);
    assert.equal(shList.length, shRows.length);
    assert.equal(shList[0].query.text, '上海X3');
    const shared = shList.find((e) => e.query.text === '宝马X3');
    assert.ok(shared, 'sh-bmw has its own 宝马X3 row');
    assert.notEqual(shared.query.id, q('宝马X3').id);
    assert.equal(shared.runs, 0);
  });

  it('attributes appointments and wins through lead stage transitions', () => {
    const { ctx, hz, sh, q } = setup();
    const stock = q('杭州i3有现车吗');
    const landing = q('杭州i3落地');
    insertRun(ctx, stock, { users_evaluated: 100, candidates: 45, qualified: 31, high_intent: 12 });
    insertRun(ctx, landing, { users_evaluated: 100, candidates: 30, qualified: 17 });

    // L1: appointment → won
    const l1 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-attr-001' });
    attribute(ctx, l1.id, stock);
    transitionLead(ctx, l1.id, 'APPOINTMENT', ACTOR);
    recordConversion(ctx, { lead_id: l1.id, outcome: 'won', amount: 263_900, actor: 'operator:tester' });
    // L2: appointment → lost (still an appointment)
    const l2 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-attr-002' });
    attribute(ctx, l2.id, stock);
    transitionLead(ctx, l2.id, 'APPOINTMENT', ACTOR);
    transitionLead(ctx, l2.id, 'LOST', { reason: '预算不够', actor: 'operator:tester' });
    // L3: jumped straight to VISITED (passed APPOINTMENT)
    const l3 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-attr-003' });
    attribute(ctx, l3.id, stock);
    transitionLead(ctx, l3.id, 'VISITED', ACTOR);
    // L4: contacted only
    const l4 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-attr-004' });
    attribute(ctx, l4.id, stock);
    transitionLead(ctx, l4.id, 'CONTACTED', ACTOR);
    // L5: imported already WON, no transition history
    const l5 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-attr-005', stage: 'WON' });
    attribute(ctx, l5.id, stock);
    // L6: other query, negotiating
    const l6 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-attr-006' });
    attribute(ctx, l6.id, landing);
    transitionLead(ctx, l6.id, 'NEGOTIATING', ACTOR);
    // L7: routed to the Shanghai store (group matching) but surfaced by the Hangzhou query
    const l7 = seedLead(ctx, { dealer_id: sh, platform_user_id: 'u-attr-007' });
    attribute(ctx, l7.id, stock);
    transitionLead(ctx, l7.id, 'APPOINTMENT', ACTOR);
    // unattributed lead never counts
    const l8 = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-attr-008' });
    transitionLead(ctx, l8.id, 'APPOINTMENT', ACTOR);

    const list = getQueryEffectiveness(ctx, hz);
    const s = find(list, '杭州i3有现车吗');
    assert.equal(s.appointments, 5, 'L1 L2 L3 L5 L7');
    assert.equal(s.won, 2, 'L1 L5');
    close(s.conversion_rate, 5 / 31, 'conversion_rate');

    const l = find(list, '杭州i3落地');
    assert.equal(l.appointments, 1);
    assert.equal(l.won, 0);
    close(l.conversion_rate, 1 / 17, 'conversion_rate landing');

    const other = find(list, '杭州宝马');
    assert.equal(other.appointments, 0);
    assert.equal(other.conversion_rate, 0);
  });
});
