/**
 * Group-level dealer matching (ARCHITECTURE §5.3) on the canonical dealer fixture: listGroupDealerIds,
 * evaluateSignalForDealers and the per-dealer scores recorded in the lead_score decision.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NotFoundError, ValidationError } from '../../../src/core/errors.ts';
import { newId } from '../../../src/core/ids.ts';
import type { SignalContext } from '../../../src/core/types.ts';
import { detectIntentRules } from '../../../src/skills/acquisition/intent-detection/nlu.ts';
import {
  evaluateSignalForDealers,
  listGroupDealerIds,
  scoreLead,
  updateScoringConfig,
} from '../../../src/skills/acquisition/lead-scoring/index.ts';
import { getDealerProfile } from '../../../src/skills/operations/dealer-brain/index.ts';
import { createTestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, seedLead } from '../../helpers/fixtures.ts';

function setup(now?: string) {
  const ctx = createTestContext(now ? { now } : {});
  const summary = loadDealerFixture(ctx);
  return { ctx, hz: dealerIdByKey(summary, 'hz-bmw'), sh: dealerIdByKey(summary, 'sh-bmw') };
}

const SH_POST: SignalContext = {
  source_type: 'comment',
  post_title: '上海宝马提车记｜X3 30L落地价分享',
  ip_location: '上海',
  author_nickname: '魔都打工仔',
};
const I3_POST: SignalContext = { source_type: 'comment', post_title: '宝马i3现在值得买吗？' };

describe('lead-scoring: group-level dealer matching (ARCHITECTURE §5.3)', () => {
  it('lists every dealer of the group with the given dealer first', () => {
    const { ctx, hz, sh } = setup();
    assert.deepEqual(listGroupDealerIds(ctx, hz), [hz, sh]);
    assert.deepEqual(listGroupDealerIds(ctx, sh), [sh, hz]);
    assert.throws(() => listGroupDealerIds(ctx, 'dlr_missing'), NotFoundError);
  });

  it('routes an explicit 上海 buyer to 上海宝马中心 while 杭州宝马中心 caps it (§5.2)', () => {
    const { ctx, hz, sh } = setup();
    const { results, best } = evaluateSignalForDealers(ctx, {
      dealer_ids: [hz, sh],
      text: '上海X3现在什么价',
      context: SH_POST,
      signal_at: ctx.clock.iso(),
      preferred_dealer_id: hz,
    });
    assert.deepEqual(results.map((r) => r.dealer_id), [hz, sh]);
    const [forHz, forSh] = results;
    assert.equal(best.dealer_id, sh, 'a strictly higher score beats the preferred (query) dealer');
    assert.equal(forSh.score, 84);
    assert.equal(forSh.tier, 'high_intent');
    assert.equal(forHz.score, 59);
    assert.ok(forHz.components.some((c) => c.factor === 'out_of_area_cap' && c.points === -15));
    for (const r of results) assert.equal(r.components.reduce((s, c) => s + c.points, 0), r.score);
    // detection runs against each dealer profile: the location label is dealer-relative
    assert.ok(forSh.detection.evidence.some((e) => e.label === '本地买家（上海）'));
    assert.ok(forHz.detection.evidence.some((e) => e.label === '所在地（上海）'));
  });

  it('breaks ties with the preferred dealer, then input order', () => {
    const { ctx, hz, sh } = setup();
    const base = { text: '帅', context: I3_POST, signal_at: ctx.clock.iso() };
    assert.equal(evaluateSignalForDealers(ctx, { ...base, dealer_ids: [hz, sh] }).best.dealer_id, hz);
    assert.equal(evaluateSignalForDealers(ctx, { ...base, dealer_ids: [sh, hz] }).best.dealer_id, sh);
    assert.equal(evaluateSignalForDealers(ctx, { ...base, dealer_ids: [hz, sh], preferred_dealer_id: sh }).best.dealer_id, sh);
    assert.equal(evaluateSignalForDealers(ctx, { ...base, dealer_ids: [sh, hz], preferred_dealer_id: hz }).best.dealer_id, hz);
    assert.equal(evaluateSignalForDealers(ctx, { ...base, dealer_ids: [sh, hz], preferred_dealer_id: null }).best.dealer_id, sh);
  });

  it('scores each dealer with its own active scoring config', () => {
    const { ctx, hz, sh } = setup();
    updateScoringConfig(ctx, sh, { thresholds: { qualified: 70 } }, 'operator:测试');
    const { results } = evaluateSignalForDealers(ctx, { dealer_ids: [hz, sh], text: '杭州i3 35L落地多少', context: I3_POST, signal_at: ctx.clock.iso() });
    assert.equal(results[0].score, 91);
    assert.equal(results[1].score, 69, '上海宝马中心 caps the 杭州 buyer at its own qualified − 1');
    assert.equal(results[1].tier, 'candidate');
  });

  it('evaluates calendar timeframes at ctx.clock', () => {
    const text = '想9月底前提车，杭州i3 35L有现车吗';
    const september = setup();
    const r1 = evaluateSignalForDealers(september.ctx, { dealer_ids: [september.hz], text, context: I3_POST, signal_at: september.ctx.clock.iso() });
    assert.equal(r1.best.detection.intent.purchase_timeframe, 'this_month');
    const october = setup('2026-10-05T02:00:00.000Z');
    const r2 = evaluateSignalForDealers(october.ctx, { dealer_ids: [october.hz], text, context: I3_POST, signal_at: october.ctx.clock.iso() });
    assert.equal(r2.best.detection.intent.purchase_timeframe, undefined, 'a deadline already passed is not a purchase plan');
  });

  it('validates its input and evaluates duplicate dealer ids once', () => {
    const { ctx, hz, sh } = setup();
    const base = { text: '现在优惠多少', context: I3_POST, signal_at: ctx.clock.iso() };
    assert.throws(() => evaluateSignalForDealers(ctx, { ...base, dealer_ids: [] }), ValidationError);
    assert.throws(() => evaluateSignalForDealers(ctx, { ...base, dealer_ids: ['  '] }), ValidationError);
    assert.throws(() => evaluateSignalForDealers(ctx, { ...base, dealer_ids: ['dlr_missing'] }), NotFoundError);
    assert.throws(() => evaluateSignalForDealers(ctx, { ...base, dealer_ids: [hz], signal_at: undefined as never }), ValidationError);
    assert.throws(() => evaluateSignalForDealers(ctx, { ...base, dealer_ids: [hz], context: { source_type: 'tweet' } as never }), ValidationError);
    assert.throws(() => evaluateSignalForDealers(ctx, { ...base, dealer_ids: [hz, 42 as never] }), ValidationError, 'a non-string id is rejected, not silently dropped');
    assert.equal(evaluateSignalForDealers(ctx, { ...base, dealer_ids: [hz, hz, sh] }).results.length, 2);
  });

  it('never caps a buyer for the store in the place they name alongside another city (§5.2 + §5.3)', () => {
    const { ctx, hz, sh } = setup();
    const { results, best } = evaluateSignalForDealers(ctx, {
      dealer_ids: [hz, sh],
      text: '人在上海工作，想回杭州买i3，35L落地多少',
      context: I3_POST,
      signal_at: ctx.clock.iso(),
      preferred_dealer_id: hz,
    });
    const [forHz, forSh] = results;
    assert.equal(forHz.detection.intent.location, '杭州');
    assert.equal(forSh.detection.intent.location, '上海');
    for (const r of results) assert.ok(!r.components.some((c) => c.factor === 'out_of_area_cap'), `${r.dealer_id} must not cap`);
    assert.equal(best.dealer_id, hz, '杭州宝马中心 stocks the i3 35L the buyer wants to buy in 杭州');
    assert.ok(forHz.score >= 80, `杭州 ${forHz.score}`);
  });

  it('records every group dealer’s best signal score in the lead_score decision', () => {
    const { ctx, hz, sh } = setup();
    const lead = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-sh-buyer-001', stage: 'CANDIDATE' });
    const text = '上海X3现在什么价';
    const detection = detectIntentRules(text, SH_POST, getDealerProfile(ctx, hz), { now: ctx.clock.now(), tz: 'Asia/Shanghai' });
    const signal = ctx.db.table('lead_signals').insert({
      id: newId('sig'),
      lead_id: lead.id,
      source_type: 'comment',
      public_post_id: null,
      public_comment_id: null,
      post_title: SH_POST.post_title ?? null,
      content: text,
      signal_at: ctx.clock.iso(),
      search_run_id: null,
      query_id: null,
      intent: detection.intent,
      signal_score: 59,
      evidence: detection.evidence,
      engine: detection.engine,
      is_purchase_signal: detection.is_purchase_signal,
      strength: detection.strength,
      transaction_questions: detection.transaction_questions,
      author_role: detection.author_role ?? null,
      created_at: ctx.clock.iso(),
    });
    const result = scoreLead(ctx, lead.id);
    assert.equal(result.score, 59);
    const decision = ctx.audit.decisionsFor('lead', lead.id)[0];
    assert.deepEqual(decision.inputs.group_dealer_scores, [
      { dealer_id: hz, best_signal_id: signal.id, best_signal_score: 59, tier: 'candidate' },
      { dealer_id: sh, best_signal_id: signal.id, best_signal_score: 84, tier: 'high_intent' },
    ]);
    assert.equal(decision.output.out_of_area_capped, true);
  });
});
