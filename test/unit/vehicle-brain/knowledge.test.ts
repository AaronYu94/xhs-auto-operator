/**
 * AI 车型知识生成: the model writes the prose, the store's data decides what survives.
 *
 * Both guards are exercised here with the kind of output a real model produces: right-sounding numbers that are not
 * this car's numbers, a price that is not this store's price, a stock claim with nothing behind it, and a 落地价.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmJsonRequest, LlmProvider, LlmResult, LlmStatus } from '../../../src/providers/llm/types.ts';
import { getVehicleCard, updateVehicle } from '../../../src/skills/operations/vehicle-brain/index.ts';
import {
  allowedMeasurements,
  generateVehicleKnowledge,
  parseKnowledgeDraft,
  unsupportedMeasurements,
  validateKnowledgeDraft,
} from '../../../src/skills/operations/vehicle-brain/knowledge.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, vehicleIdByKey } from '../../helpers/fixtures.ts';

class FakeLlm implements LlmProvider {
  readonly name = 'fake';
  calls: LlmJsonRequest[] = [];
  private readonly payload: unknown;
  constructor(payload: unknown) {
    this.payload = payload;
  }
  status(): LlmStatus {
    return { provider: 'fake', status: 'AVAILABLE', model: 'fake-1', reason: 'test' };
  }
  async completeJson<T>(req: LlmJsonRequest): Promise<LlmResult<T>> {
    this.calls.push(req);
    return { ok: true, data: this.payload as T, model: 'fake-1' };
  }
  async completeText(): Promise<LlmResult<string>> {
    return { ok: false, reason: 'unused' };
  }
}

function setup(payload?: unknown): { ctx: TestContext; hz: string; i3: string; llm: FakeLlm | null } {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  const llm = payload === undefined ? null : new FakeLlm(payload);
  if (llm) ctx.llm = llm;
  return { ctx, hz: dealerIdByKey(summary, 'hz-bmw'), i3: vehicleIdByKey(summary, 'i3-edrive35l'), llm };
}

const CLEAN = {
  description: '一台开起来安静、加速轻快的中型纯电轿车，城市通勤和周末出行都够用，后排空间对家用也友好。',
  highlights: ['续航 526 公里，城市通勤一周一充', '286 马力，起步轻快', '安静，适合每天上下班'],
  target_customers: ['第一次买电车的家庭', '每天上下班通勤的上班族'],
  faqs: [
    { question: '续航够用吗？', answer: '这台车的续航是 526 公里，市区代步一周充一次基本够用，跑长途建议提前规划补能。' },
    { question: '现在有现车吗？', answer: '白色和黑色都有现车，具体颜色可以私信我确认。' },
  ],
  competitors: [{ name: '特斯拉 Model 3', note: '内饰更传统，隔音和后排舒适性更好' }],
  content_angles: ['第一次买电车最担心的三件事', '通勤党的真实用车一周'],
};

describe('measurement guard', () => {
  it('knows what the card can back, in whichever unit it is written', () => {
    const { ctx, hz, i3 } = setup();
    const card = getVehicleCard(ctx, hz, i3);
    const allowed = allowedMeasurements(card);
    assert.deepEqual(unsupportedMeasurements('续航 526 公里，286 马力，5 座', allowed, card.vehicle.model_year), []);
    assert.deepEqual(unsupportedMeasurements('指导价 35.39万', allowed, card.vehicle.model_year), []);
    assert.deepEqual(unsupportedMeasurements('指导价 353900元', allowed, card.vehicle.model_year), []);
    assert.deepEqual(unsupportedMeasurements('2026款上市', allowed, card.vehicle.model_year), [], '年款不是参数');
    assert.deepEqual(unsupportedMeasurements('续航 700 公里', allowed, card.vehicle.model_year), ['700 公里']);
    assert.deepEqual(unsupportedMeasurements('指导价 35.4万', allowed, card.vehicle.model_year), ['35.4万'], '四舍五入也是编造');
    assert.deepEqual(unsupportedMeasurements('限时优惠 12 万', allowed, card.vehicle.model_year), ['12 万']);
  });

  it('a model name that contains a digit is a name, not a measurement', () => {
    const { ctx, hz, i3 } = setup();
    const card = getVehicleCard(ctx, hz, i3);
    const allowed = allowedMeasurements(card);
    // '理想L9 L9主打…' used to read as '9 升', which dropped a perfectly good competitor note.
    assert.deepEqual(unsupportedMeasurements('理想L9 L9主打增程多座，我们更突出驾驶质感', allowed, 2026), []);
    assert.deepEqual(unsupportedMeasurements('小米SU7 更偏科技感', allowed, 2026), []);
    assert.deepEqual(unsupportedMeasurements('eDrive35L 的定位更均衡', allowed, 2026), []);
    // …but a real measurement right after a Chinese word is still checked.
    assert.deepEqual(unsupportedMeasurements('油耗 9 L', allowed, 2026), ['9 L']);
  });

  it('reads 万, 元, 成 and % as the same facts the store stored', () => {
    const { ctx, hz, i3 } = setup();
    updateVehicle(ctx, i3, { current_price: 263_900 }, 'operator:li');
    const allowed = allowedMeasurements(getVehicleCard(ctx, hz, i3));
    assert.deepEqual(unsupportedMeasurements('现在 26.39万 可以开走', allowed, 2026), []);
    assert.deepEqual(unsupportedMeasurements('首付 3 成，36 期', allowed, 2026), [], '门店确有 30% 首付的 36 期方案');
    assert.deepEqual(unsupportedMeasurements('首付 2 成', allowed, 2026), ['2 成']);
  });
});

describe('AI 车型资料生成', () => {
  it('stores clean output, stamps it, and the card keeps the same facts', async () => {
    const { ctx, hz, i3, llm } = setup(CLEAN);
    const result = await generateVehicleKnowledge(ctx, hz, i3, 'operator:li');
    assert.equal(result.status, 'AVAILABLE');
    assert.deepEqual(result.rejected, []);
    assert.equal(result.engine, 'llm:fake-1');
    assert.equal(result.vehicle.description, CLEAN.description);
    assert.equal(result.vehicle.highlights.length, 3);
    assert.equal(result.vehicle.faqs?.length, 2);
    assert.equal(result.vehicle.knowledge_engine, 'llm:fake-1');
    assert.equal(result.vehicle.knowledge_generated_at, ctx.clock.iso());
    assert.equal(result.vehicle.msrp, 353_900, '生成资料不会动价格');
    assert.ok(llm!.calls[0].prompt.includes('指导价 35.39万'), '提示词里带着真实事实');
    assert.ok(llm!.calls[0].prompt.includes('车源：白/红 现车 1 台'));
    assert.ok(ctx.audit.eventsFor('vehicle', i3).some((e) => e.action === 'vehicle.knowledge_generated'));
  });

  it('drops every sentence the store cannot back, and keeps the rest', async () => {
    const { ctx, hz, i3 } = setup({
      ...CLEAN,
      description: '续航高达 700 公里，是同级最强的选择。',
      highlights: ['续航 526 公里，城市通勤一周一充', '现在下订直降 12 万', '零百加速 3.9 秒'],
      faqs: [
        { question: '落地价多少？', answer: '落地价 38 万左右就能开走。' },
        { question: '续航够用吗？', answer: '这台车的续航是 526 公里，市区代步一周充一次基本够用。' },
      ],
      competitors: [{ name: '特斯拉 Model 3', note: '比它便宜 5 万' }],
    });
    const result = await generateVehicleKnowledge(ctx, hz, i3, 'operator:li');
    assert.equal(result.status, 'AVAILABLE');
    assert.equal(result.applied.description, '', '编造的续航整段丢掉');
    assert.deepEqual(result.applied.highlights, ['续航 526 公里，城市通勤一周一充']);
    assert.deepEqual(result.applied.faqs.map((f) => f.question), ['续航够用吗？']);
    assert.deepEqual(result.applied.competitors, []);
    assert.ok(result.rejected.some((r) => r.field === 'description' && /700 公里/.test(r.reason)));
    assert.ok(result.rejected.some((r) => r.field === 'highlights' && /12 万/.test(r.reason)));
    assert.ok(result.rejected.some((r) => r.field === 'faqs' && /落地价|38 万/.test(r.reason)));
    assert.ok(result.rejected.some((r) => r.field === 'competitors'));

    const stored = getVehicleCard(ctx, hz, i3).vehicle;
    assert.equal(stored.description, '', '被丢掉的描述不会被写进车型库');
    assert.deepEqual(stored.highlights, ['续航 526 公里，城市通勤一周一充']);
  });

  it('a prohibited phrase is rejected like any other unverified claim', async () => {
    const { ctx, hz, i3 } = setup({ ...CLEAN, highlights: ['全网最低价，买到就是赚到'] });
    const result = await generateVehicleKnowledge(ctx, hz, i3, 'operator:li');
    assert.deepEqual(result.applied.highlights, []);
    assert.ok(result.rejected.some((r) => r.field === 'highlights'));
  });

  it('claims stock the store does not have → rejected', () => {
    const ctx = createTestContext();
    const summary = loadDealerFixture(ctx);
    const hz = dealerIdByKey(summary, 'hz-bmw');
    const card = getVehicleCard(ctx, hz, vehicleIdByKey(summary, '5series-530li'));
    const draft = parseKnowledgeDraft({ ...CLEAN, description: '门店常年有现车，随时可以提。', highlights: [], faqs: [], competitors: [], target_customers: [], content_angles: [] });
    const { applied, rejected } = validateKnowledgeDraft(ctx, hz, card, draft);
    assert.equal(applied.description, '');
    assert.equal(rejected[0].field, 'description');
  });

  it('without an LLM nothing is generated and nothing is stored', async () => {
    const { ctx, hz, i3 } = setup();
    const before = getVehicleCard(ctx, hz, i3).vehicle;
    const result = await generateVehicleKnowledge(ctx, hz, i3, 'operator:li');
    assert.equal(result.status, 'UNAVAILABLE');
    assert.match(result.reason, /没有可用的大模型/);
    assert.deepEqual(getVehicleCard(ctx, hz, i3).vehicle.highlights, before.highlights);
    assert.equal(getVehicleCard(ctx, hz, i3).vehicle.knowledge_generated_at ?? null, null);
  });

  it('apply:false previews without touching the card', async () => {
    const { ctx, hz, i3 } = setup(CLEAN);
    const result = await generateVehicleKnowledge(ctx, hz, i3, 'operator:li', { apply: false });
    assert.equal(result.applied.description, CLEAN.description);
    assert.equal(getVehicleCard(ctx, hz, i3).vehicle.description ?? '', '');
  });
});
