# qualification

## Responsibility
Decides whether a lead that is talking to us is a real sales opportunity (spec §13–14) and moves it to
`SALES_QUALIFIED`. The rule is deliberately explainable: the desired model must be known AND at least two of
- budget (conversation slot or stated public intent)
- purchase timeframe within three months (`this_week`, `soon`, `this_month`, `within_3_months`)
- location in the dealer's province (stated city/province; an IP 属地-only province does not count)
- appointment intent (slot, public visit intent, or an existing proposed/confirmed/visited appointment)
- voluntarily provided phone / WeChat
- financing, leasing or trade-in specifics.

## Owning agent
`crm-agent` (skill category `sales`); called by the conversation agent after every inbound message.

## Inputs
- `qualifyLead(ctx, leadId)`; pure `evaluateQualification(ctx, lead)`; helper `mergedConversationSlots(ctx, leadId)`.
- Skill input `{lead_id}`.

## Outputs
`{sales_qualified, reasons, missing}` in Simplified Chinese (`evaluateQualification` additionally returns `model_known`,
`met` criteria and the merged slots). When the lead is moved forward: a `lead_stage_transitions` row via CRM, an
`agent_decisions` row of type `sales_qualification` (criteria met, reasons, missing) and a refreshed `next_action`.

## Validation & guarantees
- Forward-only: leads already at SALES_QUALIFIED or deeper are not touched; no decision is written for no-ops.
- Never advances do-not-contact leads (flag or global suppression list) or WON/LOST leads.
- A model inferred only from post context does not count as a known model; IP-inferred provinces do not count as location.
- Slots from every conversation with the lead are merged oldest → newest, so a later correction wins.

## Runtime entry points
`processInboundMessage` (conversation skill) after each inbound reply; the console lead detail page shows `reasons` / `missing`;
operator workflows through the `qualification` skill.

## Failure modes
Unknown lead → `NotFoundError`; empty id → `ValidationError`. A concurrent suppression makes the CRM transition refuse, in which
case the transaction is rolled back and nothing is written.

## Tests
`test/unit/qualification/qualification.test.ts`: qualified with model + budget + timeframe (transition + decision exactly once),
not qualified with model only (missing list), IP-only province ignored, appointment/contact/payment criteria, suppressed and
closed leads never advanced, deeper stages untouched.
