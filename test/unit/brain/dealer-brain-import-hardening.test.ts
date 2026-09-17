import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import { updatePersona } from '../../../src/skills/operations/account-brain/index.ts';
import {
  DEFAULT_DEALER_SETTINGS,
  answerFact,
  findInventory,
  getActiveOffers,
  importDealerBrain,
  isValidAt,
  parseDealerBrainBundle,
} from '../../../src/skills/operations/dealer-brain/index.ts';
import { createTestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture, readDealerFixture } from '../../helpers/fixtures.ts';

describe('dealer-brain hardening: inventory snapshots', () => {
  it('retires stock that disappeared from the latest export instead of keeping it sellable', () => {
    const ctx = createTestContext();
    const first = loadDealerFixture(ctx);
    const hz = dealerIdByKey(first, 'hz-bmw');
    const sh = dealerIdByKey(first, 'sh-bmw');

    const bundle = readDealerFixture();
    bundle.inventory = bundle.inventory.filter((r) => !(r.dealer === 'hz-bmw' && r.exterior_color === '白' && r.interior_color === '红'));
    const s = importDealerBrain(ctx, bundle);
    assert.equal(s.counts.inventory_retired, 1);
    assert.equal(ctx.db.table('inventory').count(), 9, 'rows are kept for history');
    assert.equal(findInventory(ctx, hz, { model: 'i3', exterior_color: '白', interior_color: '红' }).length, 0);
    const a = answerFact(ctx, hz, { kind: 'inventory', model: 'i3', trim: '35L', exterior_color: '白', interior_color: '红' });
    assert.equal(a.found, false, 'sold car must not be offered again');
    assert.equal(findInventory(ctx, sh, {}).length, 3, 'other dealers untouched');

    const again = importDealerBrain(ctx, bundle);
    assert.equal(again.counts.inventory_retired, 0, 'retiring is idempotent');
    assert.equal(again.counts.updated, 0);
  });

  it('a status change of an aggregated (VIN-less) row never double-counts cars', () => {
    const ctx = createTestContext();
    const first = loadDealerFixture(ctx);
    const hz = dealerIdByKey(first, 'hz-bmw');
    const bundle = readDealerFixture();
    const black = bundle.inventory.find((r) => r.dealer === 'hz-bmw' && r.vehicle === 'i3-edrive35l' && r.exterior_color === '黑')!;
    black.status = 'in_transit';
    importDealerBrain(ctx, bundle);
    const rows = findInventory(ctx, hz, { model: 'i3', trim: '35L', exterior_color: '黑' });
    assert.deepEqual(rows.map((r) => `${r.inventory.status}x${r.inventory.quantity}`), ['in_transitx2']);
  });

  it("inventory_mode 'merge' only upserts", () => {
    const ctx = createTestContext();
    const first = loadDealerFixture(ctx);
    const bundle = readDealerFixture();
    bundle.inventory = [];
    const s = importDealerBrain(ctx, bundle, { inventory_mode: 'merge' });
    assert.equal(s.counts.inventory_retired, 0);
    assert.equal(findInventory(ctx, dealerIdByKey(first, 'hz-bmw'), {}).length, 6);
  });
});

describe('dealer-brain hardening: operational state survives re-import', () => {
  it('never re-enables a disabled account or resets a lost authorization', () => {
    const ctx = createTestContext();
    const s = loadDealerFixture(ctx);
    const guide = accountIdByPlatformId(s, 'xhs-hz-guide');
    const zhao = accountIdByPlatformId(s, 'xhs-sh-sales-zhao');
    const official = accountIdByPlatformId(s, 'xhs-hz-official');
    ctx.db.table('xhs_accounts').update(guide, { status: 'disabled' });
    ctx.db.table('xhs_accounts').update(official, { auth_state: 'requires_auth' });

    const bundle = readDealerFixture();
    bundle.accounts.find((a) => a.platform_account_id === 'xhs-sh-sales-zhao')!.status = 'cooldown';
    const summary = importDealerBrain(ctx, bundle);
    assert.equal(ctx.db.table('xhs_accounts').require(guide).status, 'disabled');
    assert.equal(ctx.db.table('xhs_accounts').require(official).auth_state, 'requires_auth');
    assert.equal(ctx.db.table('xhs_accounts').require(zhao).status, 'cooldown', 'a stricter bundle state is applied');
    assert.equal(summary.counts.account_state_preserved, 2);
    const events = ctx.db.table('audit_events').findMany({ action: 'account.state_changed', entity_id: zhao });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].details.status, { from: 'active', to: 'cooldown' });
  });

  it('keeps operator persona edits by default; persona_mode overwrite replaces them with an audit trail', () => {
    const ctx = createTestContext();
    const s = loadDealerFixture(ctx);
    const i3 = accountIdByPlatformId(s, 'xhs-hz-i3');
    updatePersona(ctx, i3, { tone: '运营主管调整后的语气' }, 'operator:主管');

    const seeded = loadDealerFixture(ctx);
    assert.equal(ctx.db.table('account_personas').findOne({ account_id: i3 })!.tone, '运营主管调整后的语气');
    assert.equal(seeded.counts.personas_preserved, 1);

    ctx.clock.advance({ minutes: 1 });
    const overwritten = importDealerBrain(ctx, readDealerFixture(), { persona_mode: 'overwrite' });
    assert.equal(overwritten.counts.personas_preserved, 0);
    assert.equal(ctx.db.table('account_personas').findOne({ account_id: i3 })!.tone, '极客、理性、数据导向');
    const events = ctx.db.table('audit_events').findMany({ action: 'account.persona_updated', entity_id: i3 }, { orderBy: 'created_at ASC' });
    assert.equal(events.length, 2);
    assert.equal(events[1].actor, 'system:dealer-brain-import');
    assert.deepEqual(events[1].details.changed_fields, ['tone']);
  });
});

