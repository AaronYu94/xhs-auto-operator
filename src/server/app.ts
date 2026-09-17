/**
 * HTTP server for the operator console and JSON API (ARCHITECTURE §10.5).
 * Pipeline: route match → session → auth → CSRF → handler → JSON/HTML reply, with structured request logs,
 * consistent error JSON, a 2 MB body limit, /healthz liveness and /readyz readiness.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AppError } from '../core/errors.ts';
import { MIGRATIONS } from '../db/schema.ts';
import { describeError } from '../operator/workflow-engine.ts';
import { registerContentRoutes } from './api/content.ts';
import { registerDealerRoutes } from './api/dealers.ts';
import { registerLeadRoutes } from './api/leads.ts';
import { registerOpsRoutes } from './api/ops.ts';
import { registerPublishingRoutes } from './api/publishing.ts';
import { registerSalesRoutes } from './api/sales.ts';
import { registerSetupRoutes } from './api/setup.ts';
import { CONSOLE_CSS, CONSOLE_JS } from './assets.ts';
import {
  LoginLimiter,
  clientAddress,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  clearSessionCookie,
  isCsrfSafe,
  normalizeOperatorName,
  parseCookies,
  safeEqual,
  sessionCookie,
  signSession,
  verifySession,
} from './auth.ts';
import { METHODS, Router, parseJsonBody, readRawBody, sendReply, toErrorReply, type Method, type Reply, type RequestContext } from './http.ts';
import { registerPages } from './pages/index.ts';
import { bareLayout, esc } from './render.ts';
import { serverOptions, type ServerOptions, type ServerRuntime } from './runtime.ts';

const READY_PROBE_TIMEOUT_MS = 8_000;

function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

function loginPage(options: ServerOptions, next: string, error: string | null): string {
  return bareLayout(
    '登录',
    `<div class="login-card stack">
  <div class="brand"><span class="logo"></span>AI 汽车运营官</div>
  <p class="muted small">${options.auth_enabled ? '请输入您的姓名和控制台密码。姓名会记录在审核、发送和成交等操作的审计日志中。' : '开发模式未设置控制台密码：填写姓名即可，姓名用于审计记录。'}</p>
  ${error ? `<div class="banner banner-red">${esc(error)}</div>` : ''}
  <form class="stack" method="post" action="/login">
    <input type="hidden" name="next" value="${esc(next)}">
    <label>姓名<input type="text" name="name" required maxlength="40" autocomplete="username"></label>
    ${options.auth_enabled ? '<label>控制台密码<input type="password" name="password" required autocomplete="current-password"></label>' : ''}
    <button class="btn btn-primary" type="submit">登录</button>
  </form>
</div>`,
  );
}

async function readForm(rc: RequestContext): Promise<Record<string, string>> {
  const type = String(rc.req.headers['content-type'] ?? '');
  if (type.includes('application/json')) {
    const body = await rc.json<Record<string, unknown>>();
    return Object.fromEntries(Object.entries(body ?? {}).map(([k, x]) => [k, typeof x === 'string' ? x : '']));
  }
  return Object.fromEntries(new URLSearchParams((await rc.rawBody()).toString('utf8')));
}

export interface ServerHandle {
  server: Server;
  url: string;
  options: ServerOptions;
  close(): Promise<void>;
}

export function buildRouter(runtime: ServerRuntime, options: ServerOptions): Router {
  const router = new Router();
  const { ctx } = runtime;
  const limiter = new LoginLimiter();

  router.get('/assets/app.css', () => ({ body: CONSOLE_CSS, contentType: 'text/css; charset=utf-8', cacheSeconds: 300 }), { public: true });
  router.get('/assets/app.js', () => ({ body: CONSOLE_JS, contentType: 'text/javascript; charset=utf-8', cacheSeconds: 300 }), { public: true });
  router.get('/favicon.ico', () => ({ status: 204, text: '' }), { public: true });

  router.get('/healthz', () => ({ json: { status: 'ok', version: options.version, uptime_s: Math.round((Date.now() - options.started_at_ms) / 1000) } }), { public: true });

  router.get(
    '/readyz',
    async () => {
      const checks: Record<string, unknown> = {};
      let ready = true;
      try {
        ctx.db.get('SELECT 1 AS ok');
        const applied = ctx.db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version);
        const pending = MIGRATIONS.filter((m) => !applied.includes(m.version)).map((m) => m.version);
        checks.database = { ok: pending.length === 0, migrations_applied: applied.length, pending };
        if (pending.length > 0) ready = false;
      } catch (err) {
        ready = false;
        checks.database = { ok: false, error: (err as Error).message };
      }
      const provider: Record<string, unknown> = { name: ctx.xhs.name, mode: ctx.xhs.mode };
      try {
        const report = await Promise.race([
          ctx.xhs.capabilities(null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), READY_PROBE_TIMEOUT_MS).unref()),
        ]);
        if (report) provider.capabilities = Object.fromEntries(Object.values(report.capabilities).map((c) => [c.capability, c.status]));
        else provider.capabilities = 'probe_timeout';
      } catch (err) {
        provider.capabilities = { error: (err as Error).message };
      }
      checks.xhs_provider = provider;
      checks.llm = { status: ctx.llm.status().status };
      return { status: ready ? 200 : 503, json: { status: ready ? 'ready' : 'not_ready', app_env: options.app_env, version: options.version, checks } };
    },
    { public: true },
  );

  router.get('/login', (rc) => ({ html: loginPage(options, safeNext(rc.query.get('next')), null) }), { public: true });

  router.post(
    '/login',
    async (rc) => {
      const key = clientAddress(rc.req, options.trust_proxy);
      const nowMs = Date.now();
      const form = await readForm(rc);
      const next = safeNext(form.next);
      if (limiter.blocked(key, nowMs)) return { status: 429, html: loginPage(options, next, '尝试次数过多，请 10 分钟后再试') };
      const name = normalizeOperatorName(form.name);
      if (!name) return { status: 422, html: loginPage(options, next, '请填写姓名') };
      if (options.auth_enabled && !safeEqual(form.password ?? '', options.console_password ?? '')) {
        limiter.fail(key, nowMs);
        ctx.log.warn('console.login_failed', { remote: key });
        return { status: 401, html: loginPage(options, next, '密码不正确') };
      }
      limiter.reset(key);
      const token = signSession(options.session_secret, { sub: name, exp: nowMs + SESSION_TTL_MS });
      ctx.audit.event({ actor: `operator:${name}`, action: 'console.login', entity_type: 'console', entity_id: 'session', details: { auth_enabled: options.auth_enabled } });
      return { redirect: next, headers: { 'set-cookie': sessionCookie(token, { secure: options.cookie_secure }) } };
    },
    { public: true },
  );

  router.get('/logout', () => ({ redirect: '/login', headers: { 'set-cookie': clearSessionCookie(options.cookie_secure) } }), { public: true });

  registerDealerRoutes(router, runtime);
  registerLeadRoutes(router, runtime);
  registerOpsRoutes(router, runtime);
  registerSalesRoutes(router, runtime, options);
  registerSetupRoutes(router, runtime);
  registerContentRoutes(router, runtime);
  registerPublishingRoutes(router, runtime);
  registerPages(router, { runtime, options });
  return router;
}

export function createServer(runtime: ServerRuntime, overrides: Partial<ServerOptions> = {}): Server & { consoleOptions: ServerOptions } {
  const options = serverOptions(runtime.config, overrides);
  const router = buildRouter(runtime, options);
  const { ctx } = runtime;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = performance.now();
    const methodRaw = (req.method ?? 'GET').toUpperCase();
    let path = '/';
    let status = 500;
    let actor = 'anonymous';
    try {
      const url = new URL(req.url ?? '/', 'http://console.local');
      path = url.pathname;
      const isApi = path.startsWith('/api/') || path.startsWith('/webhooks/');
      if (methodRaw !== 'HEAD' && !(METHODS as readonly string[]).includes(methodRaw)) {
        status = 405;
        sendReply(res, methodRaw, { status, headers: { allow: METHODS.join(', ') }, json: { error: { code: 'method_not_allowed', message: 'method not allowed', details: {} } } });
        return;
      }
      const match = router.match(methodRaw, path);
      if (match.kind === 'not_found') {
        status = 404;
        const reply: Reply = isApi
          ? { status, json: { error: { code: 'not_found', message: `no route for ${methodRaw} ${path}`, details: {} } } }
          : { status, html: bareLayout('页面不存在', '<div class="login-card"><h3>页面不存在</h3><a class="link" href="/">返回总览</a></div>') };
        sendReply(res, methodRaw, reply);
        return;
      }
      if (match.kind === 'method_not_allowed') {
        status = 405;
        sendReply(res, methodRaw, { status, headers: { allow: match.allowed.join(', ') }, json: { error: { code: 'method_not_allowed', message: `allowed: ${match.allowed.join(', ')}`, details: {} } } });
        return;
      }

      const session = verifySession(options.session_secret, parseCookies(req.headers.cookie)[SESSION_COOKIE], Date.now());
      const operator = session?.sub ?? (options.auth_enabled ? '' : '控制台');
      actor = session ? `operator:${session.sub}` : options.auth_enabled ? 'anonymous' : 'operator:console';
      if (!match.route.opts.public) {
        if (options.auth_enabled && !session) {
          status = 401;
          if (isApi || methodRaw !== 'GET') {
            sendReply(res, methodRaw, { status, json: { error: { code: 'unauthorized', message: '请先登录控制台', details: {} } } });
          } else {
            status = 303;
            sendReply(res, methodRaw, { redirect: `/login?next=${encodeURIComponent(path + url.search)}` });
          }
          return;
        }
      }
      if (!isCsrfSafe({ method: methodRaw, headers: req.headers }) && !(path.startsWith('/webhooks/') && match.route.opts.public)) {
        status = 403;
        sendReply(res, methodRaw, { status, json: { error: { code: 'csrf_rejected', message: '缺少 x-console-request 头或来源不一致', details: {} } } });
        return;
      }

      let bodyPromise: Promise<Buffer> | null = null;
      const rawBody = () => (bodyPromise ??= readRawBody(req, options.body_limit));
      const rc: RequestContext = {
        req,
        method: (methodRaw === 'HEAD' ? 'GET' : methodRaw) as Method,
        url,
        path,
        query: url.searchParams,
        params: match.params,
        actor,
        operator: operator || '控制台',
        authenticated: session !== null,
        rawBody,
        json: async <T>() => parseJsonBody(await rawBody()) as T,
      };
      const reply = await match.route.handler(rc);
      status = reply.redirect !== undefined ? (reply.status ?? 303) : (reply.status ?? 200);
      sendReply(res, methodRaw, reply);
    } catch (err) {
      const { reply, internal } = toErrorReply(err);
      status = reply.status ?? 500;
      if (internal) ctx.log.error('http.error', { method: methodRaw, path, error: describeError(err) });
      const wantsHtml = methodRaw === 'GET' && !path.startsWith('/api/') && !path.startsWith('/webhooks/');
      if (wantsHtml) {
        const message = err instanceof AppError ? err.message : '服务器内部错误，请查看服务日志';
        sendReply(res, methodRaw, { status, html: bareLayout('出错了', `<div class="login-card stack"><h3>无法显示此页面</h3><p>${esc(message)}</p><a class="link" href="/">返回总览</a></div>`) });
      } else if (!res.headersSent) {
        sendReply(res, methodRaw, reply);
      } else {
        res.end();
      }
    } finally {
      ctx.log.info('http.request', { method: methodRaw, path, status, ms: Math.round(performance.now() - started), actor });
    }
  };

  const server = createHttpServer((req, res) => {
    void handle(req, res);
  }) as Server & { consoleOptions: ServerOptions };
  server.consoleOptions = options;
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  return server;
}

/** Listen on config host/port (port 0 → ephemeral). */
export async function startServer(
  runtime: ServerRuntime,
  opts: { host?: string; port?: number; overrides?: Partial<ServerOptions> } = {},
): Promise<ServerHandle> {
  const server = createServer(runtime, opts.overrides);
  const host = opts.host ?? runtime.config.host;
  const port = opts.port ?? runtime.config.port;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const shownHost = addr.address === '0.0.0.0' || addr.address === '::' ? 'localhost' : addr.address.includes(':') ? `[${addr.address}]` : addr.address;
  const url = `http://${shownHost}:${addr.port}`;
  return {
    server,
    url,
    options: server.consoleOptions,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
