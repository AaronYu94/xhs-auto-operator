/**
 * Starting a xiaohongshu-mcp instance for one account on THIS host (the console's 启动本机实例).
 *
 * Every managed account needs its own instance: its own port and its own COOKIES_PATH, because an instance IS a login
 * session. Until now that meant running `scripts/xhs-mcp-fleet.sh start <id>` in a terminal and pasting the port back
 * into the console; this module does the same thing from the console, with the same layout on disk
 * (`<data_dir>/<instance>/{cookies.json,server.log,pid,port}`), so an instance started either way looks identical and
 * the login window (visible-login.ts) works on it unchanged.
 *
 * Deliberate limits:
 * - Loopback only. An instance holds a live Xiaohongshu session; the console never starts one listening on a public
 *   address, and it cannot start one on another machine (that host's own fleet script does it).
 * - A bearer token is required (the instance's `AUTH_TOKEN`), and it must be the token this process authenticates
 *   with, or the account's own console calls would be rejected by the instance it just started.
 * - The process is detached and survives the console: instances are long-lived sessions, not children of a web server.
 * - Nothing is reported as running until the instance's own `/health` answered.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { openSync, writeFileSync, chmodSync, closeSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface LocalInstanceSpec {
  /** the xiaohongshu-mcp binary */
  binaryPath: string;
  /** state directory of this instance: <data_dir>/<instance> */
  instanceDir: string;
  bind: string;
  port: number;
  /** the instance's AUTH_TOKEN (never logged, never stored in the database) */
  token: string;
}

export interface LocalInstanceOutcome {
  ok: boolean;
  pid: number | null;
  detail: string;
}

export type LocalInstanceRunner = (spec: LocalInstanceSpec) => Promise<LocalInstanceOutcome>;
/** Free = nothing is listening on that address (tests inject a fake). */
export type PortProbe = (bind: string, port: number) => Promise<boolean>;

/** Accounts get base_port + 1, + 2, … (the research instance owns the base port), same as scripts/xhs-mcp-fleet.sh. */
export const DEFAULT_BASE_PORT = 18060;
/** Instances listen on this host unless XHS_MCP_BIND says otherwise (and only loopback is ever started here). */
export const DEFAULT_INSTANCE_BIND = '127.0.0.1';
export const MAX_INSTANCE_PORTS = 64;
export const DEFAULT_START_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 500;

export function instanceUrl(bind: string, port: number): string {
  const host = bind.includes(':') ? `[${bind}]` : bind;
  return `http://${host}:${port}/mcp`;
}

export function healthUrl(bind: string, port: number): string {
  const host = bind.includes(':') ? `[${bind}]` : bind;
  return `http://${host}:${port}/health`;
}

