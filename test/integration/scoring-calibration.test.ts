/**
 * Wave A integration gate — scoring calibration (ARCHITECTURE.md §5).
 *
 * Runs the REAL pipeline end to end on the canonical dealer fixture:
 *   Dealer Brain (A1) → DealerProfile → prefilter + rule intent detection (A3) → scoreSignal (A5)
 * and asserts the binding reference table, tier boundaries, ordering and a few negative cases.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isVerbatimQuote } from '../../src/core/evidence.ts';
import { DAY_MS } from '../../src/core/time.ts';
import type { DealerProfile, IntentDetection, PrefilterResult, ScoreComponent, ScoreTier, ScoringConfig, SignalContext } from '../../src/core/types.ts';
import { detectIntentRules, prefilter } from '../../src/skills/acquisition/intent-detection/nlu.ts';
import {
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  detectionFromSignal,
  getScoringConfig,
  scoreSignal,
  tierFor,
} from '../../src/skills/acquisition/lead-scoring/index.ts';
import { getDealerProfile } from '../../src/skills/operations/dealer-brain/index.ts';
import { createTestContext } from '../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../helpers/fixtures.ts';

const POST_TITLE = '宝马i3现在值得买吗？';
const REFERENCE_CONTEXT: SignalContext = { source_type: 'comment', post_title: POST_TITLE };

interface Evaluation {
  text: string;
  prefilter: PrefilterResult;
  detection: IntentDetection;
  score: number;
  tier: ScoreTier;
  components: ScoreComponent[];
}

interface Harness {
  profile: DealerProfile;
  shProfile: DealerProfile;
  cfg: ScoringConfig;
  now: string;
  signalAt: string;
  evaluate(text: string, opts?: { context?: SignalContext; dealer?: DealerProfile; signalAt?: string }): Evaluation;
}

function setup(): Harness {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  const dealerId = dealerIdByKey(summary, 'hz-bmw');
  const profile = getDealerProfile(ctx, dealerId);
  const shProfile = getDealerProfile(ctx, dealerIdByKey(summary, 'sh-bmw'));
  const cfg = getScoringConfig(ctx, dealerId);
  const now = ctx.clock.iso();
  const signalAt = new Date(ctx.clock.now().getTime() - DAY_MS).toISOString();
  return {
    profile,
    shProfile,
    cfg,
    now,
    signalAt,
    evaluate(text, opts = {}) {
      const context = opts.context ?? REFERENCE_CONTEXT;
      const dealer = opts.dealer ?? profile;
      const pf = prefilter(text, context);
      const detection = detectIntentRules(text, context, dealer);
      const scored = scoreSignal({ detection, signal_at: opts.signalAt ?? signalAt, now, dealer }, cfg);
      return { text, prefilter: pf, detection, ...scored };
    },
  };
}

function component(ev: Evaluation, factor: string): ScoreComponent {
  const c = ev.components.find((x) => x.factor === factor);
  assert.ok(c, `"${ev.text}" has no ${factor} component (got ${ev.components.map((x) => x.factor).join(', ')})`);
  return c;
}

const REFERENCE = [
  { text: '帅', min: 2, max: 2, tier: 'none', purchase: false },
  { text: '这车后排空间怎么样', min: 20, max: 45, tier: 'candidate', purchase: true },
  { text: '现在优惠多少', min: 60, max: 79, tier: 'qualified', purchase: true },
  { text: '现在i3优惠多少', min: 60, max: 79, tier: 'qualified', purchase: true },
  { text: '杭州i3 35L落地多少', min: 85, max: 97, tier: 'high_intent', purchase: true },
  { text: '杭州i3 35L白外红内有现车吗？这周想去看看', min: 95, max: 100, tier: 'immediate', purchase: true },
] as const satisfies readonly { text: string; min: number; max: number; tier: ScoreTier; purchase: boolean }[];

describe('integration: scoring calibration on the canonical dealer fixture (§5)', () => {
  const h = setup();

  it('uses the fixture dealer profile the reference table assumes (杭州 BMW, white/red i3 eDrive35L in stock)', () => {
    assert.equal(h.profile.city, '杭州');
    assert.equal(h.profile.province, '浙江');
    assert.ok(h.profile.brands.includes('BMW'));
    assert.ok(h.profile.models.includes('i3'));
    assert.ok(
      h.profile.inventory.some(
        (row) => row.model === 'i3' && row.trim === 'eDrive35L' && row.exterior_color === '白' && row.interior_color === '红' && row.status === 'in_stock' && row.quantity > 0,
      ),
      'white/red i3 eDrive35L must be in stock',
    );
    assert.ok(h.profile.trims.some((t) => t.model === 'i3' && t.trim === 'eDrive35L' && t.aliases.includes('35L')));
    assert.equal(h.cfg.version, 1);
    assert.equal(h.cfg.active, true);
    assert.deepEqual({ ...h.cfg.weights }, { ...DEFAULT_WEIGHTS });
    assert.deepEqual({ ...h.cfg.thresholds }, { ...DEFAULT_THRESHOLDS });
    assert.deepEqual({ ...h.cfg.thresholds }, { candidate: 20, qualified: 60, high_intent: 80, immediate: 92 });
  });

  for (const ref of REFERENCE) {
    it(`"${ref.text}" scores ${ref.min === ref.max ? ref.min : `${ref.min}–${ref.max}`} → ${ref.tier}`, () => {
      const ev = h.evaluate(ref.text);
      assert.ok(ev.score >= ref.min && ev.score <= ref.max, `"${ref.text}" scored ${ev.score}, expected ${ref.min}–${ref.max}`);
      assert.equal(ev.tier, ref.tier);
      assert.equal(ev.tier, tierFor(ev.score, h.cfg.thresholds), 'tier must follow the dealer thresholds');
      assert.equal(ev.detection.is_purchase_signal, ref.purchase);
      assert.equal(ev.prefilter.passed, ref.purchase, `prefilter outcome for "${ref.text}"`);
      assert.equal(ev.prefilter.is_marketing, false);
      assert.equal(ev.detection.negative, false);

      // the breakdown shown to salespeople always adds up and never exceeds a factor maximum
      assert.equal(ev.components.reduce((sum, c) => sum + c.points, 0), ev.score);
      for (const c of ev.components) assert.ok(c.points <= c.max, `${c.factor} ${c.points} > max ${c.max}`);

      // every quote is verbatim from the comment or the post context (evidence preservation, spec §7)
      for (const e of ev.detection.evidence) {
        if (e.quote) assert.ok(isVerbatimQuote([ref.text, POST_TITLE], e.quote), `non-verbatim quote ${JSON.stringify(e)}`);
      }
      if (ref.purchase) assert.ok(ev.detection.evidence.length > 0, 'purchase signals must carry evidence');
    });
  }

  it('orders the reference comments strictly: 帅 < 后排 < 优惠 ≤ i3优惠 < 落地 < 现车', () => {
    const [shuai, rear, discount, i3Discount, landing, stock] = REFERENCE.map((r) => h.evaluate(r.text).score);
    assert.ok(shuai < rear, `帅 ${shuai} < 后排 ${rear}`);
    assert.ok(rear < discount, `后排 ${rear} < 优惠 ${discount}`);
    assert.ok(discount <= i3Discount, `优惠 ${discount} ≤ i3优惠 ${i3Discount}`);
    assert.ok(i3Discount < landing, `i3优惠 ${i3Discount} < 落地 ${landing}`);
    assert.ok(landing < stock, `落地 ${landing} < 现车 ${stock}`);
  });

  it('applies the §5 factor rules the reference values depend on', () => {
    const shuai = h.evaluate('帅');
    // non-purchase formula: round((recency 6 + authenticity 4) × 0.2) = 2
    assert.equal(component(shuai, 'recency').points, 6);
    assert.equal(component(shuai, 'authenticity').points, 4);

    const rear = h.evaluate('这车后排空间怎么样');
    assert.equal(rear.detection.intent.purchase_stage, 'research');
    assert.equal(rear.detection.strength, 0.2);
    assert.equal(component(rear, 'model_match').points, 8, 'model inferred from post context');
    assert.equal(component(rear, 'transaction_questions').points, 0);

    const discount = h.evaluate('现在优惠多少');
    assert.equal(discount.detection.intent.purchase_stage, 'price_shopping');
    assert.deepEqual(discount.detection.transaction_questions, ['discount']);
    assert.equal(component(discount, 'model_match').points, 8, 'model inferred from post context');
    assert.equal(component(discount, 'transaction_questions').points, 12);

    const i3Discount = h.evaluate('现在i3优惠多少');
    assert.equal(component(i3Discount, 'model_match').points, 12, 'model stated & carried');

    const landing = h.evaluate('杭州i3 35L落地多少');
    assert.equal(landing.detection.intent.location, '杭州');
    assert.equal(landing.detection.intent.trim, 'eDrive35L');
    assert.ok(landing.detection.transaction_questions.includes('landing_price'));
    assert.equal(component(landing, 'location_match').points, 10, 'stated city = dealer city');
    assert.equal(component(landing, 'inventory_match').points, 7, 'trim specified & in stock without an inventory question');

    const stock = h.evaluate('杭州i3 35L白外红内有现车吗？这周想去看看');
    assert.equal(stock.detection.intent.inventory_intent, true);
    assert.ok(stock.detection.transaction_questions.length >= 2);
    assert.equal(stock.detection.strength, 1);
    assert.equal(component(stock, 'explicit_purchase_intent').points, 25);
    assert.equal(component(stock, 'transaction_questions').points, 15);
    assert.equal(component(stock, 'inventory_match').points, 10, 'white/red eDrive35L in stock');
    assert.equal(component(stock, 'location_match').points, 10);
    assert.equal(component(stock, 'dealer_relevance').points, 5);
  });

  it('scores stored signals exactly like live detections (A3 evidence codes ↔ A5 reconstruction)', () => {
    for (const ref of REFERENCE) {
      const ev = h.evaluate(ref.text);
      const rebuilt = detectionFromSignal({ intent: ev.detection.intent, evidence: ev.detection.evidence, engine: ev.detection.engine });
      const stored = scoreSignal({ detection: rebuilt, signal_at: h.signalAt, now: h.now, dealer: h.profile }, h.cfg);
      assert.equal(stored.score, ev.score, `"${ref.text}" live ${ev.score} vs stored ${stored.score}`);
      assert.equal(stored.tier, ev.tier);
    }
  });

  it('keeps the PRODUCT_SPEC §6/§9 example phrasings in the same intent bands', () => {
    assert.ok(h.evaluate('这车后排怎么样').tier === 'candidate');
    assert.ok(['qualified', 'high_intent'].includes(h.evaluate('现在优惠多少').tier));
    assert.ok(h.evaluate('杭州35L现在落地多少').score >= h.cfg.thresholds.high_intent);
    assert.ok(h.evaluate('杭州i3 35L现在落地多少').score >= h.cfg.thresholds.high_intent);
    assert.ok(h.evaluate('杭州白外红内有现车吗？').score >= h.cfg.thresholds.high_intent);
    assert.equal(h.evaluate('杭州i3 35L白色有现车吗？这周想去看看').tier, 'immediate');
  });

  it('never lets a competitor salesperson comment reach candidate', () => {
    const text = '宝马i3底价私信我，杭州4S店销售';
    const ev = h.evaluate(text);
    assert.equal(ev.prefilter.is_marketing, true);
    assert.equal(ev.prefilter.passed, false);
    assert.equal(ev.prefilter.reason, 'marketing_account');
    assert.equal(ev.detection.is_purchase_signal, false);
    assert.equal(ev.detection.transaction_questions.length, 0);
    assert.ok(ev.detection.evidence.some((e) => e.code === 'marketing_account'));
    assert.ok(ev.score < h.cfg.thresholds.candidate, `marketing comment scored ${ev.score}`);
    assert.equal(ev.tier, 'none');

    // most favourable conditions (fresh, local IP, no post context) still stay below candidate
    const favourable = h.evaluate(text, {
      context: { source_type: 'comment', ip_location: '浙江' },
      signalAt: h.now,
    });
    assert.equal(favourable.detection.is_purchase_signal, false);
    assert.ok(favourable.score < h.cfg.thresholds.candidate, `marketing comment scored ${favourable.score}`);

    // stored as a lead signal it is still recognised as a non-purchase signal
    const rebuilt = detectionFromSignal({ intent: ev.detection.intent, evidence: ev.detection.evidence, engine: ev.detection.engine });
    assert.equal(rebuilt.is_purchase_signal, false);
    assert.ok(scoreSignal({ detection: rebuilt, signal_at: h.signalAt, now: h.now, dealer: h.profile }, h.cfg).score < h.cfg.thresholds.candidate);
  });

  // Expectation changed by ARCHITECTURE §5.2 (docs/PREVIEW_FINDINGS.md F3). Before §5.2 the 深圳 question only lost
  // its 10 location points and stayed high_intent (81) for 杭州宝马中心; an EXPLICITLY out-of-area buyer is now capped
  // at qualified − 1 for this dealer, with an out_of_area_cap component so the breakdown still sums to the score.
  it('caps an explicitly out-of-area buyer (深圳) below qualified with a visible out_of_area_cap component (§5.2)', () => {
    const hz = h.evaluate('杭州i3 35L落地多少');
    const sz = h.evaluate('深圳i3 35L落地多少');
    assert.equal(sz.detection.is_purchase_signal, true, 'still a purchase signal — just not for this dealer');
    assert.equal(sz.detection.intent.location, '深圳');
    assert.equal(component(sz, 'location_match').points, 0);
    const uncapped = hz.score - component(hz, 'location_match').points; // same question without location points
    assert.ok(uncapped >= h.cfg.thresholds.qualified, `uncapped ${uncapped} would be qualified`);
    const cap = component(sz, 'out_of_area_cap');
    assert.equal(sz.score, h.cfg.thresholds.qualified - 1);
    assert.equal(cap.points, sz.score - uncapped);
    assert.equal(cap.max, 0);
    assert.match(cap.reason, /^异地买家（深圳），不在本店服务范围/);
    assert.equal(sz.tier, 'candidate');
    assert.equal(sz.components.reduce((s, c) => s + c.points, 0), sz.score);

    // IP 属地 alone is never capped (noisy) and earns no location points
    const ipOnly = h.evaluate('i3 35L落地多少', { context: { ...REFERENCE_CONTEXT, ip_location: '广东' } });
    assert.ok(!ipOnly.components.some((c) => c.factor === 'out_of_area_cap'));
    assert.equal(component(ipOnly, 'location_match').points, 0);
    assert.equal(ipOnly.score, uncapped);
  });

  it('scores the same 杭州 question lower for the 上海 dealer (dealer-relative location & inventory)', () => {
    const forHz = h.evaluate('杭州i3 35L落地多少');
    const forSh = h.evaluate('杭州i3 35L落地多少', { dealer: h.shProfile });
    assert.equal(component(forSh, 'location_match').points, 0);
    assert.ok(forSh.score < forHz.score, `上海 ${forSh.score} must be < 杭州 ${forHz.score}`);
  });

  it('decays with recency: the immediate-tier comment 100 days old loses its recency points', () => {
    const fresh = h.evaluate('杭州i3 35L白外红内有现车吗？这周想去看看');
    const old = h.evaluate('杭州i3 35L白外红内有现车吗？这周想去看看', {
      signalAt: new Date(Date.parse(h.now) - 100 * DAY_MS).toISOString(),
    });
    assert.equal(component(old, 'recency').points, 0);
    assert.equal(fresh.score - old.score, component(fresh, 'recency').points);
  });
});
