import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LeadStage } from '../../../src/core/types.ts';
import { getScoringConfig } from '../../../src/skills/acquisition/lead-scoring/index.ts';
import { transitionLead } from '../../../src/skills/operations/crm/index.ts';
import {
  accountLoadRecommendations,
  adviseThresholds,
  contentPillarSignals,
  runOptimization,
} from '../../../src/skills/operations/optimization/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import {
  accountIdByPlatformId,
  dealerIdByKey,
  loadDealerFixture,
  seedAssignment,
  seedConversion,
  seedLead,
  seedPublishedPost,
} from '../../helpers/fixtures.ts';

function setup() {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  return { ctx, summary, dealerId: dealerIdByKey(summary, 'hz-bmw') };
}

function leadAt(ctx: TestContext, dealerId: string, uid: string, score: number, path: LeadStage[]) {
  const lead = seedLead(ctx, { dealer_id: dealerId, platform_user_id: uid, stage: 'DISCOVERED' });
  ctx.db.table('leads').update(lead.id, { score });
  for (const stage of path) transitionLead(ctx, lead.id, stage, { reason: 'test', actor: 'test' });
  return lead;
}

describe('adviseThresholds', () => {
  it('keeps thresholds with too little evidence', () => {
    const { ctx, dealerId } = setup();
    const advice = adviseThresholds(ctx, dealerId);
    assert.equal(advice.action, 'keep');
    assert.equal(advice.sample_size, 0);
    assert.match(advice.reason, /样本不足/);
    assert.equal(advice.auto_applied, false);
  });

  it('recommends raising the qualified threshold when the lower band never replies and higher bands do', () => {
    const { ctx, dealerId } = setup();
    for (let i = 0; i < 12; i++) leadAt(ctx, dealerId, `u-low-${i}`, 65, ['QUALIFIED', 'CONTACTED']);
    for (let i = 0; i < 12; i++) leadAt(ctx, dealerId, `u-high-${i}`, 85, i < 4 ? ['QUALIFIED', 'CONTACTED', 'REPLIED'] : ['QUALIFIED', 'CONTACTED']);
    const advice = adviseThresholds(ctx, dealerId);
    assert.equal(advice.action, 'raise_qualified', advice.reason);
    assert.equal(advice.suggested_qualified, 65);
    assert.equal(advice.bands[0].contacted, 12);
    assert.equal(advice.bands[0].replied, 0);
    assert.equal(advice.bands[1].replied, 4);
  });
});

describe('contentPillarSignals / accountLoadRecommendations', () => {
  it('a pillar that sold a car outranks a high-engagement pillar without leads', () => {
    const { ctx, summary, dealerId } = setup();
    const accountId = accountIdByPlatformId(summary, 'xhs-hz-sales-wang');
    for (let i = 0; i < 3; i++) {
      const p = seedPublishedPost(ctx, { dealer_id: dealerId, account_id: accountId, likes: 5000, collects: 800 });
      ctx.db.table('posts').update(p.id, { pillar: 'dealer_event' });
    }
    const seller = seedPublishedPost(ctx, { dealer_id: dealerId, account_id: accountId, likes: 12 });
    ctx.db.table('posts').update(seller.id, { pillar: 'price_offer' });
    const lead = leadAt(ctx, dealerId, 'u-buyer-won', 95, ['QUALIFIED']);
    ctx.db.table('leads').update(lead.id, { attributed_post_id: seller.id });
    seedConversion(ctx, { lead_id: lead.id, dealer_id: dealerId, account_id: accountId, outcome: 'won' });

    const signals = contentPillarSignals(ctx, dealerId);
    assert.equal(signals[0].pillar, 'price_offer');
    assert.equal(signals[0].signal, 'increase');
    const events = signals.find((s) => s.pillar === 'dealer_event');
    assert.equal(events?.signal, 'decrease');
    assert.equal(events?.posts, 3);
  });

  it('flags an overloaded account and one with spare capacity', () => {
    const { ctx, summary, dealerId } = setup();
    const busy = accountIdByPlatformId(summary, 'xhs-hz-sales-wang');
    ctx.db.table('xhs_accounts').update(busy, { daily_outreach_limit: 2 });
    for (let i = 0; i < 9; i++) {
      const lead = leadAt(ctx, dealerId, `u-load-${i}`, 70, ['QUALIFIED']);
      seedAssignment(ctx, { lead_id: lead.id, account_id: busy });
    }
    const recs = accountLoadRecommendations(ctx, dealerId);
    const row = recs.find((r) => r.account_id === busy);
    assert.equal(row?.capacity, 10);
    assert.equal(row?.recommendation, 'overloaded');
  });
});

describe('runOptimization', () => {
  it('evolves queries, records one optimization decision and never changes scoring thresholds', async () => {
    const { ctx, dealerId } = setup();
    const before = getScoringConfig(ctx, dealerId);
    const result = await runOptimization(ctx, dealerId);
    const after = getScoringConfig(ctx, dealerId);
    assert.equal(after.version, before.version);
    assert.deepEqual(after.thresholds, before.thresholds);
    assert.ok(Array.isArray(result.recommendations));
    assert.equal(ctx.db.table('agent_decisions').count({ decision_type: 'optimization', subject_id: dealerId }), 1);
    await assert.rejects(runOptimization(ctx, 'dlr_missing'), /not found/);
  });
});
