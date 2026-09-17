# lead-scoring

## Responsibility

Turns evidence-preserving purchase-intent signals into a **configurable, explainable score** (spec §9,
ARCHITECTURE §5, §5.1–5.3). Three levels:

1. **Signal score** (`scoreSignal`, pure): one IntentDetection → 0..100 with one component per factor and a
   Chinese reason for every point (e.g. `询问现车且店内有白外红内 eDrive35L 现车`); explicitly out-of-area buyers are
   capped below qualified for that dealer (§5.2); owners, creators and marketing accounts score as non-signals (§5.1).
2. **Group evaluation** (`evaluateSignalForDealers`): one public signal against every dealer of a group, so discovery
   routes the lead to the best-matching store (§5.3).
3. **Lead score** (`scoreLead`, persisted): re-scores every stored signal of a lead at the current clock
   (recency decays), aggregates `min(100, best + min(5, 2 × (qualifying − 1)))` where qualifying = purchase signals
   ≥ candidate, writes a `lead_scores` row, updates `leads.score` / `leads.tier`, and records a `lead_score` agent decision
   that includes the per-dealer scores of the group.

It also owns the per-dealer, versioned `scoring_configs` (weights + tier thresholds). It never changes a
lead's funnel stage or dealer — stage transitions belong to lead-deduplication / CRM, routing to discovery.

## Owning agent

`lead-scoring-agent` (skill category `acquisition`).

## Inputs

- Skill input: `{ lead_id: string }` (validated with `v.object`, non-empty).
- `scoreSignal(input, cfg)`: `{ detection: IntentDetection, signal_at, now, dealer: DealerProfile, authenticity? }`
  where `authenticity.score` is on the **0..5 calibration scale** (default 4 · verified local user 5 ·
  marketing/industry account 0) and `cfg` is `{ weights, thresholds }`.
- `evaluateSignalForDealers(ctx, { dealer_ids, text, context: SignalContext, signal_at, authenticity?, preferred_dealer_id? })`.
- `scoreLead` reads: `leads`, `lead_signals` (intent + evidence + signal_at + engine + migration-v2 detection columns),
  the Dealer Brain profile via `buildDealerProfile` (brands, models, trims + aliases, in_stock / in_transit inventory,
  city, province), the active scoring config, and the group's dealers (`listDealers`).

### Stored-signal conventions (how a `lead_signals` row is turned back into an IntentDetection)

A row is **v2** when any detection column differs from the migration-v2 defaults (`strength > 0`, non-empty
`transaction_questions`, `is_purchase_signal = false` or a non-null `author_role` — the latter two can only come from a
v2 writer); otherwise it is **legacy** (`isLegacySignalRow`).

| field | v2 row | legacy row |
|---|---|---|
| `transaction_questions` | the `transaction_questions` column (valid, distinct values) | evidence codes `tq:<question>` or codes equal to a `TRANSACTION_QUESTIONS` value; if none, derived from intent flags (`price_intent`→price, `discount_intent`→discount, `inventory_intent`→inventory, `inventory_intent`+`color_intent`→color_trim_availability, `financing_intent`→finance, `leasing_intent`→lease, `trade_in_intent`→trade_in, `dealer_selection_intent`→dealer_location, `visit_intent`→test_drive) |
| `strength` | the `strength` column (0..1); when 0 the stage anchor | evidence code `strength:<0..1>`, else the stage anchor: awareness 0.1 · research 0.2 · comparison 0.4 · price_shopping 0.88 · active_shopping / dealer_selection / purchase_imminent 1.0 |
| `author_role` | the `author_role` column, else from evidence codes | from evidence codes: `marketing_account` → marketing · `already_purchased` → owner · `content_creator` → creator |
| `negative` | evidence code `negative`, `not_interested` or `negative_feedback` | same |
| `is_purchase_signal` | column true AND not negative AND role not owner/creator/marketing AND (stage or questions) | false when negative, when an evidence code is `non_purchase` / `non_purchase_signal` / `prefilter_failed` / a prefilter reason (`pure_praise`, `emoji_only`, `empty_or_emoji`, `too_short`, `no_signal`, `marketing_account`) / `content_creator` / `already_purchased`, or when the intent has neither a purchase stage nor a transaction question |

Writers of `lead_signals` (lead-deduplication) store the detection's `is_purchase_signal`, `strength`,
`transaction_questions` and `author_role` columns (ARCHITECTURE §8 B1); evidence is stored unchanged.

