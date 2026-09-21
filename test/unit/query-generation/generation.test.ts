import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ManualClock } from '../../../src/core/clock.ts';
import { NotFoundError, ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { AgentDecision, GoalSpec, SearchQuery } from '../../../src/core/types.ts';
import { SimulationXhsProvider } from '../../../src/providers/xhs/simulation.ts';
import {
  GENERATED_QUERY_CLASSES,
  QUERY_CLASS_PRIORS,
  budgetBracketWan,
  generateQueries,
  planQueries,
  queryKey,
  skill,
  trimAlias,
} from '../../../src/skills/acquisition/automotive-query-generation/index.ts';
import { SkillRegistry } from '../../../src/skills/registry.ts';
import { TEST_NOW, createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, vehicleIdByKey } from '../../helpers/fixtures.ts';

const GOAL: GoalSpec = { type: 'lead_generation', brand: 'BMW', models: ['i3', 'X3'], location: '杭州' };

function setup(opts: Parameters<typeof createTestContext>[0] = {}) {
  const ctx = createTestContext(opts);
  const summary = loadDealerFixture(ctx);
  return { ctx, summary, hz: dealerIdByKey(summary, 'hz-bmw'), sh: dealerIdByKey(summary, 'sh-bmw') };
}

function get(rows: SearchQuery[], text: string): SearchQuery {
  const row = rows.find((r) => r.text === text);
  assert.ok(row, `missing query 「${text}」 in: ${rows.map((r) => r.text).join(' / ')}`);
  return row;
}

const texts = (rows: SearchQuery[]) => rows.map((r) => r.text);

function decisions(ctx: TestContext, type: 'query_generation' | 'query_optimization'): AgentDecision[] {
  return ctx.db.table('agent_decisions').findMany({ decision_type: type }, { orderBy: 'created_at ASC' });
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
    priority: 0.3,
    status: 'active',
    parent_query_id: null,
    generation_reason: '运营人员手工录入',
    created_at: now,
    updated_at: now,
    ...patch,
  });
}

function insertSucceededRun(ctx: TestContext, q: SearchQuery): void {
  ctx.db.table('search_runs').insert({
    id: newId('run'),
    query_id: q.id,
    dealer_id: q.dealer_id,
    workflow_run_id: null,
    provider: 'simulation',
    status: 'SUCCEEDED',
    posts_discovered: 5,
    posts_new: 5,
    comments_scanned: 40,
    users_evaluated: 30,
    candidates: 2,
    qualified: 1,
    high_intent: 0,
    error: null,
    started_at: ctx.clock.iso(),
    finished_at: ctx.clock.iso(),
  });
}

