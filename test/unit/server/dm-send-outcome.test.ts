/**
 * A send whose outcome could not be established is never offered a second automatic send: the message may already be
 * with the customer. The card says what to do instead — check Xiaohongshu, then register it or cancel it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DM_SEND_UNKNOWN_MARK } from '../../../src/providers/xhs/dm-send.ts';
import { leadDetailPage } from '../../../src/server/pages/leads.ts';
import type { PageEnv } from '../../../src/server/pages/shell.ts';
import type { RequestContext } from '../../../src/server/http.ts';
import { assignLead } from '../../../src/skills/acquisition/account-assignment/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, seedLead, seedOutreach } from '../../helpers/fixtures.ts';

function render(ctx: TestContext, dealerId: string, leadId: string): string {
  const env = { runtime: { ctx, config: { warnings: [] } }, options: { auth_enabled: true } } as unknown as PageEnv;
  const rc = { query: new URLSearchParams({ dealer: dealerId }), params: { id: leadId }, req: { headers: {} }, operator: 'op' } as unknown as RequestContext;
  return String(leadDetailPage(env, rc).html);
}

/** an approved outreach on an account whose session can send, with the given blocked_reason from the last attempt */
function seedApproved(ctx: TestContext, dealerId: string, blockedReason: string | null): string {
  const lead = seedLead(ctx, { dealer_id: dealerId, platform_user_id: 'u-dm-outcome', stage: 'QUALIFIED' });
  const assignment = assignLead(ctx, lead.id, { actor: 'test' }).assignment;
  assert.ok(assignment, 'the fleet controller picked an account');
  const outreach = seedOutreach(ctx, { lead_id: lead.id, account_id: assignment.account_id, assignment_id: assignment.id, status: 'APPROVED' });
  ctx.db.table('outreach').update(outreach.id, { blocked_reason: blockedReason });
  ctx.db.table('capability_snapshots').insert({
    id: `cap_${outreach.id}`,
    provider: ctx.xhs.name,
    account_id: assignment.account_id,
    capability: 'send_messages',
    status: 'AVAILABLE',
    reason: '由该账号自己的登录会话发送',
    checked_at: ctx.clock.iso(),
  });
  return lead.id;
}

describe('a DM whose outcome is unknown', () => {
  it('drops 通过平台发送 and tells the operator to confirm in Xiaohongshu first', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const leadId = seedApproved(ctx, dealerId, `REQUIRES_REVIEW: 私信${DM_SEND_UNKNOWN_MARK}，请在小红书中确认后再登记，不要重试：提交后未能读回`);

    const html = render(ctx, dealerId, leadId);
    assert.doesNotMatch(html, /通过平台发送/, 'no second automatic send for a message that may already be delivered');
    assert.match(html, /我已在小红书发送/, 'registering it by hand is still offered');
    assert.match(html, /取消/);
    assert.match(html, /这条私信不会自动重发/);
  });

  it('keeps the send button when the platform send is simply available', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const leadId = seedApproved(ctx, dealerId, null);

    const html = render(ctx, dealerId, leadId);
    assert.match(html, /通过平台发送/);
    assert.match(html, /用这个账号自己的登录状态发/, 'the capability note says where the message comes from');
    assert.doesNotMatch(html, /这条私信不会自动重发/);
  });
});
