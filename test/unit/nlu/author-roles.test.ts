/**
 * Author roles (ARCHITECTURE §5.1, docs/PREVIEW_FINDINGS.md F1/F2), signal-quality precision guards and calendar
 * timeframes relative to the evaluation time.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isVerbatimQuote } from '../../../src/core/evidence.ts';
import { TRANSACTION_QUESTIONS, type AuthorRole, type DealerProfile, type IntentDetection, type SignalContext } from '../../../src/core/types.ts';
import type { LlmJsonRequest, LlmProvider, LlmResult, LlmStatus } from '../../../src/providers/llm/types.ts';
import { detectIntent, refineWithLlm } from '../../../src/skills/acquisition/intent-detection/index.ts';
import {
  NON_BUYER_ROLES,
  analyzeSignal,
  analyzedTextFor,
  detectIntentRules,
  isNonBuyerRole,
} from '../../../src/skills/acquisition/intent-detection/nlu.ts';
import { TEST_NOW, createTestContext } from '../../helpers/context.ts';

const HZ_BMW: DealerProfile = {
  dealer_id: 'dlr_hz_bmw',
  brands: ['BMW'],
  models: ['i3', 'X3', '3 Series'],
  trims: [
    { model: 'i3', trim: 'eDrive35L', aliases: ['35L', 'i3 35L'] },
    { model: 'i3', trim: 'eDrive40L', aliases: ['40L', 'i3 40L'] },
    { model: 'X3', trim: 'xDrive25L', aliases: ['25L', 'X3 25L'] },
    { model: '3 Series', trim: '325Li', aliases: ['325Li'] },
  ],
  inventory: [
    { model: 'i3', trim: 'eDrive35L', exterior_color: '白', interior_color: '红', status: 'in_stock', quantity: 1 },
    { model: 'X3', trim: 'xDrive25L', exterior_color: '白', interior_color: '棕', status: 'in_stock', quantity: 2 },
  ],
  city: '杭州',
  province: '浙江',
};

const I3_TITLE = '宝马i3现在值得买吗？';
const X3_OWN_TITLE = 'X3 25L白外棕内到店啦｜杭州看车找李姐';
const post = (title: string, nickname: string | null = null, ip: string | null = null): SignalContext => ({
  source_type: 'post',
  post_title: title,
  author_nickname: nickname,
  ip_location: ip,
});
const comment = (title: string, nickname: string | null = null, ip: string | null = null): SignalContext => ({
  source_type: 'comment',
  post_title: title,
  author_nickname: nickname,
  ip_location: ip,
});
const detect = (text: string, context: SignalContext) => detectIntentRules(text, context, HZ_BMW);
const TQ_CODES: readonly string[] = TRANSACTION_QUESTIONS;

function assertNonBuyer(d: IntentDetection, role: AuthorRole, code: string, label: string) {
  assert.equal(d.author_role, role, `${label}: role`);
  assert.equal(d.is_purchase_signal, false, `${label}: never a purchase signal`);
  assert.equal(d.strength, 0, `${label}: strength`);
  assert.equal(d.intent.purchase_stage, undefined, `${label}: stage`);
  assert.deepEqual(d.transaction_questions, [], `${label}: questions`);
  assert.ok(d.evidence.some((e) => e.code === code), `${label}: evidence ${code}`);
  assert.ok(!d.evidence.some((e) => TQ_CODES.includes(e.code)), `${label}: no transaction-question evidence survives`);
}

/** Every evidence quote is a verbatim substring of the source named by its source_ref. */
function assertVerbatim(text: string, context: SignalContext, d: IntentDetection) {
  const analyzed = analyzedTextFor(text, context);
  for (const e of d.evidence) {
    const sources =
      e.source_ref === 'post_context'
        ? [context.post_title ?? '', context.post_content ?? '']
        : e.source_ref === 'ip_location'
          ? [context.ip_location ?? '']
          : e.source_ref === 'author_nickname'
            ? [context.author_nickname ?? '']
            : [analyzed];
    assert.ok(e.quote && sources.some((s) => s.includes(e.quote!)), `"${e.quote}" (${e.code}) not verbatim in ${JSON.stringify(sources)}`);
    assert.ok(isVerbatimQuote(sources, e.quote));
    assert.match(e.label, /[一-鿿]/);
  }
}

