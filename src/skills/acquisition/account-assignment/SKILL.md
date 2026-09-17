# account-assignment

## Responsibility
Fleet Controller (spec §11, ARCHITECTURE §5.3 and §8 B5). For every Qualified lead it picks exactly ONE owning
Xiaohongshu account out of the dealer's fleet, explains why, and keeps that ownership exclusive and sticky so
that "five dealer accounts never independently spam the same user" (spec §10). Ranking weighs dealer location,
model specialization, persona / account type, historical response rate, historical conversion rate, current lead
load, previous contact, lead ownership and account health.

## Owning agent
`fleet-controller` (skill `account-assignment`, category `acquisition`).

## Inputs
- Skill input: `{ lead_id: string; reassign_to?: string; actor?: string; reason?: string }`
  (`reassign_to` is the operator action; `actor` defaults to `agent:fleet-controller`).
- `rankAccountsForLead(ctx, lead)`, `assignLead(ctx, leadId, { reassign_to?, actor?, reason? })`,
  `getActiveAssignment(ctx, leadId)`, `releaseAssignment(ctx, leadId, reason, actor)`.
- Reads: `leads` (score, stage, merged intent, evidence, actor_type), `lead_signals` (transaction questions of
  purchase signals; IP 属地 of the source comment/post), `xhs_accounts`, `account_personas` (focus models/brands),
  account-brain performance (`getAccountPerformance`, `effectiveOutreachPolicy`), today's `account_health`
  snapshot (computed through `computeAccountHealth` when missing or stale; live operability via
  `isAccountOperable`), `outreach` / `conversations` (stickiness), the dealer's active scoring config (qualified
  threshold), `contact_suppressions`, previous `account_assignment` decisions (failure de-duplication).

## Outputs
`AssignmentCandidate[]` — one per account, each with `score` (0..100, exactly the sum of its factors), `eligible`,
`excluded_reason` and seven `ScoreComponent`s with Chinese reasons:

| factor | max | rule |
|---|---|---|
| location | 20 | account city = lead city → 20 · same province (stated province, a province written in the location field, or the IP 属地) → 12 · lead location unknown (or a city whose province cannot be determined) → 10 · else 0 · accounts of another dealer in the group → 0. City/province text is normalized (`杭州市西湖区` → 杭州, `浙江省` → 浙江, `魔都` → 上海). The reason names the source: stated, `地域由所在帖子内容推断`, or `客户IP属地…` |
| model_specialization | 20 | lead model unknown → 10 · model in persona focus with ≤ 3 focus models → 20 · in a broader focus list (or a compared model is in focus) → 12 · brand match only → 8 · else 0. Brands are canonicalized (`宝马` → BMW) and the lexicon brand of a known model wins over a merged intent brand |
| persona_fit | 15 | transactional (inventory/price/landing/discount/finance/lease/trade-in/dealer selection/visit, or stage price_shopping/active_shopping/dealer_selection/purchase_imminent): salesperson 15 · model_specialist 10 · official 8 · local_guide 6 · customer_story 4 — research/comparison (or unknown stage): model_specialist 15 · local_guide 11 · salesperson 9 · customer_story 8 · official 7 — awareness: customer_story 12 · local_guide 12 · model_specialist 9 · official 8 · salesperson 6 |
| response_rate | 10 | fewer than 5 messages sent in 30 days → prior 5 · else `10 × min(1, reply_rate_30d / 0.5)` |
| conversion_rate | 10 | fewer than 3 distinct leads contacted in 90 days → prior 5 · else `10 × min(1, conversion_rate_90d / 0.2)` |
| load | 10 | `10 × (1 − min(1, active_leads / capacity))`, capacity = 5 × effective daily outreach limit (the lead itself is not counted against its current owner) |
| health | 15 | HEALTHY 15 · WATCH 9 · AT_RISK 3 · `requires_auth` → 3 with reason "需重新登录" (still eligible) · disabled / paused / cooldown / RESTRICTED / other group → 0 and ineligible |

