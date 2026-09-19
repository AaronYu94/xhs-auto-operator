import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ManualClock } from '../../../src/core/clock.ts';
import {
  identityFromMyProfile,
  LOGIN_CACHE_TTL_MS,
  LOGIN_QRCODE_TTL_MS,
  McpXhsProvider,
  NO_ENDPOINT_REASON,
  parseLoginStatusText,
  type McpEndpointConfig,
  type McpProviderConfig,
} from '../../../src/providers/xhs/mcp-provider.ts';
import { createXhsProvider, xhsProviderConfigFromEnv } from '../../../src/providers/xhs/index.ts';
import type { ProviderResult } from '../../../src/providers/xhs/types.ts';
import { TEST_NOW } from '../../helpers/context.ts';

/** Verbatim results of a REAL logged-out xiaohongshu-mcp instance (see _about in the fixture). */
type RawResult = { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
const LOGGED_OUT = JSON.parse(readFileSync(new URL('./fixtures/xhs-mcp-logged-out.json', import.meta.url), 'utf8')) as Record<string, RawResult>;

const TOOLS = [
  'check_login_status', 'get_login_qrcode', 'delete_cookies', 'publish_content', 'list_feeds', 'search_feeds', 'get_feed_detail',
  'user_profile', 'post_comment_to_feed', 'reply_comment_in_feed', 'publish_with_video', 'like_feed', 'favorite_feed',
  'get_my_profile', 'get_unread_count', 'list_notifications', 'reply_notification', 'like_notification',
];

const FEED = {
  xsecToken: 'tok-1', id: '66e1aa', modelType: 'note',
  noteCard: { displayTitle: '宝马i3值得买吗', user: { userId: 'kol-1', nickname: '电车老司机阿杰' }, interactInfo: { likedCount: '12' } },
};
const LOGGED_IN_TEXT = '✅ 已登录\n用户名: i3电车研究所\n\n你可以使用其他功能了。';
const MY_PROFILE = { userBasicInfo: { nickname: 'i3电车研究所', redId: '950001' }, interactions: [], feeds: [{ ...FEED, id: 'own-1', noteCard: { ...FEED.noteCard, user: { userId: 'self-001', nickname: 'i3电车研究所' } } }] };
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

type Handler = (args: Record<string, unknown>) => RawResult;
interface Server {
  loggedIn: boolean;
  down?: boolean;
  handlers: Record<string, Handler>;
}

const text = (t: string, isError = false): RawResult => ({ content: [{ type: 'text', text: t }], isError });

function network(servers: Record<string, Server>) {
  const calls: { url: string; tool: string; args: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const server = servers[url];
    if (!server || server.down) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params: Record<string, unknown> };
    if (body.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (body.method === 'initialize') return reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'xiaohongshu-mcp' }, capabilities: {} });
    if (body.method === 'tools/list') return reply({ tools: TOOLS.map((name) => ({ name })) });
    const tool = String(body.params.name);
    const args = (body.params.arguments ?? {}) as Record<string, unknown>;
    calls.push({ url, tool, args });
    if (server.handlers[tool]) return reply(server.handlers[tool](args));
    if (tool === 'check_login_status') return reply(server.loggedIn ? text(LOGGED_IN_TEXT) : LOGGED_OUT.check_login_status);
    return reply(text(`unexpected tool ${tool}`, true));
  }) as typeof fetch;
  return { fetchImpl, calls, count: (tool: string) => calls.filter((c) => c.tool === tool).length };
}

const RESEARCH = 'http://127.0.0.1:18060/mcp';
const I3 = 'http://127.0.0.1:18061/mcp';
const DB_WANG = 'http://127.0.0.1:18065/mcp';

function setup(servers: Record<string, Server>, opts: { cfg?: Partial<McpProviderConfig>; resolveEndpoint?: (id: string) => McpEndpointConfig | null; resolveAccount?: (id: string) => string | null } = {}) {
  const clock = new ManualClock(TEST_NOW);
  const net = network(servers);
  const provider = new McpXhsProvider(
    clock,
    { research_endpoint: { url: RESEARCH, token: 'r' }, account_endpoints: { 'xhs-hz-i3': { url: I3, token: 'i3' } }, ...opts.cfg },
    { fetchImpl: net.fetchImpl, resolveEndpoint: opts.resolveEndpoint, resolveAccount: opts.resolveAccount },
  );
  return { clock, net, provider };
}

