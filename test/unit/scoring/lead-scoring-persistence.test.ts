import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { AutomotiveIntent, Evidence, Lead, LeadScore, LeadSignal } from '../../../src/core/types.ts';
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  getScoringConfig,
  scoreLead,
  skill,
  updateScoringConfig,
} from '../../../src/skills/acquisition/lead-scoring/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';

const DAY_MS = 86_400_000;

function seedDealer(ctx: TestContext) {
  const now = ctx.clock.iso();
  const group = ctx.db.table('dealer_groups').insert({ id: newId('grp'), name: '浙沪宝马经销商集团', created_at: now });
  const dealer = ctx.db.table('dealers').insert({
    id: newId('dlr'),
    group_id: group.id,
    name: '杭州宝马中心',
    brands: ['BMW'],
    city: '杭州',
    province: '浙江',
    address: '杭州市测试路1号',
    business_hours: '09:00-18:00',
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
    created_at: now,
    updated_at: now,
  });
  const vehicle = (model: string, trim: string, msrp: number, aliases: string[]) =>
    ctx.db.table('vehicles').insert({
      id: newId('veh'),
      group_id: group.id,
      brand: 'BMW',
      brand_zh: '宝马',
      model,
      model_zh: model,
      trim,
      model_year: 2026,
      msrp,
      specs: {},
      highlights: [],
      aliases,
      source: 'test_price_sheet',
      updated_at: now,
    });
  const i3_35 = vehicle('i3', 'eDrive35L', 353900, ['35L', 'i3 35L']);
  const i3_40 = vehicle('i3', 'eDrive40L', 403900, ['40L', 'i3 40L']);
  const x3_25 = vehicle('X3', 'xDrive25L', 399900, ['25L']);
  const stock = (vehicleId: string, ext: string, int: string, status: 'in_stock' | 'in_transit' | 'sold', quantity: number) =>
    ctx.db.table('inventory').insert({
      id: newId('inv'),
      dealer_id: dealer.id,
      vehicle_id: vehicleId,
      vin: null,
      exterior_color: ext,
      interior_color: int,
      status,
      quantity,
      list_price: null,
      source: 'test_inventory',
      updated_at: now,
    });
  stock(i3_35.id, '白', '红', 'in_stock', 1);
  stock(i3_35.id, '黑', '黑', 'in_stock', 2);
  stock(i3_40.id, '灰', '黑', 'in_transit', 1);
  stock(x3_25.id, '白', '棕', 'in_stock', 2);
  stock(x3_25.id, '蓝', '黑', 'sold', 1);
  return { group, dealer };
}

function insertLead(ctx: TestContext, groupId: string, dealerId: string, evidence: Evidence[] = [], intent: AutomotiveIntent = {}): Lead {
  const now = ctx.clock.iso();
  return ctx.db.table('leads').insert({
    id: newId('lead'),
    group_id: groupId,
    dealer_id: dealerId,
    platform: 'xiaohongshu',
    platform_user_id: newId('u'),
    username: '杭州买车的小李',
    profile_url: null,
    stage: 'DISCOVERED',
    score: 0,
    tier: 'none',
    intent,
    evidence,
    primary_signal_id: null,
    signal_count: 0,
    first_seen_at: now,
    last_signal_at: now,
    suppressed: false,
    suppression_reason: null,
    contact: {},
    lost_reason: null,
    estimated_value: 0,
    attributed_post_id: null,
    attributed_query_id: null,
    next_action: null,
    created_at: now,
    updated_at: now,
  });
}

interface SignalSpec {
  content: string;
  ageDays: number;
  intent: AutomotiveIntent;
  evidence: Evidence[];
}

type DetectionColumns = Pick<LeadSignal, 'is_purchase_signal' | 'strength' | 'transaction_questions' | 'author_role'>;

/** Migration-v2 column defaults: a row written before v2 (re-scoring falls back to evidence codes). */
const LEGACY_COLUMNS: DetectionColumns = { is_purchase_signal: true, strength: 0, transaction_questions: [], author_role: null };

function insertSignal(ctx: TestContext, leadId: string, spec: SignalSpec, columns: DetectionColumns = LEGACY_COLUMNS) {
  return ctx.db.table('lead_signals').insert({
    id: newId('sig'),
    lead_id: leadId,
    source_type: 'comment',
    public_post_id: null,
    public_comment_id: null,
    post_title: '宝马i3现在值得买吗？',
    content: spec.content,
    signal_at: new Date(ctx.clock.now().getTime() - spec.ageDays * DAY_MS).toISOString(),
    search_run_id: null,
    query_id: null,
    intent: spec.intent,
    signal_score: 0,
    evidence: spec.evidence,
    engine: 'rules',
    ...columns,
    created_at: ctx.clock.iso(),
  });
}

