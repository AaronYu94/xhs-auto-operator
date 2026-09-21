# vehicle-brain

## Responsibility
车型库 / Vehicle Brain: the store's live line-up as **cards**, and the retrieval layer every agent asks before it
writes. One card = one trim (`vehicles` row) plus this dealer's live colours and stock (`inventory`) and the offers
that apply to it (`offers`), with the `fact_refs` that back every number on it.

The split that makes it safe: **facts** (price, discount, specs, colours, stock, finance terms) come only from those
rows; **prose** (description, selling points, target customers, competitor notes, FAQ, content angles) may be written
by the LLM but is verified against those same rows before it is stored (`knowledge.ts`).

Retrieval is deterministic and lexical. A brand / model / trim from intent detection scores 1. Free text is scored on
the query's **discriminating** terms only — character bigrams that at least one card has and not every card has
(`通勤`, `充电`, `置换` decide a match; `宝马`, `的电` decide nothing) — and a card must contain at least
`MIN_TEXT_TERM_HITS` (2) of them and `MIN_RETRIEVAL_SCORE` (0.5) of them to match at all. There is no vector store:
with a few dozen trims per store the catalog's own vocabulary is the index, and a deterministic match is auditable.

## Owning agent
`account-strategy-agent`.

## Inputs
- `listVehicleCards(ctx, dealerId, {include_archived?, brand?, query?})`, `getVehicleCard(ctx, dealerId, vehicleId)`.
- `retrieveVehicles(ctx, dealerId, {text?, brand?, model?, trim?, limit?, include_archived?})` — the RAG entry point;
  `matchVehicle(...)` for the single best card.
- `vehicleContext(cards, {max?})` — the grounded 事实 / 素材 block a prompt carries, with its `fact_refs`.
- `vehicleFaqAnswer(card, question)` — the stored FAQ that answers a question, or null.
- `updateVehicle(ctx, vehicleId, patch, actor)`, `archiveVehicle` / `restoreVehicle`.
- `parseVehicleRows(text)` (JSON array or CSV/TSV with Chinese or English headers) + `importVehicles(ctx, dealerId,
  rows, actor, addVehicle)`.
- `generateVehicleKnowledge(ctx, dealerId, vehicleId, actor, {apply?, keep_existing?})` (knowledge.ts).
- Skill `vehicle-brain`: `{dealer_id, text?, brand?, model?, trim?, limit?}` → matches + the context block.

## Outputs
- `VehicleCard {vehicle, display_name, price{msrp,current,price_cut}, powertrain_label, colors[], in_stock,
  in_transit, offers[], finance_offers[], fact_refs[], archived}`.
- `VehicleMatch {card, score 0..1, matched_on[]}` — `matched_on` names what matched (`model:i3`, `name:35L`, `text`).
- `VehicleKnowledgeResult {vehicle, applied, rejected[], engine, status, reason}` — `rejected` names every dropped
  string and the guard that dropped it.
- `VehicleImportResult {created, updated, failed[{row, reason}], vehicles[]}`.

## Validation & guarantees
- **Archived trims never appear** in retrieval, cards, content or answers unless `include_archived` is asked for.
- **Nothing here invents a fact.** A card with no sellable stock says so (`车源：当前没有可售库存，不能说现车`) instead of
  staying silent, and `vehicleContext` labels every line 事实 or 素材 so a prompt cannot confuse the two.
- **AI generation passes two guards per string, or the string is dropped:** `verifyClaims` (the same Dealer Brain
  verifier published content goes through: prices, discounts, rates, terms, stock, dates, prohibited phrases) and
  `unsupportedMeasurements` (every 数字+单位 — 万/元/公里/度/马力/秒/座/期/成/%/台 — must match a value on the card;
  `35.39万` and `353900元` are the same fact, `首付3成` matches a 0.3 down payment, the model year is not a measurement).
  Nothing is "fixed" to make it pass, and if everything is rejected the card keeps what it had.
- Without an LLM, generation returns `UNAVAILABLE` with the reason and stores nothing.
- `current_price` cannot exceed `msrp`, and it is a verifiable price claim (`verify.ts` `refSupports`).
- Editing records `source = console:<actor>` and audits which fields changed; import reports each failed row with its
  line number instead of dropping it.

## Runtime entry points
- Console 车型 page (`/vehicles`, `/vehicles/:id`): cards, edit, gallery, archive/restore, 批量导入, AI 生成资料.
- JSON API `/api/dealers/:id/vehicle-cards`, `/api/vehicles/:id` (PATCH), `/api/vehicles/:id/archive|restore|generate`,
  `/api/dealers/:id/vehicles/import`, `/api/dealers/:id/vehicles/retrieve`.
- 设置 → 在售车型 links here; `getSetupStatus` still counts the catalog rows.
- Content agent (`post-generation`), outreach (`sales/outreach`), conversation (`sales/conversation`) and the lead
  pipeline retrieve through this module so all four see the same line-up.

## Failure modes
- Unknown dealer / vehicle, or a vehicle from another group → `NotFoundError`.
- `current_price > msrp`, a bad image path, an over-long field → `ValidationError` naming the field.
- `parseVehicleRows` without a 车型 column or with broken JSON → `ValidationError` on `text`.
- Generation without an LLM → `{status: 'UNAVAILABLE', reason}`; a failed LLM call → the same, never a rules fallback.
- Deleting a trim that stock or offers reference still fails (`PolicyError vehicle_in_use`) — archive it instead.

## Tests
- `test/unit/vehicle-brain/vehicle-brain.test.ts` — cards, CRUD, archive/restore, import (JSON + CSV), retrieval and
  matching, the FAQ answer, and that archived trims disappear from retrieval.
- `test/unit/vehicle-brain/knowledge.test.ts` — the two guards: invented prices, invented specs, prohibited phrases and
  落地价 are all rejected; clean output is stored and stamped.
- `test/unit/server/vehicles-page.test.ts` — the card page.
