import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FactRef } from '../../../src/core/types.ts';
import { answerFact, extractClaims, verifyClaims } from '../../../src/skills/operations/dealer-brain/index.ts';
import { createTestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, vehicleIdByKey } from '../../helpers/fixtures.ts';

function setup() {
  const ctx = createTestContext();
  const s = loadDealerFixture(ctx);
  const hz = dealerIdByKey(s, 'hz-bmw');
  const sh = dealerIdByKey(s, 'sh-bmw');
  const offer = (dealerId: string, title: string) => {
    const row = ctx.db.table('offers').findOne({ dealer_id: dealerId, title });
    assert.ok(row, `offer ${title}`);
    return row;
  };
  const knowledge = (title: string) => {
    const row = ctx.db.table('dealer_knowledge').findOne({ title });
    assert.ok(row, `knowledge ${title}`);
    return row;
  };
  return { ctx, s, hz, sh, offer, knowledge };
}

describe('dealer-brain: verifyClaims', () => {
  it('passes texts built from answerFact facts, including a composed outreach message', () => {
    const { ctx, hz } = setup();
    for (const q of [
      { kind: 'price', model: 'i3' },
      { kind: 'price', model: '3系' },
      { kind: 'inventory', model: 'i3', trim: '35L', exterior_color: '白', interior_color: '红' },
      { kind: 'offer' },
      { kind: 'finance', model: 'i3' },
      { kind: 'lease', model: 'X3' },
      { kind: 'trade_in' },
    ] as const) {
      const a = answerFact(ctx, hz, q);
      const check = verifyClaims(ctx, hz, a.text, a.facts);
      assert.equal(check.passed, true, `${q.kind}: ${check.issues.join(' / ')}`);
      assert.equal(check.verified.length, new Set(a.facts.map((f) => `${f.kind}:${f.id}:${f.claim}`)).size);
    }

    const price = answerFact(ctx, hz, { kind: 'price', model: 'i3', trim: '35L' });
    const inv = answerFact(ctx, hz, { kind: 'inventory', model: 'i3', trim: '35L', exterior_color: '白', interior_color: '红' });
    const message = '您好，杭州宝马中心目前有宝马i3 eDrive35L 白外红内现车1台，eDrive35L指导价35.39万，i3金九限时优惠优惠9万，截止日期9月30日前签约有效。';
    const check = verifyClaims(ctx, hz, message, [...price.facts, ...inv.facts]);
    assert.equal(check.passed, true, check.issues.join(' / '));
    assert.deepEqual(check.unverified_claims, []);
    assert.ok(check.verified.some((f) => f.kind === 'inventory'));
    assert.ok(check.verified.some((f) => f.kind === 'vehicle'));
  });

  it('fails an invented landing price even when other facts are declared', () => {
    const { ctx, hz } = setup();
    const price = answerFact(ctx, hz, { kind: 'price', model: 'i3', trim: '35L' });
    const check = verifyClaims(ctx, hz, '宝马i3 eDrive35L指导价35.39万，杭州落地价18万。', price.facts);
    assert.equal(check.passed, false);
    assert.ok(check.unverified_claims.includes('落地价18万'));
    assert.ok(check.issues.some((i) => i.includes('落地价')));
    assert.ok(check.verified.some((f) => f.kind === 'vehicle'), 'the real MSRP claim is still verified');
  });

  it('fails an invented discount amount', () => {
    const { ctx, hz } = setup();
    const price = answerFact(ctx, hz, { kind: 'price', model: 'i3' });
    const check = verifyClaims(ctx, hz, '宝马i3现在优惠15万，截止日期9月30日。', price.facts);
    assert.equal(check.passed, false);
    assert.deepEqual(check.unverified_claims, ['15万']);
  });

  it('requires a sellable inventory FactRef for 现车 / 在途 claims', () => {
    const { ctx, hz } = setup();
    const price = answerFact(ctx, hz, { kind: 'price', model: 'i3', trim: '35L' });
    const text = '宝马i3 eDrive35L有现车，指导价35.39万';
    const without = verifyClaims(ctx, hz, text, price.facts);
    assert.equal(without.passed, false);
    assert.deepEqual(without.unverified_claims, ['现车']);

    const inv = answerFact(ctx, hz, { kind: 'inventory', model: 'i3', trim: '35L', exterior_color: '白', interior_color: '红' });
    assert.equal(verifyClaims(ctx, hz, text, [...price.facts, ...inv.facts]).passed, true);

    const transitText = '宝马i3 eDrive40L灰色在途，下周到店';
    assert.equal(verifyClaims(ctx, hz, transitText, inv.facts).passed, false, 'in_stock ref cannot back 在途');
    const transit = answerFact(ctx, hz, { kind: 'inventory', model: 'i3', trim: '40L' });
    assert.equal(verifyClaims(ctx, hz, transitText, transit.facts).passed, true);

    const invId = inv.facts[0].id;
    ctx.db.table('inventory').update(invId, { status: 'sold' });
    const sold = verifyClaims(ctx, hz, inv.text, inv.facts);
    assert.equal(sold.passed, false);
    assert.ok(sold.issues.some((i) => i.includes('不可售')));
  });

  it('fails prohibited phrases from Dealer Brain knowledge', () => {
    const { ctx, hz } = setup();
    const check = verifyClaims(ctx, hz, '宝马i3全网最低，欢迎到店。', []);
    assert.equal(check.passed, false);
    assert.ok(check.issues.some((i) => i.includes('全网最低')));
    assert.deepEqual(check.unverified_claims, []);
    const loan = verifyClaims(ctx, hz, '贷款包过贷款，零首付无门槛', []);
    assert.equal(loan.passed, false);
    assert.ok(loan.issues.some((i) => i.includes('包过贷款')));
    assert.ok(loan.issues.some((i) => i.includes('零首付无门槛')));
    assert.deepEqual(loan.unverified_claims, ['零首付'], 'zero down payment is also an unbacked finance claim');
  });

  it('fails an expired-offer FactRef and never lets it back a claim', () => {
    const { ctx, hz, offer } = setup();
    const expired = offer(hz, 'i3八月清库优惠');
    const ref: FactRef = { kind: 'offer', id: expired.id, claim: '优惠12万' };
    const check = verifyClaims(ctx, hz, 'i3八月清库优惠：优惠12万', [ref]);
    assert.equal(check.passed, false);
    assert.ok(check.issues.some((i) => i.includes('有效期')));
    assert.deepEqual(check.unverified_claims, ['12万']);
    assert.deepEqual(check.verified, []);

    const unused = verifyClaims(ctx, hz, '欢迎到店咨询。', [ref]);
    assert.equal(unused.passed, false, 'declaring a stale ref is itself an issue');
  });

  it('fails refs whose numbers do not match or that belong to another dealer', () => {
    const { ctx, s, hz, sh, offer } = setup();
    const i3 = vehicleIdByKey(s, 'i3-edrive35l');
    const wrongMsrp = verifyClaims(ctx, hz, '宝马i3 eDrive35L指导价36.39万', [{ kind: 'vehicle', id: i3, claim: '指导价36.39万' }]);
    assert.equal(wrongMsrp.passed, false);
    assert.deepEqual(wrongMsrp.unverified_claims, ['36.39万']);

    const shOffer = offer(sh, 'X3现金优惠');
    const foreign = verifyClaims(ctx, hz, 'X3现金优惠5.5万', [{ kind: 'offer', id: shOffer.id, claim: '优惠5.5万' }]);
    assert.equal(foreign.passed, false);
    assert.ok(foreign.issues.some((i) => i.includes('不属于该门店')));
    assert.equal(verifyClaims(ctx, sh, 'X3现金优惠5.5万', [{ kind: 'offer', id: shOffer.id, claim: '优惠5.5万' }]).passed, true);

    const missing = verifyClaims(ctx, hz, '优惠9万', [{ kind: 'offer', id: 'ofr_missing', claim: '优惠9万' }]);
    assert.equal(missing.passed, false);
    assert.ok(missing.issues.some((i) => i.includes('不存在')));
  });

  it('does not link a token to a ref claim that only contains it as a digit suffix', () => {
    const { ctx, s, hz } = setup();
    const ref: FactRef = { kind: 'vehicle', id: vehicleIdByKey(s, 'i3-edrive40l'), claim: 'eDrive40L指导价40.39万' };
    const check = verifyClaims(ctx, hz, '宝马i3 eDrive40L指导价40.39万，优惠9万', [ref]);
    assert.equal(check.passed, false);
    assert.deepEqual(check.unverified_claims, ['9万']);
  });

  it('passes text without factual claims, negated stock statements and questions', () => {
    const { ctx, hz } = setup();
    for (const text of [
      '欢迎周末来店里看看，试驾需要携带驾驶证。',
      '目前暂无现车，可以先帮您登记需求。',
      '请问您想看现车吗？',
      '我帮您查一下库存再回复您。',
      'CLTC续航526km，高压电池质保8年或16万公里。',
    ]) {
      const check = verifyClaims(ctx, hz, text, []);
      assert.equal(check.passed, true, `${text}: ${check.issues.join(' / ')}`);
    }
  });

  it('normalizes money, rate, term, down-payment and date formats against offer and knowledge rows', () => {
    const { ctx, hz, offer, knowledge } = setup();
    const tradeIn: FactRef = { kind: 'offer', id: offer(hz, '置换补贴').id, claim: '补贴8000元' };
    for (const text of ['置换补贴8000元', '置换补贴8,000元', '置换补贴0.8万']) {
      assert.equal(verifyClaims(ctx, hz, text, [tradeIn]).passed, true, text);
    }
    assert.equal(verifyClaims(ctx, hz, '置换补贴1万', [tradeIn]).passed, false);

    const lease: FactRef = { kind: 'offer', id: offer(hz, 'X3以租代购').id, claim: 'X3以租代购' };
    assert.equal(verifyClaims(ctx, hz, 'X3以租代购5999元/月，36期，首付2成', [lease]).passed, true);
    assert.equal(verifyClaims(ctx, hz, 'X3以租代购4999元/月', [lease]).passed, false);

    const finance: FactRef = { kind: 'offer', id: offer(hz, 'i3 36期0息').id, claim: 'i3 36期0息' };
    assert.equal(verifyClaims(ctx, hz, 'i3 36期0息，首付30%，零利率', [finance]).passed, true);
    const wrongRate = verifyClaims(ctx, hz, 'i3贷款年利率3.99%，24期', [finance]);
    assert.equal(wrongRate.passed, false);
    assert.deepEqual(wrongRate.unverified_claims, ['3.99%', '24期']);
    assert.equal(verifyClaims(ctx, hz, 'i3首付2成即可提车', [finance]).passed, false);

    const cash: FactRef = { kind: 'offer', id: offer(hz, 'i3金九限时优惠').id, claim: 'i3金九限时优惠' };
    assert.equal(verifyClaims(ctx, hz, 'i3金九限时优惠有效期至2026-09-30', [cash]).passed, true);
    assert.equal(verifyClaims(ctx, hz, '试驾礼活动10月31日前有效', [cash]).passed, false);
    const campaign: FactRef = { kind: 'knowledge', id: knowledge('金九银十试驾季').id, claim: '金九银十试驾季' };
    assert.equal(verifyClaims(ctx, hz, '金九银十试驾季10月31日前到店有礼', [campaign]).passed, true);
  });

  it('extracts typed claims with values', () => {
    const claims = extractClaims('指导价35.39万，优惠9万，置换补贴8,000元，36期0息，首付3成，现车1台，截止9月30日');
    const summary = claims.map((c) => `${c.type}:${c.raw}:${c.value ?? `${c.month}-${c.day}`}`);
    assert.deepEqual(summary, [
      'money:35.39万:353900',
      'money:9万:90000',
      'money:8,000元:8000',
      'term:36期:36',
      'rate:0息:0',
      'down_payment:首付3成:0.3',
      'inventory:现车:undefined-undefined',
      'date:9月30日:9-30',
    ]);
    assert.equal(extractClaims('我们9月13日下午见').length, 0, 'appointment dates are not expiry claims');
  });
});
