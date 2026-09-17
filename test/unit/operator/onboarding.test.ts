import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PolicyError, ValidationError } from '../../../src/core/errors.ts';
import { McpXhsProvider } from '../../../src/providers/xhs/mcp-provider.ts';
import {
  addAccount,
  addVehicle,
  createDealer,
  deleteDealer,
  deleteVehicle,
  getSetupStatus,
  removeAccount,
  requireReadyToRun,
  splitList,
  updateDealer,
} from '../../../src/operator/onboarding.ts';
import { syncAccountAuth } from '../../../src/skills/operations/account-sessions/index.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { seedAssignment, seedLead } from '../../helpers/fixtures.ts';

const ACTOR = 'operator:测试';
const TOOLS = ['check_login_status', 'get_login_qrcode', 'search_feeds', 'get_feed_detail', 'user_profile', 'publish_content', 'get_my_profile', 'reply_comment_in_feed'];

const isValidation = (re: RegExp) => (e: unknown) => e instanceof ValidationError && re.test(e.message);
const isPolicy = (code: string) => (e: unknown) => e instanceof PolicyError && e.code === code;

function ownDealer(ctx: TestContext, over: Record<string, unknown> = {}) {
  return createDealer(ctx, { name: '城南汽车销售服务店', brands: '比亚迪', city: '成都', ...over }, ACTOR);
}

/** One fake xiaohongshu-mcp instance per URL; `loggedIn` flips what check_login_status answers. */
function mcpNetwork(servers: Record<string, { loggedIn: boolean; nickname: string; userId: string }>) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const s = servers[String(input)];
    if (!s) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params: Record<string, unknown> };
    if (body.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (body.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {} });
    if (body.method === 'tools/list') return reply({ tools: TOOLS.map((name) => ({ name })) });
    const text = (t: string) => reply({ content: [{ type: 'text', text: t }] });
    switch (String(body.params.name)) {
      case 'check_login_status':
        return text(s.loggedIn ? `✅ 已登录\n用户名: ${s.nickname}\n\n你可以使用其他功能了。` : '❌ 未登录\n\n请使用 get_login_qrcode 工具获取二维码进行登录。');
      case 'get_my_profile':
        return text(JSON.stringify({ userBasicInfo: { nickname: s.nickname, redId: 'red-1' }, interactions: [], feeds: [{ id: 'own-1', xsecToken: 't', modelType: 'note', noteCard: { displayTitle: '笔记', user: { userId: s.userId, nickname: s.nickname } } }] }));
      default:
        return reply({ content: [{ type: 'text', text: 'unexpected' }], isError: true });
    }
  }) as typeof fetch;
}

