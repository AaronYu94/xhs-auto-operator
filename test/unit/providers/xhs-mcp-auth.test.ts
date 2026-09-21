import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ManualClock } from '../../../src/core/clock.ts';
import {
  identityFromMyProfile,
  profileFromMyProfile,
  LOGIN_CACHE_TTL_MS,
  LOGIN_QRCODE_TTL_MS,
  MCP_DM_REASONS,
  McpXhsProvider,
  NO_ENDPOINT_REASON,
  parseLoginStatusText,
  type McpEndpointConfig,
  type McpProviderConfig,
} from '../../../src/providers/xhs/mcp-provider.ts';
import { createXhsProvider, xhsProviderConfigFromEnv } from '../../../src/providers/xhs/index.ts';
import type { ProviderResult } from '../../../src/providers/xhs/types.ts';
import { parseHelperOutput, type VisibleLoginOutcome, type VisibleLoginRequest, type VisibleLoginRunner } from '../../../src/providers/xhs/visible-login.ts';
import { findInstancePort, isLoopbackHost, type LocalInstanceRunner, type LocalInstanceSpec, type PortProbe } from '../../../src/providers/xhs/local-instance.ts';
import { DM_SEND_UNKNOWN_MARK, parseSenderOutput, type DmSendOutcome, type DmSendRequest, type DmSendRunner } from '../../../src/providers/xhs/dm-send.ts';
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

