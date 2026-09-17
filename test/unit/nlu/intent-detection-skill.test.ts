import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../../../src/core/errors.ts';
import { isVerbatimQuote } from '../../../src/core/evidence.ts';
import { newId } from '../../../src/core/ids.ts';
import type { DealerProfile, SignalContext } from '../../../src/core/types.ts';
import type { LlmJsonRequest, LlmProvider, LlmResult, LlmStatus } from '../../../src/providers/llm/types.ts';
import { analyzeSignal, detectIntentRules } from '../../../src/skills/acquisition/intent-detection/nlu.ts';
import {
  detectIntent,
  parseLlmIntentPayload,
  refineWithLlm,
  skill,
  type IntentDetectionSkillOutput,
} from '../../../src/skills/acquisition/intent-detection/index.ts';
import { createTestContext } from '../../helpers/context.ts';

/** Hangzhou BMW profile (fixture canon, ARCHITECTURE §9); defined locally so importing it never re-runs another test file. */
const HZ_BMW: DealerProfile = {
  dealer_id: 'dlr_hz_bmw',
  brands: ['BMW'],
  models: ['i3', 'X3', '3 Series'],
  trims: [
    { model: 'i3', trim: 'eDrive35L', aliases: ['35L', 'i3 35L'] },
    { model: 'i3', trim: 'eDrive40L', aliases: ['40L', 'i3 40L'] },
    { model: 'X3', trim: 'xDrive25L', aliases: ['25L'] },
  ],
  inventory: [
    { model: 'i3', trim: 'eDrive35L', exterior_color: '白', interior_color: '红', status: 'in_stock', quantity: 1 },
    { model: 'i3', trim: 'eDrive40L', exterior_color: '灰', interior_color: '黑', status: 'in_transit', quantity: 1 },
  ],
  city: '杭州',
  province: '浙江',
};

type Script = (req: LlmJsonRequest) => LlmResult<unknown> | Promise<LlmResult<unknown>>;

class ScriptedLlm implements LlmProvider {
  readonly name = 'scripted';
  readonly calls: LlmJsonRequest[] = [];
  private readonly script: Script;
  constructor(script: Script) {
    this.script = script;
  }
  status(): LlmStatus {
    return { provider: this.name, status: 'AVAILABLE', model: 'test-model', reason: 'test' };
  }
  async completeJson<T>(req: LlmJsonRequest): Promise<LlmResult<T>> {
    this.calls.push(req);
    return (await this.script(req)) as LlmResult<T>;
  }
  async completeText(): Promise<LlmResult<string>> {
    return { ok: false, reason: 'not used' };
  }
}

const I3_POST: SignalContext = { source_type: 'comment', post_title: '宝马i3现在值得买吗？' };
const ok = (data: unknown): LlmResult<unknown> => ({ ok: true, data, model: 'test-model' });