Lead authenticity comes from `leads.evidence` codes written by lead-research: `industry_account`
(or `marketing_account`) → 0, `verified_local_user` → 5, otherwise 4.

## Outputs

- `scoreSignal` → `{ score, tier, components: ScoreComponent[] }`.
- `evaluateSignalForDealers` → `{ results: { dealer_id, detection, score, tier, components }[]; best }` — one result per
  distinct dealer id in input order; `best` = highest score, ties → `preferred_dealer_id`, then input order.
- `listGroupDealerIds(ctx, dealerId)` → every dealer id of that dealer's group, the given dealer first (others in
  `listDealers` order).
- `scoreLead` / skill → `LeadScore` (`lead_scores` row): `score`, `tier`, `components` (best signal's components plus a
  `corroboration` component when the bonus applies; a single `no_signals` component for leads without signals),
  `config_version`, `computed_at`.
- Side effects of `scoreLead` (single transaction — a failure anywhere rolls back every write): `lead_scores`
  insert; `leads.score` + `leads.tier` update; `audit_events` `lead.score_updated` (only when score or tier
  changed); `agent_decisions` row with `decision_type 'lead_score'`, agent `lead-scoring-agent`, skill
  `lead-scoring`, inputs (config, authenticity, `group_dealer_scores: {dealer_id, best_signal_id, best_signal_score,
  tier}[]` for every group dealer (§5.3), per-signal score / tier / questions / strength / is_purchase_signal /
  author_role / legacy_row), evidence = lead evidence (falls back to the best signal's evidence when the lead has none),
  output (score, tier, previous score/tier, best signal, qualifying count, applied bonus, `out_of_area_capped`,
  components), confidence = best signal's `intent.confidence` (0.5 when unknown), engine `rules`. Scoring a lead may
  initialize a sibling dealer's v1 scoring config (`scoring.config_initialized`).
- `getScoringConfig` → active `ScoringConfig` (creates version 1 with defaults + `scoring.config_initialized` event
  when missing; reactivates the latest version with `scoring.config_reactivated` if none is active).
- `updateScoringConfig` → new active version N+1 (previous deactivated in the same transaction) +
  `scoring.config_updated` event with the actor, versions and a from/to diff.

## Validation & guarantees

- Calibration (defaults): weights explicit_purchase_intent 25 · transaction_questions 15 · model_match 12 ·
  inventory_match 10 · location_match 10 · purchase_stage 12 · recency 6 · authenticity 5 · dealer_relevance 5;
  thresholds candidate 20 · qualified 60 · high_intent 80 · immediate 92.
- Factor rules (points on the default scale; custom weights rescale each rule proportionally,
  `points = round(rule/defaultMax × configuredMax)`):
  - explicit_purchase_intent `round(max × strength)`.
  - transaction_questions 0 → 0 · 1 → 12 · ≥2 → 15 (distinct valid questions).
  - model_match stated & carried 12 · inferred (`inferred_fields` has `model`) & carried 8 · a carried model in
    `competing_models` 6 · brand carried only 4 · else 0. Case- and width-insensitive (NFKC); `3系` = `3 Series`;
    brand aliases are symmetric (`BMW` ↔ `宝马`, whichever form the dealer row stores); brand-prefixed models
    (`BMW X3`, `宝马i3`) accepted without prefix false positives (`iX3` ≠ `X3`).
  - inventory_match (first match wins): asked (inventory intent / `inventory` or `color_trim_availability`
    question) & matching in_stock (trim and colour when specified) 10 · asked & matching only in_transit 7 ·
    stated trim & matching in_stock without an inventory question 7 · **inventory context** (asked, or a stated
    trim or colour) whose exact spec is unavailable but the model has in_stock inventory 4 · asked but nothing
    matches 2 · else 0. A bare model mention with no stock question, trim or colour earns 0 inventory points —
    this reading reproduces the §5 reference values ≈30 / ≈65 / ≈69 exactly. Trims resolve through dealer
    aliases (`35L`, `i3 35L` → `eDrive35L`); colours are tolerant (`白外红内` / `外白内红` / `白色外观红色内饰` /
    `外观白色，红色内饰` / `白车红内饰` / `白/红` → exterior 白 + interior 红; `内饰红色` → interior 红;
    `白色` ≈ `白` ≈ `珍珠白` ≈ `white`).
  - location_match stated city = dealer city 10 · stated province (not in `inferred_fields`) = dealer province 6 ·
    IP-derived province (`inferred_fields` has `province`) = dealer province 5 · else 0.
  - purchase_stage awareness 0 · research 3 · comparison 5 · price_shopping 8 · active_shopping 10 ·
    dealer_selection 11 · purchase_imminent 12.
  - recency (elapsed time since `signal_at`) ≤3d 6 · ≤7d 5 · ≤14d 4 · ≤30d 3 · ≤90d 1 · older 0 (future
    timestamps count as fresh; unparsable timestamps 0).
  - authenticity default 4 · verified local 5 · industry 0.
  - dealer_relevance brand (or model) carried 5 · competitor brand comparing with a carried model 3 · else 0.
- Non-purchase signals — `is_purchase_signal = false`, negative, `is_marketing`, or author role owner / creator /
  marketing (even if a writer flagged them as purchase): `score = round((recency + authenticity) × 0.2)`; components
  carry a negative `non_purchase_signal` adjustment whose reason names the role (已购车车主 · 内容创作 · 营销/同行销售账号)
  so components always sum to the score.
- **Out-of-area cap (§5.2)**: when a purchase signal states a city or province (not in `inferred_fields`) whose province
  (city → province via the lexicon) differs from the dealer's province, the score is capped at `thresholds.qualified − 1`
  and a component `{factor: 'out_of_area_cap', points: min(0, cap − raw), max: 0, reason: '异地买家（深圳），不在本店服务范围…'}`
  is appended (points 0 when the raw score is already below the cap). IP 属地-only locations, the dealer city, same-province
  places, unknown places and dealers without a province are never capped.
- **Lead aggregate**: only purchase signals (not negative) scoring ≥ candidate count as qualifying for the corroboration
  bonus — owner remarks, creator content, praise and marketing never corroborate (F4).
- **Lead-level out-of-area cap (§5.2)**: when ANY purchase signal of the lead explicitly states a place outside the
  dealer's province and NO purchase signal states an in-area place, the aggregate stays ≤ `qualified − 1` — whichever
  signal scores best (a 深圳 buyer whose strongest comment names no place is still a 深圳 buyer). When the cap lowers
  the best signal itself, a lead-level `out_of_area_cap` component (`异地买家（深圳），不在本店服务范围，线索总分封顶 59`)
  carries the negative delta; a cut corroboration bonus is shown as `异地买家总分封顶`. Non-purchase or negative signals
  naming a place never cap a lead. The decision output records `out_of_area_capped` and `out_of_area_place`.
- **Group evaluation (§5.3)**: `evaluateSignalForDealers` runs `detectIntentRules` + `scoreSignal` per dealer with that
  dealer's profile, active config and timezone at `ctx.clock`; it validates `dealer_ids` (every entry a non-empty string —
  a malformed id is rejected, never silently dropped; duplicates evaluated once), `text`, `context` (with a valid
  `source_type`) and `signal_at`.