function setup(
  servers: Record<string, Server>,
  opts: {
    cfg?: Partial<McpProviderConfig>;
    resolveEndpoint?: (id: string) => McpEndpointConfig | null;
    resolveAccount?: (id: string) => string | null;
    runVisibleLogin?: VisibleLoginRunner;
    startLocalInstance?: LocalInstanceRunner;
    runDmSend?: DmSendRunner;
    probePort?: PortProbe;
    fetchImpl?: (inner: typeof fetch) => typeof fetch;
  } = {},
) {
  const clock = new ManualClock(TEST_NOW);
  const net = network(servers);
  const provider = new McpXhsProvider(
    clock,
    { research_endpoint: { url: RESEARCH, token: 'r' }, account_endpoints: { 'xhs-hz-i3': { url: I3, token: 'i3' } }, ...opts.cfg },
    {
      fetchImpl: opts.fetchImpl ? opts.fetchImpl(net.fetchImpl) : net.fetchImpl,
      resolveEndpoint: opts.resolveEndpoint,
      resolveAccount: opts.resolveAccount,
      runVisibleLogin: opts.runVisibleLogin,
      startLocalInstance: opts.startLocalInstance,
      probePort: opts.probePort,
      runDmSend: opts.runDmSend,
    },
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

  it('reads that return content keep a verified session alive; empty reads still re-probe', async () => {
    const note = { noteId: 'n1', xsecToken: 'tok', title: '想买车', desc: '求推荐', user: { userId: 'u1', nickname: '路人' }, interactInfo: {} };
    const server: Server = {
      loggedIn: true,
      handlers: {
        search_feeds: () => text(JSON.stringify({ feeds: [FEED] })),
        get_feed_detail: () => text(JSON.stringify({ data: { note, comments: { list: [] } } })),
      },
    };
    const { provider, net, clock } = setup({ [RESEARCH]: server });
    for (const q of ['a', 'b', 'c']) {
      assert.ok((await provider.searchNotes(q)).ok);
      clock.advance({ ms: LOGIN_CACHE_TTL_MS * 0.7 });
    }
    assert.equal(net.count('check_login_status'), 1, 'successful reads renewed the logged-in state (2.1 × TTL, one probe)');
    const both = await provider.getNoteWithComments({ platform_post_id: 'n1', xsec_token: 'tok' }, { limit: 20 });
    assert.ok(both.ok && both.data.comments.length === 0);
    assert.equal(net.count('check_login_status'), 1, 'a note with no comments is a real empty section, not a login problem');

    server.handlers.search_feeds = () => text(JSON.stringify({ feeds: [] }));
    clock.advance({ seconds: 1 });
    await provider.searchNotes('d');
    assert.equal(net.count('check_login_status'), 2, 'an empty read is re-verified and renews nothing');
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
      assert.deepEqual({ ...s1.data, detail: undefined }, { logged_in: false, username: null, platform_user_id: null, red_id: null, profile: null, detail: undefined, endpoint_label: 'account xhs-hz-i3' });
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
      assert.equal(s2.data.profile?.nickname, 'i3电车研究所');
      assert.equal(s2.data.profile?.notes[0]?.platform_note_id, 'own-1');
    }
    const cachedStatus = await inn.provider.auth.status('xhs-hz-i3');
    assert.ok(cachedStatus.ok && cachedStatus.data.profile?.red_id === '950001', 'the cached identity carries the profile too');
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

  it('profileFromMyProfile reads avatar, bio, counts and own notes; empty web counts stay unknown (null), never 0', () => {
    // Shape of a real get_my_profile payload (values synthetic).
    const payload = {
      userBasicInfo: { gender: 0, ipLocation: '', desc: '分享选车用车', imageb: 'https://sns-avatar-qc.xhscdn.com/avatar/abc', images: 'https://sns-avatar-qc.xhscdn.com/avatar/abc-small', nickname: '测试车主', redId: '123456' },
      interactions: [
        { type: 'follows', name: '关注', count: '78' },
        { type: 'fans', name: '粉丝', count: '1.2万' },
        { type: 'interaction', name: '获赞与收藏', count: '34' },
      ],
      feeds: [
        {
          xsecToken: 'tok=1', id: 'note-1', modelType: '',
          noteCard: { displayTitle: '提车记', user: { userId: 'u-self' }, interactInfo: { likedCount: '27', collectedCount: '', commentCount: '' }, cover: { url: '', urlPre: 'http://sns-webpic-qc.xhscdn.com/pre', urlDefault: 'http://sns-webpic-qc.xhscdn.com/default' } },
        },
      ],
    };
    assert.deepEqual(profileFromMyProfile(payload), {
      nickname: '测试车主',
      red_id: '123456',
      avatar_url: 'https://sns-avatar-qc.xhscdn.com/avatar/abc',
      bio: '分享选车用车',
      ip_location: null,
      follows: 78,
      fans: 12000,
      liked_and_collected: 34,
      notes: [
        {
          platform_note_id: 'note-1',
          title: '提车记',
          // the token is kept as its own field: reading a note's body needs it (账号语言学习 reads its own history)
          xsec_token: 'tok=1',
          url: 'https://www.xiaohongshu.com/explore/note-1?xsec_token=tok%3D1',
          cover_url: 'http://sns-webpic-qc.xhscdn.com/default',
          liked_count: 27,
          collected_count: null,
          comment_count: null,
        },
      ],
    });
    assert.deepEqual(profileFromMyProfile({ userBasicInfo: {}, feeds: [] }), {
      nickname: null, red_id: null, avatar_url: null, bio: null, ip_location: null, follows: null, fans: null, liked_and_collected: null, notes: [],
    });
  });

  it('identityFromMyProfile reads redId and the user id of own notes', () => {
    assert.deepEqual(identityFromMyProfile(MY_PROFILE), { nickname: 'i3电车研究所', red_id: '950001', platform_user_id: 'self-001' });
    assert.deepEqual(identityFromMyProfile({ data: { userBasicInfo: { nickname: 'n' }, feeds: [] } }), { nickname: 'n', red_id: null, platform_user_id: null });
  });
});

const qrServer = (): Server => ({
  loggedIn: false,
  handlers: {
    get_login_qrcode: () => ({ content: [{ type: 'text', text: '请用小红书 App 扫码登录 👇' }, { type: 'image', mimeType: 'image/png', data: PNG_BASE64 }] }),
    get_my_profile: () => LOGGED_OUT.get_my_profile,
  },
});

/** Wraps the fake network: every tools/call takes a few ms and the peak overlap per instance URL is recorded. */
function overlapTracker() {
  const inFlight = new Map<string, number>();
  const peak = new Map<string, number>();
  let globalInFlight = 0;
  let globalPeak = 0;
  const wrap = (inner: typeof fetch) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const isCall = String(init?.body ?? '').includes('"tools/call"');
      if (!isCall) return inner(input, init);
      const url = String(input);
      inFlight.set(url, (inFlight.get(url) ?? 0) + 1);
      peak.set(url, Math.max(peak.get(url) ?? 0, inFlight.get(url)!));
      globalPeak = Math.max(globalPeak, ++globalInFlight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        return await inner(input, init);
      } finally {
        inFlight.set(url, inFlight.get(url)! - 1);
        globalInFlight--;
      }
    }) as typeof fetch;
  return { wrap, peak, globalPeak: () => globalPeak };
}

describe('one call at a time per instance', () => {
  it('tool calls on one instance never overlap (a failing call does not block the queue); different instances run in parallel', async () => {
    const tracker = overlapTracker();
    const research: Server = { loggedIn: true, handlers: {} };
    const i3: Server = { loggedIn: true, handlers: { get_my_profile: () => text('boom', true) } };
    const { provider, net } = setup({ [RESEARCH]: research, [I3]: i3 }, { fetchImpl: tracker.wrap });
    const results = await Promise.all([
      provider.capabilities('xhs-hz-i3'),
      provider.capabilities('xhs-hz-i3'),
      provider.auth.status('xhs-hz-i3'), // get_my_profile fails on this instance
      provider.capabilities('xhs-hz-i3'),
      provider.capabilities(null),
      provider.capabilities(null),
    ]);
    assert.equal(results.length, 6);
    assert.equal(tracker.peak.get(I3), 1, 'never two browser calls at once on the account instance');
    assert.equal(tracker.peak.get(RESEARCH), 1, 'never two browser calls at once on the research instance');
    assert.equal(tracker.globalPeak(), 2, 'the two instances are independent');
    assert.ok(net.count('check_login_status') >= 5 && net.count('get_my_profile') === 1, 'every queued call still ran after the failure');
  });

  it('concurrent login-status requests for one instance share a single live probe', async () => {
    const server: Server = { loggedIn: true, handlers: { get_my_profile: () => text(JSON.stringify(MY_PROFILE)) } };
    const { provider, net } = setup({ [I3]: server });
    const all = await Promise.all([provider.auth.status('xhs-hz-i3'), provider.auth.status('xhs-hz-i3'), provider.auth.status('xhs-hz-i3')]);
    assert.ok(all.every((r) => r.ok && r.data.logged_in && r.data.platform_user_id === 'self-001'));
    assert.equal(net.count('check_login_status'), 1);
    assert.equal(net.count('get_my_profile'), 1);
    await provider.auth.status('xhs-hz-i3');
    assert.equal(net.count('check_login_status'), 2, 'a later request probes again (login checks are never reused)');
  });
});

