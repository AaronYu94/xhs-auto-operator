/**
 * Appointments (spec §13–14): showroom visit proposals coming out of conversations or entered by a salesperson,
 * their confirmation, and the visit / no-show outcome. Every change is audited and keeps the funnel stage
 * (APPOINTMENT → VISITED) and the lead's next action in sync. Do-not-contact users never get new appointments.
 */
import type { AppContext } from '../../../app/context.ts';
import { NotFoundError, PolicyError, ValidationError } from '../../../core/errors.ts';
import { newId } from '../../../core/ids.ts';
import { APPOINTMENT_STATUSES, type Appointment, type AppointmentStatus, type Engine, type Lead } from '../../../core/types.ts';
import { v, type Infer } from '../../../core/validate.ts';
import { modelDisplayName } from '../../../domain/automotive-lexicon.ts';
import { requireAccount } from '../../operations/account-brain/index.ts';
import { isSuppressed, isTerminalStage, refreshNextAction, transitionLead } from '../../operations/crm/index.ts';
import { getDealer } from '../../operations/dealer-brain/index.ts';
import { defineSkill } from '../../registry.ts';

export const APPOINTMENT_AGENT = 'crm-agent';
const DEFAULT_ACTOR = `agent:${APPOINTMENT_AGENT}`;
const SKILL = 'appointment';

/** Appointments that still expect the customer to come in. */
export const ACTIVE_APPOINTMENT_STATUSES: readonly AppointmentStatus[] = ['proposed', 'confirmed'];
export const UNKNOWN_VEHICLE_INTEREST = '车型待确认';

export interface UpsertAppointmentInput {
  lead_id: string;
  account_id: string;
  conversation_id?: string | null;
  /** original wording, e.g. '这周六下午' */
  time_text?: string | null;
  /** ISO timestamp when the time is resolvable */
  scheduled_for?: string | null;
  vehicle_interest?: string;
  notes?: string;
  /** additive: 'agent:<name>' or 'operator:<name>' (default agent:crm-agent) */
  actor?: string;
}

function requireText(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(path, 'expected non-empty string');
  return value.trim();
}

function normalizeIso(value: string | null | undefined, path: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new ValidationError(path, `invalid timestamp ${JSON.stringify(value)}`);
  return new Date(t).toISOString();
}

function actorParts(actor: string): { agent: string; engine: Engine } {
  if (actor.startsWith('operator:')) return { agent: APPOINTMENT_AGENT, engine: 'human' };
  const agent = actor.startsWith('agent:') ? actor.slice('agent:'.length) : APPOINTMENT_AGENT;
  return { agent: agent || APPOINTMENT_AGENT, engine: 'rules' };
}

function requireLead(ctx: AppContext, leadId: string): Lead {
  const lead = ctx.db.table('leads').get(leadId);
  if (!lead) throw new NotFoundError('lead', leadId);
  return lead;
}

function requireAppointment(ctx: AppContext, appointmentId: string): Appointment {
  const appt = ctx.db.table('appointments').get(requireText(appointmentId, 'appointment_id'));
  if (!appt) throw new NotFoundError('appointment', appointmentId);
  return appt;
}

function leadIsSuppressed(ctx: AppContext, lead: Lead): boolean {
  return lead.suppressed || isSuppressed(ctx, lead.platform_user_id, lead.platform) !== null;
}

/** 'BMW i3 eDrive35L' from the lead intent (brand falls back to the dealer's first brand). */
export function vehicleInterestFor(ctx: AppContext, lead: Lead, slots?: { model?: string; trim?: string }): string {
  const model = slots?.model ?? lead.intent.model;
  const trim = slots?.model ? slots.trim : (slots?.trim ?? lead.intent.trim);
  if (!model) return UNKNOWN_VEHICLE_INTEREST;
  const brand = lead.intent.brand ?? getDealer(ctx, lead.dealer_id).brands[0] ?? '';
  const base = brand ? modelDisplayName(brand, model, 'en') : model;
  return trim ? `${base} ${trim}` : base;
}

