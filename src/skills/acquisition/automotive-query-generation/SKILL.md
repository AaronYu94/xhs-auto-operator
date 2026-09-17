# automotive-query-generation

## Responsibility

Automotive Query Generator and Search Intelligence for the Lead Hunting Engine (spec §5, §19).

1. **Generation** (`generateQueries`): turns a dealer goal (brand, models, location) plus structured Dealer Brain
   rows into persisted Xiaohongshu search queries across five classes, each with a Chinese `generation_reason` that
   cites the template and the data it is grounded in:
   - `direct_model` — `宝马i3` · `宝马i3价格` · `宝马i3落地` · `i3优惠` · `i3值得买吗` · in-stock trim variants `i3 35L`
   - `competitor` — top 3 lexicon competitors per model: `i3 vs Model 3` · `i3还是Model 3` · `X3 vs GLC` · `X3 vs Q5L` · `3系还是C级`
   - `purchase_scenario` — budget bracket from MSRP minus the best active cash offer (`25万买什么车`), SUV (`30万SUV`,
     `家用SUV推荐`), EV (`电车推荐`, `纯电轿车推荐` / `纯电SUV推荐`), `第一次买宝马`, `准备换车`
   - `transaction_intent` — `i3落地价` · `i3优惠多少` · `i3有现车吗` (sellable stock only) · `i3贷款方案` (active finance
     offer only) · `X3以租代购` (active lease offer only) · `宝马置换补贴` (active trade-in offer only) · `什么时候买便宜`
   - `location` — `杭州宝马` · `杭州宝马优惠` · `杭州买宝马` · `浙江宝马价格` · `杭州i3` · `杭州i3落地` · `杭州i3有现车吗` (sellable stock only)
2. **Effectiveness** (`getQueryEffectiveness`): per query runs, posts discovered, comments scanned, users evaluated,
   candidates, qualified, high-intent, lead density, candidate rate, smoothed density, and attributed appointments /
   wins / conversion rate.
3. **Feedback loop** (`evolveQueries`): re-prioritizes by relative smoothed lead density, derives variants of the best
   queries, pauses and retires poor ones.
4. **Selection** (`selectQueriesToRun`): which active queries discovery should run next, with guaranteed exploration.

It never calls the XHS provider (lead-discovery runs the searches and writes `search_runs`) and never invents facts:
every price, offer, stock and competitor mentioned in a query or reason comes from a Dealer Brain row or the lexicon.

## Owning agent

`lead-hunting-agent` (skill category `acquisition`).

## Inputs

- Skill input / `generateQueries(ctx, input)`: `{ dealer_id: string; goal: GoalSpec; goal_id?: string | null }`
  validated by `queryPlanInputValidator` (`goal.type` ∈ `GOAL_TYPES`; `brand`, `location`, `province` optional
  strings ≤ 60 chars; `models` optional string array ≤ 20 items, default `[]`; `timeframe`, `target_leads`, `notes`
  optional).
- Resolution with fallbacks:
  - brand: `goal.brand` (canonical or Chinese, e.g. `BMW` / `宝马`, width/case-insensitive) must be carried by the
    dealer; otherwise every dealer brand.
  - models: `goal.models` resolved against the carried catalog via `findVehicles` (catalog aliases, brand prefixes and
    trims accepted), then through the lexicon (`resolveModelName`: `三系` → 3 Series, `五系` → 5 Series); uncarried
    models are skipped and recorded. Without goal models: carried models with sellable (in_stock / in_transit)
    inventory ordered by in-stock then in-transit units; when nothing is sellable, at most 6 catalog models — those
    with a model- or trim-specific active offer first, then the lowest entry MSRP. Unplanned catalog models are
    recorded as `omitted_models`.
  - priority models (+0.1): the goal's models; in the inventory fallback, models with in-stock units.
  - location: `goal.location` (a known city → the lexicon province wins over a conflicting `goal.province`, which is
    recorded as `ignored_province`; a province → the dealer city when the dealer is in that province; an unknown place →
    used literally as the city with the normalized `goal.province`); else `goal.province` (normalized: `浙江省` → `浙江`);
    else the dealer's city and province.
  - area (§5.2 / §5.3): whether the target province is the dealer's own, served by another store of the group
    (`group_dealer`, leads route there), served by no group store (`out_of_area`), or unknown.
