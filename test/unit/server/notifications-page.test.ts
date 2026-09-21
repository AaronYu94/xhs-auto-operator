/**
 * 对话 page, notification tabs: the same 消息 page Xiaohongshu shows an account — 私信 plus 评论和@ / 赞和收藏 / 新增关注.
 * Each row says who did what, in the platform's own words, and offers only the actions that row actually allows.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newId } from '../../../src/core/ids.ts';
import type { NotificationKind, NotificationTab, XhsNotification } from '../../../src/core/types.ts';
import type { RequestContext } from '../../../src/server/http.ts';
import { conversationsPage } from '../../../src/server/pages/conversations.ts';
import type { PageEnv } from '../../../src/server/pages/shell.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture, seedLead } from '../../helpers/fixtures.ts';

function render(ctx: TestContext, dealerId: string, query: Record<string, string> = {}): string {
  const env = { runtime: { ctx, config: { warnings: [] } }, options: { auth_enabled: true } } as unknown as PageEnv;
  const rc = { query: new URLSearchParams({ dealer: dealerId, ...query }), params: {}, req: { headers: {} }, operator: 'op' } as unknown as RequestContext;
  return String(conversationsPage(env, rc).html);
}

function seedNotification(ctx: TestContext, dealerId: string, accountId: string, over: Partial<XhsNotification> & { provider_notification_id: string }): XhsNotification {
  return ctx.db.table('xhs_notifications').insert({
    id: newId('ntf'),
    dealer_id: dealerId,
    account_id: accountId,
    tab: 'mentions' as NotificationTab,
    kind: 'comment' as NotificationKind,
    title: '评论了你的笔记',
    occurred_at: '2026-09-12T01:30:00.000Z',
    from_user_id: 'u-out-1',
    from_nickname: '想换车的小王',
    from_xsec_token: 'tok-u',
    comment_id: 'c1',
    comment_text: '这款落地多少钱？杭州有现车吗',
    comment_liked: false,
    note_id: 'feed-1',
    note_xsec_token: 'tok-feed',
    note_title: '杭州提车作业',
    status: 'NEW',
    lead_id: null,
    reply_message_id: null,
    handled_at: null,
    handled_by: null,
    fetched_at: ctx.clock.iso(),
    ...over,
  });
}

function setup(): { ctx: TestContext; hz: string; account: string } {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  return { ctx, hz: dealerIdByKey(summary, 'hz-bmw'), account: accountIdByPlatformId(summary, 'xhs-hz-official') };
}

describe('对话 page: 消息中心 tabs', () => {
  it('shows the four tabs with the unhandled counts on every view', () => {
    const { ctx, hz, account } = setup();
    seedNotification(ctx, hz, account, { provider_notification_id: 'n1' });
    seedNotification(ctx, hz, account, { provider_notification_id: 'n2', tab: 'connections', kind: 'follow', title: '开始关注你了', comment_id: null, comment_text: null });
    const dm = render(ctx, hz);
    for (const label of ['私信', '评论和@', '赞和收藏', '新增关注']) assert.match(dm, new RegExp(label));
    assert.match(dm, /view=mentions/);
    assert.match(dm, /view=connections/);
  });

  it('a comment row carries the comment, the note and the actions it allows', () => {
    const { ctx, hz, account } = setup();
    seedNotification(ctx, hz, account, { provider_notification_id: 'n1' });
    const html = render(ctx, hz, { view: 'mentions' });
    assert.match(html, /想换车的小王/);
    assert.match(html, /评论了你的笔记/);
    assert.match(html, /这款落地多少钱？杭州有现车吗/);
    assert.match(html, /杭州提车作业/);
    assert.match(html, /xsec_token=tok-feed/, 'the note opens on Xiaohongshu with the token it needs');
    assert.match(html, /\/reply"/);
    assert.match(html, /\/like"/);
    assert.match(html, /\/promote"/);
    assert.match(html, /同步消息/);
  });

  it('a follower row offers no reply or like — the platform has nothing to reply to', () => {
    const { ctx, hz, account } = setup();
    seedNotification(ctx, hz, account, {
      provider_notification_id: 'n2',
      tab: 'connections',
      kind: 'follow',
      title: '开始关注你了',
      comment_id: null,
      comment_text: null,
      note_id: null,
      note_title: null,
      from_nickname: '新粉丝',
    });
    const html = render(ctx, hz, { view: 'connections' });
    assert.match(html, /新粉丝/);
    assert.match(html, /开始关注你了/);
    assert.doesNotMatch(html, /\/reply"/);
    assert.doesNotMatch(html, /\/like"/);
    assert.match(html, /转为线索/);
  });

  it('a row that already became a lead links to it instead of offering to create one again', () => {
    const { ctx, hz, account } = setup();
    const lead = seedLead(ctx, { dealer_id: hz, platform_user_id: 'u-out-1' });
    seedNotification(ctx, hz, account, { provider_notification_id: 'n3', lead_id: lead.id, status: 'HANDLED' });
    const html = render(ctx, hz, { view: 'mentions' });
    assert.match(html, new RegExp(`/leads/${lead.id}`));
    assert.doesNotMatch(html, /\/promote"/);
    assert.match(html, /已处理/);
  });

  it('an empty tab explains how to fill it instead of looking broken', () => {
    const { ctx, hz } = setup();
    const html = render(ctx, hz, { view: 'likes' });
    assert.match(html, /还没有赞和收藏/);
    assert.match(html, /同步消息/);
  });
});
