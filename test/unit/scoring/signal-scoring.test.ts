import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AutomotiveIntent, DealerProfile, IntentDetection, ScoreComponent } from '../../../src/core/types.ts';
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  STRENGTH_ANCHORS,
  authenticityFromEvidence,
  colorMatches,
  detectionFromSignal,
  effectiveMaxima,
  parseColorIntent,
  scoreSignal,
  tierFor,
} from '../../../src/skills/acquisition/lead-scoring/index.ts';

const NOW = '2026-09-12T02:00:00.000Z';
const DAY_MS = 86_400_000;
const agoMs = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();
const daysAgo = (days: number) => agoMs(days * DAY_MS);
const CFG = { weights: DEFAULT_WEIGHTS, thresholds: DEFAULT_THRESHOLDS };

/** Hand-built profile for 杭州宝马中心 (fixture canon, ARCHITECTURE §9). */
const PROFILE: DealerProfile = {
  dealer_id: 'dlr_hz_bmw',
  brands: ['BMW'],
  models: ['3 Series', 'X3', 'i3', 'i4'],
  trims: [
    { model: '3 Series', trim: '325Li', aliases: ['325Li'] },
    { model: 'X3', trim: 'xDrive25L', aliases: ['25L', 'X3 25L'] },
    { model: 'X3', trim: 'xDrive30L', aliases: ['30L', 'X3 30L'] },
    { model: 'i3', trim: 'eDrive35L', aliases: ['35L', 'i3 35L'] },
    { model: 'i3', trim: 'eDrive40L', aliases: ['40L', 'i3 40L'] },
    { model: 'i4', trim: 'eDrive40', aliases: ['i4 40'] },
  ],
  inventory: [
    { model: 'i3', trim: 'eDrive35L', exterior_color: '白', interior_color: '红', status: 'in_stock', quantity: 1 },
    { model: 'i3', trim: 'eDrive35L', exterior_color: '黑', interior_color: '黑', status: 'in_stock', quantity: 2 },
    { model: 'i3', trim: 'eDrive40L', exterior_color: '灰', interior_color: '黑', status: 'in_transit', quantity: 1 },
    { model: 'X3', trim: 'xDrive25L', exterior_color: '白', interior_color: '棕', status: 'in_stock', quantity: 2 },
    { model: 'X3', trim: 'xDrive30L', exterior_color: '黑', interior_color: '黑', status: 'in_stock', quantity: 1 },
    { model: '3 Series', trim: '325Li', exterior_color: '蓝', interior_color: '黑', status: 'in_stock', quantity: 1 },
  ],
  city: '杭州',
  province: '浙江',
};

function detection(partial: Partial<IntentDetection> & { intent: AutomotiveIntent }): IntentDetection {
  return {
    is_purchase_signal: true,
    evidence: [],
    transaction_questions: [],
    strength: 0,
    negative: false,
    engine: 'rules',
    ...partial,
  };
}

/**
 * Reference fixtures (ARCHITECTURE §5): post context "宝马i3现在值得买吗？", signals ≤3 days old, no IP.
 * Built exactly as the rules NLU is specified to output: brand/model inferred from the post title are
 * listed in `inferred_fields`; strength follows the stage anchors.
 */
