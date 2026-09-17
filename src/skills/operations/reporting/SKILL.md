# reporting

## Responsibility
Generate the evening operator report (spec §20) and the AI-employee briefing lines (§26) for one dealer and one
dealer-local date. The report answers "what did the operation achieve today, what is blocked, and is the data real":
discovery counts, outreach queue, sales progress, pipeline value, content, account fleet, top search queries, top
converting content, lead data provenance (live Xiaohongshu / import / manual / simulation) and capability blocks
(e.g. DM sending unavailable, a session requiring login).

## Owning agent
`analytics-agent`

## Inputs
- `dealer_id` (required)
- `date` (optional `YYYY-MM-DD`, dealer-local; default: today in `dealer.settings.timezone`)

## Outputs
An `OperatorReport` row (`operator_reports`) whose `report` contains: `dealer`, `date`, `period {from, to, timezone}`,
`summary: string[]` (Chinese), `dashboard` (getDashboard), `funnel` (getFunnel), `top_queries` (getQueryEffectiveness,
runs > 0, top 5), `accounts` (getAccountsOverview), `top_content` (getContentAttribution top 5), `provenance
{all, period}` (lead counts by `data_mode`), `capabilities {provider, blocks, checked}` (latest non-AVAILABLE capability
snapshot per account/capability plus the LLM status), `workflow_runs` (status counts in the period).

## Validation & guarantees
- Every number comes from the analytics module or a direct count over real tables; summary lines are formatted only
  from those numbers (no estimates beyond the documented stage-weighted pipeline value).
- Simulation-sourced leads are called out explicitly ("注意：库中有 N 条模拟数据线索，不是真实客户").
- Capability blocks come from persisted `capability_snapshots` (written by account-sessions / refresh_dealer_data);
  the report never probes the provider itself (it is synchronous) and never reports a capability as working without a
  snapshot saying so.
- Persisted with `workflow_run_id = ctx.runId` and a `report` decision (confidence 1, engine rules).

## Runtime entry points
- `generateOperatorReport(ctx, dealerId, date?)` — used by the `evening_analysis` workflow and the console.
- `getLatestReport(ctx, dealerId, date?)`, `latestCapabilityBlocks(ctx, dealerId)`, `leadProvenance(ctx, dealerId, from, to)`.
- Skill `reporting` (`{dealer_id, date?}`).

## Failure modes
- Unknown dealer → `NotFoundError`. Malformed date → `NotFoundError('report date')`.
- An empty database yields a report of zeros with honest lines ("今日没有完成任何公开内容扫描").

## Tests
`test/unit/reporting/reporting.test.ts`: numbers equal analytics outputs for the same period; provenance counts by
data_mode incl. simulation warning; capability blocks from snapshots (latest per capability wins, AVAILABLE omitted);
persistence + decision; empty-dealer report has no NaN.
