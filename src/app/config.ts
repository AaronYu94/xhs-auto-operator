/**
 * Runtime configuration (ARCHITECTURE §10.5). Everything the process needs is read from environment variables,
 * validated once at startup, and ALL problems are reported together so an operator can fix a deployment in one pass.
 *
 * Production guarantees
 * - `APP_ENV=production` requires CONSOLE_PASSWORD and SESSION_SECRET (≥ 32 chars).
 * - `XHS_PROVIDER=simulation` is refused in production: synthetic data must never enter a production database.
 * - `XHS_PROVIDER=none` is allowed (manual import / review queues still work) but reported as a warning.
 * Secrets never appear in logs: use `redactConfig()`.
 */
import { dirname, resolve } from 'node:path';
import { ValidationError } from '../core/errors.ts';
import type { LogLevel } from '../core/logger.ts';
import { xhsProviderConfigFromEnv, type XhsProviderConfig } from '../providers/xhs/index.ts';

export const APP_ENVS = ['development', 'test', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'silent'];
export const MIN_SESSION_SECRET_LENGTH = 32;
export const MIN_CONSOLE_PASSWORD_LENGTH = 8;
export const MIN_WEBHOOK_TOKEN_LENGTH = 16;
export const DEFAULT_PORT = 8080;
export const DEFAULT_DATABASE_PATH = './data/xhs-operator.db';
export const DEFAULT_SCHEDULER_INTERVAL_MS = 60_000;
export const SIMULATION_IN_PRODUCTION_MESSAGE = '模拟数据不允许用于生产环境（XHS_PROVIDER=simulation）';
export const NO_PROVIDER_IN_PRODUCTION_WARNING =
  '生产环境未配置小红书接入（XHS_PROVIDER=none）：公开内容搜索不可用，只能人工导入真实数据';

export interface AppConfig {
  app_env: AppEnv;
  host: string;
  port: number;
  /** absolute path, or ':memory:' */
  database_path: string;
  log_level: LogLevel;
  xhs: XhsProviderConfig;
  /** XHS_MCP_TOKEN: bearer token for account endpoints configured in the database (xhs_accounts.mcp_endpoint_url) */
  xhs_default_token: string | null;
  /** LLM environment passed to createLlmProvider (LLM_PROVIDER, OPENROUTER_API_KEY / ANTHROPIC_API_KEY, LLM_MODEL, …) */
  llm_env: Record<string, string | undefined>;
  auth: { console_password: string | null; session_secret: string | null; cookie_secure: boolean };
  scheduler: { enabled: boolean; interval_ms: number };
  juguang: { webhook_token: string | null; default_dealer_id: string | null };
  public_base_url: string | null;
  /** TRUST_PROXY: the console runs behind a reverse proxy on the same host (client address from X-Forwarded-For) */
  trust_proxy: boolean;
  /** directory for runtime data (database, exports); absolute */
  data_dir: string;
  /** non-fatal configuration notices (e.g. production without a Xiaohongshu provider) */
  warnings: string[];
}

/** Every configuration problem, not just the first. */
export class ConfigError extends ValidationError {
  readonly problems: string[];

