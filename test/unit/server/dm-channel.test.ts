/**
 * The DM channel is the store's own setting, never assumed: 设置 offers it, and a draft's instructions and buttons
 * follow it. Neither channel gains a send button — the salesperson still sends by hand and registers it afterwards.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { leadDetailPage } from '../../../src/server/pages/leads.ts';
import { setupPage } from '../../../src/server/pages/setup.ts';
import type { PageEnv } from '../../../src/server/pages/shell.ts';
import type { RequestContext } from '../../../src/server/http.ts';
import { assignLead } from '../../../src/skills/acquisition/account-assignment/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, seedLead, seedOutreach } from '../../helpers/fixtures.ts';

function env(ctx: TestContext): PageEnv {
  return { runtime: { ctx, config: { warnings: [] } }, options: { auth_enabled: true } } as unknown as PageEnv;
}

function rc(dealerId: string, params: Record<string, string> = {}): RequestContext {
  return { query: new URLSearchParams({ dealer: dealerId }), params, req: { headers: {} }, operator: 'op' } as unknown as RequestContext;
}

function setChannel(ctx: TestContext, dealerId: string, channel: 'app' | 'pro'): void {
  const dealer = ctx.db.table('dealers').get(dealerId)!;
  ctx.db.table('dealers').update(dealerId, { settings: { ...dealer.settings, dm_channel: channel } });
}

/** a lead with a draft waiting for review, so the detail page renders the manual-send card */
function seedDraft(ctx: TestContext, dealerId: string): string {
  const lead = seedLead(ctx, { dealer_id: dealerId, platform_user_id: 'u-dm-channel', stage: 'QUALIFIED' });
  const assignment = assignLead(ctx, lead.id, { actor: 'test' }).assignment;
  assert.ok(assignment, 'the fleet controller picked an account');
  seedOutreach(ctx, { lead_id: lead.id, account_id: assignment.account_id, assignment_id: assignment.id, status: 'READY_FOR_REVIEW' });
  return lead.id;
}

describe('DM channel', () => {
  it('设置 lets the store pick where its salespeople send DMs, with the app selected by default', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');

    const html = String(setupPage(env(ctx), rc(dealerId)).html);
    assert.match(html, /name="dm_channel"/);
    assert.match(html, /<option value="app" selected>/);
    assert.match(html, /pro\.xiaohongshu\.com/, 'the 专业号 option names the workbench it means');

    setChannel(ctx, dealerId, 'pro');
    assert.match(String(setupPage(env(ctx), rc(dealerId)).html), /<option value="pro" selected>/);
  });

  it('a draft shows the workbench link only for the 专业号 channel, and never an automatic send', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const leadId = seedDraft(ctx, dealerId);

    const app = String(leadDetailPage(env(ctx), rc(dealerId, { id: leadId })).html);
    assert.match(app, /复制私信/);
    assert.doesNotMatch(app, /打开客服工作台/);
    assert.doesNotMatch(app, /通过平台发送/, 'no send capability was probed, so no platform send button');

    setChannel(ctx, dealerId, 'pro');
    const pro = String(leadDetailPage(env(ctx), rc(dealerId, { id: leadId })).html);
    assert.match(pro, /href="https:\/\/pro\.xiaohongshu\.com\/im\/multiCustomerService"[^>]*>打开客服工作台</);
    assert.match(pro, /我已在小红书发送/, 'the human still registers the send');
    assert.doesNotMatch(pro, /通过平台发送/);
  });
});
