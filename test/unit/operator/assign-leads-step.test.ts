/**
 * The hourly assignment step owns the store's whole pool, not just fresh leads: a lead that lost its account — the
 * account left the fleet — is picked up again at whatever stage it had reached, and the lead itself never changes.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StepContext } from '../../../src/operator/workflow-engine.ts';
import { ASSIGNABLE_STAGES, assignLeadsStep } from '../../../src/operator/workflows.ts';
import { assignLead, getActiveAssignment } from '../../../src/skills/acquisition/account-assignment/index.ts';
import { removeAccount } from '../../../src/operator/onboarding.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture, seedLead } from '../../helpers/fixtures.ts';

function runStep(ctx: TestContext, dealerId: string): Record<string, unknown> {
  const sc = { ctx, run: { workflow: 'signal_processing', dealer_id: dealerId }, input: {} } as unknown as StepContext;
  return assignLeadsStep().run(sc) as Record<string, unknown>;
}

describe('assign_leads step', () => {
  it('covers every stage that needs an owner, but never WON, LOST or leads below 合格', () => {
    assert.ok(ASSIGNABLE_STAGES.includes('QUALIFIED'));
    assert.ok(ASSIGNABLE_STAGES.includes('ASSIGNED'));
    assert.ok(ASSIGNABLE_STAGES.includes('CONTACTED'));
    assert.ok(!ASSIGNABLE_STAGES.includes('DISCOVERED'));
    assert.ok(!ASSIGNABLE_STAGES.includes('CANDIDATE'));
    assert.ok(!ASSIGNABLE_STAGES.includes('WON'));
    assert.ok(!ASSIGNABLE_STAGES.includes('LOST'));
  });

  it('gives a new owner to a lead whose account was removed, mid-funnel', () => {
    const ctx = createTestContext();
    const summary = loadDealerFixture(ctx);
    const dealerId = dealerIdByKey(summary, 'hz-bmw');
    const lead = seedLead(ctx, { dealer_id: dealerId, platform_user_id: 'u-orphan', stage: 'QUALIFIED' });
    const wang = accountIdByPlatformId(summary, 'xhs-hz-sales-wang');
    const first = assignLead(ctx, lead.id, { reassign_to: wang, actor: 'operator:ops', reason: '先给小王' });
    assert.equal(first.assignment?.account_id, wang);
    ctx.db.table('leads').update(lead.id, { stage: 'ASSIGNED' });

    removeAccount(ctx, wang, 'operator:ops');
    assert.equal(getActiveAssignment(ctx, lead.id), undefined, 'the lead is in the pool right after the account left');
    assert.ok(ctx.db.table('leads').get(lead.id), 'and the lead is still there');

    const out = runStep(ctx, dealerId);
    assert.equal(out.assigned, 1, 'the next hourly run gives it a new owner without anyone asking');
    const owner = getActiveAssignment(ctx, lead.id);
    assert.ok(owner && owner.account_id !== wang);
    const kept = ctx.db.table('leads').get(lead.id)!;
    assert.equal(kept.score, lead.score, '分数、信号与阶段属于线索本身，不随账号消失');
    assert.equal(kept.last_signal_at, lead.last_signal_at);
    assert.equal(kept.platform_user_id, lead.platform_user_id);
  });
});
