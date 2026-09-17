# content-planning

## Responsibility
Turn every active account's strategy into a concrete, de-cannibalized content calendar (spec §15 "Content Plan",
"avoid content cannibalization across accounts", §20 09:00 account plans): PLANNED post slots with pillar, model,
persona-specific angle and topic key, ready for post generation (C4).

## Owning agent
`account-strategy-agent` (skill `content-planning`, category `content`).

## Inputs
- Skill input: `{ dealer_id: string; period_start: 'YYYY-MM-DD'; days?: 1..31 (default 7); goal_id?: string | null;
  replace?: boolean }`.
- `planContent(ctx, { dealer_id, period_start, days?, goal_id? }, { replace? })`.

## Outputs
`{ plans: ContentPlan[]; posts: Post[] }` — one plan per planned account (`status 'active'`, `strategy` from
`buildAccountStrategy`, `workflow_run_id = ctx.runId`) and all posts of the returned plans (sorted by date and planning
order). New posts: `status 'PLANNED'`, empty title/body/tags/cover, `approval_policy` from `effectivePublishPolicy`,
zero metrics, `engine 'rules'`, `topic = '<model>:<pillar>:<angle>'` ('general' when the account has no carried focus
model).

## Validation & guarantees
- Accounts: only `status = 'active'` accounts whose `isAccountOperable` is not blocking (disabled / RESTRICTED are
  excluded; the reason is recorded). Accounts requiring re-auth are still planned (publishing handles capability).
- Cadence per account = `clamp(round((persona.goals.monthly_posts ?? 12) / 30 × days), 2, days)` posts in the period,
  spread evenly (`offset_k = floor((k + ½) × days / n)`, via `addDaysToKey`).
- Rolling / overlapping plans are safe (the `account_planning` workflow plans "tomorrow + 7 days" every day): live
  (non-rejected, non-failed) posts of the account on days of the period — progressed posts of this plan, posts of other
  plans, unplanned manual posts; published posts by their dealer-local publish day — count toward the cadence and
  consume the nearest spread dates; an account never gets two posts on one day; and a new slot is placed on the nearest
  day that does not push any overlapping plan period of the account over its own cadence. Fourteen consecutive daily
  runs on the Hangzhou fixture keep every account at exactly its cadence in every 7-day window.
- Pillars for the new slots: largest remainder over each strategy pillar's unmet share of the cadence (pillars already
  covered by existing posts in the period count), interleaved so a pillar does not repeat consecutively; models: the
  least-used focus model among the account's posts in the period (goal models first on ties — plain round-robin when the
  period is empty); angles from `ANGLE_LIBRARY[account_type][pillar]` (city/brand filled, EV vs ICE variants, persona
  taboo topics filtered), rotated by the account's pillar history and its index among same-type accounts.
- De-cannibalization across the dealer's accounts, including existing non-rejected/failed posts (planned or published):
  the same (model, pillar) is never on two accounts within 3 days (|Δdays| ≤ 3) and the same topic key never twice
  within one period length (|Δdays| < days — a sliding window, so overlapping rolling plans hold it too). Slots are
  processed by date, then planning order (model_specialist → salesperson → official → local_guide → customer_story).
  Conflicts are resolved by the next angle, then the next pillar (strategy order), then the next model; if every
  combination conflicts, the account's nearest allowed day in the period is tried; otherwise the slot is dropped. Every
  resolution is recorded in the `content_plan` decision output `conflicts_resolved` (original, resolved, level, reason,
  conflicting post/date/topic).
- Idempotent per (account, period_start): an existing non-archived plan is returned with its posts and nothing is
  written. With `replace: true` its still-PLANNED posts are deleted, posts that progressed (DRAFTED, PUBLISHED …) are
  preserved (only those inside the new period consume slots), the plan row is updated (strategy, period_end, run) and
  the free slots are re-planned.
- Everything runs in one transaction. One `content_plan` decision per run that created or re-planned at least one plan
  (subject dealer; plans with `cadence {target, existing_in_period, planned}` and existing post ids, reused plans,
  excluded accounts, conflicts), plus a `content_plan.created` / `content_plan.replanned` audit event per plan. Each
  planned account also records its `content_strategy` decision.

## Runtime entry points
- `planContent(ctx, input, opts?)` (contract API).
- Pure helpers: `postsForPeriod`, `spreadSlotDates`, `allocatePillars`, `allocateRemainingPillars`, `pillarSequence`,
  `anglesFor`, `topicKey`, `dayDiff`, `postDay`, `nearestAllowedDay`; constants `ANGLE_LIBRARY`,
  `CANNIBALIZATION_WINDOW_DAYS`, `PLANNING_ORDER`.
- Skill `content-planning` for the Operator (`account_planning` workflow, 09:00; goal workflows); followed by C4
  `generatePost` for each PLANNED post.

## Failure modes
- `ValidationError` for malformed input (non-calendar `period_start`, days outside 1..31, goal of another dealer);
  `NotFoundError` for an unknown dealer or goal.
- An existing plan for the same `period_start` but a different length is returned as-is unless `replace` is used.
- A plan whose period is already fully covered by the account's existing posts is still created (so the run stays
  idempotent) with zero new posts; its `cadence` records why.
- A slot whose every model × pillar × angle × allowed day conflicts is dropped (recorded, confidence lowered).

## Tests
`test/unit/content-planning/content-planning.test.ts` — six Hangzhou accounts each get ≥ 2 PLANNED posts with the
expected counts and dates inside the period, no (model, pillar) on two accounts within 3 days and no duplicate topic
keys (also against pre-existing published posts and an overlapping second period), recorded conflict resolutions,
idempotent re-run (no new rows/decisions), replace deletes only PLANNED posts and keeps progressed ones, disabled and
inactive accounts excluded, approval policy and strategy persisted, goal_id models first, pure allocation / spreading /
angle helpers, skill invocation and input validation. `test/unit/content-planning/planning-hardening.test.ts` — four
consecutive daily "tomorrow + 7 days" runs keep every account at exactly its cadence in every planned period with one
post per day and unique topics; an unplanned manual draft counts toward the cadence and keeps its day; replace with a
shorter period does not let a progressed post outside it consume a slot.