const REF = {
  shuai: detection({
    is_purchase_signal: false,
    intent: {},
    evidence: [{ code: 'pure_praise', label: '纯夸赞，无购车意向', quote: '帅' }],
  }),
  rear: detection({
    intent: { brand: 'BMW', model: 'i3', purchase_stage: 'research', confidence: 0.6, inferred_fields: ['brand', 'model'] },
    evidence: [
      { code: 'research_question', label: '关注后排空间', quote: '后排空间怎么样' },
      { code: 'model_from_post_context', label: '车型来自帖子标题', quote: '宝马i3' },
    ],
    strength: STRENGTH_ANCHORS.research,
  }),
  discount: detection({
    intent: {
      brand: 'BMW',
      model: 'i3',
      discount_intent: true,
      price_sensitivity: 'high',
      purchase_stage: 'price_shopping',
      confidence: 0.75,
      inferred_fields: ['brand', 'model'],
    },
    evidence: [{ code: 'discount_intent', label: '询问优惠', quote: '优惠多少' }],
    transaction_questions: ['discount'],
    strength: STRENGTH_ANCHORS.price_shopping,
  }),
  i3Discount: detection({
    intent: {
      brand: 'BMW',
      model: 'i3',
      discount_intent: true,
      price_sensitivity: 'high',
      purchase_stage: 'price_shopping',
      confidence: 0.8,
      inferred_fields: ['brand'],
    },
    evidence: [
      { code: 'specified_model', label: '指定车型', quote: 'i3' },
      { code: 'discount_intent', label: '询问优惠', quote: '优惠多少' },
    ],
    transaction_questions: ['discount'],
    strength: STRENGTH_ANCHORS.price_shopping,
  }),
  landing: detection({
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
      { code: 'specified_trim', label: '指定配置', quote: '35L' },
      { code: 'landing_price_question', label: '询问落地价', quote: '落地多少' },
    ],
    transaction_questions: ['landing_price'],
    strength: STRENGTH_ANCHORS.active_shopping,
  }),
  visit: detection({
    intent: {
      brand: 'BMW',
      model: 'i3',
      trim: 'eDrive35L',
      location: '杭州',
      province: '浙江',
      inventory_intent: true,
      color_intent: '白外红内',
      visit_intent: true,
      purchase_timeframe: 'this_week',
      purchase_stage: 'purchase_imminent',
      confidence: 0.95,
      inferred_fields: ['brand'],
    },
    evidence: [
      { code: 'specified_location', label: '指定城市', quote: '杭州' },
      { code: 'specified_trim', label: '指定配置', quote: '35L' },
      { code: 'specified_color', label: '指定颜色', quote: '白外红内' },
      { code: 'inventory_intent', label: '询问现车', quote: '有现车吗' },
      { code: 'visit_intent', label: '本周想到店看车', quote: '这周想去看看' },
    ],
    transaction_questions: ['inventory', 'color_trim_availability', 'test_drive'],
    strength: STRENGTH_ANCHORS.purchase_imminent,
  }),
};

const score = (det: IntentDetection, signalAt = daysAgo(1), extra: Partial<Parameters<typeof scoreSignal>[0]> = {}) =>
  scoreSignal({ detection: det, signal_at: signalAt, now: NOW, dealer: PROFILE, ...extra }, CFG);

const comp = (components: ScoreComponent[], factor: string): ScoreComponent => {
  const c = components.find((x) => x.factor === factor);
  assert.ok(c, `component ${factor} missing`);
  return c;
};

const withIntent = (base: IntentDetection, intent: Partial<AutomotiveIntent>, rest: Partial<IntentDetection> = {}) =>
  detection({ ...base, ...rest, intent: { ...base.intent, ...intent } });

