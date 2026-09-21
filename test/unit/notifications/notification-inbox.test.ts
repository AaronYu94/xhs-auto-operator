/**
 * The notification centre as the product uses it: an inbox per account, buyer comments that become leads through the
 * normal pipeline, and actions that only count when the provider confirmed them.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NotificationTab } from '../../../src/core/types.ts';
import type { ProviderMode, ProviderResult, XhsNotificationOptions, XhsNotificationPage, XhsSendResult, XhsUnreadCounts } from '../../../src/providers/xhs/types.ts';
import { UnavailableXhsProvider } from '../../../src/providers/xhs/unavailable.ts';
import {
  ignoreNotification,
  likeNotification,
  listNotifications,
  countNewNotifications,
  promoteNotificationToLead,
  replyToNotification,
  syncAccountNotifications,
  syncDealerNotifications,
} from '../../../src/skills/operations/notification-inbox/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

const BUYER = '想入手i3 35L，杭州落地多少？有现车吗';
const CHATTER = '这个颜色真好看';

type TabPages = Partial<Record<NotificationTab, ProviderResult<XhsNotificationPage>>>;

/** A provider that has a notification centre and nothing else; every call is recorded in order. */
class NotifyProvider extends UnavailableXhsProvider {
  override readonly name = 'none';
  override readonly mode: ProviderMode = 'live';
  readonly calls: string[] = [];
  pages: TabPages = {};
  unread: ProviderResult<XhsUnreadCounts> = { ok: true, data: { mentions: 1, likes: 1, connections: 1, total: 3 } };
  reply: ProviderResult<XhsSendResult> = { ok: true, data: { provider_message_id: 'xhs-mcp-notify-reply:c1:1' } };
  like: ProviderResult<{ liked: boolean }> = { ok: true, data: { liked: true } };

  async getUnreadCounts(): Promise<ProviderResult<XhsUnreadCounts>> {
    this.calls.push('unread');
    return this.unread;
  }
  async listNotifications(_accountId: string, opts: XhsNotificationOptions = {}): Promise<ProviderResult<XhsNotificationPage>> {
    const tab = opts.tab ?? 'mentions';
    this.calls.push(`list:${tab}`);
    return this.pages[tab] ?? { ok: true, data: { tab, filtered: 0, items: [] } };
  }
  async replyToNotification(_accountId: string, commentId: string): Promise<ProviderResult<XhsSendResult>> {
    this.calls.push(`reply:${commentId}`);
    return this.reply;
  }
  async likeNotificationComment(_accountId: string, commentId: string): Promise<ProviderResult<{ liked: boolean }>> {
    this.calls.push(`like:${commentId}`);
    return this.like;
  }
}

function item(over: Partial<XhsNotificationPage['items'][number]> & { provider_notification_id: string }) {
  return {
    tab: 'mentions' as NotificationTab,
    kind: 'comment' as const,
    raw_type: 'comment/item',
    title: '评论了你的笔记',
    occurred_at: '2026-09-12T01:00:00.000Z',
    from_user_id: 'u-out-1',
    from_nickname: '小王',
    from_xsec_token: 'tok-u',
    comment_id: 'c1',
    comment_text: BUYER,
    comment_liked: false,
    note_id: 'feed-1',
    note_xsec_token: 'tok-feed',
    note_title: '杭州提车作业',
    ...over,
  };
}

function page(tab: NotificationTab, items: ReturnType<typeof item>[], filtered = 0): ProviderResult<XhsNotificationPage> {
  return { ok: true, data: { tab, filtered, items: items.map((i) => ({ ...i, tab })) } };
}

function setup(): { ctx: TestContext; hz: string; account: string; xhs: NotifyProvider } {
  const xhs = new NotifyProvider(new (class extends Object {})() as never);
  const ctx = createTestContext({ xhs });
  const summary = loadDealerFixture(ctx);
  return { ctx, hz: dealerIdByKey(summary, 'hz-bmw'), account: accountIdByPlatformId(summary, 'xhs-hz-official'), xhs };
}

