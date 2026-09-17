/**
 * Minimal HTTP plumbing for the operator console and JSON API (zero dependencies):
 * a method + path router with `:param` segments, bounded body reading, JSON parsing,
 * AppError → JSON error mapping and response writing with security headers.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppError } from '../core/errors.ts';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type Method = (typeof METHODS)[number];

/** Request bodies above this size are rejected with 413 (spec: 2 MB). */
export const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;

export interface Reply {
  status?: number;
  headers?: Record<string, string | string[]>;
  json?: unknown;
  html?: string;
  text?: string;
  body?: Buffer | string;
  contentType?: string;
  /** 303 See Other redirect target (same-origin path) */
  redirect?: string;
  /** cache for static assets; everything else is no-store */
  cacheSeconds?: number;
}

export interface RequestContext {
  readonly req: IncomingMessage;
  readonly method: Method;
  readonly url: URL;
  readonly path: string;
  readonly query: URLSearchParams;
  params: Record<string, string>;
  /** audit actor, e.g. 'operator:王磊' */
  actor: string;
  /** operator display name (sent_by) */
  operator: string;
  authenticated: boolean;
  rawBody(): Promise<Buffer>;
  json<T = unknown>(): Promise<T>;
}

export type Handler = (rc: RequestContext) => Promise<Reply> | Reply;

export interface RouteOptions {
  /** reachable without a console session (health checks, login, webhooks with their own token) */
  public?: boolean;
}

export interface Route {
  method: Method;
  pattern: string;
  segments: string[];
  handler: Handler;
  opts: RouteOptions;
}

export type MatchResult =
  | { kind: 'found'; route: Route; params: Record<string, string> }
  | { kind: 'method_not_allowed'; allowed: Method[] }
  | { kind: 'not_found' };

const splitPath = (path: string): string[] => path.split('/').filter((s) => s.length > 0);

export class Router {
  private readonly routes: Route[] = [];

  add(method: Method, pattern: string, handler: Handler, opts: RouteOptions = {}): this {
    if (!pattern.startsWith('/')) throw new Error(`route pattern must start with "/": ${pattern}`);
    const segments = splitPath(pattern);
    const shape = (segs: string[]) => segs.map((s) => (s.startsWith(':') ? ':' : s)).join('/');
    const clash = this.routes.find((r) => r.method === method && shape(r.segments) === shape(segments));
    if (clash) throw new Error(`duplicate route ${method} ${pattern}`);
    this.routes.push({ method, pattern, segments, handler, opts });
    return this;
  }

  get(pattern: string, handler: Handler, opts?: RouteOptions): this {
    return this.add('GET', pattern, handler, opts);
  }
  post(pattern: string, handler: Handler, opts?: RouteOptions): this {
    return this.add('POST', pattern, handler, opts);
  }
  put(pattern: string, handler: Handler, opts?: RouteOptions): this {
    return this.add('PUT', pattern, handler, opts);
  }
  patch(pattern: string, handler: Handler, opts?: RouteOptions): this {
    return this.add('PATCH', pattern, handler, opts);
  }
  delete(pattern: string, handler: Handler, opts?: RouteOptions): this {
    return this.add('DELETE', pattern, handler, opts);
  }

  list(): { method: Method; pattern: string; public: boolean }[] {
    return this.routes.map((r) => ({ method: r.method, pattern: r.pattern, public: r.opts.public === true }));
  }

  /**
   * Static segments beat `:param` segments (`/api/leads/queue` wins over `/api/leads/:id`).
   * HEAD is matched as GET. Malformed percent-encoding in a parameter is a 400.
   */
  match(method: string, path: string): MatchResult {
    const parts = splitPath(path);
    const wanted = method === 'HEAD' ? 'GET' : method;
    let best: { route: Route; params: Record<string, string>; dynamic: number } | null = null;
    const allowed = new Set<Method>();
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let dynamic = 0;
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) {
          dynamic++;
          try {
            params[seg.slice(1)] = decodeURIComponent(parts[i]);
          } catch {
            throw new AppError('bad_request', `malformed path segment: ${parts[i]}`, 400);
          }
        } else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      allowed.add(route.method);
      if (route.method !== wanted) continue;
      if (!best || dynamic < best.dynamic) best = { route, params, dynamic };
    }
    if (best) return { kind: 'found', route: best.route, params: best.params };
    if (allowed.size > 0) return { kind: 'method_not_allowed', allowed: [...allowed] };
    return { kind: 'not_found' };
  }
}

