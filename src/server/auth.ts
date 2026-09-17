/**
 * Console authentication: a single console password (CONSOLE_PASSWORD) plus the operator's name, exchanged for an
 * HMAC-SHA256 signed session cookie. The operator name becomes the audit actor (`operator:<name>`) and the
 * `sent_by` of messages a human sends by hand. CSRF: state-changing requests must carry `x-console-request: 1`
 * (set by the console's fetch helper) or an Origin matching the Host.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'xhs_console_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const CSRF_HEADER = 'x-console-request';
export const MAX_OPERATOR_NAME = 40;

export interface SessionPayload {
  /** operator display name */
  sub: string;
  /** expiry, epoch ms */
  exp: number;
}

const b64url = (buf: Buffer): string => buf.toString('base64url');

function hmac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

/** Constant-time string comparison (both sides are HMAC-ed first so length differences leak nothing). */
export function safeEqual(a: string, b: string): boolean {
  const key = randomBytes(32);
  const ha = createHmac('sha256', key).update(a, 'utf8').digest();
  const hb = createHmac('sha256', key).update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f<>"'`]/g;

/** Trim, collapse whitespace, strip control and markup characters; empty → null. */
export function normalizeOperatorName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(UNSAFE_NAME_CHARS, '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  return Array.from(name).slice(0, MAX_OPERATOR_NAME).join('');
}

export function signSession(secret: string, payload: SessionPayload): string {
  if (!secret) throw new Error('session secret is required');
  const body = b64url(Buffer.from(JSON.stringify({ sub: payload.sub, exp: payload.exp }), 'utf8'));
  return `${body}.${b64url(hmac(secret, body))}`;
}

/** Returns the payload when the signature is valid and the session has not expired; otherwise null. */
export function verifySession(secret: string, token: string | undefined | null, nowMs: number): SessionPayload | null {
  if (!secret || !token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  const given = Buffer.from(sig, 'base64url');
  const expected = hmac(secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const p = parsed as Partial<SessionPayload>;
  if (typeof p.sub !== 'string' || typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return null;
  if (p.exp <= nowMs) return null;
  const sub = normalizeOperatorName(p.sub);
  if (!sub) return null;
  return { sub, exp: p.exp };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name || Object.hasOwn(out, name)) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function sessionCookie(token: string, opts: { secure: boolean; maxAgeMs?: number }): string {
  const maxAge = Math.floor((opts.maxAgeMs ?? SESSION_TTL_MS) / 1000);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${opts.secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

/**
 * CSRF check for state-changing methods. Safe methods pass. Otherwise the console's custom header, or an Origin
 * header whose host equals the request Host, is required. Cross-site forms cannot set custom headers, and
 * SameSite=Strict keeps the session cookie off cross-site requests as a second layer.
 */
export function isCsrfSafe(req: { method?: string; headers: Record<string, string | string[] | undefined> }): boolean {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const header = req.headers[CSRF_HEADER];
  if (header === '1') return true;
  // Browsers set Sec-Fetch-Site themselves (pages cannot forge it). A plain same-origin <form> POST — e.g. the login
  // form — carries it even when Origin is sent as "null" by a strict referrer policy.
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'same-origin') return true;
  if (typeof fetchSite === 'string' && fetchSite !== 'none') return false;
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin === 'string' && typeof host === 'string' && origin !== 'null') {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return false;
}

/** Random secret for development when no SESSION_SECRET is configured (sessions do not survive restarts). */
export function ephemeralSecret(): string {
  return randomBytes(32).toString('hex');
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Client address used for login rate limiting and logs. Behind a reverse proxy on the same host every connection comes
 * from loopback, so with `trustProxy` the proxy-set X-Forwarded-For is used instead (its last entry: the address the
 * proxy itself saw). The header is ignored for non-loopback peers, which could set it to anything.
 */
export function clientAddress(req: { socket: { remoteAddress?: string }; headers: Record<string, string | string[] | undefined> }, trustProxy: boolean): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  if (!trustProxy || !LOOPBACK_ADDRESSES.has(remote)) return remote;
  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  const forwarded = (raw ?? '').split(',').map((part) => part.trim()).filter(Boolean);
  return forwarded.at(-1) ?? remote;
}

/** Sliding-window limiter for failed logins (per client address). */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max = 10, windowMs = 10 * 60 * 1000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  blocked(key: string, nowMs: number): boolean {
    const recent = (this.failures.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
    if (recent.length === 0) this.failures.delete(key);
    else this.failures.set(key, recent);
    return recent.length >= this.max;
  }

  fail(key: string, nowMs: number): void {
    const recent = (this.failures.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
    recent.push(nowMs);
    this.failures.set(key, recent);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
