# lead-deduplication

## Responsibility

Identity resolution and lead deduplication (spec §10, ARCHITECTURE §8 B1, §5.1, §5.3). A Xiaohongshu user has
**exactly one lead per dealer group** (`uq_lead_identity (group_id, platform, platform_user_id)`), no matter how
many notes they comment on, how many searches surface them or how many managed accounts see them. Every public
signal is stored verbatim (idempotently) and merged into that single lead: structured intent, evidence with
provenance, first/last seen, attribution, estimated pipeline value. After merging it re-scores the lead, selects
the primary (strongest) signal and advances the funnel to `CANDIDATE` / `QUALIFIED` when the score tier allows —
never demoting, never advancing a suppressed user, never letting a non-purchase remark raise score or stage.

It also applies the group-level dealer matching rule (§5.3): an existing lead moves to the evaluated dealer only
when it has no active assignment and the new purchase signal scores strictly higher there than the lead's score.

## Owning agent

`lead-hunting-agent` (skill category `acquisition`).

## Inputs

`upsertLeadFromSignal(ctx, input)` / skill input (validated by `upsertLeadInputValidator`; the function validates
too, so direct callers get the same guarantees):

| field | notes |
|---|---|
| `dealer_id` | the dealer whose profile evaluated the signal (discovery passes the best-matching group dealer) |
| `identity.platform_user_id` | opaque platform id (not normalized), non-blank |
| `identity.username` | nickname (blank → falls back to the platform id on creation, never overwrites) |
| `identity.profile_url?` | optional, refreshed when given |
| `signal.source_type` | `post` · `comment` · `profile` · `reply` · `import` |
| `signal.public_post_id?` / `public_comment_id?` | internal `public_posts.id` / `public_comments.id` (must exist; a comment's note id and title are filled from the stored rows when omitted) |
| `signal.post_title?`, `content` (non-blank, verbatim) | |
| `signal.signal_at` | ISO-8601 **with an offset** (`2026-09-11T15:30:00Z`, `…+08:00`, `…+0800`), or a wall-clock time **without** an offset (`2026-09-11 23:30[:ss]`, `2026/9/11`, `2026-09-10`) read in the dealer's `settings.timezone` (default Asia/Shanghai — Xiaohongshu shows Beijing time). The host timezone is never used. |
| `signal.query_id?`, `search_run_id?` | provenance for search intelligence |
| `signal.detection` | full `IntentDetection` (`is_purchase_signal`, `intent`, `evidence`, `transaction_questions`, `strength` 0..1, `negative`, `engine`, `is_marketing?`, `author_role?`) |
| `attributed_post_id?` | our own `posts.id` that sourced the lead |

`mergeIntents(base, next)` is pure (`next` = chronologically newer intent). `findLeadByIdentity(ctx, groupId, platformUserId)`.

## Outputs

`UpsertLeadResult`: `{ lead (fresh row), signal (stored row | null), created, merged, stage_changes, duplicate, dealer_rerouted }`
(`duplicate` and `dealer_rerouted` are additive fields).

Persisted effects:
- **Transaction 1 (atomic):** optional `leads` insert (stage `DISCOVERED`, `lead_stage_transitions` row
  `null → DISCOVERED` by `agent:lead-hunting-agent`, audit `lead.created`); optional `lead.suppressed` flag (+ audit
  `lead.suppressed`) when a global suppression exists; `lead_signals` insert with the v2 columns; lead merge update;
  audit `lead.signal_added` (incl. `non_purchase_reason`); audit `lead.dealer_rerouted` (incl. `removed_evidence`)
  when the lead moved.
- After the transaction: `scoreLead` (lead_scores row, score/tier, `lead_score` decision) when the lead was created or
  the signal is a purchase signal; `primary_signal_id`; `transitionLead` to `CANDIDATE` and/or `QUALIFIED` (reason:
  score, tier, threshold and the top evidence labels of the primary signal); `refreshNextAction`.
- Decisions: `lead_dedup_merge` whenever an existing lead received a new signal (inputs: identity, signal content/
  source/ids/`non_purchase_reason`, previous dealer/stage/intent/count/score; evidence: the signal evidence with
  `source_ref = signal id`; output: merged intent, signal count, score & tier before/after, `rescored`, primary signal,
  dealer match, stage changes); `lead_qualification` exactly when the lead first reaches `QUALIFIED` (evidence = lead
  evidence; output: score, tier, lead_score_id, components, reason).

## Validation & guarantees

- **Managed identities:** a `platform_user_id` equal to the `platform_account_id` **or the verified
  `platform_user_id`** (v3) of any `xhs_accounts` row of the dealer's group → `PolicyError('managed_account_identity')`,
  nothing written.
- **Author roles are binding (§5.1):** `intentDetectionValidator` normalizes `is_purchase_signal` to `false` whenever
  the detection is `negative`, `is_marketing`, or has `author_role` owner / creator / marketing — whatever an upstream
  refinement claimed. `nonPurchaseReason(detection)` names the reason; it is recorded in `lead.signal_added` and in the
  `not_a_purchase_signal` error details.
- **Non-purchase signals** never create a lead → `PolicyError('not_a_purchase_signal')`, except `reply` / `import`
  sources. On an existing lead they are stored (with `is_purchase_signal=false`, so re-scoring can never count them)
  and their evidence is kept for history, but they do not change `intent`, are not re-scored (score/tier unchanged)
  and never advance stage.
- **Signal time:** strict parsing (free text, day-first dates and impossible dates such as `2026-02-30` →
  `ValidationError`); a signal time more than `SIGNAL_FUTURE_TOLERANCE_MS` (15 min) after `ctx.clock` →
  `ValidationError` (a future time would keep a lead "fresh" forever and corrupt first/last seen).
- **Signal persistence:** `is_purchase_signal` (normalized), `strength`, `transaction_questions`, `author_role` (null
  when absent) from the detection; `intent` and `evidence` stored exactly as detected; `signal_score =
  scoreSignal(detection, signal_at, now=ctx.clock, dealer profile, active scoring config, authenticity from lead
  evidence)`. The score is computed against the evaluated dealer when the lead is new or moves there, otherwise against
  the lead's dealer, so signal scores of one lead are always comparable. `verified_local_user` evidence only counts
  for a dealer in the IP province it was verified against.
- **Idempotency:** a comment signal is unique by `public_comment_id` (global DB index); a post signal by
  `(lead_id, public_post_id)`; every other signal by `(lead_id, source_type, public_post_id, normalizeText(content))`.
  A duplicate returns `{signal: null, duplicate: true, created: false, merged: false, stage_changes: []}` and writes
  nothing (no score row, event or decision).
- **Identity integrity:** referenced `public_posts` / `public_comments` must exist (`NotFoundError`); a comment (or a
  `post`-sourced note) authored by another user, or a comment already attached to a different lead of the same group →
  `PolicyError('signal_identity_conflict')`; a comment id not belonging to the given post → `ValidationError`.
- **Merge rules (`mergeIntents`):** vehicle merged as a consistent unit — same model combines (stated if either side
  stated it; trim/colour from whichever side has them), different models → more specific side wins (trim over none,
  then stated over inferred, then newer) and the loser's trim/colour are dropped; latest **stated** location wins
  (city+province unit, a compatible city survives a province-only statement, IP-inferred never overrides stated);
  `competing_models` union minus the merged model; boolean intents OR; most advanced `purchase_stage`; min
  `budget_min` / max `budget_max`; max `confidence`; latest timeframe / price sensitivity; `inferred_fields` exactly
  the merged fields whose value is inferred.
- **Chronological, order-independent lead intent:** the lead intent is the chronological fold (`signal_at`, then
  insertion order) of `mergeIntents` over every stored purchase signal plus the signal that created the lead. Signals
  discovered out of order (an old comment surfaced by a later search) therefore never override a newer stated value,
  and the merged intent is identical whatever order the same signals were ingested in.
- **Lead fields:** `evidence = dedupeEvidence(lead.evidence + signal evidence with source_ref = signal id)`;
  `signal_count` recounted; `first_seen_at` = min, `last_signal_at` = max; username / profile_url refreshed;
  `attributed_post_id` / `attributed_query_id` first non-null wins; `estimated_value = resolveVehicle(brand, model,
  trim).msrp` (falls back to the model's entry trim; kept when the model is unknown or not in the catalog).
- **Primary signal:** highest stored `signal_score` among purchase signals (ties → most recent); when a lead has no
  purchase signal (reply/import lead) the strongest stored signal keeps provenance visible.
- **Stage:** tier ≥ candidate → `CANDIDATE`; tier ≥ qualified → `QUALIFIED` (two transition rows when both are reached
  at once); only for purchase signals, never for suppressed leads, never demoting (CRM no-op semantics; WON/LOST untouched).
- **Suppression:** a globally suppressed identity is created with `suppressed=true` + `suppression_reason`; an existing
  lead found suppressed is flagged; neither advances.
- **Dealer move (§5.3):** only for an existing, non-terminal lead, a purchase signal, no active `lead_assignments` row
  and `signal score at evaluated dealer > lead.score`; the reason for (not) moving is recorded in the merge decision.
  On a move, `verified_local_user` evidence whose IP province is not the new dealer's province is dropped
  (`removed_evidence` in `lead.dealer_rerouted`).
- Business time comes from `ctx.clock`; all writes of the upsert itself share one `ctx.db.tx` (no awaits).

## Runtime entry points

`src/skills/acquisition/lead-deduplication/index.ts`

- `upsertLeadFromSignal(ctx: AppContext, input: UpsertLeadInput): UpsertLeadResult`
- `mergeIntents(base: AutomotiveIntent, next: AutomotiveIntent): AutomotiveIntent`
- `findLeadByIdentity(ctx: AppContext, groupId: string, platformUserId: string): Lead | undefined`
- helpers: `selectPrimarySignal(signals)`, `isPurchaseDetection(detection)`, `nonPurchaseReason(detection)`,
  `resolveSignalTime(value, timezone?, path?)` (canonical UTC ISO; wall-clock values in `timezone`), validators
  `upsertLeadInputValidator`, `intentDetectionValidator`, `automotiveIntentValidator`, `evidenceValidator`, constants
  `LEAD_DEDUP_AGENT`, `NON_PURCHASE_CREATING_SOURCES`, `NON_BUYER_AUTHOR_ROLES`, `SIGNAL_FUTURE_TOLERANCE_MS`
- `skill` — name `lead-deduplication`, category `acquisition`, agent `lead-hunting-agent`, input `UpsertLeadInput`,
  output `UpsertLeadResult` (post-conditions: lead present, signal belongs to it, duplicates carry no signal).

Callers: lead-discovery (C1) for every post/comment signal after group-level dealer matching, lead-research for
profile-note signals, conversation (C3) for `reply` signals, manual import.

## Failure modes

- `ValidationError` — malformed input (blank ids/content, unsupported / impossible / future `signal_at`, strength
  outside 0..1, unknown enum values, an invalid dealer timezone for a wall-clock `signal_at`).
- `NotFoundError` — unknown dealer, public post or public comment.
- `PolicyError('managed_account_identity' | 'not_a_purchase_signal' | 'signal_identity_conflict')` — nothing written.
- A comment already stored as a signal of a lead in **another** dealer group cannot be stored twice under the global
  `uq_signal_comment` index; the signal is stored without `public_comment_id` (post id, title and verbatim content kept,
  `comment_shared_with_other_group` recorded in the `lead.signal_added` event) and deduplicated by content afterwards.
- Scoring, stage advancement and decisions run after the upsert transaction: if one of them throws, the stored signal
  and merge remain (the next upsert or `scoreLead` re-applies scoring).

## Tests

- `test/unit/dedup/merge-intents.test.ts` — pure merge rules: trim over none, stated beats inferred, specificity,
  consistent vehicle unit, latest stated location, IP never overrides stated, province-only statements, competing union,
  boolean OR, stage/budget/confidence, `inferred_fields` consistency, no input mutation.
- `test/unit/dedup/upsert-lead.test.ts` — same user on 3 notes → one lead with merged intent, evidence provenance,
  corroborated score, primary signal, value and decisions; idempotent comment / post / content re-ingestion; separate
  leads per group and the cross-group shared comment; managed identity; non-purchase creation rules and history-only
  storage; suppressed identities; DISCOVERED → CANDIDATE → QUALIFIED with transition rows and exactly one
  `lead_qualification`, never demoting; dealer re-routing (moves / active assignment / lower score); v2 columns;
  chronological merge; attribution; validation and identity-conflict errors; registry invocation.
- `test/unit/dedup/hardening.test.ts` — owner / creator / marketing / negative detections flagged as purchase signals
  never create leads and are persisted as non-purchase on existing leads (score/stage/intent unchanged); the verified
  `platform_user_id` of a managed account is rejected; wall-clock timestamps resolved in the dealer timezone (incl. a
  non-Shanghai dealer), explicit offsets kept, malformed / impossible / future timestamps rejected; latest stated
  location wins with late-arriving older signals and the merged intent is identical for every ingestion order; comment
  provenance filled from the stored comment; stale IP-verified evidence dropped on a cross-province re-route.

Run: `node --test test/unit/dedup/*.test.ts`
