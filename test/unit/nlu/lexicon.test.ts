import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CITY_PROVINCE,
  PROVINCES,
  competitorsOf,
  detectTimeframe,
  findBrands,
  findLocation,
  findModels,
  findTrims,
  isNegatedAt,
  mapText,
  modelDisplayName,
  parseBudget,
  parseChineseNumber,
  provinceOfIp,
  rawSlice,
  resolveModelName,
} from '../../../src/domain/automotive-lexicon.ts';

const models = (text: string, context?: string) => findModels(text, { context }).map((m) => m.model);

describe('automotive lexicon: models & brands', () => {
  it('resolves rich aliases to canonical model names', () => {
    const cases: [string, string][] = [
      ['宝马i3值得买吗', 'i3'],
      ['i3怎么样', 'i3'],
      ['3系落地多少', '3 Series'],
      ['三系怎么样', '3 Series'],
      ['五系行政', '5 Series'],
      ['325Li有现车吗', '3 Series'],
      ['330Li白色', '3 Series'],
      ['新X3和老款', 'X3'],
      ['x3 25L', 'X3'],
      ['530Li优惠', '5 Series'],
      ['奔驰GLC260L', 'GLC'],
      ['GLC怎么样', 'GLC'],
      ['奔驰C级', 'C-Class'],
      ['奔驰C怎么样', 'C-Class'],
      ['奥迪Q5和别的比', 'Q5L'],
      ['Q5L落地', 'Q5L'],
      ['A4L多少钱', 'A4L'],
      ['Model 3', 'Model 3'],
      ['model3性价比', 'Model 3'],
      ['毛豆3提车', 'Model 3'],
      ['毛豆Y', 'Model Y'],
      ['Model Y长续航', 'Model Y'],
      ['汉EV', 'Han'],
      ['比亚迪汉', 'Han'],
      ['小米SU7', 'SU7'],
      ['SU7 Ultra', 'SU7'],
      ['蔚来ET5', 'ET5'],
      ['XC60', 'XC60'],
      ['雷克萨斯NX', 'NX'],
      ['ＢＭＷ　Ｘ３', 'X3'],
    ];
    for (const [text, expected] of cases) assert.deepEqual(models(text), [expected], text);
  });

  it('is word-boundary aware for Latin aliases and prefers the longest alias', () => {
    assert.deepEqual(models('现代i30怎么样'), []);
    assert.deepEqual(models('Mi3是什么'), []);
    assert.deepEqual(models('新iX3和X3哪个好'), ['iX3', 'X3']);
    assert.deepEqual(models('iX3续航'), ['iX3']);
    assert.deepEqual(models('C级车里面选哪个'), [], "'C级车' is a segment, not Mercedes C-Class");
    assert.deepEqual(models('武汉ev车主'), [], "'武汉' must not produce BYD Han");
  });

  it("treats 'M3' / 'MY' as ambiguous unless Tesla context is present", () => {
    assert.deepEqual(models('宝马M3太帅了'), []);
    assert.deepEqual(models('特斯拉M3和宝马i3'), ['Model 3', 'i3']);
    assert.deepEqual(models('M3现在优惠多少', '特斯拉Model 3降价了'), ['Model 3']);
  });

  it('returns verbatim quotes even for full-width / mixed-case input', () => {
    const text = '想买ＢＭＷ　ｉ３，Model  3也行';
    for (const m of findModels(text)) assert.ok(text.includes(m.quote), `quote ${m.quote} not verbatim`);
    for (const b of findBrands(text)) assert.ok(text.includes(b.quote), `quote ${b.quote} not verbatim`);
    assert.deepEqual(findBrands(text).map((b) => b.brand), ['BMW']);
    const mt = mapText('ＢＭＷ　Ｘ３');
    assert.equal(mt.norm, 'bmw x3');
    assert.equal(rawSlice(mt, 4, 6), 'Ｘ３');
  });

  it('finds brands including slang', () => {
    assert.deepEqual(
      findBrands('别摸我和奔驰、奥迪、特斯拉').map((b) => b.brand),
      ['BMW', 'Mercedes-Benz', 'Audi', 'Tesla'],
    );
    assert.deepEqual(findBrands('小米手机'), [], "bare '小米' is not the car brand");
  });

  it('resolves canonical names from aliases', () => {
    assert.equal(resolveModelName('宝马3系'), '3 Series');
    assert.equal(resolveModelName('model3'), 'Model 3');
    assert.equal(resolveModelName('i3'), 'i3');
    assert.equal(resolveModelName('不存在的车'), null);
  });
});

