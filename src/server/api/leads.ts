/**
 * Lead inbox, lead detail and lead actions (assignment, research, qualification, do-not-contact, funnel moves,
 * won/lost), scoring configuration and the global do-not-contact list.
 */
import type { AppContext } from '../../app/context.ts';
import { ValidationError } from '../../core/errors.ts';
import {
  ACTOR_TYPES,
  DATA_MODES,
  LEAD_STAGES,
  SCORE_TIERS,
  SIGNAL_SOURCE_TYPES,
  type Lead,
  type LeadStage,
} from '../../core/types.ts';
import { v } from '../../core/validate.ts';
import { assignLead } from '../../skills/acquisition/account-assignment/index.ts';
import { rescreenLeads } from '../../skills/acquisition/lead-discovery/rescreen.ts';
import { researchLead } from '../../skills/acquisition/lead-research/index.ts';
import { getScoringConfig, updateScoringConfig } from '../../skills/acquisition/lead-scoring/index.ts';
import {
  buildLeadCard,
  getLeadDetail,
  getLeadInbox,
  type AnalyticsFilters,
  type LeadCard,
} from '../../skills/operations/analytics/index.ts';
import { recordConversion, reopenLead, suppressContact, transitionLead } from '../../skills/operations/crm/index.ts';
import { qualifyLead } from '../../skills/sales/qualification/index.ts';
import { queryEnum, queryString, type RequestContext, type Router } from '../http.ts';
import type { ServerRuntime } from '../runtime.ts';
import { json, likePattern, paging, readBody, requireDealer, requireRow } from './common.ts';

export interface LeadCardView extends LeadCard {
  data_mode: Lead['data_mode'];
  actor_type: Lead['actor_type'];
}

export interface InboxQuery {
  dealer_id: string;
  filters: AnalyticsFilters;
  tier?: (typeof SCORE_TIERS)[number];
  q?: string;
  data_mode?: (typeof DATA_MODES)[number];
  actor_type?: (typeof ACTOR_TYPES)[number];
  /** hide closed leads (LOST / WON) unless a stage was asked for explicitly; default true */
  open_only?: boolean;
  limit: number;
  offset: number;
}

const view = (ctx: AppContext, card: LeadCard, lead?: Lead): LeadCardView => {
  const row = lead ?? ctx.db.table('leads').get(card.lead_id);
  return { ...card, data_mode: row?.data_mode ?? 'unknown', actor_type: row?.actor_type ?? null };
};

/**
 * Inbox with the analytics filters plus console extras (free text, data provenance, actor type). Extras are
 * answered straight from the leads table; analytics-only filters (brand/model/location/account/source/dates) use
 * getLeadInbox. When both kinds are combined the analytics result (max 500 cards) is filtered in memory.
 */
export function leadInbox(ctx: AppContext, q: InboxQuery): LeadCardView[] {
  const f = q.filters;
  const analyticsOnly = Boolean(f.account_id || f.brand || f.model || f.location || f.source_type || f.from || f.to);
  const extras = Boolean(q.q || q.data_mode || q.actor_type);
  if (!extras) {
    return getLeadInbox(ctx, { ...f, dealer_id: q.dealer_id, tier: q.tier, open_only: q.open_only !== false, limit: q.limit, offset: q.offset }).map((c) => view(ctx, c));
  }
  if (analyticsOnly) {
    const needle = q.q?.toLowerCase();
    return getLeadInbox(ctx, { ...f, dealer_id: q.dealer_id, tier: q.tier, open_only: q.open_only !== false, limit: 500, offset: 0 })
      .map((c) => view(ctx, c))
      .filter((c) => (!q.data_mode || c.data_mode === q.data_mode) && (!q.actor_type || c.actor_type === q.actor_type))
      .filter((c) => !needle || `${c.username} ${c.original_signal} ${c.model_label} ${c.location_label}`.toLowerCase().includes(needle))
      .slice(q.offset, q.offset + q.limit);
  }
  const where: string[] = ['dealer_id = ?'];
  const params: (string | number)[] = [q.dealer_id];
  if (q.data_mode) {
    where.push('data_mode = ?');
    params.push(q.data_mode);
  }
  if (q.actor_type) {
    where.push('actor_type = ?');
    params.push(q.actor_type);
  }
  if (f.stage) {
    where.push('stage = ?');
    params.push(f.stage);
  } else if (q.open_only !== false) {
    // closed leads (e.g. the ones the LLM screen rejected) stay in the database and in the funnel stats, but the
    // inbox is the work list: they are shown only when asked for (?closed=1 or a stage filter).
    where.push("stage NOT IN ('LOST', 'WON')");
  }
  if (q.tier) {
    where.push('tier = ?');
    params.push(q.tier);
  }
  if (q.q) {
    const like = likePattern(q.q);
    where.push(
      "(username LIKE ? ESCAPE '\\' OR platform_user_id = ? OR intent LIKE ? ESCAPE '\\' OR id IN (SELECT lead_id FROM lead_signals WHERE content LIKE ? ESCAPE '\\' OR post_title LIKE ? ESCAPE '\\'))",
    );
    params.push(like, q.q, like, like, like);
  }
  const rows = ctx.db.table('leads').query(where.join(' AND '), params, { orderBy: 'score DESC, last_signal_at DESC', limit: q.limit, offset: q.offset });
  return rows.map((lead) => view(ctx, buildLeadCard(ctx, lead), lead));
}

