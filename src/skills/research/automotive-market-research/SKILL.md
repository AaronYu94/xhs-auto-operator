# automotive-market-research

## Responsibility
Automotive market research for one dealer (spec §15 research, §2 PRICING / INVENTORY): what the public says about
prices and discounts, what budgets buyers state and where demand comes from (IP 属地), set against what the dealer
can factually offer right now (active offers and inventory from Dealer Brain). User talk and dealer facts are always
labelled separately so nobody mistakes a user's claim for a dealer price, or vice versa.

## Owning agent
`research-agent` (skill `automotive-market-research`, category `research`).

## Inputs
`{ dealer_id: string; models?: string[]; location?: string | null; window_days?: number }` (same scope rules as
xhs-research; window default 30 days).

## Outputs
Persisted `ResearchBrief` (`kind = 'market'`) whose `findings.insights` are prefixed:
- `【用户讨论·落地价】` — landing prices in public text ('落地26.8万', '26万落地'), parsed as quoted numbers with the
  verbatim phrase, split into first-hand reports ("用户自述的落地价") and numbers inside questions, budgets, conditions
  or hearsay ("另有N处落地价出现在提问/预算/假设中": 'i3 30万落地能拿下吗', '预算28万落地', '25万落地的话…'); or, when
  no number exists, the count of buyer price/landing-price questions ("没有出现具体落地价数字").
- `【用户讨论·优惠】` — discount questions and the discount amounts users mention, split into "用户自述拿到的优惠"
  ('优惠了8万') and "提问/传闻中的优惠金额" ('听说能优惠10万是真的吗').
- `【用户讨论·预算】` — budgets stated in buyer questions (`parseBudget`).
- `【门店事实·Dealer Brain】` — active offers per scope model and dealer-wide offers, rendered only from structured
  fields (type, amount, term, APR, down payment, expiry); evidence `offer:<id>` quoting the offer title.
- `【用户讨论 vs 门店事实】` — per model: local buyers' price/discount questions, the discount amounts and landing prices
  users mention for that model (用户说法), set against the dealer's active offers for it with their amounts (门店事实),
  or the absence of any; out-of-area buyers are reported as "另有异地买家N条未计入".
- `【区域需求·IP属地】` — buyer questions by `provinceOfIp`, with the dealer province share.
- `【门店库存 vs 用户需求】` — per model: in-stock / in-transit quantities (evidence `inventory:<id>` quoting the trim)
  vs local buyer demand signals and inventory questions, flagging demand without stock and stock without demand;
  buyers who explicitly state another region are counted separately ("另有异地买家N条（上海）未计入").
- `findings.headline` (distinct buyer comments asking price and/or discount, first-hand landing prices, active offer
  count, main IP province), `source_counts`.

## Validation & guarantees
- Never computes or promises a landing price; dealer facts come only from `getActiveOffers` (valid at `ctx.clock`)
  and `findInventory` (in_stock / in_transit). Expired offers never appear.
- User numbers are extracted only from public discussion: managed-account text, dealer/marketing notes and comments
  (prefilter, or intent-NLU nickname / role — e.g. '私信我底价，i3落地25万包上牌' by a sales account) and later copies
  of the same author's comment are ignored. Values outside plausible ranges (landing 3万–300万, discount 500元–50万) are
  ignored. A number is `hypothetical` when its clause is a question or carries a budget / condition / wish / hearsay cue
  (预算, 的话, 如果, 能不能, 听说 …), or is directly followed by a short question clause ('30万落地，能拿下吗'). Evidence
  labels start with `用户讨论：` or `门店事实：`.
- Amounts are attributed to the nearest scope model in the same text; a comment naming no scope model inherits the
  thread's model when the note names exactly one.
- Demand = buyer questions (same buyer/question gate as xhs-research); model attribution uses the NLU intent model
  (including post-context inference). Buyers who EXPLICITLY state a city/province outside the dealer's province
  (ARCHITECTURE §5.2) are not demand for this dealer's inventory or offers; IP 属地-only mismatches never exclude a buyer.
- Corpus gathering (≤ 6 queries: i3落地, i3优惠, X3落地, X3优惠, 杭州宝马优惠 …), evidence re-verification (dealer-fact
  evidence verified against the offer title / vehicle trim), provenance labelling (`【模拟数据】` / `【含模拟数据】`),
  honest empty brief (no insights at all without public data), decision (inputs include the dealer fact ids, inventory
  totals, data modes and ignored comment copies) + audit event.

## Runtime entry points
- `runMarketResearch(ctx, input): Promise<ResearchBrief>`
- `analyzeMarketCorpus(corpus, scope, facts)` (pure), `loadMarketFacts(ctx, scope)`, `extractAmounts(text, kind)`
  (value, verbatim phrase/quote, `hypothetical`, offsets), `describeOfferFact(offer, tz)`, `statedOutOfArea(item, scope)`
- Skill `automotive-market-research`; used by the `market_research` daily workflow.

## Failure modes
- `ValidationError` / `NotFoundError` for bad input / unknown dealer.
- Provider failures are recorded per query and never thrown.
- Buyers without IP 属地 are counted in the "无IP属地" remainder, never guessed.
- Chinese-numeral amounts ('二十七万') are not parsed (missed, never guessed).

## Tests
`test/unit/research/market-research.test.ts` — simulation corpus (user price/discount questions vs dealer offers kept
in separate, correctly referenced insights; dealer offer evidence only `offer:` refs quoting real offer titles; user
evidence only `comment:`/`note:` refs; IP distribution; inventory vs demand), DB-seeded landing price / discount
statements parsed as numbers with verbatim phrases, expired offers excluded, pure amount extraction edge cases, honest
empty brief. `test/unit/research/research-hardening.test.ts` — hypothetical vs first-hand amounts, no question/budget
price presented as self-reported, user discount amounts vs the dealer's i3 offer, a price+discount comment counted
once in the headline, out-of-area buyers kept out of model demand, marketing-post prices ignored.