describe('lead-scoring: reference calibration table (ARCHITECTURE §5)', () => {
  it('"帅" scores 2 and never becomes a candidate', () => {
    const r = score(REF.shuai);
    assert.equal(r.score, 2);
    assert.ok(r.score < 10);
    assert.equal(r.tier, 'none');
    assert.equal(r.components.reduce((s, c) => s + c.points, 0), 2, 'components sum to the score');
    assert.match(comp(r.components, 'non_purchase_signal').reason, /非购车信号/);
  });

  it('"这车后排空间怎么样" is a weak candidate around 30', () => {
    const r = score(REF.rear);
    assert.ok(r.score >= 20 && r.score <= 45, `got ${r.score}`);
    assert.equal(r.score, 31, 'reference ≈30');
    assert.equal(r.tier, 'candidate');
    assert.equal(comp(r.components, 'model_match').points, 8, 'model inferred from post context');
    assert.equal(comp(r.components, 'transaction_questions').points, 0);
    assert.equal(comp(r.components, 'purchase_stage').points, 3);
    assert.equal(comp(r.components, 'inventory_match').points, 0, 'no stock question, trim or colour → no inventory points');
  });

  it('"现在优惠多少" is qualified (60–79)', () => {
    const r = score(REF.discount);
    assert.ok(r.score >= 60 && r.score <= 79, `got ${r.score}`);
    assert.equal(r.score, 65, 'reference ≈65');
    assert.equal(r.tier, 'qualified');
    assert.equal(comp(r.components, 'explicit_purchase_intent').points, 22);
    assert.equal(comp(r.components, 'transaction_questions').points, 12);
    assert.equal(comp(r.components, 'inventory_match').points, 0);
  });

  it('"现在i3优惠多少" scores at least as high as "现在优惠多少" and stays qualified', () => {
    const plain = score(REF.discount);
    const r = score(REF.i3Discount);
    assert.ok(r.score >= plain.score, `${r.score} < ${plain.score}`);
    assert.ok(r.score >= 60 && r.score <= 79, `got ${r.score}`);
    assert.equal(r.score, 69, 'reference ≈69');
    assert.equal(r.tier, 'qualified');
    assert.equal(comp(r.components, 'model_match').points, 12, 'model stated explicitly');
    assert.equal(comp(r.components, 'inventory_match').points, 0, 'a bare model mention is not an inventory request');
  });

  it('"杭州i3 35L落地多少" is high intent (85–97)', () => {
    const r = score(REF.landing);
    assert.ok(r.score >= 85 && r.score <= 97, `got ${r.score}`);
    assert.equal(r.tier, 'high_intent');
    assert.equal(r.score, 91);
    assert.equal(comp(r.components, 'location_match').points, 10);
    assert.equal(comp(r.components, 'inventory_match').points, 7, 'trim specified & in stock without inventory question');
  });

  it('"杭州i3 35L白外红内有现车吗？这周想去看看" is immediate (≥95)', () => {
    const r = score(REF.visit);
    assert.ok(r.score >= 95, `got ${r.score}`);
    assert.equal(r.tier, 'immediate');
    const inventory = comp(r.components, 'inventory_match');
    assert.equal(inventory.points, 10);
    assert.equal(inventory.reason, '询问现车且店内有白外红内 eDrive35L 现车');
    assert.equal(comp(r.components, 'transaction_questions').points, 15);
    assert.equal(comp(r.components, 'purchase_stage').points, 12);
  });

  it('keeps the table strictly ordered and every component explained and bounded', () => {
    const order = [REF.shuai, REF.rear, REF.discount, REF.i3Discount, REF.landing, REF.visit].map((d) => score(d));
    for (let i = 1; i < order.length; i++) assert.ok(order[i].score >= order[i - 1].score);
    for (const r of order) {
      assert.equal(
        r.components.reduce((s, c) => s + c.points, 0),
        r.score,
      );
      for (const c of r.components) {
        assert.ok(c.reason.length > 0 && /[一-龥]/.test(c.reason), `reason for ${c.factor} must be Chinese`);
        if (c.factor !== 'non_purchase_signal') assert.ok(c.points >= 0 && c.points <= c.max, `${c.factor} ${c.points}/${c.max}`);
      }
    }
  });

  it('negative signals use the non-purchase formula even when flagged as purchase', () => {
    const r = score(withIntent(REF.discount, {}, { negative: true }));
    assert.equal(r.score, 2);
    assert.equal(r.tier, 'none');
    assert.match(comp(r.components, 'non_purchase_signal').reason, /无意向|拒绝/);
  });
});

describe('lead-scoring: tierFor', () => {
  it('applies default threshold boundaries inclusively', () => {
    const cases: [number, string][] = [
      [0, 'none'],
      [19, 'none'],
      [19.99, 'none'],
      [20, 'candidate'],
      [59, 'candidate'],
      [60, 'qualified'],
      [79, 'qualified'],
      [80, 'high_intent'],
      [91, 'high_intent'],
      [92, 'immediate'],
      [100, 'immediate'],
    ];
    for (const [s, tier] of cases) assert.equal(tierFor(s, DEFAULT_THRESHOLDS), tier, `score ${s}`);
    assert.equal(tierFor(Number.NaN, DEFAULT_THRESHOLDS), 'none');
  });

  it('respects custom thresholds', () => {
    const t = { candidate: 10, qualified: 50, high_intent: 70, immediate: 85 };
    assert.equal(tierFor(9, t), 'none');
    assert.equal(tierFor(10, t), 'candidate');
    assert.equal(tierFor(69, t), 'qualified');
    assert.equal(tierFor(70, t), 'high_intent');
    assert.equal(tierFor(85, t), 'immediate');
  });
});

