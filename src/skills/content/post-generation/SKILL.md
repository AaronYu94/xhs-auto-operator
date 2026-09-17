# post-generation

## Responsibility
Turns a planned content slot (created by `content-planning`) into a complete Xiaohongshu note draft for ONE managed
account: title, body, tags and cover text in that account's persona and account-type structure. Dealer facts (prices,
offers, finance / lease / trade-in programs, inventory, store data, campaigns, FAQ) are taken only from structured
Dealer Brain rows and every fact sentence carries `FactRef`s whose `claim` is a verbatim substring of the text
(spec §2 "the LLM must not invent dealership facts", §15 account-specific content).

## Owning agent
`content-agent` (category `content`).

## Inputs
- `generatePost(ctx, postId)` — post in `PLANNED`, `CHANGES_REQUIRED` or `DRAFTED` (regeneration).
- Skill input `{ post_id: string }`.
- Reads: the post (`pillar`, `angle`, `model`, `slot_date`), account + persona (tone, voice rules, signature phrases,
  taboo topics), dealer, carried vehicles (newest model year per trim), sellable inventory, active offers, active
  campaign / FAQ knowledge. Optional `ctx.llm` when `AVAILABLE`.

## Outputs
- The post updated to `DRAFTED` with `title` (≤ 20 chars, contains the model label or the brand for general posts),
  `body` (300–800 chars), `tags` (3–8, no `#`), `cover_text`, `fact_refs`, `engine` (`rules` or `llm+rules`),
  `review` cleared.
- Audit event `post.drafted`; decision `content_generation` (inputs: account type, persona, pillar, angle, model;
  evidence: every FactRef used; output: title, length, dropped blocks, engine, LLM outcome).
- Additive exports: `composeDraft`, `checkText`, `formatIssues`, `tabooHits`, `titleModelLabel`, `validateLlmDraft`,
  length/tag constants, `PILLAR_LABEL`.

## Validation & guarantees
- Fact blocks are built from rows: `<trim>指导价<price>` (vehicle), `优惠<amount>` + `截止日期<M月D日>` (offer),
  `<N>期` / `0息` / `年利率x%` / `首付N成` (finance offer), `月供<amount>` (lease), `补贴<amount>` (trade-in),
  `<colour pair>现车|在途<N>台` (inventory), vehicle highlights / spec phrases, store address and hours (never the
  phone number — XHS forbids phone numbers in content), campaign / FAQ knowledge content.
- Each block is verified on its own (`verifyClaims` + `checkPlatformRules` channel `post`); a failing block is dropped
  and listed in the decision, so an unverifiable claim can never reach the draft.
- Inventory words (现车/现货/有货/库存/在途) in angles and titles are rewritten when the model has no matching stock.
- Landing prices are never computed; the text says they are quoted separately.
- Customer-story accounts / pillars produce an owner-story **征集** (call for authorised stories), never an invented owner.
- LLM rewrite (optional) is accepted only if claims verify against the rules draft's facts, platform rules pass, no
  taboo topic appears, format rules hold and no unbacked stock word is used; otherwise the rules draft is kept and
  `llm.fallback_reason` is recorded.

## Runtime entry points
- Operator workflow `content_publishing` (generate PLANNED posts due soon), console "重新生成", skill registry
  `post-generation`.

## Failure modes
- `NotFoundError` for an unknown post / account / dealer.
- `PolicyError('invalid_post_status')` for posts that are already in review, scheduled, published, rejected or failed.
- Sparse Dealer Brain data yields a shorter fact section padded with persona advice (no claims); if the body still
  cannot reach the length rule, content review flags it (`格式：…`) and the post goes to CHANGES_REQUIRED.
- LLM errors or invalid payloads never fail generation (rules draft is used).

## Tests
`node --test test/unit/content/post-generation.test.ts` — every account type × pillar verifies and meets format rules,
cross-account distinctness, no stock words without stock, expired offers never used, customer-story 征集, status
policy, LLM accepted / rejected paths, skill registry invocation.
