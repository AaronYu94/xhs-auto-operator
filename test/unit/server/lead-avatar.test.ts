/**
 * Avatars in the inbox: the person's and the owning account's, both proxied. A lead the platform never showed an
 * avatar for keeps an initial-letter circle instead of borrowing someone else's face.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { leadsPage } from '../../../src/server/pages/leads.ts';
import type { PageEnv } from '../../../src/server/pages/shell.ts';
import type { RequestContext } from '../../../src/server/http.ts';
import { assignLead } from '../../../src/skills/acquisition/account-assignment/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, seedLead } from '../../helpers/fixtures.ts';

const AVATAR = 'https://sns-avatar-qc.xhscdn.com/avatar/abc123?imageView2/2/w/540/format/webp';

function render(ctx: TestContext, dealerId: string): string {
  const env = { runtime: { ctx, config: { warnings: [] } }, options: { auth_enabled: true } } as unknown as PageEnv;
  const rc = { query: new URLSearchParams({ dealer: dealerId }), req: { headers: {} }, operator: 'op' } as unknown as RequestContext;
  return String(leadsPage(env, rc).html);
}

describe('inbox avatars', () => {
  it('shows the lead avatar and the owning account avatar through the image proxy', () => {
    const ctx = createTestContext();
    const summary = loadDealerFixture(ctx);
    const dealerId = dealerIdByKey(summary, 'hz-bmw');
    const lead = seedLead(ctx, { dealer_id: dealerId, platform_user_id: 'buyer-with-face' });
    ctx.db.table('leads').update(lead.id, { avatar_url: AVATAR, username: '杭州小周' });
    const assigned = assignLead(ctx, lead.id, { actor: 'test' }).assignment;
    assert.ok(assigned, 'the fleet controller picked an account');
    ctx.db.table('xhs_accounts').update(assigned.account_id, {
      platform_profile: {
        nickname: '杭州宝马官方号',
        red_id: '950001',
        avatar_url: `${AVATAR}&who=account`,
        bio: null,
        ip_location: null,
        follows: null,
        fans: null,
        liked_and_collected: null,
        notes: [],
      },
    });

    const html = render(ctx, dealerId);
    assert.match(html, /\/media\/xhs-image\?src=https%3A%2F%2Fsns-avatar-qc\.xhscdn\.com%2Favatar%2Fabc123/, 'the lead avatar is proxied, never hot-linked');
    assert.match(html, /who%3Daccount/, 'the owning account avatar is shown too');
  });

  it('falls back to the first character of the name when the platform showed no avatar', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const lead = seedLead(ctx, { dealer_id: dealerId, platform_user_id: 'faceless' });
    ctx.db.table('leads').update(lead.id, { username: '路人甲' });

    const html = render(ctx, dealerId);
    assert.match(html, /<span class="avatar" aria-hidden="true">路<\/span>/);
    assert.doesNotMatch(html, /media\/xhs-image/, 'no image is invented for a lead without an avatar');
  });
});