describe('intent-detection skill: LLM gating and fallback', () => {
  it('uses rules only when no LLM is configured and records an audited decision', async () => {
    const ctx = createTestContext();
    const d = await detectIntent(ctx, {
      text: '杭州i3 35L落地多少',
      context: I3_POST,
      dealer: HZ_BMW,
      subject: { type: 'comment', id: 'pcmt_ref_5' },
    });
    assert.equal(d.engine, 'rules');
    assert.deepEqual(d, detectIntentRules('杭州i3 35L落地多少', I3_POST, HZ_BMW));
    const decisions = ctx.audit.decisionsFor('comment', 'pcmt_ref_5');
    assert.equal(decisions.length, 1);
    const dec = decisions[0];
    assert.equal(dec.agent, 'intent-detection-agent');
    assert.equal(dec.skill, 'intent-detection');
    assert.equal(dec.decision_type, 'intent_detection');
    assert.equal(dec.engine, 'rules');
    assert.equal(dec.output.purchase_stage, 'active_shopping');
    assert.equal(dec.output.strength, 1);
    assert.equal(dec.inputs.dealer_id, HZ_BMW.dealer_id);
    assert.deepEqual((dec.inputs.llm as Record<string, unknown>).used, false);
    assert.deepEqual(dec.evidence, d.evidence);
    assert.equal(dec.confidence, d.intent.confidence);
    assert.equal(dec.created_at, ctx.clock.iso());
  });

  it('records no decision without a subject', async () => {
    const ctx = createTestContext();
    await detectIntent(ctx, { text: '现在优惠多少', context: I3_POST, dealer: HZ_BMW });
    assert.equal(ctx.db.table('agent_decisions').count(), 0);
  });

  it('skips the LLM for strong detections with a known model and for prefilter failures', async () => {
    const llm = new ScriptedLlm(() => ok({ is_purchase_signal: true, purchase_stage: 'awareness', evidence: [] }));
    const ctx = createTestContext({ llm });
    const strong = await detectIntent(ctx, { text: '杭州i3 35L落地多少', context: I3_POST, dealer: HZ_BMW });
    assert.equal(strong.engine, 'rules');
    const praise = await detectIntent(ctx, { text: '帅', context: I3_POST, dealer: HZ_BMW });
    assert.equal(praise.engine, 'rules');
    const marketing = await detectIntent(ctx, { text: '宝马i3底价私信我', context: I3_POST, dealer: HZ_BMW });
    assert.equal(marketing.engine, 'rules');
    assert.equal(llm.calls.length, 0);
  });

  it('falls back silently to rules when the LLM fails, throws or returns malformed JSON', async () => {
    const rules = detectIntentRules('这车后排空间怎么样', I3_POST, HZ_BMW);
    const scripts: Script[] = [
      () => ({ ok: false, reason: 'rate limited' }),
      () => {
        throw new Error('network down');
      },
      () => ok('not an object'),
    ];
    for (const script of scripts) {
      const llm = new ScriptedLlm(script);
      const ctx = createTestContext({ llm });
      const d = await detectIntent(ctx, {
        text: '这车后排空间怎么样',
        context: I3_POST,
        dealer: HZ_BMW,
        subject: { type: 'comment', id: 'c1' },
      });
      assert.equal(llm.calls.length, 1);
      assert.deepEqual(d, rules);
      const dec = ctx.audit.decisionsFor('comment', 'c1')[0];
      const info = dec.inputs.llm as Record<string, unknown>;
      assert.equal(info.used, false);
      assert.equal(typeof info.fallback_reason, 'string');
      assert.equal(dec.engine, 'rules');
    }
  });
});