/** True for addresses on this host: the only ones the console may start an instance on. */
export function isLoopbackHost(bind: string): boolean {
  const host = bind.trim().replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Nothing listening on bind:port right now. */
export const probePortFree: PortProbe = (bind, port) =>
  new Promise((resolve) => {
    const server = createServer();
    const done = (free: boolean) => {
      server.removeAllListeners();
      server.close(() => resolve(free));
    };
    server.once('error', () => resolve(false));
    server.once('listening', () => done(true));
    try {
      server.listen({ host: bind, port, exclusive: true });
    } catch {
      resolve(false);
    }
  });

/** The pid recorded for an instance, when that process is still alive on this host. */
export function runningPid(instanceDir: string): number | null {
  try {
    const pid = Number(readFileSync(join(instanceDir, 'pid'), 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** The port an earlier start recorded for this instance (fleet script layout), when readable. */
export function recordedPort(instanceDir: string): number | null {
  try {
    const port = Number(readFileSync(join(instanceDir, 'port'), 'utf8').trim());
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
  } catch {
    return null;
  }
}

/**
 * First free port for a new instance: the one this instance used before if it is free again, else the lowest free
 * port above the research base port. `taken` holds ports already bound to other accounts in this deployment.
 */
export async function findInstancePort(
  bind: string,
  basePort: number,
  taken: ReadonlySet<number>,
  preferred: number | null,
  free: PortProbe = probePortFree,
): Promise<number | null> {
  if (preferred !== null && !taken.has(preferred) && (await free(bind, preferred))) return preferred;
  for (let i = 1; i <= MAX_INSTANCE_PORTS; i++) {
    const port = basePort + i;
    if (port > 65_535) break;
    if (taken.has(port)) continue;
    if (await free(bind, port)) return port;
  }
  return null;
}

/** Wait until the instance answers on /health (any HTTP answer means it is listening), or give up. */
export async function waitForHealth(
  bind: string,
  port: number,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  alive: () => boolean = () => true,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetchImpl(healthUrl(bind, port), { method: 'GET' });
      if (res.status > 0) return true;
    } catch {
      // not listening yet
    }
    if (!alive()) return false;
    if (Date.now() >= deadline) return false;
    await sleep(HEALTH_POLL_MS);
  }
}

/**
 * Start the instance as a detached process and wait for its /health. Mirrors scripts/xhs-mcp-fleet.sh: own directory
 * (0700), own cookies.json (0600), own server.log, pid and port files. Never throws.
 */
export const startLocalInstanceProcess: LocalInstanceRunner = async (spec) => {
  let logFd: number | null = null;
  try {
    mkdirSync(spec.instanceDir, { recursive: true, mode: 0o700 });
    chmodSync(spec.instanceDir, 0o700);
    const cookiesPath = join(spec.instanceDir, 'cookies.json');
    if (!existsSync(cookiesPath)) writeFileSync(cookiesPath, '', { mode: 0o600 });
    chmodSync(cookiesPath, 0o600);
    logFd = openSync(join(spec.instanceDir, 'server.log'), 'a', 0o600);
    // Same rule as the fleet script: no proxies, no pinned fingerprint seeds.
    const env: NodeJS.ProcessEnv = { ...process.env, COOKIES_PATH: cookiesPath, AUTH_TOKEN: spec.token };
    delete env.XHS_PROXY;
    delete env.XHS_FP_SEED;
    const child = spawn(spec.binaryPath, ['-port', `${spec.bind}:${spec.port}`, '-headless=true'], {
      cwd: spec.instanceDir,
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    const pid = child.pid ?? null;
    let spawnError: string | null = null;
    let exited = false;
    child.once('error', (err: Error) => {
      spawnError = err.message;
      exited = true;
    });
    child.once('exit', () => {
      exited = true;
    });
    child.unref();
    if (pid !== null) {
      writeFileSync(join(spec.instanceDir, 'pid'), `${pid}\n`, { mode: 0o600 });
      writeFileSync(join(spec.instanceDir, 'port'), `${spec.port}\n`, { mode: 0o600 });
    }
    const healthy = await waitForHealth(spec.bind, spec.port, DEFAULT_START_TIMEOUT_MS, fetch, undefined, () => !exited);
    if (healthy) return { ok: true, pid, detail: `实例已在 ${spec.bind}:${spec.port} 启动（日志 ${join(spec.instanceDir, 'server.log')}）` };
    if (spawnError) return { ok: false, pid: null, detail: `无法启动 ${spec.binaryPath}：${spawnError}` };
    const tail = readLogTail(join(spec.instanceDir, 'server.log'));
    return {
      ok: false,
      pid,
      detail: `实例${exited ? '启动后退出' : `在 ${Math.round(DEFAULT_START_TIMEOUT_MS / 1000)} 秒内没有响应 /health`}，请查看日志 ${join(spec.instanceDir, 'server.log')}${tail ? `：${tail}` : ''}`,
    };
  } catch (err) {
    return { ok: false, pid: null, detail: `无法启动实例：${(err as Error)?.message ?? String(err)}` };
  } finally {
    if (logFd !== null) {
      try {
        closeSync(logFd);
      } catch {
        // the child holds its own copy of the descriptor
      }
    }
  }
};

function readLogTail(path: string, chars = 200): string {
  try {
    const text = readFileSync(path, 'utf8').trim();
    return text.slice(-chars).replace(/\s+/g, ' ');
  } catch {
    return '';
  }
}
