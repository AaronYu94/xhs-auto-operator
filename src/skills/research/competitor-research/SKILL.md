# competitor-research

## Responsibility
Competitor intelligence from public Xiaohongshu discussion (spec §15 research, §5 COMPETITOR query class): which
competitor models are discussed together with the dealer's models, how often buyers explicitly compare them, and
which sentiment cues (香 / 值 / 不后悔 vs 后悔 / 不值) attach to which model. Feeds the account strategy
(comparison pillar) and comparison content angles.

## Owning agent
`research-agent` (skill `competitor-research`, category `research`).

## Inputs
`{ dealer_id: string; models?: string[]; location?: string | null; window_days?: number }` (same scope rules as
xhs-research; window default 30 days).

## Outputs
Persisted `ResearchBrief` (`kind = 'competitor'`):
- `findings.competitors[]` — one row per (our model, competitor) pair with `mentions > 0`: `brand`, `model`
  (competitor, canonical), `mentions`, `comparison_with` (our model), `example_quote` (verbatim, explicit comparisons
  preferred).
- `findings.insights` — top 3 pairs ("同框讨论N次（其中明确对比M次）") and up to 4 per-model sentiment summaries,
  each with verbatim clause evidence (`note:` / `comment:` refs).
- `findings.headline`, `source_counts`.

## Validation & guarantees
- Competitor relationships only from the lexicon (`competitorsOf(brand, model)`); model mentions only from
  `findModels` (post title as disambiguation context for comments).
- A unit (note = title + content, or one comment) counts once per pair when it states our model and the competitor,
  or when a comment states the competitor under a note that states our model. It is an explicit comparison only
  when both models are stated in the unit and the conversation NLU detects `model_comparison`.
- Sentiment cues (`香`, `值`, `不后悔` positive; `后悔`, `不值`, `不香` negative) are counted per unit, skipping question
  clauses ('值得买吗', '值不值', '香不香'). Negations and intensifiers are handled ('一点也不香' / '没那么香' → 不香,
  '没那么值得' → 不值, '这么香' → 香) with precedence so '不值' never also counts as '值' and '不香' never as '香'; words
  such as 香菜 / 香水 / 香港 are not cues. A cue is attributed to the nearest model in its clause, else the nearest
  preceding / following mention, else the single model of the note title. Only scope models and their competitors
  are tracked.
- Managed-account and dealer/marketing notes (prefilter, or intent-NLU nickname / role) are not discussion units
  themselves, but buyers' comments under them are analysed. Marketing comments and later copies of the same author's
  comment (same text pasted under several notes) are skipped, so one user never inflates a cue or a pair.
- Relevance includes competitor threads (a scope model or one of its lexicon competitors) for BOTH the provider search
  results and the ingested DB data.
- Corpus gathering (≤ 6 queries such as `i3 vs Model 3`, `X3 vs GLC`; ≤ 10 notes each; in-memory only), evidence
  re-verification, simulation labelling, honest empty brief, decision + audit event: identical to xhs-research
  (see `src/skills/research/shared.ts`).

## Runtime entry points
- `runCompetitorResearch(ctx, input): Promise<ResearchBrief>`
- `analyzeCompetitorCorpus(corpus, scope)` (pure), `findSentimentCues(mappedText)`, `SENTIMENT_CUES`, `CUE_POLARITY`
- Skill `competitor-research`; used by the `market_research` daily workflow (08:30).

## Failure modes
- `ValidationError` / `NotFoundError` for bad input / unknown dealer.
- Provider failures are recorded per query and never thrown.
- Models outside the lexicon are not recognized as competitors (no invented relationships).

## Tests
`test/unit/research/competitor-research.test.ts` — simulation corpus (i3 vs Model 3 / X3 vs GLC / 3系 vs C级 pairs
with verbatim quotes referencing real corpus ids, explicit comparison counts ≤ mentions, sentiment cue attribution to
Model Y), pure cue detection (question clauses skipped, 不值 vs 值, 不后悔 vs 后悔), DB-seeded corpus with an
unavailable provider, honest empty brief. `test/unit/research/research-hardening.test.ts` — negated / A-not-A /
intensified cues (不香, 香不香, 这么香, 香港), a copied comment counted once, competitor threads kept for competitor research.
