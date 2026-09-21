import type { AppContext } from '../../../app/context.ts';
import { NotFoundError, PolicyError, ValidationError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import { DEFAULT_TZ, daysBetween, localParts } from '../../../core/time.ts';
import {
  LEAD_STAGES,
  PLATFORMS,
  type AgentDecision,
  type Appointment,
  type AuditEvent,
  type ContactSuppression,
  type Conversion,
  type Lead,
  type LeadStage,
  type LeadStageTransition,
  type Outreach,
  type OutreachStatus,
  type Platform,
} from '../../../core/types.ts';
import { v, type Infer, type Validator } from '../../../core/validate.ts';
import { defineSkill } from '../../registry.ts';

/**
 * CRM: funnel state machine (ARCHITECTURE §4), global do-not-contact suppression (spec §24),
 * conversions with attribution, and the recommended next action shown on every lead card.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Funnel constants
// ─────────────────────────────────────────────────────────────────────────────

export const STAGE_INDEX = Object.fromEntries(LEAD_STAGES.map((stage, i) => [stage, i])) as Record<LeadStage, number>;

export const STAGE_WIN_PROBABILITY: Record<LeadStage, number> = {
  DISCOVERED: 0,
  CANDIDATE: 0.01,
  QUALIFIED: 0.02,
  ASSIGNED: 0.03,
  OUTREACH_READY: 0.03,
  CONTACTED: 0.05,
  REPLIED: 0.1,
  SALES_QUALIFIED: 0.2,
  CONTACT_ACQUIRED: 0.3,
  APPOINTMENT: 0.4,
  VISITED: 0.55,
  NEGOTIATING: 0.7,
  WON: 1,
  LOST: 0,
};

export const TERMINAL_STAGES: readonly LeadStage[] = ['WON', 'LOST'];
export const REOPEN_TARGETS = ['CANDIDATE', 'QUALIFIED'] as const;
export type ReopenTarget = (typeof REOPEN_TARGETS)[number];

export const SUPPRESSION_NEXT_ACTION = '勿扰：已停止所有触达';
export const DO_NOT_CONTACT_REASON_PREFIX = 'do_not_contact';

const DEFAULT_ACTOR = 'agent:crm-agent';
const DEFAULT_LOST_REASON = '未说明原因';
/** not-yet-delivered outreach that could still reach the user (FAILED can be retried or sent manually) */
const PENDING_OUTREACH: OutreachStatus[] = ['DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'FAILED'];
const SENT_OUTREACH: OutreachStatus[] = ['SENT', 'SENT_MANUALLY'];
const PENDING_ENGAGEMENT_REPLY = ['DRAFT', 'READY_FOR_REVIEW', 'APPROVED'] as const;
const DEFAULT_FOLLOW_UP_AFTER_DAYS = 2;
const DEFAULT_MAX_UNANSWERED_TOUCHES = 2;
const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];

export function isTerminalStage(stage: LeadStage): boolean {
  return stage === 'WON' || stage === 'LOST';
}

/** True when `stage` is a non-LOST stage at least as deep as `min` (WON counts as deepest). */
export function stageAtLeast(stage: LeadStage, min: LeadStage): boolean {
  if (stage === 'LOST') return min === 'LOST';
  return STAGE_INDEX[stage] >= STAGE_INDEX[min];
}

type TransitionVerdict = { kind: 'change' } | { kind: 'noop' } | { kind: 'invalid'; message: string };

/**
 * Funnel rules:
 * - same stage → no-op
 * - WON is terminal: WON→LOST invalid, any other request is already passed → no-op
 * - LOST is left only via reopenLead: LOST→WON invalid, any other request → no-op
 * - non-terminal → LOST: change
 * - non-terminal → WON: change only from CONTACTED or deeper, otherwise invalid
 * - non-terminal → deeper non-terminal: change; shallower: already passed → no-op
 */
function evaluateTransition(from: LeadStage, to: LeadStage): TransitionVerdict {
  if (from === to) return { kind: 'noop' };
  if (from === 'WON') {
    return to === 'LOST'
      ? { kind: 'invalid', message: 'WON is terminal: a won lead cannot be marked LOST' }
      : { kind: 'noop' };
  }
  if (from === 'LOST') {
    return to === 'WON'
      ? { kind: 'invalid', message: 'LOST lead must be reopened by an operator before it can be WON' }
      : { kind: 'noop' };
  }
  if (to === 'LOST') return { kind: 'change' };
  if (to === 'WON') {
    return STAGE_INDEX[from] >= STAGE_INDEX.CONTACTED
      ? { kind: 'change' }
      : { kind: 'invalid', message: `WON requires the lead to be CONTACTED or deeper (current stage ${from})` };
  }
  return STAGE_INDEX[to] > STAGE_INDEX[from] ? { kind: 'change' } : { kind: 'noop' };
}

/** True when moving `from` → `to` performs a real stage change under the funnel rules. */
export function canTransition(from: LeadStage, to: LeadStage): boolean {
  if (!isLeadStage(from) || !isLeadStage(to)) return false;
  return evaluateTransition(from, to).kind === 'change';
}

function isLeadStage(value: unknown): value is LeadStage {
  return typeof value === 'string' && (LEAD_STAGES as readonly string[]).includes(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

export interface TransitionMeta {
  reason: string;
  actor: string;
}

function normalizeMeta(meta: TransitionMeta): TransitionMeta {
  if (!meta || typeof meta !== 'object') throw new ValidationError('meta', 'expected {reason, actor}');
  if (typeof meta.actor !== 'string' || meta.actor.trim() === '')
    throw new ValidationError('meta.actor', 'actor is required');
  if (meta.reason !== undefined && meta.reason !== null && typeof meta.reason !== 'string')
    throw new ValidationError('meta.reason', 'expected string');
  return { reason: (meta.reason ?? '').trim(), actor: meta.actor.trim() };
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(path, 'required non-empty string');
  return value.trim();
}

function requireLead(ctx: AppContext, leadId: string): Lead {
  const lead = ctx.db.table('leads').get(leadId);
  if (!lead) throw new NotFoundError('lead', leadId);
  return lead;
}

function latestOutreach(ctx: AppContext, leadId: string): Outreach | undefined {
  const row = ctx.db.get('SELECT * FROM outreach WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', leadId);
  return row ? ctx.db.table('outreach').decode(row) : undefined;
}

function latestSentOutreach(ctx: AppContext, leadId: string): Outreach | undefined {
  const row = ctx.db.get(
    `SELECT * FROM outreach WHERE lead_id = ? AND status IN ('SENT', 'SENT_MANUALLY') AND sent_at IS NOT NULL
     ORDER BY sent_at DESC, rowid DESC LIMIT 1`,
    leadId,
  );
  return row ? ctx.db.table('outreach').decode(row) : undefined;
}

/**
 * Apply a validated stage change. MUST run inside ctx.db.tx: writes the transition row, updates the
 * lead (stage, lost_reason, next_action) and records `lead.stage_changed`.
 */
function applyStageChange(
  ctx: AppContext,
  lead: Lead,
  to: LeadStage,
  meta: TransitionMeta,
  extra: { details?: Record<string, unknown>; patch?: Partial<Lead> } = {},
): { lead: Lead; transition: LeadStageTransition } {
  const patch: Partial<Lead> = { ...extra.patch, stage: to };
  if (to === 'LOST') patch.lost_reason = meta.reason || lead.lost_reason || DEFAULT_LOST_REASON;
  patch.next_action = computeNextAction(ctx, { ...lead, ...patch });

  const transition = ctx.db.table('lead_stage_transitions').insert({
    id: newId('trn'),
    lead_id: lead.id,
    from_stage: lead.stage,
    to_stage: to,
    reason: meta.reason,
    actor: meta.actor,
    at: ctx.clock.iso(),
  });
  const updated = ctx.db.table('leads').update(lead.id, patch);
  ctx.audit.event({
    actor: meta.actor,
    action: 'lead.stage_changed',
    entity_type: 'lead',
    entity_id: lead.id,
    details: { from: lead.stage, to, reason: meta.reason, transition_id: transition.id, ...extra.details },
  });
  return { lead: updated, transition };
}

// ─────────────────────────────────────────────────────────────────────────────
// Transitions
// ─────────────────────────────────────────────────────────────────────────────

export function transitionLead(
  ctx: AppContext,
  leadId: string,
  to: LeadStage,
  meta: TransitionMeta,
): { lead: Lead; changed: boolean; transition: LeadStageTransition | null } {
  if (!isLeadStage(to)) throw new ValidationError('to', `unknown lead stage ${JSON.stringify(to)}`);
  const m = normalizeMeta(meta);
  return ctx.db.tx(() => {
    const lead = requireLead(ctx, leadId);
    const verdict = evaluateTransition(lead.stage, to);
    if (verdict.kind === 'noop') return { lead, changed: false, transition: null };
    if (verdict.kind === 'invalid')
      throw new PolicyError('invalid_transition', verdict.message, { lead_id: lead.id, from: lead.stage, to });
    if (!isTerminalStage(to)) {
      // A do-not-contact user never re-enters the funnel (a lead created after the suppression, in any group).
      const suppression = isSuppressed(ctx, lead.platform_user_id, lead.platform);
      if (lead.suppressed || suppression)
        throw new PolicyError(
          'contact_suppressed',
          'contact is on the do-not-contact list: the lead can only be moved to LOST (run suppressContact to apply the cascade)',
          { lead_id: lead.id, from: lead.stage, to, suppression_id: suppression?.id ?? null },
        );
    }
    const res = applyStageChange(ctx, lead, to, m);
    return { lead: res.lead, changed: true, transition: res.transition };
  });
}

/** Re-open a LOST lead. Only an operator may do this, and never for a suppressed (do-not-contact) user. */
export function reopenLead(ctx: AppContext, leadId: string, to: ReopenTarget, meta: TransitionMeta): Lead {
  if (!(REOPEN_TARGETS as readonly string[]).includes(to))
    throw new ValidationError('to', 'reopen target must be CANDIDATE or QUALIFIED');
  const m = normalizeMeta(meta);
  return ctx.db.tx(() => {
    const lead = requireLead(ctx, leadId);
    if (!m.actor.startsWith('operator:') || m.actor.length <= 'operator:'.length)
      throw new PolicyError('operator_required', 'only an operator (actor "operator:<name>") can reopen a lead', {
        lead_id: lead.id,
        actor: m.actor,
      });
    if (lead.stage !== 'LOST')
      throw new PolicyError('invalid_transition', `only LOST leads can be reopened (current stage ${lead.stage})`, {
        lead_id: lead.id,
        from: lead.stage,
        to,
      });
    const suppression = isSuppressed(ctx, lead.platform_user_id, lead.platform);
    if (lead.suppressed || suppression)
      throw new PolicyError('contact_suppressed', 'lead is on the do-not-contact list and cannot be reopened', {
        lead_id: lead.id,
        suppression_id: suppression?.id ?? null,
      });
    return applyStageChange(ctx, lead, to, m, {
      details: { reopened: true, previous_lost_reason: lead.lost_reason },
      patch: { lost_reason: null },
    }).lead;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Do-not-contact suppression (global across every group, dealer and account)
// ─────────────────────────────────────────────────────────────────────────────

export function isSuppressed(
  ctx: AppContext,
  platformUserId: string,
  platform: Platform = 'xiaohongshu',
): ContactSuppression | null {
  if (typeof platformUserId !== 'string' || platformUserId === '') return null;
  return ctx.db.table('contact_suppressions').findOne({ platform, platform_user_id: platformUserId }) ?? null;
}

export interface SuppressContactInput {
  platform_user_id: string;
  reason: string;
  source: string;
  actor: string;
  platform?: Platform;
}

export interface SuppressContactResult {
  suppression: ContactSuppression;
  /** true when this call created the suppression; false when it already existed */
  created: boolean;
  /** leads modified by this call (flagged suppressed, moved to LOST and/or next action refreshed) */
  leads_updated: string[];
  outreach_cancelled: string[];
  conversations_closed: string[];
  messages_discarded: string[];
  engagement_replies_cancelled: string[];
}

/**
 * Put a platform user on the global do-not-contact list and cascade immediately, in one transaction:
 * every lead of that user in ANY group is flagged and moved to LOST (WON leads keep their stage),
 * pending outreach (DRAFT / READY_FOR_REVIEW / APPROVED) is cancelled, open conversations are closed,
 * draft replies discarded and pending public engagement replies to the user's comments cancelled.
 * Idempotent: a repeated call returns the existing suppression and re-applies the cascade to anything
 * created since (e.g. a lead in another group).
 */
export function suppressContact(ctx: AppContext, input: SuppressContactInput): SuppressContactResult {
  // platform ids are opaque: validate but never normalize, so isSuppressed(id) finds exactly what was stored
  requireString(input?.platform_user_id, 'platform_user_id');
  const platformUserId = input.platform_user_id;
  const reason = requireString(input.reason, 'reason');
  const source = requireString(input.source, 'source');
  const actor = requireString(input.actor, 'actor');
  const platform = input.platform ?? 'xiaohongshu';
  if (!(PLATFORMS as readonly string[]).includes(platform)) throw new ValidationError('platform', 'unknown platform');

  return ctx.db.tx(() => {
    const now = ctx.clock.iso();
    const existing = isSuppressed(ctx, platformUserId, platform);
    const suppression =
      existing ??
      ctx.db.table('contact_suppressions').insert({
        id: newId('sup'),
        platform,
        platform_user_id: platformUserId,
        reason,
        source,
        created_at: now,
      });
    const lostReason = `${DO_NOT_CONTACT_REASON_PREFIX}: ${suppression.reason}`;
    const cancelReason = lostReason;

    const leads = ctx.db
      .table('leads')
      .findMany({ platform, platform_user_id: platformUserId }, { orderBy: 'created_at ASC' });
    const leadIds = leads.map((l) => l.id);
    const leadsUpdated = new Set<string>();

    for (const original of leads) {
      let lead = original;
      if (!lead.suppressed || lead.suppression_reason !== suppression.reason) {
        lead = ctx.db.table('leads').update(lead.id, { suppressed: true, suppression_reason: suppression.reason });
        leadsUpdated.add(lead.id);
        ctx.audit.event({
          actor,
          action: 'lead.suppressed',
          entity_type: 'lead',
          entity_id: lead.id,
          details: { suppression_id: suppression.id, reason: suppression.reason, source: suppression.source },
        });
      }
      if (!isTerminalStage(lead.stage)) {
        applyStageChange(ctx, lead, 'LOST', { reason: lostReason, actor }, { details: { suppression_id: suppression.id } });
        leadsUpdated.add(lead.id);
      }
    }

    const outreachCancelled: string[] = [];
    for (const o of ctx.db
      .table('outreach')
      .findMany({ lead_id: leadIds, status: PENDING_OUTREACH }, { orderBy: 'created_at ASC' })) {
      ctx.db.table('outreach').update(o.id, { status: 'CANCELLED', blocked_reason: cancelReason });
      outreachCancelled.push(o.id);
      ctx.audit.event({
        actor,
        action: 'outreach.cancelled',
        entity_type: 'outreach',
        entity_id: o.id,
        details: { lead_id: o.lead_id, previous_status: o.status, reason: cancelReason, suppression_id: suppression.id },
      });
    }

    const conversations = ctx.db.table('conversations').findMany({ lead_id: leadIds }, { orderBy: 'created_at ASC' });
    const conversationsClosed: string[] = [];
    for (const c of conversations) {
      if (c.status === 'closed') continue;
      ctx.db.table('conversations').update(c.id, { status: 'closed', needs_human: false, handoff_reason: 'do_not_contact' });
      conversationsClosed.push(c.id);
      ctx.audit.event({
        actor,
        action: 'conversation.closed',
        entity_type: 'conversation',
        entity_id: c.id,
        details: { lead_id: c.lead_id, previous_status: c.status, reason: 'do_not_contact', suppression_id: suppression.id },
      });
    }

    const messagesDiscarded: string[] = [];
    const drafts = ctx.db
      .table('conversation_messages')
      .findMany({ conversation_id: conversations.map((c) => c.id), status: 'draft' }, { orderBy: 'created_at ASC' });
    for (const msg of drafts) {
      ctx.db.table('conversation_messages').update(msg.id, { status: 'discarded' });
      messagesDiscarded.push(msg.id);
    }

    const engagementCancelled: string[] = [];
    const commentIds = ctx.db
      .table('public_comments')
      .findMany({ platform, author_platform_user_id: platformUserId })
      .map((c) => c.id);
    for (const reply of ctx.db
      .table('engagement_replies')
      .findMany({ public_comment_id: commentIds, status: [...PENDING_ENGAGEMENT_REPLY] }, { orderBy: 'created_at ASC' })) {
      ctx.db.table('engagement_replies').update(reply.id, { status: 'CANCELLED' });
      engagementCancelled.push(reply.id);
      ctx.audit.event({
        actor,
        action: 'engagement_reply.cancelled',
        entity_type: 'engagement_reply',
        entity_id: reply.id,
        details: { previous_status: reply.status, reason: cancelReason, suppression_id: suppression.id },
      });
    }

    for (const id of leadIds) {
      const lead = requireLead(ctx, id);
      const next = computeNextAction(ctx, lead);
      if (lead.next_action !== next) {
        ctx.db.table('leads').update(id, { next_action: next });
        leadsUpdated.add(id);
      }
    }

    const summary = {
      platform,
      platform_user_id: platformUserId,
      reason: suppression.reason,
      source: suppression.source,
      leads_updated: [...leadsUpdated],
      outreach_cancelled: outreachCancelled,
      conversations_closed: conversationsClosed,
      messages_discarded: messagesDiscarded,
      engagement_replies_cancelled: engagementCancelled,
    };
    const cascaded =
      leadsUpdated.size + outreachCancelled.length + conversationsClosed.length + messagesDiscarded.length + engagementCancelled.length;
    if (!existing) {
      ctx.audit.event({ actor, action: 'contact.suppressed', entity_type: 'contact_suppression', entity_id: suppression.id, details: summary });
    } else if (cascaded > 0) {
      ctx.audit.event({
        actor,
        action: 'contact.suppression_reapplied',
        entity_type: 'contact_suppression',
        entity_id: suppression.id,
        details: { ...summary, requested_reason: reason, requested_source: source },
      });
    }

    return {
      suppression,
      created: !existing,
      leads_updated: summary.leads_updated,
      outreach_cancelled: outreachCancelled,
      conversations_closed: conversationsClosed,
      messages_discarded: messagesDiscarded,
      engagement_replies_cancelled: engagementCancelled,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversions
// ─────────────────────────────────────────────────────────────────────────────

export interface RecordConversionInput {
  lead_id: string;
  outcome: 'won' | 'lost';
  amount?: number;
  vehicle_id?: string;
  lost_reason?: string;
  actor: string;
}

/**
 * Record a sale (won) or loss with content/query attribution from the lead and the owning account
 * from the active assignment, then move the lead to WON / LOST.
 */
export function recordConversion(ctx: AppContext, input: RecordConversionInput): Conversion {
  const leadId = requireString(input?.lead_id, 'lead_id');
  const actor = requireString(input.actor, 'actor');
  if (input.outcome !== 'won' && input.outcome !== 'lost') throw new ValidationError('outcome', 'expected won|lost');
  const amount = input.amount ?? null;
  if (amount !== null && (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0))
    throw new ValidationError('amount', 'must be a non-negative integer amount in CNY');
  const vehicleId = input.vehicle_id ?? null;
  if (vehicleId !== null && (typeof vehicleId !== 'string' || vehicleId === ''))
    throw new ValidationError('vehicle_id', 'expected non-empty string');
  if (input.lost_reason !== undefined && input.lost_reason !== null && typeof input.lost_reason !== 'string')
    throw new ValidationError('lost_reason', 'expected string');

  return ctx.db.tx(() => {
    const lead = requireLead(ctx, leadId);
    const to: LeadStage = input.outcome === 'won' ? 'WON' : 'LOST';
    const verdict = evaluateTransition(lead.stage, to);
    if (verdict.kind !== 'change') {
      const message =
        verdict.kind === 'invalid'
          ? verdict.message
          : `lead is already ${lead.stage}; a ${input.outcome} conversion cannot be recorded`;
      throw new PolicyError('invalid_transition', message, { lead_id: lead.id, from: lead.stage, to });
    }
    if (vehicleId !== null) {
      const vehicle = ctx.db.table('vehicles').get(vehicleId);
      if (!vehicle) throw new NotFoundError('vehicle', vehicleId);
      if (vehicle.group_id !== lead.group_id)
        throw new ValidationError('vehicle_id', 'vehicle belongs to a different dealer group');
    }
    const assignment = ctx.db.table('lead_assignments').findOne({ lead_id: lead.id, active: true });
    const lostReason = input.outcome === 'lost' ? (input.lost_reason ?? '').trim() || DEFAULT_LOST_REASON : null;

    const conversion = ctx.db.table('conversions').insert({
      id: newId('cvn'),
      lead_id: lead.id,
      dealer_id: lead.dealer_id,
      outcome: input.outcome,
      vehicle_id: vehicleId,
      amount,
      lost_reason: lostReason,
      attributed_post_id: lead.attributed_post_id,
      attributed_query_id: lead.attributed_query_id,
      account_id: assignment?.account_id ?? null,
      occurred_at: ctx.clock.iso(),
    });

    applyStageChange(
      ctx,
      lead,
      to,
      { reason: input.outcome === 'won' ? `conversion_won:${conversion.id}` : (lostReason as string), actor },
      {
        details: { conversion_id: conversion.id },
        patch: input.outcome === 'won' && amount !== null ? { estimated_value: amount } : {},
      },
    );

    ctx.audit.event({
      actor,
      action: 'lead.converted',
      entity_type: 'lead',
      entity_id: lead.id,
      details: {
        conversion_id: conversion.id,
        outcome: conversion.outcome,
        amount: conversion.amount,
        vehicle_id: conversion.vehicle_id,
        lost_reason: conversion.lost_reason,
        account_id: conversion.account_id,
        attributed_post_id: conversion.attributed_post_id,
        attributed_query_id: conversion.attributed_query_id,
        from_stage: lead.stage,
      },
    });
    return conversion;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Next action
// ─────────────────────────────────────────────────────────────────────────────

function outreachAction(o: Outreach, label: '私信' | '跟进私信'): string | null {
  switch (o.status) {
    case 'DRAFT':
      return `完善${label}草稿并提交审核`;
    case 'READY_FOR_REVIEW':
      return `审核${label}：通过后在小红书发送`;
    case 'APPROVED':
      return o.capability_status === 'AVAILABLE'
        ? `${label}已审核通过：等待系统发送`
        : `由负责账号在小红书人工发送已审核${label}并登记`;
    case 'BLOCKED':
      return `${label}被拦截：${o.blocked_reason?.trim() || '未通过发送前检查'}`;
    case 'FAILED':
      return `${label}发送失败：检查账号状态后重试或人工发送`;
    default:
      return null;
  }
}

function dealerTimezone(ctx: AppContext, dealerId: string): { tz: string; followUpDays: number; maxTouches: number } {
  const settings = ctx.db.table('dealers').get(dealerId)?.settings;
  const followUpDays =
    typeof settings?.follow_up_after_days === 'number' && Number.isFinite(settings.follow_up_after_days) && settings.follow_up_after_days >= 0
      ? settings.follow_up_after_days
      : DEFAULT_FOLLOW_UP_AFTER_DAYS;
  const maxTouches =
    typeof settings?.max_unanswered_touches === 'number' && settings.max_unanswered_touches > 0
      ? settings.max_unanswered_touches
      : DEFAULT_MAX_UNANSWERED_TOUCHES;
  return { tz: settings?.timezone || DEFAULT_TZ, followUpDays, maxTouches };
}

function waitingForReplyAction(ctx: AppContext, lead: Lead): string {
  const { followUpDays, maxTouches } = dealerTimezone(ctx, lead.dealer_id);
  const sentCount = ctx.db.table('outreach').count({ lead_id: lead.id, status: SENT_OUTREACH });
  if (sentCount >= maxTouches) return `已触达${sentCount}次未回复：暂停触达，等待客户主动回复`;
  const lastSent = latestSentOutreach(ctx, lead.id);
  if (!lastSent?.sent_at) return `等待回复（${followUpDays}天后跟进）`;
  const remaining = Math.ceil(followUpDays - daysBetween(lastSent.sent_at, ctx.clock.now()) - 1e-9);
  if (remaining <= 0) return '已到跟进时间：准备跟进私信';
  return `等待回复（${remaining}天后跟进）`;
}

function appointmentTimeLabel(appt: Appointment, tz: string): string {
  if (appt.scheduled_for) {
    const at = new Date(appt.scheduled_for);
    if (!Number.isNaN(at.getTime())) {
      const p = localParts(at, tz);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${p.month}月${p.day}日（周${WEEKDAY_ZH[p.weekday]}）${pad(p.hour)}:${pad(p.minute)}`;
    }
  }
  return appt.time_text?.trim() || '时间待定';
}

function appointmentAction(ctx: AppContext, lead: Lead): string {
  const rows = ctx.db.all('SELECT * FROM appointments WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC', lead.id);
  const appts = rows.map((r) => ctx.db.table('appointments').decode(r));
  const active = appts.find((a) => a.status === 'proposed' || a.status === 'confirmed');
  const { tz } = dealerTimezone(ctx, lead.dealer_id);
  if (active) return `确认到店：${appointmentTimeLabel(active, tz)}`;
  const latest = appts[0];
  if (!latest) return '确认到店：时间待定';
  if (latest.status === 'no_show') return '客户未到店：重新邀约';
  if (latest.status === 'cancelled') return '预约已取消：重新邀约到店';
  return '跟进报价与谈判';
}

/** Recommended next action (Chinese) derived from stage, outreach, conversation hand-off and appointments. */
/**
 * Machine lost-reason codes written by automated steps. Everything else in `lost_reason` is text a human wrote, and is
 * shown as it is — the code stays in the column (analytics group by it), the operator reads the label.
 */
export const LOST_REASON_LABEL: Readonly<Record<string, string>> = {
  industry_account: '车商/销售账号，不是买家',
  llm_screen: '大模型复核：不是本地在市买家',
};

export function lostReasonText(reason: string | null | undefined): string {
  const r = (reason ?? '').trim();
  if (!r) return DEFAULT_LOST_REASON;
  return LOST_REASON_LABEL[r] ?? r;
}

export function computeNextAction(ctx: AppContext, lead: Lead): string {
  if (lead.suppressed) return SUPPRESSION_NEXT_ACTION;
  if (lead.stage === 'WON') return '已成交';
  if (lead.stage === 'LOST') return `已流失：${lostReasonText(lead.lost_reason)}`;

  const handoff = ctx.db
    .table('conversations')
    .findOne({ lead_id: lead.id, status: ['open', 'handed_off'], needs_human: true }, { orderBy: 'last_message_at DESC' });
  if (handoff) return `人工接管对话：${handoff.handoff_reason?.trim() || '需要人工处理'}`;

  switch (lead.stage) {
    case 'DISCOVERED':
      return '评估公开信号：判断购买意向';
    case 'CANDIDATE':
      return '继续观察：等待更多购买信号';
    case 'QUALIFIED':
      return '分配最合适的账号';
    case 'ASSIGNED':
    case 'OUTREACH_READY': {
      const latest = latestOutreach(ctx, lead.id);
      if (latest && SENT_OUTREACH.includes(latest.status)) return waitingForReplyAction(ctx, lead);
      return (latest && outreachAction(latest, latest.kind === 'follow_up' ? '跟进私信' : '私信')) ?? '生成个性化私信';
    }
    case 'CONTACTED': {
      const latest = latestOutreach(ctx, lead.id);
      const pending = latest && outreachAction(latest, latest.kind === 'follow_up' ? '跟进私信' : '私信');
      return pending ?? waitingForReplyAction(ctx, lead);
    }
    case 'REPLIED':
      return '处理客户回复';
    case 'SALES_QUALIFIED':
      return '发送留资卡/名片获取联系方式';
    case 'CONTACT_ACQUIRED':
      return '电话邀约到店';
    case 'APPOINTMENT':
      return appointmentAction(ctx, lead);
    case 'VISITED':
      return '跟进报价与谈判';
    case 'NEGOTIATING':
      return '推进成交';
    default:
      return '人工检查线索状态';
  }
}

export function refreshNextAction(ctx: AppContext, leadId: string): Lead {
  const lead = requireLead(ctx, leadId);
  const next = computeNextAction(ctx, lead);
  return lead.next_action === next ? lead : ctx.db.table('leads').update(lead.id, { next_action: next });
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline
// ─────────────────────────────────────────────────────────────────────────────

const SUPPRESSION_ID_LIST_KEYS = [
  'leads_updated',
  'outreach_cancelled',
  'conversations_closed',
  'messages_discarded',
  'engagement_replies_cancelled',
] as const;

/**
 * The do-not-contact list is global, but a lead timeline is shown to one dealer group: keep only the
 * cascade ids that belong to this lead's records so other tenants' lead/outreach ids never leak.
 * The stored audit row is not modified.
 */
function scopeSuppressionEvent(event: AuditEvent, visibleIds: ReadonlySet<string>): AuditEvent {
  const details: Record<string, unknown> = { ...event.details };
  for (const key of SUPPRESSION_ID_LIST_KEYS) {
    const list = details[key];
    if (Array.isArray(list)) details[key] = list.filter((id) => typeof id === 'string' && visibleIds.has(id));
  }
  return { ...event, details };
}

/**
 * Transitions, audit events and agent decisions for the lead AND its related records (signals and
 * their source comments, assignments, outreach, conversations/messages, appointments, conversions,
 * the user's suppression), each list ordered by time (insertion order breaks ties).
 */
export function getLeadTimeline(
  ctx: AppContext,
  leadId: string,
): { transitions: LeadStageTransition[]; events: AuditEvent[]; decisions: AgentDecision[] } {
  const lead = requireLead(ctx, leadId);
  const ids = new Set<string>([lead.id]);
  const idsOf = (sql: string, ...params: string[]) => {
    for (const row of ctx.db.all<{ id: string | null }>(sql, ...params)) if (row.id) ids.add(row.id);
  };
  idsOf('SELECT id FROM lead_signals WHERE lead_id = ?', lead.id);
  idsOf('SELECT public_comment_id AS id FROM lead_signals WHERE lead_id = ?', lead.id);
  idsOf('SELECT id FROM lead_scores WHERE lead_id = ?', lead.id);
  idsOf('SELECT id FROM lead_assignments WHERE lead_id = ?', lead.id);
  idsOf('SELECT id FROM outreach WHERE lead_id = ?', lead.id);
  idsOf('SELECT id FROM conversations WHERE lead_id = ?', lead.id);
  idsOf(
    'SELECT m.id AS id FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.lead_id = ?',
    lead.id,
  );
  idsOf('SELECT id FROM appointments WHERE lead_id = ?', lead.id);
  idsOf('SELECT id FROM conversions WHERE lead_id = ?', lead.id);
  idsOf(
    `SELECT e.id AS id FROM engagement_replies e
       JOIN dealers d ON d.id = e.dealer_id
       JOIN public_comments pc ON pc.id = e.public_comment_id
     WHERE d.group_id = ? AND pc.platform = ? AND pc.author_platform_user_id = ?`,
    lead.group_id,
    lead.platform,
    lead.platform_user_id,
  );
  const suppressionIds = new Set<string>();
  for (const row of ctx.db.all<{ id: string }>(
    'SELECT id FROM contact_suppressions WHERE platform = ? AND platform_user_id = ?',
    lead.platform,
    lead.platform_user_id,
  )) {
    ids.add(row.id);
    suppressionIds.add(row.id);
  }

  const idList = [...ids];
  const placeholders = idList.map(() => '?').join(', ');
  const transitions = ctx.db
    .all('SELECT * FROM lead_stage_transitions WHERE lead_id = ? ORDER BY at ASC, rowid ASC', lead.id)
    .map((r) => ctx.db.table('lead_stage_transitions').decode(r));
  const events = ctx.db
    .all(`SELECT * FROM audit_events WHERE entity_id IN (${placeholders}) ORDER BY created_at ASC, rowid ASC`, ...idList)
    .map((r) => ctx.db.table('audit_events').decode(r))
    .map((e) => (suppressionIds.has(e.entity_id) ? scopeSuppressionEvent(e, ids) : e));
  const decisions = ctx.db
    .all(`SELECT * FROM agent_decisions WHERE subject_id IN (${placeholders}) ORDER BY created_at ASC, rowid ASC`, ...idList)
    .map((r) => ctx.db.table('agent_decisions').decode(r));
  return { transitions, events, decisions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill definition
// ─────────────────────────────────────────────────────────────────────────────

export const CRM_ACTIONS = ['transition', 'suppress', 'convert', 'reopen', 'refresh_next_action'] as const;
export type CrmAction = (typeof CRM_ACTIONS)[number];

const actorV = v.withDefault(v.string({ min: 1 }), DEFAULT_ACTOR);

const transitionInputV = v.object({
  action: v.literal(['transition']),
  lead_id: v.string({ min: 1 }),
  to: v.literal(LEAD_STAGES),
  reason: v.withDefault(v.string(), ''),
  actor: actorV,
});
const suppressInputV = v.object({
  action: v.literal(['suppress']),
  platform_user_id: v.string({ min: 1 }),
  reason: v.string({ min: 1 }),
  source: v.string({ min: 1 }),
  actor: actorV,
  platform: v.optional(v.literal(PLATFORMS)),
});
const convertInputV = v.object({
  action: v.literal(['convert']),
  lead_id: v.string({ min: 1 }),
  outcome: v.literal(['won', 'lost']),
  amount: v.optional(v.number({ int: true, min: 0 })),
  vehicle_id: v.optional(v.string({ min: 1 })),
  lost_reason: v.optional(v.string()),
  actor: actorV,
});
const reopenInputV = v.object({
  action: v.literal(['reopen']),
  lead_id: v.string({ min: 1 }),
  to: v.literal(REOPEN_TARGETS),
  reason: v.withDefault(v.string(), ''),
  actor: v.string({ min: 1 }),
});
const refreshInputV = v.object({
  action: v.literal(['refresh_next_action']),
  lead_id: v.string({ min: 1 }),
});

export type CrmSkillInput =
  | Infer<typeof transitionInputV>
  | Infer<typeof suppressInputV>
  | Infer<typeof convertInputV>
  | Infer<typeof reopenInputV>
  | Infer<typeof refreshInputV>;

export type CrmSkillOutput =
  | { action: 'transition'; lead: Lead; changed: boolean; transition: LeadStageTransition | null }
  | ({ action: 'suppress' } & SuppressContactResult)
  | { action: 'convert'; conversion: Conversion; lead: Lead }
  | { action: 'reopen'; lead: Lead }
  | { action: 'refresh_next_action'; lead: Lead };

const crmInput: Validator<CrmSkillInput> = (value, path = '') => {
  const { action } = v.object({ action: v.literal(CRM_ACTIONS) })(value, path);
  switch (action) {
    case 'transition':
      return transitionInputV(value, path);
    case 'suppress':
      return suppressInputV(value, path);
    case 'convert':
      return convertInputV(value, path);
    case 'reopen':
      return reopenInputV(value, path);
    case 'refresh_next_action':
      return refreshInputV(value, path);
  }
};

export const skill = defineSkill<CrmSkillInput, CrmSkillOutput>({
  name: 'crm',
  category: 'operations',
  agent: 'crm-agent',
  description:
    'CRM漏斗状态机：阶段流转（含幂等与终态规则）、全局勿扰屏蔽及级联取消触达、成交/流失记录与归因、下一步行动建议。',
  input: crmInput,
  run(ctx, input): CrmSkillOutput {
    switch (input.action) {
      case 'transition': {
        const res = transitionLead(ctx, input.lead_id, input.to, { reason: input.reason, actor: input.actor });
        return { action: 'transition', ...res };
      }
      case 'suppress':
        return {
          action: 'suppress',
          ...suppressContact(ctx, {
            platform_user_id: input.platform_user_id,
            reason: input.reason,
            source: input.source,
            actor: input.actor,
            platform: input.platform,
          }),
        };
      case 'convert': {
        const conversion = recordConversion(ctx, {
          lead_id: input.lead_id,
          outcome: input.outcome,
          amount: input.amount,
          vehicle_id: input.vehicle_id,
          lost_reason: input.lost_reason,
          actor: input.actor,
        });
        return { action: 'convert', conversion, lead: requireLead(ctx, input.lead_id) };
      }
      case 'reopen':
        return {
          action: 'reopen',
          lead: reopenLead(ctx, input.lead_id, input.to, { reason: input.reason, actor: input.actor }),
        };
      case 'refresh_next_action':
        return { action: 'refresh_next_action', lead: refreshNextAction(ctx, input.lead_id) };
    }
  },
});
