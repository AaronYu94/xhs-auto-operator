import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FactRef } from '../../../src/core/types.ts';
import { answerFact, extractClaims, importDealerBrain, verifyClaims } from '../../../src/skills/operations/dealer-brain/index.ts';
import { createTestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, readDealerFixture, vehicleIdByKey } from '../../helpers/fixtures.ts';

function setup() {
  const ctx = createTestContext();
  const s = loadDealerFixture(ctx);
  const hz = dealerIdByKey(s, 'hz-bmw');
  const offerRef = (title: string, claim: string): FactRef => {
    const row = ctx.db.table('offers').findOne({ dealer_id: hz, title });
    assert.ok(row, title);
    return { kind: 'offer', id: row.id, claim };
  };
  const price35 = answerFact(ctx, hz, { kind: 'price', model: 'i3', trim: '35L' });
  const whiteRed = answerFact(ctx, hz, { kind: 'inventory', model: 'i3', trim: '35L', exterior_color: '白', interior_color: '红' });
  const black = answerFact(ctx, hz, { kind: 'inventory', model: 'i3', trim: '35L', exterior_color: '黑' });
  return { ctx, s, hz, offerRef, price35, whiteRed, black };
}

describe('dealer-brain hardening: claim semantics', () => {
  it('a 指导价 claim can only be backed by MSRP / list price, a 优惠 claim only by an offer amount', () => {
    const { ctx, hz, price35 } = setup();
    // price35 facts include the i3 cash offer (amount 90000) and the eDrive35L MSRP (353900)
    const fakeMsrp = verifyClaims(ctx, hz, '宝马i3 eDrive35L指导价9万', price35.facts);
    assert.equal(fakeMsrp.passed, false, 'an offer amount must not back a 指导价 claim');
    assert.deepEqual(fakeMsrp.unverified_claims, ['9万']);

    const fakeDiscount = verifyClaims(ctx, hz, '宝马i3 eDrive35L现在优惠35.39万', price35.facts);
    assert.equal(fakeDiscount.passed, false, 'an MSRP must not back a 优惠 claim');
    assert.deepEqual(fakeDiscount.unverified_claims, ['35.39万']);

    assert.equal(verifyClaims(ctx, hz, '宝马i3 eDrive35L指导价35.39万，现在优惠9万', price35.facts).passed, true);
  });

  it('claims are scoped to the vehicles named in the same sentence', () => {
    const { ctx, hz, price35, whiteRed, offerRef } = setup();
    const x3Msrp = verifyClaims(ctx, hz, '宝马X3指导价35.39万', price35.facts);
    assert.equal(x3Msrp.passed, false, 'an i3 MSRP cannot back a price stated for the X3');

    const wrongTrimStock = verifyClaims(ctx, hz, '宝马i3 eDrive40L有现车', whiteRed.facts);
    assert.equal(wrongTrimStock.passed, false, 'eDrive35L stock cannot back an eDrive40L stock claim');
    assert.deepEqual(wrongTrimStock.unverified_claims, ['现车']);

    const i3Cash = offerRef('i3金九限时优惠', 'i3金九限时优惠');
    assert.equal(verifyClaims(ctx, hz, '宝马X3现在优惠9万', [i3Cash]).passed, false, 'i3 offer cannot back an X3 discount');
    assert.equal(verifyClaims(ctx, hz, '宝马i3现在优惠9万', [i3Cash]).passed, true);
    assert.equal(
      verifyClaims(ctx, hz, '宝马X3也可以看看。宝马i3 eDrive40L现在优惠9万', [i3Cash]).passed,
      true,
      'a model-level offer covers every trim; other sentences do not change the subject',
    );

    const tradeIn = offerRef('置换补贴', '补贴8000元');
    assert.equal(verifyClaims(ctx, hz, '宝马X3置换补贴8000元', [tradeIn]).passed, true, 'all-model offers apply to any vehicle');
  });

  it('inventory claims must match the stated colours and never exceed the stocked quantity', () => {
    const { ctx, hz, whiteRed, black } = setup();
    assert.equal(verifyClaims(ctx, hz, '宝马i3 eDrive35L白外红内现车1台', whiteRed.facts).passed, true);
    const wrongColour = verifyClaims(ctx, hz, '宝马i3 eDrive35L蓝外红内现车1台', whiteRed.facts);
    assert.equal(wrongColour.passed, false, 'a white/red car cannot back a blue/red stock claim');

    const inflated = verifyClaims(ctx, hz, '宝马i3 eDrive35L白外红内现车3台', whiteRed.facts);
    assert.equal(inflated.passed, false, 'only 1 white/red car is in stock');
    assert.deepEqual(inflated.unverified_claims, ['现车3台']);

    assert.equal(verifyClaims(ctx, hz, '宝马i3 eDrive35L黑外黑内现车2台', black.facts).passed, true);
    assert.equal(verifyClaims(ctx, hz, '宝马i3 eDrive35L有3台现车', [...whiteRed.facts, ...black.facts]).passed, true, '1 + 2 in stock');
    assert.equal(verifyClaims(ctx, hz, '宝马i3 eDrive35L有4台现车', [...whiteRed.facts, ...black.facts]).passed, false);
    assert.equal(verifyClaims(ctx, hz, '宝马i3 eDrive35L白色现车', black.facts).passed, false, 'single colour word is checked too');
  });

  it('descriptive colour labels produced by answerFact still verify', () => {
    const ctx = createTestContext();
    const bundle = readDealerFixture();
    const row = bundle.inventory.find((i) => i.exterior_color === '白' && i.interior_color === '红')!;
    row.exterior_color = '矿石白';
    row.interior_color = '珊瑚红';
    const s = importDealerBrain(ctx, bundle);
    const hz = dealerIdByKey(s, 'hz-bmw');
    const a = answerFact(ctx, hz, { kind: 'inventory', model: 'i3', trim: '35L', exterior_color: '白', interior_color: '红' });
    assert.ok(a.text.includes('矿石白外观、珊瑚红内饰现车1台'), a.text);
    const check = verifyClaims(ctx, hz, a.text, a.facts);
    assert.equal(check.passed, true, check.issues.join(' / '));
  });

  it('landing / transaction prices stated after the number are flagged', () => {
    const { ctx, hz, price35 } = setup();
    for (const text of ['宝马i3 eDrive35L 35.39万就能落地', '宝马i3 eDrive35L 35.39万落地', '宝马i3 eDrive35L到手价26.39万']) {
      const check = verifyClaims(ctx, hz, text, price35.facts);
      assert.equal(check.passed, false, text);
      assert.ok(check.issues.some((i) => i.includes('落地价')), `${text}: ${check.issues.join(' / ')}`);
    }
  });

  it('only genuine negations or questions exempt inventory words', () => {
    const { ctx, hz } = setup();
    for (const text of ['我们不仅有现车，还能当天提车', '无论什么颜色都有现车', '现车什么颜色都有', '不用等，库存充足']) {
      const check = verifyClaims(ctx, hz, text, []);
      assert.equal(check.passed, false, `${text} is a positive stock claim`);
    }
    for (const text of ['目前没现车了', '这台现车已经售罄', '有没有现车需要跟门店确认', '您要现车还是订车呢？']) {
      const check = verifyClaims(ctx, hz, text, []);
      assert.equal(check.passed, true, `${text}: ${check.issues.join(' / ')}`);
    }
  });

  it('extracts colloquial and Chinese-numeral money, and prefix down payments', () => {
    const { ctx, hz, offerRef } = setup();
    const i3Cash = offerRef('i3金九限时优惠', 'i3金九限时优惠');
    for (const text of ['宝马i3现在优惠九万', '宝马i3现在优惠9w', '宝马i3便宜8000块', '宝马i3优惠¥90,000']) {
      assert.equal(verifyClaims(ctx, hz, text, []).passed, false, `${text} without refs`);
    }
    assert.equal(verifyClaims(ctx, hz, '宝马i3现在优惠九万', [i3Cash]).passed, true);
    assert.equal(verifyClaims(ctx, hz, '宝马i3现在优惠9w', [i3Cash]).passed, true);
    assert.equal(verifyClaims(ctx, hz, '宝马i3现在优惠十二万', [i3Cash]).passed, false);

    const finance = offerRef('i3 36期0息', 'i3 36期0息');
    assert.equal(verifyClaims(ctx, hz, 'i3三成首付就能开走', []).passed, false);
    assert.equal(verifyClaims(ctx, hz, 'i3三成首付，36期0息', [finance]).passed, true);
    assert.equal(verifyClaims(ctx, hz, 'i3两成首付，36期0息', [finance]).passed, false);

    const values = extractClaims('优惠三十五点三九万，补贴五千九百九十九元，月供5999元/月').map((c) => c.value);
    assert.deepEqual(values, [353900, 5999, 5999]);
    for (const idiom of ['千万别错过试驾', '十万火急', '一块去试驾吧', '200W快充', '保养间隔1万公里']) {
      assert.deepEqual(extractClaims(idiom), [], idiom);
    }
  });

  it('a declared ref whose own claim contradicts its row is an issue and never reported as verified', () => {
    const { ctx, s, hz } = setup();
    const i3 = vehicleIdByKey(s, 'i3-edrive35l');
    const wrong: FactRef = { kind: 'vehicle', id: i3, claim: '指导价36.39万' };
    const inText = verifyClaims(ctx, hz, '宝马i3 eDrive35L指导价36.39万', [wrong]);
    assert.equal(inText.passed, false);
    assert.deepEqual(inText.verified, []);

    const unused = verifyClaims(ctx, hz, '欢迎到店试驾宝马i3。', [wrong]);
    assert.equal(unused.passed, false, 'a fabricated claim in declared refs is itself a fact-review issue');
    assert.ok(unused.issues.some((i) => i.includes('指导价36.39万')));

    const offerAsPrice: FactRef = { kind: 'offer', id: ctx.db.table('offers').findOne({ dealer_id: hz, title: 'i3金九限时优惠' })!.id, claim: '指导价9万' };
    assert.equal(verifyClaims(ctx, hz, '宝马i3指导价9万', [offerAsPrice]).passed, false);
  });
});
