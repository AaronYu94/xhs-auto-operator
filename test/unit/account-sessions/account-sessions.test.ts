import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { XHS_CAPABILITIES } from '../../../src/core/types.ts';
import { PolicyError, ValidationError } from '../../../src/core/errors.ts';
import type { LocalInstanceSpec } from '../../../src/providers/xhs/local-instance.ts';
import { McpXhsProvider } from '../../../src/providers/xhs/mcp-provider.ts';
import { SimulationXhsProvider } from '../../../src/providers/xhs/simulation.ts';
import {
  ACCOUNT_BOUND_ELSEWHERE_DETAIL,
  ACCOUNT_MISMATCH_DETAIL,
  getAccountSessions,
  loginWindowStatus,
  setAccountEndpoint,
  skill,
  startAccountInstance,
  logoutAccount,
  startAccountLogin,
  startLoginWindow,
  syncAccountAuth,
  syncFleetAuth,
  validateEndpointUrl,
} from '../../../src/skills/operations/account-sessions/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { accountIdByPlatformId, dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

const TOOLS = ['check_login_status', 'get_login_qrcode', 'search_feeds', 'get_feed_detail', 'user_profile', 'publish_content', 'get_my_profile', 'reply_comment_in_feed', 'delete_cookies', 'list_notifications', 'get_unread_count'];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

interface FakeServer {
  loggedIn: boolean;
  nickname?: string;
  userId?: string | null;
  down?: boolean;
}

