/**
 * Adversarial hardening of author roles and signal precision (ARCHITECTURE §5.1 / §5.2, docs/PREVIEW_FINDINGS.md F1–F3).
 *
 * Each block reproduces a defect found by probing real-looking Xiaohongshu phrasings against the rules NLU:
 * genuine buyers dropped as owners / creators, invented stock questions, a duration read as a purchase date, and a
 * buyer who names two places capped for the store in the place they want to buy.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DealerProfile, IntentDetection, SignalContext } from '../../../src/core/types.ts';
import { detectTimeframe } from '../../../src/domain/automotive-lexicon.ts';
import { analyzedTextFor, detectIntentRules } from '../../../src/skills/acquisition/intent-detection/nlu.ts';
import { DEFAULT_THRESHOLDS, DEFAULT_WEIGHTS, scoreSignal } from '../../../src/skills/acquisition/lead-scoring/index.ts';

const NOW = new Date('2026-09-12T02:00:00.000Z');

const HZ: DealerProfile = {
  dealer_id: 'dlr_hz_bmw',
  brands: ['BMW'],
  models: ['i3', 'X3', '3 Series'],
  trims: [
    { model: 'i3', trim: 'eDrive35L', aliases: ['35L', 'i3 35L'] },
    { model: 'X3', trim: 'xDrive25L', aliases: ['25L', 'X3 25L'] },
  ],
  inventory: [
    { model: 'i3', trim: 'eDrive35L', exterior_color: '白', interior_color: '红', status: 'in_stock', quantity: 1 },
    { model: 'X3', trim: 'xDrive25L', exterior_color: '白', interior_color: '棕', status: 'in_stock', quantity: 2 },
  ],
  city: '杭州',
  province: '浙江',
};
const SH: DealerProfile = { ...HZ, dealer_id: 'dlr_sh_bmw', city: '上海', province: '上海' };

const I3_TITLE = '宝马i3现在值得买吗？';
const comment = (title = I3_TITLE): SignalContext => ({ source_type: 'comment', post_title: title });
const post = (title: string): SignalContext => ({ source_type: 'post', post_title: title });
const detect = (text: string, context: SignalContext = comment(), dealer: DealerProfile = HZ) => detectIntentRules(text, context, dealer, { now: NOW });
const score = (d: IntentDetection, dealer: DealerProfile = HZ) =>
  scoreSignal({ detection: d, signal_at: NOW.toISOString(), now: NOW.toISOString(), dealer }, { weights: DEFAULT_WEIGHTS, thresholds: DEFAULT_THRESHOLDS });

function assertBuyer(d: IntentDetection, label: string) {
  assert.equal(d.author_role, 'asker', `${label}: role`);
  assert.equal(d.is_purchase_signal, true, `${label}: purchase signal`);
  assert.equal(d.negative, false, `${label}: not negative`);
  assert.ok(!d.evidence.some((e) => e.code === 'already_purchased' || e.code === 'content_creator'), `${label}: no non-buyer evidence`);
}

function assertOwner(d: IntentDetection, label: string) {
  assert.equal(d.author_role, 'owner', `${label}: role`);
  assert.equal(d.is_purchase_signal, false, `${label}: never a purchase signal`);
  assert.ok(d.evidence.some((e) => e.code === 'already_purchased'), `${label}: already_purchased evidence`);
}

function assertVerbatim(text: string, context: SignalContext, d: IntentDetection) {
  const analyzed = analyzedTextFor(text, context);
  for (const e of d.evidence) {
    const sources = e.source_ref === 'post_context' ? [context.post_title ?? '', context.post_content ?? ''] : [analyzed];
    assert.ok(e.quote && sources.some((s) => s.includes(e.quote!)), `${text}: "${e.quote}" (${e.code}) is not verbatim`);
  }
}

describe('hardening: planned purchases are not completed purchases', () => {
  it('入手了 after a plan verb (准备 / 决定 / 想 / 终于要) is a buyer; a completed 入手了 is an owner', () => {
    for (const text of ['准备入手了，杭州i3有现车吗', '决定入手了！杭州X3 25L落地多少', '想入手了，现在i3优惠多少', '终于要入手了，这周去看车，杭州哪家店靠谱']) {
      const d = detect(text);
      assertBuyer(d, text);
      assert.ok(d.transaction_questions.length > 0, `${text}: its question is kept`);
      assert.ok(score(d).score >= DEFAULT_THRESHOLDS.qualified, `${text}: scored ${score(d).score}`);
    }
    for (const text of ['终于入手了i3，白外红内太美了', '上个月入手了一台i3，很满意']) {
      const d = detect(text);
      assertOwner(d, text);
      assert.equal(d.negative, true, `${text}: a stated purchase is not in market`);
    }
  });

  it('a future owner (准车主) is a buyer; 我是车主 stays an owner', () => {
    for (const text of ['我是准车主，下周想去看车，杭州现在优惠多少', '作为准车主想问下杭州i3现车多少钱', '本人是未来车主，X3落地多少']) {
      assertBuyer(detect(text), text);
    }
    assertOwner(detect('我是车主，X3开着很舒服'), '我是车主');
  });

  it('a vocative (姐妹们 / 家人们) is not someone else: the author picked up the car', () => {
    for (const text of ['姐妹们，终于提车啦！i3白外红内太美了', '家人们谁懂啊，提车了🎉']) {
      const d = detect(text);
      assertOwner(d, text);
      assert.deepEqual(d.transaction_questions, [], `${text}: a pickup announcement asks nothing`);
    }
    for (const text of ['朋友已经提了i3，我也想买，现在优惠多少', '陪朋友去提车了，i3现在多少钱']) {
      const d = detect(text);
      assertBuyer(d, text);
      assert.ok(!d.transaction_questions.includes('inventory'), `${text}: someone else's pickup is not a stock question`);
    }
  });

  it('an owner-looking author who wants to buy and asks about it is a buyer; owner stories are not', () => {
    for (const text of ['租了一辆i3开了一个月，想买了，杭州现车多少钱', '用了半年朋友的i3，我也打算买一台，35L现在优惠多少']) {
      const d = detect(text);
      assertBuyer(d, text);
      assert.ok(d.transaction_questions.length > 0, text);
    }
    for (const text of ['提车三个月了，想买的姐妹有问题可以问我', '当初也想买X3，最后提了i3，开了半年很满意，你们觉得呢？', '提车一周了，想问下首保多少钱']) {
      assertOwner(detect(text), text);
    }
  });
});

describe('hardening: a transaction question needs a car', () => {
  it('有没有车主 / 有车主 ask for owners, not for stock', () => {
    for (const text of ['有没有车主说说i3冬天续航怎么样', '有没有车主分享下，X3值得买吗', '有车主开35L吗？冬天续航怎么样']) {
      const d = detect(text);
      assert.deepEqual(d.transaction_questions, [], text);
      assert.equal(d.intent.inventory_intent, undefined, text);
      assert.equal(d.intent.purchase_stage, 'research', `${text}: a product question`);
      assert.ok(!d.evidence.some((e) => e.code === 'inventory' || e.code === 'color_trim_availability'), `${text}: no invented stock evidence`);
      assert.ok(score(d).score < DEFAULT_THRESHOLDS.qualified, `${text}: scored ${score(d).score}`);
    }
    assert.deepEqual(detect('i3有没有车？').transaction_questions, ['inventory']);
    assert.deepEqual(detect('35L有车吗').transaction_questions.includes('inventory'), true);
  });

  it('a pickup that already happened is not a stock question; a pickup wait is', () => {
    const friend = detect('朋友刚提车了，我也想买i3，现在优惠多少');
    assert.deepEqual(friend.transaction_questions, ['discount']);
    assert.equal(friend.intent.purchase_stage, 'price_shopping');
    assert.deepEqual(detect('i3提车要等多久').transaction_questions, ['inventory']);
    assert.deepEqual(detect('多久能提车').transaction_questions, ['inventory']);
  });
});

describe('hardening: creator cues', () => {
  it('a creator word the author asks FOR (求分享 / 有没有攻略 / 怎么避坑) is a buyer request', () => {
    const cases: [string, SignalContext, string][] = [
      ['求分享杭州i3落地价', post('求分享杭州i3落地价'), 'landing_price'],
      ['第一次买车怎么避坑？杭州X3 25L落地多少合适', post('第一次买车怎么避坑？'), 'landing_price'],
    ];
    for (const [text, ctx, question] of cases) {
      const d = detect(text, ctx);
      assertBuyer(d, text);
      assert.ok(d.transaction_questions.includes(question as never), `${text}: ${question}`);
      assertVerbatim(text, ctx, d);
    }
    const guide = detect('预算30万，杭州买X3有没有攻略？', post('杭州买X3有没有攻略？'));
    assertBuyer(guide, '有没有攻略');
    assert.equal(guide.intent.purchase_stage, 'research');

    const creator = detect('给大家整理了杭州买X3的避坑攻略，落地价、优惠一次说清', post('杭州买X3避坑攻略'));
    assert.equal(creator.author_role, 'creator', 'a guide that informs stays creator content');
    assert.equal(creator.is_purchase_signal, false);
  });

  it('a first-person dilemma question overrides weak creator cues; addressing undecided readers does not', () => {
    const title = 'i3和Model 3怎么选？';
    const text = '开了一个周末还是纠结，i3和Model 3选哪个？';
    const d = detect(text, post(title));
    assertBuyer(d, text);
    assert.equal(d.intent.purchase_stage, 'comparison');
    assert.deepEqual(d.intent.competing_models, ['Model 3']);

    for (const statement of ['试驾了两天，分享几点感受，喜欢驾驶的可以冲', '开了一周i3，分享给还在纠结的朋友，选哪个看需求']) {
      const s = detect(statement, post('宝马i3开了一周'));
      assert.equal(s.author_role, 'creator', statement);
      assert.equal(s.is_purchase_signal, false, statement);
    }
  });

  it('a duration (一个周末 / 两个周末) is not a this-week purchase timeframe', () => {
    assert.equal(detectTimeframe('开了一个周末'), null);
    assert.equal(detectTimeframe('试驾了两个周末'), null);
    assert.equal(detectTimeframe('这个周末去看车')?.timeframe, 'this_week');
    assert.equal(detectTimeframe('周末去看车')?.timeframe, 'this_week');
    assert.equal(detectTimeframe('下个周末去看车')?.timeframe, 'soon');
    const d = detect('试驾了一个周末还是纠结，i3和Model 3选哪个？', post('i3和Model 3怎么选？'));
    assert.equal(d.intent.purchase_timeframe, undefined);
    assert.notEqual(d.intent.purchase_stage, 'purchase_imminent');
  });
});

describe('hardening: a completed visit is not a visit request', () => {
  it('a test-drive report is not a purchase signal and never gets a "想试驾" question', () => {
    const report = detect('试驾了i3，感觉底盘不错');
    assert.equal(report.is_purchase_signal, false, 'scored 74 (qualified) before: a report is not a buying question');
    assert.deepEqual(report.transaction_questions, []);
    assert.ok(!report.evidence.some((e) => e.label === '想试驾'));
    assert.ok(score(report).score < DEFAULT_THRESHOLDS.candidate);
  });

  it('a completed test drive plus a question is active shopping without a test_drive question', () => {
    const d = detect('上周试驾了i3，现在优惠多少');
    assertBuyer(d, '上周试驾了');
    assert.deepEqual(d.transaction_questions, ['discount']);
    assert.equal(d.intent.purchase_stage, 'active_shopping');
    assert.equal(d.intent.visit_intent, undefined, 'visit_intent means wanting to visit');
    const visited = d.evidence.find((e) => e.code === 'visited_store');
    assert.equal(visited?.label, '已试驾');
    assert.equal(visited?.quote, '试驾');

    const decided = detect('试驾过了，i3和Model 3选哪个？');
    assert.equal(decided.intent.purchase_stage, 'active_shopping');
    assert.ok(!decided.transaction_questions.includes('test_drive'));
  });

  it('a planned visit keeps its test_drive question and imminence', () => {
    const planned = detect('准备这周去试驾了，杭州i3有现车吗');
    assert.ok(planned.transaction_questions.includes('test_drive'));
    assert.equal(planned.intent.purchase_stage, 'purchase_imminent');
    assert.equal(planned.intent.visit_intent, true);
    const opening = detect('4S店几点开门？想去试驾i3');
    assert.ok(opening.transaction_questions.includes('test_drive'), "'几点开门' is still a question");
  });
});

describe('hardening: several stated places (§5.2)', () => {
  it('uses the place that relates to the dealer, so a buyer who wants to buy in 杭州 is not capped there', () => {
    const text = '人在上海工作，想回杭州买i3，35L落地多少';
    const forHz = detect(text);
    assert.equal(forHz.intent.location, '杭州');
    assert.ok(forHz.evidence.some((e) => e.code === 'stated_location' && e.label === '本地买家（杭州）'));
    const hzScore = score(forHz);
    assert.ok(!hzScore.components.some((c) => c.factor === 'out_of_area_cap'));
    assert.ok(hzScore.score >= DEFAULT_THRESHOLDS.high_intent, `杭州 scored ${hzScore.score}`);
    assertVerbatim(text, comment(), forHz);

    const forSh = detect(text, comment(), SH);
    assert.equal(forSh.intent.location, '上海');
    assert.ok(!score(forSh, SH).components.some((c) => c.factor === 'out_of_area_cap'));

    const shenzhenResident = detect('我在深圳，杭州买i3能便宜多少');
    assert.equal(shenzhenResident.intent.location, '杭州');
    assert.ok(!score(shenzhenResident).components.some((c) => c.factor === 'out_of_area_cap'));
  });

  it('still caps when every stated place is outside the dealer province', () => {
    const d = detect('深圳还是广州买i3便宜？35L落地多少');
    assert.equal(d.intent.location, '深圳');
    const r = score(d);
    assert.ok(r.components.some((c) => c.factor === 'out_of_area_cap' && c.points < 0));
    assert.equal(r.score, DEFAULT_THRESHOLDS.qualified - 1);
    assert.equal(detectIntentRules('人在上海工作，想回杭州买i3', comment()).intent.location, '上海', 'without a dealer the first city is kept');
  });
});
