# trend-detection

## Responsibility
Detect what is gaining or losing attention in public discussion around the dealer's models (spec §15 research,
§20 08:30 market research): models (incl. competitors) and curated purchase/usage terms (落地价, 优惠, 现车, 提车,
贷款/金融, 置换, 以租代购, 补贴, 试驾, 续航/充电, 空间, 油耗, 保养/质保, 性价比/值不值, 选车对比, 砍价), comparing the
last `window_days` with the previous window of equal length.

## Owning agent
`research-agent` (skill `trend-detection`, category `research`).

## Inputs
`{ dealer_id: string; models?: string[]; location?: string | null; window_days?: number }` — window default 7 days
(current window = last 7 days, previous = the 7 days before). Scope rules as xhs-research; relevance also accepts
threads mentioning a competitor of a scope model.

## Outputs
Persisted `ResearchBrief` (`kind = 'trend'`):
- `findings.trends[]` — `{ term, current, previous, change }` for every term with ≥ 2 units in either window, sorted by
  change; `change = (current − previous) / max(1, previous)` (2 decimals).
- `findings.insights` — when BOTH windows contain dated units: up to 5 rising terms (current ≥ 2 and current >
  previous; "新出现并升温" when previous = 0) and up to 3 falling terms (previous ≥ 2 and current < previous). When one
  window has no dated units at all (collection only started recently, or stopped), every term would look new or gone,
  so no rise or fall is claimed: the insights are the ≤ 5 most-mentioned terms of the window with data
  ("近7天「i3」被提及15次（前7天没有可比数据，暂不判断升降）") and the headline says the other window has no comparable data.
  Every insight carries ≤ 3 verbatim clause quotes from units in the relevant window.
- `findings.headline`, `source_counts` (notes/comments dated inside the two windows, provider searches).

## Validation & guarantees
- Counting is document frequency: a term counts once per unit (a note = title + content, or a comment).
- Units are dated by `published_at` only (DB corpus and provider data); undated units, managed-account text,
  dealer/solicitation voices (prefilter, or intent-NLU nickname / role) and later copies of the same author's comment
  never count. Min support is 2 (`MIN_SUPPORT`). The decision records `comparable` and each window's unit volume.
- `runTrendDetection` is synchronous (ARCHITECTURE §8): it analyses the DB corpus plus an optional pre-gathered
  provider corpus (`opts.provider_corpus`). The skill path (`runTrendDetectionWithProvider`) first performs the
  bounded provider search over both windows (≤ 6 queries, ≤ 10 notes each) when `search_public_content` is
  AVAILABLE. Provider data is never persisted.
- Evidence re-verification, simulation labelling, honest empty brief, decision (inputs record min support and window
  sizes) + audit event as in `src/skills/research/shared.ts`.

## Runtime entry points
- `runTrendDetection(ctx, input, opts?): ResearchBrief` (sync, contract API)
- `runTrendDetectionWithProvider(ctx, input): Promise<ResearchBrief>` (skill run)
- `countTrends(units, nowMs, windowDays)`, `analyzeTrendCorpus(corpus, scope, nowMs)`, `changeRatio(current, previous)`,
  `TREND_TERMS`, `MIN_SUPPORT`, `DEFAULT_TREND_WINDOW_DAYS`
- Skill `trend-detection`; used by the `market_research` daily workflow.

## Failure modes
- `ValidationError` / `NotFoundError` for bad input / unknown dealer.
- A sparse corpus yields trends only for terms meeting min support; otherwise the headline says no rising term met it.
- Provider failures are recorded in the decision and never thrown.

## Tests
`test/unit/research/trend-detection.test.ts` — DB-seeded public posts/comments across the current and previous
windows (rising term with exact counts and change ratio, falling term, min-support filter, undated / out-of-window /
marketing / managed-account units ignored, verbatim evidence from the correct window), simulation provider path,
pure `changeRatio` / `countTrends`, honest empty brief. `test/unit/research/research-hardening.test.ts` — no
rising claims on the simulation corpus (no previous-window data), no falling claims when the current window is empty,
simulation rows in the DB labelled, copied comments counted once.
