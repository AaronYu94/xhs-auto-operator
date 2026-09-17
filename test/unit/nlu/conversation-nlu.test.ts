import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isVerbatimQuote } from '../../../src/core/evidence.ts';
import {
  analyzeConversationMessage,
  detectContactInfo,
  detectConversationIntents,
  extractSlots,
  resolveAppointmentTime,
} from '../../../src/skills/sales/conversation/nlu.ts';
import { TEST_NOW } from '../../helpers/context.ts';

const NOW = new Date(TEST_NOW); // Saturday 2026-09-12 10:00 Asia/Shanghai
const TZ = 'Asia/Shanghai';
const at = (text: string) => resolveAppointmentTime(text, NOW, TZ);

describe('conversation NLU: appointment time', () => {
  it('resolves the reference expressions', () => {
    assert.deepEqual(at('好的，这周六下午可以过去看车，我电话13800001234'), {
      at: '2026-09-12T06:00:00.000Z',
      text: '这周六下午',
      precision: 'datetime',
    });
    assert.equal(at('明天上午').at, '2026-09-13T02:00:00.000Z');
    assert.equal(at('明天上午').text, '明天上午');
    assert.equal(at('下周三晚上').at, '2026-09-16T11:00:00.000Z');
    assert.equal(at('9月20号下午3点').at, '2026-09-20T07:00:00.000Z');
    assert.equal(at('9月20号下午3点').text, '9月20号下午3点');
  });

  it('handles weekdays relative to a Monday-start week', () => {
    assert.equal(at('周五').at, '2026-09-18T02:00:00.000Z', 'bare weekday already passed → next week');
    assert.equal(at('周五').precision, 'date');
    assert.equal(at('这周五').at, '2026-09-11T02:00:00.000Z', "'这周' keeps the current week");
    assert.equal(at('星期天下午').at, '2026-09-13T06:00:00.000Z');
    assert.equal(at('周六').at, '2026-09-12T02:00:00.000Z', 'today is not "passed"');
    assert.equal(at('下下周一').at, '2026-09-21T02:00:00.000Z');
    assert.equal(at('周末').at, '2026-09-12T02:00:00.000Z');
    assert.equal(at('下周末上午').at, '2026-09-19T02:00:00.000Z');
  });

  it('handles relative days, dates and explicit clock times', () => {
    assert.equal(at('后天中午').at, '2026-09-14T04:00:00.000Z');
    assert.equal(at('今晚').at, '2026-09-12T11:00:00.000Z');
    assert.equal(at('明天十点半').at, '2026-09-13T02:30:00.000Z');
    assert.equal(at('明天傍晚').at, '2026-09-13T09:00:00.000Z');
    assert.equal(at('下午3点').at, '2026-09-12T07:00:00.000Z', 'time only, still ahead today');
    assert.equal(at('早上九点').at, '2026-09-13T01:00:00.000Z', 'time only, already passed → tomorrow');
    assert.equal(at('14:30过去').at, '2026-09-12T06:30:00.000Z');
    assert.equal(at('晚上7点').at, '2026-09-12T11:00:00.000Z');
    assert.equal(at('20号').at, '2026-09-20T02:00:00.000Z');
    assert.equal(at('5号').at, '2026-10-05T02:00:00.000Z', 'day already passed this month → next month');
    assert.equal(at('9月5日').at, '2027-09-05T02:00:00.000Z', 'date already passed this year → next year');
    assert.equal(at('二十号下午两点').at, '2026-09-20T06:00:00.000Z');
  });

  it('does not invent times', () => {
    assert.deepEqual(at('便宜一点吧'), { at: null, text: null });
    assert.deepEqual(at('i3多少钱'), { at: null, text: null });
    assert.deepEqual(at('3号线附近'), { at: null, text: null });
    assert.deepEqual(at('2月30号'), { at: null, text: null }, 'invalid calendar date');
    assert.deepEqual(at('我电话13800001234'), { at: null, text: null });
  });
});

