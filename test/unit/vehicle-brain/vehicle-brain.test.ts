/**
 * 车型库: the cards the store sells from, and the retrieval every agent asks before it writes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PolicyError, ValidationError } from '../../../src/core/errors.ts';
import { addVehicle, deleteVehicle } from '../../../src/operator/onboarding.ts';
import {
  archiveVehicle,
  getVehicleCard,
  importVehicles,
  listVehicleCards,
  matchVehicle,
  parseVehicleRows,
  restoreVehicle,
  retrieveVehicles,
  updateVehicle,
  vehicleContext,
  vehicleFaqAnswer,
} from '../../../src/skills/operations/vehicle-brain/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, vehicleIdByKey } from '../../helpers/fixtures.ts';

function setup(): { ctx: TestContext; hz: string; i3: string } {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  return { ctx, hz: dealerIdByKey(summary, 'hz-bmw'), i3: vehicleIdByKey(summary, 'i3-edrive35l') };
}

describe('vehicle cards', () => {
  it('carries the real price, colours, stock and offers with the rows that back them', () => {
    const { ctx, hz, i3 } = setup();
    const card = getVehicleCard(ctx, hz, i3);
    assert.equal(card.display_name, '宝马i3 eDrive35L');
    assert.equal(card.price.msrp, 353_900);
    assert.equal(card.price.current, null, '当前售价 is only set when the store sets one');
    assert.equal(card.powertrain_label, '纯电');
    assert.equal(card.in_stock, 3, '白/红 1 台 + 黑/黑 2 台');
    assert.deepEqual(card.colors.map((c) => c.exterior_color).sort(), ['白', '黑']);
    assert.ok(card.offers.some((o) => o.title === 'i3金九限时优惠'));
    assert.ok(card.finance_offers.some((o) => o.type === 'finance'));
    assert.ok(card.fact_refs.some((r) => r.kind === 'vehicle' && /指导价/.test(r.claim)));
    assert.ok(card.fact_refs.some((r) => r.kind === 'inventory'));
  });

  it('当前售价 is a fact of its own and can never exceed the MSRP', () => {
    const { ctx, hz, i3 } = setup();
    assert.throws(() => updateVehicle(ctx, i3, { current_price: 400_000 }, 'operator:li'), ValidationError);
    const updated = updateVehicle(ctx, i3, { current_price: 333_900 }, 'operator:li');
    assert.equal(updated.current_price, 333_900);
    assert.equal(updated.source, 'console:operator:li');
    const card = getVehicleCard(ctx, hz, i3);
    assert.equal(card.price.current, 333_900);
    assert.equal(card.price.price_cut, 20_000);
    assert.ok(card.fact_refs.some((r) => /现售价/.test(r.claim)));
    assert.ok(ctx.audit.eventsFor('vehicle', i3).some((e) => e.action === 'vehicle.updated'));
  });

  it('stores the card material and reports an empty line-up honestly', () => {
    const { ctx, hz, i3 } = setup();
    updateVehicle(
      ctx,
      i3,
      {
        description: '一台适合城市通勤的纯电轿车。',
        target_customers: ['第一次买电车的家庭'],
        competitors: [{ name: '特斯拉 Model 3', note: '内饰更传统，后排更舒服' }],
        faqs: [{ question: '充电方便吗？', answer: '支持快充，门店可以协助申请家充桩。' }],
        content_angles: ['第一次买电车最担心的三件事'],
        images: ['https://cdn.example.com/i3.jpg'],
      },
      'operator:li',
    );
    const card = getVehicleCard(ctx, hz, i3);
    assert.equal(card.vehicle.faqs?.length, 1);
    assert.deepEqual(card.vehicle.images, ['https://cdn.example.com/i3.jpg']);
    const answer = vehicleFaqAnswer(card, '这车充电方便吗');
    assert.equal(answer?.faq.answer, '支持快充，门店可以协助申请家充桩。');
    assert.equal(vehicleFaqAnswer(card, '保养一次多少钱'), null);
  });

  it('rejects an image that is neither an https link nor an absolute path', () => {
    const { ctx, i3 } = setup();
    assert.throws(() => updateVehicle(ctx, i3, { images: ['i3.jpg'] }, 'operator:li'), ValidationError);
  });
});

describe('vehicle context for the LLM', () => {
  it('labels facts and material separately and says when there is no stock', () => {
    const { ctx, hz, i3 } = setup();
    updateVehicle(ctx, i3, { description: '城市通勤的纯电轿车', highlights: ['充电快'] }, 'operator:li');
    const block = vehicleContext([getVehicleCard(ctx, hz, i3)]).text;
    assert.match(block, /事实：宝马i3 eDrive35L（2026款）指导价 35\.39万/);
    assert.match(block, /事实：参数：纯电、纯电续航 526 公里/);
    assert.match(block, /事实：车源：白\/红 现车 1 台/);
    assert.match(block, /素材：介绍：城市通勤的纯电轿车/);
    assert.match(block, /素材：卖点：充电快/);
  });

  it('a trim with no sellable stock says so instead of staying silent', () => {
    const ctx = createTestContext();
    const summary = loadDealerFixture(ctx);
    const hz = dealerIdByKey(summary, 'hz-bmw');
    const card = getVehicleCard(ctx, hz, vehicleIdByKey(summary, '5series-530li'));
    assert.equal(card.in_stock + card.in_transit, 0);
    assert.match(vehicleContext([card]).text, /事实：车源：当前没有可售库存，不能说现车/);
  });
});

describe('retrieval (the RAG the agents use)', () => {
  it('a model or trim from intent detection always wins, and the reason is recorded', () => {
    const { ctx, hz } = setup();
    const byModel = retrieveVehicles(ctx, hz, { model: 'i3' });
    assert.ok(byModel.length >= 2);
    assert.equal(byModel[0].score, 1);
    assert.deepEqual(byModel[0].matched_on, ['model:i3']);
    assert.ok(byModel.every((m) => m.card.vehicle.model === 'i3'));

    const byTrim = retrieveVehicles(ctx, hz, { model: 'i3', trim: 'eDrive40L' });
    assert.equal(byTrim.length, 1);
    assert.equal(byTrim[0].card.vehicle.trim, 'eDrive40L');
  });

  it('finds a card by what the customer said, including by its own selling points', () => {
    const { ctx, hz, i3 } = setup();
    updateVehicle(ctx, i3, { highlights: ['充电快，半小时补能'], target_customers: ['每天通勤的上班族'] }, 'operator:li');

    const named = retrieveVehicles(ctx, hz, { text: '想看看i3，预算35万左右' });
    assert.equal(named[0].card.vehicle.model, 'i3');
    assert.ok(named[0].matched_on.some((r) => r.startsWith('name:')));

    const byMaterial = retrieveVehicles(ctx, hz, { text: '每天通勤的上班族开什么好' });
    assert.ok(byMaterial.some((m) => m.card.vehicle.id === i3), '找得到写了这类人群的车型');

    assert.deepEqual(retrieveVehicles(ctx, hz, { text: '家里的猫最近不吃饭' }), [], '毫不相关就不要硬匹配');

    // 车身形式 is searchable too: people ask for a kind of car before they know a model name.
    updateVehicle(ctx, i3, { specs: { body_type: '中型纯电轿车' } }, 'operator:li');
    assert.ok(retrieveVehicles(ctx, hz, { text: '想买台纯电轿车' }).some((m) => m.card.vehicle.id === i3));
  });

  it('an archived trim disappears from retrieval, cards and matching until it is restored', () => {
    const { ctx, hz, i3 } = setup();
    archiveVehicle(ctx, i3, 'operator:li');
    assert.ok(!listVehicleCards(ctx, hz).some((c) => c.vehicle.id === i3));
    assert.ok(listVehicleCards(ctx, hz, { include_archived: true }).some((c) => c.vehicle.id === i3));
    assert.ok(!retrieveVehicles(ctx, hz, { model: 'i3' }).some((m) => m.card.vehicle.id === i3));
    assert.equal(matchVehicle(ctx, hz, { model: 'i3', trim: 'eDrive35L' }), null);

    restoreVehicle(ctx, i3, 'operator:li');
    assert.equal(matchVehicle(ctx, hz, { model: 'i3', trim: 'eDrive35L' })?.vehicle.id, i3);
    assert.ok(ctx.audit.eventsFor('vehicle', i3).some((e) => e.action === 'vehicle.archived'));
    assert.ok(ctx.audit.eventsFor('vehicle', i3).some((e) => e.action === 'vehicle.restored'));
  });
});

describe('batch import', () => {
  it('reads a CSV with Chinese headers, creates new trims and updates existing ones', () => {
    const { ctx, hz } = setup();
    const csv = [
      '品牌,车型,配置,年款,指导价,当前售价,动力类型,卖点',
      'BMW,i3,eDrive35L,2026,353900,339900,纯电,"充电快,空间大"',
      'BMW,i5,eDrive40L,2026,44.99万,,纯电,行政级纯电轿车',
      'BMW,,,2026,100000,,,',
    ].join('\n');
    const rows = parseVehicleRows(csv);
    assert.equal(rows.length, 3);
    const result = importVehicles(ctx, hz, rows, 'operator:li', addVehicle);
    assert.equal(result.created, 1, 'i5 is new');
    assert.equal(result.updated, 1, 'i3 eDrive35L already exists');
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].row, 3);
    assert.match(result.failed[0].reason, /车型/);

    const i5 = listVehicleCards(ctx, hz).find((c) => c.vehicle.model === 'i5');
    assert.equal(i5?.price.msrp, 449_900, '44.99万 parses to yuan');
    const i3 = listVehicleCards(ctx, hz).find((c) => c.vehicle.trim === 'eDrive35L');
    assert.equal(i3?.price.current, 339_900);
    assert.ok(ctx.audit.eventsFor('dealer', hz).some((e) => e.action === 'vehicle.imported'));
  });

  it('reads a JSON array too, and refuses a table it cannot understand', () => {
    const { ctx, hz } = setup();
    const rows = parseVehicleRows(JSON.stringify([{ brand: 'BMW', model: 'i7', trim: 'xDrive50L', model_year: 2026, msrp: 1_268_000 }]));
    assert.equal(importVehicles(ctx, hz, rows, 'operator:li', addVehicle).created, 1);
    assert.throws(() => parseVehicleRows('名字,价格\nA,1'), ValidationError);
    assert.throws(() => parseVehicleRows('{oops'), ValidationError);
    assert.throws(() => parseVehicleRows('   '), ValidationError);
  });
});

describe('deleting vs archiving', () => {
  it('a trim with stock cannot be deleted, but it can be archived', () => {
    const { ctx, i3 } = setup();
    assert.throws(() => deleteVehicle(ctx, i3, 'operator:li'), PolicyError);
    assert.ok(archiveVehicle(ctx, i3, 'operator:li').archived_at);
  });
});