export function inboxQueryFrom(rc: RequestContext, dealerId: string): InboxQuery {
  const { limit, offset } = paging(rc, 50, 500);
  return {
    dealer_id: dealerId,
    filters: {
      dealer_id: dealerId,
      account_id: queryString(rc.query, 'account_id'),
      brand: queryString(rc.query, 'brand'),
      model: queryString(rc.query, 'model'),
      location: queryString(rc.query, 'location'),
      from: queryString(rc.query, 'from'),
      to: queryString(rc.query, 'to'),
      source_type: queryEnum(rc.query, 'source_type', SIGNAL_SOURCE_TYPES),
      stage: queryEnum(rc.query, 'stage', LEAD_STAGES),
    },
    tier: queryEnum(rc.query, 'tier', SCORE_TIERS),
    q: queryString(rc.query, 'q', 100),
    data_mode: queryEnum(rc.query, 'data_mode', DATA_MODES),
    actor_type: queryEnum(rc.query, 'actor_type', ACTOR_TYPES),
    open_only: queryString(rc.query, 'closed') !== '1',
    limit,
    offset,
  };
}

const reasonBody = v.object({ reason: v.string({ min: 1, max: 300 }) });
const rescreenBody = v.object({
  dealer_id: v.string({ min: 1 }),
  limit: v.optional(v.number({ int: true, min: 1, max: 1000 })),
  apply_area: v.optional(v.boolean()),
});
const assignBody = v.object({ reassign_to: v.optional(v.string({ min: 1, max: 80 })), reason: v.optional(v.string({ max: 300 })) });
const reopenBody = v.object({ to: v.literal(['CANDIDATE', 'QUALIFIED'] as const), reason: v.string({ min: 1, max: 300 }) });
const stageBody = v.object({ to: v.literal(LEAD_STAGES), reason: v.string({ min: 1, max: 300 }) });
const wonBody = v.object({ amount: v.optional(v.number({ int: true, min: 0, max: 100_000_000 })), vehicle_id: v.optional(v.string({ min: 1 })) });
const dncBody = v.object({ platform_user_id: v.string({ min: 1, max: 120 }), reason: v.string({ min: 1, max: 300 }) });
const scoringBody = v.object({ weights: v.optional(v.record(v.number({ min: 0, max: 100 }))), thresholds: v.optional(v.record(v.number({ min: 0, max: 100 }))) });