Sorting: eligible accounts first, then score desc, ties by account `created_at` asc (then insertion order).

`assignLead` → `{ assignment: LeadAssignment | null, candidates, changed, reason }` and, when it creates an
owner, a `lead_assignments` row (`active`, `reason` = Chinese summary of the top factors, `candidates` = the full
ranking, `assigned_by` = actor), lead stage → `ASSIGNED` via `transitionLead` (no-op for deeper stages), audit
`lead.assigned`, and an `agent_decisions` row (`account_assignment`, agent `fleet-controller`) with inputs (lead
score/tier/stage, intent, intent class, lead location incl. its source, dealer), evidence (lead evidence), output
(ranking with factors, chosen account, reason, margin, cancelled outreach) and confidence `0.5 + margin/30` where
margin = chosen score − best other eligible score (clamped 0.05..0.99, so a non-top choice is < 0.5; 0.9 when the
choice is the only eligible account; 0.95 for a sticky owner; 1 for an `operator:` reassignment, engine `human`).

## Validation & guarantees
- Guards (no rows written, `candidates: []`): suppressed lead or user on the global do-not-contact list; stage
  WON or LOST; an industry / dealer-sales account (`actor_type` DEALER_OR_SALES or evidence `industry_account`) that
  is not yet CONTACTED (reason `线索为车商/销售等行业账号，非购车客户，不分配账号`; as in lead-research an existing
  conversation is not orphaned); `score < qualified` threshold of the dealer's active scoring config for leads that
  are not yet CONTACTED (leads already in a sales conversation are qualified by the funnel, so an operator can still
  reassign them after their public-signal score decays). Guards apply to `reassign_to` too.
- Routing (§5.3): only accounts of `lead.dealer_id` are ranked; other dealers of the same group are ranked (with
  location 0) only when that dealer has no eligible account.
- Health freshness: today's (dealer-local date) snapshot is reused only while it is current. It is recomputed when
  missing, when the account or its dealer changed after `computed_at`, or when the live operability
  (`isAccountOperable`) disagrees with the snapshot state — so a re-enabled or re-authenticated account is eligible
  again at once and new negative feedback / a reached daily limit lowers health immediately. An unchanged fleet
  writes no extra health decisions.
- Exclusivity: an existing active assignment is kept (`changed: false`, fresh candidates returned). The insert
  re-checks inside `BEGIN IMMEDIATE` and relies on the partial unique index `uq_active_assignment`; a UNIQUE
  conflict from a concurrent writer is caught and the winning owner is returned.
- Stickiness: without an active owner, the account with the most recent SENT/SENT_MANUALLY outreach or
  conversation with the lead is the forced owner; if it is ineligible the result is `assignment: null` with
  reason `原负责账号不可用，需人工重新分配`, audit `lead.assignment_failed` and a decision.
- Reassignment (`reassign_to`): unknown account → `NotFoundError`; account of another group → `PolicyError
  account_not_in_group`; ineligible account → `PolicyError account_ineligible` (nothing changes). Otherwise ONE
  transaction releases the current owner (`released_at`, `released_reason` = operator reason or default), cancels
  undelivered outreach (DRAFT / READY_FOR_REVIEW / APPROVED) of any other account with `blocked_reason
  '线索已重新分配'` (+ `outreach.cancelled` events), creates the new assignment, and writes
  `lead.assignment_released`, `lead.assigned` and the decision. Reassigning to the current owner is a no-op.
- Every new owner (ranked, sticky or reassigned) cancels undelivered outreach of other accounts left behind by an
  earlier owner (`线索已由其他账号负责，原账号的待发私信作废`), in the same transaction, so a stale live first touch can
  neither be sent nor block the new owner's first touch (`uq_live_first_touch`).
- No eligible account → `assignment: null`, reason listing the exclusion reasons, audit `lead.assignment_failed`
  plus a decision. A repeated identical failure (same reason, no decision since) is not recorded again.
