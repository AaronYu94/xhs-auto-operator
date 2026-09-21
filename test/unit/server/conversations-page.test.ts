/**
 * 对话 page: a Xiaohongshu-shaped inbox. People on the left (needs-human first, including the ones who were messaged
 * and never wrote back), the thread on the right with our sent DM and their reply, and a composer that takes the
 * CUSTOMER's words — the one step the platform leaves to a human, said plainly and bound to the right person.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { conversationsPage, conversationDetailPage } from '../../../src/server/pages/conversations.ts';
import { userIdFromProfileLink } from '../../../src/server/api/sales.ts';
import type { PageEnv } from '../../../src/server/pages/shell.ts';
import type { RequestContext } from '../../../src/server/http.ts';
import { assignLead } from '../../../src/skills/acquisition/account-assignment/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, seedLead, seedOutreach } from '../../helpers/fixtures.ts';

function render(ctx: TestContext, dealerId: string, query: Record<string, string> = {}): string {
  const env = { runtime: { ctx, config: { warnings: [] } }, options: { auth_enabled: true } } as unknown as PageEnv;
  const rc = { query: new URLSearchParams({ dealer: dealerId, ...query }), params: {}, req: { headers: {} }, operator: 'op' } as unknown as RequestContext;
  return String(conversationsPage(env, rc).html);
}

function renderThread(ctx: TestContext, conversationId: string): string {
  const env = { runtime: { ctx, config: { warnings: [] } }, options: { auth_enabled: true } } as unknown as PageEnv;
  const rc = { query: new URLSearchParams(), params: { id: conversationId }, req: { headers: {} }, operator: 'op' } as unknown as RequestContext;
  return String(conversationDetailPage(env, rc).html);
}

/** a lead this store messaged; `replied` also stores the customer's answer, which makes it a conversation */
function seedContacted(ctx: TestContext, dealerId: string, user: string, replied?: string): { leadId: string; accountId: string; conversationId: string } {
  const lead = seedLead(ctx, { dealer_id: dealerId, platform_user_id: user, stage: 'CONTACTED' });
  const assignment = assignLead(ctx, lead.id, { actor: 'test' }).assignment;
  assert.ok(assignment, 'the fleet controller picked an account');
  seedOutreach(ctx, { lead_id: lead.id, account_id: assignment.account_id, assignment_id: assignment.id, status: 'SENT_MANUALLY' });
  const conversationId = `conv_${user}`;
  if (replied !== undefined) {
    const now = ctx.clock.iso();
    ctx.db.table('conversations').insert({
      id: conversationId,
      lead_id: lead.id,
      account_id: assignment.account_id,
      status: 'open',
      slots: {},
      ai_turns: 1,
      needs_human: true,
      handoff_reason: '客户在还价，需要销售接手',
      last_message_at: now,
      created_at: now,
      updated_at: now,
    });
    ctx.db.table('conversation_messages').insert({
      id: `msg_${user}`,
      conversation_id: conversationId,
      direction: 'inbound',
      content: replied,
      intents: [],
      extracted: {},
      status: 'received',
      fact_refs: [],
      provider_message_id: null,
      engine: 'rules',
      created_at: now,
    });
  }
  return { leadId: lead.id, accountId: assignment.account_id, conversationId };
}

