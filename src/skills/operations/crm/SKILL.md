# crm

## Responsibility
The CRM keeps the sales funnel honest and enforces do-not-contact across the whole system:
- Runs the funnel state machine (ARCHITECTURE §4). Every real stage change writes a `lead_stage_transitions`
  row and an `audit_events(action='lead.stage_changed')` event.
- Keeps a global do-not-contact list (spec §24). When a user says they don't want contact, every
  managed account in every dealer group stops reaching out immediately.
- Records conversions (won/lost), taking content and query attribution from the lead and the account
  from its active assignment.
- Works out the recommended next action (Simplified Chinese) shown on every lead card (spec §18).
- Builds a lead timeline from transitions, audit events and agent decisions.

## Owning agent
`crm-agent` (skill category `operations`).

## Inputs
Skill input (`action` decides which other fields apply; fields are validated per action with `v.*`):

| action | fields |
|---|---|
| `transition` | `lead_id`, `to` (LeadStage), `reason?` (default `''`), `actor?` (default `agent:crm-agent`) |
| `suppress` | `platform_user_id`, `reason`, `source`, `actor?`, `platform?` (default `xiaohongshu`) |
| `convert` | `lead_id`, `outcome` (`won`/`lost`), `amount?` (integer CNY ≥ 0), `vehicle_id?`, `lost_reason?`, `actor?` |
| `reopen` | `lead_id`, `to` (`CANDIDATE`/`QUALIFIED`), `reason?`, `actor` (must be `operator:<name>`) |
| `refresh_next_action` | `lead_id` |

`reopen` and `refresh_next_action` are additive to the contract, which lists only `transition`, `suppress` and `convert`.

## Outputs
- `transition` → `{action, lead, changed, transition}`
- `suppress` → `{action, suppression, created, leads_updated, outreach_cancelled, conversations_closed, messages_discarded, engagement_replies_cancelled}`
- `convert` → `{action, conversion, lead}`
- `reopen` / `refresh_next_action` → `{action, lead}`

## Validation & guarantees
Funnel rules, all checked by an exhaustive 14×14 test:

| from \ to | same | shallower | deeper non-terminal | WON | LOST |
|---|---|---|---|---|---|
| non-terminal | no-op | no-op | change | change if from ≥ CONTACTED, else `PolicyError('invalid_transition')` | change |
| WON | no-op | no-op | – | no-op | `invalid_transition` (WON is terminal) |
| LOST | no-op | no-op | no-op | `invalid_transition` (reopen first) | no-op |

- A no-op returns `changed:false` and writes nothing (not even `updated_at`).
- A do-not-contact user never re-enters the funnel. If a real change targets a non-terminal stage while the lead is flagged
  `suppressed` or its user is on the global `contact_suppressions` list, `transitionLead` throws
  `PolicyError('contact_suppressed')`. LOST (and WON as a recorded fact) stay allowed. No-ops on a LOST suppressed lead stay
  silent, so late discovery or reply calls never throw.
- Each change happens in one `ctx.db.tx`: update `stage` (+ `lost_reason` for LOST, or `未说明原因` when no reason is
  given), recompute `next_action`, insert the transition row, and add the `lead.stage_changed` event `{from, to, reason, transition_id}`.
- `reopenLead` works only on LOST leads, only for an `operator:<name>` actor, and never for a lead that is
  `suppressed` or globally suppressed (`operator_required`, `invalid_transition`, `contact_suppressed`).
  It clears `lost_reason`.
- `suppressContact` runs in one transaction and is idempotent. The unique index on `(platform, platform_user_id)`
  makes the list global. It cascades to:
  - every lead of that user in any group: `suppressed=true`, `suppression_reason`, stage → LOST with reason
    `do_not_contact: <reason>`, and the WON stage is kept
  - outreach in DRAFT, READY_FOR_REVIEW, APPROVED or FAILED (FAILED can be retried or sent by hand) → `CANCELLED` with
    `blocked_reason` set (SENT, SENT_MANUALLY and BLOCKED history is left alone)
  - open or handed-off conversations → `closed`, `needs_human=false`, `handoff_reason='do_not_contact'`
  - draft messages → `discarded`
  - pending public engagement replies to that user's comments → `CANCELLED`

  Events written: `contact.suppressed` on first call, `contact.suppression_reapplied` when a repeat call still
  cascaded something, plus `lead.suppressed`, `outreach.cancelled`, `conversation.closed`, `engagement_reply.cancelled`.
  A repeat call keeps the original suppression row and reason. It still applies the cascade to records created
  since the first call, and writes nothing when there is nothing new. `platform_user_id` is stored exactly as given
  (ids are opaque, never trimmed), so `isSuppressed` finds it. Any failure rolls back the whole cascade (tested).
- `getLeadTimeline` includes the global suppression events, but narrows their cascade id lists
  (`leads_updated`, `outreach_cancelled`, …) to this lead's own records, so another dealer group's ids never show. The
  stored audit row is not changed.
- `recordConversion`: `won` requires CONTACTED or deeper, and `lost` requires a non-terminal stage; both use the same state
  machine, and recording a second conversion on a terminal lead is rejected. The vehicle must exist (`NotFoundError`) and belong
  to the lead's group (`ValidationError`). Attribution comes from `lead.attributed_post_id` / `attributed_query_id`, and `account_id`
  from the active `lead_assignments` row. A won `amount` updates `lead.estimated_value`. Writes the `lead.converted` event.