function loggedOutServer(): Server {
  return {
    loggedIn: false,
    handlers: {
      search_feeds: () => LOGGED_OUT.search_feeds,
      get_feed_detail: () => LOGGED_OUT.get_feed_detail,
      user_profile: () => LOGGED_OUT.user_profile,
      get_my_profile: () => LOGGED_OUT.get_my_profile,
    },
  };
}

function expectAuth<T>(res: ProviderResult<T>, label: string): void {
  assert.equal(res.ok, false, `${label}: must not succeed while logged out`);
  if (!res.ok) {
    assert.equal(res.status, 'REQUIRES_AUTH', `${label}: ${res.reason}`);
    assert.equal(res.retryable, false);
    assert.match(res.reason, /not logged in/);
  }
}

describe('logged-out honesty (payloads captured from a real xiaohongshu-mcp)', () => {
  it('the captured logged-out payloads contain no login marker — the provider must not rely on tool text alone', () => {
    for (const tool of ['search_feeds', 'get_feed_detail', 'user_profile', 'get_my_profile']) {
      const t = LOGGED_OUT[tool].content.map((c) => c.text ?? '').join('\n');
      assert.doesNotMatch(t, /未登录|请先登录/, `${tool} payload`);
    }
    assert.equal(LOGGED_OUT.user_profile.isError, undefined, 'user_profile "succeeds" with an empty profile');
    assert.equal(parseLoginStatusText(LOGGED_OUT.check_login_status.content[0].text ?? '').logged_in, false);
  });

  it('every public read returns REQUIRES_AUTH and never calls the read tool while the session is logged out', async () => {
    const { provider, net } = setup({ [RESEARCH]: loggedOutServer() });
    expectAuth(await provider.searchNotes('宝马i3'), 'search');
    expectAuth(await provider.getNote({ platform_post_id: '66e1aa', xsec_token: 'tok' }), 'note');
    expectAuth(await provider.getComments({ platform_post_id: '66e1aa', xsec_token: 'tok' }, { include_replies: true }), 'comments');
    expectAuth(await provider.getUserProfile({ platform_user_id: 'u1', xsec_token: 'tok' }), 'profile');
    assert.equal(net.count('search_feeds') + net.count('get_feed_detail') + net.count('user_profile'), 0, 'no read tool call on a logged-out session');
    assert.equal(net.count('check_login_status'), 1, 'login state cached across reads');
  });

  it('a session that expires inside the cache window is detected from the failing / empty read', async () => {
    const server: Server = { loggedIn: true, handlers: { search_feeds: () => text(JSON.stringify({ feeds: [FEED], count: 1 })) } };
    const { provider, net } = setup({ [RESEARCH]: server });
    const first = await provider.searchNotes('宝马i3');
    assert.ok(first.ok && first.data.length === 1);
    assert.equal(net.count('check_login_status'), 1);

    // session drops: the real server now times out ('context deadline exceeded')
    server.loggedIn = false;
    server.handlers.search_feeds = () => LOGGED_OUT.search_feeds;
    expectAuth(await provider.searchNotes('宝马X3'), 'timeout while logged out');
    assert.equal(net.count('check_login_status'), 2, 'failure triggered a fresh login probe');

    // back to logged in; an empty result on a verified session is a genuine "no results"
    server.loggedIn = true;
    server.handlers.search_feeds = () => text(JSON.stringify({ feeds: [], count: 0 }));
    const { provider: p2, net: n2 } = setup({ [RESEARCH]: server });
    const empty = await p2.searchNotes('冷门关键词');
    assert.ok(empty.ok && empty.data.length === 0, 'verified live just now → empty is honest');
    assert.equal(n2.count('check_login_status'), 1);
    const emptyCached = await p2.searchNotes('冷门关键词2');
    assert.ok(emptyCached.ok && emptyCached.data.length === 0);
    assert.equal(n2.count('check_login_status'), 2, 'empty result from a cached login state is re-verified');

    // empty result after the session silently expired → REQUIRES_AUTH
    server.loggedIn = false;
    expectAuth(await p2.searchNotes('冷门关键词3'), 'empty while logged out');
  });

  it('user_profile with an all-empty profile (real logged-out payload) is never mapped to a profile', async () => {
    const server: Server = { loggedIn: true, handlers: { user_profile: () => LOGGED_OUT.user_profile } };
    const { provider, clock } = setup({ [RESEARCH]: server });
    await provider.capabilities(null); // cache: logged in
    clock.advance({ seconds: 5 });
    const res = await provider.getUserProfile({ platform_user_id: 'u1', xsec_token: 'tok' });
    assert.ok(!res.ok && res.status === 'UNAVAILABLE', 'still logged in → a failed read, not auth');
    server.loggedIn = false;
    clock.advance({ seconds: 5 });
    const { provider: fresh } = setup({ [RESEARCH]: server });
    expectAuth(await fresh.getUserProfile({ platform_user_id: 'u1', xsec_token: 'tok' }), 'empty profile logged out');
  });

  it('login cache lasts ≤ LOGIN_CACHE_TTL_MS and login-required text invalidates it', async () => {
    const server: Server = { loggedIn: true, handlers: { search_feeds: () => text(JSON.stringify({ feeds: [FEED] })) } };
    const { provider, net, clock } = setup({ [RESEARCH]: server });
    await provider.searchNotes('a');
    await provider.searchNotes('b');
    assert.equal(net.count('check_login_status'), 1);
    clock.advance({ ms: LOGIN_CACHE_TTL_MS + 1 });
    await provider.searchNotes('c');
    assert.equal(net.count('check_login_status'), 2, 'expired cache re-probed');

    server.handlers.search_feeds = () => text('未登录，请先扫码登录');
    const auth = await provider.searchNotes('d');
    assert.ok(!auth.ok && auth.status === 'REQUIRES_AUTH');
    expectAuth(await provider.getNote({ platform_post_id: 'x', xsec_token: 't' }), 'after login text');
    assert.equal(net.count('get_feed_detail'), 0, 'cached logged-out state short-circuits the next read');
  });

  it('an unreachable endpoint is UNAVAILABLE (retryable), never REQUIRES_AUTH', async () => {
    const { provider } = setup({ [RESEARCH]: { loggedIn: false, down: true, handlers: {} } });
    const res = await provider.searchNotes('宝马i3');
    assert.ok(!res.ok && res.status === 'UNAVAILABLE' && res.retryable === true, JSON.stringify(res));
  });

  it('engagement reads are gated by login too', async () => {
    const { provider, net } = setup({ [I3]: loggedOutServer() });
    const res = await provider.getEngagement('xhs-hz-i3', 'own-1');
    assert.ok(!res.ok && res.status === 'REQUIRES_AUTH');
    assert.equal(net.count('get_my_profile'), 0);
  });
});