/** Stored signals as dedup persisted them before migration v2: intent + evidence, transaction questions as `tq:` codes. */
const SIGNALS = {
  discount: (ageDays: number): SignalSpec => ({
    content: '现在优惠多少',
    ageDays,
    intent: {
      brand: 'BMW',
      model: 'i3',
      discount_intent: true,
      purchase_stage: 'price_shopping',
      confidence: 0.75,
      inferred_fields: ['brand', 'model'],
    },
    evidence: [{ code: 'tq:discount', label: '询问优惠', quote: '优惠多少' }],
  }),
  i3Discount: (ageDays: number): SignalSpec => ({
    content: '现在i3优惠多少',
    ageDays,
    intent: {
      brand: 'BMW',
      model: 'i3',
      discount_intent: true,
      purchase_stage: 'price_shopping',
      confidence: 0.8,
      inferred_fields: ['brand'],
    },
    evidence: [
      { code: 'specified_model', label: '指定车型', quote: 'i3' },
      { code: 'tq:discount', label: '询问优惠', quote: '优惠多少' },
    ],
  }),
  rear: (ageDays: number): SignalSpec => ({
    content: '这车后排空间怎么样',
    ageDays,
    intent: { brand: 'BMW', model: 'i3', purchase_stage: 'research', confidence: 0.6, inferred_fields: ['brand', 'model'] },
    evidence: [{ code: 'research_question', label: '关注后排空间', quote: '后排空间怎么样' }],
  }),
  shuai: (ageDays: number): SignalSpec => ({
    content: '帅',
    ageDays,
    intent: {},
    evidence: [{ code: 'pure_praise', label: '纯夸赞', quote: '帅' }],
  }),
  landing: (ageDays: number): SignalSpec => ({
    content: '杭州i3 35L落地多少',
    ageDays,
    intent: {
      brand: 'BMW',
      model: 'i3',
      trim: 'eDrive35L',
      location: '杭州',
      province: '浙江',
      price_intent: true,
      purchase_stage: 'active_shopping',
      confidence: 0.9,
      inferred_fields: ['brand'],
    },
    evidence: [
      { code: 'specified_location', label: '指定城市', quote: '杭州' },
      { code: 'tq:landing_price', label: '询问落地价', quote: '落地多少' },
    ],
  }),
  visit: (ageDays: number): SignalSpec => ({
    content: '杭州i3 35L白外红内有现车吗？这周想去看看',
    ageDays,
    intent: {
      brand: 'BMW',
      model: 'i3',
      trim: 'eDrive35L',
      location: '杭州',
      province: '浙江',
      inventory_intent: true,
      color_intent: '白外红内',
      visit_intent: true,
      purchase_stage: 'purchase_imminent',
      confidence: 0.95,
      inferred_fields: ['brand'],
    },
    evidence: [
      { code: 'tq:inventory', label: '询问现车', quote: '有现车吗' },
      { code: 'tq:color_trim_availability', label: '指定颜色', quote: '白外红内' },
      { code: 'tq:test_drive', label: '想到店看车', quote: '这周想去看看' },
    ],
  }),
};

const sumPoints = (s: LeadScore) => s.components.reduce((acc, c) => acc + c.points, 0);

