import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isVerbatimQuote } from '../../../src/core/evidence.ts';
import type { DealerProfile, IntentDetection, PurchaseStage, SignalContext } from '../../../src/core/types.ts';
import {
  STAGE_STRENGTH,
  analyzeSignal,
  analyzedTextFor,
  detectIntentRules,
  isPurePraise,
  prefilter,
} from '../../../src/skills/acquisition/intent-detection/nlu.ts';

/** Hand-built Hangzhou BMW profile matching the fixture canon (ARCHITECTURE §9). */
export const HZ_BMW: DealerProfile = {
  dealer_id: 'dlr_hz_bmw',
  brands: ['BMW'],
  models: ['i3', 'X3', '3 Series'],
  trims: [
    { model: 'i3', trim: 'eDrive35L', aliases: ['35L', 'i3 35L'] },
    { model: 'i3', trim: 'eDrive40L', aliases: ['40L', 'i3 40L'] },
    { model: 'X3', trim: 'xDrive25L', aliases: ['25L'] },
    { model: 'X3', trim: 'xDrive30L', aliases: ['30L'] },
    { model: '3 Series', trim: '325Li', aliases: ['325Li'] },
  ],
  inventory: [
    { model: 'i3', trim: 'eDrive35L', exterior_color: '白', interior_color: '红', status: 'in_stock', quantity: 1 },
    { model: 'i3', trim: 'eDrive35L', exterior_color: '黑', interior_color: '黑', status: 'in_stock', quantity: 2 },
    { model: 'i3', trim: 'eDrive40L', exterior_color: '灰', interior_color: '黑', status: 'in_transit', quantity: 1 },
    { model: 'X3', trim: 'xDrive25L', exterior_color: '白', interior_color: '棕', status: 'in_stock', quantity: 2 },
    { model: '3 Series', trim: '325Li', exterior_color: '蓝', interior_color: '黑', status: 'in_stock', quantity: 1 },
  ],
  city: '杭州',
  province: '浙江',
};

const I3_POST: SignalContext = { source_type: 'comment', post_title: '宝马i3现在值得买吗？' };

/**
 * Reference implementation of the ARCHITECTURE §5 scoring formula (signal ≤3 days old, default authenticity),
 * used as an oracle to prove the detection outputs land in the binding score bands.
 */
function referenceScore(d: IntentDetection, dealer: DealerProfile): number {
  const recency = 6;
  const authenticity = d.evidence.some((e) => e.code === 'marketing_account') ? 0 : 4;
  if (!d.is_purchase_signal) return Math.round((recency + authenticity) * 0.2);
  const i = d.intent;
  const inferred = i.inferred_fields ?? [];
  const carried = (m?: string) => !!m && dealer.models.includes(m);
  const explicit = Math.round(25 * d.strength);
  const tq = d.transaction_questions.length === 0 ? 0 : d.transaction_questions.length === 1 ? 12 : 15;
  let model = 0;
  if (carried(i.model) && !inferred.includes('model')) model = 12;
  else if (carried(i.model)) model = 8;
  else if ((i.competing_models ?? []).some(carried)) model = 6;
  else if (i.brand && dealer.brands.includes(i.brand)) model = 4;
  const rows = dealer.inventory.filter((r) => r.model === i.model);
  const trimOk = (r: (typeof rows)[number]) => !i.trim || r.trim === i.trim;
  const colorOk = (r: (typeof rows)[number]) =>
    !i.color_intent || (i.color_intent.includes(r.exterior_color) && i.color_intent.includes(r.interior_color));
  const inStock = rows.filter((r) => r.status === 'in_stock');
  let inventory = 0;
  if (i.inventory_intent) {
    if (inStock.some((r) => trimOk(r) && colorOk(r))) inventory = 10;
    else if (rows.some((r) => r.status === 'in_transit' && trimOk(r))) inventory = 7;
    else inventory = 2;
  } else if (i.trim && inStock.some(trimOk)) inventory = 7;
  else if (inStock.length > 0) inventory = 4;
  let location = 0;
  if (i.location && i.location === dealer.city) location = 10;
  else if (i.province === dealer.province && !inferred.includes('province')) location = 6;
  else if (i.province === dealer.province) location = 5;
  const stagePoints: Record<PurchaseStage, number> = {
    awareness: 0,
    research: 3,
    comparison: 5,
    price_shopping: 8,
    active_shopping: 10,
    dealer_selection: 11,
    purchase_imminent: 12,
  };
  const stage = i.purchase_stage ? stagePoints[i.purchase_stage] : 0;
  const relevance = i.brand && dealer.brands.includes(i.brand) ? 5 : (i.competing_models ?? []).some(carried) ? 3 : 0;
  return explicit + tq + model + inventory + location + stage + recency + authenticity + relevance;
}