describe('automotive-query-generation: generateQueries (spec §5)', () => {
  it('covers every query class with the spec examples, grounded in the dealer fixture', () => {
    const { ctx, hz } = setup();
    const rows = generateQueries(ctx, { dealer_id: hz, goal: GOAL, goal_id: 'goal_hz_i3_x3' });

    assert.deepEqual(new Set(rows.map((r) => r.query_class)), new Set(GENERATED_QUERY_CLASSES));
    const expected: Record<string, SearchQuery['query_class']> = {
      宝马i3: 'direct_model',
      宝马i3价格: 'direct_model',
      宝马i3落地: 'direct_model',
      i3优惠: 'direct_model',
      i3值得买吗: 'direct_model',
      宝马X3: 'direct_model',
      'i3 35L': 'direct_model',
      'X3 25L': 'direct_model',
      'X3 30L': 'direct_model',
      'i3 vs Model 3': 'competitor',
      'i3还是Model 3': 'competitor',
      'X3 vs GLC': 'competitor',
      'X3 vs Q5L': 'competitor',
      X3还是Q5L: 'competitor',
      '25万买什么车': 'purchase_scenario',
      '30万SUV': 'purchase_scenario',
      家用SUV推荐: 'purchase_scenario',
      电车推荐: 'purchase_scenario',
      纯电轿车推荐: 'purchase_scenario',
      第一次买宝马: 'purchase_scenario',
      准备换车: 'purchase_scenario',
      i3落地价: 'transaction_intent',
      i3优惠多少: 'transaction_intent',
      i3有现车吗: 'transaction_intent',
      X3有现车吗: 'transaction_intent',
      i3贷款方案: 'transaction_intent',
      X3以租代购: 'transaction_intent',
      宝马置换补贴: 'transaction_intent',
      什么时候买便宜: 'transaction_intent',
      杭州宝马: 'location',
      杭州宝马优惠: 'location',
      杭州i3: 'location',
      杭州买宝马: 'location',
      浙江宝马价格: 'location',
      杭州i3落地: 'location',
      杭州i3有现车吗: 'location',
      杭州X3有现车吗: 'location',
    };
    for (const [text, cls] of Object.entries(expected)) assert.equal(get(rows, text).query_class, cls, text);

    // in-transit trim (i3 eDrive40L) is not a "现车" variant; models outside the goal are not planned
    assert.ok(!texts(rows).includes('i3 40L'));
    assert.ok(!rows.some((r) => r.model !== null && !['i3', 'X3'].includes(r.model)), 'only goal models');
    assert.ok(!texts(rows).some((t) => t.includes('3系') || t.includes('5系') || t.includes('i4')));

    for (const r of rows) {
      assert.equal(r.dealer_id, hz);
      assert.equal(r.goal_id, 'goal_hz_i3_x3');
      assert.equal(r.status, 'active');
      assert.equal(r.parent_query_id, null);
      assert.equal(r.brand, 'BMW');
      assert.match(r.generation_reason, /[一-鿿]/u, 'reason is Chinese');
    }
    assert.equal(get(rows, '杭州i3').location, '杭州');
    assert.equal(get(rows, '浙江宝马价格').location, '浙江');
    assert.equal(get(rows, '宝马i3').location, null);
    assert.equal(get(rows, '杭州宝马').model, null);
    assert.equal(ctx.db.table('search_queries').count({ dealer_id: hz }), rows.length);
  });

  it('never produces duplicate texts and re-running the same goal changes nothing', () => {
    const { ctx, hz } = setup();
    const first = generateQueries(ctx, { dealer_id: hz, goal: GOAL, goal_id: 'goal_a' });
    const keys = first.map((r) => queryKey(r.text));
    assert.equal(new Set(keys).size, keys.length);

    ctx.clock.advance({ minutes: 10 });
    const second = generateQueries(ctx, { dealer_id: hz, goal: GOAL, goal_id: 'goal_a' });
    assert.deepEqual(
      second.map((r) => [r.id, r.text, r.priority, r.status, r.updated_at]),
      first.map((r) => [r.id, r.text, r.priority, r.status, r.updated_at]),
    );
    assert.equal(ctx.db.table('search_queries').count({ dealer_id: hz }), first.length);
    assert.equal(ctx.db.table('audit_events').count({ action: 'search_queries.generated' }), 1, 'no-op run emits no state event');
    const decs = decisions(ctx, 'query_generation');
    assert.equal(decs.length, 2);
    assert.equal(decs[1].output.created, 0);
    assert.equal(decs[1].output.unchanged, first.length);
  });

  it('sets priority from the class prior plus the goal priority-model boost', () => {
    const { ctx, hz } = setup();
    const rows = generateQueries(ctx, { dealer_id: hz, goal: GOAL });
    const p = (text: string) => get(rows, text).priority;
    assert.equal(p('杭州宝马'), QUERY_CLASS_PRIORS.location);
    assert.equal(p('杭州i3'), 0.9);
    assert.equal(p('杭州X3有现车吗'), 0.9);
    assert.equal(p('i3落地价'), 0.85);
    assert.equal(p('宝马置换补贴'), 0.75);
    assert.equal(p('宝马i3'), 0.7);
    assert.equal(p('i3 vs Model 3'), 0.65);
    assert.equal(p('25万买什么车'), 0.5);
    assert.equal(p('第一次买宝马'), 0.4);
    assert.ok(rows.every((r) => r.priority >= 0 && r.priority <= 1));
  });

  it('writes generation reasons that cite real Dealer Brain rows and never expired offers', () => {
    const { ctx, hz } = setup();
    const rows = generateQueries(ctx, { dealer_id: hz, goal: GOAL });
    const reason = (text: string) => get(rows, text).generation_reason;
    assert.match(reason('25万买什么车'), /35\.39万/u);
    assert.match(reason('25万买什么车'), /i3金九限时优惠/u);
    assert.match(reason('25万买什么车'), /26\.39万/u);
    assert.match(reason('30万SUV'), /32\.99万/u);
    assert.match(reason('30万SUV'), /X3现金优惠/u);
    assert.match(reason('i3贷款方案'), /i3 36期0息/u);
    assert.match(reason('X3以租代购'), /X3以租代购/u);
    assert.match(reason('宝马置换补贴'), /8000元/u);
    assert.match(reason('i3 35L'), /现车3台/u);
    assert.match(reason('i3有现车吗'), /现车3台、在途1台/u);
    assert.match(reason('i3 vs Model 3'), /竞品/u);
    assert.match(reason('杭州宝马'), /经营目标/u);
    assert.ok(rows.every((r) => !r.generation_reason.includes('i3八月清库优惠')), 'expired August offer is never cited');
  });

  it('generates finance / lease / trade-in queries only while such an offer is active', () => {
    const { ctx, hz, sh } = setup();
    const hzRows = texts(generateQueries(ctx, { dealer_id: hz, goal: GOAL }));
    assert.ok(hzRows.includes('i3贷款方案'));
    assert.ok(!hzRows.includes('X3贷款方案'), 'X3 has a lease offer, not a finance offer');
    assert.ok(hzRows.includes('X3以租代购'));
    assert.ok(!hzRows.includes('i3以租代购'));
    assert.ok(hzRows.includes('宝马置换补贴'));

    const shRows = generateQueries(ctx, { dealer_id: sh, goal: { type: 'lead_generation', models: ['X3'] } });
    const shTexts = texts(shRows);
    assert.ok(!shTexts.some((t) => t.endsWith('贷款方案') || t.endsWith('置换补贴') || t.endsWith('以租代购')));
    assert.match(get(shRows, 'X3优惠').generation_reason, /X3现金优惠.*5\.5万/u);
    assert.ok(shTexts.includes('30万SUV'), '38.99万 − 5.5万 = 33.49万 → 30万 bracket');

    // October: every hz September offer has expired
    const oct = setup({ now: '2026-10-02T02:00:00.000Z' });
    const octRows = generateQueries(oct.ctx, { dealer_id: oct.hz, goal: GOAL });
    const octTexts = texts(octRows);
    assert.ok(!octTexts.some((t) => t.endsWith('贷款方案') || t.endsWith('置换补贴') || t.endsWith('以租代购')));
    assert.ok(octTexts.includes('35万买什么车'), 'no cash offer: 35.39万 → 35万 bracket');
    assert.ok(octTexts.includes('35万SUV'), 'no cash offer: 38.99万 → 35万 bracket');
    assert.ok(!octTexts.includes('25万买什么车'));
    assert.match(get(octRows, 'i3优惠').generation_reason, /暂无现金优惠/u);
    assert.ok(!get(octRows, '准备换车').generation_reason.includes('置换'));
  });

  it('falls back to the dealer location and inventory-prioritized models', () => {
    const { ctx, hz, sh } = setup();
    const rows = generateQueries(ctx, { dealer_id: hz, goal: { type: 'daily_operations', models: [] } });
    assert.deepEqual(new Set(rows.map((r) => r.model).filter((m) => m !== null)), new Set(['i3', 'X3', '3 Series']));
    for (const t of ['宝马3系', '3系还是C级', '3系 vs C级', '杭州宝马', '浙江宝马价格', '杭州3系有现车吗', 'i3 35L']) get(rows, t);
    assert.equal(get(rows, '宝马3系').priority, 0.7, 'in-stock fallback models are priority models');
    assert.ok(!texts(rows).some((t) => t.includes('i4') || t.includes('5系') || t.includes('X1')), 'no stock → not planned');
    assert.match(get(rows, '杭州宝马').generation_reason, /门店所在地/u);

    const dec = decisions(ctx, 'query_generation')[0];
    assert.equal(dec.subject_type, 'dealer');
    assert.equal(dec.subject_id, hz);
    const resolved = dec.inputs.resolved as { model_source: string; location_source: string; models: { model: string }[] };
    assert.equal(resolved.model_source, 'inventory');
    assert.equal(resolved.location_source, 'dealer');
    assert.deepEqual(resolved.models.map((m) => m.model), ['i3', 'X3', '3 Series']);
    assert.ok(Math.abs(dec.confidence - 0.8) < 1e-9);

    const shRows = generateQueries(ctx, { dealer_id: sh, goal: { type: 'lead_generation', models: ['X3'] } });
    for (const t of ['上海宝马', '上海买宝马', '上海宝马价格', '上海X3', '上海X3有现车吗', 'X3 25L']) get(shRows, t);
    assert.ok(!texts(shRows).includes('X3 30L'), 'sh-bmw has no X3 30L in stock');
  });

  it('resolves a goal location given as a province or another city', () => {
    const { ctx, hz } = setup();
    const province = texts(generateQueries(ctx, { dealer_id: hz, goal: { type: 'lead_generation', brand: '宝马', models: ['i3'], location: '浙江' } }));
    assert.ok(province.includes('浙江宝马价格'));
    assert.ok(province.includes('杭州宝马'), 'dealer city is used for a province goal in the dealer province');

    const fresh = setup();
    const ningbo = generateQueries(fresh.ctx, { dealer_id: fresh.hz, goal: { type: 'lead_generation', brand: 'BMW', models: ['宝马i3'], location: '宁波' } });
    for (const t of ['宁波宝马', '宁波i3', '宁波i3有现车吗', '浙江宝马价格']) get(ningbo, t);
    assert.ok(!texts(ningbo).includes('杭州宝马'));
  });

  it('dedups against stored rows: keeps ids, raises priority, attaches goals, reactivates paused, leaves retired alone', () => {
    const { ctx, hz } = setup();
    const paused = insertQuery(ctx, hz, '宝马i3', { status: 'paused', priority: 0.3 });
    const retired = insertQuery(ctx, hz, 'i3优惠', { status: 'retired', priority: 0.2 });
    const learned = insertQuery(ctx, hz, 'i3值得买吗', { goal_id: 'goal_old', priority: 0.2 });
    insertSucceededRun(ctx, learned);
    const spaced = insertQuery(ctx, hz, 'I3  35l', { priority: 0.1 });

    ctx.clock.advance({ minutes: 1 });
    const rows = generateQueries(ctx, { dealer_id: hz, goal: GOAL, goal_id: 'goal_new' });
    const p = get(rows, '宝马i3');
    assert.equal(p.id, paused.id);
    assert.equal(p.status, 'active');
    assert.equal(p.priority, 0.7);
    assert.equal(p.goal_id, 'goal_new');
    assert.equal(ctx.db.table('audit_events').count({ action: 'search_query.reactivated', entity_id: paused.id }), 1);

    const r = get(rows, 'i3优惠');
    assert.equal(r.id, retired.id);
    assert.equal(r.status, 'retired');
    assert.equal(r.priority, 0.2);
    assert.equal(r.goal_id, null);

    const l = get(rows, 'i3值得买吗');
    assert.equal(l.id, learned.id);
    assert.equal(l.priority, 0.7, 'a new goal raises the priority even with run history');
    assert.equal(l.goal_id, 'goal_old', 'an attached goal is never replaced');

    const s = rows.find((x) => x.id === spaced.id);
    assert.ok(s, 'whitespace / case variant of 「i3 35L」 is the same query');
    assert.ok(!texts(rows).includes('i3 35L'));
    assert.equal(ctx.db.table('search_queries').count({ dealer_id: hz }), rows.length);

    // same goal again: a learned (run-backed) priority is kept, a paused query stays paused
    ctx.db.table('search_queries').update(learned.id, { priority: 0.25 });
    ctx.db.table('search_queries').update(paused.id, { status: 'paused' });
    ctx.clock.advance({ minutes: 1 });
    generateQueries(ctx, { dealer_id: hz, goal: GOAL, goal_id: 'goal_old' });
    assert.equal(ctx.db.table('search_queries').require(learned.id).priority, 0.25);
    assert.equal(ctx.db.table('search_queries').require(paused.id).status, 'active', 'goal_old differs from goal_new → reactivated');
    ctx.db.table('search_queries').update(paused.id, { status: 'paused' });
    generateQueries(ctx, { dealer_id: hz, goal: GOAL, goal_id: 'goal_new' });
    assert.equal(ctx.db.table('search_queries').require(paused.id).status, 'paused', 'same goal never reactivates');
  });

  it('records a query_generation decision listing classes, counts and grounding evidence', () => {
    const { ctx, hz } = setup();
    const rows = generateQueries(ctx, { dealer_id: hz, goal: GOAL, goal_id: 'goal_hz' });
    const [dec] = decisions(ctx, 'query_generation');
    assert.equal(dec.agent, 'lead-hunting-agent');
    assert.equal(dec.skill, 'automotive-query-generation');
    assert.equal(dec.subject_type, 'goal');
    assert.equal(dec.subject_id, 'goal_hz');
    assert.equal(dec.engine, 'rules');
    assert.ok(Math.abs(dec.confidence - 0.9) < 1e-9);
    const expectedCounts = Object.fromEntries(GENERATED_QUERY_CLASSES.map((c) => [c, rows.filter((r) => r.query_class === c).length]));
    assert.deepEqual(dec.output.classes, expectedCounts);
    assert.equal(dec.output.total, rows.length);
    assert.equal(dec.output.created, rows.length);
    assert.deepEqual((dec.output.queries as { text: string }[]).map((q) => q.text), texts(rows));
    const offerIds = new Set(ctx.db.table('offers').findMany({ dealer_id: hz }).map((o) => o.id));
    const offerEvidence = dec.evidence.filter((e) => e.code === 'active_offer');
    assert.ok(offerEvidence.length >= 4, 'cash (i3, X3), finance, lease and trade-in offers');
    assert.ok(offerEvidence.every((e) => e.source_ref && offerIds.has(e.source_ref)));
    assert.ok(dec.evidence.some((e) => e.code === 'carried_model' && e.label.includes('宝马i3')));
    assert.ok(dec.evidence.some((e) => e.code === 'target_location' && e.label.includes('杭州')));
    const event = ctx.db.table('audit_events').findOne({ action: 'search_queries.generated' });
    assert.ok(event);
    assert.equal(event.actor, 'agent:lead-hunting-agent');
    assert.equal((event.details.created as unknown[]).length, rows.length);
  });

  it('skips uncarried goal models and rejects invalid goals without writing', () => {
    const { ctx, hz, sh } = setup();
    assert.throws(() => generateQueries(ctx, { dealer_id: 'dlr_missing', goal: GOAL }), NotFoundError);
    assert.throws(() => generateQueries(ctx, { dealer_id: hz, goal: { ...GOAL, brand: 'Tesla' } }), ValidationError);
    assert.throws(() => generateQueries(ctx, { dealer_id: hz, goal: { type: 'lead_generation', brand: 'BMW', models: ['Model Y'] } }), ValidationError);
    assert.throws(() => generateQueries(ctx, { dealer_id: hz, goal: { type: 'bogus' } as unknown as GoalSpec }), ValidationError);
    assert.throws(() => generateQueries(ctx, { dealer_id: hz } as unknown as { dealer_id: string; goal: GoalSpec }), ValidationError);
    const now = ctx.clock.iso();
    const foreignGoal = ctx.db.table('operator_goals').insert({
      id: newId('goal'),
      dealer_id: sh,
      text: '上海X3线索',
      spec: { type: 'lead_generation', models: ['X3'] },
      status: 'active',
      plan: [],
      created_at: now,
      updated_at: now,
    });
    assert.throws(() => generateQueries(ctx, { dealer_id: hz, goal: GOAL, goal_id: foreignGoal.id }), ValidationError);
    assert.equal(ctx.db.table('search_queries').count(), 0);
    assert.equal(decisions(ctx, 'query_generation').length, 0);

    const rows = generateQueries(ctx, { dealer_id: hz, goal: { type: 'lead_generation', brand: '宝马', models: ['i3', 'Model Y'] } });
    get(rows, '宝马i3');
    assert.ok(!texts(rows).some((t) => t.includes('Model Y') && !t.includes('i3')));
    const [dec] = decisions(ctx, 'query_generation');
    assert.deepEqual((dec.inputs.resolved as { skipped_models: string[] }).skipped_models, ['Model Y']);
    assert.ok(dec.evidence.some((e) => e.code === 'model_not_carried' && e.label.includes('Model Y')));
    assert.ok(Math.abs(dec.confidence - 0.7) < 1e-9, 'dealer-location fallback and skipped model lower confidence');
  });

  it('previews a plan without persisting it', () => {
    const { ctx, hz } = setup();
    const planned = planQueries(ctx, { dealer_id: hz, goal: GOAL });
    assert.equal(ctx.db.table('search_queries').count(), 0);
    assert.equal(decisions(ctx, 'query_generation').length, 0);
    const rows = generateQueries(ctx, { dealer_id: hz, goal: GOAL });
    assert.deepEqual(planned.map((p) => [p.text, p.query_class, p.priority]), rows.map((r) => [r.text, r.query_class, r.priority]));
  });

  it('without vehicles in the Dealer Brain, brand-level buyer questions replace model words (not only 城市+品牌)', () => {
    const { ctx, hz } = setup();
    ctx.db.run('DELETE FROM inventory');
    ctx.db.run('DELETE FROM offers');
    ctx.db.run('DELETE FROM vehicles');
    const rows = generateQueries(ctx, { dealer_id: hz, goal: { type: 'lead_generation', brand: 'BMW', models: [], location: '杭州' }, goal_id: 'goal_brand_only' });
    for (const text of ['宝马值得买吗', '宝马哪款值得买', '宝马落地价', '宝马求推荐']) {
      const row = get(rows, text);
      assert.equal(row.model, null);
      assert.match(row.generation_reason, /尚未在门店资料中录入宝马车型/);
    }
    const withVehicles = setup();
    const modelRows = generateQueries(withVehicles.ctx, { dealer_id: withVehicles.hz, goal: GOAL, goal_id: 'goal_models' });
    assert.ok(!texts(modelRows).includes('宝马求推荐'), 'model-level words are used once vehicles exist');
  });

  it('pure helpers: budget brackets, trim aliases and query keys', () => {
    assert.equal(budgetBracketWan(263_900), 25);
    assert.equal(budgetBracketWan(329_900), 30);
    assert.equal(budgetBracketWan(300_000), 30);
    assert.equal(budgetBracketWan(50_000), 5);
    assert.equal(budgetBracketWan(49_999), null);
    assert.equal(budgetBracketWan(0), null);
    assert.equal(budgetBracketWan(Number.NaN), null);

    const { ctx, summary } = setup();
    const vehicle = (key: string) => ctx.db.table('vehicles').require(vehicleIdByKey(summary, key));
    assert.equal(trimAlias(vehicle('i3-edrive35l')), '35L');
    assert.equal(trimAlias(vehicle('x3-xdrive30l')), '30L');
    assert.equal(trimAlias(vehicle('3series-325li')), '325Li');
    assert.equal(trimAlias(vehicle('i4-edrive35')), 'eDrive35');
    assert.equal(trimAlias(vehicle('ix3-leading')), '领先型');

    assert.equal(queryKey('I3 35L'), queryKey('i335l'));
    assert.equal(queryKey('ｉ３ vs Model 3'), queryKey('i3 vs model3'));
    assert.notEqual(queryKey('杭州i3落地'), queryKey('杭州i3落地价'));
  });

  it('is registered as a skill and invoked through the registry', async () => {
    const registry = new SkillRegistry().register(skill);
    const ctx = createTestContext({ skills: registry });
    const hz = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    assert.equal(skill.name, 'automotive-query-generation');
    assert.equal(skill.category, 'acquisition');
    assert.equal(skill.agent, 'lead-hunting-agent');
    assert.throws(() => skill.input(null, skill.name), ValidationError);

    const rows = await registry.invoke<SearchQuery[]>(ctx, 'automotive-query-generation', { dealer_id: hz, goal: GOAL, goal_id: 'goal_skill' });
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => r.goal_id === 'goal_skill'));
    await assert.rejects(registry.invoke(ctx, 'automotive-query-generation', { dealer_id: hz, goal: { brand: 'BMW' } }), ValidationError);
    await assert.rejects(
      registry.invoke(ctx, 'automotive-query-generation', { dealer_id: hz, goal: { type: 'lead_generation', models: 'i3' } }),
      ValidationError,
    );
    assert.throws(() => skill.validateOutput?.([]), /no queries/);
  });

  it('generates spec queries that find public notes through the simulation provider', async () => {
    const xhs = SimulationXhsProvider.fromFile(new ManualClock(TEST_NOW));
    const { ctx, hz } = setup({ xhs });
    const rows = generateQueries(ctx, { dealer_id: hz, goal: GOAL });
    const searched = [
      '宝马i3',
      'i3值得买吗',
      'i3优惠',
      'i3 vs Model 3',
      'X3 vs GLC',
      'X3还是Q5L',
      '25万买什么车',
      '30万SUV',
      '家用SUV推荐',
      '第一次买宝马',
      '杭州买宝马',
      '杭州宝马优惠',
      '浙江宝马价格',
      '什么时候买便宜',
      'X3落地价',
    ];
    for (const text of searched) {
      get(rows, text);
      const res = await ctx.xhs.searchNotes(text, { limit: 5 });
      assert.equal(res.ok, true, `search 「${text}」 failed`);
      if (res.ok) assert.ok(res.data.length > 0, `no simulated notes for 「${text}」`);
    }
  });
});