describe('automotive lexicon: trims', () => {
  it('maps trim aliases and restricts to the given model', () => {
    assert.deepEqual(findTrims('杭州i3 35L落地多少'), [{ model: 'i3', trim: 'eDrive35L', quote: 'i3 35L' }]);
    assert.deepEqual(findTrims('eDrive 40L有现车吗').map((t) => t.trim), ['eDrive40L']);
    assert.deepEqual(findTrims('x3 25L和30L', 'X3').map((t) => t.trim), ['xDrive25L', 'xDrive30L']);
    assert.deepEqual(findTrims('35L', 'X3'), [], '35L is an i3 trim, not X3');
    assert.deepEqual(findTrims('i335L').map((t) => t.trim), ['eDrive35L'], "'i335L' is 'i3 35L' typed without a space");
    assert.deepEqual(findTrims('油箱135L'), [], 'no match inside longer numbers');
    assert.deepEqual(models('三系还是五系'), ['3 Series', '5 Series']);
  });

  it('accepts Dealer-Brain trims and aliases not in the lexicon', () => {
    const extra = [{ model: 'i5', trim: 'eDrive35L', aliases: ['i5 35L', '行政版'] }];
    assert.deepEqual(findTrims('i5行政版有吗', 'i5', extra).map((t) => t.trim), ['eDrive35L']);
    assert.deepEqual(
      findModels('i5多少钱', { extra: [{ brand: 'BMW', model: 'i5' }] }).map((m) => m.model),
      ['i5'],
    );
  });
});

describe('automotive lexicon: locations', () => {
  it('covers ≥ 40 cities including the required list, each mapped to a valid province', () => {
    const required = ['杭州', '宁波', '温州', '绍兴', '嘉兴', '湖州', '金华', '台州', '上海', '北京', '深圳', '广州', '苏州', '南京', '无锡', '成都', '重庆', '武汉', '西安', '长沙', '合肥', '郑州', '济南', '青岛', '天津', '厦门', '福州'];
    assert.ok(Object.keys(CITY_PROVINCE).length >= 40);
    for (const c of required) assert.ok(CITY_PROVINCE[c], `missing city ${c}`);
    assert.equal(PROVINCES.length, 34);
    for (const p of Object.values(CITY_PROVINCE)) assert.ok(PROVINCES.includes(p), `invalid province ${p}`);
  });

  it('recognizes every provincial division by short name', () => {
    for (const p of PROVINCES) {
      const loc = findLocation(`我在${p}`);
      assert.equal(loc?.province, p, p);
    }
    assert.deepEqual(findLocation('浙江省的朋友'), { province: '浙江', quote: '浙江省' });
  });

  it('prefers the city, resolves aliases, and avoids false positives', () => {
    assert.deepEqual(findLocation('杭州i3 35L落地多少'), { city: '杭州', province: '浙江', quote: '杭州' });
    assert.deepEqual(findLocation('浙江苏州都行'), { city: '苏州', province: '江苏', quote: '苏州' });
    assert.deepEqual(findLocation('魔都哪家店靠谱'), { city: '上海', province: '上海', quote: '魔都' });
    assert.equal(findLocation('帝都')?.city, '北京');
    assert.equal(findLocation('杭城提车')?.city, '杭州');
    assert.equal(findLocation('杭的朋友'), null, "'杭' alone is not a location");
    assert.equal(findLocation('上海南站附近')?.city, '上海');
    assert.equal(findLocation('南京路步行街'), null, 'street names are not stated locations');
    assert.equal(findLocation('北京时间八点'), null);
    assert.equal(findLocation('杭州路况还行')?.city, '杭州');
  });

  it('parses IP 属地 variants', () => {
    assert.equal(provinceOfIp('IP属地：浙江'), '浙江');
    assert.equal(provinceOfIp('IP属地: 广东'), '广东');
    assert.equal(provinceOfIp('浙江'), '浙江');
    assert.equal(provinceOfIp('浙江省'), '浙江');
    assert.equal(provinceOfIp('广西壮族自治区'), '广西');
    assert.equal(provinceOfIp('上海'), '上海');
    assert.equal(provinceOfIp('杭州'), '浙江');
    assert.equal(provinceOfIp('美国'), null);
    assert.equal(provinceOfIp(''), null);
    assert.equal(provinceOfIp(null), null);
    assert.equal(provinceOfIp(undefined), null);
  });
});