- Factor maxima (`effectiveMaxima`): integer weights summing to ≤ 100 are used unchanged. Weights summing above
  100 (or fractional weights) are converted to integer maxima that sum to `min(100, floor(sum))` by
  largest-remainder apportionment (ties by factor order). Consequently every factor's points are ≤ its max,
  the maximum total is exactly 100 when weights sum above 100, and the components always sum to the score.
  A weight of 0 removes the factor.
- `updateScoringConfig` validation: actor required; only known weight/threshold keys; finite numbers 0..100; at
  least one weight > 0; candidate threshold > 0; thresholds strictly ascending
  (candidate < qualified < high_intent < immediate); empty patch rejected. Failures throw `ValidationError` and
  create no version.
- DB guarantees: `uq_scoring_active` (one active config per dealer) and `uq_scoring_version`.
- Reference table (post "宝马i3现在值得买吗？", 杭州 BMW with 白/红 i3 eDrive35L in stock, ≤3 days, no IP):
  帅 2 · 这车后排空间怎么样 31 · 现在优惠多少 65 · 现在i3优惠多少 69 · 杭州i3 35L落地多少 91 ·
  杭州i3 35L白外红内有现车吗？这周想去看看 99 — identical whether scored from hand-built detections, legacy rows or v2
  rows. The same question from 深圳 scores 59 (capped) for 杭州宝马中心.

## Runtime entry points

`src/skills/acquisition/lead-scoring/index.ts`

