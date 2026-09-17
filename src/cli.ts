/**
 * Command-line entry point.
 *
 *   node src/cli.ts serve                     start the console + API (and the scheduler when SCHEDULER_ENABLED)
 *   node src/cli.ts scheduler                 run only the scheduler loop (worker process, no HTTP)
 *   node src/cli.ts migrate                   apply database migrations
 *   node src/cli.ts doctor [--offline] [--json] [--build-check]
 *   node src/cli.ts dealer import <file> [--dry-run] [--inventory-mode snapshot|merge] [--persona-mode seed|overwrite]
 *   node src/cli.ts dealer export <dealer_id|group_id> [--out file]
 *   node src/cli.ts seed-demo                 import the fictional demo dealer (refused when APP_ENV=production)
 *   node src/cli.ts demo                      seed-demo + serve (development only)
 *   node src/cli.ts goal <dealer_id> "<text>" submit an operator goal and wait for it
 *   node src/cli.ts run <workflow> <dealer_id>
 *   node src/cli.ts xhs-login <account_id|research> [--out qr.png]
 *   node src/cli.ts import-content <dealer_id> <file>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRuntime, type Runtime } from './app/bootstrap.ts';
import { ConfigError, loadConfig, redactConfig, type AppConfig } from './app/config.ts';
import { AppError } from './core/errors.ts';
import { Db } from './db/database.ts';
import { MIGRATIONS } from './db/schema.ts';
import { SETUP_EXEMPT_WORKFLOWS, requireReadyToRun } from './operator/onboarding.ts';
import { describeError } from './operator/workflow-engine.ts';
import { ingestInputValidator, ingestPublicContent } from './skills/acquisition/lead-discovery/index.ts';
import { startAccountLogin } from './skills/operations/account-sessions/index.ts';
import { getDealer, importDealerBrain, parseDealerBrainBundle } from './skills/operations/dealer-brain/index.ts';
import { exportDealerBrainBundle } from './server/api/dealers.ts';
import { startServer } from './server/app.ts';

export const DEMO_FIXTURE_PATH = fileURLToPath(new URL('../fixtures/dealers/hangzhou-bmw-group.json', import.meta.url));
const CLI_ACTOR = 'operator:cli';

const USAGE = `AI 汽车运营官 — 小红书获客与运营系统

用法: node src/cli.ts <命令> [参数]

  serve                                  启动控制台与 API（SCHEDULER_ENABLED=true 时同时运行排班）
  scheduler                              只运行排班（无 HTTP）
  migrate                                执行数据库迁移
  doctor [--offline] [--json]            检查配置、数据库、小红书数据源、账号登录与大模型状态
  dealer import <file> [--dry-run] [--inventory-mode snapshot|merge] [--persona-mode seed|overwrite]
  dealer export <dealer_id|group_id> [--out file]
  seed-demo                              导入虚构演示门店（生产环境禁止）
  demo                                   seed-demo 后启动（仅开发环境）
  goal <dealer_id> "<目标>"               下达经营目标并等待执行完成
  run <workflow> <dealer_id>             手动运行一个工作流
  xhs-login <account_id|research> [--out qr.png]   获取账号扫码登录二维码
  import-content <dealer_id> <file>      导入真实公开笔记/评论 JSON（标记为导入数据）
`;

interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 2) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const out = (line = '') => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);

function config(env: Record<string, string | undefined> = process.env): AppConfig {
  try {
    return loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) {
      err('配置无效：');
      for (const p of e.problems) err(`  - ${p}`);
      process.exit(2);
    }
    throw e;
  }
}

function need(value: string | undefined, name: string): string {
  if (!value) {
    err(`缺少参数 ${name}\n`);
    err(USAGE);
    process.exit(2);
  }
  return value;
}

function flagString(p: Parsed, key: string): string | undefined {
  const v = p.flags[key];
  return typeof v === 'string' ? v : undefined;
}

async function withRuntime<T>(cfg: AppConfig, fn: (rt: Runtime) => Promise<T>): Promise<T> {
  const rt = await createRuntime(cfg);
  try {
    return await fn(rt);
  } finally {
    await rt.close();
  }
}

function seedDemo(rt: Runtime): void {
  if (rt.config.app_env === 'production') {
    err('拒绝执行：演示数据是虚构的，APP_ENV=production 时不能导入。请导入您自己的 Dealer Brain（dealer import）。');
    process.exit(1);
  }
  const summary = importDealerBrain(rt.ctx, parseDealerBrainBundle(JSON.parse(readFileSync(DEMO_FIXTURE_PATH, 'utf8'))));
  rt.ensureSchedules();
  out(`已导入演示门店（虚构数据）：${Object.keys(summary.dealer_ids).join(', ')}；账号 ${Object.keys(summary.account_ids).length} 个`);
  for (const [key, id] of Object.entries(summary.dealer_ids)) out(`  ${key} → ${id}`);
}

async function serve(cfg: AppConfig, opts: { seed?: boolean } = {}): Promise<void> {
  const rt = await createRuntime(cfg);
  if (opts.seed) seedDemo(rt);
  const handle = await startServer(rt);
  const stopScheduler = cfg.scheduler.enabled ? rt.startScheduler() : null;
  out(`控制台已启动：${handle.url}  （APP_ENV=${cfg.app_env}，小红书数据源 ${rt.ctx.xhs.name}/${rt.ctx.xhs.mode}，排班${stopScheduler ? '已开启' : '未开启'}）`);
  if (!handle.options.auth_enabled) out('警告：未设置 CONSOLE_PASSWORD，控制台对能访问该地址的任何人开放（仅限本机开发）。');
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    rt.ctx.log.info('server.shutdown', { signal });
    stopScheduler?.();
    const force = setTimeout(() => {
      rt.ctx.log.error('server.shutdown_timeout', {});
      process.exit(1);
    }, 20_000);
    force.unref();
    try {
      await handle.close();
      await rt.close();
      process.exit(0);
    } catch (e) {
      err(describeError(e));
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

async function schedulerOnly(cfg: AppConfig): Promise<void> {
  const rt = await createRuntime(cfg);
  const stop = rt.startScheduler();
  out(`排班进程已启动（间隔 ${cfg.scheduler.interval_ms} ms）`);
  const shutdown = async () => {
    stop();
    await rt.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms).unref())]);
}

async function doctor(p: Parsed): Promise<void> {
  const checks: Check[] = [];
  const buildCheck = p.flags['build-check'] === true;
  const offline = buildCheck || p.flags.offline === true;
  let cfg: AppConfig;
  try {
    cfg = loadConfig(buildCheck ? { ...process.env, DATABASE_PATH: ':memory:', APP_ENV: process.env.APP_ENV === 'production' ? 'test' : process.env.APP_ENV } : process.env);
    checks.push({ name: 'config', status: 'ok', detail: `APP_ENV=${cfg.app_env}` });
    for (const w of cfg.warnings) checks.push({ name: 'config.warning', status: 'warn', detail: w });
  } catch (e) {
    const problems = e instanceof ConfigError ? e.problems : [describeError(e)];
    for (const problem of problems) checks.push({ name: 'config', status: 'fail', detail: problem });
    report(checks, p);
    return;
  }
  try {
    await withRuntime(cfg, async (rt) => {
      const applied = rt.ctx.db.all<{ version: number }>('SELECT version FROM schema_migrations').length;
      checks.push({ name: 'database', status: applied === MIGRATIONS.length ? 'ok' : 'fail', detail: `${cfg.database_path} · 迁移 ${applied}/${MIGRATIONS.length}` });
      checks.push({ name: 'workflows', status: 'ok', detail: rt.engine.list().map((w) => w.name).join(', ') });
      if (buildCheck) {
        const { createServer } = await import('./server/app.ts');
        const server = createServer(rt);
        checks.push({ name: 'server', status: 'ok', detail: `console routes loaded (auth ${server.consoleOptions.auth_enabled ? 'on' : 'off'})` });
        return;
      }
      const dealers = rt.ctx.db.table('dealers').findMany({});
      checks.push({ name: 'dealers', status: dealers.length > 0 ? 'ok' : 'warn', detail: dealers.length > 0 ? dealers.map((d) => d.name).join('、') : '尚未导入 Dealer Brain（node src/cli.ts dealer import <file>）' });
      for (const d of dealers) {
        const n = rt.ctx.db.table('xhs_accounts').count({ dealer_id: d.id, status: 'active' });
        checks.push({ name: `accounts:${d.name}`, status: n >= 5 ? 'ok' : 'warn', detail: `活跃账号 ${n} 个${n < 5 ? '（建议至少 5 个）' : ''}` });
      }
      const mode = rt.ctx.xhs.mode;
      const providerStatus: Check['status'] = mode === 'live' ? 'ok' : mode === 'simulation' ? (cfg.app_env === 'production' ? 'fail' : 'warn') : cfg.app_env === 'production' ? 'fail' : 'warn';
      checks.push({ name: 'xhs.provider', status: providerStatus, detail: `${rt.ctx.xhs.name} (${mode})${mode === 'simulation' ? ' — 模拟数据，不是真实客户' : mode === 'live' ? '' : ' — 未连接小红书'}` });
      if (!offline && mode !== 'none') {
        const report0 = await withTimeout(rt.ctx.xhs.capabilities(null), 90_000);
        if (report0 === 'timeout') checks.push({ name: 'xhs.research', status: 'fail', detail: '能力检测超时（90s）' });
        else {
          const search = report0.capabilities.search_public_content;
          checks.push({ name: 'xhs.search_public_content', status: search.status === 'AVAILABLE' ? 'ok' : 'fail', detail: `${search.status}: ${search.reason}` });
          const send = report0.capabilities.send_messages;
          checks.push({ name: 'xhs.send_messages', status: 'warn', detail: `${send.status}: ${send.reason}` });
        }
        for (const a of rt.ctx.db.table('xhs_accounts').findMany({ status: 'active' })) {
          const r = await withTimeout(rt.ctx.xhs.capabilities(a.id), 90_000);
          if (r === 'timeout') {
            checks.push({ name: `xhs.account:${a.nickname}`, status: 'fail', detail: '检测超时' });
            continue;
          }
          const pub = r.capabilities.publish_content;
          const search = r.capabilities.search_public_content;
          checks.push({ name: `xhs.account:${a.nickname}`, status: search.status === 'AVAILABLE' ? 'ok' : 'warn', detail: `搜索 ${search.status} · 发布 ${pub.status} · ${search.reason}` });
        }
      }
      const llm = rt.ctx.llm.status();
      checks.push({ name: 'llm', status: llm.status === 'AVAILABLE' ? 'ok' : 'warn', detail: `${llm.provider} ${llm.status}: ${llm.reason}` });
      checks.push({ name: 'console.auth', status: cfg.auth.console_password ? 'ok' : cfg.app_env === 'production' ? 'fail' : 'warn', detail: cfg.auth.console_password ? '已设置控制台密码' : '未设置 CONSOLE_PASSWORD' });
      checks.push({ name: 'juguang.webhook', status: cfg.juguang.webhook_token ? 'ok' : 'warn', detail: cfg.juguang.webhook_token ? `已启用${cfg.juguang.default_dealer_id ? '' : '（未设置 JUGUANG_DEFAULT_DEALER_ID）'}` : '未启用（JUGUANG_WEBHOOK_TOKEN）' });
    });
  } catch (e) {
    checks.push({ name: 'runtime', status: 'fail', detail: describeError(e) });
  }
  report(checks, p, cfg);
}

function report(checks: Check[], p: Parsed, cfg?: AppConfig): void {
  const failed = checks.some((c) => c.status === 'fail');
  if (p.flags.json === true) {
    out(JSON.stringify({ ok: !failed, checks, config: cfg ? redactConfig(cfg) : null }, null, 2));
  } else {
    const icon = { ok: '✓', warn: '!', fail: '✕' } as const;
    for (const c of checks) out(`${icon[c.status]} ${c.name.padEnd(28)} ${c.detail}`);
    out(failed ? '\n存在阻断问题，请先修复。' : '\n检查完成。');
  }
  process.exitCode = failed ? 1 : 0;
}

async function main(argv: string[]): Promise<void> {
  const p = parseArgs(argv);
  const [cmd, ...args] = p.positional;
  switch (cmd) {
    case 'serve':
      return serve(config());
    case 'demo': {
      const cfg = config();
      if (cfg.app_env === 'production') {
        err('demo 只能在开发环境运行');
        process.exit(1);
      }
      return serve(cfg, { seed: true });
    }
    case 'scheduler':
      return schedulerOnly(config());
    case 'migrate': {
      const cfg = config();
      const db = Db.open(cfg.database_path);
      const applied = db.all<{ version: number; name: string; applied_at: string }>('SELECT version, name, applied_at FROM schema_migrations ORDER BY version');
      db.close();
      out(`数据库 ${cfg.database_path}`);
      for (const m of applied) out(`  v${m.version} ${m.name} (${m.applied_at})`);
      return;
    }
    case 'doctor':
      return doctor(p);
    case 'dealer': {
      const sub = args[0];
      if (sub === 'import') {
        const file = need(args[1], '<file>');
        const bundle = parseDealerBrainBundle(JSON.parse(readFileSync(file, 'utf8')));
        const counts = { dealers: bundle.dealers.length, vehicles: bundle.vehicles.length, inventory: bundle.inventory.length, offers: bundle.offers.length, knowledge: bundle.knowledge.length, accounts: bundle.accounts.length };
        if (p.flags['dry-run'] === true) {
          out(`校验通过：${JSON.stringify(counts)}`);
          return;
        }
        const inventoryMode = flagString(p, 'inventory-mode');
        const personaMode = flagString(p, 'persona-mode');
        if (inventoryMode && inventoryMode !== 'snapshot' && inventoryMode !== 'merge') throw new AppError('validation_error', '--inventory-mode 需要 snapshot|merge', 422);
        if (personaMode && personaMode !== 'seed' && personaMode !== 'overwrite') throw new AppError('validation_error', '--persona-mode 需要 seed|overwrite', 422);
        await withRuntime(config(), async (rt) => {
          const summary = importDealerBrain(rt.ctx, bundle, { inventory_mode: inventoryMode as 'snapshot' | 'merge' | undefined, persona_mode: personaMode as 'seed' | 'overwrite' | undefined });
          rt.ctx.audit.event({ actor: CLI_ACTOR, action: 'dealer_brain.imported_via_cli', entity_type: 'dealer_group', entity_id: summary.group_id, details: { file, counts: summary.counts } });
          rt.ensureSchedules();
          out(`已导入 ${bundle.group.name}：${JSON.stringify(summary.counts)}`);
          for (const [key, id] of Object.entries(summary.dealer_ids)) out(`  门店 ${key} → ${id}`);
          for (const [key, id] of Object.entries(summary.account_ids)) out(`  账号 ${key} → ${id}`);
        });
        return;
      }
      if (sub === 'export') {
        const id = need(args[1], '<dealer_id|group_id>');
        await withRuntime(config(), async (rt) => {
          const groupId = rt.ctx.db.table('dealer_groups').get(id) ? id : getDealer(rt.ctx, id).group_id;
          const json = JSON.stringify(exportDealerBrainBundle(rt.ctx, groupId), null, 2);
          const file = flagString(p, 'out');
          if (file) {
            writeFileSync(file, json);
            out(`已导出到 ${file}`);
          } else out(json);
        });
        return;
      }
      err(USAGE);
      process.exit(2);
      return;
    }
    case 'seed-demo':
      return withRuntime(config(), async (rt) => seedDemo(rt));
    case 'goal': {
      const dealerId = need(args[0], '<dealer_id>');
      const text = need(args[1], '"<目标>"');
      await withRuntime(config(), async (rt) => {
        requireReadyToRun(rt.ctx, dealerId);
        const { goal, run } = await rt.operator.submitGoal(rt.ctx, { dealer_id: dealerId, text, actor: CLI_ACTOR });
        out(`目标 ${goal.id}：${JSON.stringify(goal.spec)}`);
        const { steps } = rt.engine.getRun(rt.ctx, run.id);
        out(`运行 ${run.id} → ${run.status}${run.error ? `：${run.error}` : ''}`);
        for (const s of steps) out(`  ${s.status.padEnd(9)} ${s.step_key}${s.error ? ` — ${s.error}` : typeof s.output.reason === 'string' ? ` — ${s.output.reason}` : ''}`);
        if (run.status === 'FAILED') process.exitCode = 1;
      });
      return;
    }
    case 'run': {
      const workflow = need(args[0], '<workflow>');
      const dealerId = need(args[1], '<dealer_id>');
      await withRuntime(config(), async (rt) => {
        if (!SETUP_EXEMPT_WORKFLOWS.includes(workflow)) requireReadyToRun(rt.ctx, dealerId);
        const run = await rt.operator.runWorkflow(rt.ctx, workflow, dealerId, CLI_ACTOR);
        const { steps } = rt.engine.getRun(rt.ctx, run.id);
        out(`运行 ${run.id} ${workflow} → ${run.status}${run.error ? `：${run.error}` : ''}`);
        for (const s of steps) out(`  ${s.status.padEnd(9)} ${s.step_key}${s.error ? ` — ${s.error}` : typeof s.output.reason === 'string' ? ` — ${s.output.reason}` : ''}`);
        if (run.status === 'FAILED') process.exitCode = 1;
      });
      return;
    }
    case 'xhs-login': {
      const target = need(args[0], '<account_id|research>');
      await withRuntime(config(), async (rt) => {
        const accountId = target === 'research' ? null : target;
        const qr = await startAccountLogin(rt.ctx, accountId, CLI_ACTOR);
        if (qr.already_logged_in) {
          out(`已登录：${qr.detail}`);
          return;
        }
        if (!qr.image_data_url?.startsWith('data:image/')) {
          err(`没有拿到二维码：${qr.detail}`);
          process.exitCode = 1;
          return;
        }
        const file = flagString(p, 'out') ?? `xhs-login-${target}.png`;
        writeFileSync(file, Buffer.from(qr.image_data_url.slice(qr.image_data_url.indexOf(',') + 1), 'base64'), { mode: 0o600 });
        out(`二维码已保存到 ${file}（仅本人查看，扫码后请删除）${qr.expires_at ? `，请在 ${qr.expires_at} 前用该账号的小红书 App 扫码` : ''}`);
        out('扫码完成后运行 node src/cli.ts doctor 确认登录状态。');
      });
      return;
    }
    case 'import-content': {
      const dealerId = need(args[0], '<dealer_id>');
      const file = need(args[1], '<file>');
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      const notes = Array.isArray(raw) ? raw : (raw as { notes?: unknown }).notes;
      await withRuntime(config(), async (rt) => {
        const input = ingestInputValidator({ dealer_id: dealerId, notes, data_mode: 'import' }, 'file');
        const summary = await ingestPublicContent(rt.ctx, input);
        out(JSON.stringify({ ...summary, lead_ids: summary.lead_ids.length, public_post_ids: summary.public_post_ids.length }, null, 2));
      });
      return;
    }
    case undefined:
    case 'help':
    case '--help':
      out(USAGE);
      return;
    default:
      err(`未知命令：${cmd}\n`);
      err(USAGE);
      process.exit(2);
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    err(e instanceof AppError ? `${e.code}: ${e.message}` : describeError(e));
    process.exit(1);
  });
}