describe('automotive lexicon: competitors & display names', () => {
  it('returns symmetric competitor sets', () => {
    assert.deepEqual(competitorsOf('BMW', 'i3').map((c) => c.model), ['Model 3', 'SU7', 'Han', 'ET5']);
    assert.ok(competitorsOf('BMW', 'X3').some((c) => c.model === 'GLC' && c.model_zh === 'GLC'));
    assert.ok(competitorsOf('Mercedes-Benz', 'GLC').some((c) => c.brand === 'BMW' && c.model === 'X3'));
    assert.ok(competitorsOf('Tesla', 'Model 3').some((c) => c.model === 'i3'));
    assert.ok(competitorsOf('宝马', '3 Series').some((c) => c.model === 'C-Class' && c.model_zh === 'C级'));
    assert.deepEqual(competitorsOf('Audi', 'i3'), [], 'brand mismatch');
    assert.deepEqual(competitorsOf('BMW', 'Z4'), [], 'unknown model');
  });

  it('formats display names in Chinese (default) and English', () => {
    assert.equal(modelDisplayName('BMW', 'i3'), '宝马i3');
    assert.equal(modelDisplayName('BMW', 'i3', 'en'), 'BMW i3');
    assert.equal(modelDisplayName('BMW', '3 Series'), '宝马3系');
    assert.equal(modelDisplayName('BMW', '3 Series', 'en'), 'BMW 3 Series');
    assert.equal(modelDisplayName('Tesla', 'Model 3'), '特斯拉Model 3');
    assert.equal(modelDisplayName('Mercedes-Benz', 'C-Class'), '奔驰C级');
    assert.equal(modelDisplayName('BMW', 'i5'), '宝马i5', 'unknown model keeps the given name');
    assert.equal(modelDisplayName('XPeng', 'X9'), '小鹏X9');
    assert.equal(modelDisplayName('', 'ZZ9'), 'ZZ9', 'a model nobody knows, with no brand, is returned as typed');
  });
});

describe('automotive lexicon: numbers, budget, timeframe, negation', () => {
  it('parses Chinese numerals', () => {
    assert.equal(parseChineseNumber('二十五'), 25);
    assert.equal(parseChineseNumber('十五'), 15);
    assert.equal(parseChineseNumber('一百零五'), 105);
    assert.equal(parseChineseNumber('两'), 2);
    assert.equal(parseChineseNumber('25.5'), 25.5);
    assert.equal(parseChineseNumber('abc'), null);
  });

  it('parses budgets and ignores prices, discounts and down payments', () => {
    const b = (t: string) => {
      const r = parseBudget(t);
      return r ? [r.budget_min, r.budget_max] : null;
    };
    assert.deepEqual(b('25万'), [250000, 250000]);
    assert.deepEqual(b('25w'), [250000, 250000]);
    assert.deepEqual(b('预算30万'), [300000, 300000]);
    assert.deepEqual(b('20-25万'), [200000, 250000]);
    assert.deepEqual(b('20到25万的车'), [200000, 250000]);
    assert.deepEqual(b('二十五万'), [250000, 250000]);
    assert.deepEqual(b('30万左右'), [270000, 330000]);
    assert.deepEqual(b('30万以内'), [undefined, 300000]);
    assert.deepEqual(b('30万以上'), [300000, undefined]);
    assert.deepEqual(b('三十多万'), [300000, 400000]);
    assert.deepEqual(b('预算30左右'), [270000, 330000]);
    assert.equal(b('优惠2万'), null);
    assert.equal(b('首付10万月供多少'), null);
    assert.equal(b('指导价35万'), null);
    assert.equal(b('跑了2w公里'), null);
    assert.equal(b('几十万的车'), null);
    const quote = parseBudget('3系还是C级，预算30万')!.quote;
    assert.ok('3系还是C级，预算30万'.includes(quote));
  });

  it('detects the nearest purchase timeframe and ignores non-temporal uses', () => {
    const tf = (t: string) => detectTimeframe(t)?.timeframe ?? null;
    assert.equal(tf('这周想去看看'), 'this_week');
    assert.equal(tf('周末去店里'), 'this_week');
    assert.equal(tf('本月准备提'), 'this_month');
    assert.equal(tf('月底前定下来'), 'this_month');
    assert.equal(tf('最近想买i3'), 'soon');
    assert.equal(tf('尽快提车'), 'soon');
    assert.equal(tf('下个月再说'), 'within_3_months');
    assert.equal(tf('三个月内换车'), 'within_3_months');
    assert.equal(tf('年底前提车'), 'within_3_months');
    assert.equal(tf('明年再买'), 'later');
    assert.equal(tf('最近i3优惠多少'), null, "'最近' without a purchase verb is not timing");
    assert.equal(tf('宝马上市了'), null, "'马上' inside '宝马上市'");
    assert.equal(tf('下周或者明年'), 'soon');
  });

  it('is negation aware with A-不-A questions and 没 questions', () => {
    const neg = (t: string, kw: string) => {
      const mt = mapText(t);
      return isNegatedAt(mt, mt.norm.indexOf(kw));
    };
    assert.equal(neg('不需要贷款', '贷款'), true);
    assert.equal(neg('我不置换', '置换'), true);
    assert.equal(neg('没有旧车', '旧车'), true);
    assert.equal(neg('要不要贷款', '贷款'), false);
    assert.equal(neg('需不需要置换', '置换'), false);
    assert.equal(neg('贷不贷款', '贷款'), false);
    assert.equal(neg('没有优惠吗', '优惠'), false);
    assert.equal(neg('不知道贷款利率', '贷款'), false);
  });
});