- `computeNextAction` checks in this order:
  1. suppressed → `勿扰：已停止所有触达`
  2. WON → `已成交`
  3. LOST → `已流失：<reason>`
  4. conversation with `needs_human` → `人工接管对话：<handoff_reason>`
  5. otherwise by stage:
     - DISCOVERED `评估公开信号：判断购买意向` · CANDIDATE `继续观察：等待更多购买信号` · QUALIFIED `分配最合适的账号`
     - ASSIGNED / OUTREACH_READY: by the latest outreach
       - READY_FOR_REVIEW `审核私信：通过后在小红书发送`
       - APPROVED `在小红书App中发送已审核私信并标记已发送` (or `私信已审核通过：等待系统发送` when send capability was AVAILABLE)
       - BLOCKED `私信被拦截：<blocked_reason>`
       - none `生成个性化私信`
     - CONTACTED:
       - a pending follow-up → `审核跟进私信：…`
       - otherwise `等待回复（N天后跟进）`, counted from the last sent touch and the dealer's `follow_up_after_days`
       - `已到跟进时间：准备跟进私信` once due
       - a pause message after `max_unanswered_touches`
     - REPLIED `处理客户回复` · SALES_QUALIFIED `发送留资卡/名片获取联系方式` · CONTACT_ACQUIRED `电话邀约到店`
     - APPOINTMENT `确认到店：<M月D日（周X）HH:MM | time_text | 时间待定>` in the dealer's timezone (`客户未到店：重新邀约` after a no-show)
     - VISITED `跟进报价与谈判` · NEGOTIATING `推进成交`

## Runtime entry points
Skill name `crm`, exported from `src/skills/operations/crm/index.ts`:
```ts
STAGE_INDEX: Record<LeadStage, number>; STAGE_WIN_PROBABILITY: Record<LeadStage, number>
TERMINAL_STAGES; REOPEN_TARGETS; SUPPRESSION_NEXT_ACTION; DO_NOT_CONTACT_REASON_PREFIX; CRM_ACTIONS
isTerminalStage(stage): boolean; stageAtLeast(stage, min): boolean
canTransition(from, to): boolean
transitionLead(ctx, leadId, to, {reason, actor}): {lead, changed, transition}
reopenLead(ctx, leadId, 'CANDIDATE'|'QUALIFIED', {reason, actor}): Lead
isSuppressed(ctx, platformUserId, platform?): ContactSuppression | null
suppressContact(ctx, {platform_user_id, reason, source, actor, platform?}): SuppressContactResult
recordConversion(ctx, {lead_id, outcome, amount?, vehicle_id?, lost_reason?, actor}): Conversion
computeNextAction(ctx, lead): string; refreshNextAction(ctx, leadId): Lead
getLeadTimeline(ctx, leadId): {transitions, events, decisions}
skill
```
Callers:
- Conversation agent (`not_interested`) → `suppressContact`
- Lead discovery / dedup → `transitionLead` (no-ops are safe for LOST or WON leads), plus `isSuppressed` before creating leads
- Outreach guards (`negative_feedback`) → `isSuppressed`
- Analytics → `STAGE_WIN_PROBABILITY`
- Lead inbox → `computeNextAction` / `getLeadTimeline`

## Failure modes
- `ValidationError`: unknown stage, missing actor, reason, source or platform user, bad amount, vehicle from another group, invalid skill input.
- `NotFoundError`: unknown lead or vehicle.
- `PolicyError`:
  - `invalid_transition`
  - `operator_required`
  - `contact_suppressed`: reopen, or a forward move of a do-not-contact user's lead
- Any error inside a transaction rolls back every write of that call.
- Lead-creating modules should call `isSuppressed` before creating a lead for a user first seen after a suppression.
  Otherwise their later forward `transitionLead` calls fail with `contact_suppressed`; `suppressContact` sweeps such leads to LOST.
- The follow-up countdown uses dealer-level `follow_up_after_days` (0 = due immediately) and `max_unanswered_touches`,
  not per-account overrides.
- Moving a lead to LOST (without suppression) does not cancel its pending outreach; the outreach module owns that decision.

## Tests
- `test/unit/crm/funnel.test.ts`:
  - constants
  - exhaustive transition matrix (rows and audit written only on change)
  - forward jump and idempotency; WON from ASSIGNED rejected; LOST terminal
  - suppressed contacts blocked from moving forward
  - rollback when the audit write fails
  - reopen rules (operator only, not suppressed); skill validation
- `test/unit/crm/suppression.test.ts`: cascade across three groups for the same `platform_user_id`
  - READY_FOR_REVIEW, DRAFT and APPROVED outreach cancelled; SENT and BLOCKED untouched
  - conversation closed, draft discarded and inbound kept; engagement reply cancelled
  - WON lead not moved to LOST; bystander untouched
  - FAILED outreach cancelled; exact id round-trip; atomic rollback
  - idempotent repeat, later re-cascade, validation, skill
- `test/unit/crm/conversion.test.ts` also covers a follow-up delay of 0 and timeline scoping across dealer groups
- `test/unit/crm/conversion.test.ts`:
  - conversion attribution and active account; won-before-contact rejected; loss reasons
  - amount and vehicle validation
  - next-action strings for every stage, outreach status, follow-up countdown, hand-off and appointment time
  - `refreshNextAction`, `getLeadTimeline`, skill convert and refresh