describe('onboarding: the dealer enters its own data', () => {
  it('creates a store only from what the operator typed', () => {
    const ctx = createTestContext();
    const dealer = ownDealer(ctx, { phone: '028-00000000' });
    assert.deepEqual(dealer.brands, ['BYD'], 'a known brand is stored canonically');
    assert.equal(dealer.city, '成都');
    assert.equal(dealer.province, '四川', 'province inferred from the city');
    assert.equal(dealer.phone, '028-00000000');
    assert.equal(ctx.db.table('dealer_groups').get(dealer.group_id)?.name, '城南汽车销售服务店');
    assert.doesNotMatch(JSON.stringify(dealer), /BMW|宝马|杭州/);
    assert.equal(ctx.audit.eventsFor('dealer', dealer.id).filter((e) => e.action === 'dealer.created').length, 1);

    const unknownBrand = createDealer(ctx, { name: '新势力体验中心', brands: '某新势力， 某新势力', city: '上海' }, ACTOR);
    assert.deepEqual(unknownBrand.brands, ['某新势力'], 'unknown brands are kept verbatim, duplicates removed');
    assert.equal(unknownBrand.group_id === dealer.group_id, false);

    const sameGroup = createDealer(ctx, { name: '城北店', brands: 'BYD', city: '成都', group_id: dealer.group_id }, ACTOR);
    assert.equal(sameGroup.group_id, dealer.group_id);

    assert.throws(() => createDealer(ctx, { name: '门店', city: '成都' }, ACTOR), isValidation(/请填写经营品牌/));
    assert.throws(() => createDealer(ctx, { brands: '比亚迪', city: '成都' }, ACTOR), isValidation(/请填写门店名称/));
    assert.throws(() => createDealer(ctx, { name: '门店', brands: '比亚迪', city: '某某镇' }, ACTOR), isValidation(/请填写省份/));
    assert.throws(() => createDealer(ctx, { name: '门店', brands: '比亚迪', city: '成都', timezone: 'Mars/Base' }, ACTOR), isValidation(/未知时区/));
    assert.throws(() => createDealer(ctx, { name: '门店', brands: '比亚迪', city: '成都', group_id: 'grp_missing' }, ACTOR), isValidation(/集团不存在/));
  });

  it('updates store fields and clears an emptied phone', () => {
    const ctx = createTestContext();
    const dealer = ownDealer(ctx, { phone: '028-1' });
    const updated = updateDealer(ctx, dealer.id, { brands: '比亚迪、某新品牌', city: '西安', province: '', phone: '' }, ACTOR);
    assert.deepEqual(updated.brands, ['BYD', '某新品牌']);
    assert.equal(updated.city, '西安');
    assert.equal(updated.province, '陕西', 'province re-inferred for the new city');
    assert.equal(updated.phone, null);
    assert.equal(ctx.audit.eventsFor('dealer', dealer.id).filter((e) => e.action === 'dealer.updated').length, 1);
    assert.equal(updateDealer(ctx, dealer.id, { city: '西安', province: '陕西' }, ACTOR).updated_at, updated.updated_at, 'no-op keeps the row');
    assert.throws(() => updateDealer(ctx, dealer.id, { city: '某某镇', province: '' }, ACTOR), isValidation(/请填写省份/));
    assert.throws(() => updateDealer(ctx, dealer.id, { brands: '' }, ACTOR), isValidation(/请填写经营品牌/));
  });

  it('adds models of the store brands only and refuses to delete a model in use', () => {
    const ctx = createTestContext();
    const dealer = createDealer(ctx, { name: '特斯拉体验店', brands: '特斯拉', city: '深圳' }, ACTOR);
    const vehicle = addVehicle(ctx, dealer.id, { brand: 'Tesla', model: 'model3', trim: '后轮驱动版', model_year: 2026, msrp: 235500, highlights: '续航长\n智能驾驶', powertrain: 'EV' }, ACTOR);
    assert.equal(vehicle.brand, 'Tesla');
    assert.equal(vehicle.brand_zh, '特斯拉');
    assert.equal(vehicle.model, 'Model 3', 'known model canonicalized');
    assert.deepEqual(vehicle.highlights, ['续航长', '智能驾驶']);
    assert.deepEqual(vehicle.specs, { powertrain: 'EV' });
    assert.deepEqual(vehicle.aliases, [], "'model3' already matches the canonical name, no alias needed");

    const custom = addVehicle(ctx, dealer.id, { brand: '特斯拉', model: '门店特供款', trim: '标准', model_year: '2026', msrp: '199000' }, ACTOR);
    assert.equal(custom.model, '门店特供款', 'unknown models are kept verbatim');

    assert.throws(() => addVehicle(ctx, dealer.id, { brand: '比亚迪', model: '汉', trim: 'x', model_year: 2026, msrp: 1 }, ACTOR), isValidation(/不在门店经营品牌/));
    assert.throws(() => addVehicle(ctx, dealer.id, { brand: 'Tesla', model: 'Model 3', trim: '后轮驱动版', model_year: 2026, msrp: 1 }, ACTOR), isValidation(/已存在/));
    assert.throws(() => addVehicle(ctx, dealer.id, { brand: 'Tesla', model: 'Model Y', trim: 'x', model_year: 2026 }, ACTOR), isValidation(/厂商指导价/));
    assert.throws(() => addVehicle(ctx, dealer.id, { brand: 'Tesla', model: 'Model Y', trim: '', model_year: 2026, msrp: 1 }, ACTOR), isValidation(/配置/));

    ctx.db.table('offers').insert({
      id: 'ofr_test',
      dealer_id: dealer.id,
      vehicle_id: vehicle.id,
      model: null,
      type: 'cash_discount',
      title: '限时优惠',
      description: '',
      amount: 5000,
      apr: null,
      term_months: null,
      down_payment_pct: null,
      conditions: '',
      valid_from: '2026-09-01',
      valid_until: '2026-09-30',
      source: 'test',
      updated_at: ctx.clock.iso(),
    });
    assert.throws(() => deleteVehicle(ctx, vehicle.id, ACTOR), isPolicy('vehicle_in_use'));
    ctx.db.table('offers').delete('ofr_test');
    deleteVehicle(ctx, vehicle.id, ACTOR);
    assert.equal(ctx.db.table('vehicles').get(vehicle.id), undefined);
  });

  it('adds the dealer own accounts logged out, with a persona of the store brands', () => {
    const ctx = createTestContext();
    const dealer = ownDealer(ctx);
    const account = addAccount(ctx, dealer.id, { nickname: '城南小张说车', account_type: 'salesperson', salesperson_name: '张三' }, ACTOR);
    assert.match(account.platform_account_id ?? '', /^xhs_/);
    assert.equal(account.status, 'active');
    assert.equal(account.auth_state, 'unknown', 'never assumed logged in');
    assert.equal(account.city, '成都');
    assert.deepEqual(ctx.db.table('account_personas').findOne({ account_id: account.id })?.focus_brands, ['BYD']);

    assert.throws(() => addAccount(ctx, dealer.id, { nickname: '销售号', account_type: 'salesperson' }, ACTOR), isValidation(/销售姓名/));
    assert.throws(() => addAccount(ctx, dealer.id, { nickname: 'x', account_type: 'robot' }, ACTOR), isValidation(/账号类型/));
    assert.throws(() => addAccount(ctx, dealer.id, { nickname: 'x', account_type: 'official', platform_account_id: '有空格 id' }, ACTOR), isValidation(/账号标识/));

    const withEndpoint = addAccount(ctx, dealer.id, { nickname: '官方号', account_type: 'official', platform_account_id: 'store-official', mcp_endpoint_url: 'http://127.0.0.1:18061/mcp/' }, ACTOR);
    assert.equal(withEndpoint.mcp_endpoint_url, 'http://127.0.0.1:18061/mcp');
    assert.throws(() => addAccount(ctx, dealer.id, { nickname: 'x', account_type: 'official', platform_account_id: 'store-official' }, ACTOR), isValidation(/已被使用/));
    const before = ctx.db.table('xhs_accounts').count({ dealer_id: dealer.id });
    assert.throws(() => addAccount(ctx, dealer.id, { nickname: '重复实例', account_type: 'official', mcp_endpoint_url: 'http://127.0.0.1:18061/mcp' }, ACTOR), isPolicy('endpoint_in_use'));
    assert.equal(ctx.db.table('xhs_accounts').count({ dealer_id: dealer.id }), before, 'a rejected instance address creates nothing');
  });

  it('removes an account only while nothing references it', () => {
    const ctx = createTestContext();
    const dealer = ownDealer(ctx);
    const used = addAccount(ctx, dealer.id, { nickname: '已在用', account_type: 'official' }, ACTOR);
    const lead = seedLead(ctx, { dealer_id: dealer.id, platform_user_id: 'u-1' });
    seedAssignment(ctx, { lead_id: lead.id, account_id: used.id });
    assert.throws(() => removeAccount(ctx, used.id, ACTOR), isPolicy('account_has_history'));

    const mistake = addAccount(ctx, dealer.id, { nickname: '填错了', account_type: 'local_guide' }, ACTOR);
    removeAccount(ctx, mistake.id, ACTOR);
    assert.equal(ctx.db.table('xhs_accounts').get(mistake.id), undefined);
    assert.equal(ctx.db.table('account_personas').findOne({ account_id: mistake.id }), undefined);
    assert.equal(ctx.audit.eventsFor('xhs_account', mistake.id).filter((e) => e.action === 'account.deleted').length, 1);
  });

  it('deletes a mistaken store with its data, but never one with leads', () => {
    const ctx = createTestContext();
    const withLead = ownDealer(ctx);
    seedLead(ctx, { dealer_id: withLead.id, platform_user_id: 'u-9' });
    assert.throws(() => deleteDealer(ctx, withLead.id, ACTOR), isPolicy('dealer_has_history'));

    const mistake = createDealer(ctx, { name: '填错的门店', brands: 'Tesla', city: '深圳' }, ACTOR);
    const sibling = createDealer(ctx, { name: '同集团门店', brands: 'Tesla', city: '深圳', group_id: mistake.group_id }, ACTOR);
    addAccount(ctx, mistake.id, { nickname: '号', account_type: 'official' }, ACTOR);
    assert.deepEqual(deleteDealer(ctx, mistake.id, ACTOR), { dealer_id: mistake.id, group_deleted: false });
    assert.equal(ctx.db.table('xhs_accounts').count({ dealer_id: mistake.id }), 0);
    assert.deepEqual(deleteDealer(ctx, sibling.id, ACTOR), { dealer_id: sibling.id, group_deleted: true });
    assert.equal(ctx.db.table('dealer_groups').get(mistake.group_id), undefined);
  });

  it('splits typed lists on Chinese and ASCII separators', () => {
    assert.deepEqual(splitList('a，b、a\n c;;', 'x', { label: '列表' }), ['a', 'b', 'c']);
    assert.deepEqual(splitList(['a', ' ', 'b'], 'x', { label: '列表' }), ['a', 'b']);
    assert.throws(() => splitList('', 'x', { label: '列表', min: 1 }), isValidation(/请填写列表/));
  });
});