describe('lead-scoring: versioned scoring config', () => {
  it('ensures an active version 1 with defaults exactly once', () => {
    const ctx = createTestContext();
    const { dealer } = seedDealer(ctx);
    const first = getScoringConfig(ctx, dealer.id);
    assert.equal(first.version, 1);
    assert.equal(first.active, true);
    assert.deepEqual(first.weights, DEFAULT_WEIGHTS);
    assert.deepEqual(first.thresholds, DEFAULT_THRESHOLDS);
    const again = getScoringConfig(ctx, dealer.id);
    assert.equal(again.id, first.id);
    assert.equal(ctx.db.table('scoring_configs').count({ dealer_id: dealer.id }), 1);
    assert.equal(ctx.audit.eventsFor('scoring_config', first.id).filter((e) => e.action === 'scoring.config_initialized').length, 1);
  });

  it('rejects unknown dealers', () => {
    const ctx = createTestContext();
    assert.throws(() => getScoringConfig(ctx, 'dlr_missing'), /not found/);
  });

  it('creates version+1, deactivates the previous version and audits the change', () => {
    const ctx = createTestContext();
    const { dealer } = seedDealer(ctx);
    const v1 = getScoringConfig(ctx, dealer.id);
    ctx.clock.advance({ minutes: 1 });
    const v2 = updateScoringConfig(ctx, dealer.id, { weights: { transaction_questions: 20, recency: 1 } }, 'operator:张经理');
    assert.equal(v2.version, 2);
    assert.equal(v2.active, true);
    assert.equal(v2.weights.transaction_questions, 20);
    assert.equal(v2.weights.recency, 1);
    assert.equal(v2.weights.explicit_purchase_intent, 25, 'unpatched weights carried forward');
    assert.equal(ctx.db.table('scoring_configs').require(v1.id).active, false);
    assert.equal(ctx.db.table('scoring_configs').count({ dealer_id: dealer.id, active: true }), 1);
    assert.equal(getScoringConfig(ctx, dealer.id).id, v2.id);

    const events = ctx.audit.eventsFor('scoring_config', v2.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'scoring.config_updated');
    assert.equal(events[0].actor, 'operator:张经理');
    assert.deepEqual((events[0].details.changes as Record<string, unknown>)['weights.transaction_questions'], { from: 15, to: 20 });
    assert.equal(events[0].details.from_version, 1);

    const v3 = updateScoringConfig(ctx, dealer.id, { thresholds: { qualified: 65 } }, 'operator:张经理');
    assert.equal(v3.version, 3);
    assert.equal(v3.weights.transaction_questions, 20, 'v3 builds on v2');
    assert.deepEqual(
      ctx.db.table('scoring_configs').findMany({ dealer_id: dealer.id }, { orderBy: 'version ASC' }).map((r) => [r.version, r.active]),
      [
        [1, false],
        [2, false],
        [3, true],
      ],
    );
  });

  it('the DB unique index forbids two active configs for a dealer', () => {
    const ctx = createTestContext();
    const { dealer } = seedDealer(ctx);
    getScoringConfig(ctx, dealer.id);
    assert.throws(
      () =>
        ctx.db.table('scoring_configs').insert({
          id: newId('scfg'),
          dealer_id: dealer.id,
          version: 9,
          weights: { ...DEFAULT_WEIGHTS },
          thresholds: { ...DEFAULT_THRESHOLDS },
          active: true,
          created_at: ctx.clock.iso(),
        }),
      /UNIQUE/,
    );
  });

  it('validates thresholds ascending and weights non-negative without creating a version', () => {
    const ctx = createTestContext();
    const { dealer } = seedDealer(ctx);
    const v1 = getScoringConfig(ctx, dealer.id);
    const bad: [Parameters<typeof updateScoringConfig>[2], RegExp][] = [
      [{ thresholds: { qualified: 10 } }, /ascending/],
      [{ thresholds: { candidate: 0 } }, /greater than 0/],
      [{ thresholds: { immediate: 80 } }, /ascending/],
      [{ weights: { model_match: -1 } }, />= 0/],
      [{ weights: { recency: Number.NaN } }, /finite/],
      [{ weights: { bogus: 5 } as never }, /unknown key/],
      [
        {
          weights: {
            explicit_purchase_intent: 0,
            transaction_questions: 0,
            model_match: 0,
            inventory_match: 0,
            location_match: 0,
            purchase_stage: 0,
            recency: 0,
            authenticity: 0,
            dealer_relevance: 0,
          },
        },
        /greater than 0/,
      ],
      [{}, /nothing to update/],
    ];
    for (const [patch, message] of bad) {
      assert.throws(
        () => updateScoringConfig(ctx, dealer.id, patch, 'operator:张经理'),
        (err: unknown) => err instanceof ValidationError && message.test(err.message),
        `patch ${JSON.stringify(patch)}`,
      );
    }
    assert.throws(() => updateScoringConfig(ctx, dealer.id, { weights: { recency: 3 } }, ''), ValidationError);
    assert.equal(ctx.db.table('scoring_configs').count({ dealer_id: dealer.id }), 1);
    assert.equal(getScoringConfig(ctx, dealer.id).id, v1.id);
  });

  it('reactivates the latest version if no config is active', () => {
    const ctx = createTestContext();
    const { dealer } = seedDealer(ctx);
    getScoringConfig(ctx, dealer.id);
    const v2 = updateScoringConfig(ctx, dealer.id, { weights: { recency: 8 } }, 'operator:张经理');
    ctx.db.run('UPDATE scoring_configs SET active = 0 WHERE dealer_id = ?', dealer.id);
    const cfg = getScoringConfig(ctx, dealer.id);
    assert.equal(cfg.id, v2.id);
    assert.equal(cfg.active, true);
    assert.equal(cfg.weights.recency, 8);
  });
});

