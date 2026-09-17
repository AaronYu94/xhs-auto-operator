# dealer-brain

## Responsibility
Single source of dealership truth (spec §2). Imports and serves structured, source-aware Dealer Brain
data — group, dealers/stores, vehicle catalog (MSRP, specs, highlights, aliases), inventory (VIN, colours,
status), offers (cash discount, finance, lease, trade-in, gift, campaign with validity windows) and
knowledge (brand, communication guidelines, prohibited claims, stores, salespeople, campaigns, FAQ,
policies) — and makes every factual customer-facing statement **retrievable and verifiable**:

- `answerFact` composes Simplified-Chinese answers ONLY from rows; every factual phrase is returned as a
  `FactRef` whose `claim` is a verbatim substring of the text.
- `verifyClaims` extracts factual claims from any generated text (posts, outreach, replies) and checks
  each one against declared FactRefs. It is the `factual_verification` pre-send guard and the content
  fact review.

Landing price (落地价) and other transaction prices (到手价/全包价/裸车价/成交价) are never computed or promised.

## Owning agent
`automotive-operator` (skill `dealer-brain`, category `operations`). Consumed by content, outreach,
conversation, scoring (via `getDealerProfile`) and review modules.

## Inputs
- `importDealerBrain(ctx, bundle, opts?)` — `DealerBrainBundle` with natural keys:
  `group {key,name}`, `dealers[]` (key, name, brands, city, province, address, business_hours, phone,
  optional partial `settings`), `vehicles[]` (key, brand/brand_zh, model/model_zh, trim, model_year, msrp,
  specs, highlights, aliases, source), `inventory[]` (dealer key, vehicle key, vin|null, colours, status,
  quantity, list_price|null, source), `offers[]` (key, dealer key, vehicle key|null, model|null, type,
  title, description, amount, apr, term_months, down_payment_pct, conditions, valid_from, valid_until,
  source), `knowledge[]` (dealer key|null, category, key, title, content, data, source, validity),
  `accounts[]` (dealer key, platform_account_id, nickname, type, status, auth_state, city,
  salesperson_name, overrides, `persona`).
  `opts: ImportOptions { inventory_mode?: 'snapshot' (default) | 'merge'; persona_mode?: 'seed' (default) | 'overwrite' }`.
- Skill input: `{ dealer_id: string, question: { kind, model?, trim?, exterior_color?, interior_color? } }`
  with `kind ∈ price | inventory | offer | finance | lease | trade_in | store | spec | highlights`.
- `verifyClaims(ctx, dealerId, text, declared: FactRef[])`.

## Outputs
- `ImportSummary { group_id, dealer_ids (key→id), account_ids (platform_account_id→id), vehicle_ids
  (key→id), counts { dealers, vehicles, inventory, offers, knowledge, accounts, personas, inserted, updated,
  unchanged, inventory_retired, account_state_preserved, personas_preserved } }`.
- `FactAnswer { found, text, facts: FactRef[], missing: string[] }` — `missing` names what could not be
  answered from data (`landing_price` always for price questions, `inventory`, `offer`, `vehicle`,
  `model`, `monthly_payment`, …).
- `ClaimCheck { passed, issues (Chinese), verified: FactRef[], unverified_claims: string[] }`.

## Validation & guarantees
- **Bundle validation** (`parseDealerBrainBundle`, `v.*` validators): shapes and enums with exact error
  paths (e.g. `inventory[0].vehicle`), unique natural keys, every cross-reference resolved, content_mix
  non-empty with valid pillars summing to 1, known IANA timezone, unknown dealer-setting keys rejected (a typo
  never silently falls back to a default limit), real calendar dates / parseable ISO timestamps only,
  `valid_from ≤ valid_until`, cash/trade-in offers need `amount`, finance/lease need `term_months`, an offer
  with both vehicle and model must agree, a model-line offer must name a catalog model, prohibited_claim rows
  need `data.phrase`, salesperson accounts need `salesperson_name`, VIN rows have quantity ≤ 1, VINs are
  stored upper-case.
- **Idempotent import**: ids are `prefix_sha1(groupKey|namespace:key)[0..16]`; rows are upserted in ONE
  transaction (insert missing, update only changed fields, clear nullable fields) together with the
  `dealer_brain.imported` audit event. Importing the same bundle twice yields identical row counts and zero
  updates. Existing rows with the same natural unique key are adopted; a VIN or platform account of another
  group is refused.
