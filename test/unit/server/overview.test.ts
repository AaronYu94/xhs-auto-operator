import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RequestContext } from '../../../src/server/http.ts';
import { overviewPage } from '../../../src/server/pages/overview.ts';
import type { PageEnv } from '../../../src/server/pages/shell.ts';
import { transitionLead } from '../../../src/skills/operations/crm/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, seedLead } from '../../helpers/fixtures.ts';

function render(ctx: TestContext, dealerId: string): string {
  const env = { runtime: { ctx, config: { warnings: [] } }, options: { auth_enabled: true } } as unknown as PageEnv;
  const rc = { query: new URLSearchParams({ dealer: dealerId }), req: { headers: {} }, operator: 'op' } as unknown as RequestContext;
  return String(overviewPage(env, rc).html);
}

describe('今日: dealer / sales accounts found by lead research are not today’s buyers', () => {
  it('a qualified lead later closed as an industry account is left out of the buyer counts and the lead tile', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const buyer = seedLead(ctx, { dealer_id: dealerId, platform_user_id: 'real-buyer', stage: 'CANDIDATE' });
    const seller = seedLead(ctx, { dealer_id: dealerId, platform_user_id: 'store-account', stage: 'CANDIDATE' });
    for (const lead of [buyer, seller]) transitionLead(ctx, lead.id, 'QUALIFIED', { reason: 'test', actor: 'test' });
    ctx.db.table('leads').update(seller.id, { actor_type: 'DEALER_OR_SALES' });
    transitionLead(ctx, seller.id, 'LOST', { reason: 'industry_account', actor: 'test' });

    const html = render(ctx, dealerId);
    const tile = html.slice(html.indexOf('now-main'), html.indexOf('now-side'));
    assert.match(tile, /now-n st-num">1</, 'one buyer today, not two');
    assert.match(tile, /已排除 <span class="st-num">1<\/span> 位/);
    assert.match(tile, /另有 1 位核实下来不是本地要买车的人/, 'why they were left out is one click away, not in the sentence');
    assert.ok(tile.includes(`/leads/${buyer.id}`));
    assert.ok(!tile.includes(`/leads/${seller.id}`), 'the closed seller account is not listed as a buyer');
    assert.match(html, /<span class="num">1<\/span><span class="tiny muted">像要买车的人/, "today's strip counts buyers only");
  });

  it('without excluded accounts the counts are unchanged and no note is shown', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const buyer = seedLead(ctx, { dealer_id: dealerId, platform_user_id: 'real-buyer', stage: 'CANDIDATE' });
    transitionLead(ctx, buyer.id, 'QUALIFIED', { reason: 'test', actor: 'test' });
    const html = render(ctx, dealerId);
    assert.doesNotMatch(html, /核实下来不是本地要买车的人/);
    assert.doesNotMatch(html, /已排除 <span class="st-num">/);
  });
});
