# account-strategy

## Responsibility
Per-account content strategy (spec §1 Account Brain, §15 "Account Strategy", §16 content → lead attribution): decide
which content pillars each Xiaohongshu account should emphasize next, and why, so accounts never behave like clones
and effort shifts toward content that actually produces qualified leads — not likes.

## Owning agent
`account-strategy-agent` (skill `account-strategy`, category `content`).

## Inputs
- Skill input: `{ account_id: string; goal?: GoalSpec; goal_id?: string | null }`.
- `buildAccountStrategy(ctx, accountId, { goal?, goal_id? })` — when only `goal_id` is given the stored
  `operator_goals.spec` is used (it must belong to the account's dealer).

## Outputs
`ContentPlan['strategy']`:
- `positioning` — the persona's content positioning.
- `pillars[]` — `{ pillar, weight, rationale }`, weights normalized to 1 (3 decimals), sorted by weight; every rationale
  is Chinese and cites each driver ("人设内容配比30%；目标车型i3属于本账号主推车型（销售号目标加权×1）+12%；内容→线索归因：
  …；最终权重23.5%").
- `focus_models` — persona focus ∩ dealer-carried models (canonical names), goal models first.
- `research_insights` — up to 5 headlines of the dealer's latest research briefs (≤ 30 days old, relevant to the focus,
  with public data: a newer brief from a run without any corpus — e.g. a provider outage — never masks an older
  informative brief and never becomes a strategy insight).
- `goal_id` when provided.

## Validation & guarantees
Weight computation (deterministic):
1. Base = persona `content_mix` normalized (account-type fallback pillars only when the mix is empty).
2. Goal: if the goal models intersect the account's focus models, `model_review`, `price_offer` and
   `inventory_showcase` each get `+0.12 × GOAL_STRENGTH` (salesperson 1, model_specialist 1, official 0.6,
   local_guide 0.4, customer_story 0.25). Accounts without the goal models are unchanged.
3. Research (latest xhs / competitor briefs that had public data, `latestBrief(..., { with_data: true })`): buyer finance/lease/trade-in question mentions ≥ 2 and ≥ 15% of question
   mentions → `finance_explainer +0.1 × fit × min(1, share/0.3)`; model-comparison questions (same thresholds) or
   competitor co-mentions ≥ 2 → `comparison +0.1 × fit × intensity`. `PILLAR_FIT` scales by account type.
4. Attribution (this account's PUBLISHED posts, last 90 days): qualified leads per post = leads with
   `attributed_post_id` at QUALIFIED or deeper (LOST counts only if it had reached QUALIFIED+). When the account has any
   qualified leads: pillars with ≥ 2 posts and 0 qualified leads ×0.8; each pillar with leads
   `+0.3 × (its leads-per-post ÷ Σ leads-per-post)`. Engagement adds at most `+0.03` in total (tie-breaker only), so
   lead outcomes always outweigh likes.
5. Normalize, drop pillars < 0.05, renormalize, round (sum exactly 1).
- Records one `content_strategy` decision per call (agent `account-strategy-agent`, subject account) with base mix,
  goal, briefs used, research signals, per-pillar attribution, output strategy and dropped pillars; evidence references
  research briefs and attributed post titles (verbatim).
- Skill `validateOutput`: non-empty pillars, weights sum to 1, each ≥ 0.05 with a rationale.

## Runtime entry points
- `buildAccountStrategy(ctx, accountId, opts?)` (contract API), `resolveGoal`, `strategyFocusModels`,
  `pillarAttribution(ctx, accountId)`, `normalizePillarWeights(weights)`, constants (`GOAL_STRENGTH`, `PILLAR_FIT`,
  `GOAL_BOOST`, `RESEARCH_BOOST`, `ATTRIBUTION_BOOST`, `ENGAGEMENT_BOOST`, `NO_LEAD_PENALTY`, `MIN_PILLAR_WEIGHT`).
- Called by `content-planning` for every planned account; skill `account-strategy` for the Operator
  (`account_planning` workflow, 09:00).

## Failure modes
- `NotFoundError` for an unknown account or goal id; `ValidationError` for a malformed goal or a goal of another dealer.
- Stale research (> 30 days) and briefs whose scope does not cover the account's focus are ignored.
- An account without published posts or leads keeps its persona/goal/research weights (no attribution driver).

## Tests
`test/unit/content-planning/account-strategy.test.ts` — six Hangzhou accounts produce six distinct pillar sets/weights
summing to 1 with Chinese rationales; focus models = persona ∩ carried with goal models first; an i3 goal boosts the
salesperson and model-specialist most, the official account less and leaves the X3/X1 salesperson unchanged; goal_id
loading and cross-dealer rejection; research briefs raise finance_explainer / comparison; attribution shifts weight
toward the pillar whose published posts produced qualified leads even when another pillar has far more likes; LOST
leads that never qualified do not count; audited decision; skill invocation and validation.
`test/unit/content-planning/planning-hardening.test.ts` — a newer brief without data neither masks an older informative
brief nor appears in `research_insights`.