describe('lead-scoring: scoreLead aggregate', () => {
  it('aggregates re-scored signals with a corroboration bonus, persists and records the decision', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedDealer(ctx);
    const leadEvidence: Evidence[] = [{ code: 'discount_intent', label: '询问优惠', quote: '优惠多少', source_ref: 'sig' }];
    const lead = insertLead(ctx, group.id, dealer.id, leadEvidence);
    const strong = insertSignal(ctx, lead.id, SIGNALS.i3Discount(1));
    insertSignal(ctx, lead.id, SIGNALS.rear(2));
    insertSignal(ctx, lead.id, SIGNALS.shuai(1));

    const result = scoreLead(ctx, lead.id);
    // best "现在i3优惠多少" = 69, two purchase signals ≥ candidate (69, 31) → +2; "帅" = 2 is not a purchase signal.
    assert.equal(result.score, 71);
    assert.equal(result.tier, 'qualified');
    assert.equal(result.config_version, 1);
    assert.equal(result.computed_at, ctx.clock.iso());
    const corroboration = result.components.find((c) => c.factor === 'corroboration');
    assert.ok(corroboration);
    assert.equal(corroboration.points, 2);
    assert.match(corroboration.reason, /2 条信号/);
    assert.equal(sumPoints(result), 71);
    assert.equal(result.components.find((c) => c.factor === 'model_match')?.points, 12, 'components of the best signal');

    const stored = ctx.db.table('lead_scores').findMany({ lead_id: lead.id });
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0], result);

    const updated = ctx.db.table('leads').require(lead.id);
    assert.equal(updated.score, 71);
    assert.equal(updated.tier, 'qualified');
    assert.equal(updated.stage, 'DISCOVERED', 'scoring never changes the funnel stage');

    const decisions = ctx.audit.decisionsFor('lead', lead.id);
    assert.equal(decisions.length, 1);
    const d = decisions[0];
    assert.equal(d.decision_type, 'lead_score');
    assert.equal(d.agent, 'lead-scoring-agent');
    assert.equal(d.skill, 'lead-scoring');
    assert.equal(d.engine, 'rules');
    assert.equal(d.confidence, 0.8, 'confidence from the best signal intent');
    assert.deepEqual(d.evidence, leadEvidence);
    assert.equal(d.output.score, 71);
    assert.equal(d.output.best_signal_id, strong.id);
    assert.equal(d.output.qualifying_signals, 2);
    assert.equal(d.output.out_of_area_capped, false);
    assert.equal((d.inputs.signals as unknown[]).length, 3);
    assert.ok((d.inputs.signals as { legacy_row: boolean }[]).every((s) => s.legacy_row), 'rows holding the v2 defaults are read as legacy');
    // §5.3: a single-dealer group records just this dealer's best signal score
    assert.deepEqual(d.inputs.group_dealer_scores, [{ dealer_id: dealer.id, best_signal_id: strong.id, best_signal_score: 69, tier: 'qualified' }]);

    const events = ctx.audit.eventsFor('lead', lead.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].action, 'lead.score_updated');
    assert.deepEqual([events[0].details.from_score, events[0].details.to_score], [0, 71]);
  });

  it('reproduces the §5 reference table from stored lead_signals rows', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedDealer(ctx);
    const cases: [SignalSpec, number, string][] = [
      [SIGNALS.shuai(1), 2, 'none'],
      [SIGNALS.rear(1), 31, 'candidate'],
      [SIGNALS.discount(1), 65, 'qualified'],
      [SIGNALS.i3Discount(1), 69, 'qualified'],
      [SIGNALS.landing(1), 91, 'high_intent'],
      [SIGNALS.visit(1), 99, 'immediate'],
    ];
    for (const [spec, expected, tier] of cases) {
      const lead = insertLead(ctx, group.id, dealer.id);
      insertSignal(ctx, lead.id, spec);
      const result = scoreLead(ctx, lead.id);
      assert.equal(result.score, expected, spec.content);
      assert.equal(result.tier, tier, spec.content);
      assert.equal(sumPoints(result), expected, `${spec.content}: components sum to the score`);
    }
  });

  it('is atomic: a failure while recording the decision leaves no score row and no lead update', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedDealer(ctx);
    const lead = insertLead(ctx, group.id, dealer.id);
    insertSignal(ctx, lead.id, SIGNALS.visit(1));
    getScoringConfig(ctx, dealer.id);
    ctx.audit.decision = () => {
      throw new Error('decision store unavailable');
    };
    assert.throws(() => scoreLead(ctx, lead.id), /decision store unavailable/);
    assert.equal(ctx.db.table('lead_scores').count({ lead_id: lead.id }), 0);
    const unchanged = ctx.db.table('leads').require(lead.id);
    assert.equal(unchanged.score, 0);
    assert.equal(unchanged.tier, 'none');
    assert.equal(ctx.audit.eventsFor('lead', lead.id).length, 0, 'score_updated event rolled back');
  });

  it('re-scores at the current clock so recency decays over time', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedDealer(ctx);
    const lead = insertLead(ctx, group.id, dealer.id);
    insertSignal(ctx, lead.id, SIGNALS.i3Discount(1));
    insertSignal(ctx, lead.id, SIGNALS.rear(2));
    assert.equal(scoreLead(ctx, lead.id).score, 71);

    ctx.clock.advance({ days: 10 }); // 11 and 12 days old → recency 4
    const later = scoreLead(ctx, lead.id);
    assert.equal(later.score, 69);
    ctx.clock.advance({ days: 90 }); // > 90 days → recency 0
    const stale = scoreLead(ctx, lead.id);
    assert.equal(stale.score, 65);
    assert.equal(stale.tier, 'qualified');
    assert.equal(ctx.db.table('lead_scores').count({ lead_id: lead.id }), 3);
    assert.equal(ctx.db.table('leads').require(lead.id).score, 65);
  });

  it('caps the corroboration bonus at 5 and the total at 100', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedDealer(ctx);

    const many = insertLead(ctx, group.id, dealer.id);
    insertSignal(ctx, many.id, SIGNALS.i3Discount(1));
    insertSignal(ctx, many.id, SIGNALS.rear(1));
    insertSignal(ctx, many.id, SIGNALS.rear(2));
    insertSignal(ctx, many.id, SIGNALS.rear(3));
    const manyScore = scoreLead(ctx, many.id);
    assert.equal(manyScore.score, 74, '69 + min(5, 2 × 3)');
    assert.equal(manyScore.components.find((c) => c.factor === 'corroboration')?.points, 5);

    const hot = insertLead(ctx, group.id, dealer.id);
    insertSignal(ctx, hot.id, SIGNALS.visit(1));
    insertSignal(ctx, hot.id, SIGNALS.landing(2));
    const hotScore = scoreLead(ctx, hot.id);
    assert.equal(hotScore.score, 100);
    assert.equal(hotScore.tier, 'immediate');
    const bonus = hotScore.components.find((c) => c.factor === 'corroboration');
    assert.equal(bonus?.points, 1, '99 + 2 capped at 100');
    assert.match(bonus?.reason ?? '', /封顶/);
    assert.equal(sumPoints(hotScore), 100);
  });

  it('uses lead evidence for authenticity (industry_account → 0)', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedDealer(ctx);
    const lead = insertLead(ctx, group.id, dealer.id, [{ code: 'industry_account', label: '主页简介为汽车销售顾问' }]);
    insertSignal(ctx, lead.id, SIGNALS.i3Discount(1));
    const result = scoreLead(ctx, lead.id);
    const auth = result.components.find((c) => c.factor === 'authenticity');
    assert.equal(auth?.points, 0);
    assert.match(auth?.reason ?? '', /行业账号/);
    assert.equal(result.score, 65);

    const verified = insertLead(ctx, group.id, dealer.id, [{ code: 'verified_local_user', label: '长期发布杭州本地生活' }]);
    insertSignal(ctx, verified.id, SIGNALS.i3Discount(1));
    assert.equal(scoreLead(ctx, verified.id).score, 70);
  });

  it('scores leads without signals as 0 and still records the decision', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedDealer(ctx);
    const lead = insertLead(ctx, group.id, dealer.id);
    const result = scoreLead(ctx, lead.id);
    assert.equal(result.score, 0);
    assert.equal(result.tier, 'none');
    assert.deepEqual(
      result.components.map((c) => c.factor),
      ['no_signals'],
    );
    assert.equal(ctx.audit.decisionsFor('lead', lead.id).length, 1);
    assert.equal(ctx.audit.eventsFor('lead', lead.id).length, 0, 'unchanged score → no state-change event');
  });

  it('applies the active config version and its thresholds', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedDealer(ctx);
    const lead = insertLead(ctx, group.id, dealer.id);
    insertSignal(ctx, lead.id, SIGNALS.i3Discount(1));
    insertSignal(ctx, lead.id, SIGNALS.rear(2));
    updateScoringConfig(ctx, dealer.id, { thresholds: { qualified: 76, high_intent: 90, immediate: 96 } }, 'operator:张经理');
    const result = scoreLead(ctx, lead.id);
    assert.equal(result.config_version, 2);
    assert.equal(result.score, 71);
    assert.equal(result.tier, 'candidate');
    assert.equal(ctx.db.table('leads').require(lead.id).tier, 'candidate');
  });

  it('accepts plain transaction codes and intent flags when tq: codes are absent', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedDealer(ctx);
    const plain = insertLead(ctx, group.id, dealer.id);
    const spec = SIGNALS.i3Discount(1);
    insertSignal(ctx, plain.id, { ...spec, evidence: [{ code: 'discount', label: '询问优惠', quote: '优惠多少' }] });
    const flags = insertLead(ctx, group.id, dealer.id);
    insertSignal(ctx, flags.id, { ...spec, evidence: [] });
    assert.equal(scoreLead(ctx, plain.id).score, 69);
    assert.equal(scoreLead(ctx, flags.id).score, 69);
  });

  it('throws for unknown leads', () => {
    const ctx = createTestContext();
    assert.throws(() => scoreLead(ctx, 'lead_missing'), /not found/);
  });
});

