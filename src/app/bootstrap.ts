/**
 * Process bootstrap (ARCHITECTURE §10.5): one call wires the persistent database, providers, skills, workflows,
 * scheduler and operator from a validated AppConfig.
 *
 * - Database: `Db.open` applies pending migrations; a restart reopens the same file with all data intact.
 * - Workflows interrupted by a crash/restart are marked FAILED (resumable) before anything else runs.
 * - Xiaohongshu provider: exactly what the configuration says. For `mcp`, internal account ids resolve to platform
 *   account ids and per-account endpoints may come from `xhs_accounts.mcp_endpoint_url`; bearer tokens only from env.
 *   There is no fallback to simulation.
 * - Scheduler: dealer schedules are ensured at start and on every tick (dealers imported later get their daily rhythm).
 */
import { mkdirSync } from 'node:fs';
import type { Clock } from '../core/clock.ts';
import { SystemClock } from '../core/clock.ts';
import { createLogger, type Logger } from '../core/logger.ts';
import type { WorkflowRun } from '../core/types.ts';
import { Db } from '../db/database.ts';
import { AutomotiveOperator } from '../operator/operator.ts';
import { Scheduler } from '../operator/scheduler.ts';
import { WorkflowEngine, describeError } from '../operator/workflow-engine.ts';
import { buildWorkflows, missingScheduledWorkflows } from '../operator/workflows.ts';
import { createLlmProvider, type LlmProvider } from '../providers/llm/index.ts';
import { createXhsProvider, type McpEndpointConfig, type XhsProvider, type XhsProviderConfig } from '../providers/xhs/index.ts';
import { registerAllSkills } from '../skills/index.ts';
import { SkillRegistry } from '../skills/registry.ts';
import { redactConfig, type AppConfig } from './config.ts';
import { createAppContext, type AppContext } from './context.ts';

export interface Runtime {
  config: AppConfig;
  ctx: AppContext;
  engine: WorkflowEngine;
  scheduler: Scheduler;
  operator: AutomotiveOperator;
  /** runs found RUNNING at startup and marked FAILED (interrupted, resumable) */
  recovered: WorkflowRun[];
  /** start the dealer scheduler loop (idempotent); returns stop() */
  startScheduler(): () => void;
  /** idempotently create the daily schedules of every dealer */
  ensureSchedules(): number;
  close(): Promise<void>;
}

export interface CreateRuntimeOptions {
  clock?: Clock;
  xhs?: XhsProvider;
  llm?: LlmProvider;
  logger?: Logger;
  db?: Db;
}

const CLOSE_WAIT_MS = 10_000;

function buildXhsProvider(config: AppConfig, db: Db, clock: Clock): XhsProvider {
  const cfg = config.xhs;
  if (cfg.kind === 'mcp') {
    const accountRow = (accountId: string) =>
      db.table('xhs_accounts').get(accountId) ?? db.table('xhs_accounts').findOne({ platform_account_id: accountId });
    const resolveAccount = (internalAccountId: string): string | null => db.table('xhs_accounts').get(internalAccountId)?.platform_account_id ?? null;
    const token = config.xhs_default_token ?? undefined;
    const resolveEndpoint = (accountId: string): McpEndpointConfig | null => {
      const url = accountRow(accountId)?.mcp_endpoint_url;
      if (!url) return null;
      return token ? { url, token } : { url };
    };
    const withResolvers: XhsProviderConfig = { ...cfg, resolveAccount: cfg.resolveAccount ?? resolveAccount, resolveEndpoint: cfg.resolveEndpoint ?? resolveEndpoint };
    return createXhsProvider(clock, withResolvers);
  }
  if (cfg.kind === 'simulation') {
    const options = { ...(cfg.options ?? {}) };
    if (!options.account_platform_ids) {
      const map: Record<string, string> = {};
      for (const a of db.table('xhs_accounts').findMany({})) if (a.platform_account_id) map[a.id] = a.platform_account_id;
      options.account_platform_ids = map;
    }
    return createXhsProvider(clock, { ...cfg, options });
  }
  return createXhsProvider(clock, cfg);
}

