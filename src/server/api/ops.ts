/**
 * Operations API: analytics, search intelligence, research briefs, workflows & schedules, audit trail, operator
 * reports, optimization, appointments and real public-content import.
 */
import { AppError, ValidationError } from '../../core/errors.ts';
import { LEAD_STAGES, RESEARCH_KINDS, SIGNAL_SOURCE_TYPES, WORKFLOW_STATUSES, type AppointmentStatus, type WorkflowStatus } from '../../core/types.ts';
import { v } from '../../core/validate.ts';
import { SETUP_EXEMPT_WORKFLOWS, requireReadyToRun } from '../../operator/onboarding.ts';
import { RESUMABLE_STATUSES } from '../../operator/workflow-engine.ts';
import {
  evolveQueries,
  generateQueries,
  getQueryEffectiveness,
  goalSpecValidator,
} from '../../skills/acquisition/automotive-query-generation/index.ts';
import { ingestInputValidator, ingestPublicContent } from '../../skills/acquisition/lead-discovery/index.ts';
import {
  getAccountsOverview,
  getContentAttribution,
  getDashboard,
  getFunnel,
  type AnalyticsFilters,
} from '../../skills/operations/analytics/index.ts';
import { runOptimization } from '../../skills/operations/optimization/index.ts';
import { generateOperatorReport, getLatestReport, latestCapabilityBlocks } from '../../skills/operations/reporting/index.ts';
import {
  cancelAppointment,
  confirmAppointment,
  listAppointments,
  markNoShow,
  markVisited,
} from '../../skills/sales/appointment/index.ts';
import { queryEnum, queryString, type RequestContext, type Router } from '../http.ts';
import type { ServerRuntime } from '../runtime.ts';
import { background, dealerFromQuery, json, paging, readBody, requireDealer, requireRow, startWorkflowInBackground } from './common.ts';

export function analyticsFilters(rc: RequestContext, dealerId: string): AnalyticsFilters {
  return {
    dealer_id: dealerId,
    account_id: queryString(rc.query, 'account_id'),
    brand: queryString(rc.query, 'brand'),
    model: queryString(rc.query, 'model'),
    location: queryString(rc.query, 'location'),
    from: queryString(rc.query, 'from'),
    to: queryString(rc.query, 'to'),
    source_type: queryEnum(rc.query, 'source_type', SIGNAL_SOURCE_TYPES),
    stage: queryEnum(rc.query, 'stage', LEAD_STAGES),
  };
}

const APPOINTMENT_STATUS_VALUES = ['proposed', 'confirmed', 'visited', 'no_show', 'cancelled'] as const;

const runBody = v.object({ dealer_id: v.string({ min: 1 }), input: v.optional(v.record(v.unknown())) });
const reasonBody = v.object({ reason: v.string({ min: 1, max: 300 }) });
const confirmBody = v.object({ scheduled_for: v.optional(v.string({ min: 10, max: 40 })) });
const generateBody = v.object({ dealer_id: v.string({ min: 1 }), goal: goalSpecValidator, goal_id: v.optional(v.nullable(v.string({ min: 1 }))) });
const dealerBody = v.object({ dealer_id: v.string({ min: 1 }) });
const scheduleBody = v.object({ enabled: v.boolean() });

