# optimization

## Responsibility
Close the learning loop by business outcomes (leads, appointments, wins), never by likes:
1. evolve search queries by measured lead density (`evolveQueries`),
2. advise on scoring thresholds from per-score-band outcomes (recommendation only),
3. rank content pillars by the qualified leads / appointments / wins their published posts produced,
4. flag account overload / spare capacity so the Fleet Controller's load factor is backed by an operator view.

## Owning agent
`optimization-agent`

## Inputs
`{ dealer_id }`

## Outputs
`{ dealer_id, queries {evaluated, reprioritized, derived[], paused[], retired[], best_smoothed_density},
thresholds ThresholdAdvice, pillars PillarSignal[], accounts LoadRecommendation[], recommendations string[], generated_at }`
(JSON-safe; also stored as the output of one `optimization` decision).

## Validation & guarantees
- Scoring thresholds are **never changed automatically** (`auto_applied: false`); `raise_qualified` requires ≥ 10
  contacted leads in both the qualified band and the higher bands, qualified-band reply rate < 5 % and higher-band
  reply rate ≥ 20 %; the suggestion never crosses `high_intent − 1`.
- Too-small samples produce `keep` with an explicit "样本不足" reason.
- Pillar signals only use PUBLISHED posts from `getContentAttribution` in the last 90 days: `increase` when a pillar
  produced wins or the best qualified-per-post, `decrease` when ≥ 3 posts produced zero leads.
- Load = active leads ÷ (5 × effective daily outreach limit); AT_RISK/RESTRICTED accounts are `attention`.

## Runtime entry points
- `runOptimization(ctx, dealerId)` — `evening_analysis` workflow.
- `adviseThresholds`, `scoreBandOutcomes`, `contentPillarSignals`, `accountLoadRecommendations` (console).
- Skill `optimization`.

## Failure modes
- Unknown dealer → `NotFoundError`. Errors from `evolveQueries` propagate (the workflow step fails and is resumable).

## Tests
`test/unit/optimization/optimization.test.ts`: threshold advice keep / raise / review with seeded transitions; pillar
signals rank a post with a win above a high-engagement post without leads; load recommendations; decision recorded;
thresholds unchanged after the run.
