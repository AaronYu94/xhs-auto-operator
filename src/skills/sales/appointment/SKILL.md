# appointment

## Responsibility
Turns a customer's wish to visit the showroom into a tracked appointment and records how it ends:
- `upsertAppointment` creates a `proposed` appointment (store = the lead's dealer, vehicle interest from the lead intent or
  the conversation slots) or updates the lead's active one (new time, notes, vehicle interest). A new time on a
  `confirmed` appointment sets it back to `proposed`, because the new slot must be confirmed again.
- `confirmAppointment` (optionally with a concrete `scheduled_for`), `markVisited` (lead → VISITED), `markNoShow`,
  and the additive `cancelAppointment`.
- `getActiveAppointment` and `listAppointments` (console calendar, soonest first, unscheduled last).

## Owning agent
`crm-agent` (skill category `sales`). The conversation agent calls `upsertAppointment` with actor
`agent:conversation-agent` when a reply contains an appointment intent.

## Inputs
- `upsertAppointment(ctx, {lead_id, account_id, conversation_id?, time_text?, scheduled_for?, vehicle_interest?, notes?, actor?})`
- `confirmAppointment(ctx, appointmentId, actor, scheduledFor?)`, `markVisited(ctx, id, actor)`, `markNoShow(ctx, id, actor)`,
  `cancelAppointment(ctx, id, actor, reason)`
- `listAppointments(ctx, {dealer_id, status?, from?, to?, limit?})`
- Skill input: `{action: 'upsert'|'confirm'|'visited'|'no_show'|'cancel', lead_id?, account_id?, appointment_id?, conversation_id?,
  time_text?, scheduled_for?, vehicle_interest?, notes?, reason?, actor?}`.

## Outputs
The `Appointment` row after the change (`listAppointments` returns rows). Side effects: `appointments` row, lead stage
(APPOINTMENT on upsert/confirm, VISITED on visit), `audit_events` (`appointment.proposed|updated|confirmed|visited|no_show|cancelled`),
an `agent_decisions` row of type `appointment` whenever an appointment is created or changed, and a refreshed `next_action`.

## Validation & guarantees
- Timestamps are validated and normalized to ISO; ids and actors must be non-empty.
- Do-not-contact leads (flagged or on the global `contact_suppressions` list): no new or confirmed appointment
  (`PolicyError('contact_suppressed')`). A walk-in by such a customer can still be recorded with `markVisited`, but the
  funnel is not re-entered.
- WON/LOST leads cannot get an appointment (`PolicyError('lead_closed')`); only `proposed` / `confirmed` appointments can be
  confirmed, visited, marked no-show or cancelled (`PolicyError('invalid_appointment_status')`).
- The account must belong to the lead's dealer group; a `conversation_id` must belong to the lead.
- At most one active appointment per lead is maintained by upsert (the newest proposed/confirmed one is updated).
- Every write runs in one `ctx.db.tx`; the funnel transition goes through CRM `transitionLead` (forward-only, idempotent).

## Runtime entry points
- Conversation agent: `processInboundMessage` → `upsertAppointment` when a reply carries an appointment intent
  (time resolved with `resolveAppointmentTime` in the dealer timezone).
- Console / API: confirm, visited, no-show and cancel actions on the 对话 and 线索 pages; calendar via `listAppointments`.
- Operator workflows via the `appointment` skill.

## Failure modes
- Unknown lead/account/appointment → `NotFoundError`.
- Invalid timestamps or cross-group account → `ValidationError`.
- Suppressed lead, closed lead or an appointment that is no longer active → `PolicyError` (nothing written).

## Tests
`test/unit/appointment/appointment.test.ts`: proposal with Asia/Shanghai time and APPOINTMENT stage, upsert updates the active
appointment and re-proposes a confirmed one on a new time, confirm / visited (VISITED) / no-show / cancel transitions and audit,
refusal for suppressed and closed leads, listing order, and the skill wrapper.