describe('automotive lexicon: calendar timeframes are relative to now', () => {
  const NOW = new Date('2026-09-12T02:00:00.000Z'); // Saturday 2026-09-12 10:00 Asia/Shanghai
  const TZ = 'Asia/Shanghai';
  /** `now: null` evaluates without a reference time */
  const tf = (t: string, now: Date | null = NOW, tz = TZ) => detectTimeframe(t, now ? { now, tz } : {})?.timeframe ?? null;

  it('places month parts of the current month and upcoming months', () => {
    assert.equal(tf('9月底前定下来'), 'this_month');
    assert.equal(tf('九月底提车'), 'this_month');
    assert.equal(tf('9月中旬去看'), 'this_month', '11–20 September contains today');
    assert.equal(tf('9月初去看'), null, '1–10 September is already over');
    assert.equal(tf('10月前买'), 'this_month', 'before October 1 = within this month');
    assert.equal(tf('10月底买'), 'within_3_months');
    assert.equal(tf('十一月提车'), 'within_3_months');
    assert.equal(tf('12月份再买'), 'within_3_months', 'December 1 is 80 days away');
    assert.equal(tf('12月底再买'), 'later', 'late December is more than 3 months away');
  });

  it('resolves National Day relative to today', () => {
    assert.equal(tf('想国庆前买'), 'this_month');
    assert.equal(tf('国庆期间去看车'), 'within_3_months');
    assert.equal(tf('十一假期去店里'), 'within_3_months');
    assert.equal(tf('国庆后再说'), 'within_3_months');
  });

  it('ignores past months, explicit past years and dates, and never guesses without now', () => {
    assert.equal(tf('8月底去看过'), null);
    assert.equal(tf('去年12月提的'), null);
    assert.equal(tf('2025年10月买的'), null);
    assert.equal(tf('9月20号下午到店'), null, 'dates belong to appointment NLU');
    assert.equal(tf('月供3000'), null);
    assert.equal(tf('9月底前定下来', null), null, "without now '9月底' is not mapped to this month");
    assert.equal(tf('月底前定下来', null), 'this_month', "the relative '月底' still resolves");
    const q = detectTimeframe('打算9月底前定', { now: NOW, tz: TZ });
    assert.equal(q?.quote, '9月底前');
  });

  it('handles explicit and next years, the year boundary and the timezone', () => {
    assert.equal(tf('明年3月再买'), 'later');
    assert.equal(tf('2027年1月提车'), 'later');
    assert.equal(tf('今年10月底买'), 'within_3_months');
    const december = new Date('2026-12-20T02:00:00.000Z');
    assert.equal(tf('1月提车', december), 'within_3_months', 'January is next year');
    assert.equal(tf('明年1月提车', december), 'within_3_months');
    assert.equal(tf('3月提车', december), 'within_3_months');
    assert.equal(tf('5月提车', december), 'later');
    const lateSeptUtc = new Date('2026-09-30T17:00:00.000Z'); // already October 1 in Shanghai
    assert.equal(tf('9月底提车', lateSeptUtc, 'Asia/Shanghai'), null);
    assert.equal(tf('9月底提车', lateSeptUtc, 'UTC'), 'this_month');
    assert.equal(tf('9月底提车', NOW, 'Not/AZone'), 'this_month', 'an invalid timezone falls back to Asia/Shanghai');
    assert.equal(tf('这周或者10月底'), 'this_week', 'the nearest timeframe wins');
  });
});