/** Rows written by a migration-v2 writer: the detection columns carry the NLU output, evidence has no `tq:` codes. */
const V2 = {
  /** '现在i3优惠多少' — no discount flag and no question code in evidence: only the columns carry the question */
  i3Discount: (ageDays: number): [SignalSpec, DetectionColumns] => [
    {
      content: '现在i3优惠多少',
      ageDays,
      intent: { brand: 'BMW', model: 'i3', purchase_stage: 'price_shopping', confidence: 0.8, inferred_fields: ['brand'] },
      evidence: [{ code: 'stated_model', label: '提及车型 i3', quote: 'i3' }],
    },
    { is_purchase_signal: true, strength: 0.88, transaction_questions: ['discount'], author_role: 'asker' },
  ],
  ownerRemark: (ageDays: number): [SignalSpec, DetectionColumns] => [
    {
      content: '开了半年i3，做工和底盘真的好，推荐去试驾对比下',
      ageDays,
      intent: { brand: 'BMW', model: 'i3', confidence: 0.85 },
      evidence: [
        { code: 'already_purchased', label: '已购车（非在市买家）', quote: '开了半年' },
        { code: 'negative_feedback', label: '非在市买家，不应跟进', quote: '开了半年' },
      ],
    },
    { is_purchase_signal: false, strength: 0, transaction_questions: [], author_role: 'owner' },
  ],
  creatorPost: (ageDays: number): [SignalSpec, DetectionColumns] => [
    {
      content: '杭州i3试驾体验｜续航、空间、优惠一次说清',
      ageDays,
      // a writer that kept the rules stage in the intent must still be read as a non-signal
      intent: { brand: 'BMW', model: 'i3', location: '杭州', province: '浙江', discount_intent: true, purchase_stage: 'active_shopping' },
      evidence: [{ code: 'content_creator', label: '内容创作/经验分享（非本人购车询问）', quote: '一次说清' }],
    },
    { is_purchase_signal: false, strength: 0, transaction_questions: [], author_role: 'creator' },
  ],
  shenzhen: (content: string, ageDays: number, question: 'landing_price' | 'inventory'): [SignalSpec, DetectionColumns] => [
    {
      content,
      ageDays,
      intent: {
        brand: 'BMW',
        model: 'i3',
        trim: 'eDrive35L',
        location: '深圳',
        province: '广东',
        ...(question === 'inventory' ? { inventory_intent: true } : { price_intent: true }),
        purchase_stage: 'active_shopping',
        confidence: 0.9,
        inferred_fields: ['brand'],
      },
      evidence: [{ code: 'stated_location', label: '所在地（深圳）', quote: '深圳' }],
    },
    { is_purchase_signal: true, strength: 1, transaction_questions: [question], author_role: 'asker' },
  ],
};

