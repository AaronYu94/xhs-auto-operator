/**
 * Signal-quality rules of lead scoring: out-of-area cap (ARCHITECTURE §5.2), non-buyer author roles (§5.1) and
 * migration-v2 stored-signal columns (§8 A5 detectionFromSignal).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AutomotiveIntent, DealerProfile, IntentDetection, ScoreComponent } from '../../../src/core/types.ts';
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  OUT_OF_AREA_FACTOR,
  STRENGTH_ANCHORS,
  detectionFromSignal,
  isLegacySignalRow,
  scoreSignal,
  statedAreaMatch,
} from '../../../src/skills/acquisition/lead-scoring/index.ts';

const NOW = '2026-09-12T02:00:00.000Z';
const DAY_MS = 86_400_000;
const ONE_DAY_AGO = new Date(Date.parse(NOW) - DAY_MS).toISOString();
const CFG = { weights: DEFAULT_WEIGHTS, thresholds: DEFAULT_THRESHOLDS };

const PROFILE: DealerProfile = {
  dealer_id: 'dlr_hz_bmw',
  brands: ['BMW'],
  models: ['i3', 'X3', '3 Series'],
  trims: [{ model: 'i3', trim: 'eDrive35L', aliases: ['35L', 'i3 35L'] }],
  inventory: [{ model: 'i3', trim: 'eDrive35L', exterior_color: '白', interior_color: '红', status: 'in_stock', quantity: 1 }],
  city: '杭州',
  province: '浙江',
};

function detection(intent: AutomotiveIntent, rest: Partial<IntentDetection> = {}): IntentDetection {
  return { is_purchase_signal: true, intent, evidence: [], transaction_questions: [], strength: 0, negative: false, engine: 'rules', ...rest };
}

/** "<city>i3 35L落地多少" as the rules NLU outputs it (brand inferred, trim + city stated). */
const landing = (place: Partial<AutomotiveIntent>, inferred: string[] = ['brand']) =>
  detection(
    { brand: 'BMW', model: 'i3', trim: 'eDrive35L', price_intent: true, purchase_stage: 'active_shopping', inferred_fields: inferred, ...place },
    { transaction_questions: ['landing_price'], strength: 1 },
  );
const rear = (place: Partial<AutomotiveIntent>) =>
  detection({ brand: 'BMW', model: 'i3', purchase_stage: 'research', inferred_fields: ['brand', 'model'], ...place }, { strength: STRENGTH_ANCHORS.research });

const score = (det: IntentDetection, extra: { dealer?: DealerProfile; cfg?: typeof CFG } = {}) =>
  scoreSignal({ detection: det, signal_at: ONE_DAY_AGO, now: NOW, dealer: extra.dealer ?? PROFILE }, extra.cfg ?? CFG);
const find = (components: ScoreComponent[], factor: string) => components.find((c) => c.factor === factor);
const sum = (components: ScoreComponent[]) => components.reduce((s, c) => s + c.points, 0);