- Dealer Brain reads: `vehicles` (model_zh, aliases, msrp, specs.body_type / powertrain / range_km), `findInventory`
  (in_stock / in_transit), `getActiveOffers` (cash_discount, finance, lease, trade_in valid at `ctx.clock` in the
  dealer's timezone), `listDealers` (group stores for the area check).
- `getQueryEffectiveness(ctx, dealerId, { from?, to? })`: optional inclusive bounds — `YYYY-MM-DD` (dealer-local
  calendar day, Asia/Shanghai by default) or an ISO-8601 timestamp with an explicit zone (`Z`, `+08:00`, `+0800`).
- `evolveQueries(ctx, dealerId)`; `selectQueriesToRun(ctx, dealerId, limit, goalId?)`.

## Outputs

- `generateQueries` / skill → `SearchQuery[]` in class order (direct_model, competitor, purchase_scenario,
  transaction_intent, location). New rows: `status 'active'`, `goal_id` = input goal id, `parent_query_id null`,
  `brand` / `model` / `location` columns set, `priority = clamp(prior + 0.1 × priority model, 0, 1)` with priors
  location 0.8 · transaction_intent 0.75 · direct_model 0.6 · competitor 0.55 · purchase_scenario 0.4.
  Side effects (one transaction): `search_queries` inserts/updates; `audit_events` `search_queries.generated` (when
  anything was created or updated) and `search_query.reactivated`; `agent_decisions` `query_generation`
  (agent `lead-hunting-agent`; subject the goal, or the dealer without goal id; inputs: goal + resolved
  brands/models/stock/brackets/offers/location/`location_source`/`ignored_province`/`area`/`model_source`/
  `skipped_models`/`omitted_models`; evidence: `carried_model`, `active_offer`, `target_location`,
  `goal_province_ignored`, `out_of_area_location`, `group_dealer_location`, `model_not_carried`, `models_omitted`;
  output: class counts, total / created / updated / reactivated / unchanged and every query; confidence 0.9, 0.8 when a
  dealer / inventory fallback was used, −0.1 skipped goal models, −0.2 out of area, −0.1 routed to another group store,
  −0.05 ignored province; engine `rules`). Location reasons mention out-of-area / group routing.
- `planQueries` → `PlannedQuery[]` without persisting (preview).
- `getQueryEffectiveness` → `QueryEffectiveness[]` for every query of the dealer (all statuses, never-run included with
  zeros) sorted by `smoothed_density` desc (ties: qualified, runs, priority, text), plus `failed_runs` and
  `last_run_at`.
- `evolveQueries` → `{ reprioritized, derived, retired, paused, evaluated, best_smoothed_density, changes }`; audit
  events `search_query.paused` / `search_query.retired` / `search_query.derived` / `search_queries.optimized`; decision
  `query_optimization` (subject dealer) with every query's statistics and before/after priorities.
- `selectQueriesToRun` → ordered active `SearchQuery[]` (≤ limit).

## Validation & guarantees

- Dedup by `(dealer_id, queryKey(text))` where `queryKey` = NFKC, lower-case, whitespace removed (backed by the
  `uq_query_text` unique index). An existing row keeps its id and class; a null `goal_id` is attached (an attached goal
  is never replaced); retired queries are never modified. A query's priority is raised when the new prior is higher
  AND (it has no completed run OR the call is a *new goal* for it); a paused query is reactivated only for a *new
  goal*. A goal is new for a row when the row belongs to another goal (or none) AND the goal has never been planned
  for this dealer (no earlier `query_generation` decision for that goal and dealer). A goal therefore lifts /
  reactivates a shared query once; re-running any already-planned goal (the daily plan) never undoes the priorities
  and pauses learned by `evolveQueries`. Re-running the same goal is idempotent (no row changes).
- Grounding: trim variants only for in-stock trims (`i3 40L` in transit is not generated); `有现车吗` only for models with
  sellable stock; `贷款方案` / `以租代购` / `置换补贴` only while a matching offer is active in the dealer's timezone (an
  offer valid until 09-30 is used at 23:59:59 Shanghai and not at 10-01 00:00); expired offers never cited;
  budget bracket = floor((MSRP − best active cash discount) / 5万) × 5万 over in-stock trims (entry = lowest net price).
