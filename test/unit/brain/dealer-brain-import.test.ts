import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../../../src/core/errors.ts';
import type { TableName } from '../../../src/core/types.ts';
import { buildDealerProfile } from '../../../src/domain/dealer-profile.ts';
import {
  DEFAULT_DEALER_SETTINGS,
  getDealer,
  getDealerProfile,
  importDealerBrain,
  listDealers,
  parseDealerBrainBundle,
  skill,
} from '../../../src/skills/operations/dealer-brain/index.ts';
import { createTestContext } from '../../helpers/context.ts';
import {
  accountIdByPlatformId,
  dealerIdByKey,
  loadDealerFixture,
  readDealerFixture,
  vehicleIdByKey,
} from '../../helpers/fixtures.ts';

const BRAIN_TABLES: TableName[] = [
  'dealer_groups',
  'dealers',
  'vehicles',
  'inventory',
  'offers',
  'dealer_knowledge',
  'xhs_accounts',
  'account_personas',
];

function tableCounts(ctx: ReturnType<typeof createTestContext>): Record<string, number> {
  return Object.fromEntries(BRAIN_TABLES.map((t) => [t, ctx.db.table(t).count()]));
}

describe('dealer-brain: import', () => {
  it('imports the canonical fixture idempotently (same ids, same row counts)', () => {
    const ctx = createTestContext();
    const first = loadDealerFixture(ctx);
    const countsAfterFirst = tableCounts(ctx);
    assert.deepEqual(countsAfterFirst, {
      dealer_groups: 1,
      dealers: 2,
      vehicles: 10,
      inventory: 9,
      offers: 8,
      dealer_knowledge: 20,
      xhs_accounts: 8,
      account_personas: 8,
    });
    assert.equal(first.counts.inserted, 66);

    ctx.clock.advance({ hours: 3 });
    const second = loadDealerFixture(ctx);
    assert.deepEqual(tableCounts(ctx), countsAfterFirst);
    assert.equal(second.counts.inserted, 0);
    assert.equal(second.counts.updated, 0);
    assert.equal(second.counts.unchanged, 66);
    assert.deepEqual(second.dealer_ids, first.dealer_ids);
    assert.deepEqual(second.account_ids, first.account_ids);
    assert.deepEqual(second.vehicle_ids, first.vehicle_ids);

    const events = ctx.db.table('audit_events').findMany({ action: 'dealer_brain.imported' });
    assert.equal(events.length, 2);
    assert.equal(events[0].entity_id, first.group_id);
  });

  it('derives deterministic ids from natural keys across databases', () => {
    const a = loadDealerFixture(createTestContext());
    const b = loadDealerFixture(createTestContext());
    assert.equal(a.group_id, b.group_id);
    assert.deepEqual(a.dealer_ids, b.dealer_ids);
    assert.match(a.group_id, /^grp_[0-9a-f]{16}$/);
    assert.match(dealerIdByKey(a, 'hz-bmw'), /^dlr_[0-9a-f]{16}$/);
    assert.match(accountIdByPlatformId(a, 'xhs-hz-i3'), /^acc_[0-9a-f]{16}$/);
    assert.notEqual(dealerIdByKey(a, 'hz-bmw'), dealerIdByKey(a, 'sh-bmw'));
  });

  it('resolves natural keys: dealers, accounts per dealer, settings and inventory ownership', () => {
    const ctx = createTestContext();
    const s = loadDealerFixture(ctx);
    const hz = dealerIdByKey(s, 'hz-bmw');
    const sh = dealerIdByKey(s, 'sh-bmw');
    assert.deepEqual(Object.keys(s.account_ids).sort(), [
      'xhs-hz-guide',
      'xhs-hz-i3',
      'xhs-hz-official',
      'xhs-hz-sales-li',
      'xhs-hz-sales-wang',
      'xhs-hz-story',
      'xhs-sh-official',
      'xhs-sh-sales-zhao',
    ]);
    assert.equal(ctx.db.table('xhs_accounts').count({ dealer_id: hz }), 6);
    assert.equal(ctx.db.table('xhs_accounts').count({ dealer_id: sh }), 2);

    const wang = ctx.db.table('xhs_accounts').require(accountIdByPlatformId(s, 'xhs-hz-sales-wang'));
    assert.equal(wang.salesperson_name, '王磊');
    assert.equal(wang.nickname, '销售小王·杭州宝马');
    assert.equal(wang.city, '杭州');
    const zhao = ctx.db.table('xhs_accounts').require(accountIdByPlatformId(s, 'xhs-sh-sales-zhao'));
    assert.equal(zhao.auth_state, 'requires_auth');
    assert.equal(zhao.city, '上海');

    assert.deepEqual(getDealer(ctx, hz).settings, DEFAULT_DEALER_SETTINGS);
    assert.deepEqual(getDealer(ctx, sh).settings, { ...DEFAULT_DEALER_SETTINGS, daily_outreach_limit: 15 });

    assert.equal(ctx.db.table('inventory').count({ dealer_id: hz }), 6);
    assert.equal(ctx.db.table('inventory').count({ dealer_id: sh }), 3);
    const whiteRed = ctx.db.table('inventory').findOne({ dealer_id: hz, exterior_color: '白', interior_color: '红' });
    assert.equal(whiteRed?.vehicle_id, vehicleIdByKey(s, 'i3-edrive35l'));
    assert.equal(whiteRed?.quantity, 1);

    const offer325 = ctx.db.table('offers').findOne({ dealer_id: hz, title: '3系325Li限时优惠' });
    assert.equal(offer325?.vehicle_id, vehicleIdByKey(s, '3series-325li'));
    assert.equal(offer325?.model, null);

    assert.equal(ctx.db.table('dealer_knowledge').count({ dealer_id: null }), 15);
    assert.equal(ctx.db.table('dealer_knowledge').count({ dealer_id: hz }), 3);
    assert.equal(ctx.db.table('dealer_knowledge').count({ dealer_id: sh }), 2);
    assert.equal(listDealers(ctx, s.group_id).length, 2);
    assert.equal(listDealers(ctx, 'grp_missing').length, 0);
    assert.throws(() => getDealer(ctx, 'dlr_missing'), /not found/);
  });

  it('updates only changed fields on re-import, including clearing nullable columns', () => {
    const ctx = createTestContext();
    loadDealerFixture(ctx);
    const bundle = readDealerFixture();
    bundle.vehicles.find((x) => x.key === 'i3-edrive35l')!.msrp = 359900;
    const acc = bundle.accounts.find((a) => a.platform_account_id === 'xhs-hz-guide')!;
    acc.daily_outreach_limit = 8;
    const s1 = importDealerBrain(ctx, bundle);
    assert.equal(s1.counts.updated, 2);
    assert.equal(s1.counts.inserted, 0);
    assert.equal(ctx.db.table('vehicles').require(s1.vehicle_ids['i3-edrive35l']).msrp, 359900);
    assert.equal(ctx.db.table('xhs_accounts').require(s1.account_ids['xhs-hz-guide']).daily_outreach_limit, 8);

    acc.daily_outreach_limit = null;
    const s2 = importDealerBrain(ctx, bundle);
    assert.equal(s2.counts.updated, 1);
    assert.equal(ctx.db.table('xhs_accounts').require(s2.account_ids['xhs-hz-guide']).daily_outreach_limit, null);

    bundle.inventory.push({
      dealer: 'hz-bmw',
      vehicle: 'x1-sdrive20li',
      vin: null,
      exterior_color: '白',
      interior_color: '黑',
      status: 'in_transit',
      quantity: 1,
      list_price: null,
      source: 'test',
    });
    const s3 = importDealerBrain(ctx, bundle);
    assert.equal(s3.counts.inserted, 1);
    assert.equal(ctx.db.table('inventory').count(), 10);
  });

  it('rejects invalid bundles with precise paths and writes nothing', () => {
    const ctx = createTestContext();
    const unknownVehicle = readDealerFixture();
    unknownVehicle.inventory[0].vehicle = 'model-y';
    assert.throws(
      () => importDealerBrain(ctx, unknownVehicle),
      (err: unknown) => err instanceof ValidationError && err.path === 'inventory[0].vehicle',
    );

    const dupDealer = readDealerFixture();
    dupDealer.dealers[1].key = 'hz-bmw';
    assert.throws(() => importDealerBrain(ctx, dupDealer), /dealers\[1\]\.key: duplicate dealer key/);

    const badMix = readDealerFixture();
    badMix.accounts[2].persona.content_mix = { model_review: 0.5, comparison: 0.2 };
    assert.throws(() => importDealerBrain(ctx, badMix), /accounts\[2\]\.persona\.content_mix: content_mix weights must sum to 1/);

    const badPillar = JSON.parse(JSON.stringify(readDealerFixture()));
    badPillar.accounts[0].persona.content_mix = { memes: 1 };
    assert.throws(() => parseDealerBrainBundle(badPillar), /accounts\[0\]\.persona\.content_mix\.memes/);

    const badStatus = JSON.parse(JSON.stringify(readDealerFixture()));
    badStatus.inventory[1].status = 'available';
    assert.throws(() => parseDealerBrainBundle(badStatus), /inventory\[1\]\.status: expected one of/);

    const reversedOffer = readDealerFixture();
    reversedOffer.offers[0].valid_until = '2026-08-01';
    assert.throws(() => importDealerBrain(ctx, reversedOffer), /offers\[0\]\.valid_until/);

    const noPhrase = readDealerFixture();
    const prohibited = noPhrase.knowledge.find((k) => k.category === 'prohibited_claim')!;
    prohibited.data = {};
    assert.throws(() => importDealerBrain(ctx, noPhrase), /data\.phrase/);

    const badTz = readDealerFixture();
    badTz.dealers[0].settings = { timezone: 'Mars/Olympus' };
    assert.throws(() => importDealerBrain(ctx, badTz), /unknown timezone/);

    for (const t of BRAIN_TABLES) assert.equal(ctx.db.table(t).count(), 0, `${t} must stay empty`);
  });

  it('refuses to take over VINs or platform accounts of another group (transaction rolled back)', () => {
    const ctx = createTestContext();
    loadDealerFixture(ctx);
    const before = tableCounts(ctx);

    const other = readDealerFixture();
    other.group.key = 'other-group';
    assert.throws(() => importDealerBrain(ctx, other), /VIN LBV00000000000001 is registered to a dealer of another group/);
    assert.deepEqual(tableCounts(ctx), before);

    const accountsOnly = readDealerFixture();
    accountsOnly.group.key = 'other-group';
    accountsOnly.inventory = [];
    assert.throws(() => importDealerBrain(ctx, accountsOnly), /already registered to another dealer group/);
    assert.deepEqual(tableCounts(ctx), before);
  });

  it('getDealerProfile delegates to buildDealerProfile', () => {
    const ctx = createTestContext();
    const s = loadDealerFixture(ctx);
    const hz = dealerIdByKey(s, 'hz-bmw');
    const profile = getDealerProfile(ctx, hz);
    assert.deepEqual(profile, buildDealerProfile(ctx, hz));
    assert.equal(profile.city, '杭州');
    assert.ok(profile.inventory.some((i) => i.trim === 'eDrive35L' && i.exterior_color === '白' && i.interior_color === '红'));
    assert.ok(profile.models.includes('3 Series'));
  });

  it('exposes a registered skill definition', () => {
    assert.equal(skill.name, 'dealer-brain');
    assert.equal(skill.category, 'operations');
    assert.equal(skill.agent, 'automotive-operator');
  });
});