describe('onboarding: readiness gate', () => {
  it('without a login API an active account is enough; no or paused accounts block', () => {
    const ctx = createTestContext();
    const dealer = ownDealer(ctx);
    const empty = getSetupStatus(ctx, dealer.id);
    assert.equal(empty.ready, false);
    assert.equal(empty.login_api, false);
    assert.match(empty.blocker ?? '', /添加小红书账号/);
    assert.throws(() => requireReadyToRun(ctx, dealer.id), isPolicy('setup_incomplete'));

    const account = addAccount(ctx, dealer.id, { nickname: '官方号', account_type: 'official' }, ACTOR);
    assert.equal(getSetupStatus(ctx, dealer.id).ready, true);
    ctx.db.table('xhs_accounts').update(account.id, { status: 'paused' });
    assert.equal(getSetupStatus(ctx, dealer.id).ready, false, 'a paused account does not run');
  });

  it('with a login API only a login verified by a live probe makes the store ready', async () => {
    const ctx = createTestContext();
    const url = 'http://127.0.0.1:18061/mcp';
    const servers = { [url]: { loggedIn: false, nickname: '城南小张说车', userId: 'u-own-1' } };
    ctx.xhs = new McpXhsProvider(ctx.clock, { account_endpoints: {} }, {
      fetchImpl: mcpNetwork(servers),
      resolveAccount: (id) => ctx.db.table('xhs_accounts').get(id)?.platform_account_id ?? null,
      resolveEndpoint: (id) => {
        const endpoint = ctx.db.table('xhs_accounts').get(id)?.mcp_endpoint_url;
        return endpoint ? { url: endpoint, token: 't' } : null;
      },
    });
    const dealer = ownDealer(ctx);
    const account = addAccount(ctx, dealer.id, { nickname: '城南小张说车', account_type: 'official', mcp_endpoint_url: url }, ACTOR);

    let status = getSetupStatus(ctx, dealer.id);
    assert.equal(status.login_api, true);
    assert.equal(status.ready, false);
    assert.match(status.blocker ?? '', /扫码登录/);

    ctx.db.table('xhs_accounts').update(account.id, { auth_state: 'authenticated' });
    assert.equal(getSetupStatus(ctx, dealer.id).ready, false, 'an unverified "authenticated" state does not count');

    await syncAccountAuth(ctx, account.id);
    assert.equal(getSetupStatus(ctx, dealer.id).ready, false, 'the probe found the session logged out');

    servers[url].loggedIn = true;
    ctx.clock.advance({ minutes: 2 });
    await syncAccountAuth(ctx, account.id);
    status = getSetupStatus(ctx, dealer.id);
    assert.equal(status.accounts_logged_in, 1);
    assert.equal(status.ready, true);
    assert.equal(status.blocker, null);
    assert.equal(requireReadyToRun(ctx, dealer.id).ready, true);
  });
});
