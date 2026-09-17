# outreach

## Responsibility
Turn an assigned, qualified lead into ONE personalized, compliant private message from its owning Xiaohongshu
account, and carry it through review → provider send or human send (spec §12, ARCHITECTURE §6 / §8 C2 / §10.4).
The message quotes the user's real public signal (short verbatim fragment of the primary signal, or the note it was
written under) and only states dealership facts retrieved from Dealer Brain (`answerFact`) with FactRefs. It never
claims `SENT` without a provider-confirmed message id.

## Owning agent
`outreach-agent`

## Inputs
- `prepareOutreach(ctx, leadId, {kind?, actor?})` — lead with an ACTIVE assignment and stage ≥ ASSIGNED.
- `approveOutreach(ctx, outreachId, actor, editedMessage?)`, `sendOutreach(ctx, outreachId)`,
  `markOutreachSentManually(ctx, outreachId, actor)`, `cancelOutreach(ctx, outreachId, actor, reason)`.
- `runSendGuards(ctx, {lead, account_id, message, fact_refs, kind, human_approved?, capability, outreach_id?})`.
- `listOutreachQueue(ctx, {dealer_id, statuses?, account_id?, limit?})` — console review/manual-send queue.
- Skill `outreach`: `{action: 'prepare'|'approve'|'send'|'mark_sent'|'cancel', lead_id?, outreach_id?, kind?, actor?, edited_message?, reason?}`.

## Outputs
`Outreach` rows (message, personalization evidence, fact_refs, guard_results, approval_policy, capability_status,
status, provider_message_id, blocked_reason, approved_by/at, sent_at, sent_by, engine). Queue items add lead summary
(score, tier, stage, data_mode, actor_type), owning account, original signal with source URL, copy-ready text and
Chinese step-by-step manual-send instructions.

## Validation & guarantees
- Composer (`composer.ts`): persona voice per account type (official / salesperson / model_specialist / local_guide /
  customer_story); quote ≤ 18 chars, verbatim, free of contact info, prohibited phrases and anything that would read
  as a price/stock claim; inventory / offer / highlight phrases copied from `answerFact` claims; CTA only 留资卡 /
  预约到店; ≤ 300 chars (optional parts dropped by priority).
- Optional LLM refinement only when `ctx.llm` is AVAILABLE; accepted only if every fact claim and the quote survive
  verbatim, `verifyClaims` and `checkPlatformRules` pass and no contact info appears — else the rules text is used.
  The generation decision records `llm_unavailable | llm_used | llm_rejected: …`.
- Guards in §6 order: ownership · negative_feedback (global suppression, lead suppressed, not_interested evidence or
  inbound refusal, LOST) · duplicate (another live first touch from ANY account; DB unique index race → BLOCKED) ·
  previous_contact (first touch after any sent touch / an inbound reply; follow-up spacing and unanswered-touch limit) ·
  account_health (`isAccountOperable`) · rate_limit (dealer-local daily limit, min interval) · factual_verification
  (`verifyClaims` for the sending account's store) · platform_rules (`checkPlatformRules` dm + near-duplicate ≥ 0.85
  against the account's last 50 messages) · approval_policy · provider_capability.
- Status: blocking failure → BLOCKED; review failures → READY_FOR_REVIEW; all pass (AUTO, score ≥ auto_send_min_score,
  capability AVAILABLE) → sent immediately. Provider ok with id → SENT + lead CONTACTED; unknown outcome / retryable →
  stays APPROVED with the reason; non-retryable failure → FAILED. Capability not AVAILABLE → APPROVED awaiting manual send.
- `markOutreachSentManually` re-runs guards; any blocking failure marks the row BLOCKED and throws `PolicyError
  outreach_blocked`. Success → SENT_MANUALLY, `sent_by`, lead CONTACTED.
- Decisions `outreach_generation` and `outreach_guard`; audit events `outreach.prepared|blocked|approved|sent|
  sent_manually|send_failed|awaiting_manual_send|cancelled`; `refreshNextAction` after every change.

## Runtime entry points
Operator workflows after `assignLead` (lead discovery / signal processing), console outreach queue actions
(审核通过 / 已在小红书发送 / 取消), skill `outreach`. Follow-ups come from the `follow-up` skill.

## Failure modes
- `PolicyError no_active_assignment | lead_not_assigned | outreach_not_reviewable | outreach_not_approved |
  outreach_not_sendable | outreach_blocked | outreach_already_sent`; `NotFoundError`; `ValidationError` (actor/reason/kind).
- Provider exceptions in capability checks become UNAVAILABLE (never assumed AVAILABLE).
- Facts missing in Dealer Brain → the message simply omits them (e.g. "车源我再帮您确认"), never invents them.

## Tests
`node --test test/unit/outreach/*.test.ts` — review path with send capability unavailable, provider send with
simulated capability, AUTO policy, suppression, cross-account duplicates, ownership, rate limit, invented price and
"加微信" edits, manual send accountability, persona differentiation with verbatim quotes, LLM validation fallback,
follow-up timing/limits/idempotency, queue contents.