describe('lead-scoring: out-of-area cap (ARCHITECTURE §5.2)', () => {
  it('caps an explicitly stated other-province city at qualified − 1 with a negative component', () => {
    const local = score(landing({ location: '杭州', province: '浙江' }));
    assert.equal(local.score, 91);
    const r = score(landing({ location: '深圳', province: '广东' }));
    const cap = find(r.components, OUT_OF_AREA_FACTOR);
    assert.ok(cap);
    assert.equal(r.score, 59);
    assert.equal(cap.points, 59 - 81, 'raw score 81 (no location points) capped to 59');
    assert.equal(cap.max, 0);
    assert.equal(cap.reason, '异地买家（深圳），不在本店服务范围，得分封顶 59');
    assert.equal(r.tier, 'candidate');
    assert.equal(sum(r.components), r.score, 'components still sum to the score');
  });

  it('applies to a stated province, and to a city whose province is resolved from the lexicon', () => {
    const province = score(landing({ province: '广东' }));
    assert.equal(province.score, 59);
    assert.match(find(province.components, OUT_OF_AREA_FACTOR)!.reason, /异地买家（广东）/);
    const cityOnly = score(landing({ location: '上海' }));
    assert.equal(cityOnly.score, 59);
  });

  it('never caps IP 属地 alone, the same province, the dealer city or an unknown place', () => {
    const ip = score(landing({ province: '广东' }, ['brand', 'province']));
    assert.equal(find(ip.components, OUT_OF_AREA_FACTOR), undefined);
    assert.equal(ip.score, 81, 'no location points, no cap');
    const sameProvince = score(landing({ location: '宁波', province: '浙江' }));
    assert.equal(find(sameProvince.components, OUT_OF_AREA_FACTOR), undefined);
    assert.equal(sameProvince.score, 87);
    assert.equal(find(score(landing({ location: '杭州市' })).components, OUT_OF_AREA_FACTOR), undefined);
    assert.equal(find(score(landing({ location: '火星' })).components, OUT_OF_AREA_FACTOR), undefined);
    assert.equal(find(score(landing({ location: '深圳', province: '广东' }), { dealer: { ...PROFILE, province: '' } }).components, OUT_OF_AREA_FACTOR), undefined);
  });

  it('emits a zero adjustment when the raw score is already below the cap, and none for non-signals', () => {
    const weak = score(rear({ location: '深圳', province: '广东' }));
    const cap = find(weak.components, OUT_OF_AREA_FACTOR);
    assert.ok(cap);
    assert.equal(cap.points, 0);
    assert.equal(cap.reason, '异地买家（深圳），不在本店服务范围');
    assert.equal(weak.score, 31);
    const nonSignal = score(detection({ location: '深圳', province: '广东' }, { is_purchase_signal: false }));
    assert.equal(find(nonSignal.components, OUT_OF_AREA_FACTOR), undefined);
    assert.equal(nonSignal.score, 2);
  });

  it('follows the dealer’s configured qualified threshold', () => {
    const r = score(landing({ location: '深圳', province: '广东' }), { cfg: { weights: DEFAULT_WEIGHTS, thresholds: { ...DEFAULT_THRESHOLDS, qualified: 70 } } });
    assert.equal(r.score, 69);
    assert.equal(sum(r.components), 69);
  });

  it('exposes the stated-area comparison', () => {
    assert.deepEqual(statedAreaMatch({ location: '宁波', province: '浙江' }, PROFILE), { match: 'in_area', place: '宁波' });
    assert.deepEqual(statedAreaMatch({ location: '深圳', province: '广东' }, PROFILE), { match: 'out_of_area', place: '深圳' });
    assert.deepEqual(statedAreaMatch({ province: '广东', inferred_fields: ['province'] }, PROFILE), { match: 'unstated' });
    assert.deepEqual(statedAreaMatch({}, PROFILE), { match: 'unstated' });
  });
});

describe('lead-scoring: non-buyer author roles (ARCHITECTURE §5.1)', () => {
  const buyer = landing({ location: '杭州', province: '浙江' });

  it('scores owners, creators and marketing accounts with the non-signal formula, even if flagged as purchase', () => {
    const cases: [Partial<IntentDetection>, RegExp][] = [
      [{ author_role: 'owner' }, /已购车车主/],
      [{ author_role: 'creator' }, /内容创作/],
      [{ author_role: 'marketing' }, /营销\/同行销售账号/],
      [{ is_marketing: true }, /营销\/同行销售账号/],
    ];
    for (const [rest, reason] of cases) {
      const r = score({ ...buyer, ...rest });
      assert.equal(r.score, 2, JSON.stringify(rest));
      assert.equal(r.tier, 'none');
      assert.match(find(r.components, 'non_purchase_signal')!.reason, reason);
      assert.equal(sum(r.components), 2);
    }
    assert.equal(score({ ...buyer, author_role: 'asker' }).score, 91, 'askers are scored normally');
  });
});

