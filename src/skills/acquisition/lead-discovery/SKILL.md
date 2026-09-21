# lead-discovery

## Responsibility
Turn stored search queries into real public Xiaohongshu content and purchase-intent lead signals (spec §4, §6;
ARCHITECTURE §3, §5.3, §8 C1, §10.1–10.2):
provider search → note detail → comments (incl. replies) → `public_posts` / `public_comments` with provenance →
cheap prefilter → group-level intent detection + scoring → actor classification → BUYER signals ≥ candidate go to
`upsertLeadFromSignal` (identity resolution / dedup). Assignment, lead research and outreach are chained by the
operator workflow, not here.

## Owning agent
`lead-hunting-agent`

## Inputs
- `runSearchQuery(ctx, {dealer_id, query_id, limits?: {max_posts?, max_comments_per_post?}})`
- `runDiscovery(ctx, {dealer_id, goal_id?, max_queries?, limits?})` — queries from `selectQueriesToRun`
- `ingestPublicContent(ctx, {dealer_id, notes: (XhsNoteDetail & {comments})[], search_run_id?, query_id?, data_mode?})`
  — also the manual import path for real JSON exported from xiaohongshu-mcp (validated; counts accept `"1.2万"`,
  timestamps accept ISO / epoch ms; nested `sub_comments` are flattened).
- Skill `lead-discovery`: `{dealer_id, goal_id?, max_queries? (1–50), limits?}` → `runDiscovery`.
- Defaults: 10 posts per query (cap 50), 50 comments per post (cap 500), 8 queries, provider window 90 days, sort general (综合).

## Outputs
- `SearchRun` rows: `provider`, `data_mode` (`live` / `simulation` from the provider mode), status
  `SUCCEEDED | FAILED | UNAVAILABLE`, `error` with the provider's status + reason, counters
  `posts_discovered` (notes selected to read from the search results), `posts_new`, `comments_scanned`, `users_evaluated` (distinct non-managed authors),
  `candidates / qualified / high_intent` (distinct leads touched whose current tier is at least that level).
- `public_posts` (url `https://www.xiaohongshu.com/explore/<id>?xsec_token=…`, `own_post_id` when the note is one of our
  posts, `first_search_run_id` kept, `data_mode`) and `public_comments` (prefilter result, `data_mode`).
- Lead signals via lead-deduplication; afterwards `lead_signals.actor_type`, `leads.actor_type`
  (`aggregateActorType`) and `leads.data_mode` (`live` once any live signal merges).
- `IngestSummary` {data_mode, posts, posts_new, comments, users_evaluated, prefilter_rejected, by_actor_type,
  below_candidate, signals_created, leads_created, leads_merged, lead_ids, public_post_ids, skipped_managed,
  skipped_anonymous, rejected_by_policy}.
- `DiscoveryResult` {runs, leads_touched, blocked: {status, reason, query_id} | null}.
- Decision `lead_prefilter` per ingested note (counts by prefilter reason and actor type, verbatim samples of rejected
  texts); audit events `search_run.completed`, `search_run.unavailable`, `discovery.blocked`, `public_content.ingested`.

## Validation & guarantees
- Capability `search_public_content` is checked first; anything but AVAILABLE ends the run UNAVAILABLE with the reason and
  writes no public rows. There is no fallback to other data.
- Provider calls are sequential (one headless-browser call at a time on a live instance) and happen before transactions.
- Per-note failures are counted and audited; REQUIRES_AUTH stops the run (UNAVAILABLE) after ingesting what was already
  fetched; every note failing otherwise ends FAILED.
- `runDiscovery` stops at the first UNAVAILABLE / REQUIRES_AUTH run so a logged-out instance is not hammered. A
  transient search failure (retryable UNAVAILABLE after the capability check passed, e.g. a xiaohongshu-mcp tool
  timeout) ends only that run FAILED and the batch continues; `MAX_CONSECUTIVE_TRANSIENT_FAILURES` (2) in a row block.