export function registerOpsRoutes(router: Router, runtime: ServerRuntime): void {
  const { ctx, engine, scheduler } = runtime;

  // ── analytics ───────────────────────────────────────────────────────────────
  router.get('/api/dashboard', (rc) => json(getDashboard(ctx, analyticsFilters(rc, dealerFromQuery(rc, ctx)))));
  router.get('/api/funnel', (rc) => json({ funnel: getFunnel(ctx, analyticsFilters(rc, dealerFromQuery(rc, ctx))) }));
  router.get('/api/attribution', (rc) => json({ rows: getContentAttribution(ctx, analyticsFilters(rc, dealerFromQuery(rc, ctx))) }));
  router.get('/api/accounts/overview', (rc) => json({ accounts: getAccountsOverview(ctx, dealerFromQuery(rc, ctx)) }));

  // ── search intelligence ─────────────────────────────────────────────────────
  router.get('/api/queries', (rc) => {
    const dealerId = dealerFromQuery(rc, ctx);
    return json({ queries: getQueryEffectiveness(ctx, dealerId, { from: queryString(rc.query, 'from'), to: queryString(rc.query, 'to') }) });
  });
  router.post('/api/queries/generate', async (rc) => {
    const input = await readBody(rc, generateBody);
    requireDealer(ctx, input.dealer_id);
    return json({ queries: generateQueries(ctx, { dealer_id: input.dealer_id, goal: input.goal, goal_id: input.goal_id ?? null }) }, 201);
  });
  router.post('/api/queries/evolve', async (rc) => {
    const { dealer_id } = await readBody(rc, dealerBody);
    return json(evolveQueries(ctx, requireDealer(ctx, dealer_id)));
  });

  router.get('/api/research', (rc) => {
    const dealerId = dealerFromQuery(rc, ctx);
    const kind = queryEnum(rc.query, 'kind', RESEARCH_KINDS);
    const { limit, offset } = paging(rc, 20, 200);
    return json({ briefs: ctx.db.table('research_briefs').findMany({ dealer_id: dealerId, kind }, { orderBy: 'created_at DESC', limit, offset }) });
  });

  // ── public content import (real content exported from Xiaohongshu tooling) ─
  router.post('/api/public-content/import', async (rc) => {
    const raw = (await rc.json()) as Record<string, unknown>;
    const input = ingestInputValidator({ ...raw, data_mode: raw?.data_mode ?? 'import' }, 'body');
    if (input.data_mode === 'simulation' || input.data_mode === 'live') {
      throw new ValidationError('data_mode', 'imports are labelled import or manual; live data only comes from a live provider');
    }
    requireDealer(ctx, input.dealer_id);
    return json(await ingestPublicContent(ctx, input), 201);
  });

  // ── workflows & schedules ───────────────────────────────────────────────────
  router.get('/api/workflows', () => json({ workflows: engine.list().map((d) => ({ name: d.name, description: d.description })) }));

  router.get('/api/workflow-runs', (rc) => {
    const dealerId = queryString(rc.query, 'dealer_id');
    const statusRaw = queryString(rc.query, 'status');
    const status = statusRaw ? (statusRaw.split(',') as WorkflowStatus[]) : undefined;
    if (status) for (const s of status) if (!WORKFLOW_STATUSES.includes(s)) throw new ValidationError('status', `unknown status ${s}`);
    return json({ runs: engine.listRuns(ctx, { dealer_id: dealerId, workflow: queryString(rc.query, 'workflow'), status, limit: paging(rc, 50, 500).limit }) });
  });

  router.get('/api/workflow-runs/:id', (rc) => json(engine.getRun(ctx, rc.params.id)));

  router.post('/api/workflows/:name/run', async (rc) => {
    const input = await readBody(rc, runBody);
    requireDealer(ctx, input.dealer_id);
    if (!SETUP_EXEMPT_WORKFLOWS.includes(rc.params.name)) requireReadyToRun(ctx, input.dealer_id);
    const run = await startWorkflowInBackground(runtime, rc.params.name, { dealer_id: input.dealer_id, ...(input.input ?? {}) }, {
      dealer_id: input.dealer_id,
      actor: rc.actor,
    });
    return json({ run }, 202);
  });

  router.post('/api/workflow-runs/:id/resume', (rc) => {
    const { run } = engine.getRun(ctx, rc.params.id);
    if (engine.isExecuting(run.id)) throw new AppError('workflow_already_running', '该任务正在运行中', 409);
    if (run.status === 'SUCCEEDED') return json({ run });
    if (!RESUMABLE_STATUSES.includes(run.status)) throw new AppError('workflow_not_resumable', `状态为 ${run.status} 的任务不能恢复`, 409);
    background(ctx, 'workflow.resume', engine.resume(ctx, run.id, { actor: rc.actor }));
    return json({ run: { ...run, status: 'RUNNING' } }, 202);
  });

  router.post('/api/workflow-runs/:id/cancel', async (rc) => {
    const { reason } = await readBody(rc, reasonBody);
    return json({ run: engine.cancel(ctx, rc.params.id, { actor: rc.actor, reason }) });
  });

  router.get('/api/schedules', (rc) => json({ schedules: scheduler.listSchedules(ctx, { dealer_id: queryString(rc.query, 'dealer_id') }) }));

  router.patch('/api/schedules/:id', async (rc) => {
    const { enabled } = await readBody(rc, scheduleBody);
    return json({ schedule: scheduler.setEnabled(ctx, rc.params.id, enabled, rc.actor) });
  });

  // ── audit ───────────────────────────────────────────────────────────────────
  router.get('/api/decisions', (rc) => {
    const { limit, offset } = paging(rc, 50, 500);
    const rows = ctx.db.table('agent_decisions').findMany(
      {
        subject_type: queryString(rc.query, 'subject_type'),
        subject_id: queryString(rc.query, 'subject_id'),
        decision_type: queryString(rc.query, 'decision_type') as never,
        agent: queryString(rc.query, 'agent'),
        workflow_run_id: queryString(rc.query, 'workflow_run_id'),
      },
      { orderBy: 'created_at DESC', limit, offset },
    );
    return json({ decisions: rows });
  });

  router.get('/api/events', (rc) => {
    const { limit, offset } = paging(rc, 50, 500);
    const rows = ctx.db.table('audit_events').findMany(
      { entity_type: queryString(rc.query, 'entity_type'), entity_id: queryString(rc.query, 'entity_id'), action: queryString(rc.query, 'action'), actor: queryString(rc.query, 'actor') },
      { orderBy: 'created_at DESC', limit, offset },
    );
    return json({ events: rows });
  });

  // ── capabilities (snapshots; live probes go through account sessions) ──────
  router.get('/api/capabilities/latest', (rc) => json(latestCapabilityBlocks(ctx, dealerFromQuery(rc, ctx))));

  router.get('/api/capabilities', async (rc) => {
    const accountId = queryString(rc.query, 'account_id') ?? null;
    if (accountId) requireRow(ctx.db.table('xhs_accounts').get(accountId), 'xhs_account', accountId);
    return json({ report: await ctx.xhs.capabilities(accountId), llm: ctx.llm.status() });
  });

  // ── reports & optimization ──────────────────────────────────────────────────
  router.get('/api/reports/:dealerId', (rc) => json({ report: getLatestReport(ctx, requireDealer(ctx, rc.params.dealerId), queryString(rc.query, 'date')) }));
  router.post('/api/reports/:dealerId', (rc) => json({ report: generateOperatorReport(ctx, requireDealer(ctx, rc.params.dealerId), queryString(rc.query, 'date')) }, 201));
  router.post('/api/optimization/:dealerId', async (rc) => json(await runOptimization(ctx, requireDealer(ctx, rc.params.dealerId))));

  // ── appointments ────────────────────────────────────────────────────────────
  router.get('/api/appointments', (rc) => {
    const dealerId = dealerFromQuery(rc, ctx);
    const statusRaw = queryString(rc.query, 'status');
    const status = statusRaw ? (statusRaw.split(',') as AppointmentStatus[]) : undefined;
    if (status) for (const s of status) if (!(APPOINTMENT_STATUS_VALUES as readonly string[]).includes(s)) throw new ValidationError('status', `unknown status ${s}`);
    return json({ appointments: listAppointments(ctx, { dealer_id: dealerId, status, from: queryString(rc.query, 'from'), to: queryString(rc.query, 'to'), limit: paging(rc, 100, 500).limit }) });
  });
  router.post('/api/appointments/:id/confirm', async (rc) => {
    const { scheduled_for } = await readBody(rc, confirmBody);
    return json({ appointment: confirmAppointment(ctx, rc.params.id, rc.actor, scheduled_for) });
  });
  router.post('/api/appointments/:id/visited', (rc) => json({ appointment: markVisited(ctx, rc.params.id, rc.actor) }));
  router.post('/api/appointments/:id/no-show', (rc) => json({ appointment: markNoShow(ctx, rc.params.id, rc.actor) }));
  router.post('/api/appointments/:id/cancel', async (rc) => {
    const { reason } = await readBody(rc, reasonBody);
    return json({ appointment: cancelAppointment(ctx, rc.params.id, rc.actor, reason) });
  });
}
