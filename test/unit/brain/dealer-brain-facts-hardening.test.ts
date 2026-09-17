import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  answerFact,
  findVehicles,
  importDealerBrain,
  resolveVehicle,
  verifyClaims,
} from '../../../src/skills/operations/dealer-brain/index.ts';
import { createTestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, readDealerFixture, vehicleIdByKey } from '../../helpers/fixtures.ts';

describe('dealer-brain hardening: lookups & answers', () => {
  it('resolves a model string that already contains the full trim name', () => {
    const ctx = createTestContext();
    const s = loadDealerFixture(ctx);
    const trims = (model: string) => findVehicles(ctx, s.group_id, { model }).map((v) => v.trim);
    assert.deepEqual(trims('i3 eDrive35L'), ['eDrive35L']);
    assert.deepEqual(trims('宝马i3 eDrive35L'), ['eDrive35L']);
    assert.deepEqual(trims('BMW X3 xDrive30L'), ['xDrive30L']);
    assert.deepEqual(trims('3系 330Li'), ['330Li']);
    assert.equal(resolveVehicle(ctx, s.group_id, { model: 'i3 eDrive40L' })?.id, vehicleIdByKey(s, 'i3-edrive40l'));
    assert.deepEqual(trims('i3 eDrive99L'), []);
  });

  it('never echoes arbitrary user text as a colour in customer-facing answers', () => {
    const ctx = createTestContext();
    const s = loadDealerFixture(ctx);
    const hz = dealerIdByKey(s, 'hz-bmw');
    const garbage = answerFact(ctx, hz, { kind: 'inventory', model: 'i3', exterior_color: '全网最低' });
    assert.equal(garbage.found, false, 'a non-colour query matches no stock');
    for (const colour of ['全网最低', '最低价白', '优惠99万的蓝']) {
      // '最低价白' may legitimately match white stock; either way the answer is built only from rows
      const a = answerFact(ctx, hz, { kind: 'inventory', model: 'i3', exterior_color: colour });
      assert.ok(!a.text.includes(colour), a.text);
      assert.ok(!a.text.includes('最低'), a.text);
      assert.ok(!a.text.includes('优惠'), a.text);
      assert.equal(verifyClaims(ctx, hz, a.text, a.facts).passed, true, a.text);
    }
    const real = answerFact(ctx, hz, { kind: 'inventory', model: 'i3', exterior_color: '宝石蓝' });
    assert.ok(real.text.includes('外观宝石蓝'), real.text);
  });

  it('renders offer amounts exactly (no silent rounding)', () => {
    const ctx = createTestContext();
    const bundle = readDealerFixture();
    bundle.offers.find((o) => o.key === 'hz-x3-cash')!.amount = 12345;
    const s = importDealerBrain(ctx, bundle);
    const hz = dealerIdByKey(s, 'hz-bmw');
    const a = answerFact(ctx, hz, { kind: 'offer', model: 'X3' });
    assert.ok(a.text.includes('优惠12345元'), a.text);
    assert.ok(!a.text.includes('1.23万'));
    assert.equal(verifyClaims(ctx, hz, a.text, a.facts).passed, true);
  });

  it('a trim price question lists only the newest model year of that trim', () => {
    const ctx = createTestContext();
    const bundle = readDealerFixture();
    const base = bundle.vehicles.find((x) => x.key === 'i3-edrive35l')!;
    bundle.vehicles.push({ ...base, key: 'i3-edrive35l-2025', model_year: 2025, msrp: 329900 });
    const s = importDealerBrain(ctx, bundle);
    const hz = dealerIdByKey(s, 'hz-bmw');
    const a = answerFact(ctx, hz, { kind: 'price', model: 'i3', trim: '35L' });
    assert.ok(a.text.includes('指导价35.39万'), a.text);
    assert.ok(!a.text.includes('32.99万'), 'the superseded 2025 price must not be quoted as current');
    assert.equal(a.facts.filter((f) => f.kind === 'vehicle').length, 1);
  });
});
