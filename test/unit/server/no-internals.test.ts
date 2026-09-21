/**
 * The console talks to a car dealer, not to whoever built the system.
 *
 * Nothing a page renders may contain the machinery: integration tool names, the fleet script, instance ports,
 * environment variables, English status codes, internal skill / agent names, or our own row ids as visible text.
 * That material is real and useful — it lives in the audit log and the server log, which is where support looks.
 *
 * This test renders every page with a live provider and realistically ugly data (a failed search whose error is the
 * raw one a real instance produced, a capability snapshot with the provider's English reason, a decision, an audit
 * event) and reads back only what a human would see: visible text plus the tooltips.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { newId } from '../../../src/core/ids.ts';
import { McpXhsProvider } from '../../../src/providers/xhs/mcp-provider.ts';
import type { RequestContext } from '../../../src/server/http.ts';
import { accountsPage } from '../../../src/server/pages/accounts.ts';
import { contentPage, postDetailPage } from '../../../src/server/pages/content.ts';
import { conversationsPage } from '../../../src/server/pages/conversations.ts';
import { intelPage } from '../../../src/server/pages/intel.ts';
import { leadDetailPage, leadsPage } from '../../../src/server/pages/leads.ts';
import { overviewPage } from '../../../src/server/pages/overview.ts';
import { setupPage } from '../../../src/server/pages/setup.ts';
import type { PageEnv } from '../../../src/server/pages/shell.ts';
import { systemPage } from '../../../src/server/pages/system.ts';
import { vehicleDetailPage, vehiclesPage } from '../../../src/server/pages/vehicles.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture, seedLead, vehicleIdByKey } from '../../helpers/fixtures.ts';

/** verbatim from a real run: this is the text that used to reach the 情报 page */
const RAW_SEARCH_ERROR =
  'UNAVAILABLE: xiaohongshu-mcp tool failed (account xhs_9f2a31c07b4e88d1a005): 搜索Feeds失败: 筛选面板里没有「发布时间」这一组';
const RAW_CAPABILITY_REASON =
  'via xiaohongshu-mcp publish_content (account xhs_7c41de9a2f60b3e7c118 (db), logged in as 某某汽车XX店官方号); at least one image required; no note id is returned (reconcile later)';

const BANNED: [RegExp, string][] = [
  [/xiaohongshu-mcp/i, '集成层工具名'],
  [/xhs-mcp-fleet/i, '运维脚本'],
  [/\b(?:search_feeds|get_feed_detail|publish_content|get_my_profile|user_profile|reply_comment_in_feed|list_notifications|get_unread_count|delete_cookies)\b/, '接口名'],
  [/\bXHS_[A-Z_]+\b|\bAPP_ENV\b|\bDATABASE_PATH\b|\bOPENROUTER_API_KEY\b/, '环境变量'],
  [/\b(?:UNAVAILABLE|REQUIRES_AUTH|REQUIRES_REVIEW)\b/, '英文状态码'],
  [/:180\d\d\b/, '实例端口'],
  [/cookies\.json/, '会话文件'],
  [/\b(?:lead|outreach|post|conv|veh|acc|dlr|ntf|run)_[0-9a-z]{10,}\b/, '内部记录ID'],
  [/\b(?:lead-hunting-agent|outreach-agent|conversation-agent|lead-research-agent|lead-scoring-agent|fleet-controller|publishing-agent|account-strategy-agent)\b/, '内部 agent 名'],
  [/\b(?:lead_research|lead_score|outreach_generation|conversation_reply|content_generation|notification-inbox|vehicle-brain|account-sessions)\b/, '内部 skill 名'],
];

/** What a person actually sees: text nodes plus the tooltips, with scripts, styles and attributes removed. */
function visibleText(html: string): string {
  const titles = [...html.matchAll(/\stitle="([^"]*)"/g)].map((m) => m[1]).join(' \n ');
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return `${body}\n${titles}`;
}