describe('pending login', () => {
  it('while a QR login is pending, a logged-out status skips get_my_profile; afterwards the stale-selector check resumes', async () => {
    const { provider, net, clock } = setup({ [I3]: qrServer() });
    const qr = await provider.auth.loginQrcode('xhs-hz-i3');
    assert.ok(qr.ok && !qr.data.already_logged_in);
    for (let i = 0; i < 3; i++) {
      const s = await provider.auth.status('xhs-hz-i3');
      assert.ok(s.ok && !s.data.logged_in);
      if (s.ok) assert.match(s.data.detail, /login pending; identity check skipped/);
    }
    assert.equal(net.count('get_my_profile'), 0, 'no 60 s profile call while the operator is scanning');
    assert.equal(net.count('check_login_status'), 3, 'the login itself is still probed live every time');
    clock.advance({ ms: LOGIN_QRCODE_TTL_MS + 1 });
    const after = await provider.auth.status('xhs-hz-i3');
    assert.ok(after.ok && !after.data.logged_in);
    assert.equal(net.count('get_my_profile'), 1, 'QR expired: a logged-out report is verified against the profile again');
  });

  it('a login seen by the probe ends the pending state', async () => {
    const server: Server = { ...qrServer(), handlers: { ...qrServer().handlers, get_my_profile: () => text(JSON.stringify(MY_PROFILE)) } };
    const { provider, net } = setup({ [I3]: server });
    await provider.auth.loginQrcode('xhs-hz-i3');
    server.loggedIn = true;
    const s = await provider.auth.status('xhs-hz-i3');
    assert.ok(s.ok && s.data.logged_in && s.data.platform_user_id === 'self-001');
    server.loggedIn = false; // logged out again later: back to the normal stale-selector verification
    await provider.auth.status('xhs-hz-i3');
    assert.equal(net.count('get_my_profile'), 2);
  });
});

