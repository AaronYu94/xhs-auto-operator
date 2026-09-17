import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../../../src/core/errors.ts';
import {
  AD_LAW_ABSOLUTE_TERMS,
  DEFAULT_MAX_LENGTH,
  MAX_EMOJI,
  checkPlatformRules,
  countEmoji,
  detectContactInfoLeak,
  isNearDuplicate,
  skill as complianceSkill,
} from '../../../src/skills/operations/compliance/index.ts';
import { createTestContext } from '../../helpers/context.ts';

const codes = (text: string) => detectContactInfoLeak(text).map((i) => i.code);
const dm = (text: string, prohibited: { phrase: string; reason: string }[] = [], max_length = 300) =>
  checkPlatformRules(text, { prohibited, max_length, channel: 'dm' });
const issueCodes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

describe('compliance: detectContactInfoLeak — positives', () => {
  const cases: [string, string, string][] = [
    // [text, expected code, expected verbatim quote]
    ['V❤：abc12345', 'contact_wechat', 'V❤：abc12345'],
    ['加我V❤：abc12345', 'contact_wechat', '加我V❤：abc12345'],
    ['有需要可以找我，薇信 abc_12345', 'contact_wechat', '薇信 abc_12345'],
    ['微信号:wx_car888 备注小红书', 'contact_wechat', '微信号:wx_car888'],
    ['威信是bmw_hz2026', 'contact_wechat', '威信是bmw_hz2026'],
    ['想了解的加我微信', 'contact_wechat', '加我微信'],
    ['加V详聊', 'contact_wechat', '加V详聊'],
    ['感兴趣➕V', 'contact_wechat', '➕V'],
    ['具体vx私我', 'contact_wechat', 'vx私我'],
    ['方便留个微信吗', 'contact_wechat', '留个微信'],
    ['你有微信吗', 'contact_wechat', '有微信吗'],
    ['电话 138 0000 1234 随时联系', 'contact_phone', '138 0000 1234'],
    ['１３８－００００－１２３４', 'contact_phone', '１３８－００００－１２３４'],
    ['+86 138-0000-1234', 'contact_phone', '+86 138-0000-1234'],
    ['号码一三八零零零零一二三四', 'contact_phone', '一三八零零零零一二三四'],
    ['门店电话0571-88886666', 'contact_phone', '0571-88886666'],
    ['热线400-820-3000', 'contact_phone', '400-820-3000'],
    ['QQ 12345678', 'contact_qq', 'QQ 12345678'],
    ['可以加个qq聊', 'contact_qq', '加个qq聊'],
    ['简历发 sales@bmw-hz.com', 'contact_email', 'sales@bmw-hz.com'],
    ['详情见 https://example.com/offer?id=1，欢迎咨询', 'contact_link', 'https://example.com/offer?id=1'],
    ['官网 www.bmw.com.cn 查看', 'contact_link', 'www.bmw.com.cn'],
    ['官网bmw-hz.cn有活动', 'contact_link', 'bmw-hz.cn'],
    ['扫码加入车友群', 'off_platform_solicitation', '扫码'],
    ['主页有联系方式', 'off_platform_solicitation', '主页有联系方式'],
    ['关注公众号领取购车礼包', 'off_platform_solicitation', '关注公众号'],
    ['有兴趣加我', 'off_platform_solicitation', '加我'],
    ['方便的话留个电话', 'off_platform_solicitation', '留个电话'],
  ];
  for (const [text, code, quote] of cases) {
    it(`flags ${code} in ${JSON.stringify(text)}`, () => {
      const issues = detectContactInfoLeak(text);
      const hit = issues.find((i) => i.code === code);
      assert.ok(hit, `expected ${code}, got ${JSON.stringify(issues)}`);
      assert.equal(hit.quote, quote);
      assert.ok(text.includes(hit.quote!), 'quote must be a verbatim substring of the original text');
      assert.ok(hit.message.length > 0);
    });
  }

  // Hardening pass: evasions that previously slipped through.
  const evasions: [string, string, string][] = [
    ['加我微信（abc12345）', 'contact_wechat', '加我微信（abc12345）'],
    ['微信【abc12345】', 'contact_wechat', '微信【abc12345】'],
    ['vx「bmw_hz88」', 'contact_wechat', 'vx「bmw_hz88」'],
    ['加微：abc12345', 'contact_wechat', '加微：abc12345'],
    ['感兴趣可以加微', 'contact_wechat', '加微'],
    ['➕薇 abc12345', 'contact_wechat', '➕薇 abc12345'],
    ['威 信 abc12345', 'contact_wechat', '威 信 abc12345'],
    ['门店电话（0571）8888 6666', 'contact_phone', '（0571）8888 6666'],
    ['座机0571-8888 6666', 'contact_phone', '0571-8888 6666'],
    ['138/0000/1234', 'contact_phone', '138/0000/1234'],
    ['138💚0000💚1234', 'contact_phone', '138💚0000💚1234'],
    ['官网 bmwhz点com', 'contact_link', 'bmwhz点com'],
    ['bmwhz。cn 查看', 'contact_link', 'bmwhz。cn'],
    ['看车清单在 bmw.store', 'contact_link', 'bmw.store'],
    ['不用留资卡，直接留个电话给我', 'off_platform_solicitation', '留个电话'],
    ['主页简介有联系方式', 'off_platform_solicitation', '主页简介有联系方式'],
    ['搜同名公众号领取资料', 'off_platform_solicitation', '同名公众号'],
  ];
  for (const [text, code, quote] of evasions) {
    it(`flags evasion ${code} in ${JSON.stringify(text)}`, () => {
      const issues = detectContactInfoLeak(text);
      const hit = issues.find((i) => i.code === code);
      assert.ok(hit, `expected ${code}, got ${JSON.stringify(issues)}`);
      assert.equal(hit.quote, quote);
      assert.ok(text.includes(hit.quote!), 'quote must be a verbatim substring of the original text');
    });
  }

  it('reports one merged issue per overlapping contact and keeps distinct kinds apart', () => {
    const issues = detectContactInfoLeak('加我微信abc12345，或者打138 0000 1234');
    assert.deepEqual(
      issues.map((i) => [i.code, i.quote]),
      [
        ['contact_wechat', '加我微信abc12345'],
        ['contact_phone', '138 0000 1234'],
      ],
    );
  });
});