describe('lead-scoring: migration-v2 stored-signal columns', () => {
  const visitIntent: AutomotiveIntent = {
    brand: 'BMW',
    model: 'i3',
    trim: 'eDrive35L',
    location: '杭州',
    province: '浙江',
    inventory_intent: true,
    color_intent: '白外红内',
    visit_intent: true,
    purchase_stage: 'purchase_imminent',
    inferred_fields: ['brand'],
  };

  it('detects legacy rows by their v2 default values', () => {
    const base = { intent: {}, evidence: [], engine: 'rules' as const };
    assert.equal(isLegacySignalRow(base), true, 'no v2 fields at all');
    assert.equal(isLegacySignalRow({ ...base, is_purchase_signal: true, strength: 0, transaction_questions: [], author_role: null }), true);
    assert.equal(isLegacySignalRow({ ...base, strength: 0.2 }), false);
    assert.equal(isLegacySignalRow({ ...base, transaction_questions: ['price'] }), false);
    assert.equal(isLegacySignalRow({ ...base, is_purchase_signal: false }), false, 'the migration default is 1: false is v2-written');
    assert.equal(isLegacySignalRow({ ...base, author_role: 'asker' }), false);
  });

  it('prefers the columns over evidence conventions', () => {
    const det = detectionFromSignal({
      intent: visitIntent,
      evidence: [{ code: 'tq:price', label: '询问价格' }],
      engine: 'rules',
      is_purchase_signal: true,
      strength: 1,
      transaction_questions: ['inventory', 'color_trim_availability', 'test_drive', 'bogus' as never],
      author_role: 'asker',
    });
    assert.deepEqual(det.transaction_questions, ['inventory', 'color_trim_availability', 'test_drive']);
    assert.equal(det.author_role, 'asker');
    assert.equal(det.is_purchase_signal, true);
    assert.equal(score(det).score, 99);

    const strength = detectionFromSignal({ intent: { ...visitIntent, purchase_stage: 'price_shopping' }, evidence: [], engine: 'rules', strength: 0.5, transaction_questions: ['price'], is_purchase_signal: true, author_role: 'asker' });
    assert.equal(strength.strength, 0.5, 'stored strength wins over the stage anchor');
    const anchored = detectionFromSignal({ intent: { purchase_stage: 'price_shopping' }, evidence: [], engine: 'rules', strength: 0, transaction_questions: ['price'], is_purchase_signal: true, author_role: null });
    assert.equal(anchored.strength, 0.88, 'a v2 row without strength falls back to the anchor');
  });

  it('honours is_purchase_signal=false, non-buyer roles and negative evidence on v2 rows', () => {
    const creator = detectionFromSignal({
      intent: { brand: 'BMW', model: 'i3', purchase_stage: 'active_shopping', price_intent: true },
      evidence: [{ code: 'landing_price', label: '询问落地价' }],
      engine: 'rules',
      is_purchase_signal: false,
      strength: 0,
      transaction_questions: [],
      author_role: 'creator',
    });
    assert.equal(creator.is_purchase_signal, false);
    assert.equal(creator.strength, 0);
    assert.equal(score(creator).score, 2);

    const inconsistentOwner = detectionFromSignal({ intent: visitIntent, evidence: [], engine: 'rules', is_purchase_signal: true, strength: 1, transaction_questions: ['inventory'], author_role: 'owner' });
    assert.equal(inconsistentOwner.is_purchase_signal, false, 'an owner row is never a purchase signal');
    const negative = detectionFromSignal({ intent: visitIntent, evidence: [{ code: 'not_interested', label: '不需要' }], engine: 'rules', is_purchase_signal: true, strength: 1, transaction_questions: ['inventory'], author_role: 'asker' });
    assert.equal(negative.negative, true);
    assert.equal(negative.is_purchase_signal, false);
  });

  it('reads role codes from legacy rows', () => {
    const legacy = (code: string) =>
      detectionFromSignal({ intent: { model: 'i3', purchase_stage: 'research' }, evidence: [{ code, label: code }], engine: 'rules', is_purchase_signal: true, strength: 0, transaction_questions: [], author_role: null });
    assert.equal(legacy('content_creator').is_purchase_signal, false);
    assert.equal(legacy('content_creator').author_role, 'creator');
    assert.equal(legacy('already_purchased').author_role, 'owner');
    assert.equal(legacy('marketing_account').is_marketing, true);
    assert.equal(legacy('product_research').is_purchase_signal, true, 'plain legacy research row stays a signal');
  });
});