- `DEFAULT_WEIGHTS: ScoringWeights`, `DEFAULT_THRESHOLDS: ScoringThresholds`, `STRENGTH_ANCHORS`, `SCORING_FACTORS`, `THRESHOLD_KEYS`, `OUT_OF_AREA_FACTOR`
- `tierFor(score: number, t: ScoringThresholds): ScoreTier`
- `scoreSignal(input: SignalScoreInput, cfg: Pick<ScoringConfig, 'weights' | 'thresholds'>): { score; tier; components }`
- `evaluateSignalForDealers(ctx: AppContext, input: EvaluateSignalForDealersInput): { results: DealerSignalEvaluation[]; best: DealerSignalEvaluation }`
- `listGroupDealerIds(ctx: AppContext, dealerId: string): string[]`
- `scoreLead(ctx: AppContext, leadId: string): LeadScore`
- `getScoringConfig(ctx: AppContext, dealerId: string): ScoringConfig`
- `updateScoringConfig(ctx: AppContext, dealerId: string, patch: { weights?; thresholds? }, actor: string): ScoringConfig`
- helpers: `effectiveMaxima(weights)`, `detectionFromSignal(signal: StoredSignal)`, `isLegacySignalRow(signal)`,
  `statedAreaMatch(intent, dealer): { match: 'in_area' | 'out_of_area' | 'unstated'; place? }`,
  `authenticityFromEvidence(evidence)`, `parseColorIntent(text)`, `colorMatches(wanted, actual)`
- `skill` — name `lead-scoring`, category `acquisition`, agent `lead-scoring-agent`, input `{ lead_id }`, output `LeadScore`
  (post-condition: score within 0..100 and components present).

## Failure modes

- Unknown lead → `NotFoundError('lead')`; unknown dealer → `NotFoundError('dealer')` (from config / profile /
  `listGroupDealerIds` / `evaluateSignalForDealers`).
- Invalid config patch or `evaluateSignalForDealers` input → `ValidationError` (no partial writes).
- A failure while persisting (score row, lead update, event or decision) rolls back the whole `scoreLead` write set.
- Signals with an unparsable `signal_at` get 0 recency points (reason `信号时间无效`) rather than failing the lead.
- Legacy rows whose evidence lacks question codes fall back to intent-flag derivation; if neither exists,
  transaction-question points are lost for that signal (visible in the component reason). Legacy non-purchase rows
  that carry a `purchase_stage` but no non-purchase evidence code are re-scored as purchase signals — v2 rows are not
  affected.
- `group_dealer_scores` re-score the stored detections (made against the lead's dealer profile) with each sibling
  dealer's profile and config; entity extraction is not re-run per dealer (use `evaluateSignalForDealers` at ingestion
  for exact per-dealer detection).
- A model the dealer does not carry never earns model/inventory points, even if the user asks for stock.

## Tests

- `test/unit/scoring/signal-scoring.test.ts` — reference calibration table (exact values), tier boundaries,
  recency buckets, location / inventory (incl. inventory-context gating) / competitor / authenticity variants,
  colour parsing (suffix, prefix, mixed, full-width forms), symmetric brand aliases, custom-weight scaling
  (proportional rules, largest-remainder integer maxima, sum > 100, fractional weights, zero weight, points ≤ max
  and components summing to the score), stored-signal reconstruction.
- `test/unit/scoring/signal-quality.test.ts` — §5.2 cap (stated city / province / lexicon-resolved city, IP-only,
  same province, dealer city, unknown place, below-cap zero adjustment, custom threshold), non-buyer role reasons,
  v2-column reconstruction (legacy detection, column precedence, strength fallback, non-purchase / owner / negative rows,
  legacy role codes).
- `test/unit/scoring/lead-scoring-persistence.test.ts` — config v1 creation, versioning with the unique active
  index, validation failures (incl. candidate threshold 0), reactivation; `scoreLead` aggregation with
  corroboration bonus and caps, the reference table from stored rows, atomic rollback when the decision cannot be
  recorded, recency decay over the clock, authenticity from lead evidence, zero-signal leads, config
  thresholds/version applied, decision + event recording, stage untouched; v2 rows (columns over evidence, strength
  column, non-purchase rows, purchase-only corroboration, legacy role codes, aggregate out-of-area cap and its lifting,
  lead-level cap when the best signal names no place, non-purchase place mentions never capping);
  skill registration and input validation.
- `test/unit/scoring/group-evaluation.test.ts` — fixture dealers: group listing, explicit 上海 routing, tie-breaking,
  per-dealer configs, calendar timeframes at the clock, input validation (malformed ids, invalid `source_type`), a buyer
  naming two cities capped by neither dealer, `group_dealer_scores` in the decision.
- `test/integration/scoring-calibration.test.ts` and `test/integration/corpus-signal-quality.test.ts`.

Run: `node --test test/unit/scoring/*.test.ts`
