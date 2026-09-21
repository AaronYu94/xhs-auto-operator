# lead-research

## Responsibility

Researches a lead's **public** Xiaohongshu profile context (spec §4, ARCHITECTURE §8 B1) to decide how authentic
and relevant the person is:

- detects dealer / sales / used-car / broker accounts from the public nickname and bio (never acquisition leads),
  closes such leads (`LOST`, reason `industry_account`) while they have not been contacted, and frees the owning
  account (undelivered outreach cancelled) so nobody messages a trade account;
- marks verified local users (profile IP 属地 province = dealer province, not an industry account);
- captures purchase signals from the user's own recent public notes (through lead-deduplication, idempotently);
- re-scores the lead (authenticity on the 0..5 scale: industry 0 · verified local 5 · otherwise 4).

It only uses what the provider genuinely returns: when `read_public_profile` is not `AVAILABLE`, or the profile call
fails, the research is recorded as **skipped** and no profile data, evidence or signal is invented.

## Owning agent

`lead-research-agent` (skill category `acquisition`).

## Inputs

- Skill input: `{ lead_id: string }` (validated, non-empty).
- `researchLead(ctx, leadId)` reads the lead, its dealer, the global suppression list, provider capabilities
  (`ctx.xhs.capabilities(null).read_public_profile`), the `xsec_token` of the most recent signal that came from a stored
  public note (`lead_signals → public_posts.xsec_token`, required by xiaohongshu-mcp `user_profile`), and
  `ctx.xhs.getUserProfile({platform_user_id, xsec_token})`.

## Outputs

`LeadResearchResult`: `{ lead_id, status: 'researched' | 'skipped', reason, authenticity: {score 0..5, reasons},
added_signals, industry_account }`.

Persisted effects when researched:
- `leads.evidence` gains `industry_account` (label `疑似车商/销售账号`, quote = the verbatim bio clause containing the
  keyword, or the nickname clause when only the nickname matched) and/or `verified_local_user` (label
  `本地真实用户（IP属地 <province>）`, quote = the IP 属地 string); both with `source_ref = profile:<platform_user_id>`.
  A previous research's `verified_local_user` evidence is replaced by the current result (IP 属地 changes, the lead may
  have moved dealer); `industry_account` evidence is kept. `profile_url` filled when missing; audit `lead.researched`
  (`added_evidence`, `removed_evidence`).
- Industry account with stage before `CONTACTED` → `transitionLead(LOST, reason 'industry_account', actor
  agent:lead-research-agent)`, then `releaseAssignment` (account-assignment) when an active assignment exists — the
  assignment is released and that account's undelivered outreach is cancelled.