- Effectiveness math: `runs` counts SUCCEEDED runs only (FAILED / UNAVAILABLE go to `failed_runs`, RUNNING is ignored);
  `lead_density = qualified / max(1, users_evaluated)`; `candidate_rate = candidates / max(1, users_evaluated)`;
  `smoothed_density = (qualified + 1) / (users_evaluated + 20)`; `appointments` = leads with
  `attributed_query_id = query` that reached APPOINTMENT or deeper (APPOINTMENT, VISITED, NEGOTIATING, WON — a later LOST
  still counts) per `lead_stage_transitions` (or the current stage for rows without transition history);
  `won` = reached WON; `conversion_rate = appointments / max(1, qualified)`. Attribution ignores the lead's dealer
  (group routing may move a lead to another store; the query still surfaced it). Window bounds filter runs by
  `started_at` and attribution by transition time; a date-only `to` covers the whole dealer-local day.
- Feedback loop (one transaction: statistics are read inside it, so rows committed by another process just before
  the call are seen): every active query with ≥ 1 completed run gets
  `priority = round(clamp(0.35 × class prior + 0.65 × smoothed_density / best, 0.05, 1), 4)` where `best` is the highest
  smoothed density among non-retired queries with runs; never-run queries keep their priority (exploration); a derived
  query uses its root parent's class prior. Then queries with ≥ 5 runs and smoothed density < 0.01 are retired (active
  or paused); active queries with ≥ 3 runs and 0 candidates are paused. Variants are derived from active queries with
  ≥ 1 run and smoothed density ≥ 0.08, best first: dealer city prefix (not for comparisons or texts naming a place) →
  in-stock trim alias inserted after the model name (`杭州i3有现车吗` → `杭州i3 35L有现车吗`; model matched case- and
  width-insensitively and never inside a longer token such as `iX3`; skipped when any catalog trim, in stock or not, is
  already named) → transaction suffixes `落地` / `有现车吗` (sellable models only) / `优惠`, only on noun phrases: no
  question or attribute ask (`吗`, `多少`, `怎么样`, `推荐`, …), no transaction term, not a purchase scenario. Comparisons
  (`vs` with or without spaces, `还是`, `对比`, `PK`, …) get no variants. Derived rows: `query_class 'derived'`,
  `parent_query_id`, parent's goal / brand / model / location and new priority, reason citing the parent's runs, users,
  qualified leads and densities. At most 3 per parent and 5 per call; a text that exists in any status is never created
  again.
