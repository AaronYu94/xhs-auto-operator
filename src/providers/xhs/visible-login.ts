/**
 * Visible-browser login for a local xiaohongshu-mcp instance.
 *
 * Xiaohongshu rejects QR logins scanned from a headless browser (the phone shows "fail to login" and the instance never
 * sees the scan), so logging in needs a real browser window. The login helper (tools/xhs-visible-login, built against
 * the local xiaohongshu-mcp source so browser binary and fingerprint seed match the instance) opens that window, waits
 * for the scan and writes the instance's cookies file. The running instance loads that file on its next browser launch,
 * so it does not need a restart.
 *
 * Helper protocol: `<helper> -timeout <seconds>` with COOKIES_PATH in the environment; its output contains exactly one
 * of LOGIN_OK / LOGIN_TIMEOUT / LOGIN_FAILED.
 */
import { spawn } from 'node:child_process';

export interface VisibleLoginRequest {
  helperPath: string;
  cookiesPath: string;
  timeoutMs: number;
}

export interface VisibleLoginOutcome {
  ok: boolean;
  detail: string;
}

export type VisibleLoginRunner = (req: VisibleLoginRequest) => Promise<VisibleLoginOutcome>;

export const DEFAULT_VISIBLE_LOGIN_TIMEOUT_MS = 5 * 60_000;
/** Instance names double as directory names under the data dir (same rule as scripts/xhs-mcp-fleet.sh). */
export const INSTANCE_NAME_RE = /^[A-Za-z0-9._-]+$/;

const MARKER_RE = /LOGIN_(OK|TIMEOUT|FAILED)/;
const MAX_OUTPUT_CHARS = 64 * 1024;

/** Pull the helper's verdict line out of its (logrus) output. */
export function parseHelperOutput(output: string, exitCode: number | null): VisibleLoginOutcome {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const message = (line: string) => /msg="((?:[^"\\]|\\.)*)"/.exec(line)?.[1] ?? line;
  const marker = lines.find((l) => MARKER_RE.test(l));
  if (marker) return { ok: MARKER_RE.exec(marker)?.[1] === 'OK', detail: message(marker).slice(0, 300) };
  const last = lines.at(-1);
  return { ok: false, detail: `login helper exited (code ${exitCode ?? 'signal'}) without a result${last ? `: ${message(last).slice(0, 300)}` : ''}` };
}

/** Run the helper as a child process; never throws. */
export const runVisibleLoginHelper: VisibleLoginRunner = (req) =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, COOKIES_PATH: req.cookiesPath };
    // Same rule as the fleet script: no proxies, no pinned fingerprint seeds (the seed lives in the cookies file).
    delete env.XHS_PROXY;
    delete env.XHS_FP_SEED;
    let output = '';
    const collect = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_CHARS) output += chunk.toString('utf8');
    };
    let settled = false;
    const done = (outcome: VisibleLoginOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(outcome);
    };
    const child = spawn(req.helperPath, ['-timeout', String(Math.ceil(req.timeoutMs / 1000))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    // The helper enforces its own deadline; this is only a backstop for a hung process.
    const killTimer = setTimeout(() => child.kill('SIGTERM'), req.timeoutMs + 60_000);
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => done({ ok: false, detail: `could not start the login helper ${req.helperPath}: ${err.message}` }));
    child.on('close', (code) => done(parseHelperOutput(output, code)));
  });