export async function createRuntime(config: AppConfig, opts: CreateRuntimeOptions = {}): Promise<Runtime> {
  const clock = opts.clock ?? opts.db?.clock ?? new SystemClock();
  const log = opts.logger ?? createLogger(config.log_level);
  if (config.database_path !== ':memory:') mkdirSync(config.data_dir, { recursive: true });
  const db = opts.db ?? Db.open(config.database_path, { clock });
  if (opts.db) db.migrate();

  let closed = false;
  try {
    const xhs = opts.xhs ?? buildXhsProvider(config, db, clock);
    const llm = opts.llm ?? createLlmProvider(config.llm_env);
    const skills = registerAllSkills(new SkillRegistry());
    const ctx = createAppContext({ db, clock, xhs, llm, skills, log });

    const workflows = buildWorkflows();
    const missing = missingScheduledWorkflows(workflows);
    if (missing.length > 0) throw new Error(`workflows missing for the daily schedule: ${missing.join(', ')}`);
    const engine = new WorkflowEngine(workflows);
    const recovered = engine.recoverInterrupted(ctx);
    const scheduler = new Scheduler(engine);
    const operator = new AutomotiveOperator(engine);

    const ensureSchedules = (): number => {
      const dealers = ctx.db.table('dealers').findMany({});
      for (const d of dealers) scheduler.ensureSchedules(ctx, d.id);
      return dealers.length;
    };
    const dealerCount = ensureSchedules();

    let timer: ReturnType<typeof setInterval> | null = null;
    let kickoff: ReturnType<typeof setTimeout> | null = null;
    let ticking: Promise<void> | null = null;
    const tick = (): Promise<void> => {
      if (ticking || closed) return ticking ?? Promise.resolve();
      ticking = (async () => {
        try {
          ensureSchedules();
          const runs = await scheduler.tick(ctx);
          if (runs.length > 0) log.info('scheduler.tick', { runs: runs.map((r) => ({ id: r.id, workflow: r.workflow, dealer_id: r.dealer_id, status: r.status })) });
        } catch (err) {
          log.error('scheduler.tick_failed', { error: describeError(err) });
        } finally {
          ticking = null;
        }
      })();
      return ticking;
    };
    const stopScheduler = () => {
      if (timer) clearInterval(timer);
      if (kickoff) clearTimeout(kickoff);
      if (timer) log.info('scheduler.stopped', {});
      timer = null;
      kickoff = null;
    };

    log.info('runtime.started', {
      app_env: config.app_env,
      database_path: config.database_path,
      xhs_provider: { name: xhs.name, mode: xhs.mode },
      llm: llm.status(),
      skills: skills.list().length,
      workflows: engine.list().map((w) => w.name),
      dealers: dealerCount,
      recovered_runs: recovered.map((r) => r.id),
      config: redactConfig(config),
    });
    for (const w of config.warnings) log.warn('config.warning', { warning: w });
    if (xhs.mode === 'simulation') log.warn('xhs.simulation_mode', { message: '小红书模拟数据模式：数据不是真实客户，仅用于测试/演示' });

    return {
      config,
      ctx,
      engine,
      scheduler,
      operator,
      recovered,
      ensureSchedules,
      startScheduler() {
        if (closed) throw new Error('runtime is closed');
        if (!timer) {
          timer = setInterval(() => void tick(), config.scheduler.interval_ms);
          timer.unref();
          kickoff = setTimeout(() => void tick(), 0);
          kickoff.unref();
          log.info('scheduler.started', { interval_ms: config.scheduler.interval_ms });
        }
        return stopScheduler;
      },
      async close() {
        if (closed) return;
        closed = true;
        stopScheduler();
        const pending = ticking as Promise<void> | null;
        if (pending) {
          await Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, CLOSE_WAIT_MS).unref())]);
        }
        db.close();
        log.info('runtime.closed', {});
      },
    };
  } catch (err) {
    closed = true;
    if (!opts.db) db.close();
    throw err;
  }
}