const tier = (score: number) => (score >= 92 ? 'immediate' : score >= 80 ? 'high_intent' : score >= 60 ? 'qualified' : score >= 20 ? 'candidate' : 'none');

/** Every evidence quote is a verbatim substring of the source named by its source_ref. */
function assertVerbatimEvidence(text: string, context: SignalContext | undefined, d: IntentDetection) {
  const analyzed = analyzedTextFor(text, context);
  for (const e of d.evidence) {
    assert.ok(e.code.length > 0, 'evidence code');
    assert.match(e.label, /[一-鿿]/, `label must be Chinese: ${e.label}`);
    assert.ok(e.quote, `evidence ${e.code} has a quote`);
    const sources =
      e.source_ref === 'post_context'
        ? [context?.post_title ?? '', context?.post_content ?? '']
        : e.source_ref === 'ip_location'
          ? [context?.ip_location ?? '']
          : [analyzed];
    assert.ok(
      sources.some((s) => s.includes(e.quote!)),
      `quote "${e.quote}" (${e.code}) is not a raw substring of ${JSON.stringify(sources)}`,
    );
    assert.ok(isVerbatimQuote(sources, e.quote), `isVerbatimQuote failed for ${e.code}`);
  }
}

describe('intent-detection: prefilter', () => {
  it('rejects praise, noise and emoji-only comments', () => {
    assert.equal(prefilter('帅', I3_POST).reason, 'pure_praise');
    assert.equal(prefilter('好看！！', I3_POST).reason, 'pure_praise');
    assert.equal(prefilter('这车好帅啊😍', I3_POST).reason, 'pure_praise');
    assert.equal(prefilter('蹲', I3_POST).reason, 'pure_praise');
    assert.equal(prefilter('哈哈哈', I3_POST).reason, 'pure_praise');
    assert.equal(prefilter('yyds 666', I3_POST).reason, 'pure_praise');
    assert.equal(prefilter('😍😍🔥', I3_POST).reason, 'empty_or_emoji');
    assert.equal(prefilter('[赞R][赞R]', I3_POST).reason, 'empty_or_emoji');
    assert.equal(prefilter('   ', I3_POST).reason, 'empty_or_emoji');
    assert.equal(prefilter('嗯', I3_POST).reason, 'too_short');
    for (const t of ['帅', '好看', '😍😍', '蹲', '哈哈哈']) assert.equal(prefilter(t, I3_POST).passed, false, t);
    assert.equal(isPurePraise('i3好帅'), false, 'a model mention is not pure praise');
  });

  it('flags marketing / competitor salesperson solicitation', () => {
    const r = prefilter('宝马i3底价私信我，杭州4S店销售', I3_POST);
    assert.equal(r.passed, false);
    assert.equal(r.reason, 'marketing_account');
    assert.equal(r.is_marketing, true);
    assert.ok(r.hits.includes('私信我'));
    assert.equal(prefilter('有需要的朋友私我，全网最低', I3_POST).is_marketing, true);
    assert.equal(prefilter('加v了解更多i3优惠', I3_POST).is_marketing, true);
  });

  it('does not treat buyer requests as marketing', () => {
    const a = prefilter('杭州i3有现车吗，可以加微信吗', I3_POST);
    assert.equal(a.passed, true);
    assert.equal(a.is_marketing, false);
    const b = prefilter('杭州哪个4S店销售靠谱', I3_POST);
    assert.equal(b.passed, true);
  });

  it('passes generic transaction questions only with automotive context', () => {
    const withCtx = prefilter('现在优惠多少', I3_POST);
    assert.equal(withCtx.passed, true);
    assert.equal(withCtx.reason, 'keyword_hit');
    assert.ok(withCtx.hits.includes('优惠'));
    assert.equal(prefilter('现在优惠多少', { source_type: 'comment', post_title: '杭州周末美食推荐' }).reason, 'no_signal');
    assert.equal(prefilter('现在优惠多少').reason, 'no_signal');
    assert.equal(prefilter('i3多少钱').passed, true, 'model mention is enough');
    assert.equal(prefilter('今天天气真不错', I3_POST).reason, 'no_signal');
  });
});

