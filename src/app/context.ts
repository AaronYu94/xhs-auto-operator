import { AuditLog } from '../audit/audit.ts';
import type { Clock } from '../core/clock.ts';
import { SystemClock } from '../core/clock.ts';
import type { Logger } from '../core/logger.ts';
import { silentLogger } from '../core/logger.ts';
import { Db } from '../db/database.ts';
import { DisabledLlmProvider, type LlmProvider } from '../providers/llm/types.ts';
import type { XhsProvider } from '../providers/xhs/types.ts';
import { UnavailableXhsProvider } from '../providers/xhs/unavailable.ts';
import { SkillRegistry } from '../skills/registry.ts';

/**
 * Everything a skill needs. Passed explicitly (no globals) so every module is testable with an
 * in-memory database, a manual clock and test providers.
 */
export interface AppContext {
  db: Db;
  clock: Clock;
  audit: AuditLog;
  xhs: XhsProvider;
  llm: LlmProvider;
  skills: SkillRegistry;
  log: Logger;
  /** workflow run currently executing (decisions/audit are stamped with it) */
  runId: string | null;
}

export interface CreateContextOptions {
  dbPath?: string;
  db?: Db;
  clock?: Clock;
  xhs?: XhsProvider;
  llm?: LlmProvider;
  skills?: SkillRegistry;
  log?: Logger;
}

export function createAppContext(opts: CreateContextOptions = {}): AppContext {
  const clock = opts.clock ?? opts.db?.clock ?? new SystemClock();
  const db = opts.db ?? Db.open(opts.dbPath ?? ':memory:', { clock });
  return {
    db,
    clock,
    audit: new AuditLog(db),
    xhs: opts.xhs ?? new UnavailableXhsProvider(clock),
    llm: opts.llm ?? new DisabledLlmProvider(),
    skills: opts.skills ?? new SkillRegistry(),
    log: opts.log ?? silentLogger,
    runId: null,
  };
}

/** Derive a context bound to a workflow run (audit decisions stamped with runId). */
export function withRun(ctx: AppContext, runId: string | null): AppContext {
  return { ...ctx, runId, audit: ctx.audit.withRun(runId) };
}