describe('author roles: creators never become purchase signals (F1)', () => {
  const CREATOR_POSTS: [string, string, string][] = [
    [
      '杭州买宝马攻略｜到店前必看的6件事',
      '在杭州买宝马，到店前先把这几件事做好📝\n1. 明确车型和配置：i3、3系、X3价格区间差很多\n2. 问清落地价包含哪些费用\n3. 有现车吗？现车和订车优惠可能不一样\n4. 贷款、置换政策提前问',
      '杭州买车指南针',
    ],
    [
      '杭州i3试驾体验｜续航、空间、优惠一次说清',
      '周末在杭州试驾了宝马i3 eDrive35L🔋\n优惠：杭州几家门店都有政策，建议提前电话问清楚\ni3值得买吗？喜欢宝马驾驶感的话值得！',
      '杭州小众探店车',
    ],
    [
      I3_TITLE,
      '最近好多粉丝问我宝马i3到底值不值得入手🤔\n开了一周35L，说几点真实感受：\n4️⃣ 价格现在比年初松动不少，具体优惠看各地门店',
      '电车老司机阿杰',
    ],
    [
      'X3和GLC选哪个？30万豪华SUV深度对比',
      '把宝马X3和奔驰GLC开了一个周末，给纠结的朋友一些参考📋\n🔹价格：两台车终端优惠都不小，一定多问几家',
      'SUV测评君',
    ],
  ];

  it('classifies guide / test-drive / KOL review posts as creators with content_creator evidence', () => {
    for (const [title, content, nickname] of CREATOR_POSTS) {
      const ctx = post(title, nickname, '浙江');
      const d = detect(content, ctx);
      assertNonBuyer(d, 'creator', 'content_creator', nickname);
      assert.equal(d.is_marketing, false);
      assert.equal(d.negative, false, `${nickname}: informing is not refusing`);
      assert.equal(d.intent.brand, 'BMW', `${nickname}: vehicle entities are still extracted`);
      const place = d.evidence.find((e) => e.code === 'stated_location');
      if (place) assert.match(place.label, /^提及地点/, `${nickname}: a creator is not a "local buyer"`);
      assertVerbatim(content, ctx, d);
    }
  });

  it('uses creator nickname hints, unless the author asks a buying question', () => {
    const statement = detect('这车续航怎么样', comment(I3_TITLE, '汽车测评小王'));
    assertNonBuyer(statement, 'creator', 'content_creator', 'nickname creator');
    const ev = statement.evidence.find((e) => e.code === 'content_creator')!;
    assert.equal(ev.source_ref, 'author_nickname');
    assert.equal(ev.quote, '测评');
    assertVerbatim('这车续航怎么样', comment(I3_TITLE, '汽车测评小王'), statement);

    const withoutNickname = detect('这车续航怎么样', comment(I3_TITLE));
    assert.equal(withoutNickname.is_purchase_signal, true, 'the same question from anyone else is research');
    assert.equal(withoutNickname.author_role, 'asker');

    const buying = detect('杭州i3 35L现在落地多少？', comment(I3_TITLE, '汽车测评小王'));
    assert.equal(buying.author_role, 'asker');
    assert.equal(buying.is_purchase_signal, true);
  });

  it('keeps a creator-looking post an asker when the author asks for themself', () => {
    const own = detect('我想买35L，杭州哪家店有现车？预算30万左右', post('求推荐｜杭州i3测评看了一堆还是纠结'));
    assert.equal(own.author_role, 'asker');
    assert.equal(own.is_purchase_signal, true);
    assert.equal(own.intent.purchase_stage, 'dealer_selection');

    const weakCue = detect('杭州哪家店可以试驾？这周末有空', post('想去试驾体验一下i3'));
    assert.equal(weakCue.author_role, 'asker', "'体验' is only a weak creator cue; a buying question wins");
    assert.equal(weakCue.intent.purchase_stage, 'purchase_imminent');
  });

  it('treats advice replies that ask nothing as informational', () => {
    const ctx = comment('宝马贷款方案&置换补贴怎么谈？9月政策思路汇总', '汽车金融老K', '江苏');
    const d = detect('各店金融政策不同，建议到店问清楚总成本', ctx);
    assertNonBuyer(d, 'creator', 'content_creator', 'advice reply');
    const asking = detect('建议直接到店看车吗？杭州i3有现车吗', comment(I3_TITLE));
    assert.equal(asking.author_role, 'asker', 'a question is never advice');
    assert.equal(asking.is_purchase_signal, true);
  });
});