describe('login window (visible browser)', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'xhs-login-'));
    const helper = join(dir, 'xhs-visible-login');
    writeFileSync(helper, '#!/bin/sh\nexit 0\n');
    chmodSync(helper, 0o755);
    const dataDir = join(dir, 'fleet');
    mkdirSync(join(dataDir, 'research'), { recursive: true });
    mkdirSync(join(dataDir, 'xhs-hz-i3'), { recursive: true });
    const requests: VisibleLoginRequest[] = [];
    let finish: (o: VisibleLoginOutcome) => void = () => {};
    const runner: VisibleLoginRunner = (req) => {
      requests.push(req);
      return new Promise((resolve) => (finish = resolve));
    };
    return { dir, helper, dataDir, requests, runner, finish: (o: VisibleLoginOutcome) => finish(o) };
  }
  const settle = () => new Promise((r) => setImmediate(r));

  it('is absent unless configured', () => {
    const { provider } = setup({ [RESEARCH]: loggedOutServer() });
    assert.equal(provider.auth.visibleLogin, undefined);
  });

  it('opens one window per instance, writes that instance’s cookies file, and reports the outcome', async () => {
    const f = fixture();
    const server = loggedOutServer();
    const { provider, net, clock } = setup(
      { [RESEARCH]: server, [I3]: loggedOutServer() },
      { cfg: { visible_login: { helper_path: f.helper, data_dir: f.dataDir, timeout_ms: 120_000 } }, runVisibleLogin: f.runner },
    );
    const api = provider.auth.visibleLogin;
    assert.ok(api);
    assert.equal(api.status(null), null);
    const job = await api.start(null);
    assert.ok(job.ok);
    if (job.ok) {
      assert.equal(job.data.state, 'running');
      assert.equal(job.data.instance, 'research');
      assert.equal(job.data.expires_at, new Date(clock.now().getTime() + 120_000).toISOString());
    }
    assert.deepEqual(f.requests, [{ helperPath: f.helper, cookiesPath: join(f.dataDir, 'research', 'cookies.json'), timeoutMs: 120_000 }]);
    const again = await api.start(null);
    assert.ok(again.ok && again.data.state === 'running');
    assert.equal(f.requests.length, 1, 'a running window is not opened twice');

    const pending = await provider.auth.status(null);
    assert.ok(pending.ok && !pending.data.logged_in);
    assert.equal(net.count('get_my_profile'), 0, 'no profile probing while the window waits for the scan');

    server.loggedIn = true; // the helper wrote the instance's cookies
    f.finish({ ok: true, detail: 'LOGIN_OK: logged in; 30 cookies saved' });
    await settle();
    const done = api.status(null);
    assert.equal(done?.state, 'succeeded');
    assert.equal(done?.detail, 'LOGIN_OK: logged in; 30 cookies saved');
    assert.ok(done?.finished_at);
    const search = await provider.searchNotes('宝马i3');
    assert.ok(search.ok || search.status !== 'REQUIRES_AUTH', 'login caches were dropped: the new session is probed, not the cached logout');

    const acct = await api.start('xhs-hz-i3');
    assert.ok(acct.ok && acct.data.instance === 'xhs-hz-i3');
    assert.equal(f.requests[1]?.cookiesPath, join(f.dataDir, 'xhs-hz-i3', 'cookies.json'));
    f.finish({ ok: false, detail: 'LOGIN_TIMEOUT: no confirmed login within 5m0s' });
    await settle();
    assert.equal(api.status('xhs-hz-i3')?.state, 'failed');
    assert.match(api.status('xhs-hz-i3')?.detail ?? '', /LOGIN_TIMEOUT/);
  });

  it('refuses remote instances, missing helpers / state dirs and accounts without an instance — with the fix in the reason', async () => {
    const f = fixture();
    const remote = 'http://10.0.0.5:18062/mcp';
    const { provider } = setup(
      { [RESEARCH]: loggedOutServer(), [remote]: loggedOutServer() },
      {
        cfg: { account_endpoints: { 'xhs-hz-i3': { url: I3 }, 'xhs-remote': { url: remote } }, visible_login: { helper_path: f.helper, data_dir: f.dataDir } },
        runVisibleLogin: f.runner,
      },
    );
    const api = provider.auth.visibleLogin!;
    const r1 = await api.start('xhs-remote');
    assert.ok(!r1.ok && r1.status === 'UNAVAILABLE');
    if (!r1.ok) assert.match(r1.reason, /not on this host.*xhs-mcp-fleet\.sh login xhs-remote/);
    const r2 = await api.start('acc-without-endpoint');
    assert.deepEqual(r2, { ok: false, status: 'UNAVAILABLE', reason: NO_ENDPOINT_REASON, retryable: false });

    const noDir = setup({ [RESEARCH]: loggedOutServer() }, { cfg: { visible_login: { helper_path: f.helper, data_dir: join(f.dir, 'nope') } }, runVisibleLogin: f.runner });
    const r3 = await noDir.provider.auth.visibleLogin!.start(null);
    assert.ok(!r3.ok && /no state directory .*nope.research/.test(r3.reason));
    const noHelper = setup({ [RESEARCH]: loggedOutServer() }, { cfg: { visible_login: { helper_path: join(f.dir, 'missing'), data_dir: f.dataDir } }, runVisibleLogin: f.runner });
    const r4 = await noHelper.provider.auth.visibleLogin!.start(null);
    assert.ok(!r4.ok && /build-login-helper/.test(r4.reason));
    assert.equal(f.requests.length, 0, 'nothing was launched');
  });

  it('without a research instance, the research login targets the instance public reads fall back to', async () => {
    const f = fixture();
    const { provider } = setup({ [I3]: loggedOutServer() }, { cfg: { research_endpoint: undefined, visible_login: { helper_path: f.helper, data_dir: f.dataDir } }, runVisibleLogin: f.runner });
    const job = await provider.auth.visibleLogin!.start(null);
    assert.ok(job.ok && job.data.instance === 'xhs-hz-i3');
    assert.equal(f.requests[0]?.cookiesPath, join(f.dataDir, 'xhs-hz-i3', 'cookies.json'), 'the cookies the fallback instance actually reads');
  });

  it('parses the helper verdict from its log output', () => {
    assert.deepEqual(parseHelperOutput('time="x" level=info msg="login window open"\ntime="y" level=info msg="LOGIN_OK: logged in; 31 cookies saved to /d/cookies.json"\n', 0), {
      ok: true,
      detail: 'LOGIN_OK: logged in; 31 cookies saved to /d/cookies.json',
    });
    assert.equal(parseHelperOutput('time="y" level=error msg="LOGIN_TIMEOUT: no confirmed login within 5m0s"', 2).ok, false);
    const crashed = parseHelperOutput('panic: {-32001 Session with given id not found. }\n', 2);
    assert.equal(crashed.ok, false);
    assert.match(crashed.detail, /exited \(code 2\) without a result: panic/);
  });

  it('env: XHS_LOGIN_HELPER and XHS_MCP_DATA_DIR go together and become absolute paths', () => {
    const base = { XHS_PROVIDER: 'mcp', XHS_MCP_RESEARCH_URL: RESEARCH };
    assert.throws(() => xhsProviderConfigFromEnv({ ...base, XHS_LOGIN_HELPER: '/opt/xhs/xhs-visible-login' }), /XHS_MCP_DATA_DIR/);
    assert.throws(() => xhsProviderConfigFromEnv({ ...base, XHS_MCP_DATA_DIR: './data/xhs-mcp' }), /XHS_LOGIN_HELPER/);
    const cfg = xhsProviderConfigFromEnv({ ...base, XHS_LOGIN_HELPER: '/opt/xhs/xhs-visible-login', XHS_MCP_DATA_DIR: './data/xhs-mcp' });
    assert.ok(cfg.kind === 'mcp');
    if (cfg.kind === 'mcp') {
      assert.equal(cfg.mcp.visible_login?.helper_path, '/opt/xhs/xhs-visible-login');
      assert.equal(cfg.mcp.visible_login?.data_dir, join(process.cwd(), 'data/xhs-mcp'));
    }
    const plain = xhsProviderConfigFromEnv(base);
    assert.ok(plain.kind === 'mcp' && plain.mcp.visible_login === undefined);
  });
});

