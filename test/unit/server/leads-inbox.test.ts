/**
 * The lead inbox is a work list: leads closed by the screen (or won) stay in the database and in the funnel stats, but
 * they do not sit between the leads a salesperson still has to work.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { leadInbox, type InboxQuery } from '../../../src/server/api/leads.ts';
import { transitionLead } from '../../../src/skills/operations/crm/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, seedLead } from '../../helpers/fixtures.ts';

function setup(): { ctx: TestContext; dealerId: string; open: string; lost: string } {
  const ctx = createTestContext();
  const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
  const open = seedLead(ctx, { dealer_id: dealerId, platform_user_id: 'still-shopping' }).id;
  const lost = seedLead(ctx, { dealer_id: dealerId, platform_user_id: 'rejected-by-screen' }).id;
  transitionLead(ctx, lost, 'LOST', { reason: 'llm_screen', actor: 'test' });
  return { ctx, dealerId, open, lost };
}

const query = (dealerId: string, extra: Partial<InboxQuery> = {}): InboxQuery => ({
  dealer_id: dealerId,
  filters: { dealer_id: dealerId, ...(extra.filters ?? {}) },
  limit: 50,
  offset: 0,
  ...extra,
});

describe('lead inbox: closed leads are out of the way but never gone', () => {
  it('hides LOST leads by default, shows them on request or when their stage is asked for', () => {
    const { ctx, dealerId, open, lost } = setup();
    assert.deepEqual(
      leadInbox(ctx, query(dealerId)).map((c) => c.lead_id),
      [open],
    );
    assert.deepEqual(
      leadInbox(ctx, query(dealerId, { open_only: false }))
        .map((c) => c.lead_id)
        .sort(),
      [open, lost].sort(),
    );
    assert.deepEqual(
      leadInbox(ctx, query(dealerId, { filters: { dealer_id: dealerId, stage: 'LOST' } })).map((c) => c.lead_id),
      [lost],
    );
    assert.equal(ctx.db.table('leads').count(), 2, 'nothing is deleted');
  });

  it('the closed lead still carries its Chinese lost reason', () => {
    const { ctx, dealerId, lost } = setup();
    const card = leadInbox(ctx, query(dealerId, { open_only: false })).find((c) => c.lead_id === lost);
    assert.equal(card?.next_action, '已流失：大模型复核：不是本地在市买家');
  });
});