describe('lead-scoring: migration-v2 signal rows', () => {
  it('scores v2 rows from the detection columns, not from evidence conventions', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedDealer(ctx);
    const lead = insertLead(ctx, group.id, dealer.id);
    const [spec, columns] = V2.i3Discount(1);
    insertSignal(ctx, lead.id, spec, columns);
    const result = scoreLead(ctx, lead.id);
    assert.equal(result.score, 69, 'the discount question comes from the column (evidence alone would give 57)');
    assert.equal(result.components.find((c) => c.factor === 'transaction_questions')?.points, 12);
    const signalInputs = ctx.audit.decisionsFor('lead', lead.id)[0].inputs.signals as { legacy_row: boolean; author_role: string | null }[];
    assert.deepEqual(signalInputs.map((s) => [s.legacy_row, s.author_role]), [[false, 'asker']]);
  });

  it('honours the stored strength column over the stage anchor', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedDealer(ctx);
    const lead = insertLead(ctx, group.id, dealer.id);
    const [spec, columns] = V2.i3Discount(1);
    insertSignal(ctx, lead.id, spec, { ...columns, strength: 0.5 });
    const result = scoreLead(ctx, lead.id);
    assert.equal(result.components.find((c) => c.factor === 'explicit_purchase_intent')?.points, 13, 'round(0.5 × 25)');
    assert.equal(result.score, 60);
  });

  it('never scores a v2 non-purchase row as a purchase signal, even with a stage in its intent', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedDealer(ctx);
    const lead = insertLead(ctx, group.id, dealer.id);
    const [spec, columns] = V2.creatorPost(1);
    insertSignal(ctx, lead.id, spec, columns);
    const result = scoreLead(ctx, lead.id);
    assert.equal(result.score, 2);
    assert.equal(result.tier, 'none');
    assert.match(result.components.find((c) => c.factor === 'non_purchase_signal')?.reason ?? '', /内容创作/);
  });

  it('lets only purchase signals corroborate (owner remarks and creator content never add a bonus, F4)', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedDealer(ctx);
    // candidate threshold 1: non-purchase signals (score 2) would count under a score-only rule
    updateScoringConfig(ctx, dealer.id, { thresholds: { candidate: 1 } }, 'operator:张经理');
    const lead = insertLead(ctx, group.id, dealer.id);
    insertSignal(ctx, lead.id, ...V2.i3Discount(1));
    insertSignal(ctx, lead.id, ...V2.ownerRemark(1));
    insertSignal(ctx, lead.id, ...V2.ownerRemark(2));
    insertSignal(ctx, lead.id, ...V2.creatorPost(2));
    insertSignal(ctx, lead.id, SIGNALS.shuai(1));
    const result = scoreLead(ctx, lead.id);
    assert.equal(result.score, 69);
    assert.equal(result.components.find((c) => c.factor === 'corroboration'), undefined);
    assert.equal(ctx.audit.decisionsFor('lead', lead.id)[0].output.qualifying_signals, 1);

    insertSignal(ctx, lead.id, SIGNALS.rear(2)); // a second (legacy) purchase signal
    assert.equal(scoreLead(ctx, lead.id).score, 71);
  });

  it('reads legacy rows carrying content_creator / already_purchased codes as non-purchase', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedDealer(ctx);
    for (const code of ['content_creator', 'already_purchased']) {
      const lead = insertLead(ctx, group.id, dealer.id);
      insertSignal(ctx, lead.id, { ...SIGNALS.i3Discount(1), evidence: [...SIGNALS.i3Discount(1).evidence, { code, label: code }] });
      assert.equal(scoreLead(ctx, lead.id).score, 2, code);
    }
  });

  it('keeps an explicitly out-of-area lead below qualified even with corroborating signals (§5.2)', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedDealer(ctx);
    const lead = insertLead(ctx, group.id, dealer.id);
    insertSignal(ctx, lead.id, ...V2.shenzhen('深圳i3 35L落地多少', 1, 'landing_price'));
    insertSignal(ctx, lead.id, ...V2.shenzhen('深圳i3 35L有现车吗', 2, 'inventory'));
    const result = scoreLead(ctx, lead.id);
    assert.equal(result.score, 59);
    assert.equal(result.tier, 'candidate');
    assert.ok(result.components.some((c) => c.factor === 'out_of_area_cap' && c.points < 0));
    const corroboration = result.components.find((c) => c.factor === 'corroboration');
    assert.equal(corroboration?.points, 0);
    assert.match(corroboration?.reason ?? '', /异地买家总分封顶 59/);
    assert.equal(sumPoints(result), 59);
    const decision = ctx.audit.decisionsFor('lead', lead.id)[0];
    assert.equal(decision.output.out_of_area_capped, true);
    assert.equal(decision.output.qualifying_signals, 2);

    // a qualifying signal that states a local place shows the buyer is (also) local: the cap no longer holds
    insertSignal(ctx, lead.id, { ...SIGNALS.rear(1), content: '杭州这车后排空间怎么样', intent: { ...SIGNALS.rear(1).intent, location: '杭州', province: '浙江' } }, {
      is_purchase_signal: true,
      strength: 0.2,
      transaction_questions: [],
      author_role: 'asker',
    });
    const local = scoreLead(ctx, lead.id);
    assert.equal(local.score, 63, '59 + min(5, 2 × 2)');
    assert.equal(local.tier, 'qualified');
    assert.equal(ctx.audit.decisionsFor('lead', lead.id)[1].output.out_of_area_capped, false);
  });

  it('caps the lead when any purchase signal states an out-of-area place, even if its best signal names no place (§5.2)', () => {
    const ctx = createTestContext();
    const { group, dealer } = seedDealer(ctx);
    const lead = insertLead(ctx, group.id, dealer.id);
    insertSignal(ctx, lead.id, ...V2.shenzhen('深圳i3 35L落地多少', 2, 'landing_price')); // 81 raw → 59 capped
    const best = insertSignal(ctx, lead.id, ...V2.i3Discount(1)); // 69, no place stated
    const result = scoreLead(ctx, lead.id);
    // before: best 69 + corroboration 2 = 71 (qualified) although the buyer said they are in 深圳
    assert.equal(result.score, 59);
    assert.equal(result.tier, 'candidate');
    const cap = result.components.find((c) => c.factor === 'out_of_area_cap');
    assert.ok(cap, 'a lead-level out_of_area_cap component explains the reduction');
    assert.equal(cap.points, -10);
    assert.equal(cap.max, 0);
    assert.match(cap.reason, /异地买家（深圳）/);
    assert.equal(result.components.find((c) => c.factor === 'corroboration')?.points, 0);
    assert.equal(sumPoints(result), 59, 'components still sum to the score');
    const decision = ctx.audit.decisionsFor('lead', lead.id)[0];
    assert.equal(decision.output.best_signal_id, best.id);
    assert.equal(decision.output.best_signal_score, 69);
    assert.equal(decision.output.out_of_area_capped, true);
    assert.equal(ctx.db.table('leads').require(lead.id).tier, 'candidate');

    // a negative or non-purchase signal naming 深圳 does not cap a local buyer
    const other = insertLead(ctx, group.id, dealer.id);
    insertSignal(ctx, other.id, ...V2.i3Discount(1));
    insertSignal(ctx, other.id, { content: '深圳有没有类似攻略', ageDays: 1, intent: { location: '深圳', province: '广东' }, evidence: [{ code: 'no_signal', label: '无购车相关信号', quote: '深圳有没有类似攻略' }] }, {
      is_purchase_signal: false,
      strength: 0,
      transaction_questions: [],
      author_role: 'unknown',
    });
    assert.equal(scoreLead(ctx, other.id).score, 69);
  });
});

describe('lead-scoring: skill definition', () => {
  it('is registered as acquisition skill of the lead-scoring agent and validates input', async () => {
    const ctx = createTestContext();
    assert.equal(skill.name, 'lead-scoring');
    assert.equal(skill.category, 'acquisition');
    assert.equal(skill.agent, 'lead-scoring-agent');
    ctx.skills.register(skill);
    const { group, dealer } = seedDealer(ctx);
    const lead = insertLead(ctx, group.id, dealer.id);
    insertSignal(ctx, lead.id, SIGNALS.visit(0));
    const out = await ctx.skills.invoke<LeadScore>(ctx, 'lead-scoring', { lead_id: lead.id });
    assert.equal(out.score, 99);
    assert.equal(out.tier, 'immediate');
    await assert.rejects(ctx.skills.invoke(ctx, 'lead-scoring', { lead_id: '' }), /lead_id/);
    await assert.rejects(ctx.skills.invoke(ctx, 'lead-scoring', {}), /lead_id/);
  });
});