describe('intent-detection: ARCHITECTURE §5 reference comments', () => {
  const detect = (text: string, ctx: SignalContext = I3_POST) => detectIntentRules(text, ctx, HZ_BMW);

  it("'帅' is not a purchase signal", () => {
    const d = detect('帅');
    assert.equal(d.is_purchase_signal, false);
    assert.equal(d.strength, 0);
    assert.equal(d.intent.purchase_stage, undefined);
    assert.equal(d.intent.model, undefined, 'filtered comments do not inherit the post model');
    assert.deepEqual(d.transaction_questions, []);
    assert.equal(d.evidence[0].code, 'pure_praise');
    assert.equal(d.engine, 'rules');
  });

  it("'这车后排空间怎么样' is research with the model inferred from the post", () => {
    const d = detect('这车后排空间怎么样');
    assert.equal(d.is_purchase_signal, true);
    assert.equal(d.intent.purchase_stage, 'research');
    assert.equal(d.strength, 0.2);
    assert.equal(d.intent.brand, 'BMW');
    assert.equal(d.intent.model, 'i3');
    assert.deepEqual(d.intent.inferred_fields, ['brand', 'model']);
    const ctxEv = d.evidence.find((e) => e.code === 'model_from_post_context');
    assert.deepEqual(ctxEv, { code: 'model_from_post_context', label: '车型来自帖子上下文', quote: '宝马i3', source_ref: 'post_context' });
    assert.deepEqual(d.transaction_questions, []);
  });

  it("'现在优惠多少' is price_shopping with a discount question and inferred model", () => {
    const d = detect('现在优惠多少');
    assert.equal(d.intent.purchase_stage, 'price_shopping');
    assert.equal(d.strength, 0.88);
    assert.deepEqual(d.transaction_questions, ['discount']);
    assert.equal(d.intent.discount_intent, true);
    assert.equal(d.intent.model, 'i3');
    assert.ok(d.intent.inferred_fields?.includes('model'));
    assert.ok(d.evidence.some((e) => e.code === 'discount' && e.label === '询问优惠' && e.quote === '优惠'));
  });

  it("'现在i3优惠多少' is price_shopping with the model stated", () => {
    const d = detect('现在i3优惠多少');
    assert.equal(d.intent.purchase_stage, 'price_shopping');
    assert.equal(d.strength, 0.88);
    assert.equal(d.intent.model, 'i3');
    assert.equal(d.intent.inferred_fields, undefined);
    assert.ok(d.evidence.some((e) => e.code === 'stated_model' && e.quote === 'i3'));
  });

  it("'杭州i3 35L落地多少' is active_shopping with trim and local location", () => {
    const d = detect('杭州i3 35L落地多少');
    assert.equal(d.intent.purchase_stage, 'active_shopping');
    assert.equal(d.strength, 1);
    assert.deepEqual(d.transaction_questions, ['landing_price']);
    assert.equal(d.intent.trim, 'eDrive35L');
    assert.equal(d.intent.location, '杭州');
    assert.equal(d.intent.province, '浙江');
    assert.equal(d.intent.price_intent, true);
    const labels = d.evidence.map((e) => e.label);
    for (const l of ['指定配置 eDrive35L', '本地买家（杭州）', '询问落地价']) assert.ok(labels.includes(l), l);
  });

  it("'杭州i3 35L白外红内有现车吗？这周想去看看' is purchase_imminent", () => {
    const d = detect('杭州i3 35L白外红内有现车吗？这周想去看看');
    assert.equal(d.intent.purchase_stage, 'purchase_imminent');
    assert.equal(d.strength, 1);
    assert.deepEqual(d.transaction_questions, ['inventory', 'color_trim_availability', 'test_drive']);
    assert.equal(d.intent.color_intent, '白外红内');
    assert.equal(d.intent.purchase_timeframe, 'this_week');
    assert.equal(d.intent.visit_intent, true);
    assert.equal(d.intent.inventory_intent, true);
    const labels = d.evidence.map((e) => e.label);
    for (const l of ['询问现车', '指定配置 eDrive35L', '指定颜色 白外红内', '本地买家（杭州）', '计划本周到店']) assert.ok(labels.includes(l), l);
    assert.ok((d.intent.confidence ?? 0) > (detect('现在优惠多少').intent.confidence ?? 1));
  });

  it('feeds the §5 scoring formula into the binding score bands and tiers', () => {
    const expectations: [string, number, number, string][] = [
      ['帅', 0, 9, 'none'],
      ['这车后排空间怎么样', 20, 45, 'candidate'],
      ['现在优惠多少', 60, 79, 'qualified'],
      ['现在i3优惠多少', 60, 79, 'qualified'],
      ['杭州i3 35L落地多少', 85, 97, 'high_intent'],
      ['杭州i3 35L白外红内有现车吗？这周想去看看', 95, 100, 'immediate'],
    ];
    const scores: number[] = [];
    for (const [text, min, max, expectedTier] of expectations) {
      const score = referenceScore(detect(text), HZ_BMW);
      scores.push(score);
      assert.ok(score >= min && score <= max, `${text}: score ${score} not in [${min}, ${max}]`);
      assert.equal(tier(score), expectedTier, `${text}: tier`);
    }
    assert.equal(scores[0], 2, "'帅' scores exactly 2");
    assert.ok(scores[3] >= scores[2], 'stating the model never lowers the score');
    for (let i = 1; i < scores.length; i++) assert.ok(scores[i] >= scores[i - 1], 'monotonic reference ladder');
  });
});