describe('lead-scoring: recency decay', () => {
  const recencyAt = (signalAt: string) => comp(score(REF.rear, signalAt).components, 'recency').points;

  it('awards bucket points at exact boundaries and decays just past them', () => {
    const minute = 60_000;
    assert.equal(recencyAt(NOW), 6);
    assert.equal(recencyAt(daysAgo(3)), 6);
    assert.equal(recencyAt(agoMs(3 * DAY_MS + minute)), 5);
    assert.equal(recencyAt(daysAgo(7)), 5);
    assert.equal(recencyAt(agoMs(7 * DAY_MS + minute)), 4);
    assert.equal(recencyAt(daysAgo(14)), 4);
    assert.equal(recencyAt(agoMs(14 * DAY_MS + minute)), 3);
    assert.equal(recencyAt(daysAgo(30)), 3);
    assert.equal(recencyAt(agoMs(30 * DAY_MS + minute)), 1);
    assert.equal(recencyAt(daysAgo(90)), 1);
    assert.equal(recencyAt(agoMs(90 * DAY_MS + minute)), 0);
    assert.equal(recencyAt(daysAgo(400)), 0);
  });

  it('treats future timestamps as fresh and invalid timestamps as zero', () => {
    assert.equal(recencyAt(new Date(Date.parse(NOW) + DAY_MS).toISOString()), 6);
    const invalid = comp(score(REF.rear, 'not-a-date').components, 'recency');
    assert.equal(invalid.points, 0);
    assert.match(invalid.reason, /无效/);
  });

  it('decays the whole signal score and the non-purchase formula', () => {
    assert.equal(score(REF.rear, daysAgo(1)).score - score(REF.rear, daysAgo(100)).score, 6);
    assert.equal(score(REF.shuai, daysAgo(100)).score, 1, 'round((0 + 4) × 0.2)');
  });
});

describe('lead-scoring: location matching', () => {
  const loc = (intent: Partial<AutomotiveIntent>, inferred: string[] = ['brand']) => {
    const base = withIntent(REF.landing, { location: undefined, province: undefined });
    const det = withIntent(base, { ...intent, inferred_fields: inferred });
    return comp(score(det).components, 'location_match');
  };

  it('stated city equal to dealer city → 10 (suffix tolerant)', () => {
    assert.equal(loc({ location: '杭州', province: '浙江' }).points, 10);
    assert.equal(loc({ location: '杭州市' }).points, 10);
  });

  it('stated province equal to dealer province → 6', () => {
    const c = loc({ location: '宁波', province: '浙江' });
    assert.equal(c.points, 6);
    assert.match(c.reason, /浙江/);
    assert.equal(loc({ province: '浙江省' }).points, 6);
  });

  it('IP 属地 province only → 5', () => {
    const c = loc({ province: '浙江' }, ['brand', 'province']);
    assert.equal(c.points, 5);
    assert.match(c.reason, /IP 属地/);
  });

  it('other province or no location → 0', () => {
    assert.equal(loc({ location: '上海', province: '上海' }).points, 0);
    assert.equal(loc({ province: '广东' }, ['brand', 'province']).points, 0);
    assert.equal(loc({}).points, 0);
    assert.equal(loc({ location: '杭州' }, ['brand', 'location']).points, 0, 'city inferred from post context is not stated');
  });
});

