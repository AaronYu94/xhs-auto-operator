# analytics

## Responsibility
Business-outcome analytics for the operator console and the Automotive Operator (spec §16 content → lead attribution,
§17 dashboard, §18 lead inbox, §19 funnel/outcomes, §26 "AI employee" briefing). It answers three questions:
- **What happened today?** Content, discovery, outreach, sales and pipeline numbers for a dealer-local period.
- **What needs me?** Queues of exceptions that need a human, plus fleet health.
- **What actually sells cars?** Content and account performance measured by leads, appointments and sales, not likes.

Every figure is computed at read time from the persisted tables (posts, search_runs, lead_stage_transitions, outreach,
conversations/messages, appointments, conversions, account_health, workflow_runs, …). There is no static, sampled or
fabricated data. The plain functions are read-only. The skill run writes one audited `report` decision when it produces a
dashboard.

## Owning agent
`analytics-agent` (skill category `operations`).

## Inputs
`AnalyticsFilters` (all optional; empty strings are ignored; text is NFKC-normalized so full-width input such as `ＢＭＷ` matches):

| filter | leads | own posts | search runs | accounts |
|---|---|---|---|---|
| `dealer_id` | `leads.dealer_id` | `posts.dealer_id` | `search_runs.dealer_id` | accounts of the dealer |
| `account_id` | lead's **active** assignment is that account | `posts.account_id` | the account's dealer | only that account |
| `brand` | `json_extract(intent,'$.brand')`, case-insensitive; 宝马 → BMW | – | `search_queries.brand` | – |
| `model` | `json_extract(intent,'$.model')`, case-insensitive; 3系 → 3 Series | `posts.model` | `search_queries.model` | – |
| `location` | `intent.location` OR `intent.province`; a province also matches its cities; 杭州市/杭城 → 杭州 | – | `search_queries.location` | – |
| `from` / `to` | ISO-8601 datetime with zone, or `YYYY-MM-DD` dealer-local (`to` date inclusive) | | | |
| `source_type` | lead has a signal of that type | – | – | – |
| `stage` | current `leads.stage` | – | – | – |

When both `dealer_id` and `account_id` are given, the account must belong to that dealer (otherwise `ValidationError`
instead of silently mixing one store's discovery numbers with another store's leads).

Skill input: `{kind: 'dashboard'|'inbox'|'funnel'|'attribution'|'accounts'|'lead_detail', filters?, lead_id?}`.
- `filters` also accepts `tier`, `limit` (1..500) and `offset` (≥0) for `inbox`.
- `lead_id` is required for `lead_detail`, which is additive to the contract.

## Outputs
- `resolvePeriod(ctx, f)` → `{from, to, timezone, is_today}`. The window is half-open, `[from, to)`, in UTC ISO.
  - Default: the dealer-local day `[00:00, next 00:00)` in `dealer.settings.timezone`. Asia/Shanghai is used when there is no dealer or account filter.
  - `from` only: runs until the end of today.
  - `to` only: the local day that ends at `to`.
