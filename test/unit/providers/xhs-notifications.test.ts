/**
 * The notification centre through the live provider. The payload shapes here were captured from a real
 * xiaohongshu-mcp instance (`list_notifications` / `get_unread_count`); the names and ids are replaced with
 * placeholders — the structure, the `type` strings and the epoch-second timestamps are the real ones.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ManualClock } from '../../../src/core/clock.ts';
import { McpXhsProvider, notificationKindOf, notificationsFrom, unreadCountsFrom } from '../../../src/providers/xhs/mcp-provider.ts';
import { TEST_NOW } from '../../helpers/context.ts';

const TOOLS = [
  'check_login_status', 'search_feeds', 'get_feed_detail', 'user_profile', 'get_my_profile', 'publish_content',
  'reply_comment_in_feed', 'get_unread_count', 'list_notifications', 'reply_notification', 'like_notification',
];
const LOGGED_IN_TEXT = '✅ 已登录\n用户名: 测试账号\n\n你可以使用其他功能了。';
const ACCOUNT_URL = 'http://127.0.0.1:18061/mcp';

const LIKES_PAYLOAD = {
  tab: 'likes',
  filtered: 1,
  items: [
    {
      id: '7682729091179570135',
      type: 'liked/item',
      title: '赞了你的笔记',
      time: 1788774759,
      from: { user_id: 'u-liker-1', nickname: '路人甲', xsec_token: 'tok-liker-1' },
      liked: false,
      feed_id: 'feed-1',
      feed_xsec_token: 'tok-feed-1',
      feed_title: '这台车的实拍',
    },
    {
      id: '7680587271880279519',
      type: 'faved/item',
      title: '收藏了你的笔记',
      time: 1788276078,
      from: { user_id: 'u-fav-1', nickname: '路人乙', xsec_token: 'tok-fav-1' },
      liked: false,
      feed_id: 'feed-1',
      feed_xsec_token: 'tok-feed-1',
      feed_title: '这台车的实拍',
    },
  ],
};

const MENTIONS_PAYLOAD = {
  tab: 'mentions',
  filtered: 0,
  items: [
    {
      id: '7690000000000000001',
      type: 'comment/item',
      title: '评论了你的笔记',
      time: 1788800000,
      from: { user_id: 'u-buyer-1', nickname: '想换车的小王', xsec_token: 'tok-buyer-1' },
      comment_id: 'cmt-1',
      comment_text: '这款落地多少钱？杭州有现车吗',
      liked: false,
      feed_id: 'feed-1',
      feed_xsec_token: 'tok-feed-1',
      feed_title: '这台车的实拍',
    },
  ],
};

const CONNECTIONS_PAYLOAD = {
  tab: 'connections',
  filtered: 0,
  items: [
    { id: '7682344871995308341', type: 'follow/you', title: '开始关注你了', time: 1788685301, from: { user_id: 'u-fan-1', nickname: '新粉丝', xsec_token: 'tok-fan-1' }, liked: false },
  ],
};

type RawResult = { content: { type: string; text?: string }[]; isError?: boolean };
const text = (t: string, isError = false): RawResult => ({ content: [{ type: 'text', text: t }], isError });

function setup(handlers: Record<string, (args: Record<string, unknown>) => RawResult>, loggedIn = true) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params: Record<string, unknown> };
    if (body.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (body.method === 'initialize') return reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'xiaohongshu-mcp' }, capabilities: {} });
    if (body.method === 'tools/list') return reply({ tools: TOOLS.map((name) => ({ name })) });
    const tool = String(body.params.name);
    const args = (body.params.arguments ?? {}) as Record<string, unknown>;
    calls.push({ tool, args });
    if (handlers[tool]) return reply(handlers[tool](args));
    if (tool === 'check_login_status') return reply(text(loggedIn ? LOGGED_IN_TEXT : '❌ 未登录'));
    return reply(text(`unexpected tool ${tool}`, true));
  }) as typeof fetch;
  const provider = new McpXhsProvider(new ManualClock(TEST_NOW), { account_endpoints: { 'xhs-a': { url: ACCOUNT_URL } } }, { fetchImpl });
  return { provider, calls };
}

describe('notification payload parsing', () => {
  it('reads the three tabs, keeps the platform wording and the ids each action needs', () => {
    const likes = notificationsFrom(LIKES_PAYLOAD, 'likes');
    assert.equal(likes.tab, 'likes');
    assert.equal(likes.filtered, 1, 'entries the platform hid are carried through, not swallowed');
    assert.deepEqual(likes.items.map((i) => i.kind), ['like', 'collect']);
    assert.equal(likes.items[0].title, '赞了你的笔记');
    assert.equal(likes.items[0].occurred_at, new Date(1788774759 * 1000).toISOString(), 'epoch seconds');
    assert.equal(likes.items[0].note_id, 'feed-1');
    assert.equal(likes.items[0].note_xsec_token, 'tok-feed-1');
    assert.equal(likes.items[0].from_xsec_token, 'tok-liker-1');
    assert.equal(likes.items[0].comment_id, null);

    const mentions = notificationsFrom(MENTIONS_PAYLOAD, 'mentions');
    assert.equal(mentions.items[0].kind, 'comment');
    assert.equal(mentions.items[0].comment_id, 'cmt-1');
    assert.equal(mentions.items[0].comment_text, '这款落地多少钱？杭州有现车吗');

    const conns = notificationsFrom(CONNECTIONS_PAYLOAD, 'connections');
    assert.equal(conns.items[0].kind, 'follow');
    assert.equal(conns.items[0].note_id, null);
  });

  it('drops entries that cannot be acted on and accepts millisecond timestamps', () => {
    const page = notificationsFrom(
      {
        tab: 'likes',
        items: [
          { id: '', type: 'liked/item', time: 1788774759, from: { user_id: 'u1' } },
          { id: 'n2', type: 'liked/item', time: 1788774759, from: {} },
          { id: 'n3', type: 'liked/item', time: 0, from: { user_id: 'u3' } },
          { id: 'n4', type: 'liked/item', time: 1788774759000, from: { user_id: 'u4' } },
        ],
      },
      'likes',
    );
    assert.deepEqual(page.items.map((i) => i.provider_notification_id), ['n4']);
    assert.equal(page.items[0].occurred_at, new Date(1788774759000).toISOString());
  });

  it('classifies unknown type strings by the platform wording instead of guessing "like"', () => {
    assert.equal(notificationKindOf('brand/new/thing', '回复了你的评论', 'mentions', false), 'comment');
    assert.equal(notificationKindOf('brand/new/thing', '收藏了你的笔记', 'likes', false), 'collect');
    assert.equal(notificationKindOf('', '', 'mentions', false), 'mention');
    assert.equal(notificationKindOf('', '', 'likes', false), 'other');
  });

  it('unread counts sum the three tabs', () => {
    assert.deepEqual(unreadCountsFrom({ mentions: 2, likes: 5, connections: 1, unread: 8 }), { mentions: 2, likes: 5, connections: 1, total: 8 });
  });
});

describe('notification centre through the provider', () => {
  it('lists a tab, reports the capability and passes the limit', async () => {
    const { provider, calls } = setup({
      list_notifications: () => text(JSON.stringify(MENTIONS_PAYLOAD)),
      get_unread_count: () => text(JSON.stringify({ mentions: 1, likes: 0, connections: 0, unread: 1 })),
    });
    const caps = await provider.capabilities('xhs-a');
    assert.equal(caps.capabilities.read_notifications.status, 'AVAILABLE');
    assert.match(caps.capabilities.read_notifications.reason, /clears its unread badge/);

    const unread = await provider.getUnreadCounts('xhs-a');
    assert.equal(unread.ok && unread.data.total, 1);

    const page = await provider.listNotifications('xhs-a', { tab: 'mentions', limit: 5 });
    assert.equal(page.ok, true);
    if (page.ok) assert.equal(page.data.items[0].comment_id, 'cmt-1');
    assert.deepEqual(calls.find((c) => c.tool === 'list_notifications')?.args, { tab: 'mentions', limit: 5 });
  });

  it('a logged-out session is REQUIRES_AUTH, never an empty inbox', async () => {
    const { provider, calls } = setup({ get_unread_count: () => text('获取未读数失败: 读取未读数失败: context deadline exceeded', true) }, false);
    const res = await provider.listNotifications('xhs-a', { tab: 'likes' });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.status, 'REQUIRES_AUTH');
    assert.equal(calls.filter((c) => c.tool === 'list_notifications').length, 0, 'no tool call on a logged-out session');
    const caps = await provider.capabilities('xhs-a');
    assert.equal(caps.capabilities.read_notifications.status, 'REQUIRES_AUTH');
  });

  it('a reply is confirmed by the JSON record the tool returns; a refusal fails', async () => {
    const { provider, calls } = setup({
      reply_notification: (args) => text(JSON.stringify({ comment_id: args.comment_id, nickname: '想换车的小王', feed_id: 'feed-1', content: args.content })),
      like_notification: () => text(JSON.stringify({ comment_id: 'cmt-1', liked: true })),
    });
    const reply = await provider.replyToNotification('xhs-a', 'cmt-1', '已私信您报价');
    assert.equal(reply.ok, true);
    if (reply.ok) assert.match(reply.data.provider_message_id, /^xhs-mcp-notify-reply:cmt-1:/);
    assert.deepEqual(calls.find((c) => c.tool === 'reply_notification')?.args, { comment_id: 'cmt-1', content: '已私信您报价' });

    const like = await provider.likeNotificationComment('xhs-a', 'cmt-1');
    assert.equal(like.ok && like.data.liked, true);

    const refused = setup({ reply_notification: () => text('回复失败: 该评论已删除或不可见，不能回复', true) });
    const bad = await refused.provider.replyToNotification('xhs-a', 'cmt-x', '你好');
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.reason, /不能回复/);
  });

  it('refuses to act without a comment id or text instead of calling the tool', async () => {
    const { provider, calls } = setup({});
    assert.equal((await provider.replyToNotification('xhs-a', '', 'hi')).ok, false);
    assert.equal((await provider.replyToNotification('xhs-a', 'cmt-1', '   ')).ok, false);
    assert.equal((await provider.likeNotificationComment('xhs-a', '')).ok, false);
    assert.equal(calls.length, 0);
  });
});