describe('author roles: owners are not in the market (F2)', () => {
  it('classifies stated completed purchases as owners (negative, non-signal)', () => {
    const cases: [string, SignalContext][] = [
      [
        '人生第一台宝马终于提啦🎉 分享下在杭州买宝马3系的全过程\n1. 先线上问了三家店的报价，优惠多少差得挺多\n3. 贷款方案选了36期，首付三成',
        post('第一次买宝马｜4S店砍价全过程，落地价公开', '第一次买宝马的Coco', '浙江'),
      ],
      ['开了半年i3，做工和底盘真的好，推荐去试驾对比下', comment('i3和Model 3怎么选？30万预算纠结党看过来')],
      ['同款白红，提车三个月了，很满意', comment('杭州i3 35L白外红内实拍｜店里现车')],
      ['宝马i3提车一年，跑了1.8万公里🚙\n优点：操控好、做工好、电耗低', post('宝马i3开了一年，说说真实感受', 'i3一年车主')],
      ['已经提了Model Y 很香', comment(I3_TITLE)],
      ['我是车主，X3开着很舒服', comment(X3_OWN_TITLE)],
    ];
    for (const [text, ctx] of cases) {
      const d = detect(text, ctx);
      assertNonBuyer(d, 'owner', 'already_purchased', text);
      assert.equal(d.negative, true, `${text}: a stated purchase means not in market`);
      assert.ok(d.evidence.some((e) => e.code === 'negative_feedback'), `${text}: negative marker for stored-signal scoring`);
      assertVerbatim(text, ctx, d);
    }
    const coco = detect(cases[0][0], cases[0][1]);
    assert.ok(coco.evidence.some((e) => e.code === 'content_creator'), 'an owner story is also creator content');
  });

  it('uses the owner nickname hint for remarks, not for the owner’s buying questions', () => {
    const remark = detect('i3冬天续航怎么样？', comment(I3_TITLE, 'i3车主小严', '浙江'));
    assertNonBuyer(remark, 'owner', 'already_purchased', 'nickname owner');
    assert.equal(remark.negative, false, 'a nickname hint is not a stated refusal');
    assert.equal(remark.evidence.find((e) => e.code === 'already_purchased')?.source_ref, 'author_nickname');
    assert.equal(detect('i3冬天续航怎么样？', comment(I3_TITLE)).is_purchase_signal, true, 'control without nickname');

    const shopping = detect('想换X3了，杭州X3 25L有现车吗？', comment(X3_OWN_TITLE, 'i3车主小严'));
    assert.equal(shopping.author_role, 'asker');
    assert.equal(shopping.is_purchase_signal, true);

    const future = detect('i3冬天续航怎么样？', comment(I3_TITLE, '准车主小李'));
    assert.equal(future.author_role, 'asker', "'准车主' is a future owner");
  });

  it('keeps an owner who shops for another car an asker', () => {
    for (const text of ['我是车主，想给老婆再买一台X3，现在优惠多少', '已经提了i3，想再给老婆买一台X3，现在优惠多少']) {
      const d = detect(text, comment(X3_OWN_TITLE));
      assert.equal(d.author_role, 'asker', text);
      assert.equal(d.is_purchase_signal, true, text);
      assert.equal(d.negative, false, text);
      assert.ok(d.transaction_questions.includes('discount'), text);
      assert.ok(!d.evidence.some((e) => e.code === 'already_purchased'), text);
    }
  });

  it('does not treat someone else’s purchase or the trade-in car as ownership', () => {
    const friend = detect('朋友已经提了i3，我也想买，现在优惠多少', comment(I3_TITLE));
    assert.equal(friend.author_role, 'asker');
    assert.equal(friend.is_purchase_signal, true);
    const tradeIn = detect('旧车开了五年，想置换X3，杭州有现车吗', comment(X3_OWN_TITLE));
    assert.equal(tradeIn.author_role, 'asker');
    assert.ok(tradeIn.transaction_questions.includes('inventory'));
  });
});