- Recent-note purchase signals → `upsertLeadFromSignal(source_type 'profile', content = note title, public_post_id null,
  signal_at = note published_at)` (lead-deduplication's decisions, scoring and stage rules apply).
- `scoreLead` at the end; `refreshNextAction`.
- Decision `lead_research` (agent `lead-research-agent`, skill `lead-research`) — inputs: provider name/mode, capability
  state, whether an xsec_token was used, profile summary (nickname, bio, IP 属地, follower/note counts, recent note
  titles); evidence: the evidence found; output: status, reason, industry keywords, verified-local flag, IP/dealer
  province, authenticity, added/removed evidence, `assignment_released`, added signals, per-note outcomes, stage and
  score before/after.

When skipped: only the `lead_research` decision (status `skipped`, reason, capability state); authenticity is derived
from the lead's existing evidence; no other write.

## Validation & guarantees

- `detectIndustryAccount` also flags store / staff account names (`DEALER_ACCOUNT_NAME_RE`, e.g. `…销售服务中心`,
  `<品牌>汽车 | 小李`), quoting the nickname; an IP 属地 in the dealer's province never makes such an account local.

- Provider calls happen before any transaction; everything after them is synchronous (`ctx.db.tx` never spans an await).
- Skip reasons are explicit: `<CAPABILITY_STATUS>: <provider reason>` (e.g. `UNAVAILABLE: No Xiaohongshu integration
  configured`), `<status>: <reason>` of a failed `getUserProfile`, `UNAVAILABLE: capability check failed: …` /
  `profile request failed: …` when the provider throws, `profile_mismatch: …` when the provider returns another user,
  `lead_suppressed: …` for do-not-contact users — checked before the provider call (their profile is not read) **and
  again after it** (a user suppressed while the profile was being read: nothing from the profile is stored).
- **Industry detection is context-aware** (nickname + bio, NFKC/case-insensitive, per clause split on ｜,，。!？；、 etc.).
  Keywords: 4S店 · 销售顾问 · 汽车顾问 · 车商 · 二手车 · 收车 · 车行 · 置换热线 · 经纪人 · 买车找我 · 私信报价 · 底价.
  Unambiguous trade phrases (汽车顾问, 车商, 置换热线, 买车找我, 私信报价) always count. Words that real buyers use are
  only counted in a trade context, because closing a buyer as LOST silently loses the lead:
  - `4S店` — unless the clause is a consumer experience (踩坑/套路/砍价/维权/投诉/提车/记录…) without employment words (销售/顾问/经理/在职/老兵…);
  - `销售顾问`, `经纪人` — only with automotive context in the clause (汽车/二手车/4S/车行/车商/新车/试驾/车源/车辆/购车/车型 or a car brand; 小米 alone does not count), so 房产经纪人 / 保险销售顾问 / 医美销售顾问 are not flagged;
  - `二手车` — a trade phrase (二手车商/收购/评估/经纪…, 高价收) or no consumer wording (卖了/想买/车主/代步/入手/攻略…);
  - `底价` — seller wording (私信/找我/咨询/全网/内部/报价…) or no buyer wording (求/问/等/蹲/多少/吗/？…);
  - `收车` — unless it is a driver ending a shift (司机/网约车/滴滴/出租/代驾/下班/回家) without trade words;
  - `车行` — except bicycle / e-bike / motorbike shops (自行车行, 电动车行…).
  Evidence quotes are always verbatim substrings of the profile text.
- Verified local requires a parsable IP 属地 whose province equals the dealer's province and no industry hit.
- Recent notes: only the user's own notes (a note whose author id differs → `other_author`); notes already captured
  as a stored public-note signal of this lead (same `platform_post_id`) are not re-added (no double corroboration);
  publish times are parsed like lead-deduplication signal times (offset or dealer-timezone wall clock); undated or
  unparsable → `unknown_publish_time`, later than now + 15 min → `future_publish_time`, older than
  `STALE_NOTE_DAYS` (90, the last non-zero recency bucket) → `stale_note`; non-purchase titles are ignored;
  `PolicyError` / `ValidationError` from lead-deduplication are recorded per note (`rejected`) and do not abort the
  research. Industry accounts contribute no recent-note signals.
- Evidence is merged with `dedupeEvidence`, so repeated research is idempotent (no duplicate evidence, no duplicate
  signals, no second LOST transition).
- Leads already `CONTACTED` or deeper keep their stage (a human conversation exists); WON / LOST are never changed.

## Runtime entry points

`src/skills/acquisition/lead-research/index.ts`

- `researchLead(ctx: AppContext, leadId: string): Promise<LeadResearchResult>`
- `detectIndustryAccount(profile: {nickname?, bio?}): { industry: boolean; keywords: string[]; evidence: Evidence | null }` (pure)
- constants `INDUSTRY_KEYWORDS` (+ type `IndustryKeyword`), `INDUSTRY_EVIDENCE_LABEL`, `STALE_NOTE_DAYS`
- `skill` — name `lead-research`, category `acquisition`, agent `lead-research-agent`, input `{ lead_id }`, output
  `LeadResearchResult` (post-conditions: authenticity within 0..5; skipped research adds no signals).

Typically invoked by the Operator's signal-processing workflow for new CANDIDATE / QUALIFIED leads before the Fleet
Controller assigns them.

## Failure modes

- Unknown lead → `NotFoundError('lead')`; unknown dealer → `NotFoundError('dealer')`.
- Capability not available / provider failure / thrown provider error → `status: 'skipped'` with the reason (no exception).
- Context rules reduce but cannot eliminate keyword misclassification (e.g. an unusual buyer bio without consumer
  wording, or a dealer bio phrased like a review); the matched keywords and quote are recorded in the evidence and
  decision so an operator can review and reopen the lead.
- Errors other than `PolicyError` / `ValidationError` raised while storing a recent-note signal propagate (the evidence
  already written stays).

## Tests

- `test/unit/lead-research/research-lead.test.ts` — with `SimulationXhsProvider`: `u-dealer-spam-001` → industry evidence
  quoted from the bio, LOST, authenticity 0, lower score, decision; industry account already CONTACTED keeps its stage;
  `u-hz-buyer-001` → verified local user (authenticity 5), xsec_token usage; out-of-province IP stays default;
  recent-note signals added exactly once (canonical corpus and a custom corpus), already-captured notes skipped;
  undated notes and profile mismatches via a scripted provider; `UnavailableXhsProvider` / unknown user / suppressed lead
  → skipped with no evidence; pure `detectIndustryAccount` cases; registry invocation and input validation.
- `test/unit/lead-research/hardening.test.ts` — realistic buyer bios with ambiguous trade words (房产经纪人, 保险/医美
  销售顾问, 4S店踩坑, 求底价, 卖了二手车, 网约车收车, 自行车行) are not flagged while dealer / used-car / broker accounts are,
  with verbatim quotes; a real-estate agent researching a BMW stays a qualified lead; closing an industry account
  releases its assignment and cancels pending outreach; a suppression that lands during the provider call persists
  nothing; recent notes by other authors or older than 90 days are not added; IP-based local verification is refreshed
  on every research.

Run: `node --test test/unit/lead-research/*.test.ts`