- **Operational safety on re-import** (daily `refresh_dealer_data`):
  - `inventory_mode: 'snapshot'` — the bundle's inventory is the complete stock of each dealer it lists;
    that dealer's rows missing from it are retired (quantity 0, kept for history) so sold cars are never
    answered or verified as available, and a VIN-less row whose status changed never double-counts.
  - Account `status` / `auth_state` are never loosened by a bundle (a disabled account is not re-enabled, a
    `requires_auth` state is not reset); stricter bundle values are applied and audited as
    `account.state_changed`.
  - `persona_mode: 'seed'` — personas are created when missing but existing personas (edited through Account
    Brain) are kept; `'overwrite'` replaces changed fields and audits `account.persona_updated`.
- Dealer settings are always complete: frozen `DEFAULT_DEALER_SETTINGS` (REVIEW_REQUIRED outreach & publish,
  20 outreach/day, 3-minute interval, 2 unanswered touches, follow-up after 2 days, 2 posts/day, 6 AI turns,
  auto-send ≥ 90, `Asia/Shanghai`) merged with the seed's partial settings.
- **Lookup semantics**: model matching is NFKC/case/space-insensitive on model, model_zh, brand-prefixed
  names, aliases and full names carrying the trim (`i3 eDrive35L`, `宝马X3 xDrive30L`); trims match trim,
  aliases, model+trim or a letter-bounded suffix (`35L` → `eDrive35L`, never `5L`). `resolveVehicle` without
  trim → lowest-MSRP trim of the newest model year. Inventory defaults to `in_stock` + `in_transit` with
  quantity > 0 and tolerant colours (`白` ↔ `白色` ↔ `矿石白`, English colour names). Offers and knowledge are
  valid when `valid_from ≤ now ≤ end of valid_until's local day` in the dealer timezone; corrupt dates fail
  closed. Trim-level offers apply to that vehicle, model-level to all trims of the model, model-less offers to
  every vehicle.
