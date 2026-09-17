# follow-up

## Responsibility
Plan at most one follow-up private message for each contacted lead that has gone silent, using the same persona
composer, Dealer Brain facts and ten pre-send guards as first touches (spec §12, ARCHITECTURE §6).

## Owning agent
`outreach-agent`

## Inputs
- `findFollowUpCandidates(ctx, dealerId)` — read-only evaluation of every CONTACTED lead of the dealer.
- `planFollowUps(ctx, dealerId)` — creates follow-up outreach for eligible leads.
- Skill `follow-up`: `{dealer_id}`.

## Outputs
- Candidates: `{lead_id, account_id, last_sent_at, days_since_last_touch, unanswered_touches, eligible, reason}` (Chinese reason).
- `Outreach[]` of kind `follow_up` (READY_FOR_REVIEW / APPROVED / SENT / BLOCKED according to the guards).

## Validation & guarantees
- Eligible only when: stage CONTACTED, not suppressed (lead flag or global list), an active owning account, at least
  one SENT/SENT_MANUALLY touch, no inbound message after the last touch, unanswered touches <
  `max_unanswered_touches`, ≥ `follow_up_after_days` since the last touch (effective account policy), no pending
  outreach, and no non-cancelled follow-up created today (dealer-local day) — so repeated runs are idempotent.
- The guard pipeline re-checks spacing, limits, duplicates, ownership and do-not-contact at generation time.
- Wording references the earlier touch, adds at most one verified active offer, and offers an easy opt-out; no pressure.
- Audit event `follow_up.planned` per run (created and skipped leads); decisions come from `prepareOutreach`.

## Runtime entry points
Scheduled `reply_processing` workflow (every 30 min) and the skill `follow-up`.

## Failure modes
`NotFoundError` for an unknown dealer; per-lead `AppError`s (e.g. lost assignment between evaluation and generation)
are recorded as skipped, not thrown.

## Tests
`node --test test/unit/outreach/follow-up.test.ts` — spacing, idempotency, unanswered-touch limit, replied leads and
suppressed leads excluded, guard pipeline applied.