describe('lead-scoring: inventory matching', () => {
  const inv = (intent: Partial<AutomotiveIntent>, questions: IntentDetection['transaction_questions'] = [], inferred = ['brand']) => {
    const det = detection({
      intent: { brand: 'BMW', purchase_stage: 'active_shopping', inferred_fields: inferred, ...intent },
      transaction_questions: questions,
      strength: 1,
    });
    return comp(score(det).components, 'inventory_match');
  };

  it('asked & matching in_stock trim/colour → 10', () => {
    assert.equal(inv({ model: 'i3', trim: '35L', inventory_intent: true, color_intent: '白外红内' }, ['inventory']).points, 10);
    assert.equal(inv({ model: 'i3', inventory_intent: true, color_intent: '白色' }, ['inventory']).points, 10, '白色 matches 白');
    assert.equal(inv({ model: 'I3', trim: 'i3 35L', inventory_intent: true }, ['inventory']).points, 10, 'case-insensitive + alias');
  });

  it('asked & only in_transit → 7', () => {
    const c = inv({ model: 'i3', trim: 'eDrive40L', inventory_intent: true }, ['inventory']);
    assert.equal(c.points, 7);
    assert.match(c.reason, /在途/);
  });

  it('asked but dealer has none → 2', () => {
    assert.equal(inv({ model: 'i4', inventory_intent: true }, ['inventory']).points, 2, 'carried model without inventory');
    assert.equal(inv({ brand: 'Tesla', model: 'Model 3', inventory_intent: true }, ['inventory']).points, 2, 'model not carried');
  });

  it('asked with a spec the dealer lacks, but model in stock → 4', () => {
    const c = inv({ model: 'i3', trim: '35L', inventory_intent: true, color_intent: '蓝色' }, ['inventory']);
    assert.equal(c.points, 4);
    assert.match(c.reason, /其他现车/);
    assert.equal(inv({ model: 'i3', trim: '35L', inventory_intent: true, color_intent: '红外白内' }, ['inventory']).points, 4);
  });

  it('trim specified & in stock without an inventory question → 7', () => {
    assert.equal(inv({ model: 'X3', trim: '25L' }).points, 7);
    assert.equal(inv({ model: 'i3', trim: '35L', color_intent: '白外红内' }).points, 7, 'stated trim + colour in stock');
  });

  it('model in stock → 4 only as the fallback of an inventory-relevant request', () => {
    assert.equal(inv({ model: 'i3', trim: 'eDrive40L' }).points, 4, 'stated trim only in transit, other i3 in stock');
    const colour = inv({ model: 'i3', color_intent: '蓝色' });
    assert.equal(colour.points, 4, 'stated colour not in stock, model in stock');
    assert.match(colour.reason, /暂无完全匹配现车/);
    const bare = inv({ model: 'X3' });
    assert.equal(bare.points, 0, 'bare model mention without inventory context earns nothing');
    assert.match(bare.reason, /未询问库存/);
    assert.equal(inv({ model: 'i3', trim: 'eDrive35L' }, [], ['brand', 'trim']).points, 0, 'trim inferred, not specified');
    assert.equal(inv({ model: 'i3', color_intent: '白色' }, [], ['brand', 'color_intent']).points, 0, 'colour inferred');
  });

  it('no model and no question → 0; no stock and no question → 0', () => {
    assert.equal(inv({}).points, 0);
    assert.equal(inv({ model: 'i4' }).points, 0);
  });

  it('parses colour requests into exterior/interior parts and matches tolerantly', () => {
    assert.deepEqual(parseColorIntent('白外红内'), { exterior: '白', interior: '红' });
    assert.deepEqual(parseColorIntent('外白内红'), { exterior: '白', interior: '红' });
    assert.deepEqual(parseColorIntent('白色外观红色内饰'), { exterior: '白', interior: '红' });
    assert.deepEqual(parseColorIntent('白/红'), { exterior: '白', interior: '红' });
    assert.deepEqual(parseColorIntent('红色内饰'), { interior: '红' });
    assert.deepEqual(parseColorIntent('白色'), { exterior: '白' });
    assert.deepEqual(parseColorIntent(''), {});
    assert.deepEqual(parseColorIntent('内饰红色'), { interior: '红' }, 'marker before the colour');
    assert.deepEqual(parseColorIntent('外观白色'), { exterior: '白' });
    assert.deepEqual(parseColorIntent('外观白色内饰红色'), { exterior: '白', interior: '红' });
    assert.deepEqual(parseColorIntent('白色外观内饰红色'), { exterior: '白', interior: '红' });
    assert.deepEqual(parseColorIntent('外观白色，红色内饰'), { exterior: '白', interior: '红' });
    assert.deepEqual(parseColorIntent('白车红内饰'), { exterior: '白', interior: '红' });
    assert.deepEqual(parseColorIntent('白色车身红色内饰'), { exterior: '白', interior: '红' });
    assert.deepEqual(parseColorIntent('ＷＨＩＴＥ／ＲＥＤ'), { exterior: 'white', interior: 'red' }, 'full-width input');
    assert.equal(
      inv({ model: 'i3', trim: '35L', inventory_intent: true, color_intent: '内饰黑色' }, ['inventory']).points,
      10,
      'black interior 35L is in stock',
    );
    assert.equal(
      inv({ model: 'i3', trim: '35L', inventory_intent: true, color_intent: '内饰棕色' }, ['inventory']).points,
      4,
      'no brown-interior 35L: interior request must not be matched against the exterior colour',
    );
    assert.equal(colorMatches('白色', '白'), true);
    assert.equal(colorMatches('珍珠白', '白'), true);
    assert.equal(colorMatches('white', '白'), true);
    assert.equal(colorMatches('黑', '白'), false);
    assert.equal(colorMatches(undefined, '白'), true);
  });
});

