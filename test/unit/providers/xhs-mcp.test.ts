import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ManualClock } from '../../../src/core/clock.ts';
import { McpError, McpHttpClient, parseSseMessages } from '../../../src/providers/xhs/mcp-client.ts';
import {
  classifyToolText,
  DM_TOOL_PATTERN,
  mapFeed,
  McpXhsProvider,
  NO_ENDPOINT_REASON,
  toCount,
  type McpProviderConfig,
} from '../../../src/providers/xhs/mcp-provider.ts';
import { createXhsProvider, xhsProviderConfigFromEnv } from '../../../src/providers/xhs/index.ts';
import { ValidationError } from '../../../src/core/errors.ts';
import type { ProviderResult } from '../../../src/providers/xhs/types.ts';
import { TEST_NOW } from '../../helpers/context.ts';

const XHS_MCP_TOOLS = [
  'check_login_status', 'get_login_qrcode', 'delete_cookies', 'publish_content', 'list_feeds', 'search_feeds', 'get_feed_detail',
  'user_profile', 'post_comment_to_feed', 'reply_comment_in_feed', 'publish_with_video', 'like_feed', 'favorite_feed',
  'get_my_profile', 'get_unread_count', 'list_notifications', 'reply_notification', 'like_notification',
];

type ToolReply = { text: string; isError?: boolean };
interface ServerOpts {
  loggedIn?: boolean;
  tools?: string[];
  sse?: boolean;
  statelessNoInit?: boolean;
  sessionId?: string;
  down?: boolean;
  handlers?: Record<string, (args: Record<string, unknown>) => ToolReply>;
}
interface Call { url: string; method: string; params: Record<string, unknown>; headers: Headers }

const FEED = {
  xsecToken: 'tok-1', id: '66e1aa', modelType: 'note', index: 0,
  noteCard: { type: 'normal', displayTitle: '宝马i3值得买吗', user: { userId: 'kol-1', nickName: '电车老司机阿杰' }, interactInfo: { likedCount: '1.2万', commentCount: '35', collectedCount: '200' } },
};
const NOTE_DETAIL = {
  feed_id: '66e1aa',
  data: {
    note: {
      noteId: '66e1aa', xsecToken: 'tok-1', title: '宝马i3现在值得买吗？', desc: '开了一周35L #宝马i3[话题]# #新能源汽车[话题]#', type: 'normal',
      time: 1789000000000, ipLocation: '上海', user: { userId: 'kol-1', nickname: '电车老司机阿杰' },
      interactInfo: { likedCount: '2386', commentCount: '214', collectedCount: '912', sharedCount: '10' }, imageList: [{ url: 'x' }],
    },
    comments: {
      list: [
        {
          id: 'c1', noteId: '66e1aa', content: '现在优惠多少', likeCount: '25', createTime: 1789100000000, ipLocation: '浙江', userInfo: { userId: 'u2', nickname: '今天也要早睡' },
          subCommentCount: '1', subComments: [{ id: 'c1r', content: '同问', likeCount: '1', createTime: 1789100100000, ipLocation: '北京', userInfo: { userId: 'u3', nickname: '桃子汽水' } }],
        },
        { id: 'c2', content: '帅', likeCount: 0, createTime: 1789100200000, userInfo: { userId: 'u4', nickname: '小熊软糖' }, subComments: [] },
      ],
      cursor: '', hasMore: false,
    },
  },
};