describe('auth API', () => {
  it('status: logged out → logged_in false; logged in → username + user id verified via get_my_profile (cached)', async () => {
    const out = setup({ [I3]: loggedOutServer() });
    const s1 = await out.provider.auth.status('xhs-hz-i3');
    assert.ok(s1.ok);
    if (s1.ok) {
      assert.deepEqual({ ...s1.data, detail: undefined }, { logged_in: false, username: null, platform_user_id: null, red_id: null, detail: undefined, endpoint_label: 'account xhs-hz-i3' });
      assert.match(s1.data.detail, /未登录/);
    }
    assert.equal(out.net.count('get_my_profile'), 1, 'a logged-out report is verified against the profile tool');

    const server: Server = { loggedIn: true, handlers: { get_my_profile: () => text(JSON.stringify(MY_PROFILE)) } };
    const inn = setup({ [I3]: server });
    const s2 = await inn.provider.auth.status('xhs-hz-i3');
    assert.ok(s2.ok && s2.data.logged_in);
    if (s2.ok) {
      assert.equal(s2.data.username, 'i3电车研究所');
      assert.equal(s2.data.platform_user_id, 'self-001');
      assert.equal(s2.data.red_id, '950001');
      assert.match(s2.data.detail, /verified via get_my_profile/);
    }
    await inn.provider.auth.status('xhs-hz-i3');
    assert.equal(inn.net.count('get_my_profile'), 1, 'identity cached for the same nickname');
    assert.equal(inn.net.count('check_login_status'), 2, 'status always probes login live');
    assert.equal(inn.net.calls.find((c) => c.tool === 'get_my_profile')?.url, I3);
  });

  it('status: a stale logged-out selector is overridden only when get_my_profile proves the session', async () => {
    const server: Server = { loggedIn: false, handlers: { get_my_profile: () => text(JSON.stringify(MY_PROFILE)) } };
    const { provider, net } = setup({ [I3]: server });
    const status = await provider.auth.status('xhs-hz-i3');
    assert.ok(status.ok && status.data.logged_in);
    if (status.ok) {
      assert.equal(status.data.platform_user_id, 'self-001');
      assert.equal(status.data.red_id, '950001');
      assert.match(status.data.detail, /verified via get_my_profile/);
    }
    assert.equal(net.count('check_login_status'), 1);
    assert.equal(net.count('get_my_profile'), 1);

    await provider.auth.status('xhs-hz-i3');
    assert.equal(net.count('get_my_profile'), 2, 'a logged-out report is re-verified, never answered from the identity cache');

    const noUserId: Server = { loggedIn: false, handlers: { get_my_profile: () => text(JSON.stringify({ userBasicInfo: { nickname: 'x', redId: '1' }, feeds: [] })) } };
    const unproven = await setup({ [I3]: noUserId }).provider.auth.status('xhs-hz-i3');
    assert.ok(unproven.ok && !unproven.data.logged_in, 'a profile without a user id does not prove the session');
    if (unproven.ok) assert.match(unproven.data.detail, /未登录[\s\S]*no own notes/);
  });

  it('status: identity unverifiable (no own notes / get_my_profile failure) → platform_user_id null with the reason', async () => {
    const noNotes: Server = { loggedIn: true, handlers: { get_my_profile: () => text(JSON.stringify({ userBasicInfo: { nickname: 'x', redId: '1' }, feeds: [] })) } };
    const a = await setup({ [I3]: noNotes }).provider.auth.status('xhs-hz-i3');
    assert.ok(a.ok && a.data.logged_in && a.data.platform_user_id === null && /no own notes/.test(a.data.detail));
    const failing: Server = { loggedIn: true, handlers: { get_my_profile: () => LOGGED_OUT.get_my_profile } };
    const b = await setup({ [I3]: failing }).provider.auth.status('xhs-hz-i3');
    assert.ok(b.ok && b.data.logged_in && b.data.platform_user_id === null && /get_my_profile failed/.test(b.data.detail));
  });

  it('loginQrcode: data URL + expiry, invalidates login cache; already logged in; no fallback to research for an account', async () => {
    const server: Server = {
      loggedIn: false,
      handlers: {
        get_login_qrcode: () => ({ content: [{ type: 'text', text: '请用小红书 App 在 2026-09-12 10:04:00 前扫码登录 👇' }, { type: 'image', mimeType: 'image/png', data: PNG_BASE64 }] }),
        search_feeds: () => text(JSON.stringify({ feeds: [FEED] })),
      },
    };
    const { provider, net, clock } = setup({ [I3]: server, [RESEARCH]: loggedOutServer() });
    expectAuth(await provider.searchNotes('宝马i3', {}, 'xhs-hz-i3'), 'before login');
    const qr = await provider.auth.loginQrcode('xhs-hz-i3');
    assert.ok(qr.ok);
    if (qr.ok) {
      assert.equal(qr.data.already_logged_in, false);
      assert.equal(qr.data.image_data_url, `data:image/png;base64,${PNG_BASE64}`);
      assert.equal(qr.data.expires_at, new Date(clock.now().getTime() + LOGIN_QRCODE_TTL_MS).toISOString());
      assert.match(qr.data.detail, /扫码登录/);
    }
    server.loggedIn = true; // the operator scanned
    const after = await provider.searchNotes('宝马i3', {}, 'xhs-hz-i3');
    assert.ok(after.ok && after.data.length === 1, 'cache invalidated by the QR request → fresh probe sees the login');
    assert.equal(net.calls.find((c) => c.tool === 'get_login_qrcode')?.url, I3);

    server.handlers.get_login_qrcode = () => text('你当前已处于登录状态');
    const already = await provider.auth.loginQrcode('xhs-hz-i3');
    assert.ok(already.ok && already.data.already_logged_in && already.data.image_data_url === null);

    const unknown = await provider.auth.loginQrcode('acc-without-endpoint');
    assert.deepEqual(unknown, { ok: false, status: 'UNAVAILABLE', reason: NO_ENDPOINT_REASON, retryable: false });
    assert.equal(net.calls.filter((c) => c.url === RESEARCH && c.tool === 'get_login_qrcode').length, 0);
    const research = await provider.auth.loginQrcode(null);
    assert.ok(!research.ok, 'research server in this test does not implement get_login_qrcode');
  });
});