- Selection: active queries only, ordered by (goal's queries first when `goalId` is given, priority desc, created_at,
  text). Never-run = no SUCCEEDED run. At least `ceil(n / 4)` never-run queries are included when available (replacing
  the lowest-ranked explored ones) and every block of up to four slots contains one (moved to the block's last slot).
- Everything runs synchronously; writes are wrapped in `ctx.db.tx`; time comes from `ctx.clock`; ids from `newId('q')`.

## Runtime entry points

`src/skills/acquisition/automotive-query-generation/index.ts`

- `generateQueries(ctx: AppContext, input: QueryPlanInput): SearchQuery[]`
- `planQueries(ctx: AppContext, input: QueryPlanInput): PlannedQuery[]`
- `getQueryEffectiveness(ctx: AppContext, dealerId: string, opts?: { from?: string; to?: string }): QueryEffectiveness[]`
- `evolveQueries(ctx: AppContext, dealerId: string): EvolveResult`
- `selectQueriesToRun(ctx: AppContext, dealerId: string, limit: number, goalId?: string | null): SearchQuery[]`
- helpers: `buildQueryPlan`, `resolveQueryTargets`, `buildPlannedQueries` (plan.ts), `queryKey`, `trimAlias`,
  `budgetBracketWan`, `smoothedDensity`, `completedRunCounts`; constants `QUERY_CLASS_PRIORS`,
  `GENERATED_QUERY_CLASSES`, `PRIORITY_MODEL_BOOST`, `MAX_COMPETITORS_PER_MODEL`, `BUDGET_BRACKET_WAN`,
  `FALLBACK_MODEL_CAP`, `FEEDBACK`; validators `goalSpecValidator`, `queryPlanInputValidator`; types `QueryPlanTargets`
  (with `area: TargetArea`, `ignored_province`, `omitted_models`), `PlannedQuery`, `QueryEffectiveness`, `EvolveResult`.
- `skill` — name `automotive-query-generation`, category `acquisition`, agent `lead-hunting-agent`, input
  `{ dealer_id, goal, goal_id? }`, output `SearchQuery[]` (post-condition: non-empty, every row has text, a reason and a
  priority within 0..1).
- Operator usage: goal / daily `lead_discovery` → `generateQueries` → `selectQueriesToRun` → lead-discovery
  `runSearchQuery`; evening optimization → `evolveQueries`; analytics / UI → `getQueryEffectiveness`.

## Failure modes

- Unknown dealer → `NotFoundError('dealer')`.
- Invalid input (missing / unknown goal type, non-array models, empty dealer id) → `ValidationError`; nothing is written.
- `goal.brand` not carried by the dealer → `ValidationError('goal.brand')`.
- Goal models given but none carried (catalog or lexicon) → `ValidationError('goal.models')`; some carried → the rest
  are skipped and recorded (`skipped_models`, evidence `model_not_carried`, lower confidence).
- `goal_id` of an `operator_goals` row owned by another dealer → `ValidationError('goal_id')` (ids with no goal row are
  accepted, e.g. external goals).
- A dealer with no brand anywhere → `ValidationError('goal.brand')`.
- A goal location no group store serves is honoured but flagged (`out_of_area_location`, confidence −0.2): per §5.2
  explicitly out-of-area buyers never become Qualified for this dealer.
- `from` / `to` not a real `YYYY-MM-DD` or not an ISO-8601 timestamp with zone (e.g. `2026-09-12T10:00:00`,
  `2026-09-12 10:00`, `Sep 12 2026`, `2026-02-30`), or `from` after `to` → `ValidationError`; `limit` not a
  non-negative integer → `ValidationError('limit')`.
- Models missing from the lexicon produce no competitor queries and fall back to catalog specs for body / powertrain.
- A failure while persisting rolls back every write of that call (queries, events and decision).

## Tests

- `test/unit/query-generation/generation.test.ts` — fixture goal BMW i3 + X3 in 杭州: every class and the spec examples
  present, no duplicates, in-transit trims excluded, priorities (prior + boost), data-grounded reasons, idempotent
  re-run, finance / lease / trade-in gating (incl. after offers expire and for 上海宝马中心), inventory and dealer
  fallbacks, province / other-city locations, dedup rules (paused reactivation, retired untouched, learned priority
  kept, new-goal raise, whitespace/case-insensitive text match), decision contents, validation failures, preview,
  helpers, registry invocation, and that spec queries find notes through `SimulationXhsProvider`.
- `test/unit/query-generation/effectiveness.test.ts` — spec densities 2% / 17% / 31% and ordering, aggregation over
  runs, failed / running runs, time windows, dealer isolation, appointment / won attribution (jumps, LOST after
  appointment, imported WON leads, cross-dealer routing).
- `test/unit/query-generation/evolution.test.ts` — exact re-prioritization values, exploration priorities, pause and
  retire rules, derived variants from the best queries (cap, per-parent cap, no duplicates across calls), derived
  class prior, decision and events.
- `test/unit/query-generation/selection.test.ts` — priority order, exploration slots for several limits, failed runs
  not counting as explored, goal-first ordering, exclusions and limit validation, selection after evolution.
- `test/unit/query-generation/hardening.test.ts` — regressions: a second goal lifts / reactivates shared queries once
  and the daily plan never undoes evolve's pauses and priorities; Asia/Shanghai date-only bounds and ambiguous
  timestamps; natural derived variants (no double trim, no suffix on questions, unspaced comparisons, lower-case
  models); province normalization and city-province precedence; lexicon model aliases; out-of-area / group-store
  evidence; evolve reads inside its transaction; no-stock fallback ordering with omitted models; offer validity at the
  Shanghai day boundary.
- `test/unit/query-generation/contract.test.ts` — compile-time conformance to ARCHITECTURE §8 B2 signatures, runtime
  exports, skill definition and SKILL.md sections.

Run: `node --test test/unit/query-generation/*.test.ts`