describe('lead-scoring: model match, competitors and dealer relevance', () => {
  it('competitor post comparing with a carried model → model 6, relevance 3', () => {
    const det = detection({
      intent: { brand: 'Tesla', model: 'Model 3', competing_models: ['i3'], purchase_stage: 'comparison' },
      strength: STRENGTH_ANCHORS.comparison,
    });
    const r = score(det);
    assert.equal(comp(r.components, 'model_match').points, 6);
    assert.match(comp(r.components, 'model_match').reason, /i3/);
    assert.equal(comp(r.components, 'dealer_relevance').points, 3);
    assert.equal(comp(r.components, 'explicit_purchase_intent').points, 10);
    assert.equal(comp(r.components, 'purchase_stage').points, 5);
  });

  it('accepts brand-prefixed competing models but never confuses iX3 with X3', () => {
    const prefixed = detection({ intent: { brand: 'Tesla', model: 'Model Y', competing_models: ['BMW X3'], purchase_stage: 'comparison' } });
    assert.equal(comp(score(prefixed).components, 'model_match').points, 6);
    const ix3 = detection({ intent: { brand: 'Tesla', model: 'Model Y', competing_models: ['iX3'], purchase_stage: 'comparison' } });
    assert.equal(comp(score(ix3).components, 'model_match').points, 0);
    assert.equal(comp(score(ix3).components, 'dealer_relevance').points, 0);
  });

  it('carried model stated inside a comparison keeps the stated-model points', () => {
    const det = detection({
      intent: { brand: 'BMW', model: 'i3', competing_models: ['Model 3'], purchase_stage: 'comparison' },
      strength: STRENGTH_ANCHORS.comparison,
    });
    const r = score(det);
    assert.equal(comp(r.components, 'model_match').points, 12);
    assert.equal(comp(r.components, 'dealer_relevance').points, 5);
  });

  it('brand match only → 4; unrelated brand → 0; 3系 equals 3 Series', () => {
    const brandOnly = score(detection({ intent: { brand: '宝马', model: 'i7', purchase_stage: 'research' } }));
    assert.equal(comp(brandOnly.components, 'model_match').points, 4);
    assert.equal(comp(brandOnly.components, 'dealer_relevance').points, 5);
    const other = score(detection({ intent: { brand: 'BYD', model: 'Han', purchase_stage: 'research' } }));
    assert.equal(comp(other.components, 'model_match').points, 0);
    assert.equal(comp(other.components, 'dealer_relevance').points, 0);
    const series = score(detection({ intent: { model: '3系', purchase_stage: 'research' } }));
    assert.equal(comp(series.components, 'model_match').points, 12);
    assert.equal(comp(series.components, 'dealer_relevance').points, 5);
  });

  it('matches brands symmetrically when the dealer stores Chinese brand names', () => {
    const zhDealer: DealerProfile = { ...PROFILE, brands: ['宝马'] };
    const latin = scoreSignal(
      { detection: detection({ intent: { brand: 'BMW', model: 'i7', purchase_stage: 'research' } }), signal_at: daysAgo(1), now: NOW, dealer: zhDealer },
      CFG,
    );
    assert.equal(comp(latin.components, 'model_match').points, 4, 'brand-only match BMW ↔ 宝马');
    assert.equal(comp(latin.components, 'dealer_relevance').points, 5);
    const prefixed = scoreSignal(
      { detection: detection({ intent: { model: 'BMW i3', purchase_stage: 'research' } }), signal_at: daysAgo(1), now: NOW, dealer: zhDealer },
      CFG,
    );
    assert.equal(comp(prefixed.components, 'model_match').points, 12, 'Latin brand prefix stripped for a Chinese-named dealer');
    const fullwidth = score(detection({ intent: { brand: 'ＢＭＷ', model: '宝马ｉ３', purchase_stage: 'research' } }));
    assert.equal(comp(fullwidth.components, 'model_match').points, 12, 'full-width brand/model normalised');
  });
});

describe('lead-scoring: authenticity', () => {
  it('industry/marketing account scores 0, verified local user 5, default 4', () => {
    const base = score(REF.i3Discount);
    const industry = score(REF.i3Discount, daysAgo(1), { authenticity: { score: 0, reasons: ['疑似4S店销售账号'] } });
    const auth = comp(industry.components, 'authenticity');
    assert.equal(auth.points, 0);
    assert.equal(auth.reason, '疑似4S店销售账号');
    assert.equal(base.score - industry.score, 4);
    const verified = score(REF.i3Discount, daysAgo(1), { authenticity: { score: 5, reasons: [] } });
    assert.equal(comp(verified.components, 'authenticity').points, 5);
    assert.equal(comp(base.components, 'authenticity').points, 4);
  });

  it('derives authenticity from lead evidence codes', () => {
    assert.equal(authenticityFromEvidence([{ code: 'industry_account', label: '简介含"汽车销售"' }]).score, 0);
    assert.equal(authenticityFromEvidence([{ code: 'verified_local_user', label: '主页多次发布杭州生活' }]).score, 5);
    assert.equal(
      authenticityFromEvidence([
        { code: 'verified_local_user', label: '本地' },
        { code: 'industry_account', label: '车商' },
      ]).score,
      0,
      'industry evidence wins',
    );
    assert.equal(authenticityFromEvidence([{ code: 'inventory_intent', label: '询问现车' }]).score, 4);
    assert.equal(authenticityFromEvidence([]).score, 4);
  });
});