describe('对话 inbox', () => {
  it('lists people like a message app: a thread, someone still waiting, and the ones needing a person first', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    seedContacted(ctx, dealerId, 'u-waiting');
    const { conversationId } = seedContacted(ctx, dealerId, 'u-replied', '能不能再便宜点');

    const html = render(ctx, dealerId);
    assert.match(html, /class="im"/);
    assert.match(html, /class="im-list"/);
    assert.match(html, /im-list-title">消息/);
    assert.match(html, /u-replied/);
    assert.match(html, /u-waiting/, 'someone who never wrote back is still in the inbox');
    assert.match(html, /你已发出私信，等待回复/, 'and their row says why it is empty');
    assert.ok(html.indexOf('u-replied') < html.indexOf('u-waiting'), 'the one needing a person is first');
    assert.match(html, /需要人工/);
    assert.match(html, new RegExp(`/conversations/${conversationId}`), 'the row opens the thread');
  });

  it('with nothing yet, the right pane explains the page instead of showing an empty table', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');

    const html = render(ctx, dealerId);
    // An empty pane states what is true and offers the one next step; how the flow works is behind the page's 「?」.
    assert.match(html, /还没有发出过私信/);
    assert.match(html, /去线索页发第一条/);
    assert.match(html, /客户回的话要你贴进来/, 'the step the platform forces on a human is still disclosed');
    assert.doesNotMatch(html, /class="flow"/, 'no numbered four-card diagram fills the empty pane');
  });

  it('a thread shows what we sent, what they said, and a draft that never pretends to be delivered', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const { conversationId, accountId } = seedContacted(ctx, dealerId, 'u-thread', '这周六能去看车吗');
    ctx.db.table('conversation_messages').insert({
      id: 'msg_draft',
      conversation_id: conversationId,
      direction: 'outbound',
      content: '周六 09:00-18:00 都在，您方便几点？',
      intents: [],
      extracted: {},
      status: 'draft',
      fact_refs: [],
      provider_message_id: null,
      engine: 'llm',
      created_at: ctx.clock.iso(),
    });

    const html = renderThread(ctx, conversationId);
    assert.match(html, /class="im-msg is-out"[\s\S]*您好，看到您在关注宝马i3/, 'our sent DM is in the thread, on our side');
    assert.match(html, /class="im-msg is-in"[\s\S]*这周六能去看车吗/, 'their reply is on theirs');
    assert.match(html, /AI 回复草稿 · 未发送/);
    assert.match(html, /\/api\/messages\/msg_draft\/approve/);
    assert.match(html, /\/api\/messages\/msg_draft\/mark-sent/);
    assert.match(html, /客户在还价，需要销售接手/, 'the handoff reason is on the thread, not buried');
    assert.match(html, /客户透露了什么/);

    // the composer takes the customer's words, bound to that customer and that account
    assert.match(html, /客户说了什么（把他的原话贴进来）/);
    assert.match(html, /<input type="hidden" name="platform_user_id" value="u-thread">/);
    assert.match(html, new RegExp(`<input type="hidden" name="account_id" value="${accountId}">`));
    assert.match(html, /data-api="\/api\/conversations\/inbound"/);
  });

  it('keeps the needs-human filter (and the old link), and a stranger can still be registered by hand', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    seedContacted(ctx, dealerId, 'u-quiet');
    seedContacted(ctx, dealerId, 'u-loud', '能不能再便宜点');

    const filtered = render(ctx, dealerId, { filter: 'needs_human' });
    assert.match(filtered, /u-loud/);
    assert.doesNotMatch(filtered, /u-quiet/);
    assert.match(render(ctx, dealerId, { needs_human: '1' }), /u-loud/, 'the old link still works');

    const fresh = render(ctx, dealerId, { new: '1' });
    assert.match(fresh, /新客户主动私信/);
    assert.match(fresh, /客户主页链接/);
    assert.match(fresh, /粘贴他的小红书主页链接/, '并且说清楚这个链接从哪来');
  });

  it('a do-not-contact customer gets no composer at all', () => {
    const ctx = createTestContext();
    const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
    const { leadId, conversationId } = seedContacted(ctx, dealerId, 'u-dnc', '别再发了');
    ctx.db.table('leads').update(leadId, { suppressed: true, suppression_reason: '客户要求勿扰' });

    const html = renderThread(ctx, conversationId);
    assert.match(html, /已加入勿扰名单/);
    assert.doesNotMatch(html, /客户说了什么（把他的原话贴进来）/);
  });
});

describe('粘贴主页链接登记新客户', () => {
  it('takes the id out of a copied profile link, and leaves a typed id alone', () => {
    assert.equal(userIdFromProfileLink('https://www.xiaohongshu.com/user/profile/5f3a1b2c000000000101d4e2?xsec_token=AB1'), '5f3a1b2c000000000101d4e2');
    assert.equal(userIdFromProfileLink('  https://www.xiaohongshu.com/user/profile/5f3a1b2c000000000101d4e2/  '), '5f3a1b2c000000000101d4e2');
    assert.equal(userIdFromProfileLink('5f3a1b2c000000000101d4e2'), '5f3a1b2c000000000101d4e2');
    // Not a link we understand: kept as typed so the person sees their own input in the error, not a mangled one.
    assert.equal(userIdFromProfileLink('https://example.com/a/b/我'), 'https://example.com/a/b/我');
  });
});
