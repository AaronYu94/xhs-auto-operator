# account-health

## Responsibility
Daily risk snapshot per Xiaohongshu account (spec §24 account health). Protects accounts from bans and
harassment-style behaviour by turning real activity (messages sent today, negative feedback, reply rate,
authorization, account status) into a `HEALTHY | WATCH | AT_RISK | RESTRICTED` state that the Fleet
Controller uses for assignment and the outreach guard pipeline uses for check 5 (`account_health`).

## Owning agent
`fleet-controller` (skill `account-health`, category `operations`).

## Inputs
- Skill input: `{ dealer_id: string }` → computes every account of the dealer.
- `computeAccountHealth(ctx, accountId)`, `getLatestHealth(ctx, accountId)`, `isAccountOperable(ctx, accountId)`.

## Outputs
`AccountHealth` rows (one per account per dealer-local date): `health_score` 0..100, `state`,
`outreach_sent_today` (SENT/SENT_MANUALLY with `sent_at` inside the local day), `publish_today`
(PUBLISHED posts inside the local day), `negative_feedback_7d`, `reply_rate_30d`, `conversion_rate_90d`,
`active_leads` (from account-brain performance), `issues` (Chinese), `computed_at`.
`isAccountOperable` → `{ ok, blocking, reason }`.

## Validation & guarantees
State rules (first matching severity wins):

| state | conditions |
|---|---|
| RESTRICTED | account `status = disabled` |
| AT_RISK | `auth_state = requires_auth` · `negative_feedback_7d ≥ 3` · `outreach_sent_today ≥ daily limit` (limit 0: any send) |
| WATCH | status `paused`/`cooldown` · `reply_rate_30d < 0.05` with ≥ 10 sent in 30 days · `outreach_sent_today ≥ 80%` of limit · `negative_feedback_7d ≥ 1` |
| HEALTHY | otherwise |

- `health_score = 100 − penalties`, clamped into the state band: HEALTHY 80–100, WATCH 60–79,
  AT_RISK 30–59, RESTRICTED 0–29 (`HEALTH_SCORE_BANDS`; also enforced by the skill's `validateOutput`).
  Reaching the daily publish limit adds an informational issue and a small penalty.
- The daily limit is the effective outreach limit (dealer settings merged with account override).
- Upsert by `(account_id, date)` in one transaction; every computation records an `agent_decisions` row
  (`decision_type = 'account_health'`, engine `rules`, inputs, findings as evidence, output) and
  an `account.health_changed` audit event whenever the state differs from the previous snapshot
  (including the first one).
- `isAccountOperable` is read-only (writes no snapshot, decision or event) and evaluates the SAME rules LIVE
  from real tables: disabled / RESTRICTED → `blocking: true`; `requires_auth`, AT_RISK (≥ 3 negative responses
  in 7 days, daily outreach limit reached), paused or cooldown → `ok: false, blocking: false` (route to
  review) with the Chinese finding as reason; otherwise ok. It therefore never depends on whether the daily
  snapshot has been computed yet, a stale snapshot never keeps a re-enabled account blocked, and daily limits
  reset at dealer-local midnight.

## Runtime entry points
Skill name `account-health` (`export const skill`). Functions: `computeAccountHealth`,
`computeFleetHealth`, `getLatestHealth`, `isAccountOperable`, pure `evaluateAccountHealth`,
`HEALTH_SCORE_BANDS`.

## Failure modes
- `NotFoundError` for unknown account/dealer.
- A daily outreach limit of 0 is AT_RISK only once something was actually sent (a zero limit with nothing
  sent is not a breach); the outreach `rate_limit` guard still refuses to send at limit 0.
- Negative feedback is attributed only to accounts that sent outreach to the suppressed user (or that an
  audit event names); suppressions of never-contacted users do not affect any account.

## Tests
`test/unit/brain/account-health.test.ts` — healthy fleet with audited decisions, requires_auth, 80% and
100% of the daily limit with dealer-local day boundaries and account override, negative feedback
thresholds and 7-day expiry, disabled/paused/cooldown with operability, low reply rate sample size,
per-day upsert and next-day reset, live operability without a snapshot (negative feedback, limit reached,
stale snapshot vs re-enabled account), score-band invariant across 720 input combinations, skill invocation
with persisted/audited snapshots and output validation.