describe('local instances (starting an account’s own instance from the console)', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'xhs-instances-'));
    const binary = join(dir, 'xiaohongshu-mcp');
    writeFileSync(binary, '#!/bin/sh\nexit 0\n');
    chmodSync(binary, 0o755);
    const dataDir = join(dir, 'fleet');
    mkdirSync(dataDir, { recursive: true });
    const specs: LocalInstanceSpec[] = [];
    const runner: LocalInstanceRunner = (spec) => {
      specs.push(spec);
      return Promise.resolve({ ok: true, pid: 4242, detail: `实例已在 ${spec.bind}:${spec.port} 启动` });
    };
    const local = { binary_path: binary, data_dir: dataDir, bind: '127.0.0.1', base_port: 18060, token: 'fleet-token' };
    return { dir, binary, dataDir, specs, runner, local };
  }
  /** every port free except the ones already listening in this deployment */
  const freeExcept = (busy: number[]): PortProbe => (_bind, port) => Promise.resolve(!busy.includes(port));

  it('is absent unless this host was configured to run instances', () => {
    const { provider } = setup({ [RESEARCH]: loggedOutServer() });
    assert.equal(provider.auth.localInstance, undefined);
  });

  it('starts the account’s own instance on the first free port, with its own cookies dir and the fleet token', async () => {
    const f = fixture();
    const { provider } = setup(
      { [RESEARCH]: loggedOutServer() },
      { cfg: { account_endpoints: {}, local_instances: f.local }, startLocalInstance: f.runner, probePort: freeExcept([18060, 18061]) },
    );
    const api = provider.auth.localInstance;
    assert.ok(api);
    const res = await api.start('xhs-new-sales');
    assert.ok(res.ok);
    if (res.ok) {
      assert.equal(res.data.url, 'http://127.0.0.1:18062/mcp', 'the research port and a busy one are skipped');
      assert.equal(res.data.port, 18062);
      assert.equal(res.data.instance, 'xhs-new-sales');
      assert.equal(res.data.started, true);
      assert.equal(res.data.pid, 4242);
    }
    assert.deepEqual(f.specs, [
      { binaryPath: f.binary, instanceDir: join(f.dataDir, 'xhs-new-sales'), bind: '127.0.0.1', port: 18062, token: 'fleet-token' },
    ]);
  });

  it('never lands on a port another account is bound to, and never starts two processes for one account', async () => {
    const f = fixture();
    const { provider } = setup(
      { [RESEARCH]: loggedOutServer() },
      { cfg: { account_endpoints: { 'xhs-hz-i3': { url: I3 } }, local_instances: f.local }, startLocalInstance: f.runner, probePort: freeExcept([18060]) },
    );
    const api = provider.auth.localInstance!;
    // 18061 is the env account's instance, 18062 belongs to an account bound in the database
    const res = await api.start('xhs-new-sales', { reserved_ports: [18062] });
    assert.ok(res.ok && res.data.port === 18063);

    const [a, b] = await Promise.all([api.start('xhs-second'), api.start('xhs-second')]);
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.equal(a.data.port, b.data.port, 'a double click waits for the first start instead of starting a second process');
    assert.equal(f.specs.filter((s) => s.instanceDir.endsWith('xhs-second')).length, 1);
  });

  it('reuses an instance that is already running for this account instead of starting a second one', async () => {
    const f = fixture();
    const dir = join(f.dataDir, 'xhs-running');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid'), `${process.pid}\n`);
    writeFileSync(join(dir, 'port'), '18064\n');
    const { provider } = setup(
      { [RESEARCH]: loggedOutServer() },
      {
        cfg: { account_endpoints: {}, local_instances: f.local },
        startLocalInstance: f.runner,
        probePort: freeExcept([]),
        fetchImpl: (inner) =>
          (async (input: string | URL | Request, init?: RequestInit) =>
            String(input) === 'http://127.0.0.1:18064/health' ? new Response('{"status":"healthy"}', { status: 200 }) : inner(input, init)) as typeof fetch,
      },
    );
    const res = await provider.auth.localInstance!.start('xhs-running');
    assert.ok(res.ok);
    if (res.ok) {
      assert.equal(res.data.started, false, 'the running instance is reused');
      assert.equal(res.data.url, 'http://127.0.0.1:18064/mcp');
      assert.equal(res.data.pid, process.pid);
    }
    assert.equal(f.specs.length, 0, 'nothing was launched');
  });

  it('refuses to start a second process when this account’s instance process is alive but silent', async () => {
    const f = fixture();
    const dir = join(f.dataDir, 'xhs-stuck');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid'), `${process.pid}\n`);
    writeFileSync(join(dir, 'port'), '18065\n');
    const { provider } = setup(
      { [RESEARCH]: loggedOutServer() },
      { cfg: { account_endpoints: {}, local_instances: f.local }, startLocalInstance: f.runner, probePort: freeExcept([]) },
    );
    const res = await provider.auth.localInstance!.start('xhs-stuck');
    assert.ok(!res.ok && res.status === 'UNAVAILABLE');
    if (!res.ok) assert.match(res.reason, /still running \(pid \d+, port 18065 not answering/);
    assert.equal(f.specs.length, 0, 'the running session is never given a second process');
  });

  it('reuses a fleet-script instance through the port the account is already bound to', async () => {
    const f = fixture();
    const dir = join(f.dataDir, 'xhs-fleet');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid'), `${process.pid}\n`); // an older fleet script wrote no port file
    const { provider } = setup(
      { [RESEARCH]: loggedOutServer() },
      {
        cfg: { account_endpoints: {}, local_instances: f.local },
        startLocalInstance: f.runner,
        probePort: freeExcept([]),
        fetchImpl: (inner) =>
          (async (input: string | URL | Request, init?: RequestInit) =>
            String(input) === 'http://127.0.0.1:18066/health' ? new Response('ok', { status: 200 }) : inner(input, init)) as typeof fetch,
      },
    );
    const res = await provider.auth.localInstance!.start('xhs-fleet', { known_port: 18066 });
    assert.ok(res.ok && res.data.started === false && res.data.port === 18066);
    assert.equal(f.specs.length, 0);
  });

  it('refuses env-pinned accounts, a missing binary and instances that would not be on this host', async () => {
    const f = fixture();
    const pinned = setup(
      { [RESEARCH]: loggedOutServer() },
      { cfg: { account_endpoints: { 'xhs-hz-i3': { url: I3 } }, local_instances: f.local }, startLocalInstance: f.runner, probePort: freeExcept([]) },
    );
    const r1 = await pinned.provider.auth.localInstance!.start('xhs-hz-i3');
    assert.ok(!r1.ok && r1.status === 'UNAVAILABLE');
    if (!r1.ok) assert.match(r1.reason, /XHS_MCP_ACCOUNTS/);

    const remote = setup(
      { [RESEARCH]: loggedOutServer() },
      { cfg: { account_endpoints: {}, local_instances: { ...f.local, bind: '0.0.0.0' } }, startLocalInstance: f.runner, probePort: freeExcept([]) },
    );
    const r2 = await remote.provider.auth.localInstance!.start('xhs-new');
    assert.ok(!r2.ok && /not this host/.test(r2.reason));

    const noBinary = setup(
      { [RESEARCH]: loggedOutServer() },
      { cfg: { account_endpoints: {}, local_instances: { ...f.local, binary_path: join(f.dir, 'missing') } }, startLocalInstance: f.runner, probePort: freeExcept([]) },
    );
    const r3 = await noBinary.provider.auth.localInstance!.start('xhs-new');
    assert.ok(!r3.ok && /XHS_MCP_BIN/.test(r3.reason));
    assert.equal(f.specs.length, 0, 'nothing was launched');
  });

  it('port picking prefers the instance’s own last port and gives up instead of wrapping into foreign ports', async () => {
    assert.equal(await findInstancePort('127.0.0.1', 18060, new Set(), 18067, freeExcept([])), 18067);
    assert.equal(await findInstancePort('127.0.0.1', 18060, new Set([18067]), 18067, freeExcept([])), 18061, 'a port another account holds is not reused');
    assert.equal(await findInstancePort('127.0.0.1', 18060, new Set(), 18067, freeExcept([18067])), 18061, 'busy again: the next free port');
    assert.equal(await findInstancePort('127.0.0.1', 18060, new Set(), null, () => Promise.resolve(false)), null);
    assert.equal(isLoopbackHost('127.0.0.1'), true);
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('10.0.0.5'), false);
  });

  it('env: XHS_MCP_BIN needs a state dir and a token, and pairs with the login window', () => {
    const base = { XHS_PROVIDER: 'mcp', XHS_MCP_RESEARCH_URL: RESEARCH, XHS_MCP_TOKEN: 'tok' };
    assert.throws(() => xhsProviderConfigFromEnv({ ...base, XHS_MCP_BIN: '/opt/xhs/xiaohongshu-mcp' }), /XHS_MCP_DATA_DIR/);
    assert.throws(
      () => xhsProviderConfigFromEnv({ XHS_PROVIDER: 'mcp', XHS_MCP_BIN: '/opt/xhs/xiaohongshu-mcp', XHS_MCP_DATA_DIR: './data/xhs-mcp' }),
      /XHS_MCP_TOKEN/,
    );
    const cfg = xhsProviderConfigFromEnv({ ...base, XHS_MCP_BIN: '/opt/xhs/xiaohongshu-mcp', XHS_MCP_DATA_DIR: './data/xhs-mcp', XHS_MCP_BASE_PORT: '18070' });
    assert.ok(cfg.kind === 'mcp');
    if (cfg.kind === 'mcp') {
      assert.deepEqual(cfg.mcp.local_instances, {
        binary_path: '/opt/xhs/xiaohongshu-mcp',
        data_dir: join(process.cwd(), 'data/xhs-mcp'),
        bind: '127.0.0.1',
        base_port: 18070,
        token: 'tok',
      });
      assert.equal(cfg.mcp.visible_login, undefined, 'the state dir alone does not claim a login window');
    }
    assert.equal((xhsProviderConfigFromEnv(base) as { mcp: { local_instances?: unknown } }).mcp.local_instances, undefined);
  });
});

