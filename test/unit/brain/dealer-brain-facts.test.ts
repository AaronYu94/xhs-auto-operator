import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  answerFact,
  findInventory,
  findVehicles,
  getActiveOffers,
  getKnowledge,
  getProhibitedClaims,
  importDealerBrain,
  resolveVehicle,
  skill,
  verifyClaims,
} from '../../../src/skills/operations/dealer-brain/index.ts';
import { createTestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, readDealerFixture, vehicleIdByKey } from '../../helpers/fixtures.ts';

function setup() {
  const ctx = createTestContext();
  const s = loadDealerFixture(ctx);
  return { ctx, s, hz: dealerIdByKey(s, 'hz-bmw'), sh: dealerIdByKey(s, 'sh-bmw') };
}

describe('dealer-brain: catalog & inventory lookup', () => {
  it('matches models case/width-insensitively via model, model_zh and aliases', () => {
    const { ctx, s } = setup();
    const trims = (q: Parameters<typeof findVehicles>[2]) => findVehicles(ctx, s.group_id, q).map((x) => x.trim);
    assert.deepEqual(trims({ model: 'I3' }), ['eDrive35L', 'eDrive40L']);
    assert.deepEqual(trims({ model: 'ｉ３' }), ['eDrive35L', 'eDrive40L']);
    assert.deepEqual(trims({ model: '宝马3系' }), ['325Li', '330Li']);
    assert.deepEqual(trims({ model: '3 series' }), ['325Li', '330Li']);
    assert.deepEqual(trims({ model: 'i3', trim: '35L' }), ['eDrive35L']);
    assert.deepEqual(trims({ model: 'i3', trim: 'edrive35l' }), ['eDrive35L']);
    assert.deepEqual(trims({ model: 'i3 35L' }), ['eDrive35L']);
    assert.deepEqual(trims({ trim: '25L' }), ['xDrive25L']);
    assert.deepEqual(trims({ model: 'i3', trim: '5L' }), []);
    assert.deepEqual(trims({ model: 'X5' }), []);
    assert.deepEqual(trims({ brand: '宝马', model: 'X3' }), ['xDrive25L', 'xDrive30L']);
    assert.deepEqual(trims({ brand: 'Tesla', model: 'X3' }), []);
  });

  it('resolveVehicle picks the lowest-MSRP trim of the newest model year', () => {
    const ctx = createTestContext();
    const bundle = readDealerFixture();
    const base = bundle.vehicles.find((x) => x.key === 'i3-edrive35l')!;
    bundle.vehicles.push({ ...base, key: 'i3-edrive35l-2025', model_year: 2025, msrp: 299900 });
    const s = importDealerBrain(ctx, bundle);
    const i3 = resolveVehicle(ctx, s.group_id, { model: 'i3' });
    assert.equal(i3?.id, vehicleIdByKey(s, 'i3-edrive35l'));
    assert.equal(i3?.model_year, 2026);
    assert.equal(resolveVehicle(ctx, s.group_id, { model: 'i3', trim: '40L' })?.trim, 'eDrive40L');
    assert.equal(resolveVehicle(ctx, s.group_id, { model: 'X3' })?.trim, 'xDrive25L');
    assert.equal(resolveVehicle(ctx, s.group_id, { model: 'Model Y' }), null);
    assert.equal(resolveVehicle(ctx, s.group_id, {}), null);
  });

  it('finds sellable inventory with tolerant colour matching and dealer isolation', () => {
    const { ctx, hz, sh } = setup();
    const whiteRed = findInventory(ctx, hz, { model: 'i3', trim: '35L', exterior_color: '白', interior_color: '红' });
    assert.equal(whiteRed.length, 1);
    assert.equal(whiteRed[0].inventory.quantity, 1);
    assert.equal(whiteRed[0].vehicle.trim, 'eDrive35L');
    assert.equal(findInventory(ctx, hz, { model: 'i3', trim: '35L', exterior_color: '白色', interior_color: '红色' }).length, 1);
    assert.equal(findInventory(ctx, hz, { model: 'i3', exterior_color: 'white', interior_color: 'red' }).length, 1);
    assert.equal(findInventory(ctx, hz, { model: 'i3', trim: '35L', exterior_color: '蓝' }).length, 0);

    const transit = findInventory(ctx, hz, { model: 'i3', trim: '40L' });
    assert.equal(transit.length, 1);
    assert.equal(transit[0].inventory.status, 'in_transit');
    assert.equal(findInventory(ctx, hz, { model: 'i3', trim: '40L', statuses: ['in_stock'] }).length, 0);

    const shI3 = findInventory(ctx, sh, { model: 'i3' });
    assert.equal(shI3.length, 1);
    assert.equal(shI3[0].inventory.interior_color, '黑');
    const all = findInventory(ctx, hz, {});
    assert.equal(all.length, 6);
    assert.equal(all[all.length - 1].inventory.status, 'in_transit', 'in_stock rows are listed first');
  });

  it('matches descriptive colour names and excludes sold / zero-quantity rows', () => {
    const ctx = createTestContext();
    const bundle = readDealerFixture();
    const row = bundle.inventory.find((i) => i.exterior_color === '白' && i.interior_color === '红')!;
    row.exterior_color = '矿石白';
    row.interior_color = '珊瑚红';
    const s = importDealerBrain(ctx, bundle);
    const hz = dealerIdByKey(s, 'hz-bmw');
    const hit = findInventory(ctx, hz, { model: 'i3', exterior_color: '白', interior_color: '红' });
    assert.equal(hit.length, 1);
    assert.equal(hit[0].inventory.exterior_color, '矿石白');

    ctx.db.table('inventory').update(hit[0].inventory.id, { status: 'sold' });
    assert.equal(findInventory(ctx, hz, { model: 'i3', exterior_color: '白', interior_color: '红' }).length, 0);
    assert.equal(findInventory(ctx, hz, { model: 'i3', exterior_color: '白', statuses: ['sold'] }).length, 1);
    ctx.db.table('inventory').update(hit[0].inventory.id, { status: 'in_stock', quantity: 0 });
    assert.equal(findInventory(ctx, hz, { model: 'i3', exterior_color: '白', interior_color: '红' }).length, 0);
  });
});

