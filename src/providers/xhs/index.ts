import { resolve as resolvePath } from 'node:path';
import type { Clock } from '../../core/clock.ts';
import { ValidationError } from '../../core/errors.ts';
import { DEFAULT_INSTANCE_BIND } from './local-instance.ts';
import { McpXhsProvider, type McpEndpointConfig, type McpProviderConfig } from './mcp-provider.ts';
import { DEFAULT_SIMULATION_CORPUS_PATH, SimulationXhsProvider, type SimulationOptions } from './simulation.ts';
import type { XhsProvider } from './types.ts';
import { UnavailableXhsProvider } from './unavailable.ts';

export type * from './types.ts';
export { buildReport, UnavailableXhsProvider } from './unavailable.ts';
export {
  DEFAULT_SIMULATION_CORPUS_PATH,
  parseSimulationCorpus,
  SIMULATION_DISABLED_REASONS,
  simulationQueryGroups,
  SimulationXhsProvider,
  type SimAuthor,
  type SimComment,
  type SimInboxScript,
  type SimNote,
  type SimProfile,
  type SimSentMessage,
  type SimSentReply,
  type SimulationCorpus,
  type SimulationOptions,
} from './simulation.ts';
export {
  DEFAULT_MCP_TIMEOUT_MS,
  MCP_PROTOCOL_VERSION,
  McpError,
  McpHttpClient,
  decodeRpcBody,
  parseSseMessages,
  type McpContent,
  type McpErrorKind,
  type McpHttpClientOptions,
  type McpInitializeResult,
  type McpToolInfo,
  type McpToolResult,
} from './mcp-client.ts';
export {
  DM_TOOL_PATTERN,
  IDENTITY_CACHE_TTL_MS,
  LOGIN_CACHE_TTL_MS,
  LOGIN_QRCODE_TTL_MS,
  MCP_DM_REASONS,
  McpXhsProvider,
  NO_ENDPOINT_REASON,
  NO_PUBLIC_ENDPOINT_REASON,
  TOOL_CACHE_TTL_MS,
  XHS_WEB_ORIGIN,
  classifyToolText,
  epochToIso,
  identityFromMyProfile,
  isLoopbackUrl,
  mapComment,
  mapFeed,
  mapNoteDetail,
  normalizeEndpointUrl,
  parseLoginStatusText,
  parseToolJson,
  profileFromMyProfile,
  toCount,
  xhsNoteUrl,
  xhsProfileUrl,
  type McpEndpointConfig,
  type McpProviderConfig,
  type McpProviderOptions,
  type McpVisibleLoginConfig,
  type ToolTextVerdict,
} from './mcp-provider.ts';
export {
  DEFAULT_VISIBLE_LOGIN_TIMEOUT_MS,
  parseHelperOutput,
  runVisibleLoginHelper,
  type VisibleLoginOutcome,
  type VisibleLoginRequest,
  type VisibleLoginRunner,
} from './visible-login.ts';
export {
  juguangTimeToIso,
  noteIdFromUrl,
  parseJuguangLeadPush,
  parseJuguangLeadPushDetailed,
  type JuguangLead,
  type JuguangParseResult,
} from './juguang-webhook.ts';

export type XhsProviderConfig =
  | { kind: 'none'; reason?: string }
  | { kind: 'simulation'; corpus_path: string; options?: SimulationOptions }
  | {
      kind: 'mcp';
      mcp: McpProviderConfig;
      /** internal account id → platform account id (bootstrap passes a DB lookup) */
      resolveAccount?: (internalAccountId: string) => string | null;
      /** endpoint for accounts without an env-configured instance (bootstrap: xhs_accounts.mcp_endpoint_url + XHS_MCP_TOKEN) */
      resolveEndpoint?: (accountId: string) => McpEndpointConfig | null;
      fetchImpl?: typeof fetch;
    };

/** Build the configured Xiaohongshu provider. Unknown kinds fail loudly instead of silently degrading. */
export function createXhsProvider(clock: Clock, cfg: XhsProviderConfig): XhsProvider {
  switch (cfg.kind) {
    case 'none':
      return new UnavailableXhsProvider(clock, cfg.reason);
    case 'simulation':
      return SimulationXhsProvider.fromFile(clock, cfg.corpus_path, cfg.options ?? {});
    case 'mcp':
      return new McpXhsProvider(clock, cfg.mcp, { resolveAccount: cfg.resolveAccount, resolveEndpoint: cfg.resolveEndpoint, fetchImpl: cfg.fetchImpl });
    default: {
      const kind = (cfg as { kind?: unknown }).kind;
      throw new ValidationError('xhs.kind', `unknown Xiaohongshu provider kind ${JSON.stringify(kind)} (none|simulation|mcp)`);
    }
  }
}

