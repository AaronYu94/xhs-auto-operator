/**
 * End-to-end: the real HTTP server over the real runtime (SQLite file, workflows, skills) with the simulation
 * provider — login, Dealer Brain import, goal → discovery → leads with exact sources, manual outreach send,
 * reply capture → appointment, dashboard, every console page, restart persistence, production refusals, webhook.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createRuntime, type Runtime } from '../../src/app/bootstrap.ts';
import { ConfigError, loadConfig } from '../../src/app/config.ts';
import { stableId } from '../../src/skills/operations/dealer-brain/index.ts';
import { startServer, type ServerHandle } from '../../src/server/app.ts';

const FIXTURE = JSON.parse(readFileSync(new URL('../../fixtures/dealers/hangzhou-bmw-group.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const HZ_DEALER_ID = stableId('dlr', 'zj-bmw-group', 'dealer:hz-bmw');
const PASSWORD = 'e2e-console-password';
const SECRET = 'e2e-session-secret-0123456789abcdef-xyz';
const dirs: string[] = [];

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'xhs-console-e2e-'));
  dirs.push(d);
  return d;
}

interface Console {
  rt: Runtime;
  handle: ServerHandle;
  url: string;
  cookie: string;
  close(): Promise<void>;
}

async function boot(env: Record<string, string>): Promise<Console> {
  const cfg = loadConfig({ LOG_LEVEL: 'silent', ...env });
  const rt = await createRuntime(cfg);
  const handle = await startServer(rt, { host: '127.0.0.1', port: 0 });
  return {
    rt,
    handle,
    url: handle.url,
    cookie: '',
    close: async () => {
      await handle.close();
      await rt.close();
    },
  };
}

async function login(c: Console, name: string, password: string): Promise<Response> {
  const res = await fetch(`${c.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-console-request': '1' },
    body: new URLSearchParams({ name, password, next: '/' }).toString(),
  });
  const set = res.headers.get('set-cookie');
  if (set) c.cookie = set.split(';')[0];
  return res;
}

async function api<T = any>(c: Console, method: string, path: string, body?: unknown, expect = [200, 201, 202]): Promise<T> {
  const res = await fetch(`${c.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-console-request': '1', cookie: c.cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  assert.ok(expect.includes(res.status), `${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

async function page(c: Console, path: string): Promise<string> {
  const res = await fetch(`${c.url}${path}`, { headers: { cookie: c.cookie }, redirect: 'manual' });
  const html = await res.text();
  assert.equal(res.status, 200, `${path} → ${res.status}: ${html.slice(0, 300)}`);
  const visible = html.replace(/<script[\s\S]*?<\/script>/g, '');
  assert.doesNotMatch(visible, /undefined|NaN|\[object Object\]/, `${path} renders a broken value`);
  return html;
}

async function waitRun(c: Console, runId: string): Promise<any> {
  for (let i = 0; i < 600; i++) {
    const r = await api(c, 'GET', `/api/workflow-runs/${runId}`);
    if (r.run.status !== 'RUNNING') return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`run ${runId} did not finish`);
}

describe('console e2e (simulation provider, real runtime)', { timeout: 240_000 }, () => {
  it('runs the full operator workflow through the console and persists across a restart', async () => {
    const dir = tempDir();
    const env = {
      APP_ENV: 'development',
      DATABASE_PATH: join(dir, 'console.db'),
      XHS_PROVIDER: 'simulation',
      XHS_SIM_REBASE_TO_NOW: 'true',
      CONSOLE_PASSWORD: PASSWORD,
      SESSION_SECRET: SECRET,
    };
    let c = await boot(env);
    try {
      // auth
      const gate = await fetch(`${c.url}/`, { redirect: 'manual' });
      assert.equal(gate.status, 303);
      assert.match(gate.headers.get('location') ?? '', /^\/login\?next=/);
      await api(c, 'GET', '/api/dealers', undefined, [401]);
      assert.equal((await login(c, '测试运营', 'wrong-password')).status, 401);
      assert.equal((await login(c, '测试运营', PASSWORD)).status, 303);
      assert.match(c.cookie, /^xhs_console_session=/);

      // CSRF: session alone is not enough for writes
      const csrf = await fetch(`${c.url}/api/dnc`, { method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(csrf.status, 403);

      // Dealer Brain
      const dry = await api(c, 'POST', '/api/dealer-brain/import', { bundle: FIXTURE, dry_run: true });
      assert.equal(dry.valid, true);
      assert.equal(dry.counts.accounts >= 5, true);
      const imported = await api(c, 'POST', '/api/dealer-brain/import', { bundle: FIXTURE });
      assert.equal(imported.summary.dealer_ids['hz-bmw'], HZ_DEALER_ID);

      // goal → discovery → leads with exact sources
      const goal = await api(c, 'POST', '/api/goals', { dealer_id: HZ_DEALER_ID, text: '这个月在杭州获取宝马i3线索' }, [202]);
      assert.equal(goal.run.status, 'RUNNING', 'goal returns while the run continues in the background');
      const run = await waitRun(c, goal.run.id);
      assert.equal(run.run.status, 'SUCCEEDED', JSON.stringify(run.steps.map((s: any) => [s.step_key, s.status, s.error])));

      const { leads } = await api(c, 'GET', `/api/leads?dealer_id=${HZ_DEALER_ID}&limit=50`);
      assert.ok(leads.length > 0, 'discovery produced leads');
      for (const l of leads) {
        assert.equal(l.data_mode, 'simulation', 'simulation leads are labelled as such');
        assert.ok(l.original_signal.length > 0, 'original signal is never hidden');
      }
      const top = leads[0];
      assert.equal(top.actor_type, 'BUYER');
      assert.match(top.source.url, /^https:\/\/www\.xiaohongshu\.com\/explore\//);

      // outreach: human review + manual send (no DM capability)
      const { items } = await api(c, 'GET', `/api/outreach?dealer_id=${HZ_DEALER_ID}`);
      assert.ok(items.length > 0, 'outreach drafts are queued for review');
      const item = items[0];
      assert.notEqual(item.outreach.status, 'SENT', 'never SENT without provider confirmation');
      assert.ok(item.copy_text && item.manual_send_instructions.length > 0);
      await api(c, 'POST', `/api/outreach/${item.outreach.id}/approve`, { message: item.outreach.message });
      const sent = await api(c, 'POST', `/api/outreach/${item.outreach.id}/mark-sent`);
      assert.equal(sent.outreach.status, 'SENT_MANUALLY');
      assert.match(String(sent.outreach.sent_by), /测试运营/);

      // reply capture → appointment → confirm
      const inbound = await api(c, 'POST', `/api/leads/${item.lead.id}/inbound`, { content: '这周六下午去店里看看，现在有什么优惠？' }, [201]);
      assert.ok(inbound.intents.includes('appointment'), JSON.stringify(inbound.intents));
      const { appointments } = await api(c, 'GET', `/api/appointments?dealer_id=${HZ_DEALER_ID}`);
      assert.ok(appointments.length > 0);
      const confirmed = await api(c, 'POST', `/api/appointments/${appointments[0].id}/confirm`, {});
      assert.equal(confirmed.appointment.status, 'confirmed');

      const dash = await api(c, 'GET', `/api/dashboard?dealer_id=${HZ_DEALER_ID}`);
      assert.ok(dash.outreach.contacted >= 1);
      assert.ok(dash.sales.appointments >= 1);
      assert.ok(dash.discovery.qualified >= 1);

      // every console page renders real data
      for (const p of ['/', '/leads', '/conversations', '/content', '/accounts', '/intel', '/system']) await page(c, `${p}?dealer=${HZ_DEALER_ID}`);
      const detail = await page(c, `/leads/${item.lead.id}?dealer=${HZ_DEALER_ID}`);
      assert.match(detail, /查看原帖/);
      assert.match(detail, /模拟数据/);
      assert.match(detail, /已人工发送/);
      const overview = await page(c, `/?dealer=${HZ_DEALER_ID}`);
      assert.match(overview, /模拟数据模式/);
      assert.doesNotMatch(overview, /发送成功/);
      await page(c, `/system/runs/${goal.run.id}?dealer=${HZ_DEALER_ID}`);
      const health = await fetch(`${c.url}/healthz`);
      assert.equal(health.status, 200);
    } finally {
      await c.close();
    }

    // restart on the same database file
    c = await boot(env);
    try {
      await api(c, 'GET', '/api/dealers', undefined, [401]);
      await login(c, '测试运营', PASSWORD);
      const { leads } = await api(c, 'GET', `/api/leads?dealer_id=${HZ_DEALER_ID}&limit=50`);
      assert.ok(leads.length > 0, 'leads survive a restart');
      const { items } = await api(c, 'GET', `/api/outreach?dealer_id=${HZ_DEALER_ID}&status=SENT_MANUALLY`);
      assert.equal(items.length, 1, 'manual send survives a restart');
      const runs = await api(c, 'GET', `/api/workflow-runs?dealer_id=${HZ_DEALER_ID}`);
      assert.ok(runs.runs.some((r: any) => r.workflow === 'goal_execution' && r.status === 'SUCCEEDED'));
      const ready = await api(c, 'GET', '/readyz');
      assert.equal(ready.status, 'ready');
    } finally {
      await c.close();
    }
  });

  it('production configuration refuses simulation data and missing console secrets', () => {
    assert.throws(
      () => loadConfig({ APP_ENV: 'production', XHS_PROVIDER: 'simulation', DATABASE_PATH: join(tempDir(), 'p.db') }),
      (err: unknown) => err instanceof ConfigError && err.problems.some((p) => p.includes('模拟数据')) && err.problems.some((p) => p.startsWith('CONSOLE_PASSWORD')),
    );
  });

  it('production server: health is public, everything else requires a session', async () => {
    const c = await boot({ APP_ENV: 'production', XHS_PROVIDER: 'none', DATABASE_PATH: join(tempDir(), 'prod.db'), CONSOLE_PASSWORD: PASSWORD, SESSION_SECRET: SECRET });
    try {
      assert.equal((await fetch(`${c.url}/healthz`)).status, 200);
      const ready = (await (await fetch(`${c.url}/readyz`)).json()) as { checks: { xhs_provider: { mode: string } } };
      assert.equal(ready.checks.xhs_provider.mode, 'none');
      assert.equal((await fetch(`${c.url}/api/dealers`)).status, 401);
      const gate = await fetch(`${c.url}/system`, { redirect: 'manual' });
      assert.equal(gate.status, 303);
      await login(c, '值班运营', PASSWORD);
      const home = await page(c, '/');
      assert.match(home, /未连接小红书/);
      assert.match(home, /还没有门店/);
      assert.match(home, /href="\/setup"/);
      assert.match(await page(c, '/setup'), /填写门店信息/);
    } finally {
      await c.close();
    }
  });

  it('onboarding: a fresh console runs only on the dealer own data and its own accounts', async () => {
    const c = await boot({
      APP_ENV: 'development',
      XHS_PROVIDER: 'simulation',
      XHS_SIM_REBASE_TO_NOW: 'true',
      DATABASE_PATH: join(tempDir(), 'onboarding.db'),
      CONSOLE_PASSWORD: PASSWORD,
      SESSION_SECRET: SECRET,
    });
    try {
      await login(c, '新门店运营', PASSWORD);
      assert.match(await page(c, '/'), /还没有门店/);
      const created = await api(c, 'POST', '/api/dealers', { name: '城南汽车销售服务店', brands: '比亚迪', city: '成都' }, [201]);
      const dealerId = created.id as string;
      assert.deepEqual(created.dealer.brands, ['BYD']);
      assert.equal(created.dealer.province, '四川');
      await api(c, 'POST', `/api/dealers/${dealerId}/vehicles`, { brand: 'BYD', model: '城南特供款', trim: '标准版', model_year: 2026, msrp: 150000 }, [201]);
      assert.equal((await api(c, 'POST', `/api/dealers/${dealerId}/vehicles`, { brand: '特斯拉', model: 'Model 3', trim: 'x', model_year: 2026, msrp: 1 }, [422])).error.code, 'validation_error');

      // No account yet: goals and acquisition runs are refused, and every page says why.
      const refused = await api(c, 'POST', '/api/goals', { dealer_id: dealerId, text: '这个月在成都获取线索' }, [409]);
      assert.equal(refused.error.code, 'setup_incomplete');
      assert.match(refused.error.message, /添加小红书账号/);
      assert.equal((await api(c, 'POST', '/api/workflows/lead_discovery/run', { dealer_id: dealerId }, [409])).error.code, 'setup_incomplete');
      const overview = await page(c, `/?dealer=${dealerId}`);
      assert.match(overview, /还没有小红书账号/);
      assert.doesNotMatch(overview, /宝马|BMW|杭州/);
      assert.match(await page(c, `/leads?dealer=${dealerId}`), /设置未完成/);
      const setup = await page(c, `/setup?dealer=${dealerId}`);
      assert.match(setup, /城南特供款/);
      assert.match(setup, /还没有小红书账号/);

      // The dealer's own account; a mistaken one can be removed while nothing references it.
      const mistake = await api(c, 'POST', `/api/dealers/${dealerId}/accounts`, { nickname: '填错的账号', account_type: 'local_guide' }, [201]);
      await api(c, 'DELETE', `/api/accounts/${mistake.id}`);
      await api(c, 'POST', `/api/dealers/${dealerId}/accounts`, { nickname: '城南小张说车', account_type: 'salesperson', salesperson_name: '张三' }, [201]);
      const status = await api(c, 'GET', `/api/dealers/${dealerId}/setup`);
      assert.equal(status.ready, true, 'simulation has no login session: an active account is enough');
      assert.equal(status.accounts_active, 1);
      assert.match(await page(c, `/accounts?dealer=${dealerId}`), /城南小张说车/);
      assert.match(await page(c, `/setup?dealer=${dealerId}`), /可以开始运行/);
      assert.match(await page(c, `/?dealer=${dealerId}`), /例如：这个月在成都获取比亚迪城南特供款线索/);

      const goal = await api(c, 'POST', '/api/goals', { dealer_id: dealerId, text: '这个月在成都获取城南特供款线索' }, [202]);
      await waitRun(c, goal.run.id);
    } finally {
      await c.close();
    }
  });

  it('聚光 webhook: disabled without a token, token-checked, persists pushed leads', async () => {
    const dir = tempDir();
    const token = 'juguang-webhook-token-e2e';
    const c = await boot({
      APP_ENV: 'development',
      XHS_PROVIDER: 'none',
      DATABASE_PATH: join(dir, 'hook.db'),
      JUGUANG_WEBHOOK_TOKEN: token,
      JUGUANG_DEFAULT_DEALER_ID: HZ_DEALER_ID,
    });
    try {
      await api(c, 'POST', '/api/dealer-brain/import', { bundle: FIXTURE });
      const push = { red_id: 'red_e2e_001', nickname: '杭州买车的小李', phone: '13800001234', city: '杭州', time: '2026-09-12 10:00:00' };
      const bad = await fetch(`${c.url}/webhooks/juguang?token=wrong-token-value`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(push) });
      assert.equal(bad.status, 401);
      const ok = await fetch(`${c.url}/webhooks/juguang?token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(push) });
      const body = (await ok.json()) as { received: number; created: string[]; updated: string[] };
      assert.equal(ok.status, 200, JSON.stringify(body));
      assert.equal(body.received, 1);
      assert.equal(body.created.length + body.updated.length, 1);
    } finally {
      await c.close();
    }
    const off = await boot({ APP_ENV: 'development', XHS_PROVIDER: 'none', DATABASE_PATH: join(tempDir(), 'off.db') });
    try {
      const res = await fetch(`${off.url}/webhooks/juguang?token=anything`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 404);
    } finally {
      await off.close();
    }
  });
});
