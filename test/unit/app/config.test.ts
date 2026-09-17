import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { describe, it } from 'node:test';
import {
  ConfigError,
  DEFAULT_PORT,
  NO_PROVIDER_IN_PRODUCTION_WARNING,
  SIMULATION_IN_PRODUCTION_MESSAGE,
  loadConfig,
  redactConfig,
} from '../../../src/app/config.ts';

const SECRET = 'x'.repeat(48);

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${String(err)}`);
    return err;
  }
  assert.fail('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('development defaults: no provider, scheduler off, absolute database path', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.app_env, 'development');
    assert.equal(cfg.port, DEFAULT_PORT);
    assert.equal(cfg.host, '0.0.0.0');
    assert.ok(isAbsolute(cfg.database_path));
    assert.ok(cfg.database_path.endsWith('xhs-operator.db'));
    assert.ok(isAbsolute(cfg.data_dir));
    assert.equal(cfg.xhs.kind, 'none');
    assert.equal(cfg.scheduler.enabled, false);
    assert.equal(cfg.scheduler.interval_ms, 60_000);
    assert.equal(cfg.auth.console_password, null);
    assert.equal(cfg.auth.cookie_secure, false);
    assert.equal(cfg.trust_proxy, false);
    assert.equal(loadConfig({ TRUST_PROXY: 'true' }).trust_proxy, true);
    assert.deepEqual(cfg.warnings, []);
  });

  it('production collects every problem at once and refuses simulation data', () => {
    const err = configError(() => loadConfig({ APP_ENV: 'production', XHS_PROVIDER: 'simulation', PORT: '99999', SESSION_SECRET: 'short' }));
    const text = err.problems.join('\n');
    assert.match(text, /CONSOLE_PASSWORD/);
    assert.match(text, /SESSION_SECRET/);
    assert.match(text, /PORT/);
    assert.ok(text.includes(SIMULATION_IN_PRODUCTION_MESSAGE));
    assert.ok(err.problems.length >= 4);
  });

  it('production with a live MCP provider and secrets is valid; scheduler on; https cookies secure', () => {
    const cfg = loadConfig({
      APP_ENV: 'production',
      CONSOLE_PASSWORD: 'correct horse battery',
      SESSION_SECRET: SECRET,
      XHS_PROVIDER: 'mcp',
      XHS_MCP_RESEARCH_URL: 'http://127.0.0.1:18060/mcp',
      XHS_MCP_TOKEN: 'mcp-token-value',
      DATABASE_PATH: '/var/lib/xhs/app.db',
      PUBLIC_BASE_URL: 'https://ops.example.com',
      JUGUANG_WEBHOOK_TOKEN: 'juguang-token-0123456789',
    });
    assert.equal(cfg.app_env, 'production');
    assert.equal(cfg.xhs.kind, 'mcp');
    assert.equal(cfg.scheduler.enabled, true);
    assert.equal(cfg.auth.cookie_secure, true);
    assert.equal(cfg.trust_proxy, false);
    assert.equal(cfg.database_path, '/var/lib/xhs/app.db');
    assert.equal(cfg.data_dir, '/var/lib/xhs');
  });

  it('production without a Xiaohongshu provider is allowed but warned', () => {
    const cfg = loadConfig({ APP_ENV: 'production', CONSOLE_PASSWORD: 'password123', SESSION_SECRET: SECRET, DATABASE_PATH: '/tmp/x.db' });
    assert.deepEqual(cfg.warnings, [NO_PROVIDER_IN_PRODUCTION_WARNING]);
  });

  it('rejects in-memory databases in production and malformed values', () => {
    const err = configError(() =>
      loadConfig({
        APP_ENV: 'production',
        CONSOLE_PASSWORD: 'password123',
        SESSION_SECRET: SECRET,
        DATABASE_PATH: ':memory:',
        SCHEDULER_ENABLED: 'maybe',
        LOG_LEVEL: 'loud',
        PUBLIC_BASE_URL: 'ftp://nope',
        JUGUANG_WEBHOOK_TOKEN: 'short',
      }),
    );
    const text = err.problems.join('\n');
    for (const key of ['DATABASE_PATH', 'SCHEDULER_ENABLED', 'LOG_LEVEL', 'PUBLIC_BASE_URL', 'JUGUANG_WEBHOOK_TOKEN']) assert.match(text, new RegExp(key));
  });

  it('reports provider configuration errors instead of silently degrading', () => {
    const err = configError(() => loadConfig({ XHS_PROVIDER: 'mcp', XHS_MCP_ACCOUNTS: 'not-a-pair' }));
    assert.match(err.problems.join('\n'), /XHS_MCP_ACCOUNTS/);
    assert.throws(() => loadConfig({ APP_ENV: 'staging' }), ConfigError);
  });

  it('NODE_ENV=production implies production when APP_ENV is unset', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production' }), ConfigError);
  });
});

describe('redactConfig', () => {
  it('never exposes passwords, secrets, API keys or MCP tokens', () => {
    const cfg = loadConfig({
      CONSOLE_PASSWORD: 'super-secret-password',
      SESSION_SECRET: SECRET,
      ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
      XHS_PROVIDER: 'mcp',
      XHS_MCP_ACCOUNTS: JSON.stringify({ 'xhs-hz-official': { url: 'http://10.0.0.5:18061/mcp', token: 'account-token-leak' } }),
      XHS_MCP_RESEARCH_URL: 'http://user:pw@10.0.0.5:18060/mcp',
      JUGUANG_WEBHOOK_TOKEN: 'juguang-token-0123456789',
    });
    const text = JSON.stringify(redactConfig(cfg));
    for (const secret of ['super-secret-password', SECRET, 'sk-ant-should-not-leak', 'account-token-leak', 'juguang-token-0123456789', 'user:pw@']) {
      assert.ok(!text.includes(secret), `leaked ${secret}`);
    }
    assert.match(text, /10\.0\.0\.5:18061/);
    assert.match(text, /\[REDACTED\]/);
    assert.match(text, /"cookie_secure":false/);
  });
});