describe('lead-scoring: configurable weights', () => {
  it('scales rule points proportionally to customized maxima', () => {
    const weights = { ...DEFAULT_WEIGHTS, explicit_purchase_intent: 15, transaction_questions: 25 };
    const r = scoreSignal({ detection: REF.i3Discount, signal_at: daysAgo(1), now: NOW, dealer: PROFILE }, { weights, thresholds: DEFAULT_THRESHOLDS });
    const tq = comp(r.components, 'transaction_questions');
    assert.equal(tq.max, 25);
    assert.equal(tq.points, 20, '1 question = 12/15 of max');
    const explicit = comp(r.components, 'explicit_purchase_intent');
    assert.equal(explicit.max, 15);
    assert.equal(explicit.points, 13, 'round(0.88 × 15)');
    const visit = scoreSignal({ detection: REF.visit, signal_at: daysAgo(1), now: NOW, dealer: PROFILE }, { weights, thresholds: DEFAULT_THRESHOLDS });
    assert.equal(comp(visit.components, 'transaction_questions').points, 25, '≥2 questions = full max');
  });

  it('scales down weights that sum above 100 so the maximum total stays 100', () => {
    const doubled: typeof DEFAULT_WEIGHTS = { ...DEFAULT_WEIGHTS };
    for (const key of Object.keys(doubled) as (keyof typeof DEFAULT_WEIGHTS)[]) doubled[key] = DEFAULT_WEIGHTS[key] * 2;
    for (const det of Object.values(REF)) {
      const a = score(det);
      const b = scoreSignal({ detection: det, signal_at: daysAgo(1), now: NOW, dealer: PROFILE }, { weights: doubled, thresholds: DEFAULT_THRESHOLDS });
      assert.equal(b.score, a.score);
      assert.deepEqual(
        b.components.map((c) => [c.factor, c.max]),
        a.components.map((c) => [c.factor, c.max]),
      );
    }
    const heavy = { ...DEFAULT_WEIGHTS, transaction_questions: 35 };
    const r = scoreSignal({ detection: REF.visit, signal_at: daysAgo(1), now: NOW, dealer: PROFILE }, { weights: heavy, thresholds: DEFAULT_THRESHOLDS });
    assert.ok(r.score <= 100);
    // shares of 100 for weights summing to 120, apportioned by largest remainder
    assert.deepEqual(effectiveMaxima(heavy), {
      explicit_purchase_intent: 21,
      transaction_questions: 29,
      model_match: 10,
      inventory_match: 9,
      location_match: 8,
      purchase_stage: 10,
      recency: 5,
      authenticity: 4,
      dealer_relevance: 4,
    });
    assert.equal(comp(r.components, 'transaction_questions').max, 29);
    assert.equal(r.components.reduce((s, c) => s + c.max, 0), 100);
  });

  it('never lets a factor exceed its max and keeps components summing to the score under scaled weights', () => {
    const weights = {
      explicit_purchase_intent: 11.5,
      transaction_questions: 11.5,
      model_match: 11.5,
      inventory_match: 11.5,
      location_match: 11.5,
      purchase_stage: 11.5,
      recency: 11.5,
      authenticity: 8,
      dealer_relevance: 11.5,
    };
    const maxima = effectiveMaxima(weights);
    assert.ok(Object.values(maxima).every((m) => Number.isInteger(m)), 'integer maxima');
    assert.equal(Object.values(maxima).reduce((s, m) => s + m, 0), 100);
    for (const weightsCase of [weights, { ...weights, recency: 40 }, { ...DEFAULT_WEIGHTS, model_match: 12.4, recency: 6.3 }]) {
      for (const det of Object.values(REF)) {
        const r = scoreSignal(
          { detection: det, signal_at: daysAgo(0), now: NOW, dealer: PROFILE, authenticity: { score: 5, reasons: [] } },
          { weights: weightsCase, thresholds: DEFAULT_THRESHOLDS },
        );
        assert.ok(r.score >= 0 && r.score <= 100, `score ${r.score}`);
        assert.equal(r.components.reduce((s, c) => s + c.points, 0), r.score, 'components sum to the score');
        for (const c of r.components)
          if (c.factor !== 'non_purchase_signal') assert.ok(c.points <= c.max, `${c.factor} ${c.points}/${c.max}`);
      }
    }
    const full = scoreSignal(
      { detection: REF.visit, signal_at: daysAgo(0), now: NOW, dealer: PROFILE, authenticity: { score: 5, reasons: [] } },
      { weights, thresholds: DEFAULT_THRESHOLDS },
    );
    assert.equal(full.score, 100, 'a perfect signal still reaches exactly 100');
  });

  it('keeps integer weights summing to ≤ 100 untouched and floors fractional totals', () => {
    assert.deepEqual(effectiveMaxima(DEFAULT_WEIGHTS), { ...DEFAULT_WEIGHTS });
    const fractional = effectiveMaxima({
      explicit_purchase_intent: 11.1,
      transaction_questions: 11.1,
      model_match: 11.1,
      inventory_match: 11.1,
      location_match: 11.1,
      purchase_stage: 11.1,
      recency: 11.1,
      authenticity: 11.1,
      dealer_relevance: 11.1,
    });
    assert.equal(Object.values(fractional).reduce((s, m) => s + m, 0), 99, 'floor(99.9)');
    assert.ok(Object.values(fractional).every((m) => m === 11));
  });

  it('a zero weight removes the factor', () => {
    const weights = { ...DEFAULT_WEIGHTS, location_match: 0 };
    const r = scoreSignal({ detection: REF.landing, signal_at: daysAgo(1), now: NOW, dealer: PROFILE }, { weights, thresholds: DEFAULT_THRESHOLDS });
    const c = comp(r.components, 'location_match');
    assert.equal(c.points, 0);
    assert.equal(c.max, 0);
    assert.equal(r.score, 81);
  });
});