/** The newest proposed / confirmed appointment of the lead, if any. */
export function getActiveAppointment(ctx: AppContext, leadId: string): Appointment | undefined {
  const rows = ctx.db.all(
    `SELECT * FROM appointments WHERE lead_id = ? AND status IN ('proposed', 'confirmed') ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    leadId,
  );
  return rows[0] ? ctx.db.table('appointments').decode(rows[0]) : undefined;
}

/**
 * Create a proposed appointment, or update the lead's active one (time, vehicle interest, notes), then move the
 * lead to APPOINTMENT. Refuses do-not-contact and closed (WON/LOST) leads.
 */
export function upsertAppointment(ctx: AppContext, input: UpsertAppointmentInput): Appointment {
  const leadId = requireText(input?.lead_id, 'lead_id');
  const accountId = requireText(input.account_id, 'account_id');
  const actor = input.actor?.trim() || DEFAULT_ACTOR;
  const scheduledFor = normalizeIso(input.scheduled_for, 'scheduled_for');
  const timeText = typeof input.time_text === 'string' && input.time_text.trim() ? input.time_text.trim() : null;
  const { agent, engine } = actorParts(actor);

  return ctx.db.tx(() => {
    const lead = requireLead(ctx, leadId);
    const account = requireAccount(ctx, accountId);
    if (account.group_id !== lead.group_id) throw new ValidationError('account_id', 'account belongs to a different dealer group');
    if (leadIsSuppressed(ctx, lead))
      throw new PolicyError('contact_suppressed', 'lead is on the do-not-contact list: no appointment can be created', { lead_id: lead.id });
    if (isTerminalStage(lead.stage))
      throw new PolicyError('lead_closed', `lead is ${lead.stage}; reopen it before scheduling a visit`, { lead_id: lead.id, stage: lead.stage });
    if (input.conversation_id) {
      const conv = ctx.db.table('conversations').get(input.conversation_id);
      if (!conv || conv.lead_id !== lead.id) throw new ValidationError('conversation_id', 'conversation does not belong to this lead');
    }
    const dealer = getDealer(ctx, lead.dealer_id);
    const now = ctx.clock.iso();
    const table = ctx.db.table('appointments');
    const existing = getActiveAppointment(ctx, lead.id);
    const vehicleInterest = input.vehicle_interest?.trim() || existing?.vehicle_interest || vehicleInterestFor(ctx, lead);
    const note = input.notes?.trim() ?? '';

    let appointment: Appointment;
    let created = false;
    if (existing) {
      const patch: Partial<Appointment> = {};
      if (scheduledFor && scheduledFor !== existing.scheduled_for) patch.scheduled_for = scheduledFor;
      if (timeText && timeText !== existing.time_text) patch.time_text = timeText;
      if (vehicleInterest !== existing.vehicle_interest && vehicleInterest !== UNKNOWN_VEHICLE_INTEREST) patch.vehicle_interest = vehicleInterest;
      if (input.conversation_id && !existing.conversation_id) patch.conversation_id = input.conversation_id;
      if (note && !existing.notes.includes(note)) patch.notes = existing.notes ? `${existing.notes}\n${note}` : note;
      // a new time for a confirmed visit needs to be confirmed again
      if ((patch.scheduled_for || patch.time_text) && existing.status === 'confirmed') patch.status = 'proposed';
      appointment = Object.keys(patch).length > 0 ? table.update(existing.id, patch) : existing;
      if (Object.keys(patch).length > 0) {
        ctx.audit.event({
          actor,
          action: 'appointment.updated',
          entity_type: 'appointment',
          entity_id: existing.id,
          details: { lead_id: lead.id, changes: patch, previous: { scheduled_for: existing.scheduled_for, time_text: existing.time_text, status: existing.status } },
        });
      }
    } else {
      created = true;
      appointment = table.insert({
        id: newId('appt'),
        lead_id: lead.id,
        dealer_id: dealer.id,
        account_id: account.id,
        conversation_id: input.conversation_id ?? null,
        scheduled_for: scheduledFor,
        time_text: timeText,
        store: dealer.name,
        vehicle_interest: vehicleInterest,
        status: 'proposed',
        notes: note,
        created_at: now,
        updated_at: now,
      });
      ctx.audit.event({
        actor,
        action: 'appointment.proposed',
        entity_type: 'appointment',
        entity_id: appointment.id,
        details: { lead_id: lead.id, account_id: account.id, scheduled_for: scheduledFor, time_text: timeText, store: dealer.name },
      });
    }

    const stage = transitionLead(ctx, lead.id, 'APPOINTMENT', {
      reason: `预约到店：${timeText ?? (scheduledFor ? scheduledFor : '时间待定')}`,
      actor,
    });
    if (created || appointment !== existing) {
      ctx.audit.decision({
        agent,
        skill: SKILL,
        decision_type: 'appointment',
        subject_type: 'appointment',
        subject_id: appointment.id,
        inputs: { lead_id: lead.id, account_id: account.id, conversation_id: input.conversation_id ?? null, time_text: timeText, scheduled_for: scheduledFor },
        evidence: timeText ? [{ code: 'appointment_time', label: '客户提出的到店时间', quote: timeText, source_ref: input.conversation_id ?? undefined }] : [],
        output: { created, status: appointment.status, scheduled_for: appointment.scheduled_for, store: appointment.store, vehicle_interest: appointment.vehicle_interest, stage_changed: stage.changed },
        confidence: scheduledFor ? 0.85 : 0.6,
        engine,
      });
    }
    refreshNextAction(ctx, lead.id);
    return appointment;
  });
}

function requireActive(appt: Appointment, action: string): void {
  if (!ACTIVE_APPOINTMENT_STATUSES.includes(appt.status))
    throw new PolicyError('invalid_appointment_status', `cannot ${action} an appointment that is ${appt.status}`, {
      appointment_id: appt.id,
      status: appt.status,
    });
}

/** proposed/confirmed → confirmed (optionally with a concrete time). */
export function confirmAppointment(ctx: AppContext, appointmentId: string, actor: string, scheduledFor?: string): Appointment {
  const who = requireText(actor, 'actor');
  const at = normalizeIso(scheduledFor, 'scheduled_for');
  return ctx.db.tx(() => {
    const appt = requireAppointment(ctx, appointmentId);
    requireActive(appt, 'confirm');
    const lead = requireLead(ctx, appt.lead_id);
    if (leadIsSuppressed(ctx, lead))
      throw new PolicyError('contact_suppressed', 'lead is on the do-not-contact list: the appointment cannot be confirmed', { lead_id: lead.id });
    const updated = ctx.db.table('appointments').update(appt.id, { status: 'confirmed', ...(at ? { scheduled_for: at } : {}) });
    ctx.audit.event({
      actor: who,
      action: 'appointment.confirmed',
      entity_type: 'appointment',
      entity_id: appt.id,
      details: { lead_id: lead.id, previous_status: appt.status, scheduled_for: updated.scheduled_for },
    });
    if (!isTerminalStage(lead.stage)) transitionLead(ctx, lead.id, 'APPOINTMENT', { reason: '到店预约已确认', actor: who });
    refreshNextAction(ctx, lead.id);
    return updated;
  });
}

/** The customer came to the store: appointment visited, lead → VISITED. */
export function markVisited(ctx: AppContext, appointmentId: string, actor: string): Appointment {
  const who = requireText(actor, 'actor');
  return ctx.db.tx(() => {
    const appt = requireAppointment(ctx, appointmentId);
    requireActive(appt, 'mark visited');
    const lead = requireLead(ctx, appt.lead_id);
    const updated = ctx.db.table('appointments').update(appt.id, { status: 'visited' });
    const suppressed = leadIsSuppressed(ctx, lead);
    // A do-not-contact customer may still walk in; the visit is recorded but the funnel is not re-entered.
    const stage = !suppressed && !isTerminalStage(lead.stage)
      ? transitionLead(ctx, lead.id, 'VISITED', { reason: `客户已到店（${appt.store}）`, actor: who })
      : null;
    ctx.audit.event({
      actor: who,
      action: 'appointment.visited',
      entity_type: 'appointment',
      entity_id: appt.id,
      details: { lead_id: lead.id, previous_status: appt.status, stage_changed: stage?.changed ?? false, suppressed },
    });
    refreshNextAction(ctx, lead.id);
    return updated;
  });
}

/** The customer did not come: appointment no_show; the next action becomes re-inviting. */
export function markNoShow(ctx: AppContext, appointmentId: string, actor: string): Appointment {
  const who = requireText(actor, 'actor');
  return ctx.db.tx(() => {
    const appt = requireAppointment(ctx, appointmentId);
    requireActive(appt, 'mark no-show');
    const updated = ctx.db.table('appointments').update(appt.id, { status: 'no_show' });
    ctx.audit.event({
      actor: who,
      action: 'appointment.no_show',
      entity_type: 'appointment',
      entity_id: appt.id,
      details: { lead_id: appt.lead_id, previous_status: appt.status, scheduled_for: appt.scheduled_for },
    });
    refreshNextAction(ctx, appt.lead_id);
    return updated;
  });
}

/** Additive: cancel an active appointment (customer or store cancelled). */
export function cancelAppointment(ctx: AppContext, appointmentId: string, actor: string, reason: string): Appointment {
  const who = requireText(actor, 'actor');
  const why = requireText(reason, 'reason');
  return ctx.db.tx(() => {
    const appt = requireAppointment(ctx, appointmentId);
    requireActive(appt, 'cancel');
    const notes = appt.notes ? `${appt.notes}\n取消原因：${why}` : `取消原因：${why}`;
    const updated = ctx.db.table('appointments').update(appt.id, { status: 'cancelled', notes });
    ctx.audit.event({
      actor: who,
      action: 'appointment.cancelled',
      entity_type: 'appointment',
      entity_id: appt.id,
      details: { lead_id: appt.lead_id, previous_status: appt.status, reason: why },
    });
    refreshNextAction(ctx, appt.lead_id);
    return updated;
  });
}

export interface ListAppointmentsQuery {
  dealer_id: string;
  status?: AppointmentStatus | AppointmentStatus[];
  /** ISO lower bound (inclusive) on scheduled_for; appointments without a time are kept */
  from?: string;
  /** ISO upper bound (exclusive) on scheduled_for */
  to?: string;
  limit?: number;
}

/** Additive (console): a dealer's appointments, soonest first, unscheduled ones last. */
export function listAppointments(ctx: AppContext, q: ListAppointmentsQuery): Appointment[] {
  const dealerId = requireText(q?.dealer_id, 'dealer_id');
  const statuses = q.status === undefined ? [...APPOINTMENT_STATUSES] : Array.isArray(q.status) ? q.status : [q.status];
  for (const s of statuses) if (!APPOINTMENT_STATUSES.includes(s)) throw new ValidationError('status', `unknown appointment status ${s}`);
  const from = normalizeIso(q.from, 'from');
  const to = normalizeIso(q.to, 'to');
  const limit = Math.min(500, Math.max(1, Math.floor(q.limit ?? 100)));
  const params: (string | number)[] = [dealerId, ...statuses];
  let where = `dealer_id = ? AND status IN (${statuses.map(() => '?').join(', ')})`;
  if (from) {
    where += ' AND (scheduled_for IS NULL OR scheduled_for >= ?)';
    params.push(from);
  }
  if (to) {
    where += ' AND (scheduled_for IS NULL OR scheduled_for < ?)';
    params.push(to);
  }
  return ctx.db
    .all(`SELECT * FROM appointments WHERE ${where} ORDER BY scheduled_for IS NULL, scheduled_for ASC, created_at ASC LIMIT ${limit}`, ...params)
    .map((row) => ctx.db.table('appointments').decode(row));
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill
// ─────────────────────────────────────────────────────────────────────────────

export const APPOINTMENT_ACTIONS = ['upsert', 'confirm', 'visited', 'no_show', 'cancel'] as const;

const skillInput = v.object({
  action: v.literal(APPOINTMENT_ACTIONS),
  lead_id: v.optional(v.string({ min: 1 })),
  account_id: v.optional(v.string({ min: 1 })),
  appointment_id: v.optional(v.string({ min: 1 })),
  conversation_id: v.optional(v.nullable(v.string({ min: 1 }))),
  time_text: v.optional(v.nullable(v.string({ max: 200 }))),
  scheduled_for: v.optional(v.nullable(v.string({ min: 1 }))),
  vehicle_interest: v.optional(v.string({ max: 200 })),
  notes: v.optional(v.string({ max: 2000 })),
  reason: v.optional(v.string({ max: 500 })),
  actor: v.optional(v.string({ min: 1 })),
});
export type AppointmentSkillInput = Infer<typeof skillInput>;

export const skill = defineSkill<AppointmentSkillInput, Appointment>({
  name: 'appointment',
  category: 'sales',
  agent: 'crm-agent',
  description: '创建/更新到店预约，确认、到店、未到店与取消，并同步线索阶段（APPOINTMENT / VISITED）',
  input: skillInput,
  run(ctx, input) {
    const actor = input.actor ?? DEFAULT_ACTOR;
    const need = (value: string | undefined, path: string) => requireText(value, path);
    switch (input.action) {
      case 'upsert':
        return upsertAppointment(ctx, {
          lead_id: need(input.lead_id, 'lead_id'),
          account_id: need(input.account_id, 'account_id'),
          conversation_id: input.conversation_id ?? null,
          time_text: input.time_text ?? null,
          scheduled_for: input.scheduled_for ?? null,
          vehicle_interest: input.vehicle_interest,
          notes: input.notes,
          actor,
        });
      case 'confirm':
        return confirmAppointment(ctx, need(input.appointment_id, 'appointment_id'), actor, input.scheduled_for ?? undefined);
      case 'visited':
        return markVisited(ctx, need(input.appointment_id, 'appointment_id'), actor);
      case 'no_show':
        return markNoShow(ctx, need(input.appointment_id, 'appointment_id'), actor);
      case 'cancel':
        return cancelAppointment(ctx, need(input.appointment_id, 'appointment_id'), actor, need(input.reason, 'reason'));
    }
  },
});