describe('intent-detection: extraction rules', () => {
  it('detects comparisons with competing models', () => {
    const a = detectIntentRules('i3和Model 3到底选哪个', I3_POST, HZ_BMW);
    assert.equal(a.intent.purchase_stage, 'comparison');
    assert.equal(a.strength, 0.4);
    assert.equal(a.intent.model, 'i3');
    assert.deepEqual(a.intent.competing_models, ['Model 3']);
    assert.ok(a.evidence.some((e) => e.label === '对比 Model 3'));

    const b = detectIntentRules('X3和GLC选哪个', { source_type: 'comment' }, HZ_BMW);
    assert.equal(b.intent.model, 'X3');
    assert.deepEqual(b.intent.competing_models, ['GLC']);

    const c = detectIntentRules('3系还是C级，预算30万', { source_type: 'comment' }, HZ_BMW);
    assert.equal(c.intent.purchase_stage, 'comparison');
    assert.equal(c.intent.model, '3 Series');
    assert.deepEqual(c.intent.competing_models, ['C-Class']);
    assert.equal(c.intent.budget_min, 300000);
    assert.equal(c.intent.budget_max, 300000);

    const d = detectIntentRules('和Model 3比怎么样', I3_POST, HZ_BMW);
    assert.equal(d.intent.model, 'i3', 'post subject stays primary');
    assert.deepEqual(d.intent.competing_models, ['Model 3']);
    assert.equal(d.intent.purchase_stage, 'comparison');

    const noDealer = detectIntentRules('Model 3和i3选哪个', { source_type: 'comment' });
    assert.equal(noDealer.intent.model, 'Model 3', 'without a dealer the first mention is primary');
    assert.deepEqual(noDealer.intent.competing_models, ['i3']);
  });

  it('uses IP 属地 province only when no location is stated', () => {
    const d = detectIntentRules('现在优惠多少', { ...I3_POST, ip_location: 'IP属地：浙江' }, HZ_BMW);
    assert.equal(d.intent.location, undefined);
    assert.equal(d.intent.province, '浙江');
    assert.ok(d.intent.inferred_fields?.includes('province'));
    assert.deepEqual(
      d.evidence.find((e) => e.code === 'ip_location'),
      { code: 'ip_location', label: 'IP属地 浙江', quote: 'IP属地：浙江', source_ref: 'ip_location' },
    );
    const stated = detectIntentRules('深圳i3 35L落地多少', { ...I3_POST, ip_location: '浙江' }, HZ_BMW);
    assert.equal(stated.intent.location, '深圳');
    assert.equal(stated.intent.province, '广东');
    assert.ok(!stated.intent.inferred_fields?.includes('province'));
    assert.equal(stated.intent.purchase_stage, 'active_shopping');
    assert.ok(stated.evidence.some((e) => e.label === '所在地（深圳）'));
  });

  it('marks already-purchased and explicit refusals as negative', () => {
    const d = detectIntentRules('已经提了Model Y 很香', I3_POST, HZ_BMW);
    assert.equal(d.negative, true);
    assert.equal(d.is_purchase_signal, false);
    assert.equal(d.strength, 0);
    assert.ok(d.evidence.some((e) => e.code === 'already_purchased'));

    const refusal = detectIntentRules('不需要，谢谢', I3_POST, HZ_BMW);
    assert.equal(refusal.negative, true);
    assert.equal(refusal.is_purchase_signal, false);

    const friend = detectIntentRules('朋友已经提了i3，我也想买，现在优惠多少', I3_POST, HZ_BMW);
    assert.equal(friend.negative, false, 'someone else bought it');
    assert.equal(friend.intent.purchase_stage, 'price_shopping');
  });

  it('is negation aware: declining financing is not negative feedback', () => {
    const d = detectIntentRules('不需要贷款，全款，杭州有现车吗', I3_POST, HZ_BMW);
    assert.equal(d.negative, false);
    assert.equal(d.is_purchase_signal, true);
    assert.equal(d.intent.financing_intent, false);
    assert.ok(!d.transaction_questions.includes('finance'));
    assert.ok(d.evidence.some((e) => e.code === 'financing_declined' && e.quote === '不需要贷款'));
    assert.equal(d.intent.purchase_stage, 'active_shopping');

    const rejectCompetitor = detectIntentRules('Model 3不考虑了，杭州i3有现车吗', I3_POST, HZ_BMW);
    assert.equal(rejectCompetitor.negative, false);
    assert.equal(rejectCompetitor.intent.model, 'i3');
    assert.ok(rejectCompetitor.transaction_questions.includes('inventory'));

    const askFinance = detectIntentRules('i3要不要贷款划算，首付多少', I3_POST, HZ_BMW);
    assert.equal(askFinance.intent.financing_intent, true);
    assert.ok(askFinance.transaction_questions.includes('finance'));
    assert.equal(askFinance.intent.purchase_stage, 'active_shopping');
  });

  it("does not match 'i3' inside 'i30'", () => {
    const d = detectIntentRules('现代i30多少钱', { source_type: 'comment' }, HZ_BMW);
    assert.equal(d.intent.model, undefined);
    assert.ok(!d.evidence.some((e) => e.code === 'stated_model'));
  });

  it('distinguishes greeting 在吗 from asking whether a car is still available', () => {
    const greeting = detectIntentRules('在吗？i3多少钱', I3_POST, HZ_BMW);
    assert.deepEqual(greeting.transaction_questions, ['price']);
    assert.equal(greeting.intent.purchase_stage, 'price_shopping');
    const stock = detectIntentRules('白色那台还在吗', I3_POST, HZ_BMW);
    assert.ok(stock.transaction_questions.includes('inventory'));
    assert.equal(stock.intent.color_intent, '白色');
    assert.equal(stock.intent.purchase_stage, 'active_shopping');
  });

  it('covers the remaining stages', () => {
    const imminent = detectIntentRules('准备下定i3了', { source_type: 'comment' }, HZ_BMW);
    assert.equal(imminent.intent.purchase_stage, 'purchase_imminent');
    assert.ok(imminent.evidence.some((e) => e.code === 'purchase_commitment'));

    const dealerSel = detectIntentRules('哪家4S店靠谱', I3_POST, HZ_BMW);
    assert.equal(dealerSel.intent.purchase_stage, 'dealer_selection');
    assert.equal(dealerSel.intent.dealer_selection_intent, true);
    assert.equal(dealerSel.strength, 1);

    const awareness = detectIntentRules('好想买i3', { source_type: 'comment' }, HZ_BMW);
    assert.equal(awareness.intent.purchase_stage, 'awareness');
    assert.equal(awareness.strength, 0.1);

    const scenario = detectIntentRules('25万买什么车', { source_type: 'comment' }, HZ_BMW);
    assert.equal(scenario.intent.purchase_stage, 'research');
    assert.equal(scenario.intent.budget_max, 250000);

    const tradeIn = detectIntentRules('i3置换有补贴吗', { source_type: 'comment' }, HZ_BMW);
    assert.deepEqual(tradeIn.transaction_questions, ['trade_in']);
    assert.equal(tradeIn.intent.trade_in_intent, true);
    assert.ok(tradeIn.evidence.some((e) => e.label === '询问置换补贴'));

    // a yes/no programme question without trim/location/programme details is price shopping (§5: "specifics")
    const lease = detectIntentRules('宝马有以租代购吗', { source_type: 'comment' }, HZ_BMW);
    assert.equal(lease.intent.leasing_intent, true);
    assert.equal(lease.intent.purchase_stage, 'price_shopping');
    const leaseDetail = detectIntentRules('杭州i3以租代购月租多少', { source_type: 'comment' }, HZ_BMW);
    assert.equal(leaseDetail.intent.purchase_stage, 'active_shopping');

    const notTiming = detectIntentRules('最近i3优惠多少', { source_type: 'comment' }, HZ_BMW);
    assert.equal(notTiming.intent.purchase_stage, 'price_shopping', "'最近' alone does not make it imminent");
    assert.equal(notTiming.intent.purchase_timeframe, undefined);

    const soon = detectIntentRules('最近想去店里看看i3现车', { source_type: 'comment' }, HZ_BMW);
    assert.equal(soon.intent.purchase_stage, 'purchase_imminent');
    assert.equal(soon.intent.purchase_timeframe, 'soon');
  });

  it("analyzes posts as title + '\\n' + content", () => {
    const ctx: SignalContext = { source_type: 'post', post_title: '杭州i3落地价求助' };
    const a = analyzeSignal('35L白色有现车吗', ctx, HZ_BMW);
    assert.equal(a.analyzed_text, '杭州i3落地价求助\n35L白色有现车吗');
    const d = a.detection;
    assert.equal(d.intent.location, '杭州');
    assert.equal(d.intent.model, 'i3');
    assert.equal(d.intent.trim, 'eDrive35L');
    assert.equal(d.intent.inferred_fields, undefined, 'a post is its own source, nothing inferred');
    assert.deepEqual(d.transaction_questions, ['landing_price', 'inventory', 'color_trim_availability']);
    assert.equal(analyzedTextFor('杭州i3落地价求助 35L白色有现车吗', ctx), '杭州i3落地价求助 35L白色有现车吗', 'title not duplicated');
  });

  it('keeps stated entities for marketing comments but never makes them signals', () => {
    const d = detectIntentRules('宝马i3底价私信我，杭州4S店销售', I3_POST, HZ_BMW);
    assert.equal(d.is_purchase_signal, false);
    assert.equal(d.negative, false);
    assert.equal(d.intent.model, 'i3');
    assert.equal(d.evidence[0].code, 'marketing_account');
    assert.equal(referenceScore(d, HZ_BMW), 1);
  });

  it('anchors strengths exactly as ARCHITECTURE §5', () => {
    assert.deepEqual(STAGE_STRENGTH, {
      awareness: 0.1,
      research: 0.2,
      comparison: 0.4,
      price_shopping: 0.88,
      active_shopping: 1,
      dealer_selection: 1,
      purchase_imminent: 1,
    });
  });
});

