# xhs-research

## Responsibility
Evidence-based Xiaohongshu content research for one dealer (spec §15 research step): what prospective buyers
actually ask, which content topics earn engagement, and which content formats attract buyer questions rather than
just likes. Output feeds the account strategy (finance / comparison question frequency) and the operator report.
It never invents numbers: every insight quotes public text verbatim and cites the note/comment it came from.

## Owning agent
`research-agent` (skill `xhs-research`, category `research`).

## Inputs
`{ dealer_id: string; models?: string[]; location?: string | null; window_days?: number }`
- `models` — canonical names or aliases ('宝马3系' → '3 Series'); default = the dealer's carried models
  prioritized by in-stock quantity, in-transit quantity, active model offers, then catalog order.
- `location` — default the dealer city; `null` disables location queries.
- `window_days` — 1..180, default 30.

## Outputs
A persisted `ResearchBrief` (`research_briefs`, `kind = 'xhs'`, `engine = 'rules'`, `workflow_run_id = ctx.runId`):
- `findings.top_questions` — buyer question clusters (`QUESTION_CLUSTERS`: 价格/落地价/优惠/现车/颜色配置/贷款/
  租赁/置换/哪家店/试驾/车型对比/产品细节/预算场景) with `count` (distinct comments) and a verbatim `example_quote`
  (most-liked example).
- `findings.topics` — title-pattern topics (`TOPIC_PATTERNS`, multi-label, '其他' otherwise) with `posts` and
  `engagement` = likes + collects + comments.
- `findings.insights` — top 3 question clusters, highest-engagement topic, and "likes leader vs buyer-question
  leader" format comparison, each with Evidence (`quote` + `source_ref` `comment:<platform_comment_id>` /
  `note:<platform_post_id>`).
- `findings.headline`, `source_counts { posts, comments, provider_searches }`.

## Validation & guarantees
- Corpus: when `search_public_content` is AVAILABLE, ≤ 6 searches (`buildResearchQueries('xhs')`: 宝马i3, 杭州i3,
  宝马X3 …), ≤ 10 notes each within the window, note detail + comments with replies; analysed in memory only
  (nothing is written to `public_posts` — ingestion belongs to lead-discovery). Already-ingested `public_posts` /
  `public_comments` relevant to the scope (a scope model, or brand-level content naming no model) inside the
  window are merged in (dedup by platform ids). Provider notes pass the same relevance rule, so a competitor-only
  thread a search happened to return (e.g. a Model 3 owner note tagged 宝马i3) is not xhs research data.
- Copies of a comment (the same author posting the same text again, e.g. one question pasted under several notes)
  count once; the number ignored is recorded as `repeated_comments_ignored` in the decision.
- Buyer questions: comments analysed with the intent NLU (`analyzeSignal`, post context + IP) and the conversation
  NLU; counted only when the prefilter passed, not marketing, not negative/already-purchased, not a creator reply
  (comment author = note author), not a managed account, author role (when the NLU provides one) is asker/unknown,
  and the comment is phrased as a question/request (`isQuestionForm`, or a model comparison). Owner statements such
  as '开了两年，保养也不贵，推荐' never count as questions.
- Scope at comment level: a note enters the corpus when ANY of its texts is relevant, so its other comments are not
  counted blindly — a buyer question that explicitly names only models outside `scope.models` (e.g. '上海X3现在什么价'
  under a brand-level note in an i3 brief) is not counted (`namesOnlyOutOfScopeModels`); a question naming no model
  ('现在优惠多少') inherits its note's relevance.
- Before persisting, every evidence quote is re-verified as a verbatim substring of its referenced source; failing
  evidence is dropped (count recorded in the decision) and insights without evidence are dropped.
- Provenance (ARCHITECTURE §10.1): every note/comment carries its `data_mode` (the DB row's, or derived from the
  provider mode). A corpus made only of simulation data — from the simulation provider OR simulation rows already
  ingested into the DB — is labelled `【模拟数据】` in the headline, a mixed corpus `【含模拟数据】`; the decision records
  `data_modes`. Live / import data is never labelled simulation. Provider-unavailable runs say they are based on DB
  data only. With no corpus at all the brief is still persisted with an honest "暂无可分析的小红书公开数据…"
  headline, zero counts and no insights.
- One `agent_decisions` row (`decision_type = 'research'`, agent `research-agent`, subject `research_brief`) with
  scope, queries, provider status per query, DB corpus size, evidence and a sample-size confidence; one
  `research.brief_created` audit event.

## Runtime entry points
- `runXhsResearch(ctx, input): Promise<ResearchBrief>`
- `analyzeXhsCorpus(corpus, scope)` (pure), `topicsOfTitle(title)`, `TOPIC_PATTERNS`, `engagementOf(note)`
- Skill `xhs-research` (`skills.invoke(ctx, 'xhs-research', input)`); used by the `market_research` daily workflow.
- Shared engine: `src/skills/research/shared.ts` (`resolveScope`, `buildResearchQueries`, `gatherResearchCorpus`,
  `fetchProviderCorpus`, `loadDbCorpus`, `analyzeComments`, `QUESTION_CLUSTERS`, `persistBrief`, `latestBrief`).

## Failure modes
- `ValidationError` for malformed input; `NotFoundError` for an unknown dealer.
- Provider capability check / search / detail / comment failures never throw: they are logged per query in the
  decision inputs and the run continues with whatever data exists (DB corpus or nothing).
- NLU limitations propagate (e.g. a generic '多少' may be classified as a price question); clusters inherit them.

## Tests
`test/unit/research/xhs-research.test.ts` — simulation corpus run (bounded searches, non-empty question clusters and
topics, every evidence quote verbatim in the referenced corpus note/comment, no managed-account or marketing text
counted as buyer questions, simulation label, decision + event, nothing written to public_posts), DB-only corpus with
an unavailable provider, honest empty brief (unavailable provider + empty DB), explicit model/alias scoping, skill
invocation and input validation. Shared helpers: `test/unit/research/research-shared.test.ts`. Hardening regressions
(simulation rows in the DB labelled, mixed provenance, copied comments counted once, competitor-only provider threads
excluded, `latestBrief` with data): `test/unit/research/research-hardening.test.ts`. Comment-level model scope (an
X3-only question never counts in an i3 brief and vice versa): `test/unit/research/xhs-research-scope.test.ts`; the
same rule over the whole corpus: `test/integration/acquisition-core.test.ts`.