describe('dealer-brain hardening: bundle validation', () => {
  it('rejects impossible calendar dates and unparseable timestamps', () => {
    for (const [field, value] of [
      ['valid_until', '2026-02-30'],
      ['valid_until', '2026-09-30T25:00:00Z'],
      ['valid_from', '2026-13-01'],
    ] as const) {
      const bundle = readDealerFixture();
      bundle.offers[0][field] = value;
      assert.throws(
        () => parseDealerBrainBundle(bundle),
        (err: unknown) => err instanceof ValidationError && err.path === `offers[0].${field}`,
        `${field}=${value}`,
      );
    }
  });

  it('rejects unknown dealer settings keys (typos must not silently fall back to defaults)', () => {
    const bundle = readDealerFixture();
    (bundle.dealers[1].settings as Record<string, unknown>) = { daily_outreach_limt: 15 };
    assert.throws(() => parseDealerBrainBundle(bundle), /dealers\[1\]\.settings\.daily_outreach_limt: unknown setting/);
  });

  it('rejects offers whose model matches no vehicle or contradicts their vehicle', () => {
    const noModel = readDealerFixture();
    noModel.offers[0].model = 'i5';
    assert.throws(() => importDealerBrain(createTestContext(), noModel), /offers\[0\]\.model: no vehicle/);

    const mismatch = readDealerFixture();
    const o325 = mismatch.offers.findIndex((o) => o.key === 'hz-325li-cash');
    mismatch.offers[o325].model = 'X3';
    assert.throws(() => parseDealerBrainBundle(mismatch), new RegExp(`offers\\[${o325}\\]\\.model: does not match vehicle`));
  });

  it('rejects an empty persona content_mix', () => {
    const bundle = readDealerFixture();
    bundle.accounts[0].persona.content_mix = {};
    assert.throws(() => parseDealerBrainBundle(bundle), /accounts\[0\]\.persona\.content_mix: must contain at least one pillar/);
  });

  it('normalizes VINs to upper case so the same car is never imported twice', () => {
    const ctx = createTestContext();
    loadDealerFixture(ctx);
    const bundle = readDealerFixture();
    bundle.inventory[0].vin = bundle.inventory[0].vin!.toLowerCase();
    const s = importDealerBrain(ctx, bundle);
    assert.equal(ctx.db.table('inventory').count(), 9);
    assert.equal(s.counts.inserted, 0);
    assert.equal(ctx.db.table('inventory').count({ vin: 'LBV00000000000001' }), 1);
  });
});

describe('dealer-brain hardening: defaults & validity windows', () => {
  it('DEFAULT_DEALER_SETTINGS cannot be mutated by a consumer', () => {
    assert.throws(() => {
      (DEFAULT_DEALER_SETTINGS as { daily_outreach_limit: number }).daily_outreach_limit = 999;
    }, TypeError);
    assert.equal(DEFAULT_DEALER_SETTINGS.daily_outreach_limit, 20);
  });

  it('corrupt validity dates fail closed', () => {
    const ctx = createTestContext();
    const s = loadDealerFixture(ctx);
    const hz = dealerIdByKey(s, 'hz-bmw');
    const now = ctx.clock.now();
    assert.equal(isValidAt('2026-09-01', 'not-a-date', now, 'Asia/Shanghai'), false);
    assert.equal(isValidAt('garbage', null, now, 'Asia/Shanghai'), false);
    ctx.db.table('offers').insert({
      id: newId('ofr'),
      dealer_id: hz,
      vehicle_id: null,
      model: 'i3',
      type: 'cash_discount',
      title: '坏数据优惠',
      description: '',
      amount: 150000,
      apr: null,
      term_months: null,
      down_payment_pct: null,
      conditions: '',
      valid_from: '2026-09-01',
      valid_until: '2026-09-31T99:00:00Z',
      source: 'manual',
      updated_at: ctx.clock.iso(),
    });
    assert.ok(!getActiveOffers(ctx, hz).some((o) => o.title === '坏数据优惠'));
  });
});