type Env = Record<string, string | undefined>;

function envBool(env: Env, key: string): boolean | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const s = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw new ValidationError(key, `expected a boolean (true/false), got ${JSON.stringify(raw)}`);
}

function envList(env: Env, key: string): string[] | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseAccountEndpoints(raw: string | undefined, defaultToken: string | undefined): Record<string, McpEndpointConfig> {
  const out: Record<string, McpEndpointConfig> = {};
  if (!raw || !raw.trim()) return out;
  const text = raw.trim();
  if (text.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new ValidationError('XHS_MCP_ACCOUNTS', `invalid JSON: ${(err as Error).message}`);
    }
    for (const [account, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[account] = { url: value, token: defaultToken };
      else if (value && typeof value === 'object' && typeof (value as { url?: unknown }).url === 'string') {
        const ep = value as { url: string; token?: unknown };
        out[account] = { url: ep.url, token: typeof ep.token === 'string' ? ep.token : defaultToken };
      } else throw new ValidationError(`XHS_MCP_ACCOUNTS.${account}`, 'expected "url" string or {url, token}');
    }
  } else {
    for (const pair of text.split(/[,;\s]+/).filter(Boolean)) {
      const idx = pair.indexOf('=');
      if (idx <= 0) throw new ValidationError('XHS_MCP_ACCOUNTS', `expected platformAccountId=url, got ${JSON.stringify(pair)}`);
      out[pair.slice(0, idx)] = { url: pair.slice(idx + 1), token: defaultToken };
    }
  }
  for (const [account, ep] of Object.entries(out)) {
    if (!/^https?:\/\//i.test(ep.url)) throw new ValidationError(`XHS_MCP_ACCOUNTS.${account}`, `invalid url ${JSON.stringify(ep.url)}`);
    if (ep.token === undefined) delete ep.token;
  }
  return out;
}

/**
 * Derive provider configuration from environment variables (see README.md in this directory).
 * XHS_PROVIDER=none|simulation|mcp (default none).
 */
export function xhsProviderConfigFromEnv(env: Env): XhsProviderConfig {
  const kind = (env.XHS_PROVIDER ?? 'none').trim().toLowerCase() || 'none';
  if (kind === 'none') return { kind: 'none' };
  if (kind === 'simulation') {
    const options: SimulationOptions = {};
    const flags: [keyof SimulationOptions, string][] = [
      ['send_messages', 'XHS_SIM_SEND_MESSAGES'],
      ['receive_messages', 'XHS_SIM_RECEIVE_MESSAGES'],
      ['publish', 'XHS_SIM_PUBLISH'],
      ['reply_comments', 'XHS_SIM_REPLY_COMMENTS'],
      ['rebase_to_now', 'XHS_SIM_REBASE_TO_NOW'],
    ];
    for (const [opt, key] of flags) {
      const val = envBool(env, key);
      if (val !== undefined) (options as Record<string, unknown>)[opt] = val;
    }
    const auth = envList(env, 'XHS_SIM_AUTH_REQUIRED_ACCOUNTS');
    if (auth) options.auth_required_accounts = auth;
    if (env.XHS_SIM_ID_NAMESPACE?.trim()) options.id_namespace = env.XHS_SIM_ID_NAMESPACE.trim();
    return { kind: 'simulation', corpus_path: env.XHS_SIM_CORPUS?.trim() || DEFAULT_SIMULATION_CORPUS_PATH, options };
  }
  if (kind === 'mcp') {
    const token = env.XHS_MCP_TOKEN?.trim() || undefined;
    const mcp: McpProviderConfig = { account_endpoints: parseAccountEndpoints(env.XHS_MCP_ACCOUNTS, token) };
    const researchUrl = env.XHS_MCP_RESEARCH_URL?.trim();
    if (researchUrl) {
      if (!/^https?:\/\//i.test(researchUrl)) throw new ValidationError('XHS_MCP_RESEARCH_URL', `invalid url ${JSON.stringify(researchUrl)}`);
      const researchToken = env.XHS_MCP_RESEARCH_TOKEN?.trim() || token;
      mcp.research_endpoint = researchToken ? { url: researchUrl, token: researchToken } : { url: researchUrl };
    }
    if (env.XHS_MCP_TIMEOUT_MS?.trim()) {
      const n = Number(env.XHS_MCP_TIMEOUT_MS);
      if (!Number.isInteger(n) || n <= 0) throw new ValidationError('XHS_MCP_TIMEOUT_MS', 'expected a positive integer (ms)');
      mcp.timeout_ms = n;
    }
    const dm = envBool(env, 'XHS_MCP_ENABLE_DM_TOOLS');
    if (dm !== undefined) mcp.enable_dm_tools = dm;
    // Visible-browser login (Xiaohongshu rejects QR logins scanned from the headless instance): both or neither.
    const helper = env.XHS_LOGIN_HELPER?.trim();
    const dataDir = env.XHS_MCP_DATA_DIR?.trim();
    // This host runs the instances itself: the console may start an account's own instance (XHS_MCP_BIN).
    const binary = env.XHS_MCP_BIN?.trim();
    // Opt-in DM sending through the account's own session (tools/xhs-dm-send). Off unless a deployment sets it.
    const sender = env.XHS_DM_SENDER?.trim();
    if (helper && !dataDir) throw new ValidationError('XHS_MCP_DATA_DIR', 'required with XHS_LOGIN_HELPER: the instances’ state dir (<dir>/<instance>/cookies.json)');
    if (binary && !dataDir) throw new ValidationError('XHS_MCP_DATA_DIR', 'required with XHS_MCP_BIN: the instances’ state dir (<dir>/<instance>/{cookies.json,pid,port})');
    if (sender && !dataDir) throw new ValidationError('XHS_MCP_DATA_DIR', 'required with XHS_DM_SENDER: the session a DM is sent from is <dir>/<instance>/cookies.json');
    if (dataDir && !helper && !binary && !sender)
      throw new ValidationError('XHS_LOGIN_HELPER', 'required with XHS_MCP_DATA_DIR: path of the built tools/xhs-visible-login binary (or set XHS_MCP_BIN to start instances from the console)');
    if (helper && dataDir) mcp.visible_login = { helper_path: resolvePath(helper), data_dir: resolvePath(dataDir) };
    if (binary && dataDir) {
      if (!token) {
        throw new ValidationError(
          'XHS_MCP_TOKEN',
          'required with XHS_MCP_BIN: an instance holds a live Xiaohongshu session and is only ever started with an AUTH_TOKEN this process also uses',
        );
      }
      const bind = env.XHS_MCP_BIND?.trim() || DEFAULT_INSTANCE_BIND;
      const base = env.XHS_MCP_BASE_PORT?.trim();
      let basePort: number | undefined;
      if (base) {
        const n = Number(base);
        if (!Number.isInteger(n) || n < 1 || n > 65_535) throw new ValidationError('XHS_MCP_BASE_PORT', 'expected a port number (the research instance’s port; accounts take the ports above it)');
        basePort = n;
      }
      mcp.local_instances = {
        binary_path: resolvePath(binary),
        data_dir: resolvePath(dataDir),
        bind,
        ...(basePort === undefined ? {} : { base_port: basePort }),
        token,
      };
    }
    if (sender && dataDir) {
      const ms = env.XHS_DM_SEND_TIMEOUT_MS?.trim();
      let timeoutMs: number | undefined;
      if (ms) {
        const n = Number(ms);
        if (!Number.isInteger(n) || n <= 0) throw new ValidationError('XHS_DM_SEND_TIMEOUT_MS', 'expected a positive integer (ms)');
        timeoutMs = n;
      }
      mcp.dm_sender = {
        helper_path: resolvePath(sender),
        data_dir: resolvePath(dataDir),
        ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
      };
    }
    // No env endpoints is valid (v3): account endpoints may come from xhs_accounts.mcp_endpoint_url through the
    // bootstrap's resolveEndpoint. Missing endpoints are reported per capability (UNAVAILABLE with the reason), never mocked.
    return { kind: 'mcp', mcp };
  }
  throw new ValidationError('XHS_PROVIDER', `unknown provider ${JSON.stringify(env.XHS_PROVIDER)} (none|simulation|mcp)`);
}
