/**
 * What the HTTP server needs from the application runtime (a subset of src/app/bootstrap.ts `Runtime`)
 * and the server options derived from AppConfig.
 */
import { readFileSync } from 'node:fs';
import type { Runtime } from '../app/bootstrap.ts';
import type { AppConfig } from '../app/config.ts';
import { ephemeralSecret } from './auth.ts';
import { DEFAULT_BODY_LIMIT } from './http.ts';

export type ServerRuntime = Pick<Runtime, 'config' | 'ctx' | 'engine' | 'scheduler' | 'operator'>;

export interface ServerOptions {
  app_env: AppConfig['app_env'];
  auth_enabled: boolean;
  console_password: string | null;
  session_secret: string;
  cookie_secure: boolean;
  /** TRUST_PROXY: take the client address from X-Forwarded-For set by a reverse proxy on loopback */
  trust_proxy: boolean;
  juguang_token: string | null;
  juguang_default_dealer_id: string | null;
  body_limit: number;
  version: string;
  started_at_ms: number;
}

let cachedVersion: string | null = null;

/** Version from package.json (read once). */
export function appVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

export function serverOptions(config: AppConfig, overrides: Partial<ServerOptions> = {}): ServerOptions {
  const password = config.auth.console_password;
  return {
    app_env: config.app_env,
    auth_enabled: password !== null && password !== '',
    console_password: password,
    session_secret: config.auth.session_secret ?? ephemeralSecret(),
    cookie_secure: config.auth.cookie_secure,
    trust_proxy: config.trust_proxy,
    juguang_token: config.juguang.webhook_token,
    juguang_default_dealer_id: config.juguang.default_dealer_id,
    body_limit: DEFAULT_BODY_LIMIT,
    version: appVersion(),
    started_at_ms: Date.now(),
    ...overrides,
  };
}