describe('author roles: marketing, askers and unknown', () => {
  it('emits marketing_account once for solicitation and sets is_marketing', () => {
    const d = detect('宝马i3底价私信我，杭州4S店销售', comment(I3_TITLE, '宝马顾问小陈', '浙江'));
    assert.equal(d.author_role, 'marketing');
    assert.equal(d.is_marketing, true);
    const marketing = d.evidence.filter((e) => e.code === 'marketing_account');
    assert.equal(marketing.length, 1, 'marketing_account is emitted once');
    assert.equal(marketing[0].quote, '私信我');
    assert.match(marketing[0].label, /私信我/);
    assert.match(marketing[0].label, /4S店销售/);
    assert.equal(d.is_purchase_signal, false);
  });

  it('flags dealer-sales nicknames even when the text itself does not solicit', () => {
    const ctx = comment(I3_TITLE, '宝马顾问小陈', '浙江');
    const d = detect('i3现车很多，颜色齐全', ctx);
    assertNonBuyer(d, 'marketing', 'marketing_account', 'dealer nickname');
    assert.equal(d.is_marketing, true);
    assert.equal(d.evidence.find((e) => e.code === 'marketing_account')?.source_ref, 'author_nickname');
    assertVerbatim('i3现车很多，颜色齐全', ctx, d);
  });

  it('keeps genuine askers intact', () => {
    const luna =
      '二胎家庭，老公天天杭州市区通勤，周末带娃去周边玩😭\n预算30万左右，想换一台空间够、开着舒服的SUV\n目前在X3和Q5L之间纠结，有没有车主说说真实感受？\n最好这个月能定下来，求杭州靠谱的门店推荐🙏\n#家用SUV推荐[话题]# #宝马X3[话题]# #奥迪Q5L[话题]#';
    const cases: [string, SignalContext][] = [
      [luna, post('预算30万，杭州，家用SUV推荐？X3还是Q5L', '二胎妈妈Luna', '浙江')],
      ['这台白色35L还在吗？多少钱', comment('杭州i3 35L白外红内实拍｜店里现车', '钱塘江的风', '浙江')],
      ['有白色现车吗', comment(X3_OWN_TITLE, '萧山阿May', '浙江')],
      ['杭州i3 35L白外红内有现车吗？这周想去看看', comment('杭州i3试驾体验｜续航、空间、优惠一次说清', '西湖边的小鹿', '浙江')],
      ['我是车主，想给老婆再买一台X3，现在优惠多少', comment(X3_OWN_TITLE)],
    ];
    for (const [text, ctx] of cases) {
      const d = detect(text, ctx);
      assert.equal(d.author_role, 'asker', text);
      assert.equal(d.is_purchase_signal, true, text);
      assert.equal(d.is_marketing, false, text);
      assert.ok(d.strength > 0, text);
      assertVerbatim(text, ctx, d);
    }
    const lunaDetection = detect(luna, cases[0][1]);
    assert.equal(lunaDetection.intent.purchase_stage, 'purchase_imminent');
    assert.ok(lunaDetection.transaction_questions.includes('dealer_location'), "'靠谱的门店推荐' asks for a dealer");
  });

  it('reports unknown for noise and exposes the non-buyer role set', () => {
    for (const text of ['帅', '哈哈哈 Model Y确实香']) {
      const d = detect(text, comment(I3_TITLE));
      assert.equal(d.author_role, 'unknown', text);
      assert.equal(d.is_marketing, false, text);
    }
    assert.deepEqual([...NON_BUYER_ROLES].sort(), ['creator', 'marketing', 'owner']);
    assert.equal(isNonBuyerRole('asker'), false);
    assert.equal(isNonBuyerRole(null), false);
    assert.equal(isNonBuyerRole('owner'), true);
  });
});