describe('sending a DM from the account’s own session (opt-in)', () => {
  function fixture(outcome: DmSendOutcome = { state: 'sent', message_id: 'bubble-9', peer_avatar_url: 'https://sns-avatar-qc.xhscdn.com/avatar/abc', detail: '已在会话中确认' }) {
    const dir = mkdtempSync(join(tmpdir(), 'xhs-dm-'));
    const helper = join(dir, 'xhs-dm-send');
    writeFileSync(helper, '#!/bin/sh\nexit 0\n');
    chmodSync(helper, 0o755);
    const dataDir = join(dir, 'fleet');
    mkdirSync(join(dataDir, 'xhs-hz-i3'), { recursive: true });
    writeFileSync(join(dataDir, 'xhs-hz-i3', 'cookies.json'), '[]');
    const requests: DmSendRequest[] = [];
    const runner: DmSendRunner = (req) => {
      requests.push(req);
      return Promise.resolve(outcome);
    };
    return { dir, helper, dataDir, requests, runner, cfg: { helper_path: helper, data_dir: dataDir } };
  }
  const capabilityOf = async (provider: McpXhsProvider, accountId: string) => (await provider.capabilities(accountId)).capabilities.send_messages;

  it('stays unavailable — with the documented reason — until a deployment opts in', async () => {
    const { provider } = setup({ [RESEARCH]: loggedOutServer(), [I3]: loggedOutServer() });
    const res = await provider.sendMessage('xhs-hz-i3', 'buyer-1', '您好');
    assert.deepEqual(res, { ok: false, status: 'UNAVAILABLE', reason: MCP_DM_REASONS.send_messages, retryable: false });
    const cap = await capabilityOf(provider, 'xhs-hz-i3');
    assert.equal(cap?.status, 'UNAVAILABLE');
    assert.equal(cap?.reason, MCP_DM_REASONS.send_messages);
  });

  it('sends through the account’s own cookies and only reports SENT with the id read back in the conversation', async () => {
    const f = fixture();
    const { provider } = setup({ [RESEARCH]: loggedOutServer(), [I3]: loggedOutServer() }, { cfg: { dm_sender: f.cfg }, runDmSend: f.runner });
    const cap = await capabilityOf(provider, 'xhs-hz-i3');
    assert.equal(cap?.status, 'AVAILABLE');
    assert.match(cap?.reason ?? '', /自己的登录会话/);

    const res = await provider.sendMessage('xhs-hz-i3', 'buyer-1', '  您好，看到您在看宝马i3  ');
    assert.ok(res.ok);
    if (res.ok) assert.equal(res.data.provider_message_id, 'xhs-dm:bubble-9');
    assert.deepEqual(f.requests.map((r) => ({ cookies: r.cookiesPath, profile: r.profileUrl, text: r.text })), [
      {
        cookies: join(f.dataDir, 'xhs-hz-i3', 'cookies.json'),
        profile: 'https://www.xiaohongshu.com/user/profile/buyer-1',
        text: '您好，看到您在看宝马i3',
      },
    ]);
  });

  it('an unknown outcome is REQUIRES_REVIEW and never retryable; a pre-send failure may be retried', async () => {
    const unknown = fixture({ state: 'unknown', message_id: null, peer_avatar_url: null, detail: '提交后未能在会话中读回' });
    const a = setup({ [RESEARCH]: loggedOutServer(), [I3]: loggedOutServer() }, { cfg: { dm_sender: unknown.cfg }, runDmSend: unknown.runner });
    const r1 = await a.provider.sendMessage('xhs-hz-i3', 'buyer-1', '您好');
    assert.ok(!r1.ok && r1.status === 'REQUIRES_REVIEW' && r1.retryable === false);
    if (!r1.ok) assert.match(r1.reason, new RegExp(DM_SEND_UNKNOWN_MARK));

    const failed = fixture({ state: 'failed', message_id: null, peer_avatar_url: null, detail: '主页上没有私信入口' });
    const b = setup({ [RESEARCH]: loggedOutServer(), [I3]: loggedOutServer() }, { cfg: { dm_sender: failed.cfg }, runDmSend: failed.runner });
    const r2 = await b.provider.sendMessage('xhs-hz-i3', 'buyer-1', '您好');
    assert.ok(!r2.ok && r2.status === 'UNAVAILABLE' && r2.retryable === true, 'nothing was sent: this one may be tried again');
  });

  it('refuses a remote instance, a missing session file and an unknown DM tool on the instance', async () => {
    const f = fixture();
    const remoteUrl = 'http://10.0.0.9:18061/mcp';
    const remote = setup(
      { [RESEARCH]: loggedOutServer(), [remoteUrl]: loggedOutServer() },
      { cfg: { account_endpoints: { 'xhs-hz-i3': { url: remoteUrl } }, dm_sender: f.cfg }, runDmSend: f.runner },
    );
    const r1 = await remote.provider.sendMessage('xhs-hz-i3', 'buyer-1', '您好');
    assert.ok(!r1.ok && /其他机器/.test(r1.reason));
    assert.equal((await capabilityOf(remote.provider, 'xhs-hz-i3'))?.status, 'UNAVAILABLE');

    const noSession = setup(
      { [RESEARCH]: loggedOutServer(), [I3]: loggedOutServer() },
      { cfg: { dm_sender: { ...f.cfg, data_dir: join(f.dir, 'empty') } }, runDmSend: f.runner },
    );
    const r2 = await noSession.provider.sendMessage('xhs-hz-i3', 'buyer-1', '您好');
    assert.ok(!r2.ok && r2.status === 'REQUIRES_AUTH');
    assert.equal(f.requests.length, 0, 'nothing was sent');
  });

  it('parses the helper verdict, treating anything unrecognised as unknown', () => {
    assert.deepEqual(parseSenderOutput('chat_button="div.chat"\nSEND_OK: msg-7\n', 0), { state: 'sent', message_id: 'msg-7', peer_avatar_url: null, detail: 'msg-7' });
    const withFace = parseSenderOutput('peer_avatar=https://sns-avatar-qc.xhscdn.com/avatar/xyz?x=1\nSEND_OK: msg-8\n', 0);
    assert.equal(withFace.peer_avatar_url, 'https://sns-avatar-qc.xhscdn.com/avatar/xyz?x=1', 'the recipient’s avatar comes back with the send');
    assert.equal(parseSenderOutput('peer_avatar=https://evil.example.com/a.png\nSEND_OK: msg-9\n', 0).peer_avatar_url, null, 'only Xiaohongshu’s own CDN is accepted');
    assert.equal(parseSenderOutput('DRYRUN_OK: conversation reachable', 0).state, 'dry_run');
    assert.equal(parseSenderOutput('SEND_FAILED: no 私信 control on the profile', 1).state, 'failed');
    assert.equal(parseSenderOutput('SEND_UNKNOWN: crashed while sending', 3).state, 'unknown');
    const silent = parseSenderOutput('panic: browser closed\n', 2);
    assert.equal(silent.state, 'unknown', 'a crash after typing is never reported as a failure');
    assert.match(silent.detail, /code 2/);
  });

  it('env: XHS_DM_SENDER needs the state dir and is absent by default', () => {
    const base = { XHS_PROVIDER: 'mcp', XHS_MCP_RESEARCH_URL: RESEARCH, XHS_MCP_TOKEN: 'tok' };
    assert.throws(() => xhsProviderConfigFromEnv({ ...base, XHS_DM_SENDER: '/opt/xhs/xhs-dm-send' }), /XHS_MCP_DATA_DIR/);
    const cfg = xhsProviderConfigFromEnv({ ...base, XHS_DM_SENDER: '/opt/xhs/xhs-dm-send', XHS_MCP_DATA_DIR: './data/xhs-mcp', XHS_DM_SEND_TIMEOUT_MS: '90000' });
    assert.ok(cfg.kind === 'mcp');
    if (cfg.kind === 'mcp') {
      assert.deepEqual(cfg.mcp.dm_sender, { helper_path: '/opt/xhs/xhs-dm-send', data_dir: join(process.cwd(), 'data/xhs-mcp'), timeout_ms: 90_000 });
    }
    assert.equal((xhsProviderConfigFromEnv(base) as { mcp: { dm_sender?: unknown } }).mcp.dm_sender, undefined, 'off unless a deployment sets it');
  });
});