function network(servers: Record<string, ServerOpts>) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const server = servers[url];
    if (!server || server.down) throw new TypeError('fetch failed: connect ECONNREFUSED');
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params: Record<string, unknown> };
    calls.push({ url, method: body.method, params: body.params, headers });
    if (body.id === undefined) return new Response(null, { status: 202 });
    let payload: Record<string, unknown>;
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: body.id, result });
    if (body.method === 'initialize') {
      payload = server.statelessNoInit
        ? { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } }
        : reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'xiaohongshu-mcp', version: '2.0' }, capabilities: { tools: {} } });
    } else if (body.method === 'tools/list') {
      payload = reply({ tools: (server.tools ?? XHS_MCP_TOOLS).map((name) => ({ name, inputSchema: { type: 'object' } })) });
    } else if (body.method === 'tools/call') {
      const name = String(body.params.name);
      const args = (body.params.arguments ?? {}) as Record<string, unknown>;
      let r: ToolReply;
      if (server.handlers?.[name]) r = server.handlers[name](args);
      else if (name === 'check_login_status') r = { text: server.loggedIn === false ? '❌ 未登录\n请使用 get_login_qrcode 获取二维码' : '✅ 已登录\n用户名: i3电车研究所' };
      else r = { text: `unexpected tool ${name}`, isError: true };
      payload = reply({ content: [{ type: 'text', text: r.text }], isError: r.isError ?? false });
    } else {
      payload = { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `unknown method ${body.method}` } };
    }
    const resHeaders: Record<string, string> = { 'content-type': server.sse ? 'text/event-stream' : 'application/json' };
    if (server.sessionId) resHeaders['mcp-session-id'] = server.sessionId;
    const text = server.sse ? `event: message\ndata: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload);
    return new Response(text, { status: 200, headers: resHeaders });
  };
  return { fetchImpl: fetchImpl as typeof fetch, calls, toolCalls: (name: string) => calls.filter((c) => c.method === 'tools/call' && c.params.name === name) };
}

const RESEARCH = 'http://127.0.0.1:18060/mcp';
const I3 = 'http://127.0.0.1:18061/mcp';
const LI = 'http://127.0.0.1:18062/mcp';

function setup(servers: Record<string, ServerOpts>, cfg: Partial<McpProviderConfig> = {}, resolveAccount?: (id: string) => string | null) {
  const clock = new ManualClock(TEST_NOW);
  const net = network(servers);
  const provider = new McpXhsProvider(
    clock,
    { research_endpoint: { url: RESEARCH, token: 'research-token' }, account_endpoints: { 'xhs-hz-i3': { url: I3, token: 'i3-token' }, 'xhs-hz-sales-li': { url: LI } }, ...cfg },
    { fetchImpl: net.fetchImpl, resolveAccount },
  );
  return { clock, net, provider };
}

function unwrap<T>(res: ProviderResult<T>): T {
  if (!res.ok) assert.fail(`expected ok, got ${res.status}: ${res.reason}`);
  return res.data;
}

describe('McpHttpClient', () => {
  it('performs the initialize handshake, sends auth + accept headers and echoes the session id', async () => {
    const net = network({ [I3]: { sessionId: 'sess-42' } });
    const client = new McpHttpClient({ url: I3, token: 'tkn', fetchImpl: net.fetchImpl });
    const tools = await client.listTools();
    assert.equal(tools.length, XHS_MCP_TOOLS.length);
    assert.deepEqual(net.calls.map((c) => c.method), ['initialize', 'notifications/initialized', 'tools/list']);
    const init = net.calls[0];
    assert.equal(init.params.protocolVersion, '2025-06-18');
    assert.equal((init.params.clientInfo as { name: string }).name, 'xhs-auto-operator');
    assert.equal(init.headers.get('accept'), 'application/json, text/event-stream');
    assert.equal(init.headers.get('content-type'), 'application/json');
    assert.equal(init.headers.get('authorization'), 'Bearer tkn');
    assert.equal(init.headers.get('mcp-session-id'), null);
    assert.equal(net.calls[2].headers.get('mcp-session-id'), 'sess-42');
    assert.equal(client.sessionId, 'sess-42');
    await client.listTools();
    assert.equal(net.calls.filter((c) => c.method === 'initialize').length, 1, 'handshake happens once');
  });

  it('tolerates stateless servers that reject initialize', async () => {
    const net = network({ [RESEARCH]: { statelessNoInit: true } });
    const client = new McpHttpClient({ url: RESEARCH, fetchImpl: net.fetchImpl });
    const res = await client.callTool('check_login_status');
    assert.match(res.text, /已登录/);
    assert.equal(res.isError, false);
    assert.equal(client.server, null);
    assert.equal(net.calls.at(-1)?.headers.get('authorization'), null);
  });

  it('parses SSE response bodies', async () => {
    const net = network({ [I3]: { sse: true } });
    const client = new McpHttpClient({ url: I3, fetchImpl: net.fetchImpl });
    const res = await client.callTool('check_login_status', {});
    assert.match(res.text, /已登录/);
    const multi = parseSseMessages('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n: keep-alive\n\nid: 7\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":3,"result":{}}\r\n\r\n');
    assert.deepEqual(multi, [{ jsonrpc: '2.0', method: 'notifications/progress' }, { jsonrpc: '2.0', id: 3, result: {} }]);
  });

  it('maps failures to typed McpError kinds', async () => {
    const toolErr = network({ [I3]: { handlers: { publish_content: () => ({ text: '发布失败: 图片不能为空', isError: true }) } } });
    await assert.rejects(new McpHttpClient({ url: I3, fetchImpl: toolErr.fetchImpl }).callTool('publish_content', {}), (e: unknown) => e instanceof McpError && e.kind === 'tool' && /图片不能为空/.test(e.message));
    await assert.rejects(new McpHttpClient({ url: I3, fetchImpl: toolErr.fetchImpl }).request('resources/list', {}), (e: unknown) => e instanceof McpError && e.kind === 'rpc' && e.code === -32601);
    const down = network({});
    await assert.rejects(new McpHttpClient({ url: I3, fetchImpl: down.fetchImpl }).listTools(), (e: unknown) => e instanceof McpError && e.kind === 'network');
    const http500 = (async () => new Response('internal boom', { status: 500 })) as unknown as typeof fetch;
    await assert.rejects(new McpHttpClient({ url: I3, fetchImpl: http500 }).listTools(), (e: unknown) => e instanceof McpError && e.kind === 'http' && e.status === 500);
    const hanging = ((_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch;
    await assert.rejects(new McpHttpClient({ url: I3, fetchImpl: hanging, timeoutMs: 20 }).listTools(), (e: unknown) => e instanceof McpError && e.kind === 'timeout');
    assert.throws(() => new McpHttpClient({ url: 'ftp://nope' }), McpError);
  });

  it('re-initializes once when the server expires the session (HTTP 404)', async () => {
    let expired = false;
    const inner = network({ [I3]: { sessionId: 'sess-1' } });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      if (body.method === 'tools/list' && !expired) {
        expired = true;
        return new Response('session not found', { status: 404 });
      }
      return inner.fetchImpl(input, init);
    }) as typeof fetch;
    const client = new McpHttpClient({ url: I3, fetchImpl });
    await client.initialize();
    const tools = await client.listTools();
    assert.ok(tools.length > 0);
    assert.equal(inner.calls.filter((c) => c.method === 'initialize').length, 2);
  });
});

describe('McpXhsProvider capabilities', () => {
  it('logged in: maps tools to capabilities, DMs UNAVAILABLE, tools/list cached for 5 minutes', async () => {
    const { provider, net, clock } = setup({ [I3]: {} });
    const report = await provider.capabilities('xhs-hz-i3');
    assert.equal(report.provider, 'xiaohongshu-mcp');
    assert.equal(report.mode, 'live');
    for (const cap of ['search_public_content', 'read_public_post', 'read_public_comments', 'read_public_profile', 'publish_content', 'read_engagement', 'reply_comments'] as const) {
      assert.equal(report.capabilities[cap].status, 'AVAILABLE', cap);
    }
    assert.match(report.capabilities.search_public_content.reason, /search_feeds/);
    assert.match(report.capabilities.read_engagement.reason, /no view counts/);
    assert.equal(report.capabilities.send_messages.status, 'UNAVAILABLE');
    assert.match(report.capabilities.send_messages.reason, /no authorized API/);
    assert.equal(report.capabilities.receive_messages.status, 'UNAVAILABLE');
    assert.match(report.capabilities.receive_messages.reason, /私信通/);

    await provider.capabilities('xhs-hz-i3');
    assert.equal(net.calls.filter((c) => c.method === 'tools/list').length, 1, 'cached');
    assert.equal(net.toolCalls('check_login_status').length, 2, 'login re-checked each time');
    clock.advance({ minutes: 6 });
    await provider.capabilities('xhs-hz-i3');
    assert.equal(net.calls.filter((c) => c.method === 'tools/list').length, 2, 'cache expired after 5 min');
    assert.equal(net.calls[0].headers.get('authorization'), 'Bearer i3-token');
  });

  it('not logged in: login-dependent capabilities REQUIRES_AUTH', async () => {
    const { provider } = setup({ [LI]: { loggedIn: false } });
    const report = await provider.capabilities('xhs-hz-sales-li');
    for (const cap of ['search_public_content', 'read_public_post', 'read_public_comments', 'read_public_profile', 'publish_content', 'read_engagement', 'reply_comments'] as const) {
      assert.equal(report.capabilities[cap].status, 'REQUIRES_AUTH', cap);
    }
    assert.match(report.capabilities.publish_content.reason, /get_login_qrcode/);
    assert.equal(report.capabilities.send_messages.status, 'UNAVAILABLE');
  });

  it('no endpoint → UNAVAILABLE; network failure → UNAVAILABLE and retryable', async () => {
    const clock = new ManualClock(TEST_NOW);
    const bare = new McpXhsProvider(clock, { account_endpoints: {} }, network({}).fetchImpl);
    const report = await bare.capabilities('acc_x');
    assert.equal(report.capabilities.publish_content.status, 'UNAVAILABLE');
    assert.equal(report.capabilities.publish_content.reason, 'no xiaohongshu-mcp endpoint configured for this account');
    assert.equal(report.capabilities.search_public_content.status, 'UNAVAILABLE');
    const pub = await bare.publishNote('acc_x', { title: 't', body: 'b', tags: [], images: ['/tmp/a.jpg'] });
    assert.deepEqual(pub, { ok: false, status: 'UNAVAILABLE', reason: 'no xiaohongshu-mcp endpoint configured for this account', retryable: false });
    assert.equal((await bare.searchNotes('宝马i3')).ok, false);

    const { provider } = setup({ [I3]: { down: true }, [RESEARCH]: { down: true } });
    const down = await provider.capabilities('xhs-hz-i3');
    assert.equal(down.capabilities.search_public_content.status, 'UNAVAILABLE');
    assert.match(down.capabilities.search_public_content.reason, /unreachable/);
    const search = await provider.searchNotes('宝马i3', {}, 'xhs-hz-i3');
    assert.equal(search.ok, false);
    if (!search.ok) {
      assert.equal(search.status, 'UNAVAILABLE');
      assert.equal(search.retryable, true);
    }
  });

  it('DM-like tools are REQUIRES_REVIEW (even with enable_dm_tools) and never called', async () => {
    const tools = [...XHS_MCP_TOOLS, 'send_private_message'];
    for (const enable of [false, true]) {
      const { provider, net } = setup({ [I3]: { tools } }, { enable_dm_tools: enable });
      const report = await provider.capabilities('xhs-hz-i3');
      assert.equal(report.capabilities.send_messages.status, 'REQUIRES_REVIEW');
      assert.equal(report.capabilities.receive_messages.status, 'REQUIRES_REVIEW');
      assert.match(report.capabilities.send_messages.reason, /DM-like tool detected \(send_private_message\) but unverified; not enabled/);
      const send = await provider.sendMessage('xhs-hz-i3', 'u-hz-buyer-001', '你好');
      assert.equal(send.ok, false);
      if (!send.ok) assert.equal(send.status, 'REQUIRES_REVIEW');
      assert.equal(net.toolCalls('send_private_message').length, 0);
    }
    const { provider } = setup({ [I3]: {} });
    const send = await provider.sendMessage('xhs-hz-i3', 'u', 'hi');
    assert.ok(!send.ok && send.status === 'UNAVAILABLE');
    const inbox = await provider.listInboundMessages('xhs-hz-i3', null);
    assert.ok(!inbox.ok && inbox.status === 'UNAVAILABLE' && /私信通/.test(inbox.reason));
  });
});

describe('McpXhsProvider payload mapping', () => {
  it('search_feeds → XhsNoteSummary with filters, tolerant counts and non-note skipping', async () => {
    const { provider, net } = setup({
      [RESEARCH]: { handlers: { search_feeds: () => ({ text: JSON.stringify({ feeds: [FEED, { id: 'hq', modelType: 'hot_query' }, { ...FEED, id: '77f2', xsecToken: 'tok-2', noteCard: { displayTitle: 'X3', user: { userId: 'u9', nickname: '李' }, interactInfo: { likedCount: 12 } } }], count: 3 }) }) } },
    });
    const notes = unwrap(await provider.searchNotes('宝马i3', { sort: 'latest', published_within_days: 7, limit: 5 }));
    assert.equal(notes.length, 2);
    assert.deepEqual(net.toolCalls('search_feeds')[0].params.arguments, { keyword: '宝马i3', filters: { sort_by: '最新', publish_time: '一周内' } });
    assert.equal(net.toolCalls('search_feeds')[0].url, RESEARCH, 'public read without account uses the research endpoint');
    const [n] = notes;
    assert.equal(n.platform_post_id, '66e1aa');
    assert.equal(n.xsec_token, 'tok-1');
    assert.equal(n.title, '宝马i3值得买吗');
    assert.deepEqual(n.author, { platform_user_id: 'kol-1', nickname: '电车老司机阿杰', profile_url: 'https://www.xiaohongshu.com/user/profile/kol-1', avatar_url: null });
    assert.equal(n.like_count, 12000);
    assert.equal(n.url, 'https://www.xiaohongshu.com/explore/66e1aa?xsec_token=tok-1');
    assert.equal(n.published_at, null);
    assert.equal(notes[1].like_count, 12);
    assert.equal(unwrap(await provider.searchNotes('宝马i3', { limit: 1 })).length, 1);
    assert.equal(toCount('10w+'), 100000);
    assert.equal(toCount('3.5千'), 3500);
    assert.equal(toCount('n/a'), 0);
  });

  it('search cards carry the comment count when the platform shows it', () => {
    const card = (interactInfo: Record<string, unknown>) => mapFeed({ id: 'n1', xsecToken: 't', modelType: 'note', noteCard: { displayTitle: 'x', user: { userId: 'u' }, interactInfo } });
    assert.equal(card({ likedCount: '2', commentCount: '227' })?.comment_count, 227);
    assert.equal(card({ likedCount: '2', commentCount: '1.2万' })?.comment_count, 12000);
    assert.equal(card({ likedCount: '2' })?.comment_count, null, 'absent is unknown, never 0');
  });

  it('getNoteWithComments reads the detail and its comments with ONE get_feed_detail call', async () => {
    const { provider, net } = setup({ [I3]: { handlers: { get_feed_detail: () => ({ text: JSON.stringify(NOTE_DETAIL) }) } } });
    const ref = { platform_post_id: '66e1aa', xsec_token: 'tok-1' };
    const both = unwrap(await provider.getNoteWithComments(ref, { include_replies: true, limit: 50 }, 'xhs-hz-i3'));
    assert.equal(net.toolCalls('get_feed_detail').length, 1, 'one page load for detail + comments');
    assert.deepEqual(net.toolCalls('get_feed_detail')[0].params.arguments, { feed_id: '66e1aa', xsec_token: 'tok-1', load_all_comments: true, limit: 50, click_more_replies: true, reply_limit: 10 });
    assert.deepEqual(both.note, unwrap(await provider.getNote(ref, 'xhs-hz-i3')), 'same note as getNote');
    assert.deepEqual(both.comments, unwrap(await provider.getComments(ref, { include_replies: true, limit: 50 }, 'xhs-hz-i3')), 'same comments as getComments');
    const noToken = await provider.getNoteWithComments({ platform_post_id: '66e1aa' }, {}, 'xhs-hz-i3');
    assert.ok(!noToken.ok && /xsec_token/.test(noToken.reason));
  });

  it('get_feed_detail → XhsNoteDetail and XhsComment (ms → ISO, replies flattened)', async () => {
    const { provider, net } = setup({ [I3]: { handlers: { get_feed_detail: () => ({ text: JSON.stringify(NOTE_DETAIL) }) } } });
    const ref = { platform_post_id: '66e1aa', xsec_token: 'tok-1' };
    const note = unwrap(await provider.getNote(ref, 'xhs-hz-i3'));
    assert.equal(net.toolCalls('get_feed_detail')[0].url, I3);
    assert.equal(note.title, '宝马i3现在值得买吗？');
    assert.equal(note.content, NOTE_DETAIL.data.note.desc);
    assert.deepEqual(note.tags, ['宝马i3', '新能源汽车']);
    assert.equal(note.published_at, new Date(1789000000000).toISOString());
    assert.equal(note.ip_location, '上海');
    assert.deepEqual([note.like_count, note.comment_count, note.collect_count], [2386, 214, 912]);
    assert.equal(note.author.nickname, '电车老司机阿杰');

    const flat = unwrap(await provider.getComments(ref, { include_replies: true, limit: 50 }, 'xhs-hz-i3'));
    assert.deepEqual(net.toolCalls('get_feed_detail')[1].params.arguments, { feed_id: '66e1aa', xsec_token: 'tok-1', load_all_comments: true, limit: 50, click_more_replies: true, reply_limit: 10 });
    assert.deepEqual(flat.map((c) => [c.platform_comment_id, c.parent_comment_id]), [['c1', null], ['c1r', 'c1'], ['c2', null]]);
    const c1 = flat[0];
    assert.equal(c1.content, '现在优惠多少');
    assert.equal(c1.like_count, 25);
    assert.equal(c1.published_at, new Date(1789100000000).toISOString());
    assert.equal(c1.ip_location, '浙江');
    assert.deepEqual(c1.author, { platform_user_id: 'u2', nickname: '今天也要早睡', profile_url: 'https://www.xiaohongshu.com/user/profile/u2', avatar_url: null });
    assert.equal(flat[2].ip_location, null);
    const tops = unwrap(await provider.getComments(ref, {}, 'xhs-hz-i3'));
    assert.deepEqual(tops.map((c) => c.platform_comment_id), ['c1', 'c2']);
    assert.equal(tops[0].sub_comments, undefined);

    const noToken = await provider.getComments({ platform_post_id: '66e1aa' }, {}, 'xhs-hz-i3');
    assert.ok(!noToken.ok && /xsec_token/.test(noToken.reason));
    assert.equal(net.toolCalls('get_feed_detail').length, 3, 'no call without xsec_token');
  });

  it('user_profile → XhsUserProfile', async () => {
    const profile = { userBasicInfo: { gender: 1, nickname: '西湖边的小鹿', desc: '杭州｜准备换电车', ipLocation: '浙江', redId: '950123' }, interactions: [{ type: 'follows', name: '关注', count: '10' }, { type: 'fans', name: '粉丝', count: '1.5万' }], feeds: [FEED] };
    const { provider, net } = setup({ [RESEARCH]: { handlers: { user_profile: () => ({ text: JSON.stringify(profile) }) } } });
    const p = unwrap(await provider.getUserProfile({ platform_user_id: 'u-hz-buyer-001', xsec_token: 'tok-u' }));
    assert.deepEqual(net.toolCalls('user_profile')[0].params.arguments, { user_id: 'u-hz-buyer-001', xsec_token: 'tok-u' });
    assert.equal(p.nickname, '西湖边的小鹿');
    assert.equal(p.bio, '杭州｜准备换电车');
    assert.equal(p.ip_location, '浙江');
    assert.equal(p.follower_count, 15000);
    assert.equal(p.profile_url, 'https://www.xiaohongshu.com/user/profile/u-hz-buyer-001');
    assert.deepEqual(p.recent_notes.map((n) => n.platform_post_id), ['66e1aa']);
    const noToken = await provider.getUserProfile({ platform_user_id: 'u' });
    assert.ok(!noToken.ok && noToken.status === 'UNAVAILABLE');
  });

  it('publish_content: images required, success yields null note id, 失败 text is a failure', async () => {
    let publishText = '内容发布成功: 杭州i3到店';
    const { provider, net } = setup({ [I3]: { handlers: { publish_content: () => ({ text: publishText }) } } });
    const noImages = await provider.publishNote('xhs-hz-i3', { title: '杭州i3到店', body: '欢迎看车', tags: ['宝马i3'] });
    assert.deepEqual(noImages, { ok: false, status: 'REQUIRES_REVIEW', reason: 'xiaohongshu-mcp requires at least one image', retryable: false });
    assert.equal(net.toolCalls('publish_content').length, 0);

    const ok = unwrap(await provider.publishNote('xhs-hz-i3', { title: '杭州i3到店', body: '欢迎看车', tags: ['宝马i3'], images: ['/data/i3.jpg'] }));
    assert.deepEqual(ok, { platform_note_id: null, url: null });
    assert.deepEqual(net.toolCalls('publish_content')[0].params.arguments, { title: '杭州i3到店', content: '欢迎看车', images: ['/data/i3.jpg'], tags: ['宝马i3'] });

    publishText = '发布失败: 标题长度超过限制';
    const failed = await provider.publishNote('xhs-hz-i3', { title: 'x'.repeat(40), body: 'b', tags: [], images: ['/data/i3.jpg'] });
    assert.ok(!failed.ok && failed.status === 'UNAVAILABLE' && /标题长度超过限制/.test(failed.reason));
    const other = await provider.publishNote('unknown-account', { title: 't', body: 'b', tags: [], images: ['/a.jpg'] });
    assert.ok(!other.ok && other.reason === 'no xiaohongshu-mcp endpoint configured for this account');
  });

  it('publish_with_video: a video note takes one local path and never carries images', async () => {
    const { provider, net } = setup({ [I3]: { handlers: { publish_with_video: () => ({ text: '视频发布成功: 提车日' }) } } });
    const ok = unwrap(
      await provider.publishNote('xhs-hz-i3', { title: '提车日', body: '今天交付', tags: ['提车'], images: ['/data/i3.jpg'], video: '/data/tiche.mp4' }),
    );
    assert.deepEqual(ok, { platform_note_id: null, url: null });
    assert.deepEqual(net.toolCalls('publish_with_video')[0].params.arguments, { title: '提车日', content: '今天交付', video: '/data/tiche.mp4', tags: ['提车'] });
    assert.equal(net.toolCalls('publish_content').length, 0, 'a video note does not go through the image publisher');

    const url = await provider.publishNote('xhs-hz-i3', { title: 't', body: 'b', tags: [], video: 'https://example.com/a.mp4' });
    assert.ok(!url.ok && /absolute local path/.test(url.reason));
    assert.equal(net.toolCalls('publish_with_video').length, 1);

    const withoutTool = setup({ [I3]: { tools: XHS_MCP_TOOLS.filter((t) => t !== 'publish_with_video') } });
    const missing = await withoutTool.provider.publishNote('xhs-hz-i3', { title: 't', body: 'b', tags: [], video: '/data/a.mp4' });
    assert.ok(!missing.ok && /publish_with_video not exposed/.test(missing.reason));
  });

  it('engagement via get_my_profile, comment replies and logged-out tool text', async () => {
    const myProfile = { userBasicInfo: { nickname: 'i3电车研究所' }, feeds: [{ ...FEED, id: 'own-1', noteCard: { ...FEED.noteCard, interactInfo: { likedCount: '368', collectedCount: '142', commentCount: '9', sharedCount: '4' } } }] };
    const { provider, net } = setup(
      {
        [I3]: {
          handlers: {
            get_my_profile: () => ({ text: JSON.stringify(myProfile) }),
            reply_comment_in_feed: () => ({ text: '评论回复成功' }),
            search_feeds: () => ({ text: '未登录，请先扫码登录' }),
          },
        },
      },
      {},
      (internal) => (internal === 'acc_i3' ? 'xhs-hz-i3' : null),
    );
    const e = unwrap(await provider.getEngagement('acc_i3', 'own-1'));
    assert.deepEqual(e, { platform_note_id: 'own-1', views: null, likes: 368, collects: 142, comments: 9, shares: 4 });
    assert.deepEqual(net.toolCalls('get_my_profile')[0].params.arguments, { tab: 'note' });
    assert.equal(net.toolCalls('get_my_profile')[0].url, I3, 'internal id resolved to the account endpoint');
    const missing = await provider.getEngagement('acc_i3', 'not-mine');
    assert.ok(!missing.ok && /not found/.test(missing.reason));

    const reply = unwrap(await provider.replyToComment('acc_i3', { platform_post_id: 'own-1', xsec_token: 'tok-1', platform_comment_id: 'c9', platform_user_id: 'u9' }, '在的，欢迎到店'));
    assert.match(reply.provider_message_id, /^xhs-mcp-reply:c9:/);
    assert.deepEqual(net.toolCalls('reply_comment_in_feed')[0].params.arguments, { feed_id: 'own-1', xsec_token: 'tok-1', content: '在的，欢迎到店', comment_id: 'c9', user_id: 'u9' });

    const loggedOut = await provider.searchNotes('宝马i3', {}, 'acc_i3');
    assert.ok(!loggedOut.ok && loggedOut.status === 'REQUIRES_AUTH');
  });

  it('falls back to an account endpoint for public reads when no research endpoint exists', async () => {
    const clock = new ManualClock(TEST_NOW);
    const net = network({ [LI]: { handlers: { search_feeds: () => ({ text: JSON.stringify({ feeds: [FEED], count: 1 }) }) } } });
    const provider = new McpXhsProvider(clock, { account_endpoints: { 'xhs-hz-sales-li': { url: LI } } }, net.fetchImpl);
    assert.equal(unwrap(await provider.searchNotes('X3')).length, 1);
    assert.equal(net.toolCalls('search_feeds')[0].url, LI);
    const report = await provider.capabilities(null);
    assert.equal(report.capabilities.search_public_content.status, 'AVAILABLE');
    assert.equal(report.capabilities.publish_content.status, 'UNAVAILABLE', 'account-specific without account id');
    assert.throws(() => new McpXhsProvider(clock, { account_endpoints: { bad: { url: 'nope' } } }), /account_endpoints/);
  });
});

describe('McpXhsProvider hardening', () => {
  type Fault = 'hang' | 'reset' | 'refused' | 'http500' | 'http503' | 'http504' | null;
  function faulty(servers: Record<string, ServerOpts>) {
    const net = network(servers);
    const state: { fault: Fault; onlyTool: string | null } = { fault: null, onlyTool: null };
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params?: { name?: string } };
      const hit = body.method === 'tools/call' && state.fault && (!state.onlyTool || body.params?.name === state.onlyTool);
      if (hit) {
        net.calls.push({ url: String(input), method: body.method, params: (body.params ?? {}) as Record<string, unknown>, headers: new Headers(init?.headers) });
        switch (state.fault) {
          case 'hang':
            return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
          case 'reset':
            throw new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
          case 'refused':
            throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:18061'), { code: 'ECONNREFUSED' }) });
          case 'http500':
            return new Response('internal error', { status: 500 });
          case 'http503':
            return new Response('busy', { status: 503 });
          case 'http504':
            return new Response('gateway timeout', { status: 504 });
        }
      }
      return net.fetchImpl(input, init);
    }) as typeof fetch;
    return { net, state, fetchImpl };
  }
  const DRAFT = { title: '杭州i3到店', body: '白外红内实拍，欢迎到店看车', tags: ['宝马i3'], images: ['/data/i3.jpg'] };
  const REPLY_REF = { platform_post_id: 'own-1', xsec_token: 'tok-1', platform_comment_id: 'c9', platform_user_id: 'u9' };

  it('classifies tool text by its earliest marker', () => {
    assert.equal(classifyToolText('内容发布成功: {Title:我的砍价失败经历 Content:…}'), 'success');
    assert.equal(classifyToolText('发布失败: 未能成功上传图片'), 'failure');
    assert.equal(classifyToolText('❌ 未登录，发布失败'), 'login_required');
    assert.equal(classifyToolText('已提交，请稍后在App中查看'), 'none');
    assert.equal(classifyToolText(''), 'none');
    assert.equal(classifyToolText('Publish successful'), 'success');
    assert.equal(classifyToolText('publish failed: timeout'), 'failure');
  });

  it('write tools: echoed content never flips the verdict; unconfirmed results are REQUIRES_REVIEW and not retryable', async () => {
    let publishText = '内容发布成功: {Title:杭州i3到店 Content:上次砍价失败了，这次终于谈拢}';
    let replyText = '评论回复成功';
    const { provider, net } = setup({ [I3]: { handlers: { publish_content: () => ({ text: publishText }), reply_comment_in_feed: () => ({ text: replyText }) } } });
    assert.deepEqual(unwrap(await provider.publishNote('xhs-hz-i3', DRAFT)), { platform_note_id: null, url: null });

    publishText = '发布失败: 未能成功上传图片';
    const failed = await provider.publishNote('xhs-hz-i3', DRAFT);
    assert.ok(!failed.ok && failed.status === 'UNAVAILABLE' && failed.retryable === true, JSON.stringify(failed));

    for (const ambiguous of ['已提交，请稍后在App中查看', '']) {
      publishText = ambiguous;
      const unknown = await provider.publishNote('xhs-hz-i3', DRAFT);
      assert.ok(!unknown.ok, 'no fabricated success');
      if (!unknown.ok) {
        assert.equal(unknown.status, 'REQUIRES_REVIEW');
        assert.equal(unknown.retryable, false);
        assert.match(unknown.reason, /outcome unknown/);
        assert.match(unknown.reason, /verify on the Xiaohongshu account before retrying/);
      }
    }
    publishText = '⚠️ 未登录，请先扫码登录';
    const auth = await provider.publishNote('xhs-hz-i3', DRAFT);
    assert.ok(!auth.ok && auth.status === 'REQUIRES_AUTH');

    replyText = 'ok';
    const reply = await provider.replyToComment('xhs-hz-i3', REPLY_REF, '在的，欢迎到店');
    assert.ok(!reply.ok && reply.status === 'REQUIRES_REVIEW' && reply.retryable === false);
    assert.equal(net.toolCalls('publish_content').length, 5);

    // reads: JSON payloads that merely contain 失败 in user content are fine
    const { provider: reader } = setup({ [RESEARCH]: { handlers: { search_feeds: () => ({ text: JSON.stringify({ feeds: [{ ...FEED, noteCard: { ...FEED.noteCard, displayTitle: '砍价失败复盘' } }] }) }) } } });
    assert.equal(unwrap(await reader.searchNotes('砍价'))[0].title, '砍价失败复盘');
  });

  it('write outcome unknown after dispatch (timeout / socket reset / 5xx) → REQUIRES_REVIEW; never-sent → retryable UNAVAILABLE', async () => {
    const { net, state, fetchImpl } = faulty({ [I3]: { handlers: { publish_content: () => ({ text: '内容发布成功' }), search_feeds: () => ({ text: '{"feeds":[]}' }), reply_comment_in_feed: () => ({ text: '评论回复成功' }) } } });
    const clock = new ManualClock(TEST_NOW);
    const provider = new McpXhsProvider(clock, { account_endpoints: { 'xhs-hz-i3': { url: I3 } }, timeout_ms: 25 }, fetchImpl);

    const expectations: [Fault, 'REQUIRES_REVIEW' | 'UNAVAILABLE', boolean][] = [
      ['hang', 'REQUIRES_REVIEW', false],
      ['reset', 'REQUIRES_REVIEW', false],
      ['http504', 'REQUIRES_REVIEW', false],
      ['http500', 'REQUIRES_REVIEW', false],
      ['http503', 'UNAVAILABLE', true],
      ['refused', 'UNAVAILABLE', true],
    ];
    for (const [fault, status, retryable] of expectations) {
      state.fault = fault;
      const pub = await provider.publishNote('xhs-hz-i3', DRAFT);
      assert.ok(!pub.ok, `${fault}: publish must not succeed`);
      if (!pub.ok) {
        assert.equal(pub.status, status, `${fault}: ${pub.reason}`);
        assert.equal(pub.retryable, retryable, `${fault} retryable`);
      }
      const reply = await provider.replyToComment('xhs-hz-i3', REPLY_REF, '在的');
      assert.ok(!reply.ok && reply.status === status && reply.retryable === retryable, `${fault} reply: ${JSON.stringify(reply)}`);
    }
    // the same faults on a READ stay plain retryable failures
    state.fault = 'hang';
    const search = await provider.searchNotes('宝马i3', {}, 'xhs-hz-i3');
    assert.ok(!search.ok && search.status === 'UNAVAILABLE' && search.retryable === true);
    state.fault = null;
    assert.deepEqual(unwrap(await provider.publishNote('xhs-hz-i3', DRAFT)), { platform_note_id: null, url: null });
    assert.ok(net.toolCalls('publish_content').length >= 7);

    // endpoint down before the handshake: the tool call never left the process
    const down = new McpXhsProvider(clock, { account_endpoints: { 'xhs-hz-i3': { url: I3 } } }, network({ [I3]: { down: true } }).fetchImpl);
    const neverSent = await down.publishNote('xhs-hz-i3', DRAFT);
    assert.ok(!neverSent.ok && neverSent.status === 'UNAVAILABLE' && neverSent.retryable === true, JSON.stringify(neverSent));
  });

  it('rejects account endpoints that share one xiaohongshu-mcp instance (would act in another account session)', () => {
    const clock = new ManualClock(TEST_NOW);
    assert.throws(
      () => new McpXhsProvider(clock, { account_endpoints: { 'xhs-hz-i3': { url: 'http://127.0.0.1:18061/mcp' }, 'xhs-hz-sales-li': { url: 'HTTP://127.0.0.1:18061/mcp/' } } }),
      (e: unknown) => e instanceof ValidationError && /already configured for account xhs-hz-i3/.test(e.message),
    );
    assert.doesNotThrow(() => new McpXhsProvider(clock, { research_endpoint: { url: I3 }, account_endpoints: { 'xhs-hz-i3': { url: I3 }, 'xhs-hz-sales-li': { url: LI } } }), 'research may reuse an account instance');
    const env = xhsProviderConfigFromEnv({ XHS_PROVIDER: 'mcp', XHS_MCP_ACCOUNTS: 'a=http://10.0.0.5:18061/mcp,b=http://10.0.0.5:18061/mcp' });
    assert.throws(() => createXhsProvider(clock, env), /already configured for account a/);
  });

  it('applies published_within_days exactly when feeds carry timestamps', async () => {
    const now = Date.parse(TEST_NOW);
    const recent = { ...FEED, id: 'recent-1', noteCard: { ...FEED.noteCard, time: now - 2 * 86_400_000 } };
    const old = { ...FEED, id: 'old-1', noteCard: { ...FEED.noteCard, time: now - 40 * 86_400_000 } };
    const { provider, net } = setup({ [RESEARCH]: { handlers: { search_feeds: () => ({ text: JSON.stringify({ feeds: [recent, old, FEED] }) }) } } });
    const ids = unwrap(await provider.searchNotes('宝马i3', { published_within_days: 30 })).map((n) => n.platform_post_id);
    assert.deepEqual(ids, ['recent-1', '66e1aa'], 'old note dropped, undated note kept');
    assert.deepEqual((net.toolCalls('search_feeds')[0].params.arguments as { filters: unknown }).filters, { publish_time: '半年内' });
    const all = unwrap(await provider.searchNotes('宝马i3')).map((n) => n.platform_post_id);
    assert.deepEqual(all, ['recent-1', 'old-1', '66e1aa']);
  });

  it('sub-comment replying to another sub-comment keeps its real parent (targetComment)', async () => {
    const detail = structuredClone(NOTE_DETAIL);
    const c1 = detail.data.comments.list[0] as Record<string, unknown>;
    (c1.subComments as unknown[]).push({ id: 'c1r2', content: '我也是杭州的', likeCount: '0', createTime: 1789100150000, ipLocation: '浙江', userInfo: { userId: 'u5', nickname: '小葵' }, targetComment: { id: 'c1r', userInfo: { userId: 'u3' } } });
    const { provider } = setup({ [I3]: { handlers: { get_feed_detail: () => ({ text: JSON.stringify(detail) }) } } });
    const flat = unwrap(await provider.getComments({ platform_post_id: '66e1aa', xsec_token: 'tok-1' }, { include_replies: true }, 'xhs-hz-i3'));
    assert.deepEqual(flat.map((c) => [c.platform_comment_id, c.parent_comment_id]), [['c1', null], ['c1r', 'c1'], ['c1r2', 'c1r'], ['c2', null]]);
  });

  it('snake_case DM tools are detected; DM methods mirror capabilities without any prior probe and never call the tool', async () => {
    for (const name of XHS_MCP_TOOLS) assert.equal(DM_TOOL_PATTERN.test(name), false, `real xiaohongshu-mcp tool ${name} is not DM-like`);
    for (const name of ['send_dm', 'dm_list', 'get_inbox', 'list_conversations', 'send_private_message', 'chat', 'reply_私信']) {
      assert.equal(DM_TOOL_PATTERN.test(name), true, name);
    }
    const { provider, net } = setup({ [I3]: { tools: [...XHS_MCP_TOOLS, 'send_dm'] } });
    const send = await provider.sendMessage('xhs-hz-i3', 'u-hz-buyer-001', '你好');
    assert.ok(!send.ok && send.status === 'REQUIRES_REVIEW' && /send_dm/.test(send.reason), JSON.stringify(send));
    const inbox = await provider.listInboundMessages('xhs-hz-i3', null);
    assert.ok(!inbox.ok && inbox.status === 'REQUIRES_REVIEW');
    const report = await provider.capabilities('xhs-hz-i3');
    assert.equal(report.capabilities.send_messages.status, 'REQUIRES_REVIEW');
    assert.equal(net.toolCalls('send_dm').length, 0);
    const unknownAccount = await provider.sendMessage('acc-without-endpoint', 'u', 'hi');
    assert.ok(!unknownAccount.ok && unknownAccount.status === 'UNAVAILABLE');
  });

  it('resolver failures and prototype-named account ids return ProviderResults instead of throwing', async () => {
    const clock = new ManualClock(TEST_NOW);
    const net = network({ [I3]: {}, [RESEARCH]: { handlers: { search_feeds: () => ({ text: JSON.stringify({ feeds: [FEED] }) }) } } });
    const provider = new McpXhsProvider(clock, { research_endpoint: { url: RESEARCH }, account_endpoints: { 'xhs-hz-i3': { url: I3 } } }, {
      fetchImpl: net.fetchImpl,
      resolveAccount: (id) => {
        if (id === 'acc_broken') throw new Error('database is closed');
        return null;
      },
    });
    const pub = await provider.publishNote('acc_broken', DRAFT);
    assert.ok(!pub.ok && pub.status === 'UNAVAILABLE' && /database is closed/.test(pub.reason));
    const report = await provider.capabilities('acc_broken');
    assert.match(report.capabilities.publish_content.reason, /database is closed/);
    assert.equal(unwrap(await provider.searchNotes('宝马i3', {}, 'acc_broken')).length, 1, 'public read falls back to research');
    for (const weird of ['toString', '__proto__', 'constructor']) {
      const res = await provider.publishNote(weird, DRAFT);
      assert.deepEqual(res, { ok: false, status: 'UNAVAILABLE', reason: NO_ENDPOINT_REASON, retryable: false }, weird);
    }
  });

  it('AVAILABLE reasons name the logged-in Xiaohongshu user so operators can spot a wrong session', async () => {
    const { provider } = setup({ [I3]: {} });
    const report = await provider.capabilities('xhs-hz-i3');
    assert.match(report.capabilities.publish_content.reason, /account xhs-hz-i3, logged in as i3电车研究所/);
  });
});
