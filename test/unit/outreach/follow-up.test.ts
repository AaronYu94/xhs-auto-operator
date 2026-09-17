import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findFollowUpCandidates, planFollowUps, skill } from '../../../src/skills/sales/follow-up/index.ts';
import { markOutreachSentManually, prepareOutreach } from '../../../src/skills/sales/outreach/index.ts';
import { seedInboundReply, seedSuppression } from '../../helpers/fixtures.ts';
import { createWorld, seedSignalLead, type World } from './helpers.ts';

const WANG = 'xhs-hz-sales-wang';

async function contacted(w: World, user: string, owner = WANG, text?: string) {
  const intent = text ? { brand: 'BMW', model: 'i3', discount_intent: true, purchase_stage: 'price_shopping' as const } : undefined;
  const lead = seedSignalLead(w, { user, owner, text, intent });
  const first = await prepareOutreach(w.ctx, lead.id);
  markOutreachSentManually(w.ctx, first.id, 'operator:王磊');
  return lead;
}

describe('planFollowUps', () => {
  it('waits follow_up_after_days, creates one follow-up through the guards, and is idempotent', async () => {
    const w = createWorld();
    const lead = await contacted(w, 'u-silent');
    w.ctx.clock.advance({ days: 1 });
    assert.deepEqual(await planFollowUps(w.ctx, w.dealerId), []);
    assert.match(findFollowUpCandidates(w.ctx, w.dealerId)[0].reason, /未满2天/);

    w.ctx.clock.advance({ days: 1, hours: 2 });
    const created = await planFollowUps(w.ctx, w.dealerId);
    assert.equal(created.length, 1);
    const fu = created[0];
    assert.equal(fu.kind, 'follow_up');
    assert.equal(fu.lead_id, lead.id);
    assert.equal(fu.status, 'READY_FOR_REVIEW');
    assert.match(fu.message, /天前跟您聊过/);
    assert.equal(fu.guard_results.find((g) => g.check === 'previous_contact')!.passed, true);

    assert.deepEqual(await planFollowUps(w.ctx, w.dealerId), [], 'no second follow-up while one is pending');
    assert.match(findFollowUpCandidates(w.ctx, w.dealerId)[0].reason, /待审核/);
    assert.ok(w.ctx.db.table('audit_events').findMany({ action: 'follow_up.planned' }).length >= 2);
  });

  it('stops at max_unanswered_touches', async () => {
    const w = createWorld();
    await contacted(w, 'u-limit');
    w.ctx.clock.advance({ days: 2, hours: 1 });
    const [fu] = await planFollowUps(w.ctx, w.dealerId);
    markOutreachSentManually(w.ctx, fu.id, 'operator:王磊');
    w.ctx.clock.advance({ days: 3 });
    assert.deepEqual(await planFollowUps(w.ctx, w.dealerId), []);
    assert.match(findFollowUpCandidates(w.ctx, w.dealerId)[0].reason, /连续触达2次/);
  });

  it('never follows up a user who replied or opted out', async () => {
    const w = createWorld();
    const replied = await contacted(w, 'u-replied');
    w.ctx.clock.advance({ hours: 5 });
    seedInboundReply(w.ctx, { lead_id: replied.id, account_id: w.account(WANG), content: '有现车吗？' });
    // different owner and signal: the same account may not send a near-identical template to two users
    await contacted(w, 'u-optout', 'xhs-hz-i3', '现在i3优惠多少');
    seedSuppression(w.ctx, 'u-optout');
    w.ctx.clock.advance({ days: 3 });

    assert.deepEqual(await skill.run(w.ctx, { dealer_id: w.dealerId }), []);
    const reasons = Object.fromEntries(findFollowUpCandidates(w.ctx, w.dealerId).map((c) => [c.lead_id, c.reason]));
    assert.match(reasons[replied.id], /已回复/);
    assert.ok(Object.values(reasons).some((r) => /勿扰/.test(r)));
  });
});
