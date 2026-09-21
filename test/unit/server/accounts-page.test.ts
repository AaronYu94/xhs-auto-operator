/**
 * 账号 page: adding an account has to lead somewhere. On a host that runs the sessions itself the card offers to
 * connect the account with one click; elsewhere it points at 高级设置. Neither claims a login, and neither shows the
 * machinery behind it — no tool names, no ports, no shell commands.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { McpXhsProvider } from '../../../src/providers/xhs/mcp-provider.ts';
import { accountsPage } from '../../../src/server/pages/accounts.ts';
import type { PageEnv } from '../../../src/server/pages/shell.ts';
import type { RequestContext } from '../../../src/server/http.ts';
import { createTestContext, type TestContext } from '../../helpers/context.ts';
import { dealerIdByKey, loadDealerFixture } from '../../helpers/fixtures.ts';

const unreachable = (async () => {
  throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
}) as unknown as typeof fetch;

/** live provider; `local` decides whether this host is configured to run the instances itself */
function ctxFor(local: boolean): { ctx: TestContext; dealerId: string } {
  const ctx = createTestContext();
  const dealerId = dealerIdByKey(loadDealerFixture(ctx), 'hz-bmw');
  let localInstances: Record<string, unknown> | undefined;
  if (local) {
    const dir = mkdtempSync(join(tmpdir(), 'xhs-accounts-page-'));
    const binary = join(dir, 'xiaohongshu-mcp');
    writeFileSync(binary, '#!/bin/sh\n');
    chmodSync(binary, 0o755);
    mkdirSync(join(dir, 'fleet'), { recursive: true });
    localInstances = { binary_path: binary, data_dir: join(dir, 'fleet'), bind: '127.0.0.1', token: 'fleet-token' };
  }
  ctx.xhs = new McpXhsProvider(ctx.clock, { account_endpoints: {}, ...(localInstances ? { local_instances: localInstances } : {}) } as never, {
    fetchImpl: unreachable,
    resolveAccount: (id) => ctx.db.table('xhs_accounts').get(id)?.platform_account_id ?? null,
    resolveEndpoint: (id) => {
      const url = ctx.db.table('xhs_accounts').get(id)?.mcp_endpoint_url;
      return url ? { url } : null;
    },
  });
  return { ctx, dealerId };
}

function render(ctx: TestContext, dealerId: string): string {
  const env = { runtime: { ctx, config: { warnings: [] } }, options: { auth_enabled: true } } as unknown as PageEnv;
  const rc = { query: new URLSearchParams({ dealer: dealerId }), req: { headers: {} }, operator: 'op' } as unknown as RequestContext;
  return String(accountsPage(env, rc).html);
}

describe('账号: giving a new account its own instance', () => {
  it('offers a one-click connect on a host that runs the sessions, without claiming the account is logged in', () => {
    const { ctx, dealerId } = ctxFor(true);
    const html = render(ctx, dealerId);
    assert.match(html, /data-url="\/api\/accounts\/[^"]+\/instance"/);
    assert.match(html, /连接这个账号/);
    assert.match(html, /data-pending="正在准备…"/, 'a connect that takes seconds says it is working');
    assert.match(html, /登录未检测/, 'login is still unverified until a live probe says otherwise');
  });

  it('elsewhere points at 高级设置 instead of a start button', () => {
    const { ctx, dealerId } = ctxFor(false);
    const html = render(ctx, dealerId);
    assert.doesNotMatch(html, /\/instance"/);
    assert.doesNotMatch(html, /连接这个账号/);
    assert.match(html, /高级设置|账号服务地址/);
  });

  it('never shows the machinery: no tool names, ports, shell commands or internal ids', () => {
    for (const local of [true, false]) {
      const { ctx, dealerId } = ctxFor(local);
      const html = render(ctx, dealerId);
      const hit = /.{60}xiaohongshu-mcp.{60}/s.exec(html);
      assert.doesNotMatch(html, /xiaohongshu-mcp/, `tool name${hit ? `: …${hit[0].replace(/\s+/g, ' ')}…` : ''}`);
      assert.doesNotMatch(html, /xhs-mcp-fleet/, 'shell script');
      assert.doesNotMatch(html, /:180\d\d/, 'instance port');
      assert.doesNotMatch(html, /XHS_[A-Z_]+/, 'environment variable');
      assert.doesNotMatch(html, /cookies\.json|REQUIRES_AUTH|UNAVAILABLE/, 'internal wording');
    }
  });
});