- **answerFact** quotes only the current catalog (newest model year, per trim when a trim is asked), renders
  money exactly (`formatCny` when exact, else full 元 — `12345元`, never a rounded `1.23万`), never echoes
  numbers or non-colour user text from the question, never lists expired offers, reports `found=false` with
  an honest "暂无" sentence when there is no matching stock/offer, and asserts every FactRef claim is in the
  text (also re-checked by the skill's `validateOutput`). Every answer verifies against its own facts
  (round-trip test over all kinds, models, trims, colours and both dealers).
- **verifyClaims** extracts:
  - money — `35.39万`, `9万`, `8000元`, `8,000元`, `0.8万`, `5999元/月`, `9w`, `8000块`, `¥90,000` and Chinese
    numerals (`九万`, `三十五点三九万`, `五千九百九十九元`); idioms (`千万别`, `十万火急`, `一块去`) and non-money
    units (`1万公里`, `200W快充`) are ignored;
  - rates (`3.99%`, `0息`, `零利率`, `免息`), terms (`36期`), down payments (`首付3成`, `三成首付`, `首付30%`,
    `零首付`);
  - positive inventory claims (`现车`, `现货`, `有货`, `库存`, `在途`) with stated counts (`现车2台`, `有3台现车`)
    and colours (`白外红内`, `矿石白外观、珊瑚红内饰`, `灰色在途`); genuine negations (`暂无`, `没现车`,
    `已售罄`), inquiries and questions are skipped, while `不仅有现车` / `无论…都有现车` / `现车什么颜色都有` are claims;
  - expiry dates (`2026-09-30`, `2026/9/30`, `9月30日前`, `截止…`) and prohibited phrases.

  A claim passes only if a declared ref (a) exists, (b) belongs to the dealer (vehicles: same group and carried
  brand), (c) is currently valid / sellable, (d) is the right kind of fact — `指导价/售价` ← vehicle MSRP or
  inventory list price, `优惠/补贴/立减` ← non-lease offer amount, `月供` or `/月` ← lease amount, `现车/在途` ←
  inventory with that status, rates/terms/down payments/dates ← offers or knowledge — (e) covers the vehicle
  named in the same sentence (a named trim narrows its model; model-line offers cover all trims) and the stated
  colours, and (f) matches numerically (msrp, list_price, amount, apr, term_months, down_payment_pct,
  valid_from/valid_until) or verbatim in the offer/knowledge text. A stated car count must not exceed the
  backing stock. Money next to `落地/到手价/全包价/裸车价/成交价` (before or after the number, e.g. `35.39万就能落地`)
  always fails. Declared refs that are invalid, or whose own claim contradicts their row, are issues even if
  unused and are never reported as `verified`. Text with no claims and no refs passes.

## Runtime entry points
Skill name `dealer-brain` (`export const skill`). Exported functions (`index.ts`):
`importDealerBrain`, `parseDealerBrainBundle`, `getDealer`, `listDealers`, `getDealerProfile` (delegates to
`buildDealerProfile`), `findVehicles`, `resolveVehicle`, `findInventory`, `getActiveOffers`, `getKnowledge`,
`getProhibitedClaims`, `answerFact`, `verifyClaims`, `extractClaims`, `isOfferActive`, `isKnowledgeActive`,
`offerAppliesToVehicle`, `vehicleDisplayName`, `DEFAULT_DEALER_SETTINGS`, `DEALER_SETTING_KEYS`,
`mergeDealerSettings`, `colorMatches`, `isValidAt`, `isValidDateValue`, `exactCny`, `stableId`,
`contentMixValidator`, `factQuestionValidator`; types `ImportOptions`, `ImportSummary`, `ExtractedClaim`,
`MoneyRole`, `ClaimCheck`, `FactQuestion`, `FactAnswer`. Workflow `refresh_dealer_data` re-imports dealer data
idempotently (snapshot inventory, seed personas).

## Failure modes
- `ValidationError` (with path) for malformed bundles, dangling keys, impossible dates, unknown settings,
  offers naming no catalog model, cross-group VIN/account collisions — the whole import is rolled back.
- `NotFoundError` for unknown dealer ids.
- Unknown vehicle / no stock / no active offer → `found=false` with `missing`, never fabricated text.
- Not extracted (reviewers keep such claims in the supported forms): colloquial compound numerals
  (`两万五` without a unit), month.day dates (`9.30前`), numeric claims about vehicles outside the catalog
  (competitor models are not scoped), and percentages are always treated as rates / down payments (a spec
  percentage such as `续航提升10%` fails review conservatively).
- Offers and knowledge are upserted, never deleted; they leave the answers through their validity windows.
  A partial bundle must use `inventory_mode: 'merge'`, otherwise the listed dealers' unlisted stock is retired.

## Tests
- `test/unit/brain/dealer-brain-import.test.ts` — idempotency, deterministic ids, natural keys, settings
  merge, field updates incl. nulls, validation paths with rollback, cross-group refusal, profile delegation.
- `test/unit/brain/dealer-brain-import-hardening.test.ts` — snapshot retirement (sold cars, status changes,
  merge mode), account state never loosened (audited tightening), persona seed/overwrite modes, impossible
  dates, unknown settings, offer model checks, empty content_mix, VIN case, frozen defaults, corrupt dates
  fail closed.
- `test/unit/brain/dealer-brain-facts.test.ts` — vehicle/trim/alias matching, newest-year resolution,
  tolerant colours, status filters, offer validity boundaries in dealer tz, knowledge scoping, all answer
  kinds, expired offer exclusion, no-stock honesty, landing price never computed, skill invocation.
- `test/unit/brain/dealer-brain-facts-hardening.test.ts` — full-name model strings, no echo of non-colour
  user text, exact money rendering, newest model year per trim.
- `test/unit/brain/dealer-brain-verify.test.ts` — answerFact texts pass; invented 落地价/优惠, 现车 without
  inventory ref, 在途 vs in_stock, sold stock, prohibited phrases, expired/foreign/missing refs, numeric
  mismatch, boundary-aware linking, format normalization, negations/questions, claim extraction.
- `test/unit/brain/dealer-brain-verify-hardening.test.ts` — price-vs-discount roles, same-sentence vehicle
  scoping, colour and count checks, landing after the number, negation false positives, colloquial and
  Chinese-numeral money, contradicting refs.
- `test/unit/brain/dealer-brain-roundtrip.test.ts` — every answerFact output (all kinds × models × trims ×
  colours × both dealers) verifies against its own facts; the same text fails once its offers expire.