describe('DB-configured endpoints', () => {
  it('resolveEndpoint serves accounts without env endpoints; env wins; endpointInfo never exposes tokens', async () => {
    const db: Record<string, McpEndpointConfig> = { acc_wang: { url: DB_WANG, token: 'secret-db' }, acc_i3: { url: 'http://127.0.0.1:19999/mcp' } };
    const { provider, net } = setup(
      { [DB_WANG]: { loggedIn: true, handlers: { publish_content: () => text('内容发布成功') } }, [I3]: { loggedIn: true, handlers: {} } },
      { resolveEndpoint: (id) => db[id] ?? null, resolveAccount: (id) => (id === 'acc_i3' ? 'xhs-hz-i3' : id === 'acc_wang' ? 'xhs-hz-sales-wang' : null) },
    );
    const report = await provider.capabilities('acc_wang');
    assert.equal(report.capabilities.publish_content.status, 'AVAILABLE');
    assert.match(report.capabilities.publish_content.reason, /account xhs-hz-sales-wang \(db\)/);
    const pub = await provider.publishNote('acc_wang', { title: 't', body: 'b', tags: [], images: ['/a.jpg'] });
    assert.ok(pub.ok);
    assert.equal(net.calls.find((c) => c.tool === 'publish_content')?.url, DB_WANG);

    assert.deepEqual(provider.endpointInfo('acc_wang'), { source: 'db', url: DB_WANG });
    assert.deepEqual(provider.endpointInfo('acc_i3'), { source: 'env', url: I3 }, 'env wins over the DB row');
    assert.deepEqual(provider.endpointInfo('acc_none'), { source: 'none', url: null });
    assert.doesNotMatch(JSON.stringify(provider.endpointInfo('acc_wang')), /secret/);
  });

  it('a DB endpoint that points at another account’s instance, an invalid URL or a throwing resolver fails explicitly', async () => {
    const db: Record<string, McpEndpointConfig | 'throw'> = { acc_dup: { url: 'HTTP://127.0.0.1:18061/mcp/' }, acc_bad: { url: 'ftp://x' }, acc_err: 'throw' };
    const { provider } = setup({ [I3]: { loggedIn: true, handlers: {} } }, {
      resolveEndpoint: (id) => {
        const row = db[id];
        if (row === 'throw') throw new Error('database is closed');
        return row ?? null;
      },
    });
    const dup = await provider.publishNote('acc_dup', { title: 't', body: 'b', tags: [], images: ['/a.jpg'] });
    assert.ok(!dup.ok && dup.status === 'UNAVAILABLE' && /already configured for account xhs-hz-i3/.test(dup.reason) && dup.retryable === false, JSON.stringify(dup));
    const bad = await provider.capabilities('acc_bad');
    assert.match(bad.capabilities.publish_content.reason, /invalid xiaohongshu-mcp endpoint url/);
    const err = await provider.auth.status('acc_err');
    assert.ok(!err.ok && /database is closed/.test(err.reason));
    assert.deepEqual(provider.endpointInfo('acc_err'), { source: 'none', url: null });
  });

  it('env config: XHS_PROVIDER=mcp without env endpoints is valid and createXhsProvider wires resolveEndpoint', async () => {
    const cfg = xhsProviderConfigFromEnv({ XHS_PROVIDER: 'mcp', XHS_MCP_TOKEN: 'tkn' });
    assert.ok(cfg.kind === 'mcp');
    const net = network({ [DB_WANG]: { loggedIn: false, handlers: {} } });
    const provider = createXhsProvider(new ManualClock(TEST_NOW), { ...cfg, fetchImpl: net.fetchImpl, resolveEndpoint: (id) => (id === 'acc_wang' ? { url: DB_WANG, token: 'tkn' } : null) });
    const report = await provider.capabilities('acc_wang');
    assert.equal(report.capabilities.search_public_content.status, 'REQUIRES_AUTH');
    assert.equal(provider.endpointInfo?.('acc_wang').source, 'db');
    assert.ok(provider.auth, 'live provider exposes the auth API');
  });

  it('identityFromMyProfile reads redId and the user id of own notes', () => {
    assert.deepEqual(identityFromMyProfile(MY_PROFILE), { nickname: 'i3电车研究所', red_id: '950001', platform_user_id: 'self-001' });
    assert.deepEqual(identityFromMyProfile({ data: { userBasicInfo: { nickname: 'n' }, feeds: [] } }), { nickname: 'n', red_id: null, platform_user_id: null });
  });
});