describe('conversation NLU: contact info', () => {
  it('extracts phones tolerant of spaces and dashes', () => {
    assert.deepEqual(detectContactInfo('我电话13800001234'), { phone: '13800001234' });
    assert.equal(detectContactInfo('138 0000 1234').phone, '13800001234');
    assert.equal(detectContactInfo('手机：138-0000-1234').phone, '13800001234');
    assert.equal(detectContactInfo('+86 13912345678').phone, '13912345678');
    assert.equal(detectContactInfo('１３８００００１２３４').phone, '13800001234', 'full-width digits');
    assert.deepEqual(detectContactInfo('1380000123'), {}, '10 digits');
    assert.deepEqual(detectContactInfo('订单号138000012345'), {}, '12 digits');
    assert.deepEqual(detectContactInfo('12800001234'), {}, 'invalid second digit');
  });

  it('extracts WeChat ids after common prefixes', () => {
    assert.equal(detectContactInfo('我微信是wang_lei88').wechat, 'wang_lei88');
    assert.equal(detectContactInfo('vx: Abc_12345').wechat, 'Abc_12345', 'case preserved');
    assert.equal(detectContactInfo('wx Lucky-2026').wechat, 'Lucky-2026');
    assert.equal(detectContactInfo('v信 abc123').wechat, 'abc123');
    assert.equal(detectContactInfo('薇信：zhangsan9').wechat, 'zhangsan9');
    assert.equal(detectContactInfo('加我 wxid_ab12cd34').wechat, 'wxid_ab12cd34');
    assert.equal(detectContactInfo('微信13800001234').wechat, '13800001234');
    assert.deepEqual(detectContactInfo('电话13800001234，微信同号'), { phone: '13800001234', wechat: '13800001234' });
    assert.deepEqual(detectContactInfo('微信 12345'), {});
    assert.deepEqual(detectContactInfo('微信支付可以吗'), {});
    assert.deepEqual(detectContactInfo('微信 abc'), {}, 'too short');
  });
});

describe('conversation NLU: intents', () => {
  const intents = (t: string) => detectConversationIntents(t).intents;

  it('detects appointment + contact exchange with verbatim evidence', () => {
    const text = '好的，这周六下午可以过去看车，我电话13800001234';
    const r = detectConversationIntents(text);
    assert.deepEqual(r.intents, ['appointment', 'contact_exchange']);
    assert.equal(r.evidence.length, 2);
    for (const e of r.evidence) assert.ok(isVerbatimQuote(text, e.quote), `non-verbatim quote: ${e.quote}`);
  });

  it('detects refusals but stays negation-aware', () => {
    assert.deepEqual(intents('不需要，别再发了'), ['not_interested']);
    const finance = intents('不需要贷款，全款');
    assert.ok(finance.includes('finance_query'));
    assert.ok(!finance.includes('not_interested'));
    assert.deepEqual(intents('已经在别家订了'), ['not_interested']);
    assert.deepEqual(intents('不用了，谢谢'), ['not_interested']);
    assert.ok(!intents('打扰一下，i3有现车吗').includes('not_interested'), 'polite 打扰一下');
    const priceNoFinance = intents('先不考虑贷款，i3什么价');
    assert.deepEqual(priceNoFinance, ['price_query', 'finance_query']);
    assert.deepEqual(intents('不考虑Model 3了'), ['general'], 'rejecting a competitor is not a refusal');
  });

  it('detects the transaction intents', () => {
    assert.deepEqual(intents('旧车置换有补贴吗'), ['trade_in']);
    assert.deepEqual(intents('和GLC比怎么样'), ['model_comparison']);
    assert.deepEqual(intents('i3和Model 3哪个好'), ['model_comparison']);
    assert.deepEqual(intents('i3落地多少'), ['price_query']);
    assert.deepEqual(intents('35L还有现车吗'), ['inventory_query']);
    assert.deepEqual(intents('可以做以租代购吗'), ['lease_query']);
    assert.deepEqual(intents('首付多少，月供呢'), ['finance_query'], "'首付多少' is a finance question, not a price question");
    assert.deepEqual(intents('明天下午有空'), ['appointment']);
    assert.deepEqual(intents('加个微信聊'), ['contact_exchange']);
    assert.deepEqual(intents('不去看车了'), ['general'], 'a negated visit is not an appointment');
  });

  it("falls back to 'general'", () => {
    const r = detectConversationIntents('好的谢谢');
    assert.deepEqual(r.intents, ['general']);
    assert.equal(r.evidence[0].quote, '好的谢谢');
    assert.deepEqual(detectConversationIntents('').intents, ['general']);
  });
});