describe('compliance: detectContactInfoLeak — false-positive guards', () => {
  const benign = [
    '支持微信支付和刷卡',
    '到店支持微信扫码支付',
    '宝马3系 325Li 蓝/黑 现车1台',
    '宝马i3 eDrive35L 指导价35.39万，36期0息',
    '最低首付2成，首付最低2成也可以',
    'X3 xDrive30L 3.5L 百公里油耗7.5L',
    '欢迎参加我们的周末试驾活动',
    '可以通过留资卡留下联系方式，我们会尽快联系你',
    '看到你在问杭州i3落地价，这周六门店有白外红内现车，欢迎到店看看',
    '2026年9月12日 10:00 到店',
    '',
    // hardening pass: benign look-alikes of the new evasion patterns
    '2.0T+V型发动机，动力充沛',
    '稍微信任一下我们的专业团队',
    '这是权威信息，请放心',
    '增加微调座椅功能',
    '可以点下方留资卡留下电话，我们尽快联系你',
    '营业时间09:00-18:00，周末不休',
    'Mr.Wang 为你服务',
  ];
  for (const text of benign) {
    it(`does not flag ${JSON.stringify(text)}`, () => {
      assert.deepEqual(detectContactInfoLeak(text), []);
    });
  }
});

describe('compliance: checkPlatformRules', () => {
  it('passes a clean personalized DM', () => {
    const r = dm('你好～看到你在笔记下问杭州i3 35L有没有现车，我们店目前有白外红内现车，指导价35.39万，周末可以来店里看看。');
    assert.equal(r.passed, true, JSON.stringify(r.issues));
    assert.deepEqual(r.issues, []);
  });

  it('flags every built-in advertising-law absolute term with a verbatim quote', () => {
    for (const term of AD_LAW_ABSOLUTE_TERMS) {
      const text = `这台车${term}，欢迎了解`;
      const r = checkPlatformRules(text, { prohibited: [], max_length: 300, channel: 'post' });
      const hit = r.issues.find((i) => i.code === 'ad_law_absolute_term');
      assert.ok(hit, `term ${term} not flagged`);
      assert.ok(text.includes(hit.quote!));
      assert.equal(r.passed, false);
    }
  });

  it('matches absolute terms written with spaces or spelled out', () => {
    for (const [text, quote] of [
      ['百分之百保证提车', '百分之百保证'],
      ['100% 保证提车', '100% 保证'],
      ['全网 最低价', '全网 最低'],
    ] as const) {
      const r = checkPlatformRules(text, { prohibited: [], max_length: 300, channel: 'post' });
      const hit = r.issues.find((i) => i.code === 'ad_law_absolute_term');
      assert.equal(hit?.quote, quote, `${text}: ${JSON.stringify(r.issues)}`);
    }
    const spacedClaim = checkPlatformRules('杭州 NO. 1 宝马店', { prohibited: [{ phrase: 'No.1', reason: '不得宣称第一' }], max_length: 300, channel: 'post' });
    assert.deepEqual(spacedClaim.issues.map((i) => [i.code, i.quote]), [['prohibited_claim', 'NO. 1']]);
  });

  it('matches absolute terms after full-width normalization', () => {
    const r = checkPlatformRules('１００％保证提车', { prohibited: [], max_length: 300, channel: 'post' });
    assert.deepEqual(
      r.issues.map((i) => [i.code, i.quote]),
      [['ad_law_absolute_term', '１００％保证']],
    );
  });

  it('does not treat factual finance terms as lowest-price claims', () => {
    for (const text of ['最低首付2成', '首付最低2成，36期0息', '宝马3系 325Li 指导价35.39万']) {
      const r = checkPlatformRules(text, { prohibited: [], max_length: 300, channel: 'dm' });
      assert.equal(r.passed, true, `${text}: ${JSON.stringify(r.issues)}`);
    }
    const r = checkPlatformRules('全网最低价，最低首付2成', { prohibited: [], max_length: 300, channel: 'post' });
    assert.deepEqual(issueCodes(r), ['ad_law_absolute_term']);
    assert.equal(r.issues[0].quote, '全网最低');
  });

  it('flags dealer-prohibited phrases case-insensitively, honouring the finance exemption', () => {
    const prohibited = [
      { phrase: 'No.1', reason: '不得宣称第一' },
      { phrase: '最低', reason: '不得承诺最低价' },
    ];
    const r = checkPlatformRules('杭州NO.1宝马店，首付最低2成', { prohibited, max_length: 300, channel: 'post' });
    assert.deepEqual(
      r.issues.map((i) => [i.code, i.quote]),
      [['prohibited_claim', 'NO.1']],
    );
    assert.match(r.issues[0].message, /不得宣称第一/);

    const r2 = checkPlatformRules('首付最低2成，本店价格全城最低', { prohibited, max_length: 300, channel: 'post' });
    const claim = r2.issues.find((i) => i.code === 'prohibited_claim');
    assert.equal(claim?.quote, '最低');
    assert.equal(r2.issues.filter((i) => i.code === 'prohibited_claim').length, 1);
  });

  it('enforces max length by characters (emoji count once)', () => {
    const exact = '好'.repeat(299) + '🚗';
    assert.equal(dm(exact).issues.some((i) => i.code === 'too_long'), false);
    const r = dm(exact + '车');
    const tooLong = r.issues.find((i) => i.code === 'too_long');
    assert.ok(tooLong);
    assert.match(tooLong.message, /301字/);
  });

  it('flags excessive emoji (> MAX_EMOJI) including Xiaohongshu emoji codes', () => {
    assert.equal(MAX_EMOJI, 8);
    const eight = '周末来看车😀😀😀😀[赞R][赞R]🚗🚗';
    assert.equal(countEmoji(eight), 8);
    assert.equal(dm(eight).issues.some((i) => i.code === 'excessive_emoji'), false);
    const nine = eight + '🔥';
    assert.equal(countEmoji(nine), 9);
    assert.ok(dm(nine).issues.some((i) => i.code === 'excessive_emoji'));
    assert.equal(countEmoji('BMW™ ©2026'), 0);
  });

  it('counts emoji as rendered glyphs (flags, ZWJ sequences, keycaps)', () => {
    assert.equal(countEmoji('🇨🇳'), 1, 'a flag is one emoji');
    assert.equal(countEmoji('👨‍👩‍👧'), 1, 'a ZWJ family is one emoji');
    assert.equal(countEmoji('👍🏻'), 1, 'skin tone modifier does not add a second emoji');
    assert.equal(countEmoji('1️⃣2️⃣'), 2);
    assert.equal(countEmoji('❤️'), 1);
    const flags = '国庆到店🇨🇳🇨🇳🇨🇳🇨🇳🇨🇳🇨🇳🇨🇳🇨🇳🇨🇳';
    assert.ok(dm(flags).issues.some((i) => i.code === 'excessive_emoji'), 'nine flags exceed the limit');
    assert.equal(dm('全家出游👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧').issues.some((i) => i.code === 'excessive_emoji'), false);
  });

  it('flags repeated punctuation spam but not ordinary punctuation', () => {
    const r = dm('现车到店啦！！！！！快来');
    const spam = r.issues.find((i) => i.code === 'punctuation_spam');
    assert.equal(spam?.quote, '！！！！！');
    assert.equal(dm('现车到店啦！！！快来看看吧～～……').passed, true);
  });

  it('forbids marketing boilerplate only in DMs', () => {
    const text = '【杭州宝马】尊敬的客户，i3限时优惠，回复TD退订';
    const r = dm(text);
    const quotes = r.issues.filter((i) => i.code === 'marketing_boilerplate').map((i) => i.quote);
    assert.ok(quotes.includes('【杭州宝马】'));
    assert.ok(quotes.includes('尊敬的客户'));
    assert.ok(quotes.includes('回复TD退订'));
    const post = checkPlatformRules(text, { prohibited: [], max_length: 300, channel: 'post' });
    assert.equal(post.issues.some((i) => i.code === 'marketing_boilerplate'), false);
  });

  it('forbids all links in DMs, and external links everywhere', () => {
    // unlisted TLD with a path + on-platform short link: only the DM channel forbids them
    const dmIssues = dm('车型配置表见 bmw.gallery/i3 和 xhslink').issues;
    assert.deepEqual(
      dmIssues.filter((i) => i.code === 'link_in_dm').map((i) => i.quote),
      ['bmw.gallery/i3', 'xhslink'],
    );
    const comment = checkPlatformRules('车型配置表见 bmw.gallery/i3', { prohibited: [], max_length: 300, channel: 'comment' });
    assert.equal(comment.passed, true);
    // a known external TLD is an off-platform link on every channel
    const storeOnComment = checkPlatformRules('车型配置表见 bmw.store/i3', { prohibited: [], max_length: 300, channel: 'comment' });
    assert.deepEqual(storeOnComment.issues.map((i) => [i.code, i.quote]), [['contact_link', 'bmw.store/i3']]);

    const external = dm('详情 https://example.com/x');
    assert.deepEqual(issueCodes(external), ['contact_link'], 'a link already reported as contact_link is not double-counted');
    const onComment = checkPlatformRules('详情 https://example.com/x', { prohibited: [], max_length: 300, channel: 'comment' });
    assert.deepEqual(issueCodes(onComment), ['contact_link']);
  });

  it('forbids bare domains with less common TLDs in DMs', () => {
    const r = dm('配置单在 bmw.store 可以看');
    assert.equal(r.passed, false);
    assert.ok(
      r.issues.some((i) => (i.code === 'contact_link' || i.code === 'link_in_dm') && i.quote === 'bmw.store'),
      JSON.stringify(r.issues),
    );
  });

  it('includes contact leaks among platform issues and rejects empty text', () => {
    const r = dm('加我微信abc12345');
    assert.equal(r.passed, false);
    assert.deepEqual(issueCodes(r), ['contact_wechat']);
    assert.deepEqual(issueCodes(dm('   ')), ['empty_text']);
  });

  it('validates options', () => {
    assert.throws(() => checkPlatformRules('hi', { prohibited: [], max_length: 0, channel: 'dm' }), ValidationError);
    assert.throws(
      () => checkPlatformRules('hi', { prohibited: [], max_length: 10, channel: 'sms' as unknown as 'dm' }),
      ValidationError,
    );
  });
});