/** Read the request body, rejecting anything larger than `limit` bytes with 413. */
export function readRawBody(req: IncomingMessage, limit = DEFAULT_BODY_LIMIT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new AppError('payload_too_large', `请求体超过 ${Math.round(limit / 1024 / 1024)} MB 上限`, 413));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new AppError('payload_too_large', `请求体超过 ${Math.round(limit / 1024 / 1024)} MB 上限`, 413));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

/** Parse a JSON body; an empty body is `{}`. Invalid JSON is a 400 with a clear code. */
export function parseJsonBody(buf: Buffer): unknown {
  const text = buf.toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new AppError('invalid_json', `请求体不是有效的 JSON：${(err as Error).message}`, 400);
  }
}

export interface ErrorReply {
  reply: Reply;
  /** true for unexpected errors (logged with stack, message hidden from the client) */
  internal: boolean;
}

export function toErrorReply(err: unknown): ErrorReply {
  if (err instanceof AppError) {
    return {
      internal: err.status >= 500,
      reply: { status: err.status, json: { error: { code: err.code, message: err.message, details: err.details } } },
    };
  }
  return {
    internal: true,
    reply: { status: 500, json: { error: { code: 'internal_error', message: '服务器内部错误，请查看服务日志', details: {} } } },
  };
}

const HTML_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** Write a Reply. Sets nosniff / frame / referrer headers everywhere and a strict CSP on HTML. */
export function sendReply(res: ServerResponse, method: string, reply: Reply): void {
  const headers: Record<string, string | string[]> = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    // same-origin: our own form POSTs keep a real Origin header (CSRF check) while outbound links (e.g. xiaohongshu.com
    // source posts) still receive no referrer. 'no-referrer' made browsers send `Origin: null` and broke login.
    'referrer-policy': 'same-origin',
    'cache-control': reply.cacheSeconds ? `public, max-age=${reply.cacheSeconds}` : 'no-store',
    ...(reply.headers ?? {}),
  };
  let status = reply.status ?? 200;
  let body: Buffer | string = '';
  if (reply.redirect !== undefined) {
    status = reply.status ?? 303;
    headers.location = reply.redirect;
  } else if (reply.json !== undefined) {
    headers['content-type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(reply.json);
  } else if (reply.html !== undefined) {
    headers['content-type'] = 'text/html; charset=utf-8';
    headers['content-security-policy'] = HTML_CSP;
    body = reply.html;
  } else if (reply.text !== undefined) {
    headers['content-type'] = 'text/plain; charset=utf-8';
    body = reply.text;
  } else if (reply.body !== undefined) {
    headers['content-type'] = reply.contentType ?? 'application/octet-stream';
    body = reply.body;
  }
  headers['content-length'] = String(Buffer.byteLength(body));
  res.writeHead(status, headers);
  res.end(method === 'HEAD' ? undefined : body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Query / body helpers for handlers
// ─────────────────────────────────────────────────────────────────────────────

export function queryString(q: URLSearchParams, key: string, max = 200): string | undefined {
  const raw = q.get(key);
  if (raw === null) return undefined;
  const t = raw.trim();
  if (t === '') return undefined;
  if (t.length > max) throw new AppError('validation_error', `${key}: must be at most ${max} chars`, 422, { path: key });
  return t;
}

export function queryInt(q: URLSearchParams, key: string, opts: { min?: number; max?: number } = {}): number | undefined {
  const raw = queryString(q, key, 20);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new AppError('validation_error', `${key}: expected an integer`, 422, { path: key });
  if (opts.min !== undefined && n < opts.min) throw new AppError('validation_error', `${key}: must be >= ${opts.min}`, 422, { path: key });
  if (opts.max !== undefined && n > opts.max) throw new AppError('validation_error', `${key}: must be <= ${opts.max}`, 422, { path: key });
  return n;
}

export function queryEnum<const T extends readonly string[]>(q: URLSearchParams, key: string, values: T): T[number] | undefined {
  const raw = queryString(q, key, 60);
  if (raw === undefined) return undefined;
  if (!values.includes(raw)) {
    throw new AppError('validation_error', `${key}: expected one of ${values.join('|')}`, 422, { path: key });
  }
  return raw as T[number];
}