describe('dealer-brain: offers & knowledge validity', () => {
  it('returns only currently valid offers; model-level offers apply to all trims', () => {
    const { ctx, s, hz } = setup();
    const titles = (q?: Parameters<typeof getActiveOffers>[2]) => getActiveOffers(ctx, hz, q).map((o) => o.title);
    const i3 = titles({ model: 'i3' });
    assert.ok(i3.includes('i3金九限时优惠'));
    assert.ok(i3.includes('i3 36期0息'));
    assert.ok(i3.includes('置换补贴'), 'all-model trade-in applies');
    assert.ok(!i3.includes('i3八月清库优惠'), 'expired offer excluded');
    assert.ok(!i3.includes('X3现金优惠'));

    assert.deepEqual(titles({ vehicle_id: vehicleIdByKey(s, 'i3-edrive40l'), types: ['cash_discount'] }), ['i3金九限时优惠']);
    assert.ok(titles({ vehicle_id: vehicleIdByKey(s, '3series-325li') }).includes('3系325Li限时优惠'));
    assert.ok(!titles({ vehicle_id: vehicleIdByKey(s, '3series-330li') }).includes('3系325Li限时优惠'));
    assert.equal(titles().length, 6);
  });

  it('treats valid_until as the end of that day in dealer time', () => {
    const { ctx, hz } = setup();
    ctx.clock.set('2026-09-30T15:59:59.000Z'); // 23:59:59 Shanghai
    assert.ok(getActiveOffers(ctx, hz).some((o) => o.title === 'i3金九限时优惠'));
    ctx.clock.set('2026-09-30T16:00:00.000Z'); // 2026-10-01 00:00 Shanghai
    assert.equal(getActiveOffers(ctx, hz).length, 0);
    ctx.clock.set('2026-08-31T15:00:00.000Z'); // 2026-08-31 23:00 Shanghai
    assert.deepEqual(
      getActiveOffers(ctx, hz).map((o) => o.title),
      ['i3八月清库优惠'],
    );
  });

  it('returns group-wide plus own-dealer knowledge valid now, and prohibited phrases', () => {
    const { ctx, hz, sh } = setup();
    const stores = getKnowledge(ctx, hz, ['store']);
    assert.equal(stores.length, 1);
    assert.equal(stores[0].title, '杭州宝马中心门店信息');
    const shSales = getKnowledge(ctx, sh, ['salesperson']).map((k) => k.title);
    assert.deepEqual(shSales, ['赵强']);
    assert.ok(getKnowledge(ctx, hz, ['campaign']).some((k) => k.title === '金九银十试驾季'));
    ctx.clock.set('2026-10-31T16:00:00.000Z');
    assert.equal(getKnowledge(ctx, hz, ['campaign']).length, 0);

    const phrases = getProhibitedClaims(ctx, hz).map((p) => p.phrase).sort();
    assert.deepEqual(phrases, ['保证', '全网最低', '内部价', '包过贷款', '最低价', '绝对', '零首付无门槛'].sort());
    assert.ok(getProhibitedClaims(ctx, hz).every((p) => p.reason.length > 0 && p.knowledge_id.startsWith('kn_')));
  });
});

