/**
 * Adversarial regression tests for the A3 NLU module (hardening pass).
 * Every case here reproduced a concrete defect in the first implementation.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isVerbatimQuote } from '../../../src/core/evidence.ts';
import { TRANSACTION_QUESTIONS, type DealerProfile, type IntentDetection, type SignalContext } from '../../../src/core/types.ts';
import { detectTimeframe, findBrands, findLocation, findModels } from '../../../src/domain/automotive-lexicon.ts';
import type { LlmJsonRequest, LlmProvider, LlmResult, LlmStatus } from '../../../src/providers/llm/types.ts';
import { detectIntent, refineWithLlm } from '../../../src/skills/acquisition/intent-detection/index.ts';
import { analyzeSignal, analyzedTextFor, detectIntentRules, prefilter } from '../../../src/skills/acquisition/intent-detection/nlu.ts';
import {
  detectContactInfo,
  detectConversationIntents,
  extractSlots,
  resolveAppointmentTime,
} from '../../../src/skills/sales/conversation/nlu.ts';
import { TEST_NOW, createTestContext } from '../../helpers/context.ts';

const HZ_BMW: DealerProfile = {
  dealer_id: 'dlr_hz_bmw',
  brands: ['BMW'],
  models: ['i3', 'X3', '3 Series'],
  trims: [
    { model: 'i3', trim: 'eDrive35L', aliases: ['35L', 'i3 35L'] },
    { model: 'i3', trim: 'eDrive40L', aliases: ['40L', 'i3 40L'] },
    { model: 'X3', trim: 'xDrive25L', aliases: ['25L'] },
  ],
  inventory: [
    { model: 'i3', trim: 'eDrive35L', exterior_color: '白', interior_color: '红', status: 'in_stock', quantity: 1 },
    { model: 'i3', trim: 'eDrive40L', exterior_color: '灰', interior_color: '黑', status: 'in_transit', quantity: 1 },
  ],
  city: '杭州',
  province: '浙江',
};
const I3_POST: SignalContext = { source_type: 'comment', post_title: '宝马i3现在值得买吗？' };
const COMMENT: SignalContext = { source_type: 'comment' };
const detect = (text: string, ctx: SignalContext = I3_POST) => detectIntentRules(text, ctx, HZ_BMW);
const NOW = new Date(TEST_NOW); // Saturday 2026-09-12 10:00 Asia/Shanghai
const TZ = 'Asia/Shanghai';
const intents = (t: string) => detectConversationIntents(t).intents;

describe('hardening: timeframes never read past events as upcoming purchases', () => {
  it('ignores past-tense and recurring time words', () => {
    const tf = (t: string) => detectTimeframe(t)?.timeframe ?? null;
    for (const t of ['上周六去店里看了', '上周末看过', '每周末都洗车', '三年前买的', '两年前提的', '去年年底提的', '上个月底去看过', '两年内不换车']) {
      assert.equal(tf(t), null, t);
    }
    assert.notEqual(tf('6个月内换车'), 'this_month', "'6个月内' is not 'this month'");
    // controls stay recognized
    assert.equal(tf('这周末去看'), 'this_week');
    assert.equal(tf('周六去看车'), 'this_week');
    assert.equal(tf('今年年底前提车'), 'within_3_months');
    assert.equal(tf('过年前提车'), 'within_3_months');
    assert.equal(tf('下周六过去'), 'soon');
  });

  it('a past dealer visit does not make a discount question purchase_imminent', () => {
    const d = detect('上周六去店里看了i3，现在优惠多少');
    assert.equal(d.intent.purchase_timeframe, undefined);
    assert.notEqual(d.intent.purchase_stage, 'purchase_imminent');
    assert.equal(d.is_purchase_signal, true);
  });

  it("recognizes '去看<车型>' as a visit so a weekend visit plan is imminent", () => {
    const d = detect('这周末有空去看i3');
    assert.equal(d.intent.purchase_stage, 'purchase_imminent');
    assert.equal(d.intent.visit_intent, true);
    assert.ok(d.transaction_questions.includes('test_drive'));
    const movie = detect('周末去看电影', COMMENT);
    assert.equal(movie.is_purchase_signal, false);
  });
});

describe('hardening: negative feedback is precise', () => {
  it('declining a feature or segment is not declining the purchase', () => {
    for (const t of ['不需要四驱，i3后排空间怎么样', '预算30万，不需要SUV，3系怎么样', '四驱不需要，i3后排空间怎么样', '不考虑电车，X3油耗怎么样']) {
      const d = detect(t);
      assert.equal(d.negative, false, t);
      assert.equal(d.is_purchase_signal, true, t);
      assert.equal(d.intent.purchase_stage, 'research', t);
    }
    for (const t of ['不需要，谢谢', '暂时不考虑买车了', 'i3不买了', '不需要了哈', '我真的不需要']) {
      const d = detect(t);
      assert.equal(d.negative, true, t);
      assert.equal(d.is_purchase_signal, false, t);
    }
  });

  it("'区别发…' / '特别发…' are not '别发'", () => {
    const d = detect('i3和X3有啥区别发我看看');
    assert.equal(d.negative, false);
    assert.equal(detect('别发了').negative, true);
  });

  it('a complaint about being harassed by others does not suppress a price question', () => {
    const d = detect('留了电话一直被骚扰，现在i3落地多少');
    assert.equal(d.negative, false);
    assert.deepEqual(d.transaction_questions, ['landing_price']);
    assert.equal(detect('别骚扰我').negative, true);
  });

  it("'刚提的问题' is not an already-purchased car", () => {
    const d = detect('我刚提的问题没人回，i3多少钱');
    assert.equal(d.negative, false);
    assert.equal(d.intent.purchase_stage, 'price_shopping');
    assert.equal(detect('刚提的i3，很满意', COMMENT).negative, true);
  });

  it('negative detections carry an evidence code the lead scorer recognizes as negative', () => {
    for (const t of ['已订i3，等提车', '已经提了Model Y 很香', '不需要，谢谢', '别再发了']) {
      const d = detect(t);
      assert.equal(d.negative, true, t);
      assert.ok(d.evidence.some((e) => e.code === 'not_interested' || e.code === 'negative_feedback'), t);
    }
  });
});

describe('hardening: marketing detection does not discard buyers', () => {
  it('ignores family members and payment methods', () => {
    const a = prefilter('回去找我老婆商量一下，i3落地多少', I3_POST);
    assert.equal(a.is_marketing, false);
    assert.equal(a.passed, true);
    const b = prefilter('定金微信转账就行吗，i3有现车吗', I3_POST);
    assert.equal(b.is_marketing, false);
    assert.equal(b.passed, true);
    assert.equal(prefilter('找我拿底价', I3_POST).is_marketing, true);
    assert.equal(prefilter('i3现车，加我微信', I3_POST).is_marketing, true);
  });
});

describe('hardening: transaction questions and stages', () => {
  it("'有没有优惠' / '还有优惠吗' is a discount question, not a trim availability question", () => {
    for (const t of ['35L有没有优惠', '35L还有优惠吗']) {
      const d = detect(t);
      assert.deepEqual(d.transaction_questions, ['discount'], t);
      assert.equal(d.intent.purchase_stage, 'active_shopping', `${t}: trim-specific price question`);
    }
    assert.ok(detect('35L白色还有吗').transaction_questions.includes('color_trim_availability'));
  });

  it('generic finance/lease questions are price_shopping; specifics make it active_shopping', () => {
    assert.equal(detect('能贷款吗').intent.purchase_stage, 'price_shopping');
    assert.equal(detect('能贷款吗').strength, 0.88);
    assert.equal(detect('i3能分期吗').intent.purchase_stage, 'price_shopping');
    assert.equal(detect('宝马有以租代购吗', COMMENT).intent.purchase_stage, 'price_shopping');
    assert.equal(detect('i3首付多少').intent.purchase_stage, 'active_shopping');
    assert.equal(detect('杭州i3能贷款吗').intent.purchase_stage, 'active_shopping');
    assert.equal(detect('i3置换有补贴吗', COMMENT).intent.purchase_stage, 'active_shopping');
    assert.equal(detect('i3以租代购月租多少').intent.purchase_stage, 'active_shopping');
  });

  it('spec questions with 多少 are research, not price', () => {
    const d = detect('i3 百公里加速多少', COMMENT);
    assert.deepEqual(d.transaction_questions, []);
    assert.equal(d.intent.purchase_stage, 'research');
  });

  it("'绿色牌照' is not a colour request", () => {
    const d = detect('i3是绿色牌照吗，多少钱');
    assert.equal(d.intent.color_intent, undefined);
    assert.equal(d.intent.purchase_stage, 'price_shopping');
  });

  it('every transaction question has evidence whose code IS the question (persistable round-trip)', () => {
    const texts = [
      '杭州i3 35L白外红内有现车吗？这周想去看看',
      'i3多少钱，落地多少，有优惠吗',
      '求推荐杭州靠谱的店，i3贷款首付多少，旧车置换补贴有吗',
      '宝马有以租代购吗',
      '35L有现车吗',
    ];
    for (const t of texts) {
      const d = detect(t);
      assert.ok(d.transaction_questions.length > 0, t);
      for (const q of d.transaction_questions) {
        assert.ok(d.evidence.some((e) => e.code === q), `${t}: no evidence with code '${q}'`);
      }
      const questionCodes = d.evidence.map((e) => e.code).filter((c) => (TRANSACTION_QUESTIONS as readonly string[]).includes(c));
      assert.deepEqual([...new Set(questionCodes)].sort(), [...d.transaction_questions].sort(), `${t}: no stray question codes`);
    }
  });
});

describe('hardening: lexicon false positives', () => {
  it("JV brand names ('北京现代') are not locations and block post-context model inference", () => {
    assert.equal(findLocation('北京现代i30'), null);
    assert.equal(findLocation('上海大众朗逸'), null);
    assert.equal(findLocation('北京4S店')?.city, '北京');
    assert.ok(findBrands('北京现代i30').some((b) => b.brand === 'Hyundai'));
    const d = detect('北京现代i30多少钱');
    assert.equal(d.intent.location, undefined);
    assert.equal(d.intent.model, undefined, 'must not inherit the i3 post model when another brand is named');
    assert.notEqual(d.intent.brand, 'BMW');
    const toyota = detect('丰田凯美瑞好开吗');
    assert.equal(toyota.intent.model, undefined);
    assert.equal(toyota.intent.brand, 'Toyota');
  });

  it("'宝马M3' is never Tesla Model 3, even next to a Tesla mention", () => {
    assert.deepEqual(findModels('宝马M3和Model Y').map((m) => m.model), ['Model Y']);
    assert.deepEqual(findModels('宝马 M3和特斯拉').map((m) => m.model), []);
    assert.deepEqual(findModels('特斯拉M3').map((m) => m.model), ['Model 3']);
  });
});

describe('hardening: evidence stays verbatim on the new fixtures', () => {
  const fixtures = [
    '上周六去店里看了i3，现在优惠多少',
    '这周末有空去看i3',
    '不需要四驱，i3后排空间怎么样',
    '留了电话一直被骚扰，现在i3落地多少',
    '已订i3，等提车',
    '北京现代i30多少钱',
    'ｉ３　３５Ｌ有没有优惠？',
    '不需要，谢谢😊',
  ];
  it('quotes are raw substrings of their source', () => {
    for (const t of fixtures) {
      const d = detect(t);
      const analyzed = analyzedTextFor(t, I3_POST);
      for (const e of d.evidence) {
        const src = e.source_ref === 'post_context' ? [I3_POST.post_title!] : [analyzed];
        assert.ok(e.quote && src.some((s) => s.includes(e.quote!)), `${t}: '${e.quote}' (${e.code}) not verbatim`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LLM refinement
// ─────────────────────────────────────────────────────────────────────────────

class OneShotLlm implements LlmProvider {
  readonly name = 'one-shot';
  private readonly data: unknown;
  constructor(data: unknown) {
    this.data = data;
  }
  status(): LlmStatus {
    return { provider: this.name, status: 'AVAILABLE', model: 'test-model', reason: 'test' };
  }
  async completeJson<T>(_req: LlmJsonRequest): Promise<LlmResult<T>> {
    return { ok: true, data: this.data as T, model: 'test-model' };
  }
  async completeText(): Promise<LlmResult<string>> {
    return { ok: false, reason: 'unused' };
  }
}

describe('hardening: LLM refinement guards', () => {
  it('rejects LLM negative feedback whose quote expresses no refusal', () => {
    const a = analyzeSignal('这车后排空间怎么样', I3_POST, HZ_BMW);
    const r = refineWithLlm(
      a,
      { is_purchase_signal: false, negative: true, purchase_stage: null, evidence: [{ field: 'negative', label: '不想买', quote: '后排空间' }] },
      I3_POST,
      HZ_BMW,
    );
    assert.equal(r.detection.negative, false);
    assert.ok(r.rejected.includes('negative'));
  });

  it('re-anchors LLM quotes to the exact raw substring (case / width / spacing)', async () => {
    const text = 'I3 什么时候能开回家';
    const ctx = createTestContext({
      llm: new OneShotLlm({
        is_purchase_signal: true,
        purchase_stage: 'awareness',
        transaction_questions: ['inventory'],
        evidence: [{ field: 'inventory', label: '关心提车时间', quote: 'i3  什么时候能开回家' }],
      }),
    });
    const d: IntentDetection = await detectIntent(ctx, { text, context: COMMENT, dealer: HZ_BMW });
    assert.equal(d.engine, 'llm+rules');
    const ev = d.evidence.find((e) => e.code === 'inventory');
    assert.ok(ev, 'inventory evidence accepted');
    assert.equal(ev.quote, 'I3 什么时候能开回家');
    for (const e of d.evidence) assert.ok(e.quote && text.includes(e.quote), `not raw: ${e.quote}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conversation NLU
// ─────────────────────────────────────────────────────────────────────────────

describe('hardening: conversation refusals are never missed', () => {
  it('detects explicit do-not-contact phrasings', () => {
    for (const t of ['不要再打扰我了', '别再打扰我', '别再给我发消息了', '请勿打扰', '退订', '别再给我打电话了', '以后不要再私信我']) {
      const r = detectConversationIntents(t);
      assert.ok(r.intents.includes('not_interested'), t);
      for (const e of r.evidence) assert.ok(isVerbatimQuote(t, e.quote), `${t}: ${e.quote}`);
      assert.equal(extractSlots(t, { now: NOW, tz: TZ, previous: { appointment_intent: true } }).appointment_intent, false, t);
    }
  });

  it('detects purchases made elsewhere', () => {
    for (const t of ['买了别的车了', '已经在别处买了', '在其他店订了']) assert.ok(intents(t).includes('not_interested'), t);
  });

  it('does not treat declining a feature as not_interested', () => {
    for (const t of ['不需要SUV，想看轿车', '不考虑电车', '有啥区别发我看看', '不用了解那么多，直接说价格']) {
      assert.ok(!intents(t).includes('not_interested'), t);
    }
    for (const t of ['不需要了，谢谢', '暂时不考虑', '不用了哈']) assert.ok(intents(t).includes('not_interested'), t);
  });
});

describe('hardening: conversation appointments', () => {
  const slots = (t: string) => extractSlots(t, { now: NOW, tz: TZ });

  it('negated availability is not an appointment', () => {
    for (const t of ['明天不行，下周再说', '明天再说吧，不方便', '明天银行放款', '过去三年开的都是奥迪', '都过去了', '这周没空']) {
      assert.ok(!intents(t).includes('appointment'), t);
      assert.notEqual(slots(t).appointment_intent, true, t);
      assert.equal(slots(t).appointment_at, undefined, t);
    }
  });

  it('keeps real appointments and resolves the offered day, not the refused one', () => {
    assert.ok(intents('周六可以').includes('appointment'));
    assert.ok(intents('我明天过去').includes('appointment'));
    const s = slots('明天不行，下周六可以');
    assert.equal(s.appointment_intent, true);
    assert.equal(s.appointment_at, '2026-09-19T02:00:00.000Z');
    assert.equal(resolveAppointmentTime('明天不行，下周六可以', NOW, TZ).text, '下周六');
    const meet = slots('好的，下午3点见');
    assert.ok(intents('好的，下午3点见').includes('appointment'));
    assert.equal(meet.appointment_at, '2026-09-12T07:00:00.000Z');
  });

  it('past-tense time words do not set a purchase timeframe', () => {
    assert.equal(slots('上周末去看过了').purchase_timeframe, undefined);
  });
});

describe('hardening: conversation contact & price', () => {
  it('a refusal to give a phone number is not a contact exchange', () => {
    assert.ok(!intents('不方便留个手机号').includes('contact_exchange'));
    assert.ok(!intents('不想留个人电话').includes('contact_exchange'));
    assert.ok(intents('我手机号13800001234').includes('contact_exchange'));
  });

  it("'要多少首付' is a finance question only", () => {
    assert.deepEqual(intents('要多少首付'), ['finance_query']);
  });

  it('extracts WeChat after 搜/搜索', () => {
    assert.equal(detectContactInfo('微信搜 wang_lei88').wechat, 'wang_lei88');
  });
});

describe('hardening: second-pass regressions', () => {
  it("'不感兴趣' on an automotive post still passes the prefilter and is negative", () => {
    const d = detect('对这个不感兴趣');
    assert.equal(prefilter('对这个不感兴趣', I3_POST).passed, true);
    assert.equal(d.negative, true);
    assert.ok(d.evidence.some((e) => e.code === 'not_interested'));
    assert.equal(detect('对SUV没兴趣，i3续航怎么样').negative, false);
  });

  it('asking the poster whether they already bought is not an already-purchased signal', () => {
    const a = detect('提车了吗？i3现在多少钱');
    assert.equal(a.negative, false);
    assert.equal(a.is_purchase_signal, true);
    assert.ok(a.transaction_questions.includes('price'));
    assert.ok(!a.evidence.some((e) => e.code === 'already_purchased' || e.code === 'negative_feedback'));
    const b = detect('已经买了吗？i3现车有吗');
    assert.equal(b.negative, false);
    assert.ok(b.transaction_questions.includes('inventory'));
    assert.equal(detect('已经提车了', COMMENT).negative, true);
    assert.ok(!intents('买好了吗').includes('not_interested'));
    assert.ok(intents('买好了').includes('not_interested'));
  });

  it("A-不-A availability ('周六行不行') is an appointment and '到店' is not swallowed into the time quote", () => {
    const s = extractSlots('周六行不行', { now: NOW, tz: TZ });
    assert.equal(s.appointment_intent, true);
    assert.equal(s.appointment_at, '2026-09-12T02:00:00.000Z');
    assert.ok(intents('明天有没有空，想过来看车').includes('appointment'));
    const r = resolveAppointmentTime('9月20号下午3点到店', NOW, TZ);
    assert.equal(r.at, '2026-09-20T07:00:00.000Z');
    assert.equal(r.text, '9月20号下午3点');
  });
});