describe('notification inbox', () => {
  it('reads the unread counts before opening any tab, stores every tab and never duplicates a notification', async () => {
    const { ctx, account, xhs } = setup();
    xhs.pages = {
      mentions: page('mentions', [item({ provider_notification_id: 'n1' })]),
      likes: page('likes', [item({ provider_notification_id: 'n2', kind: 'like', raw_type: 'liked/item', title: '赞了你的笔记', comment_id: null, comment_text: null, from_user_id: 'u-liker' })], 2),
      connections: page('connections', [item({ provider_notification_id: 'n3', kind: 'follow', raw_type: 'follow/you', title: '开始关注你了', comment_id: null, comment_text: null, note_id: null, from_user_id: 'u-fan' })]),
    };
    const first = await syncAccountNotifications(ctx, account);
    assert.equal(xhs.calls[0], 'unread', 'counts are read before a tab clears its badge');
    assert.equal(first.created, 3);
    assert.equal(first.unread?.total, 3);
    assert.deepEqual(first.tabs.map((t) => t.status), ['AVAILABLE', 'AVAILABLE', 'AVAILABLE']);
    assert.equal(first.tabs.find((t) => t.tab === 'likes')?.filtered, 2, '平台隐藏的条目照实报出');

    const again = await syncAccountNotifications(ctx, account);
    assert.equal(again.created, 0, 'the same notifications are stored once');
    assert.equal(listNotifications(ctx, ctx.db.table('xhs_accounts').get(account)!.dealer_id).length, 3);
    assert.deepEqual(countNewNotifications(ctx, ctx.db.table('xhs_accounts').get(account)!.dealer_id), { mentions: 1, likes: 1, connections: 1 });
  });

  it('a buyer comment becomes a lead; likes, collects and followers do not', async () => {
    const { ctx, hz, account, xhs } = setup();
    xhs.pages = {
      mentions: page('mentions', [
        item({ provider_notification_id: 'n1' }),
        item({ provider_notification_id: 'n2', comment_id: 'c2', comment_text: CHATTER, from_user_id: 'u-chat' }),
      ]),
      likes: page('likes', [item({ provider_notification_id: 'n3', kind: 'like', comment_id: null, comment_text: null, from_user_id: 'u-liker' })]),
      connections: page('connections', [item({ provider_notification_id: 'n4', kind: 'follow', comment_id: null, comment_text: null, from_user_id: 'u-fan' })]),
    };
    const result = await syncAccountNotifications(ctx, account);
    assert.equal(result.leads_created, 1);
    const leads = ctx.db.table('leads').findMany({ dealer_id: hz });
    assert.deepEqual(leads.map((l) => l.platform_user_id), ['u-out-1']);
    const signal = ctx.db.table('lead_signals').findOne({ lead_id: leads[0].id });
    assert.equal(signal?.content, BUYER);
    assert.equal(leads[0].data_mode, 'live', 'provenance of a live notification');
    const rows = listNotifications(ctx, hz);
    assert.equal(rows.find((r) => r.provider_notification_id === 'n1')?.lead_id, leads[0].id);
    for (const id of ['n2', 'n3', 'n4']) assert.equal(rows.find((r) => r.provider_notification_id === id)?.lead_id, null);
  });

  it('a follower can still be turned into a lead by hand, and the lead records what actually happened', async () => {
    const { ctx, hz, account, xhs } = setup();
    xhs.pages = {
      connections: page('connections', [
        item({ provider_notification_id: 'n9', kind: 'follow', title: '开始关注你了', comment_id: null, comment_text: null, note_id: null, note_title: null, from_user_id: 'u-fan', from_nickname: '新粉丝' }),
      ]),
    };
    await syncAccountNotifications(ctx, account, { tabs: ['connections'] });
    const row = listNotifications(ctx, hz)[0];
    assert.equal(row.lead_id, null);
    const { lead_id } = promoteNotificationToLead(ctx, row.id, 'user:sales');
    const lead = ctx.db.table('leads').get(lead_id)!;
    assert.equal(lead.platform_user_id, 'u-fan');
    assert.equal(lead.username, '新粉丝');
    const signal = ctx.db.table('lead_signals').findOne({ lead_id });
    assert.equal(signal?.content, '开始关注你了');
    assert.equal(signal?.source_type, 'reply');
    assert.equal(listNotifications(ctx, hz)[0].status, 'HANDLED');
  });

  it('a tab that cannot be read reports its own status instead of looking empty', async () => {
    const { ctx, hz, account, xhs } = setup();
    xhs.pages = {
      mentions: { ok: false, status: 'REQUIRES_AUTH', reason: 'Xiaohongshu session not logged in on account xhs-hz-official' },
      likes: { ok: false, status: 'REQUIRES_AUTH', reason: 'Xiaohongshu session not logged in on account xhs-hz-official' },
      connections: { ok: false, status: 'REQUIRES_AUTH', reason: 'Xiaohongshu session not logged in on account xhs-hz-official' },
    };
    const result = await syncAccountNotifications(ctx, account);
    assert.equal(result.created, 0);
    assert.deepEqual(new Set(result.tabs.map((t) => t.status)), new Set(['REQUIRES_AUTH']));
    assert.match(result.detail, /not logged in/);
    assert.equal(listNotifications(ctx, hz).length, 0);
  });

  it('a provider without a notification centre says so and stores nothing', async () => {
    const ctx = createTestContext();
    const summary = loadDealerFixture(ctx);
    const results = await syncDealerNotifications(ctx, dealerIdByKey(summary, 'hz-bmw'));
    assert.ok(results.length >= 1);
    for (const r of results) {
      assert.equal(r.created, 0);
      assert.match(r.detail, /没有通知中心/);
    }
  });

  it('a reply counts only when the provider confirmed it', async () => {
    const { ctx, hz, account, xhs } = setup();
    xhs.pages = { mentions: page('mentions', [item({ provider_notification_id: 'n1' })]) };
    await syncAccountNotifications(ctx, account, { tabs: ['mentions'] });
    const row = listNotifications(ctx, hz)[0];

    xhs.reply = { ok: false, status: 'REQUIRES_REVIEW', reason: '回复结果未知' };
    const refused = await replyToNotification(ctx, row.id, '您好，已私信您报价', 'user:sales');
    assert.equal(refused.status, 'REQUIRES_REVIEW');
    assert.equal(refused.notification.status, 'NEW', 'an unconfirmed reply leaves the notification open');
    assert.equal(refused.notification.reply_message_id, null);

    xhs.reply = { ok: true, data: { provider_message_id: 'xhs-mcp-notify-reply:c1:9' } };
    const sent = await replyToNotification(ctx, row.id, '您好，已私信您报价', 'user:sales');
    assert.equal(sent.status, 'AVAILABLE');
    assert.equal(sent.notification.status, 'HANDLED');
    assert.equal(sent.notification.reply_message_id, 'xhs-mcp-notify-reply:c1:9');
    assert.equal(ctx.audit.eventsFor('xhs_notification', row.id).some((e) => e.action === 'notification_replied'), true);
  });

  it('liking records the platform state; ignoring closes the row', async () => {
    const { ctx, hz, account, xhs } = setup();
    xhs.pages = {
      mentions: page('mentions', [item({ provider_notification_id: 'n1' }), item({ provider_notification_id: 'n2', comment_id: 'c2', comment_text: CHATTER, from_user_id: 'u-chat' })]),
    };
    await syncAccountNotifications(ctx, account, { tabs: ['mentions'] });
    const [a, b] = listNotifications(ctx, hz);
    const liked = await likeNotification(ctx, a.id, 'user:sales');
    assert.equal(liked.notification.comment_liked, true);
    assert.equal(liked.notification.status, 'NEW', '点赞不代表处理完');
    assert.equal(ignoreNotification(ctx, b.id, 'user:sales').status, 'IGNORED');
    assert.equal(countNewNotifications(ctx, hz).mentions, 1);
  });
});