describe('dealer-brain: answerFact', () => {
  it('price: MSRP per trim + active cash discount with expiry, never the expired offer or a landing price', () => {
    const { ctx, hz } = setup();
    const a = answerFact(ctx, hz, { kind: 'price', model: 'i3' });
    assert.equal(a.found, true);
    assert.ok(a.text.includes('指导价35.39万'));
    assert.ok(a.text.includes('指导价40.39万'));
    assert.ok(a.text.includes('优惠9万'));
    assert.ok(a.text.includes('截止日期9月30日'));
    assert.ok(!a.text.includes('12万'), 'expired 12万 offer must not appear');
    assert.ok(a.missing.includes('landing_price'));
    assert.ok(a.text.includes('落地价需结合上牌、保险及金融方案'));
    assert.ok(!/落地价?\d/.test(a.text), 'no landing price number');
    for (const f of a.facts) assert.ok(a.text.includes(f.claim), `claim ${f.claim} must be verbatim`);
    assert.ok(a.facts.some((f) => f.kind === 'vehicle' && f.claim === 'eDrive35L指导价35.39万'));
    assert.ok(a.facts.some((f) => f.kind === 'offer' && f.claim === '优惠9万'));
  });

  it('price for a specific trim only lists that trim', () => {
    const { ctx, hz } = setup();
    const a = answerFact(ctx, hz, { kind: 'price', model: 'i3', trim: '35L' });
    assert.ok(a.text.includes('指导价35.39万'));
    assert.ok(!a.text.includes('40.39万'));
    const noModel = answerFact(ctx, hz, { kind: 'price' });
    assert.equal(noModel.found, false);
    assert.deepEqual(noModel.facts, []);
    assert.ok(noModel.missing.includes('model') && noModel.missing.includes('landing_price'));
  });

  it('inventory: white/red eDrive35L found with quantity 1, colour tolerant', () => {
    const { ctx, hz } = setup();
    for (const colours of [
      { exterior_color: '白', interior_color: '红' },
      { exterior_color: '白色', interior_color: '红色' },
    ]) {
      const a = answerFact(ctx, hz, { kind: 'inventory', model: 'i3', trim: '35L', ...colours });
      assert.equal(a.found, true);
      assert.ok(a.text.includes('白外红内现车1台'), a.text);
      assert.equal(a.facts.length, 1);
      assert.equal(a.facts[0].kind, 'inventory');
      assert.equal(ctx.db.table('inventory').require(a.facts[0].id).vin, 'LBV00000000000001');
    }
    const black = answerFact(ctx, hz, { kind: 'inventory', model: 'i3', trim: '35L', exterior_color: '黑' });
    assert.ok(black.text.includes('黑外黑内现车2台'));
    const transit = answerFact(ctx, hz, { kind: 'inventory', model: 'i3', trim: '40L' });
    assert.ok(transit.text.includes('灰外黑内在途1台'));
  });

  it('inventory: no matching stock → found=false and never invents availability', () => {
    const { ctx, hz } = setup();
    const a = answerFact(ctx, hz, { kind: 'inventory', model: 'i3', trim: '35L', exterior_color: '蓝', interior_color: '红' });
    assert.equal(a.found, false);
    assert.deepEqual(a.facts, []);
    assert.deepEqual(a.missing, ['inventory']);
    assert.ok(a.text.includes('暂无'));
    assert.ok(!/现车\d/.test(a.text));
    assert.equal(verifyClaims(ctx, hz, a.text, a.facts).passed, true, 'negative stock statement is not a positive claim');

    const unknown = answerFact(ctx, hz, { kind: 'inventory', model: 'Model Y' });
    assert.equal(unknown.found, false);
    assert.deepEqual(unknown.missing, ['vehicle']);
  });

  it('offer / finance / lease / trade_in come only from active offers of that type', () => {
    const { ctx, hz, sh } = setup();
    const finance = answerFact(ctx, hz, { kind: 'finance', model: 'i3' });
    assert.equal(finance.found, true);
    for (const claim of ['36期', '0息', '首付3成']) assert.ok(finance.facts.some((f) => f.claim === claim), claim);
    assert.ok(finance.missing.includes('monthly_payment'));

    const lease = answerFact(ctx, hz, { kind: 'lease', model: 'X3' });
    assert.ok(lease.text.includes('月供5999元') && lease.text.includes('首付2成'));
    assert.equal(answerFact(ctx, hz, { kind: 'lease', model: 'i3' }).found, false);

    const tradeIn = answerFact(ctx, hz, { kind: 'trade_in' });
    assert.ok(tradeIn.text.includes('补贴8000元'));
    assert.ok(!tradeIn.text.includes('金融机构'));

    const shX3 = answerFact(ctx, sh, { kind: 'offer', model: 'X3' });
    assert.ok(shX3.text.includes('优惠5.5万'));
    assert.ok(!shX3.text.includes('优惠6万'), 'other dealer offers never leak');

    ctx.clock.set('2026-10-05T02:00:00.000Z');
    const expired = answerFact(ctx, hz, { kind: 'offer', model: 'i3' });
    assert.equal(expired.found, false);
    assert.deepEqual(expired.missing, ['offer']);
  });

  it('store, spec and highlights are built from dealer, knowledge and vehicle rows', () => {
    const { ctx, hz } = setup();
    const store = answerFact(ctx, hz, { kind: 'store' });
    assert.ok(store.text.includes('浙江省杭州市西湖区文三西路888号（演示地址）'));
    assert.ok(store.text.includes('周一至周日 08:30-18:30'));
    assert.ok(store.facts.some((f) => f.kind === 'dealer' && f.id === hz));
    assert.ok(store.facts.some((f) => f.kind === 'knowledge'));

    const spec = answerFact(ctx, hz, { kind: 'spec', model: 'i3', trim: '35L' });
    assert.ok(spec.text.includes('CLTC续航526km'));
    assert.ok(spec.text.includes('最大功率286马力'));
    const highlights = answerFact(ctx, hz, { kind: 'highlights', model: '3系' });
    assert.ok(highlights.text.includes('经典后驱运动轿车'));
    assert.equal(answerFact(ctx, hz, { kind: 'spec' }).found, false);

    for (const a of [store, spec, highlights]) {
      assert.equal(verifyClaims(ctx, hz, a.text, a.facts).passed, true);
    }
  });

  it('runs as the dealer-brain skill with validated input', async () => {
    const { ctx, hz } = setup();
    ctx.skills.register(skill);
    const out = await ctx.skills.invoke<{ found: boolean; text: string }>(ctx, 'dealer-brain', {
      dealer_id: hz,
      question: { kind: 'price', model: 'X3' },
    });
    assert.equal(out.found, true);
    assert.ok(out.text.includes('指导价38.99万'));
    await assert.rejects(ctx.skills.invoke(ctx, 'dealer-brain', { dealer_id: hz, question: { kind: 'landing' } }), /question\.kind/);
  });
});