export function registerLeadRoutes(router: Router, runtime: ServerRuntime): void {
  const { ctx } = runtime;
  const lead = (id: string) => requireRow(ctx.db.table('leads').get(id), 'lead', id);

  router.get('/api/leads', (rc) => {
    const dealerId = requireDealer(ctx, queryString(rc.query, 'dealer_id') ?? queryString(rc.query, 'dealer') ?? '');
    const q = inboxQueryFrom(rc, dealerId);
    return json({ leads: leadInbox(ctx, q), limit: q.limit, offset: q.offset });
  });

  router.get('/api/leads/:id', (rc) => {
    const detail = getLeadDetail(ctx, rc.params.id);
    return json({ ...detail, data_mode: detail.lead.data_mode ?? 'unknown', actor_type: detail.lead.actor_type ?? null });
  });

  router.post('/api/leads/:id/assign', async (rc) => {
    lead(rc.params.id);
    const input = await readBody(rc, assignBody);
    const result = assignLead(ctx, rc.params.id, { reassign_to: input.reassign_to, reason: input.reason, actor: rc.actor });
    return json(result);
  });

  // maintenance: re-check open leads made before the LLM screen (closes owners / dealers / chatter, never deletes)
  router.post('/api/leads/rescreen', async (rc) => {
    const input = await readBody(rc, rescreenBody);
    return json(await rescreenLeads(ctx, input), 200);
  });

  router.post('/api/leads/:id/research', async (rc) => {
    lead(rc.params.id);
    return json(await researchLead(ctx, rc.params.id));
  });

  router.post('/api/leads/:id/qualify', (rc) => {
    lead(rc.params.id);
    return json(qualifyLead(ctx, rc.params.id));
  });

  router.post('/api/leads/:id/suppress', async (rc) => {
    const row = lead(rc.params.id);
    const { reason } = await readBody(rc, reasonBody);
    const result = suppressContact(ctx, { platform_user_id: row.platform_user_id, reason, source: rc.actor, actor: rc.actor });
    return json(result);
  });

  router.post('/api/leads/:id/stage', async (rc) => {
    lead(rc.params.id);
    const input = await readBody(rc, stageBody);
    if (input.to === 'WON' || input.to === 'LOST') throw new ValidationError('to', 'use /won or /lost to record the outcome');
    return json(transitionLead(ctx, rc.params.id, input.to as LeadStage, { reason: input.reason, actor: rc.actor }));
  });

  router.post('/api/leads/:id/lost', async (rc) => {
    lead(rc.params.id);
    const { reason } = await readBody(rc, reasonBody);
    return json({ conversion: recordConversion(ctx, { lead_id: rc.params.id, outcome: 'lost', lost_reason: reason, actor: rc.actor }) });
  });

  router.post('/api/leads/:id/won', async (rc) => {
    lead(rc.params.id);
    const input = await readBody(rc, wonBody);
    return json({ conversion: recordConversion(ctx, { lead_id: rc.params.id, outcome: 'won', amount: input.amount, vehicle_id: input.vehicle_id, actor: rc.actor }) });
  });

  router.post('/api/leads/:id/reopen', async (rc) => {
    lead(rc.params.id);
    const input = await readBody(rc, reopenBody);
    return json({ lead: reopenLead(ctx, rc.params.id, input.to, { reason: input.reason, actor: rc.actor }) });
  });

  router.get('/api/dnc', (rc) => {
    const { limit, offset } = paging(rc, 100, 500);
    const q = queryString(rc.query, 'q', 120);
    const rows = q
      ? ctx.db.table('contact_suppressions').query("platform_user_id LIKE ? ESCAPE '\\' OR reason LIKE ? ESCAPE '\\'", [likePattern(q), likePattern(q)], { orderBy: 'created_at DESC', limit, offset })
      : ctx.db.table('contact_suppressions').findMany({}, { orderBy: 'created_at DESC', limit, offset });
    return json({ suppressions: rows, total: ctx.db.table('contact_suppressions').count() });
  });

  router.post('/api/dnc', async (rc) => {
    const input = await readBody(rc, dncBody);
    return json(suppressContact(ctx, { platform_user_id: input.platform_user_id, reason: input.reason, source: rc.actor, actor: rc.actor }), 201);
  });

  router.get('/api/scoring/:dealerId', (rc) => json({ config: getScoringConfig(ctx, requireDealer(ctx, rc.params.dealerId)) }));

  router.put('/api/scoring/:dealerId', async (rc) => {
    const dealerId = requireDealer(ctx, rc.params.dealerId);
    const input = await readBody(rc, scoringBody);
    return json({ config: updateScoringConfig(ctx, dealerId, { weights: input.weights, thresholds: input.thresholds }, rc.actor) });
  });
}
