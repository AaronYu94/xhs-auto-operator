/** Shared helpers for JSON API handlers. */
import type { AppContext } from '../../app/context.ts';
import { AppError, NotFoundError, ValidationError } from '../../core/errors.ts';
import type { WorkflowRun } from '../../core/types.ts';
import type { Validator } from '../../core/validate.ts';
import { describeError } from '../../operator/workflow-engine.ts';
import { queryInt, queryString, type Reply, type RequestContext } from '../http.ts';
import type { ServerRuntime } from '../runtime.ts';

export const json = (value: unknown, status = 200): Reply => ({ status, json: value });

export async function readBody<T>(rc: RequestContext, validator: Validator<T>): Promise<T> {
  return validator(await rc.json(), 'body');
}

/** `dealer_id` (or `dealer`) query parameter, verified to exist. */
export function dealerFromQuery(rc: RequestContext, ctx: AppContext): string {
  const id = queryString(rc.query, 'dealer_id') ?? queryString(rc.query, 'dealer');
  if (!id) throw new ValidationError('dealer_id', 'required');
  if (!ctx.db.table('dealers').get(id)) throw new NotFoundError('dealer', id);
  return id;
}

export function requireDealer(ctx: AppContext, id: string): string {
  if (!ctx.db.table('dealers').get(id)) throw new NotFoundError('dealer', id);
  return id;
}

export function paging(rc: RequestContext, defLimit = 50, maxLimit = 500): { limit: number; offset: number } {
  return {
    limit: queryInt(rc.query, 'limit', { min: 1, max: maxLimit }) ?? defLimit,
    offset: queryInt(rc.query, 'offset', { min: 0 }) ?? 0,
  };
}

/** Escape LIKE wildcards; use with `ESCAPE '\\'`. */
export const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Start a workflow and answer as soon as its run row exists; the run continues in the background and is observable
 * through /api/workflow-runs/:id. Validation errors before the run starts are returned to the caller. A RUNNING run
 * of the same workflow for the dealer is returned instead of starting a duplicate.
 */
export function startWorkflowInBackground(
  runtime: ServerRuntime,
  name: string,
  input: Record<string, unknown>,
  opts: { dealer_id: string | null; goal_id?: string | null; actor: string },
): Promise<WorkflowRun> {
  const { ctx, engine } = runtime;
  return new Promise<WorkflowRun>((resolve, reject) => {
    let started = false;
    engine
      .start(ctx, name, input, {
        trigger: 'api',
        dealer_id: opts.dealer_id,
        goal_id: opts.goal_id ?? null,
        actor: opts.actor,
        singleton: true,
        onStarted: (run) => {
          started = true;
          resolve(run);
        },
      })
      .then((run) => {
        if (!started) resolve(run);
      })
      .catch((err: unknown) => {
        if (!started) reject(err);
        else ctx.log.error('workflow.background_failed', { workflow: name, dealer_id: opts.dealer_id, error: describeError(err) });
      });
  });
}

/** Fire-and-forget a promise whose failure is only logged (after the HTTP response was sent). */
export function background(ctx: AppContext, label: string, work: Promise<unknown>): void {
  work.catch((err: unknown) => ctx.log.error(`${label}.failed`, { error: describeError(err) }));
}

export function requireRow<T>(row: T | undefined | null, entity: string, id: string): T {
  if (row === undefined || row === null) throw new NotFoundError(entity, id);
  return row;
}

export function conflict(code: string, message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError(code, message, 409, details);
}