- `getDashboard(ctx, f)` → `DashboardMetrics`:
  - `content`:
    - `posts_published`, `views` and `engagement` (likes+collects+comments+shares) sum the posts published in the period.
    - `posts_planned` counts `slot_date` within the period's local dates (all statuses except REJECTED).
    - `posts_pending_approval` counts posts currently IN_REVIEW.
  - `discovery`:
    - `posts_scanned`, `comments_scanned` and `users_evaluated` sum over search_runs started in the period.
    - `candidates` and `qualified` are distinct leads that **entered** that stage or deeper in the period (see guarantees).
    - `high_intent` is the subset of `qualified` whose current tier is `high_intent` or `immediate`.
  - `outreach`:
    - `outreach_ready` counts outreach currently READY_FOR_REVIEW or APPROVED.
    - `contacted` counts leads that entered CONTACTED in the period.
    - `replies` counts inbound messages in the period.
    - `reply_rate` = distinct leads with an inbound message in the period ÷ `contacted`. It is 0 when nobody was contacted and never exceeds 1.
  - `sales`: `sales_qualified`, `contacts_acquired`, `appointments`, `visits`, `won` and `lost` are distinct leads entering each stage in the period.
  - `pipeline`:
    - `estimated_value` = Σ over open leads (QUALIFIED…NEGOTIATING, not suppressed) of `estimated_value × STAGE_WIN_PROBABILITY[stage]`, rounded per stage.
    - `by_stage` lists every open stage, including zero rows.
  - `accounts`:
    - `active` counts accounts with status `active`.
    - `healthy` counts accounts whose latest snapshot is HEALTHY.
    - `requiring_attention` lists `{account_id, nickname, state, issues}`. An account with no snapshot is listed with `state: null` and the issue `尚未计算健康度`. Order: RESTRICTED, AT_RISK, never computed, WATCH.
  - `exceptions`: `[{kind, title, count, severity, href}]`. Only kinds with count > 0 appear, ordered by severity (high → low):

    | kind | counts | severity | href |
    |---|---|---|---|
    | `conversations_needs_human` | open/handed-off conversations with `needs_human` | high | `/conversations?needs_human=1` |
    | `outreach_review` | outreach READY_FOR_REVIEW | high | `/leads?outreach_status=READY_FOR_REVIEW` |
    | `appointments_unconfirmed` | `proposed` appointments with `scheduled_for` in [now, now+48h) | high | `/leads?stage=APPOINTMENT` |
    | `workflow_failed` | workflow_runs FAILED, finished (or started) during dealer-local today | high | `/system?run_status=FAILED` |
    | `outreach_manual_send` | outreach APPROVED whose `capability_status` ≠ AVAILABLE | medium | `/leads?outreach_status=APPROVED` |
    | `posts_in_review` | posts IN_REVIEW | medium | `/content?status=IN_REVIEW` |
    | `reply_drafts` | outbound `draft` messages in non-closed conversations | medium | `/conversations?drafts=1` |
    | `engagement_replies_review` | engagement replies READY_FOR_REVIEW | medium | `/content?engagement_status=READY_FOR_REVIEW` |
    | `qualified_unassigned` | QUALIFIED-or-deeper, non-terminal, not suppressed, no active assignment | medium | `/leads?unassigned=1` |
    | `accounts_attention` | `accounts.requiring_attention.length` | high if any account is RESTRICTED or AT_RISK, else medium | `/accounts` |
    | `outreach_blocked` | outreach BLOCKED with `updated_at` in the last 7 days | low | `/leads?outreach_status=BLOCKED` |

    Hrefs carry `dealer_id=<scope dealer>` when the view is scoped.
  - `briefing`: Chinese lines built only from the numbers above, e.g. `今日计划 7 篇内容，1 篇待审批`, `分析了 428 条公开信号`,
    `发现 34 条合格线索，其中 11 条高意向`, `8 条私信待你审核`, `5 条回复需要人工处理`, `新增 3 个到店预约`,
    `预计管道价值 16.3万`.
    - Lines whose facts are zero are omitted.
    - When nothing happened there is one line: `今日暂无新的运营进展`.
    - The prefix is `今日` for the default period and `本期` for custom windows.
- `getLeadInbox(ctx, f & {tier?, limit=50, offset=0})` → `LeadCard[]`, sorted by score DESC, then last_signal_at DESC, then id. Each card has:
  - `score`, `tier`, and `tier_label` (立即跟进/高意向/合格/候选/未达候选).
  - `model_label`, e.g. `BMW i3 eDrive35L`, built with `modelDisplayName(...,'en')` plus the trim. It is `车型未明确` when unknown.
  - `location_label`, never overstating certainty: the stated city, else the stated province, else an inferred city
    (`杭州（推断）`), else an IP-inferred province (`IP属地：浙江` — intent detection infers a province only from the
    Xiaohongshu IP 属地), else the signal author's own IP (`IP属地：<ip>`; the commenter's, never the note author's for a
    comment), else `地区未知`.
  - `purchase_stage` and its Chinese label.
  - `intent_chips` (max 6, distinct labels) explain WHY the lead matters, in priority order:
    1. warnings from any signal (`already_purchased`, `content_creator`, `marketing_account`, `industry_account`, `not_interested`, `negative_feedback`);
    2. the evidence of the representative (primary) signal;
    3. evidence of the other purchase signals, strongest first;
    4. lead-level evidence (e.g. lead research).

    Prefilter outcomes (`无购车相关信号`, `纯夸赞，无购车意图`, `空内容/仅表情`, `内容过短`) and the evidence of remarks that
    are not purchase signals (merged only for history) are never chips.
  - `source {type, post_title, url, signal_at}`; a comment-only signal resolves its note through the comment row.
  - `original_signal`: the verbatim content of the primary signal (fallbacks: strongest purchase signal, then latest), with its id.
  - `signal_count`.
  - `assigned_account {id, nickname, account_type} | null` (the active assignment).
  - `stage`.
  - `next_action`: live, from CRM `computeNextAction`.
  - `outreach_status` of the latest outreach.
  - `suppressed`.

  Explicit `from`/`to` bound `last_signal_at`. Without them every matching lead is listed.