- `releaseAssignment` is idempotent (no active owner → no-op), cancels that account's undelivered outreach
  (so the new owner's first touch is not blocked by `uq_live_first_touch`) and writes `lead.assignment_released`.
- The skill's `validateOutput` enforces: non-empty reason, returned assignment active, a new owner is an eligible
  ranked candidate, and every candidate's score equals the sum of its factors within 0..100.

## Runtime entry points
Skill name `account-assignment` (`export const skill`), invoked by the operator's signal-processing workflow after
lead scoring/research and by the operator UI for reassignment. Functions: `rankAccountsForLead`, `assignLead`,
`getActiveAssignment`, `releaseAssignment`; additive exports `classifyLeadIntent`,
`assignmentConfidence(candidates, chosenAccountId?)`, `summarizeFactors`, `ASSIGNMENT_FACTOR_MAX`,
`PERSONA_FIT_POINTS`, calibration constants, `PENDING_OUTREACH_STATUSES`, `REASSIGN_CANCEL_REASON`,
`ORPHAN_OUTREACH_CANCEL_REASON`, `STICKY_UNAVAILABLE_REASON`, `INDUSTRY_ACCOUNT_REASON`, `DEFAULT_ASSIGNER`, types
`LocationSource`, `AssignLeadOptions`, `AssignLeadResult`, `AssignmentMode`, `AccountAssignmentInput`.

## Failure modes
- `NotFoundError` for an unknown lead, dealer or reassignment target; `ValidationError` for an empty release
  reason/actor; `PolicyError` for reassignment to an out-of-group or ineligible account.
- Ranking computes today's health snapshot for accounts without a current one (this writes the account-health
  snapshot and its own audited decision) and creates a baseline persona for accounts imported without one
  (account-brain).
- An active owner that has since become unavailable is NOT silently replaced (the relationship belongs to it);
  the reason recommends manual reassignment.
- If several accounts contacted the same lead (data imported from before exclusivity), the most recent contact
  wins stickiness.
- FAILED outreach of a released account is not cancelled (it is a delivery record; any retry or manual send is
  blocked by the `ownership` pre-send guard).

## Tests
`test/unit/fleet/ranking.test.ts` — spec example ranking for a Hangzhou i3 eDrive35L inventory lead (销售小王 #1 >
i3电车研究所 > 官方号, factor values and score = Σ factors), X3 price lead → 李姐聊宝马, research/comparison i3 lead →
i3电车研究所, sh-bmw lead ranks only Shanghai accounts (赵哥 requires_auth → health 3 "需重新登录", 上海官方 wins),
location rules (unknown, out-of-province, IP 属地), paused/cooldown/disabled exclusion, load factor on a busy
account, reply/conversion priors vs history, group fallback with location 0, intent classification.
`test/unit/fleet/assignment.test.ts` — assignment row/stage/audit/decision contents and confidence, exclusivity
(idempotent repeat, index blocks a second active row, simulated race returns the winner), stickiness to a contacted
account (outreach and conversation) and to an unavailable one, reassignment (release, pending outreach cancelled,
sent outreach kept, audit/decision, ineligible/unknown targets refused atomically), guards (suppressed, global
suppression, unqualified, LOST, WON, CONTACTED lead with a decayed score), no eligible account, releaseAssignment,
and invocation through the skill registry.
`test/unit/fleet/hardening.test.ts` — stale same-day health snapshots (re-enabled, re-authenticated, new negative
feedback, reuse without extra decisions, Asia/Shanghai day boundary), location normalization (省/市/district
suffixes, province in the location field) and honest location sources (IP 属地 vs post context), brand
canonicalization, cancellation of orphaned outreach on a new owner, industry-account guard (and not orphaning an
existing conversation), created_at tie-break for added candidates, confidence of a non-top choice, failure
de-duplication, most-recent-contact stickiness, reassignment without an owner, `validateOutput` tamper detection.