describe('intent-detection skill: LLM validation', () => {
  it('drops hallucinated evidence, rejects unsupported trim/location/budget and clamps stage jumps', async () => {
    const llm = new ScriptedLlm((req) => {
      assert.equal(req.purpose, 'intent_refinement');
      assert.ok(req.prompt.includes('这车后排空间怎么样'));
      return ok({
        is_purchase_signal: true,
        purchase_stage: 'purchase_imminent',
        model: 'i3',
        trim: 'eDrive40L',
        city: '杭州',
        transaction_questions: ['inventory'],
        evidence: [
          { field: 'stage', label: '关注后排空间', quote: '后排空间' },
          { field: 'trim', label: '40L', quote: '40L' },
          { field: 'location', label: '杭州', quote: '杭州' },
          { field: 'budget', label: '预算', quote: '预算30万' },
          { field: 'inventory', label: '问现车', quote: '有现车吗' },
        ],
      });
    });
    const ctx = createTestContext({ llm });
    const d = await detectIntent(ctx, {
      text: '这车后排空间怎么样',
      context: I3_POST,
      dealer: HZ_BMW,
      subject: { type: 'comment', id: 'c2' },
    });
    assert.equal(d.engine, 'llm+rules');
    assert.equal(d.intent.purchase_stage, 'comparison', 'research → at most one step up');
    assert.equal(d.strength, 0.4);
    assert.equal(d.intent.trim, undefined);
    assert.equal(d.intent.location, undefined);
    assert.equal(d.intent.budget_min, undefined);
    assert.deepEqual(d.transaction_questions, []);
    assert.equal(d.intent.model, 'i3');
    assert.ok(d.intent.inferred_fields?.includes('model'), 'rules inference is preserved');
    for (const e of d.evidence) {
      const src = e.source_ref === 'post_context' ? [I3_POST.post_title!] : ['这车后排空间怎么样'];
      assert.ok(isVerbatimQuote(src, e.quote), `non-verbatim evidence kept: ${e.quote}`);
    }
    assert.ok(d.evidence.some((e) => e.code === 'stage_rationale' && e.quote === '后排空间'));
    const info = ctx.audit.decisionsFor('comment', 'c2')[0].inputs.llm as { rejected: string[]; used: boolean };
    assert.equal(info.used, true);
    for (const r of ['trim', 'location', 'budget', 'question:inventory', 'stage_jump_clamped']) {
      assert.ok(info.rejected.includes(r), `expected rejection ${r}`);
    }
  });

  it('accepts verbatim-supported additions and infers a model quoted from the post title', async () => {
    const ctx2Models: SignalContext = { source_type: 'comment', post_title: 'i3和i4怎么选' };
    const rules = detectIntentRules('i3什么时候能开回家', { source_type: 'comment' }, HZ_BMW);
    assert.equal(rules.intent.purchase_stage, undefined, 'rules miss this phrasing');

    const llm = new ScriptedLlm(() =>
      ok({
        is_purchase_signal: true,
        purchase_stage: 'active_shopping',
        transaction_questions: ['inventory'],
        evidence: [{ field: 'inventory', label: '关心提车时间', quote: '什么时候能开回家' }],
      }),
    );
    const ctx = createTestContext({ llm });
    const d = await detectIntent(ctx, { text: 'i3什么时候能开回家', context: { source_type: 'comment' }, dealer: HZ_BMW });
    assert.equal(d.engine, 'llm+rules');
    assert.deepEqual(d.transaction_questions, ['inventory']);
    assert.equal(d.intent.inventory_intent, true);
    assert.equal(d.intent.purchase_stage, 'awareness', 'none → at most one step');
    assert.equal(d.is_purchase_signal, true);
    assert.equal(d.strength, 0.1);

    const analysis = analyzeSignal('现在优惠多少', ctx2Models, HZ_BMW);
    assert.equal(analysis.detection.intent.model, undefined, 'two models in the post: rules do not guess');
    const refined = refineWithLlm(
      analysis,
      {
        is_purchase_signal: true,
        purchase_stage: 'price_shopping',
        model: '宝马i3',
        evidence: [{ field: 'model', label: '帖子讨论i3', quote: 'i3' }],
      },
      ctx2Models,
      HZ_BMW,
    );
    assert.equal(refined.detection.intent.model, 'i3');
    assert.equal(refined.detection.intent.brand, 'BMW');
    assert.ok(refined.detection.intent.inferred_fields?.includes('model'));
    const modelEv = refined.detection.evidence.find((e) => e.code === 'model_from_post_context');
    assert.equal(modelEv?.source_ref, 'post_context');
    assert.ok(refined.accepted.includes('model'));
    assert.equal(refined.detection.intent.purchase_stage, 'price_shopping');
  });

  it('never lets the LLM remove negative feedback, but lets it add a supported one', () => {
    const negative = analyzeSignal('已经提了Model Y 很香', I3_POST, HZ_BMW);
    const r1 = refineWithLlm(negative, { is_purchase_signal: true, purchase_stage: 'awareness', negative: false, evidence: [{ field: 'stage', label: 'x', quote: '很香' }] }, I3_POST, HZ_BMW);
    assert.equal(r1.detection.negative, true);
    assert.equal(r1.detection.is_purchase_signal, false);
    assert.equal(r1.detection.strength, 0);

    const soft = analyzeSignal('i3还是算了吧太贵', { source_type: 'comment' }, HZ_BMW);
    assert.equal(soft.detection.negative, false);
    const r2 = refineWithLlm(soft, { is_purchase_signal: false, purchase_stage: null, negative: true, evidence: [{ field: 'negative', label: '放弃购买', quote: '算了吧' }] }, { source_type: 'comment' }, HZ_BMW);
    assert.equal(r2.detection.negative, true);
    assert.equal(r2.detection.is_purchase_signal, false);
    const r3 = refineWithLlm(soft, { is_purchase_signal: false, negative: true, evidence: [{ field: 'negative', label: '放弃', quote: '不想要了' }] }, { source_type: 'comment' }, HZ_BMW);
    assert.equal(r3.detection.negative, false, 'unsupported negative quote rejected');
  });

  it('validates the LLM payload shape strictly', () => {
    assert.equal(parseLlmIntentPayload(null), null);
    assert.equal(parseLlmIntentPayload([1, 2]), null);
    const p = parseLlmIntentPayload({
      is_purchase_signal: 'yes',
      purchase_stage: 'buying_now',
      transaction_questions: ['inventory', 'teleport'],
      evidence: [{ field: 'model', label: 'ok', quote: 'i3' }, { field: 'hack', label: 'x', quote: 'y' }, 'junk'],
    });
    assert.ok(p);
    assert.equal(p.is_purchase_signal, undefined);
    assert.equal(p.purchase_stage, undefined);
    assert.deepEqual(p.transaction_questions, ['inventory']);
    assert.deepEqual(p.evidence, [{ field: 'model', label: 'ok', quote: 'i3' }]);
  });
});