describe('signal quality: precision guards', () => {
  it('ignores price / where-to-buy questions about non-vehicle objects', () => {
    const jacket = detect('博主这件外套哪里买的[偷笑R]', comment(I3_TITLE));
    assert.equal(jacket.is_purchase_signal, false);
    assert.ok(!jacket.transaction_questions.includes('dealer_location'));
    assert.deepEqual(detect('这件外套多少钱', comment(I3_TITLE)).transaction_questions, []);
    const car = detect('这台车在哪买的，杭州有现车吗', comment(I3_TITLE));
    assert.ok(car.transaction_questions.includes('dealer_location'));
    assert.equal(car.intent.purchase_stage, 'dealer_selection');
  });

  it('reads a bare 多少 after a spec or finance term as that term, not the price', () => {
    const fuel = detect('请问油耗大概多少', comment(X3_OWN_TITLE));
    assert.deepEqual(fuel.transaction_questions, []);
    assert.equal(fuel.intent.purchase_stage, 'research');
    assert.deepEqual(detect('贷款方案是怎么谈的？利率多少', comment('第一次买宝马｜4S店砍价全过程，落地价公开')).transaction_questions, ['finance']);
    assert.deepEqual(detect('现在大概多少', comment(I3_TITLE)).transaction_questions, ['price']);
  });

  it('recognizes dealer-selection phrasings with a brand or store noun in between', () => {
    for (const text of ['上海哪家宝马店靠谱', '有没有杭州靠谱的宝马销售推荐', '杭州有没有靠谱的门店推荐']) {
      const d = detect(text, comment(I3_TITLE));
      assert.equal(d.intent.purchase_stage, 'dealer_selection', text);
      assert.ok(d.transaction_questions.includes('dealer_location'), text);
    }
  });

  it('does not read statements about product topics as research', () => {
    assert.equal(detect('红内饰好好看😍', comment('杭州i3 35L白外红内实拍｜店里现车')).is_purchase_signal, false);
    assert.equal(detect('后排一般，一米七五坐着还行，再高就有点压头了', comment(I3_TITLE)).is_purchase_signal, false);
    assert.equal(detect('后排空间怎么样', comment(I3_TITLE)).intent.purchase_stage, 'research');
  });
});

class ScriptedLlm implements LlmProvider {
  readonly name = 'scripted';
  readonly calls: LlmJsonRequest[] = [];
  private readonly data: unknown;
  constructor(data: unknown) {
    this.data = data;
  }
  status(): LlmStatus {
    return { provider: this.name, status: 'AVAILABLE', model: 'test-model', reason: 'test' };
  }
  async completeJson<T>(req: LlmJsonRequest): Promise<LlmResult<T>> {
    this.calls.push(req);
    return { ok: true, data: this.data as T, model: 'test-model' };
  }
  async completeText(): Promise<LlmResult<string>> {
    return { ok: false, reason: 'unused' };
  }
}