function setup(): { ctx: TestContext; dealerId: string; leadId: string; vehicleId: string; postId: string } {
  const ctx = createTestContext();
  const summary = loadDealerFixture(ctx);
  const dealerId = dealerIdByKey(summary, 'hz-bmw');
  const unreachable = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  ctx.xhs = new McpXhsProvider(ctx.clock, { account_endpoints: {} } as never, {
    fetchImpl: unreachable,
    resolveAccount: (id) => ctx.db.table('xhs_accounts').get(id)?.platform_account_id ?? null,
    resolveEndpoint: (id) => {
      const url = ctx.db.table('xhs_accounts').get(id)?.mcp_endpoint_url;
      return url ? { url } : null;
    },
  });
  const now = ctx.clock.iso();
  const account = ctx.db.table('xhs_accounts').findMany({ dealer_id: dealerId })[0]!;
  ctx.db.table('xhs_accounts').update(account.id, {
    mcp_endpoint_url: 'http://127.0.0.1:18061/mcp',
    auth_checked_at: now,
    auth_state: 'requires_auth',
    auth_detail: 'Xiaohongshu session not logged in on account xhs-hz-official (log in via get_login_qrcode)',
  });

  // a failed search, exactly as the integration reported it
  const query = ctx.db.table('search_queries').insert({
    id: newId('sq'),
    dealer_id: dealerId,
    goal_id: null,
    text: '本地品牌',
    query_class: 'location',
    brand: 'BMW',
    model: null,
    location: '舟山',
    priority: 0.8,
    status: 'active',
    parent_query_id: null,
    generation_reason: 'test',
    created_at: now,
    updated_at: now,
  });
  ctx.db.table('search_runs').insert({
    id: newId('sr'),
    query_id: query.id,
    dealer_id: dealerId,
    workflow_run_id: null,
    provider: ctx.xhs.name,
    status: 'FAILED',
    data_mode: 'live',
    posts_discovered: 0,
    posts_new: 0,
    comments_scanned: 0,
    users_evaluated: 0,
    candidates: 0,
    qualified: 0,
    high_intent: 0,
    error: RAW_SEARCH_ERROR,
    started_at: now,
    finished_at: now,
  });
  ctx.db.table('capability_snapshots').insert({
    id: newId('cap'),
    provider: ctx.xhs.name,
    account_id: account.id,
    capability: 'publish_content',
    status: 'AVAILABLE',
    reason: RAW_CAPABILITY_REASON,
    checked_at: now,
  });

  const lead = seedLead(ctx, { dealer_id: dealerId, platform_user_id: 'u-leak-1', stage: 'QUALIFIED' });
  ctx.db.table('agent_decisions').insert({
    id: newId('dec'),
    agent: 'lead-research-agent',
    skill: 'lead-research',
    decision_type: 'lead_research',
    subject_type: 'lead',
    subject_id: lead.id,
    inputs: {},
    evidence: [{ code: 'ip_match', label: 'IP属地 浙江 与门店所在省份一致' }],
    output: { researched: true },
    confidence: 0.7,
    engine: 'rules',
    workflow_run_id: null,
    created_at: now,
  });
  ctx.audit.event({ actor: 'agent:lead-hunting-agent', action: 'lead.created', entity_type: 'lead', entity_id: lead.id, details: {} });

  const post = ctx.db.table('posts').findMany({ dealer_id: dealerId })[0];
  return { ctx, dealerId, leadId: lead.id, vehicleId: vehicleIdByKey(summary, 'i3-edrive35l'), postId: post?.id ?? '' };
}

/** the 系统 page reads the workflow engine and the scheduler; a page test only needs them to answer */
const env = (ctx: TestContext) =>
  ({
    runtime: {
      ctx,
      config: { warnings: [] },
      engine: { list: () => [], listRuns: () => [], has: () => false },
      scheduler: { listSchedules: () => [], plan: () => [], list: () => [] },
    },
    options: { auth_enabled: true },
  }) as unknown as PageEnv;
const rc = (dealerId: string, params: Record<string, string> = {}, query: Record<string, string> = {}) =>
  ({ query: new URLSearchParams({ dealer: dealerId, ...query }), params, req: { headers: {} }, operator: 'op' }) as unknown as RequestContext;

describe('控制台不向用户暴露系统内部', () => {
  it('every page speaks the store\'s language, on every tab', () => {
    const s = setup();
    const e = env(s.ctx);
    const pages: [string, string][] = [
      ['今日', String(overviewPage(e, rc(s.dealerId)).html)],
      ['线索', String(leadsPage(e, rc(s.dealerId)).html)],
      ['线索详情', String(leadDetailPage(e, rc(s.dealerId, { id: s.leadId })).html)],
      ['对话', String(conversationsPage(e, rc(s.dealerId)).html)],
      ['对话·评论和@', String(conversationsPage(e, rc(s.dealerId, {}, { view: 'mentions' })).html)],
      ['对话·赞和收藏', String(conversationsPage(e, rc(s.dealerId, {}, { view: 'likes' })).html)],
      ['对话·新增关注', String(conversationsPage(e, rc(s.dealerId, {}, { view: 'connections' })).html)],
      ['内容', String(contentPage(e, rc(s.dealerId)).html)],
      ['车型库', String(vehiclesPage(e, rc(s.dealerId)).html)],
      ['车型卡片', String(vehicleDetailPage(e, rc(s.dealerId, { id: s.vehicleId })).html)],
      ['车型·已归档', String(vehiclesPage(e, rc(s.dealerId, {}, { archived: '1' })).html)],
      ['账号', String(accountsPage(e, rc(s.dealerId)).html)],
      ['情报', String(intelPage(e, rc(s.dealerId)).html)],
      ['系统', String(systemPage(e, rc(s.dealerId)).html)],
      ['设置', String(setupPage(e, rc(s.dealerId)).html)],
    ];
    if (s.postId) pages.push(['内容详情', String(postDetailPage(e, rc(s.dealerId, { id: s.postId })).html)]);

    for (const [name, html] of pages) {
      const text = visibleText(html);
      for (const [re, what] of BANNED) {
        const hit = re.exec(text);
        assert.equal(hit, null, `${name} 页面暴露了${what}：…${text.slice(Math.max(0, (hit?.index ?? 0) - 50), (hit?.index ?? 0) + 70).replace(/\s+/g, ' ')}…`);
      }
    }
  });

  it('the failed search says what to do, not what broke inside', () => {
    const s = setup();
    const text = visibleText(String(intelPage(env(s.ctx), rc(s.dealerId)).html));
    assert.match(text, /小红书页面改版了|没走通|稍后重试/);
    assert.doesNotMatch(text, /搜索Feeds失败/);
  });

  it('a capability row says what the store can do with it', () => {
    const s = setup();
    const text = visibleText(String(systemPage(env(s.ctx), rc(s.dealerId)).html));
    assert.match(text, /可以直接发笔记/);
    assert.doesNotMatch(text, /reconcile later/);
  });
});