function fleetNetwork(servers: Record<string, FakeServer>) {
  const calls: { url: string; tool: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const s = servers[url];
    if (!s || s.down) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params: Record<string, unknown> };
    if (body.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (body.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {} });
    if (body.method === 'tools/list') return reply({ tools: TOOLS.map((name) => ({ name })) });
    const tool = String(body.params.name);
    calls.push({ url, tool });
    const text = (t: string) => reply({ content: [{ type: 'text', text: t }] });
    switch (tool) {
      case 'check_login_status':
        return text(s.loggedIn ? `✅ 已登录\n用户名: ${s.nickname ?? '账号'}\n\n你可以使用其他功能了。` : '❌ 未登录\n\n请使用 get_login_qrcode 工具获取二维码进行登录。');
      case 'get_my_profile': {
        const feeds = s.userId ? [{ id: 'own-1', xsecToken: 't', modelType: 'note', noteCard: { displayTitle: '笔记', user: { userId: s.userId, nickname: s.nickname } } }] : [];
        return text(JSON.stringify({ userBasicInfo: { nickname: s.nickname ?? '', redId: 'red-1' }, interactions: [], feeds }));
      }
      case 'delete_cookies':
        // A real instance without cookies reports logged out AND stops returning an own profile.
        s.loggedIn = false;
        s.userId = null;
        s.nickname = undefined;
        return text('已删除 cookies，登录状态已重置');
      case 'get_login_qrcode':
        return s.loggedIn
          ? text('你当前已处于登录状态')
          : reply({ content: [{ type: 'text', text: '请用小红书 App 扫码登录 👇' }, { type: 'image', mimeType: 'image/png', data: PNG }] });
      default:
        return reply({ content: [{ type: 'text', text: `unexpected ${tool}` }], isError: true });
    }
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const URL_OFFICIAL = 'http://10.0.0.5:18061/mcp';
const URL_WANG = 'http://10.0.0.5:18062/mcp';
const URL_I3_ENV = 'http://10.0.0.5:18064/mcp';

/** Fixture dealer + a live provider resolving endpoints from env (i3) and xhs_accounts.mcp_endpoint_url (others). */
function liveSetup(servers: Record<string, FakeServer>): { ctx: TestContext; ids: Record<string, string>; dealerId: string; calls: { url: string; tool: string }[] } {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  const net = fleetNetwork(servers);
  ctx.xhs = new McpXhsProvider(ctx.clock, { account_endpoints: { 'xhs-hz-i3': { url: URL_I3_ENV, token: 'env-token' } } }, {
    fetchImpl: net.fetchImpl,
    resolveAccount: (id) => ctx.db.table('xhs_accounts').get(id)?.platform_account_id ?? null,
    resolveEndpoint: (id) => {
      const url = ctx.db.table('xhs_accounts').get(id)?.mcp_endpoint_url;
      return url ? { url, token: 'db-default-token' } : null;
    },
  });
  const ids = {
    official: accountIdByPlatformId(summary, 'xhs-hz-official'),
    wang: accountIdByPlatformId(summary, 'xhs-hz-sales-wang'),
    li: accountIdByPlatformId(summary, 'xhs-hz-sales-li'),
    i3: accountIdByPlatformId(summary, 'xhs-hz-i3'),
  };
  return { ctx, ids, dealerId: dealerIdByKey(summary, 'hz-bmw'), calls: net.calls };
}

describe('setAccountEndpoint', () => {
  it('validates, normalizes, enforces one instance per account, resets auth state and audits', () => {
    const { ctx, ids } = liveSetup({});
    assert.throws(() => setAccountEndpoint(ctx, ids.official, 'ftp://10.0.0.5/mcp', 'operator:ops'), ValidationError);
    assert.throws(() => setAccountEndpoint(ctx, ids.official, 'http://user:pw@10.0.0.5:18061/mcp', 'operator:ops'), /不得包含用户名或密码/);
    assert.throws(() => setAccountEndpoint(ctx, ids.official, 'not a url', 'operator:ops'), ValidationError);

    const updated = setAccountEndpoint(ctx, ids.official, 'HTTP://10.0.0.5:18061/mcp/', 'operator:ops');
    assert.equal(updated.mcp_endpoint_url, URL_OFFICIAL);
    assert.equal(updated.auth_state, 'unknown', 'a new instance means an unverified session');
    assert.throws(
      () => setAccountEndpoint(ctx, ids.wang, 'http://10.0.0.5:18061/mcp', 'operator:ops'),
      (e: unknown) => e instanceof PolicyError && e.code === 'endpoint_in_use' && /杭州宝马中心官方/.test(e.message),
    );
    const events = ctx.audit.eventsFor('xhs_account', ids.official).filter((e) => e.action === 'account.endpoint_updated');
    assert.equal(events.length, 1);
    assert.deepEqual({ from: events[0].details.from, to: events[0].details.to }, { from: null, to: URL_OFFICIAL });

    const same = setAccountEndpoint(ctx, ids.official, URL_OFFICIAL, 'operator:ops');
    assert.equal(ctx.audit.eventsFor('xhs_account', ids.official).filter((e) => e.action === 'account.endpoint_updated').length, 1, 'no-op not audited');
    assert.equal(same.mcp_endpoint_url, URL_OFFICIAL);
    const cleared = setAccountEndpoint(ctx, ids.official, null, 'operator:ops');
    assert.equal(cleared.mcp_endpoint_url, null);
    assert.equal(validateEndpointUrl(' https://mcp.example.com/x/ '), 'https://mcp.example.com/x');
  });
});

describe('syncAccountAuth (live provider)', () => {
  it('logged in → authenticated with verified user id, snapshots recorded; logged out → requires_auth; down → unknown', async () => {
    const servers: Record<string, FakeServer> = {
      [URL_OFFICIAL]: { loggedIn: true, nickname: '杭州宝马中心官方', userId: 'xhs-user-official' },
      [URL_WANG]: { loggedIn: false },
    };
    const { ctx, ids } = liveSetup(servers);
    setAccountEndpoint(ctx, ids.official, URL_OFFICIAL, 'operator:ops');
    setAccountEndpoint(ctx, ids.wang, URL_WANG, 'operator:ops');

    const ok = await syncAccountAuth(ctx, ids.official);
    assert.equal(ok.status, 'AVAILABLE');
    assert.equal(ok.applicable, true);
    assert.equal(ok.account.auth_state, 'authenticated');
    assert.equal(ok.account.platform_user_id, 'xhs-user-official');
    assert.equal(ok.account.auth_checked_at, ctx.clock.iso());
    assert.match(ok.account.auth_detail ?? '', /已登录「杭州宝马中心官方」.*用户ID xhs-user-official 已校验/);
    const snaps = ctx.db.table('capability_snapshots').findMany({ account_id: ids.official });
    assert.equal(snaps.length, XHS_CAPABILITIES.length);
    assert.equal(snaps.find((s) => s.capability === 'publish_content')?.status, 'AVAILABLE');
    assert.equal(snaps.find((s) => s.capability === 'send_messages')?.status, 'UNAVAILABLE');
    assert.equal(ctx.audit.eventsFor('xhs_account', ids.official).filter((e) => e.action === 'account.auth_synced').length, 1);

    const out = await syncAccountAuth(ctx, ids.wang);
    assert.equal(out.status, 'REQUIRES_AUTH');
    assert.equal(out.account.auth_state, 'requires_auth');
    assert.match(out.reason, /未登录/);

    servers[URL_WANG].down = true;
    const down = await syncAccountAuth(ctx, ids.wang);
    assert.equal(down.status, 'UNAVAILABLE');
    assert.equal(down.account.auth_state, 'unknown');
    assert.match(down.reason, /无法确认登录状态/);

    const none = await syncAccountAuth(ctx, ids.li);
    assert.equal(none.status, 'UNAVAILABLE', 'no endpoint anywhere');
    assert.equal(none.account.auth_state, 'unknown');
    assert.match(none.reason, /no xiaohongshu-mcp endpoint configured for this account/);
  });

  it('a session logged into a different Xiaohongshu user, or a user bound to another account, requires re-login', async () => {
    const servers: Record<string, FakeServer> = {
      [URL_OFFICIAL]: { loggedIn: true, nickname: '杭州宝马中心官方', userId: 'xhs-user-official' },
      [URL_WANG]: { loggedIn: true, nickname: '销售小王', userId: 'xhs-user-wang' },
    };
    const { ctx, ids } = liveSetup(servers);
    setAccountEndpoint(ctx, ids.official, URL_OFFICIAL, 'operator:ops');
    setAccountEndpoint(ctx, ids.wang, URL_WANG, 'operator:ops');
    const first = await syncAccountAuth(ctx, ids.official);
    assert.equal(first.account.platform_user_id, 'xhs-user-official');
    assert.equal(first.account.platform_profile?.nickname, '杭州宝马中心官方', 'the confirmed session’s own profile is stored');
    assert.equal(first.account.platform_profile?.notes[0]?.platform_note_id, 'own-1');
    assert.equal(first.account.platform_profile_at, ctx.clock.iso());

    servers[URL_OFFICIAL] = { loggedIn: true, nickname: '某个私人账号', userId: 'xhs-user-someone-else' };
    const mismatch = await syncAccountAuth(ctx, ids.official);
    assert.equal(mismatch.status, 'REQUIRES_AUTH');
    assert.equal(mismatch.account.auth_state, 'requires_auth');
    assert.ok(mismatch.reason.includes(ACCOUNT_MISMATCH_DETAIL));
    assert.equal(mismatch.account.platform_user_id, 'xhs-user-official', 'the verified id is never silently replaced');
    assert.equal(mismatch.account.platform_profile?.nickname, '杭州宝马中心官方', 'another user’s profile is never stored on this account');

    servers[URL_WANG] = { loggedIn: true, nickname: '杭州宝马中心官方', userId: 'xhs-user-official' };
    const elsewhere = await syncAccountAuth(ctx, ids.wang);
    assert.equal(elsewhere.status, 'REQUIRES_AUTH');
    assert.ok(elsewhere.reason.includes(ACCOUNT_BOUND_ELSEWHERE_DETAIL));
    assert.equal(elsewhere.account.platform_user_id ?? null, null);
    assert.equal(elsewhere.account.platform_profile ?? null, null);
  });

  it('syncFleetAuth probes every non-disabled account of the dealer; env endpoints win over DB rows', async () => {
    const { ctx, ids, dealerId, calls } = liveSetup({ [URL_I3_ENV]: { loggedIn: true, nickname: 'i3电车研究所', userId: 'xhs-user-i3' } });
    ctx.db.table('xhs_accounts').update(ids.li, { status: 'disabled' });
    const results = await syncFleetAuth(ctx, dealerId);
    const hzAccounts = ctx.db.table('xhs_accounts').findMany({ dealer_id: dealerId });
    assert.equal(results.length, hzAccounts.length - 1, 'disabled account skipped');
    assert.ok(!results.some((r) => r.account.id === ids.li));
    const i3 = results.find((r) => r.account.id === ids.i3)!;
    assert.equal(i3.status, 'AVAILABLE');
    assert.ok(calls.every((c) => c.url === URL_I3_ENV), 'only the configured instance was contacted');

    const sessions = getAccountSessions(ctx, dealerId);
    const i3Row = sessions.find((s) => s.account_id === ids.i3)!;
    assert.deepEqual(i3Row.endpoint, { source: 'env', url: URL_I3_ENV });
    assert.equal(i3Row.auth_state, 'authenticated');
    assert.equal(i3Row.platform_user_id, 'xhs-user-i3');
    assert.equal(i3Row.capabilities.search_public_content?.status, 'AVAILABLE');
    assert.equal(i3Row.provider.login_api, true);
    const official = sessions.find((s) => s.account_id === ids.official)!;
    assert.deepEqual(official.endpoint, { source: 'none', url: null });
    assert.equal(official.capabilities.publish_content?.status, 'UNAVAILABLE');
    const serialized = JSON.stringify(sessions);
    assert.ok(!serialized.includes('env-token') && !serialized.includes('db-default-token'), 'no bearer tokens in the read model');
  });
});

describe('startAccountLogin', () => {
  it('returns the QR data URL, audits without the image, and never falls back to another instance', async () => {
    const { ctx, ids } = liveSetup({ [URL_WANG]: { loggedIn: false } });
    setAccountEndpoint(ctx, ids.wang, URL_WANG, 'operator:ops');
    const qr = await startAccountLogin(ctx, ids.wang, 'operator:ops');
    assert.equal(qr.already_logged_in, false);
    assert.equal(qr.image_data_url, `data:image/png;base64,${PNG}`);
    const event = ctx.audit.eventsFor('xhs_account', ids.wang).find((e) => e.action === 'account.login_qrcode_requested');
    assert.ok(event);
    assert.equal(event.details.endpoint_source, 'db');
    assert.doesNotMatch(JSON.stringify(event.details), /base64|iVBOR/, 'image data never persisted');

    await assert.rejects(
      startAccountLogin(ctx, ids.official, 'operator:ops'),
      // The message an operator reads says what to click, never which process to start (src/server/humanize.ts).
      (e: unknown) =>
        e instanceof PolicyError &&
        e.code === 'xhs_account_no_endpoint' &&
        /还没有连接/.test(e.message) &&
        !/xiaohongshu-mcp|xhs-mcp-fleet/.test(e.message),
    );
  });
});

describe('logoutAccount', () => {
  it('deletes the instance session and leaves the account requires_auth', async () => {
    const { ctx, ids, calls } = liveSetup({ [URL_WANG]: { loggedIn: true, nickname: '王销售', userId: 'xhs-user-wang' } });
    setAccountEndpoint(ctx, ids.wang, URL_WANG, 'operator:ops');
    assert.equal((await syncAccountAuth(ctx, ids.wang)).account.auth_state, 'authenticated');

    const { account, detail } = await logoutAccount(ctx, ids.wang, 'operator:ops');
    assert.equal(account.auth_state, 'requires_auth');
    assert.match(detail, /已删除 cookies/);
    assert.equal(account.auth_detail, detail);
    assert.ok(calls.some((c) => c.tool === 'delete_cookies'));
    assert.ok(ctx.audit.eventsFor('xhs_account', ids.wang).some((e) => e.action === 'account.logged_out'));

    // The session really is gone: the next probe says so instead of reusing what we believed a moment ago.
    assert.equal((await syncAccountAuth(ctx, ids.wang)).status, 'REQUIRES_AUTH');
  });

  it('is refused for an account without its own instance, and by providers without a login session', async () => {
    const { ctx, ids } = liveSetup({});
    await assert.rejects(logoutAccount(ctx, ids.official, 'operator:ops'), (e: unknown) => e instanceof PolicyError && e.code === 'xhs_account_no_endpoint');
    const sim = createTestContext();
    const summary = loadDealerFixture(sim);
    await assert.rejects(
      logoutAccount(sim, accountIdByPlatformId(summary, 'xhs-hz-official'), 'operator:ops'),
      (e: unknown) => e instanceof PolicyError && e.code === 'xhs_logout_not_applicable',
    );
  });
});

describe('startLoginWindow', () => {
  it('opens the visible login window for the account’s local instance, audits it and reports the job', async () => {
    const ctx = createTestContext();
    const summary = loadDealerFixture(ctx);
    const i3 = accountIdByPlatformId(summary, 'xhs-hz-i3');
    const dir = mkdtempSync(join(tmpdir(), 'xhs-window-'));
    const helper = join(dir, 'helper');
    writeFileSync(helper, '#!/bin/sh\n');
    chmodSync(helper, 0o755);
    mkdirSync(join(dir, 'fleet', 'xhs-hz-i3'), { recursive: true });
    const cookiePaths: string[] = [];
    const net = fleetNetwork({ 'http://127.0.0.1:18064/mcp': { loggedIn: false } });
    ctx.xhs = new McpXhsProvider(
      ctx.clock,
      { account_endpoints: { 'xhs-hz-i3': { url: 'http://127.0.0.1:18064/mcp' } }, visible_login: { helper_path: helper, data_dir: join(dir, 'fleet') } },
      {
        fetchImpl: net.fetchImpl,
        resolveAccount: (id) => ctx.db.table('xhs_accounts').get(id)?.platform_account_id ?? null,
        runVisibleLogin: async (req) => {
          cookiePaths.push(req.cookiesPath);
          return { ok: true, detail: 'LOGIN_OK: logged in' };
        },
      },
    );
    assert.ok(getAccountSessions(ctx, dealerIdByKey(summary, 'hz-bmw')).every((s) => s.provider.login_window === true));
    const job = await startLoginWindow(ctx, i3, 'operator:ops');
    assert.equal(job.instance, 'xhs-hz-i3');
    assert.deepEqual(cookiePaths, [join(dir, 'fleet', 'xhs-hz-i3', 'cookies.json')]);
    await new Promise((r) => setImmediate(r));
    assert.equal(loginWindowStatus(ctx, i3)?.state, 'succeeded');
    const event = ctx.audit.eventsFor('xhs_account', i3).find((e) => e.action === 'account.login_window_opened');
    assert.equal(event?.details.instance, 'xhs-hz-i3');
  });

  it('is refused with a clear policy error when no login window is configured', async () => {
    const { ctx, ids } = liveSetup({});
    await assert.rejects(startLoginWindow(ctx, ids.i3, 'operator:ops'), (e: unknown) => e instanceof PolicyError && e.code === 'xhs_login_window_not_configured');
    assert.equal(loginWindowStatus(ctx, ids.i3), null);
    const sim = createTestContext();
    loadDealerFixture(sim);
    sim.xhs = SimulationXhsProvider.fromFile(sim.clock);
    await assert.rejects(startLoginWindow(sim, null, 'operator:ops'), (e: unknown) => e instanceof PolicyError && e.code === 'xhs_login_window_not_configured');
  });
});

describe('startAccountInstance', () => {
  /** A dealer whose own host runs the instances: binary + state dir + token, nothing pinned by env. */
  function localHost(): { ctx: TestContext; ids: Record<string, string>; dealerId: string; specs: LocalInstanceSpec[]; dataDir: string } {
    const ctx = createTestContext();
    const summary = loadDealerFixture(ctx);
    const dir = mkdtempSync(join(tmpdir(), 'xhs-add-account-'));
    const binary = join(dir, 'xiaohongshu-mcp');
    writeFileSync(binary, '#!/bin/sh\n');
    chmodSync(binary, 0o755);
    const dataDir = join(dir, 'fleet');
    mkdirSync(dataDir, { recursive: true });
    const specs: LocalInstanceSpec[] = [];
    const net = fleetNetwork({});
    ctx.xhs = new McpXhsProvider(
      ctx.clock,
      { account_endpoints: {}, local_instances: { binary_path: binary, data_dir: dataDir, bind: '127.0.0.1', base_port: 18060, token: 'fleet-token' } },
      {
        fetchImpl: net.fetchImpl,
        resolveAccount: (id) => ctx.db.table('xhs_accounts').get(id)?.platform_account_id ?? null,
        resolveEndpoint: (id) => {
          const url = ctx.db.table('xhs_accounts').get(id)?.mcp_endpoint_url;
          return url ? { url, token: 'fleet-token' } : null;
        },
        startLocalInstance: (spec) => {
          specs.push(spec);
          return Promise.resolve({ ok: true, pid: 3131, detail: `实例已在 ${spec.bind}:${spec.port} 启动` });
        },
        probePort: (_bind, port) => Promise.resolve(port !== 18060),
      },
    );
    const ids = {
      official: accountIdByPlatformId(summary, 'xhs-hz-official'),
      wang: accountIdByPlatformId(summary, 'xhs-hz-sales-wang'),
    };
    return { ctx, ids, dealerId: dealerIdByKey(summary, 'hz-bmw'), specs, dataDir };
  }

  it('starts the account’s own instance, binds it and leaves the login to a human', async () => {
    const { ctx, ids, dealerId, specs, dataDir } = localHost();
    assert.ok(getAccountSessions(ctx, dealerId).every((s) => s.provider.local_instances === true));

    const { account, instance } = await startAccountInstance(ctx, ids.official, 'operator:ops');
    assert.equal(instance.url, 'http://127.0.0.1:18061/mcp');
    assert.equal(instance.started, true);
    assert.equal(account.mcp_endpoint_url, 'http://127.0.0.1:18061/mcp', 'the account is bound to the instance that was just started');
    assert.equal(specs[0]?.instanceDir, join(dataDir, 'xhs-hz-official'), 'its own cookies directory');
    assert.equal(specs[0]?.token, 'fleet-token');
    assert.equal(account.auth_state, 'unknown', 'a new instance is a new session: login is not assumed');
    const started = ctx.audit.eventsFor('xhs_account', ids.official).find((e) => e.action === 'account.instance_started');
    assert.equal(started?.details.port, 18061);
    assert.equal(started?.details.reused, false);

    // A second account gets its own instance on its own port, never the first one's.
    const second = await startAccountInstance(ctx, ids.wang, 'operator:ops');
    assert.equal(second.instance.port, 18062);
    assert.equal(second.account.mcp_endpoint_url, 'http://127.0.0.1:18062/mcp');
    const sessions = getAccountSessions(ctx, dealerId);
    assert.equal(sessions.find((s) => s.account_id === ids.official)?.endpoint.url, 'http://127.0.0.1:18061/mcp');
    assert.equal(sessions.find((s) => s.account_id === ids.wang)?.endpoint.url, 'http://127.0.0.1:18062/mcp');
  });

  it('says where to start the instance when this host does not run them', async () => {
    const { ctx, ids } = liveSetup({});
    await assert.rejects(
      startAccountInstance(ctx, ids.official, 'operator:ops'),
      (e: unknown) =>
        e instanceof PolicyError &&
        e.code === 'xhs_local_instance_not_configured' &&
        /一键连接账号|账号服务/.test(e.message) &&
        !/xiaohongshu-mcp|xhs-mcp-fleet|XHS_MCP/.test(e.message),
    );
    assert.equal(ctx.db.table('xhs_accounts').get(ids.official)?.mcp_endpoint_url ?? null, null, 'nothing was bound');
    const sim = createTestContext();
    const summary = loadDealerFixture(sim);
    sim.xhs = SimulationXhsProvider.fromFile(sim.clock);
    assert.ok(getAccountSessions(sim, dealerIdByKey(summary, 'hz-bmw')).every((s) => s.provider.local_instances === false));
  });
});

describe('providers without a login session', () => {
  it('simulation: sync reports "not applicable" honestly; REQUIRES_AUTH accounts become requires_auth; QR login refused', async () => {
    const ctx = createTestContext();
    const summary = loadDealerFixture(ctx);
    const official = accountIdByPlatformId(summary, 'xhs-hz-official');
    const wang = accountIdByPlatformId(summary, 'xhs-hz-sales-wang');
    ctx.xhs = SimulationXhsProvider.fromFile(ctx.clock, undefined, { auth_required_accounts: [wang] });

    const a = await syncAccountAuth(ctx, official);
    assert.equal(a.applicable, false);
    assert.match(a.reason, /^不适用：当前小红书接入 simulation（simulation）没有真实登录会话接口/);
    assert.equal(a.account.auth_state, 'authenticated', 'fixture state kept, not upgraded or faked');
    const b = await syncAccountAuth(ctx, wang);
    assert.equal(b.status, 'REQUIRES_AUTH');
    assert.equal(b.account.auth_state, 'requires_auth');
    await assert.rejects(startAccountLogin(ctx, official, 'operator:ops'), (e: unknown) => e instanceof PolicyError && e.code === 'xhs_login_not_applicable');
    const sessions = getAccountSessions(ctx, dealerIdByKey(summary, 'hz-bmw'));
    assert.ok(sessions.every((s) => s.provider.login_api === false && s.endpoint.source === 'none'));
  });
});

describe('account-sessions skill', () => {
  it('validates input and dispatches sync / sessions', async () => {
    const { ctx, ids, dealerId } = liveSetup({});
    assert.throws(() => skill.input({ action: 'login' }), ValidationError);
    await assert.rejects(Promise.resolve().then(() => skill.run(ctx, { action: 'sessions' })), /dealer_id/);
    await assert.rejects(Promise.resolve().then(() => skill.run(ctx, { action: 'sync' })), /dealer_id or account_id/);
    const synced = await skill.run(ctx, skill.input({ action: 'sync', account_id: ids.official }));
    assert.ok(synced.action === 'sync' && synced.results.length === 1);
    skill.validateOutput?.(synced);
    const sessions = await skill.run(ctx, { action: 'sessions', dealer_id: dealerId });
    assert.ok(sessions.action === 'sessions' && sessions.sessions.length >= 5);
  });
});