- `getLeadDetail(ctx, leadId)` → `LeadDetail`:
  - `lead`, `card`, `dealer`.
  - `signals`, each with its `public_post`/`public_comment` rows (the post resolved through the comment when the signal only carries the comment id) and an `is_primary` flag.
  - `scores` (history).
  - `assignment`, plus `candidates` (the active ranking, or the latest one), and the `assignments` history.
  - `outreach[]`.
  - `conversation` + `messages` (the most recent conversation) and every `conversations[]` entry.
  - `appointments`, `conversions`.
  - `transitions`, `decisions` and `events`, via CRM `getLeadTimeline`. This covers the lead plus its signals, comments, assignments, outreach, conversations, messages, appointments and conversions.
  - `suppression`.
- `getContentAttribution(ctx, f)` → one `ContentAttributionRow` per PUBLISHED post. Columns:
  - `views`, `engagement`.
  - `comments_collected`: customer comments on the public_posts row with `own_post_id`; replies written by our own managed
    accounts are excluded.
  - `commenter_profiles`: distinct commenters, excluding managed accounts.
  - Managed accounts are recognized by `xhs_accounts.platform_account_id` **or** the verified Xiaohongshu id `xhs_accounts.platform_user_id` (v3, live sessions).
  - `leads`, `qualified_leads`, `conversations`, `appointments` (not cancelled).
  - `won`, `won_value` (Σ `conversions.amount`).

  Sorted by won, then appointments, then qualified_leads, then engagement (all DESC). Explicit `from`/`to` bound `published_at`.
- `getFunnel(ctx, f)` → every `LEAD_STAGES` entry `{stage, count, reached, conversion_from_prev}`:
  - `reached` = leads at that stage or deeper, with LOST excluded from the chain.
  - `conversion_from_prev` = reached ÷ reached(previous stage). DISCOVERED is 1 when leads exist. LOST is 0.
  - Explicit `from`/`to` restrict the cohort by `first_seen_at`.
- `getAccountsOverview(ctx, dealerId?)` → per account:
  - identity: nickname, type, status, auth_state, `persona_name` (null when the account has no persona — never substituted with the nickname), focus_models.
  - latest health: `health_state`, `health_score`, `health_issues`, `health_date`.
  - `active_leads`, `outreach_sent_30d`, `reply_rate_30d`, `appointments_90d`, `won_90d`, `posts_published_30d`, all taken from Account Brain `getAccountPerformance`.
- Skill output: `{kind, result}`, where `result` is the matching function's return value.

## Validation & guarantees
- **No NaN.** Every ratio has a zero-denominator guard, and SQL aggregates are coalesced. The skill's `validateOutput` rejects any non-finite number in the result. An empty database returns zeros, empty lists and the single "no progress" briefing line.
- **"Entered a stage" comes from `lead_stage_transitions`.** Lead deduplication writes `NULL → DISCOVERED` on creation and CRM transitions for every later move.
  - A non-terminal transition enters stage X when it lands at X or deeper coming from a shallower stage, from `NULL`, or from `LOST` (a reopened lead).
  - So a forward jump (DISCOVERED → QUALIFIED) counts for both candidates and qualified, while a later move (ASSIGNED → CONTACTED) does not count again for QUALIFIED.
  - WON and LOST count only on explicit moves to them. A jump to WON never counts as an appointment or visit.
  - Counts are distinct leads.