- The `discover` workflow step is SKIPPED (with the reason) whenever no run succeeded, blocked or not.
- Search: `SEARCH_SORT` = general (综合; 最新 is dominated by dealer promotion posts), one page of
  `SEARCH_RESULTS_CONSIDERED` (20) results; `selectNotesToRead` skips dealer-store / staff authors
  (`notes_skipped_seller`) and reads the most-commented notes first, up to `max_posts`.
- Freshness: the search asks for notes of the last `LEAD_FRESH_DAYS` (7) days; older comments are stored but counted as
  `stale_skipped`, never evaluated.
- Screening (`llm-screen.ts`): candidates that pass the rules go to the LLM with the post and the comment they reply to;
  only `buyer` verdicts (verbatim quote, stored as `llm_screen` evidence) become leads; `screen` stats per note are in the
  `lead_prefilter` decision. Without an LLM the rules decide (`screened_by: 'rules'`). Area: `targetAreaFor(goal)`.
- Progress: `runDiscovery(ctx, input, onProgress)` reports query i/n, phase and note j/m (workflow step `progress`).
- Maintenance `rescreenLeads(ctx, {dealer_id, limit?, apply_area?})` (`rescreen.ts`, `POST /api/leads/rescreen`):
  re-screens open leads made before the LLM screen and closes the non-buyers through the CRM (LOST reason
  `llm_screen`, assignment released, outreach cancelled, audit `lead.rescreened`). Leads at CONTACTED or deeper, and
  leads whose screen fails, are left untouched; without an LLM it changes nothing.
- One provider call per note when the provider has `getNoteWithComments`; notes fetched within `REFETCH_AFTER_MS` (12 h)
  are skipped and counted as `notes_skipped_recent` (a batch whose notes were all read recently still SUCCEEDS).
- Prefilter first: rejected texts never reach intent detection. Only `classifyActor` = BUYER with best score ≥ the best
  dealer's candidate threshold becomes a lead signal; owners, creators, dealer/sales accounts and enthusiasts never do.
- Managed accounts (`platform_account_id` / verified `platform_user_id`) are never evaluated as leads.
- Idempotent: public rows upsert by platform ids; lead-deduplication ignores re-observed comments/posts.
- `live` provenance is never downgraded by a later non-live fetch; simulation rows never get fabricated xiaohongshu.com URLs.
- Signal content is verbatim (posts: title + "\n" + content, exactly the text the NLU quotes from).

## Runtime entry points
- Operator workflows `lead_discovery` / goal workflows call `runDiscovery`, then research, assignment and outreach.
- Console "导入公开内容" calls `ingestPublicContent` with `data_mode: 'import'`.
- `GroupEvaluator` / `groupDealerIds` are exported for callers that need the same group-level evaluation.

## Failure modes
- Provider not configured / unreachable / logged out → run UNAVAILABLE, `blocked` returned, operator sees the reason.
- Missing `xsec_token` (xiaohongshu-mcp requires it) → per-note detail failure, counted.
- Unexpected ingest error → run FAILED with the error; policy refusals from dedup (`not_a_purchase_signal`,
  `managed_account_identity`, `signal_identity_conflict`) are counted, not thrown.
- Unknown dealer / query from another dealer / invalid import JSON → `NotFoundError` / `ValidationError`.

## Tests
`node --test test/unit/discovery/*.test.ts` — simulation corpus run (one lead for u-hz-buyer-001 with ≥3 verbatim
signals, BUYER, simulation provenance, explore URLs), spam and managed authors skipped, exact run counters, idempotent
re-run, unavailable provider, REQUIRES_AUTH at capability and mid-run, no-query block, import path provenance and
validation, a stub live provider with xiaohongshu-mcp payload shapes (live provenance, real explore URL), own-post
attribution, decisions and skill registration.