describe('lead-scoring: signal reconstruction from stored rows', () => {
  it('reads tq: evidence codes, plain transaction codes and derives strength from stage anchors', () => {
    const det = detectionFromSignal({
      intent: REF.visit.intent,
      evidence: [
        ...REF.visit.evidence,
        { code: 'tq:inventory', label: '询问现车' },
        { code: 'tq:color_trim_availability', label: '指定颜色' },
        { code: 'test_drive', label: '到店看车' },
        { code: 'tq:not_a_question', label: '无效' },
      ],
      engine: 'rules',
    });
    assert.deepEqual(det.transaction_questions, ['inventory', 'color_trim_availability', 'test_drive']);
    assert.equal(det.strength, 1);
    assert.equal(det.is_purchase_signal, true);
    assert.equal(det.negative, false);
    assert.equal(score(det).score, score(REF.visit).score);
  });

  it('honours stored strength and derives questions from intent flags when no codes are stored', () => {
    const det = detectionFromSignal({
      intent: { model: 'i3', price_intent: true, financing_intent: true, purchase_stage: 'price_shopping' },
      evidence: [{ code: 'strength:0.5', label: '意向强度' }],
      engine: 'llm+rules',
    });
    assert.deepEqual(det.transaction_questions, ['price', 'finance']);
    assert.equal(det.strength, 0.5);
    assert.equal(det.engine, 'llm+rules');
    const anchored = detectionFromSignal({ intent: { purchase_stage: 'price_shopping' }, evidence: [], engine: 'rules' });
    assert.equal(anchored.strength, 0.88);
  });

  it('marks negative and empty signals as non-purchase', () => {
    const negative = detectionFromSignal({
      intent: { model: 'i3', purchase_stage: 'research' },
      evidence: [{ code: 'not_interested', label: '不需要', quote: '不需要' }],
      engine: 'rules',
    });
    assert.equal(negative.negative, true);
    assert.equal(negative.is_purchase_signal, false);
    const empty = detectionFromSignal({ intent: {}, evidence: [], engine: 'rules' });
    assert.equal(empty.is_purchase_signal, false);
    assert.equal(empty.strength, 0);
    assert.equal(score(empty).score, 2);
  });
});