- **Period boundaries are half-open in the dealer timezone.** With the default clock (Sat 2026-09-12 10:00 Shanghai):
  - 23:59 local (`15:59Z`) counts today.
  - 00:00 the next day (`16:00Z`) and 00:01 do not count.
  - 23:59 the previous day does not count.
  - Stored timestamps must be UTC ISO strings, which `ctx.clock.iso()` and lead deduplication's `signal_at` normalization guarantee.
- **Filters are parameterized SQL**; user input is never interpolated. Unknown `dealer_id`/`account_id` → `NotFoundError`. A bad stage, source type, tier, limit, offset or date, `from ≥ to`, or an account outside the filtered dealer → `ValidationError`.
- **The inbox never hides provenance and never overstates.** Every card carries the verbatim original signal text and its source link, and shows the owning account whenever an active assignment exists. IP-inferred provinces are labelled `IP属地：…`. The chips explain the primary signal, not noise from unrelated remarks. The real simulation corpus is run through rules NLU → lead deduplication → fleet controller in `hardening.test.ts` to check these invariants on every card.
- **Attribution is single-touch, so rows sum without double counting.**
  - A lead belongs to `lead.attributed_post_id`, or else to the own post of its earliest signal on one of our notes. Comment signals are resolved through `public_comments.public_post_id`.
  - A won conversion is credited to `conversions.attributed_post_id` when recorded, otherwise to its lead's post. A lead with a won conversion is credited only through that conversion, never a second time through its lead post.
  - A lead in stage WON without any won conversion row still counts as won, with value 0.
  - `qualified_leads` counts leads currently at QUALIFIED or deeper, or with any transition from/to a QUALIFIED-or-deeper non-terminal stage. This keeps LOST leads that had been qualified.
- **Read-only.** Personas and health snapshots are never created by analytics. An account without a snapshot is reported, not computed.

## Runtime entry points
Skill `analytics`, exported from `src/skills/operations/analytics/index.ts`:
```ts
resolvePeriod(ctx, f?: AnalyticsFilters): AnalyticsPeriod            // {from, to, timezone, is_today}
getDashboard(ctx, f?: AnalyticsFilters): DashboardMetrics
getLeadInbox(ctx, f?: AnalyticsFilters & {tier?, limit?, offset?}): LeadCard[]
getLeadDetail(ctx, leadId: string): LeadDetail
getContentAttribution(ctx, f?: AnalyticsFilters): ContentAttributionRow[]
getFunnel(ctx, f?: AnalyticsFilters): FunnelStage[]                   // {stage, count, reached, conversion_from_prev}
getAccountsOverview(ctx, dealerId?: string): AccountOverviewRow[]
buildBriefing(metrics, exceptionCounts): string[]                     // pure
buildLeadCard(ctx, lead): LeadCard; modelLabel(intent); locationLabel(intent, ip); intentChips(evidence)
TIER_LABELS, PURCHASE_STAGE_LABELS, NON_INTENT_EVIDENCE_CODES, WARNING_EVIDENCE_CODES, EXCEPTION_KINDS,
OPEN_PIPELINE_STAGES, HEALTH_NOT_COMPUTED_ISSUE, ANALYTICS_KINDS
skill   // {kind, filters?, lead_id?} → {kind, result}
```
Internal files:

| file | contents |
|---|---|
| `filters.ts` | normalization, periods, SQL scopes, stage SQL |
| `dashboard.ts` | dashboard queries and briefing |
| `leads.ts` | inbox cards (chips, labels, provenance) and lead detail |
| `content.ts` | content attribution |
| `funnel.ts` | funnel |
| `accounts.ts` | account overview and health attention |
| `types.ts` | result types |

Callers:
- the HTTP server: the 总览, 线索, 内容 and 账号 tabs
- the operator's evening analysis and reporting: the skill with `kind: 'dashboard'`, which records a `report` decision containing the briefing and the exception counts
- optimization: attribution and the funnel