describe('compliance: isNearDuplicate', () => {
  const base = '你好～看到你在问杭州i3 35L的落地价，我们店这周有白外红内现车，欢迎周末来店里看看';

  it('detects identical and lightly edited mass templates', () => {
    assert.deepEqual(isNearDuplicate(base, [base]), { duplicate: true, max_similarity: 1 });
    const edited = base.replace('这周', '本周');
    const r = isNearDuplicate(base, ['宝马X3保养费用一览', edited]);
    assert.equal(r.duplicate, true);
    assert.ok(r.max_similarity >= 0.85 && r.max_similarity < 1);
  });

  it('does not flag genuinely different messages and respects custom thresholds', () => {
    const other = '你好，之前你问X3 xDrive25L的置换补贴，目前旧车置换最高补贴8000元';
    const r = isNearDuplicate(base, [other]);
    assert.equal(r.duplicate, false);
    assert.ok(r.max_similarity < 0.5);
    assert.equal(isNearDuplicate(base, [other], r.max_similarity).duplicate, true);
    assert.deepEqual(isNearDuplicate(base, []), { duplicate: false, max_similarity: 0 });
  });

  it('compares texts without meaningful characters by exact normalized equality', () => {
    assert.equal(isNearDuplicate('👍👍', ['👍👍']).duplicate, true);
    assert.equal(isNearDuplicate('👍', ['🚗']).duplicate, false);
    assert.equal(isNearDuplicate('', ['']).duplicate, false);
  });
});

describe('compliance: skill', () => {
  it('validates input, applies channel defaults and appends near-duplicate issues', async () => {
    const ctx = createTestContext();
    ctx.skills.register(complianceSkill);
    assert.equal(complianceSkill.name, 'compliance');
    await assert.rejects(ctx.skills.invoke(ctx, 'compliance', { text: 'hi' }), ValidationError);

    const out = await ctx.skills.invoke<{ passed: boolean; issues: { code: string }[]; max_length: number }>(
      ctx,
      'compliance',
      { text: '你好，看到你在问i3现车', channel: 'dm', compare_with: ['你好，看到你在问i3现车'] },
    );
    assert.equal(out.max_length, DEFAULT_MAX_LENGTH.dm);
    assert.equal(out.passed, false);
    assert.deepEqual(out.issues.map((i) => i.code), ['near_duplicate']);

    const clean = await ctx.skills.invoke<{ passed: boolean }>(ctx, 'compliance', {
      text: '周末门店有i3试驾活动',
      channel: 'post',
      prohibited: [{ phrase: '最低价' }],
    });
    assert.equal(clean.passed, true);
  });
});
