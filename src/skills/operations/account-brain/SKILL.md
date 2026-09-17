# account-brain

## Responsibility
Independent "brain" per Xiaohongshu account (spec §1): identity, account type, persona (tone, voice rules,
target customers, focus brands/models, positioning, content mix, goals, signature phrases, taboo topics),
location, recent content, lead ownership, latest health, and historical performance computed from real
tables. Guarantees accounts do not behave like clones and gives the Fleet Controller, content planning and
outreach the effective per-account policies.

## Owning agent
`account-strategy-agent` (skill `account-brain`, category `operations`).

## Inputs
- Skill input: `{ account_id: string }`.
- `listFleet(ctx, { dealer_id?, group_id? })`.
- `updatePersona(ctx, accountId, patch: Partial<AccountPersona>, actor)` — actor such as `operator:<name>`.

## Outputs
- `AccountBrain { account, persona, health: AccountHealth | null, performance: AccountPerformance,
  recent_posts: Post[] (≤10, newest first by published_at/scheduled_for/created_at) }`.
- `AccountPerformance`:
  - `posts_published_30d`, `avg_engagement_30d` (likes+collects+comments+shares per published post)
  - `leads_owned_active` — active assignments on leads not WON/LOST and not suppressed
  - `outreach_sent_30d` — SENT / SENT_MANUALLY with `sent_at` in window
  - `replies_30d` — conversations of this account with an inbound message in window
  - `reply_rate_30d` — contacted leads (sent in window) that replied after the first send ÷ contacted leads
  - `appointments_90d` — non-cancelled appointments created in window
  - `won_90d` — distinct leads won in window with `conversion.account_id` = account, or unattributed
    conversions whose lead was assigned to the account at `occurred_at`
  - `conversion_rate_90d` — won ÷ distinct leads owned at any point in the 90-day window
  - `negative_feedback_7d` — distinct platform users suppressed in the last 7 days (from
    `contact_suppressions` and `audit_events` action `contact.suppressed`) that this account had sent
    outreach to (or whose event names this account)
- `OutreachPolicy { policy, daily_limit, min_interval_minutes, max_unanswered_touches, follow_up_after_days,
  auto_send_min_score, timezone }` and publish policy `{ policy, daily_limit, timezone }`.

## Validation & guarantees
- Windows are rolling (inclusive lower bound) relative to `ctx.clock`; empty history → all zeros, never NaN.
- Policy merge: complete dealer settings (defaults filled) with non-null account overrides
  (`outreach_approval_policy`, `daily_outreach_limit`, `daily_publish_limit`); an explicit `0` is an
  override.
- `updatePersona` validates every field (non-empty tone/name/positioning, string lists, a non-empty
  content_mix of valid pillars summing to 1, integer goals), rejects read-only (`id`, `account_id`,
  `updated_at`) and unknown fields, writes only changed fields in a transaction and records
  `account.persona_updated` with before/after; a no-op patch writes nothing.
- Persona edits survive the daily Dealer Brain re-import: `importDealerBrain` only seeds missing personas
  unless called with `persona_mode: 'overwrite'` (then audited as `account.persona_updated` by
  `system:dealer-brain-import`), and never loosens an account's live `status` / `auth_state`.
- An account created without a persona receives a persisted account-type baseline persona on first read
  (audit event `account.persona_created`) so every AccountBrain has a persona row.

## Runtime entry points
Skill name `account-brain` (`export const skill`). Functions: `getAccountBrain`, `listFleet`,
`getAccountPerformance`, `effectiveOutreachPolicy`, `effectivePublishPolicy`, `updatePersona`,
`ensurePersona`, `requireAccount`.

## Failure modes
- `NotFoundError` for unknown account (or its dealer).
- `ValidationError` for invalid persona patches (no partial writes).
- Metrics reflect only what other modules persisted (e.g. engagement requires collected post metrics;
  suppression attribution requires sent outreach or `details.account_id` on the audit event).

## Tests
`test/unit/brain/account-brain.test.ts` — distinct personas across the 6 Hangzhou accounts (tone +
focus_models unique, content mix sums), zero metrics without history, baseline persona creation,
persona updates with audit and validation, policy merging and overrides, full 7/30/90-day performance
scenario with in/out-of-window rows across accounts, window boundary behaviour, recent-post cap, skill
invocation.