describe('conversation NLU: slots', () => {
  const opts = { now: NOW, tz: TZ };

  it('extracts appointment, phone and timeframe from the reference reply', () => {
    const s = extractSlots('好的，这周六下午可以过去看车，我电话13800001234', { ...opts, previous: { model: 'i3', trim: 'eDrive35L' } });
    assert.equal(s.appointment_intent, true);
    assert.equal(s.appointment_time_text, '这周六下午');
    assert.equal(s.appointment_at, '2026-09-12T06:00:00.000Z');
    assert.equal(s.contact_phone, '13800001234');
    assert.equal(s.model, 'i3', 'previous slots preserved');
    assert.equal(s.trim, 'eDrive35L');
  });

  it('resolves a bare time only in an appointment context', () => {
    const noContext = extractSlots('今天优惠多少', opts);
    assert.equal(noContext.appointment_at, undefined);
    const followUp = extractSlots('明天上午', { ...opts, previous: { appointment_intent: true, model: 'i3' } });
    assert.equal(followUp.appointment_at, '2026-09-13T02:00:00.000Z');
    assert.equal(followUp.appointment_time_text, '明天上午');
    const cancelled = extractSlots('周六去不了了', { ...opts, previous: { appointment_intent: true } });
    assert.equal(cancelled.appointment_intent, false);
  });

  it('handles financing negation and full payment', () => {
    assert.equal(extractSlots('不需要贷款，全款', opts).financing, false);
    assert.equal(extractSlots('首付可以做两成吗', opts).financing, true);
    assert.equal(extractSlots('全款', { ...opts, previous: { financing: true } }).financing, false);
    assert.equal(extractSlots('全款还是贷款划算', { ...opts, previous: { financing: true } }).financing, true, 'ambiguous keeps previous');
    assert.equal(extractSlots('以租代购怎么算', opts).leasing, true);
    assert.equal(extractSlots('不做融资租赁', opts).leasing, false);
  });

  it('extracts trade-in and the trade-in vehicle without mistaking it for the desired model', () => {
    const s = extractSlots('旧车是16年的奥迪A4L，想置换', { ...opts, previous: { model: 'i3' } });
    assert.equal(s.trade_in, true);
    assert.equal(s.trade_in_vehicle, '16年的奥迪A4L');
    assert.equal(s.model, 'i3');
    assert.equal(extractSlots('旧车置换有补贴吗', opts).trade_in, true);
    assert.equal(extractSlots('没有旧车，首购', opts).trade_in, false);
  });

  it('tracks comparisons, carried models, trims, budget and location', () => {
    const cmp = extractSlots('和GLC比怎么样', { ...opts, previous: { model: 'X3' } });
    assert.equal(cmp.model, 'X3');
    assert.deepEqual(cmp.competing_models, ['GLC']);

    const carried = extractSlots('Model 3和i3哪个好', { ...opts, carried_models: ['i3', 'X3'] });
    assert.equal(carried.model, 'i3');
    assert.deepEqual(carried.competing_models, ['Model 3']);

    const merged = extractSlots('35L的，预算30万左右，人在杭州，下个月买', { ...opts, previous: { model: 'i3', competing_models: ['Model 3'] } });
    assert.equal(merged.trim, 'eDrive35L');
    assert.equal(merged.budget_min, 270000);
    assert.equal(merged.budget_max, 330000);
    assert.equal(merged.location, '杭州');
    assert.equal(merged.purchase_timeframe, 'within_3_months');
    assert.deepEqual(merged.competing_models, ['Model 3']);

    const switched = extractSlots('还是看看X3吧', { ...opts, previous: { model: 'i3', trim: 'eDrive35L' } });
    assert.equal(switched.model, 'X3');
    assert.equal(switched.trim, undefined, 'trim of the old model is cleared');

    const trimOnly = extractSlots('40L有吗', opts);
    assert.equal(trimOnly.model, 'i3');
    assert.equal(trimOnly.trim, 'eDrive40L');
  });

  it('extracts WeChat and never mutates the previous slots object', () => {
    const previous = Object.freeze({ model: 'i3', competing_models: Object.freeze(['Model 3']) as unknown as string[] });
    const s = extractSlots('我微信是wang_lei88，和SU7比怎么样', { ...opts, previous });
    assert.equal(s.contact_wechat, 'wang_lei88');
    assert.deepEqual(s.competing_models, ['Model 3', 'SU7']);
    assert.deepEqual(previous.competing_models, ['Model 3']);
  });

  it('combines intents, evidence and slots', () => {
    const r = analyzeConversationMessage('不需要，别再发了', { ...opts, previous: { appointment_intent: true } });
    assert.deepEqual(r.intents, ['not_interested']);
    assert.equal(r.slots.appointment_intent, false);
    assert.ok(r.evidence.every((e) => isVerbatimQuote('不需要，别再发了', e.quote)));
  });

  it('resolves calendar purchase timeframes against the message time', () => {
    assert.equal(extractSlots('打算国庆前买，杭州i3有现车吗', opts).purchase_timeframe, 'this_month');
    assert.equal(extractSlots('10月底买', opts).purchase_timeframe, 'within_3_months');
    const november = { now: new Date('2026-11-05T02:00:00.000Z'), tz: TZ };
    assert.equal(extractSlots('10月底买', november).purchase_timeframe, undefined, 'a past month is not a purchase plan');
    assert.equal(
      extractSlots('10月底买', { ...november, previous: { purchase_timeframe: 'this_month' } }).purchase_timeframe,
      'this_month',
      'an unresolvable expression keeps the previous slot',
    );
  });
});