  constructor(problems: string[]) {
    super('config', `配置无效（${problems.length} 项）：${problems.join('；')}`);
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;

const blankToNull = (value: string | undefined): string | null => {
  const s = value?.trim();
  return s ? s : null;
};

export function loadConfig(env: Env): AppConfig {
  const problems: string[] = [];
  const warnings: string[] = [];

  const bool = (key: string, fallback: boolean): boolean => {
    const raw = blankToNull(env[key]);
    if (raw === null) return fallback;
    const s = raw.toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
    problems.push(`${key}: 需要 true/false，实际为 ${JSON.stringify(raw)}`);
    return fallback;
  };
  const int = (key: string, fallback: number, min: number, max: number): number => {
    const raw = blankToNull(env[key]);
    if (raw === null) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${key}: 需要 ${min}–${max} 之间的整数，实际为 ${JSON.stringify(raw)}`);
      return fallback;
    }
    return n;
  };

  // ── environment ─────────────────────────────────────────────────────────────
  const rawEnv = blankToNull(env.APP_ENV)?.toLowerCase() ?? (blankToNull(env.NODE_ENV)?.toLowerCase() === 'production' ? 'production' : 'development');
  let app_env: AppEnv = 'development';
  if ((APP_ENVS as readonly string[]).includes(rawEnv)) app_env = rawEnv as AppEnv;
  else problems.push(`APP_ENV: 需要 ${APP_ENVS.join('|')}，实际为 ${JSON.stringify(rawEnv)}`);
  const production = app_env === 'production';

  // ── server ──────────────────────────────────────────────────────────────────
  const host = blankToNull(env.HOST) ?? '0.0.0.0';
  const port = int('PORT', DEFAULT_PORT, 1, 65_535);

  const rawDb = blankToNull(env.DATABASE_PATH) ?? DEFAULT_DATABASE_PATH;
  const database_path = rawDb === ':memory:' ? rawDb : resolve(rawDb);
  if (production && database_path === ':memory:') problems.push('DATABASE_PATH: 生产环境必须使用持久化数据库文件，不能是 :memory:');
  const rawDataDir = blankToNull(env.DATA_DIR);
  const data_dir = resolve(rawDataDir ?? (database_path === ':memory:' ? './data' : dirname(database_path)));

  const rawLevel = (blankToNull(env.LOG_LEVEL) ?? (app_env === 'test' ? 'warn' : 'info')).toLowerCase();
  let log_level: LogLevel = 'info';
  if ((LOG_LEVELS as readonly string[]).includes(rawLevel)) log_level = rawLevel as LogLevel;
  else problems.push(`LOG_LEVEL: 需要 ${LOG_LEVELS.join('|')}，实际为 ${JSON.stringify(rawLevel)}`);

  // ── Xiaohongshu provider ────────────────────────────────────────────────────
  let xhs: XhsProviderConfig = { kind: 'none' };
  try {
    xhs = xhsProviderConfigFromEnv(env);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  if (production && xhs.kind === 'simulation') problems.push(`XHS_PROVIDER: ${SIMULATION_IN_PRODUCTION_MESSAGE}`);
  if (production && xhs.kind === 'none' && problems.every((p) => !p.startsWith('XHS'))) warnings.push(NO_PROVIDER_IN_PRODUCTION_WARNING);

  // ── LLM ─────────────────────────────────────────────────────────────────────
  const llmProvider = blankToNull(env.LLM_PROVIDER)?.toLowerCase() ?? null;
  if (llmProvider && !(['anthropic', 'openrouter', 'none'] as const).includes(llmProvider as 'none')) {
    problems.push(`LLM_PROVIDER: 只能是 anthropic、openrouter 或 none（当前 ${llmProvider}）`);
  }
  const llm_env: Record<string, string | undefined> = {
    LLM_PROVIDER: env.LLM_PROVIDER,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL: env.OPENROUTER_BASE_URL,
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    LLM_MODEL: env.LLM_MODEL,
    ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
    ANTHROPIC_REFUSAL_FALLBACKS: env.ANTHROPIC_REFUSAL_FALLBACKS,
  };

  // ── console auth ────────────────────────────────────────────────────────────
  const console_password = env.CONSOLE_PASSWORD !== undefined && env.CONSOLE_PASSWORD.length > 0 ? env.CONSOLE_PASSWORD : null;
  const session_secret = env.SESSION_SECRET !== undefined && env.SESSION_SECRET.length > 0 ? env.SESSION_SECRET : null;
  if (console_password !== null && console_password.length < MIN_CONSOLE_PASSWORD_LENGTH) {
    problems.push(`CONSOLE_PASSWORD: 至少 ${MIN_CONSOLE_PASSWORD_LENGTH} 个字符`);
  }
  if (session_secret !== null && session_secret.length < MIN_SESSION_SECRET_LENGTH) {
    problems.push(`SESSION_SECRET: 至少 ${MIN_SESSION_SECRET_LENGTH} 个字符（建议 openssl rand -hex 32）`);
  }
  if (production && console_password === null) problems.push('CONSOLE_PASSWORD: 生产环境必须设置控制台登录密码');
  if (production && session_secret === null) problems.push('SESSION_SECRET: 生产环境必须设置会话签名密钥');
  if (console_password !== null && session_secret === null && !production) {
    warnings.push('已设置 CONSOLE_PASSWORD 但未设置 SESSION_SECRET：重启后会话失效（开发环境使用随机密钥）');
  }

  // ── public URL / cookies ────────────────────────────────────────────────────
  const public_base_url = blankToNull(env.PUBLIC_BASE_URL);
  if (public_base_url !== null) {
    let ok = false;
    try {
      const u = new URL(public_base_url);
      ok = u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      ok = false;
    }
    if (!ok) problems.push(`PUBLIC_BASE_URL: 需要 http(s) 地址，实际为 ${JSON.stringify(public_base_url)}`);
  }
  const cookie_secure = bool('COOKIE_SECURE', production && (public_base_url?.startsWith('https://') ?? false));
  const trust_proxy = bool('TRUST_PROXY', false);

  // ── scheduler ───────────────────────────────────────────────────────────────
  const scheduler = {
    enabled: bool('SCHEDULER_ENABLED', production),
    interval_ms: int('SCHEDULER_INTERVAL_MS', DEFAULT_SCHEDULER_INTERVAL_MS, 1_000, 86_400_000),
  };

  // ── 聚光 lead webhook ────────────────────────────────────────────────────────
  const webhook_token = env.JUGUANG_WEBHOOK_TOKEN !== undefined && env.JUGUANG_WEBHOOK_TOKEN.length > 0 ? env.JUGUANG_WEBHOOK_TOKEN : null;
  if (webhook_token !== null && webhook_token.length < MIN_WEBHOOK_TOKEN_LENGTH) {
    problems.push(`JUGUANG_WEBHOOK_TOKEN: 至少 ${MIN_WEBHOOK_TOKEN_LENGTH} 个字符`);
  }
  const juguang = { webhook_token, default_dealer_id: blankToNull(env.JUGUANG_DEFAULT_DEALER_ID) };

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    app_env,
    host,
    port,
    database_path,
    log_level,
    xhs,
    xhs_default_token: blankToNull(env.XHS_MCP_TOKEN),
    llm_env,
    auth: { console_password, session_secret, cookie_secure },
    scheduler,
    juguang,
    public_base_url,
    trust_proxy,
    data_dir,
    warnings,
  };
}

const SECRET_KEY_RE = /token|secret|password|api_?key|authorization|cookie/i;

function redactValue(key: string, value: unknown): unknown {
  if (SECRET_KEY_RE.test(key) && key !== 'cookie_secure') {
    if (value === null || value === undefined || value === '') return value ?? null;
    return '[REDACTED]';
  }
  if (typeof value === 'function') return '[function]';
  if (Array.isArray(value)) return value.map((x, i) => redactValue(String(i), x));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(value)) out[k] = redactValue(k, x);
    return out;
  }
  return value;
}

/**
 * Log-safe view of the configuration: every value under a key that looks like a token/secret/password/API key is
 * replaced by '[REDACTED]' (null stays null so "not set" remains visible). URLs are kept; credentials embedded in
 * URLs (user:pass@host) are stripped.
 */
export function redactConfig(cfg: AppConfig): Record<string, unknown> {
  const out = redactValue('', cfg) as Record<string, unknown>;
  const stripUrlCredentials = (value: unknown): unknown => {
    if (typeof value === 'string' && /^https?:\/\/[^/]*@/i.test(value)) return value.replace(/^(https?:\/\/)[^/@]*@/i, '$1[REDACTED]@');
    if (Array.isArray(value)) return value.map(stripUrlCredentials);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, stripUrlCredentials(x)]));
    }
    return value;
  };
  return stripUrlCredentials(out) as Record<string, unknown>;
}