describe('author roles: the LLM can never promote a non-buyer', () => {
  const promote = {
    is_purchase_signal: true,
    purchase_stage: 'active_shopping',
    transaction_questions: ['test_drive'],
    evidence: [{ field: 'test_drive', label: '想试驾', quote: '推荐去试驾' }],
  };

  it('refineWithLlm returns the rules detection unchanged for owners / creators / marketing', () => {
    const ctx = comment(I3_TITLE);
    const analysis = analyzeSignal('开了半年i3，做工和底盘真的好，推荐去试驾对比下', ctx, HZ_BMW);
    const r = refineWithLlm(analysis, promote, ctx, HZ_BMW);
    assert.equal(r.detection, analysis.detection);
    assert.deepEqual(r.rejected, ['non_buyer_author_role']);
    assert.equal(r.detection.is_purchase_signal, false);
  });

  it('detectIntent does not call the LLM for non-buyers and audits why', async () => {
    const llm = new ScriptedLlm(promote);
    const ctx = createTestContext({ llm });
    const d = await detectIntent(ctx, {
      text: '最近好多粉丝问我宝马i3到底值不值得入手🤔 开了一周35L，说几点真实感受',
      context: post(I3_TITLE, '电车老司机阿杰', '上海'),
      dealer: HZ_BMW,
      subject: { type: 'post', id: 'ppost_kol' },
    });
    assert.equal(llm.calls.length, 0);
    assert.equal(d.author_role, 'creator');
    assert.equal(d.engine, 'rules');
    const decision = ctx.audit.decisionsFor('post', 'ppost_kol')[0];
    assert.equal((decision.inputs.llm as Record<string, unknown>).skipped_reason, 'author_role:creator');
    assert.equal(decision.output.author_role, 'creator');
    assert.equal(decision.output.is_marketing, false);
  });

  it('an LLM-confirmed need turns an unknown author into an asker', async () => {
    const llm = new ScriptedLlm({
      is_purchase_signal: true,
      purchase_stage: 'active_shopping',
      transaction_questions: ['inventory'],
      evidence: [{ field: 'inventory', label: '关心提车时间', quote: '什么时候能开回家' }],
    });
    const ctx = createTestContext({ llm });
    const d = await detectIntent(ctx, { text: 'i3什么时候能开回家', context: { source_type: 'comment' }, dealer: HZ_BMW });
    assert.equal(llm.calls.length, 1);
    assert.equal(d.is_purchase_signal, true);
    assert.equal(d.author_role, 'asker');
    assert.equal(d.is_marketing, false);
  });
});

describe('intent detection: calendar timeframes relative to the evaluation time', () => {
  const TEXT = '想9月底前提车，杭州i3 35L有现车吗';
  const CTX = comment(I3_TITLE);

  it('detectIntentRules resolves them only with an explicit now', () => {
    const withNow = detectIntentRules(TEXT, CTX, HZ_BMW, { now: new Date(TEST_NOW), tz: 'Asia/Shanghai' });
    assert.equal(withNow.intent.purchase_timeframe, 'this_month');
    assert.equal(withNow.evidence.find((e) => e.code === 'purchase_timeframe')?.quote, '9月底前');
    assert.equal(detectIntentRules(TEXT, CTX, HZ_BMW).intent.purchase_timeframe, undefined, 'never guessed without now');
    const october = detectIntentRules(TEXT, CTX, HZ_BMW, { now: new Date('2026-10-05T02:00:00.000Z') });
    assert.equal(october.intent.purchase_timeframe, undefined, 'a past deadline is not a plan');
    assert.equal(october.is_purchase_signal, true);
  });

  it('detectIntent uses ctx.clock and the given timezone', async () => {
    const september = await detectIntent(createTestContext(), { text: TEXT, context: CTX, dealer: HZ_BMW });
    assert.equal(september.intent.purchase_timeframe, 'this_month');
    const october = await detectIntent(createTestContext({ now: '2026-10-05T02:00:00.000Z' }), { text: TEXT, context: CTX, dealer: HZ_BMW });
    assert.equal(october.intent.purchase_timeframe, undefined);
    const boundary = createTestContext({ now: '2026-09-30T17:00:00.000Z' }); // Oct 1 in Shanghai, Sep 30 in UTC
    assert.equal((await detectIntent(boundary, { text: TEXT, context: CTX, dealer: HZ_BMW })).intent.purchase_timeframe, undefined);
    assert.equal((await detectIntent(boundary, { text: TEXT, context: CTX, dealer: HZ_BMW, tz: 'UTC' })).intent.purchase_timeframe, 'this_month');
  });
});
