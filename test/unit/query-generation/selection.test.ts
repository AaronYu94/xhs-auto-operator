import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotFoundError, ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { GoalSpec, QueryStatus, SearchQuery, SearchRun } from '../../../src/core/types.ts';
import {
  evolveQueries,
  generateQueries,
  selectQueriesToRun,
} from '../../../src/skills/acquisition/automotive-query-generation/index.ts';
import { TEST_NOW, createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

let seq = 0;

function insertQuery(
  ctx: TestContext,
  dealerId: string,
  text: string,
  priority: number,
  opts: { goal_id?: string | null; status?: QueryStatus } = {},
): SearchQuery {
  const at = new Date(Date.parse(TEST_NOW) - 86_400_000 + ++seq * 1000).toISOString();
  return ctx.db.table('search_queries').insert({
    id: newId('q'),
    dealer_id: dealerId,
    goal_id: opts.goal_id ?? null,
    text,
    query_class: 'location',
    brand: 'BMW',
    model: null,
    location: '杭州',
    priority,
    status: opts.status ?? 'active',
    parent_query_id: null,
    generation_reason: '测试查询',
    created_at: at,
    updated_at: at,
  });
}

function run(ctx: TestContext, query: SearchQuery, status: SearchRun['status'] = 'SUCCEEDED'): void {
  ctx.db.table('search_runs').insert({
    id: newId('run'),
    query_id: query.id,
    dealer_id: query.dealer_id,
    workflow_run_id: null,
    provider: 'simulation',
    status,
    posts_discovered: 3,
    posts_new: 1,
    comments_scanned: 20,
    users_evaluated: 15,
    candidates: 2,
    qualified: 1,
    high_intent: 0,
    error: status === 'SUCCEEDED' ? null : 'provider error',
    started_at: ctx.clock.iso(),
    finished_at: ctx.clock.iso(),
  });
}

function setup() {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  const hz = dealerIdByKey(summary, 'hz-bmw');
  const sh = dealerIdByKey(summary, 'sh-bmw');
  const explored = (text: string, priority: number, goal: string | null = null) => {
    const q = insertQuery(ctx, hz, text, priority, { goal_id: goal });
    run(ctx, q);
    return q;
  };
  return { ctx, hz, sh, explored };
}

/** Six proven queries and two never-run ones. */
function pool() {
  const s = setup();
  s.explored('E1', 0.9);
  s.explored('E2', 0.85);
  s.explored('E3', 0.8);
  s.explored('E4', 0.7);
  s.explored('E5', 0.6, 'g1');
  s.explored('E6', 0.5);
  insertQuery(s.ctx, s.hz, 'U1', 0.3);
  insertQuery(s.ctx, s.hz, 'U2', 0.2, { goal_id: 'g1' });
  return s;
}

const texts = (rows: SearchQuery[]) => rows.map((r) => r.text);

describe('automotive-query-generation: selectQueriesToRun', () => {
  it('orders by priority when every active query has already run', () => {
    const { ctx, hz, explored } = setup();
    explored('B', 0.8);
    explored('A', 0.9);
    explored('D', 0.4);
    explored('C', 0.8); // tie with B → earlier created first
    assert.deepEqual(texts(selectQueriesToRun(ctx, hz, 3)), ['A', 'B', 'C']);
    assert.deepEqual(texts(selectQueriesToRun(ctx, hz, 10)), ['A', 'B', 'C', 'D']);
  });

  it('interleaves never-run queries: at least one in every block of four slots', () => {
    const { ctx, hz } = pool();
    assert.deepEqual(texts(selectQueriesToRun(ctx, hz, 8)), ['E1', 'E2', 'E3', 'U1', 'E4', 'E5', 'E6', 'U2']);
    assert.deepEqual(texts(selectQueriesToRun(ctx, hz, 4)), ['E1', 'E2', 'E3', 'U1']);
    assert.deepEqual(texts(selectQueriesToRun(ctx, hz, 5)), ['E1', 'E2', 'E3', 'U1', 'U2']);
    assert.deepEqual(texts(selectQueriesToRun(ctx, hz, 2)), ['E1', 'U1']);
    assert.deepEqual(texts(selectQueriesToRun(ctx, hz, 1)), ['U1']);
    assert.equal(selectQueriesToRun(ctx, hz, 50).length, 8);
  });

  it('keeps a high-priority never-run query at its natural rank', () => {
    const { ctx, hz } = pool();
    insertQuery(ctx, hz, 'U0', 0.95);
    assert.deepEqual(texts(selectQueriesToRun(ctx, hz, 4)), ['U0', 'E1', 'E2', 'E3']);
    assert.deepEqual(texts(selectQueriesToRun(ctx, hz, 8)), ['U0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'U1']);
  });

  it('uses pure priority order when no query has run yet', () => {
    const { ctx, hz } = setup();
    insertQuery(ctx, hz, 'N2', 0.5);
    insertQuery(ctx, hz, 'N1', 0.7);
    insertQuery(ctx, hz, 'N3', 0.1);
    assert.deepEqual(texts(selectQueriesToRun(ctx, hz, 3)), ['N1', 'N2', 'N3']);
  });

  it('treats queries with only FAILED / UNAVAILABLE runs as never run', () => {
    const { ctx, hz, explored } = setup();
    explored('E1', 0.9);
    explored('E2', 0.8);
    explored('E3', 0.7);
    explored('E4', 0.6);
    const failed = insertQuery(ctx, hz, 'F1', 0.1);
    run(ctx, failed, 'FAILED');
    run(ctx, failed, 'UNAVAILABLE');
    assert.deepEqual(texts(selectQueriesToRun(ctx, hz, 4)), ['E1', 'E2', 'E3', 'F1']);
  });

  it("puts the goal's queries first when a goal id is given", () => {
    const { ctx, hz } = pool();
    assert.deepEqual(texts(selectQueriesToRun(ctx, hz, 4, 'g1')), ['E5', 'U2', 'E1', 'E2']);
    assert.deepEqual(texts(selectQueriesToRun(ctx, hz, 4, 'unknown_goal')), ['E1', 'E2', 'E3', 'U1']);
    assert.deepEqual(texts(selectQueriesToRun(ctx, hz, 4, null)), ['E1', 'E2', 'E3', 'U1']);
  });

  it('excludes paused, retired and other dealers’ queries and validates the limit', () => {
    const { ctx, hz, sh, explored } = setup();
    explored('E1', 0.5);
    insertQuery(ctx, hz, 'P', 0.99, { status: 'paused' });
    insertQuery(ctx, hz, 'R', 0.98, { status: 'retired' });
    insertQuery(ctx, sh, 'SH', 0.97);
    assert.deepEqual(texts(selectQueriesToRun(ctx, hz, 10)), ['E1']);
    assert.deepEqual(selectQueriesToRun(ctx, hz, 0), []);
    assert.throws(() => selectQueriesToRun(ctx, hz, -1), ValidationError);
    assert.throws(() => selectQueriesToRun(ctx, hz, 1.5), ValidationError);
    assert.throws(() => selectQueriesToRun(ctx, 'dlr_missing', 3), NotFoundError);

    const empty = createTestContext();
    const emptyHz = dealerIdByKey(loadDealerFixture(empty), 'hz-bmw');
    assert.deepEqual(selectQueriesToRun(empty, emptyHz, 5), []);
  });

  it('after evolution, runs the best queries and explores derived ones, never paused or retired', () => {
    const ctx = createTestContext();
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const goal: GoalSpec = { type: 'lead_generation', brand: 'BMW', models: ['i3', 'X3'], location: '杭州' };
    const rows = generateQueries(ctx, { dealer_id: hz, goal, goal_id: 'goal_hz' });
    const q = (text: string) => rows.find((r) => r.text === text)!;
    const history: [string, number, number, number, number][] = [
      ['杭州i3有现车吗', 1, 100, 45, 31],
      ['杭州i3落地', 1, 100, 30, 17],
      ['i3值得买吗', 3, 10, 0, 0],
      ['i3 vs Model 3', 5, 30, 1, 0],
    ];
    for (const [text, n, users, candidates, qualified] of history) {
      for (let i = 0; i < n; i++) {
        ctx.db.table('search_runs').insert({
          id: newId('run'),
          query_id: q(text).id,
          dealer_id: hz,
          workflow_run_id: null,
          provider: 'simulation',
          status: 'SUCCEEDED',
          posts_discovered: 10,
          posts_new: 2,
          comments_scanned: 50,
          users_evaluated: users,
          candidates,
          qualified,
          high_intent: 0,
          error: null,
          started_at: ctx.clock.iso(),
          finished_at: ctx.clock.iso(),
        });
      }
    }
    ctx.clock.advance({ hours: 1 });
    const evolved = evolveQueries(ctx, hz);
    assert.ok(evolved.derived.some((d) => d.text === '杭州i3 35L有现车吗'));

    const selected = selectQueriesToRun(ctx, hz, 8, 'goal_hz');
    const selectedTexts = texts(selected);
    assert.equal(selected.length, 8);
    assert.equal(selectedTexts[0], '杭州i3有现车吗', 'the best proven query runs first (0.93, created earlier)');
    assert.equal(selectedTexts[1], '杭州i3 35L有现车吗', 'its derived variant inherits 0.93 and is explored next');
    assert.ok(!selectedTexts.includes('i3值得买吗') && !selectedTexts.includes('i3 vs Model 3'));
    assert.ok(selected.every((s) => s.status === 'active'));
  });
});
