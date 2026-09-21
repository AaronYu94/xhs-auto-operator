/**
 * Sending one reviewed direct message from a managed account's own logged-in session.
 *
 * Xiaohongshu has no DM API a store can call: the official IM API is open only to approved third-party 客服服务商,
 * the 聚光 Marketing API covers ads, reports and 客资 (inbound leads) but no message sending, and the 专业号 workbench
 * (pro.xiaohongshu.com) does not share the instance's session at all — it asks for its own login. So the only channel
 * a store can operate itself is the account's own browser session, the same one this system already uses to publish
 * notes and reply to comments. `tools/xhs-dm-send` does exactly one send with text the console already reviewed.
 *
 * This is deliberately opt-in per deployment (`XHS_DM_SENDER`), off by default, and it changes nothing about the
 * guarantees around sending: the ten pre-send guards still run, the daily limits still apply, and an outreach only
 * becomes SENT with a provider-confirmed message id — here, the message read back inside the conversation.
 *
 * Helper protocol: `<helper> -profile <url> [-dry-run]` with COOKIES_PATH and DM_TEXT in the environment. Its output
 * contains exactly one of SEND_OK / SEND_FAILED / SEND_UNKNOWN / DRYRUN_OK / DRYRUN_FAILED. An unknown outcome is
 * never retried: the message may have reached a real person.
 */
import { spawn } from 'node:child_process';

export interface DmSendRequest {
  helperPath: string;
  /** the instance's own cookies file: the session the message is sent from */
  cookiesPath: string;
  /** recipient's public profile url */
  profileUrl: string;
  /** the reviewed message (passed through the environment, never in argv) */
  text: string;
  timeoutMs: number;
  /** true = stop before the send button (used to check the conversation is reachable) */
  dryRun?: boolean;
}

export const DM_SEND_STATES = ['sent', 'failed', 'unknown', 'dry_run'] as const;
export type DmSendState = (typeof DM_SEND_STATES)[number];

export interface DmSendOutcome {
  state: DmSendState;
  /** provider-confirmed id of the message read back in the conversation (only when state is 'sent') */
  message_id: string | null;
  /** the recipient's avatar as the conversation header showed it; the console has no other way to see their face */
  peer_avatar_url: string | null;
  detail: string;
}

export type DmSendRunner = (req: DmSendRequest) => Promise<DmSendOutcome>;

export const DEFAULT_DM_SEND_TIMEOUT_MS = 120_000;
/**
 * Marks an outreach whose send outcome could not be established. The console keys off it: such a message must never
 * get a second automatic send — a human checks Xiaohongshu and then registers it or cancels it.
 */
export const DM_SEND_UNKNOWN_MARK = '发送结果未知';
const MARKER_RE = /(SEND_OK|SEND_FAILED|SEND_UNKNOWN|DRYRUN_OK|DRYRUN_FAILED)\s*:?\s*(.*)/;
const MAX_OUTPUT_CHARS = 64 * 1024;

/** Read the helper's verdict. Anything unrecognised is 'unknown': after typing, silence is not failure. */
export function parseSenderOutput(output: string, exitCode: number | null): DmSendOutcome {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const avatarLine = lines.find((l) => l.startsWith('peer_avatar='));
  const peer = avatarLine ? avatarLine.slice('peer_avatar='.length).trim() : '';
  const peer_avatar_url = /^https:\/\/[\w.-]*xhscdn\.com\//i.test(peer) ? peer : null;
  const marker = lines.find((l) => MARKER_RE.test(l));
  if (marker) {
    const [, kind, rest] = MARKER_RE.exec(marker) as RegExpExecArray;
    const detail = rest.trim().slice(0, 300);
    if (kind === 'SEND_OK') return { state: 'sent', message_id: detail || `dm:${Date.now()}`, peer_avatar_url, detail: detail || '已在会话中确认' };
    if (kind === 'DRYRUN_OK') return { state: 'dry_run', message_id: null, peer_avatar_url, detail: detail || '会话可用，未发送' };
    if (kind === 'SEND_FAILED' || kind === 'DRYRUN_FAILED') return { state: 'failed', message_id: null, peer_avatar_url, detail: detail || '发送前失败，消息未发出' };
    return { state: 'unknown', message_id: null, peer_avatar_url, detail: detail || '发送结果未知，请勿重试' };
  }
  const last = lines.at(-1);
  return {
    state: 'unknown',
    message_id: null,
    peer_avatar_url,
    detail: `发送助手退出（code ${exitCode ?? 'signal'}）且没有给出结果${last ? `：${last.slice(0, 300)}` : ''}`,
  };
}

/** Run the helper as a child process; never throws. */
export const runDmSendHelper: DmSendRunner = (req) =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, COOKIES_PATH: req.cookiesPath, DM_TEXT: req.text };
    // Same rule as the rest of the fleet: no proxies, no pinned fingerprint seeds.
    delete env.XHS_PROXY;
    delete env.XHS_FP_SEED;
    const args = ['-profile', req.profileUrl, '-timeout', `${Math.ceil(req.timeoutMs / 1000)}s`];
    if (req.dryRun) args.push('-dry-run');
    let output = '';
    const collect = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_CHARS) output += chunk.toString('utf8');
    };
    let settled = false;
    const done = (outcome: DmSendOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(outcome);
    };
    const child = spawn(req.helperPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    // The helper enforces its own deadline; this is only a backstop for a hung browser.
    const killTimer = setTimeout(() => child.kill('SIGTERM'), req.timeoutMs + 30_000);
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (err) => done({ state: 'failed', message_id: null, peer_avatar_url: null, detail: `无法启动发送助手 ${req.helperPath}：${err.message}` }));
    child.on('close', (code) => done(parseSenderOutput(output, code)));
  });