## Failure modes
- `NotFoundError`: unknown `dealer_id`, `account_id` or lead.
- `ValidationError`:
  - malformed filters: a non-string value, an unknown stage/source/tier, an invalid date, or `from ≥ to`
  - an `account_id` that does not belong to the given `dealer_id`
  - `limit` outside 1..500, or a negative `offset`
  - a missing `lead_id` for `lead_detail`
- The skill throws when a result contains a non-finite number, which would mean corrupted data.
- **Limitations:**
  - `views` and `engagement` are the current cumulative metrics of posts published in the period, not per-day deltas, because metric history is not stored.
  - A live MCP provider reports no views, so `views` stays 0.
  - `brand`, `location`, `source_type` and `stage` do not filter our own posts (posts have no such columns). `account_id` does not narrow search runs beyond the account's dealer, because discovery is dealer-level.
  - Dealer-scoped failed-run counts exclude runs with `dealer_id` NULL.
  - A health snapshot is used as the latest one regardless of its age (consistent with Account Health's own guards).
  - `reply_rate` follows the contract formula (leads replying in the period ÷ leads contacted in the period); replies to earlier outreach can reach the cap of 1 on a quiet day. Per-account cohort reply rates come from `getAccountPerformance`.
  - Period comparisons are string comparisons on UTC ISO timestamps; a writer that stores offsets (`+08:00`) or no milliseconds at a boundary instant would be misplaced by the comparison.
  - Leads inserted without any transition row (raw imports that bypass lead deduplication) are not counted as having "entered" a stage, but they do appear in the inbox, funnel and pipeline.

## Tests
- `test/unit/analytics/dashboard.test.ts`:
  - exact content, discovery, outreach and sales counts from seeded posts, search runs, transitions and messages
  - Asia/Shanghai period boundaries (23:59 counts, 00:00/00:01 next day and the previous day do not)
  - custom and date-only periods, and `resolvePeriod` validation
  - forward jumps, and WON jumps not counted as appointments
  - reply-rate math, including the zero-denominator and cap cases
  - pipeline value math
  - filters by account, model, location, stage and source
  - the complete exceptions list, with severity order and hrefs
  - account attention, including a never-computed account
  - briefing lines matching the numbers, and the empty-day line
  - an empty database returns zeros and no NaN
  - the skill records a `report` decision
- `test/unit/analytics/leads.test.ts`:
  - inbox ordering and paging
  - the verbatim original signal and assigned account on every card, including the fallback when there is no primary signal
  - labels (model, location, IP, tier, stage) and max 6 chips
  - filters (tier, account, model, location, source, stage, from/to)
  - lead-detail completeness: signals with public rows, scores, assignment ranking, outreach, conversations, appointments, conversions, transitions, decisions incl. outreach and conversation subjects, events, suppression
  - NotFound and validation errors
- `test/unit/analytics/content-funnel-accounts.test.ts`:
  - attribution ranks a post with 1 won above a post with 10× engagement and 0 leads
  - comment/commenter counts that exclude managed accounts
  - implicit first-touch attribution through comment signals, without double counting
  - won_value and a won conversion credited by `attributed_post_id`
  - funnel counts and conversions, with LOST excluded from the chain
  - account overview (persona, health, performance, never-computed health, no invented persona) and dealer validation
  - skill kinds and input validation
- `test/unit/analytics/hardening.test.ts` (real simulation corpus through rules NLU → lead deduplication → fleet controller, plus regressions):
  - every card: stored verbatim original signal, source link, owner for ASSIGNED leads, no prefilter-noise chips, primary-signal evidence leading the chips, IP-inferred provinces labelled `IP属地：…`
  - the multi-signal buyer `u-hz-buyer-001` shows 询问现车/想到店看车 from its primary signal; the lurker `u-noise-002` shows no noise or unrelated-remark chips
  - dashboard qualified count equals the dedup QUALIFIED transitions
  - own-account replies (legacy key and verified Xiaohongshu id) excluded from comments and commenter profiles
  - comment-only signals resolve their note on the card and in the detail view
  - a won lead credited once when the conversion names a different post
  - dealer/account scope mismatch rejected
  - no persona name invented
  - full-width filters for models outside the lexicon
  - location/chip label helpers