describe('intent-detection skill: registry invocation', () => {
  function seedDealer(ctx: ReturnType<typeof createTestContext>) {
    const now = ctx.clock.iso();
    const group = ctx.db.table('dealer_groups').insert({ id: newId('grp'), name: '浙沪宝马经销商集团', created_at: now });
    const dealer = ctx.db.table('dealers').insert({
      id: newId('dlr'),
      group_id: group.id,
      name: '杭州宝马中心',
      brands: ['BMW'],
      city: '杭州',
      province: '浙江',
      address: '杭州市测试路1号',
      business_hours: '09:00-18:00',
      phone: null,
      settings: {
        outreach_approval_policy: 'REVIEW_REQUIRED',
        publish_approval_policy: 'REVIEW_REQUIRED',
        daily_outreach_limit: 20,
        min_outreach_interval_minutes: 3,
        max_unanswered_touches: 2,
        follow_up_after_days: 2,
        daily_publish_limit: 2,
        max_ai_conversation_turns: 6,
        auto_send_min_score: 90,
        timezone: 'Asia/Shanghai',
      },
      created_at: now,
      updated_at: now,
    });
    const vehicle = ctx.db.table('vehicles').insert({
      id: newId('veh'),
      group_id: group.id,
      brand: 'BMW',
      brand_zh: '宝马',
      model: 'i3',
      model_zh: 'i3',
      trim: 'eDrive35L',
      model_year: 2026,
      msrp: 353900,
      specs: { powertrain: 'EV' },
      highlights: [],
      aliases: ['35L', 'i3 35L'],
      source: 'test',
      updated_at: now,
    });
    ctx.db.table('inventory').insert({
      id: newId('inv'),
      dealer_id: dealer.id,
      vehicle_id: vehicle.id,
      vin: null,
      exterior_color: '白',
      interior_color: '红',
      status: 'in_stock',
      quantity: 1,
      list_price: null,
      source: 'test',
      updated_at: now,
    });
    return dealer;
  }

  it('loads the dealer profile by dealer_id and returns prefilter + detection', async () => {
    const ctx = createTestContext();
    const dealer = seedDealer(ctx);
    ctx.skills.register(skill);
    assert.equal(skill.name, 'intent-detection');
    assert.equal(skill.agent, 'intent-detection-agent');
    assert.equal(skill.category, 'acquisition');
    const out = await ctx.skills.invoke<IntentDetectionSkillOutput>(ctx, 'intent-detection', {
      text: '杭州i3 35L白外红内有现车吗？这周想去看看',
      context: { source_type: 'comment', post_title: '宝马i3现在值得买吗？', ip_location: null },
      dealer_id: dealer.id,
      subject: { type: 'comment', id: 'pcmt_x' },
    });
    assert.equal(out.prefilter.passed, true);
    assert.equal(out.detection.intent.purchase_stage, 'purchase_imminent');
    assert.ok(out.detection.evidence.some((e) => e.label === '本地买家（杭州）'), 'dealer city came from the DB');
    assert.equal(ctx.audit.decisionsFor('comment', 'pcmt_x')[0].inputs.dealer_id, dealer.id);
  });

  it('validates skill input and surfaces unknown dealers', async () => {
    const ctx = createTestContext();
    ctx.skills.register(skill);
    await assert.rejects(ctx.skills.invoke(ctx, 'intent-detection', { context: I3_POST }), ValidationError);
    await assert.rejects(
      ctx.skills.invoke(ctx, 'intent-detection', { text: 'i3多少钱', context: { source_type: 'tweet' } }),
      ValidationError,
    );
    await assert.rejects(ctx.skills.invoke(ctx, 'intent-detection', { text: 'i3多少钱', dealer_id: 'dlr_missing' }), /not found/);
    const noDealer = await ctx.skills.invoke<IntentDetectionSkillOutput>(ctx, 'intent-detection', { text: 'i3多少钱' });
    assert.equal(noDealer.detection.intent.purchase_stage, 'price_shopping');
  });
});