describe('intent-detection: evidence property', () => {
  const fixtures: [string, SignalContext | undefined][] = [
    ['帅', I3_POST],
    ['这车后排空间怎么样', I3_POST],
    ['现在优惠多少', I3_POST],
    ['现在优惠多少', { ...I3_POST, ip_location: 'IP属地：浙江' }],
    ['现在i3优惠多少', I3_POST],
    ['杭州i3 35L落地多少', I3_POST],
    ['杭州i3 35L白外红内有现车吗？这周想去看看', I3_POST],
    ['i3和Model 3到底选哪个', I3_POST],
    ['X3和GLC选哪个', { source_type: 'comment' }],
    ['3系还是C级，预算30万', { source_type: 'comment' }],
    ['深圳i3 35L落地多少', I3_POST],
    ['已经提了Model Y 很香', I3_POST],
    ['宝马i3底价私信我，杭州4S店销售', I3_POST],
    ['和Model 3比怎么样', { source_type: 'comment', post_title: '宝马i3值得买吗', post_content: '续航和空间都不错' }],
    ['不需要贷款，全款，杭州有现车吗', I3_POST],
    ['ＢＭＷ　Ｘ３　２５Ｌ　有现车吗？魔都', { source_type: 'comment' }],
    ['35L白色有现车吗', { source_type: 'post', post_title: '杭州i3落地价求助' }],
    ['😍😍', I3_POST],
    ['求推荐杭州靠谱的店，i3贷款首付多少，旧车置换补贴有吗', { source_type: 'reply', ip_location: '浙江' }],
    ['25万左右，下个月想换车，X3 30L还是iX3', undefined],
  ];

  it('every evidence quote is verbatim and every label is Chinese', () => {
    for (const [text, ctx] of fixtures) {
      const d = detectIntentRules(text, ctx, HZ_BMW);
      assertVerbatimEvidence(text, ctx, d);
      assert.ok(d.strength >= 0 && d.strength <= 1);
      const c = d.intent.confidence ?? -1;
      assert.ok(c >= 0 && c <= 1, `confidence ${c}`);
      if (d.is_purchase_signal) {
        assert.ok(d.intent.purchase_stage, `${text}: signal must have a stage`);
        assert.equal(d.strength, STAGE_STRENGTH[d.intent.purchase_stage!]);
      } else {
        assert.equal(d.strength, 0, `${text}: non-signal strength`);
      }
      for (const q of d.transaction_questions) {
        assert.ok(d.evidence.length > 0, `${text}: question ${q} without evidence`);
      }
    }
  });
});
