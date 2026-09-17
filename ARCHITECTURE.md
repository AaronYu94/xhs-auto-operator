# Architecture & Module Contract

Automotive Xiaohongshu AI Operations & Lead Acquisition System — an AI operations employee for
dealer groups running fleets (5+) of Xiaohongshu (小红书, "XHS") accounts.

This file is the **binding contract** between modules. Signatures here are the public API other
modules import. Additive changes (new optional params, new exports) are fine; breaking changes
must update this file and every caller.

---

## 1. Stack & conventions

| Concern | Decision |
|---|---|
| Runtime | Node ≥ 24 running TypeScript natively (type stripping). **Erasable syntax only**: no `enum`, no `namespace`, no constructor parameter properties, no decorators. Use `as const` arrays + union types. |
| Imports | Relative imports MUST include the `.ts` extension. Type-only imports use `import type`. |
| Persistence | `node:sqlite` via `src/db/database.ts` (`Db`, typed `Table<T>`). Entities are snake_case, 1:1 with columns. JSON/boolean columns auto-converted (`TABLE_META`). |
| Transactions | `ctx.db.tx(() => …)` wraps **synchronous** work only. Never `await` inside. Do provider/LLM calls first, then persist in a tx. |
| Time | Always `ctx.clock.now()` / `ctx.clock.iso()` — never `new Date()` / `Date.now()` in business logic (tests use `ManualClock`). Dealer-local dates via `src/core/time.ts` (`localDateKey`, `startOfLocalDay`, tz = `dealer.settings.timezone`). |
| IDs | `newId(prefix)` — prefixes: `grp dlr kn veh inv ofr acc per hlth plan post q run ppost pcmt lead sig lsc asg out conv msg appt cvn trn sup scfg goal wf step sch dec evt cap rb eng rpt`. |
| Context | Every skill function takes `ctx: AppContext` first (`src/app/context.ts`): `db, clock, audit, xhs, llm, skills, log, runId`. No globals. |
| Validation | `src/core/validate.ts` (`v.object`, …) for skill inputs, API bodies, fixture imports. |
| Errors | `NotFoundError`, `ValidationError`, `PolicyError(code, msg)` from `src/core/errors.ts`. |
| Audit | Important AI decisions → `ctx.audit.decision({...})` (agent, skill, decision_type, subject, inputs, evidence, output, confidence, engine). State changes → `ctx.audit.event({...})`. |
| Tests | `node:test` + `node:assert/strict`. Files `test/unit/**/<name>.test.ts`, `test/integration/**`, `test/e2e/**`. Use `createTestContext()` from `test/helpers/context.ts` (in-memory DB, `ManualClock` at `2026-09-12T02:00:00Z` = Sat 10:00 Shanghai). Run one file: `node --test test/unit/x/y.test.ts`. Typecheck: `npx tsc --noEmit -p tsconfig.json`. |
| LLM | Optional. `ctx.llm.status().status === 'AVAILABLE'` gates use. Deterministic engines are the baseline and must be complete on their own. LLM output is validated (quotes must be verbatim substrings; facts must verify). |
| Language | Generated customer-facing text (posts, outreach, replies) is Simplified Chinese. UI is Chinese-first. Code/comments English. |

## 2. Directory layout & ownership

```
src/
  core/            types.ts ids.ts clock.ts time.ts text.ts validate.ts errors.ts logger.ts      [foundation]
  db/              schema.ts database.ts                                                         [foundation]
  audit/           audit.ts                                                                      [foundation]
  app/             context.ts (foundation) · config.ts bootstrap.ts (wave D)
  domain/          automotive-lexicon.ts                                                         [A3]
  providers/
    xhs/           types.ts unavailable.ts (foundation) · simulation.ts mcp-client.ts
                   mcp-provider.ts juguang-webhook.ts index.ts                                   [A2]
    llm/           types.ts (foundation) · anthropic.ts evidence-guard.ts index.ts               [A5]
  skills/
    registry.ts                                                                                  [foundation]
    index.ts       registers every skill                                                         [D1]
    research/      xhs-research competitor-research automotive-market-research trend-detection   [B3]
    content/       account-strategy content-planning                                             [B3]
                   post-generation content-review publishing engagement                          [C4]
    acquisition/   intent-detection                                                              [A3]
                   lead-scoring                                                                  [A5]
                   lead-deduplication lead-research                                              [B1]
                   automotive-query-generation                                                   [B2]
                   account-assignment                                                            [B5]
                   lead-discovery                                                                [C1]
    sales/         conversation/nlu.ts                                                           [A3]
                   outreach follow-up                                                            [C2]
                   conversation qualification appointment                                        [C3]
    operations/    dealer-brain account-brain account-health                                     [A1]
                   crm compliance                                                                [A4]
                   analytics                                                                     [B4]
                   reporting optimization                                                        [D1]
  operator/        workflow-engine.ts scheduler.ts                                               [A6]
                   goal-parser.ts planner.ts operator.ts workflows.ts                            [D1]
  server/          http server, JSON API, server-rendered UI                                     [D2]
                   UI MUST follow docs/UI_DESIGN.md + docs/design/ui-reference.png (binding visual spec)
  cli.ts                                                                                         [D4]
fixtures/
  dealers/hangzhou-bmw-group.json                                                                [A1]
  xhs/simulation-corpus.json                                                                     [A2]
test/helpers/      context.ts (foundation) · fixtures.ts (A1: loadDealerFixture)
```

Each skill lives in `src/skills/<category>/<skill-name>/index.ts` and exports (a) plain typed
functions for direct use and (b) `export const skill = defineSkill({...})` for the Operator.
Each skill directory has a `SKILL.md` (responsibility, inputs, outputs, validation, runtime entry,
tests) — written by the module owner.

## 3. The two operating loops

```
CONTENT OPERATIONS
 research ─► account strategy ─► content plan (cross-account de-cannibalized)
 ─► post generation (Dealer-Brain facts only) ─► fact review + duplicate review + compliance
 ─► approval policy ─► schedule/publish (provider or READY_TO_PUBLISH) ─► engagement
 ─► performance collection ─► optimization (by leads & sales, not likes)

LEAD ACQUISITION
 dealer goal ─► query generation (5 classes) ─► provider search ─► public posts + comments
 ─► cheap prefilter ─► intent detection (evidence-preserving) ─► signal scoring
 ─► identity resolution / dedup (1 lead per user per group) ─► lead score ─► CANDIDATE/QUALIFIED
 ─► lead research (public profile, authenticity) ─► fleet controller (exclusive owner)
 ─► personalized outreach ─► 10 pre-send guards ─► SENT | READY_FOR_REVIEW | BLOCKED
 ─► replies ─► conversation (intents, slots, fact-grounded drafts) ─► qualification
 ─► contact / appointment ─► visit ─► negotiation ─► WON/LOST ─► attribution & search intelligence
```

## 4. Funnel (CRM) rules — `src/skills/operations/crm`

Stages (order = depth): `DISCOVERED CANDIDATE QUALIFIED ASSIGNED OUTREACH_READY CONTACTED REPLIED
SALES_QUALIFIED CONTACT_ACQUIRED APPOINTMENT VISITED NEGOTIATING WON LOST`.

- Forward moves to any deeper non-terminal stage are allowed (one transition row records the jump).
- Requesting a stage the lead has already reached or passed is an idempotent no-op (`changed:false`).
- `WON` allowed only from `CONTACTED` or deeper. `LOST` allowed from any non-terminal stage.
- `WON` is terminal. `LOST` can only be left via `reopenLead` (operator actor, not suppressed).
- Every change writes `lead_stage_transitions` + `audit_events(action='lead.stage_changed')`.

## 5. Scoring calibration (binding for A3 intent detection and A5 lead scoring)

Weights (max points, sum 100, configurable per dealer in `scoring_configs`):

| factor | max | rule |
|---|---|---|
| explicit_purchase_intent | 25 | `round(25 × detection.strength)` |
| transaction_questions | 15 | 0 questions → 0 · 1 → 12 · ≥2 → 15 |
| model_match | 12 | model stated & dealer carries → 12 · inferred from post context & carried → 8 · comparison involving a carried model → 6 · brand match only → 4 · else 0 |
| inventory_match | 10 | asked inventory & matching in_stock (trim/colour when specified) → 10 · asked & only in_transit → 7 · trim specified & in stock (no inventory question) → 7 · model in stock **only when the signal carries inventory context** (inventory/colour question or a specified trim/colour) → 4 · asked but none → 2 · else 0 |
| location_match | 10 | stated city = dealer city → 10 · stated province = dealer province → 6 · IP 属地 province = dealer province → 5 · else 0 |
| purchase_stage | 12 | awareness 0 · research 3 · comparison 5 · price_shopping 8 · active_shopping 10 · dealer_selection 11 · purchase_imminent 12 |
| recency | 6 | ≤3d 6 · ≤7d 5 · ≤14d 4 · ≤30d 3 · ≤90d 1 · older 0 |
| authenticity | 5 | default 4 · verified real local user 5 · marketing/industry account 0 |
| dealer_relevance | 5 | brand carried → 5 · competitor brand but compares with a carried model → 3 · else 0 |

Non-purchase signals (`is_purchase_signal=false`, incl. prefilter failures):
`score = round((recency + authenticity) × 0.2)` (e.g. "帅" → 2).

Detection `strength` anchors: awareness 0.1 · research 0.2 · comparison 0.4 · price_shopping 0.88 ·
active_shopping / dealer_selection / purchase_imminent 1.0.

Default thresholds: `candidate 20 · qualified 60 · high_intent 80 · immediate 92`.

Reference fixtures (post context "宝马i3现在值得买吗？", dealer 杭州 BMW with white/red i3 eDrive35L in stock, signal ≤3 days old, no IP):

| comment | expected score | tier |
|---|---|---|
| 帅 | 2 (<10) | none |
| 这车后排空间怎么样 | ≈30 (20–45) | candidate |
| 现在优惠多少 | ≈65 (60–79) | qualified |
| 现在i3优惠多少 | ≈69 (60–79) | qualified (≥ previous) |
| 杭州i3 35L落地多少 | ≈91 (85–97) | high_intent |
| 杭州i3 35L白外红内有现车吗？这周想去看看 | ≈99 (≥95) | immediate |

Lead aggregate score = `min(100, max(signal scores re-scored at now) + min(5, 2 × (qualifying signals − 1)))`.
"Qualifying" signals are **purchase signals** (`is_purchase_signal=true`) scoring ≥ candidate; non-signals never add corroboration.

### 5.1 Author roles (binding — fixes docs/PREVIEW_FINDINGS.md F1/F2/F4)

`IntentDetection.author_role` ∈ `asker | owner | creator | marketing | unknown` (`AUTHOR_ROLES`):
- **marketing** — prefilter solicitation / dealer-sales account → `is_marketing=true`, `is_purchase_signal=false`, evidence `marketing_account`.
- **creator** — informational or creator content, typical in posts: 攻略 · 测评/评测 · 体验 · 实拍 · 分享 · 合集 · 干货 · 一次说清 · 必看 · 避坑 · 科普 · 探店 · 整理了 · 给大家 · 粉丝问我 · 开了一周/N天(试驾报告) — and nickname hints (测评/攻略/探店/车评/说车/买车指南) — unless the author ALSO asks a first-person buying question for themself (我想买/求推荐/帮我选 + ？). → `is_purchase_signal=false`, evidence `content_creator`.
- **owner** — purchase already completed: 提车了/终于提啦/已提/提车N个月/车主/开了半年/开了一年/用了N个月/入手了 + past tense, 已经买了/已经提了 (competitor or ours), 人生第一台…提啦 — unless they explicitly shop for another car (换车/增购/再买一台 + question). → `is_purchase_signal=false`, evidence `already_purchased`. (Owners are referral / customer-story material, not acquisition leads.)
- **asker** — a prospective buyer's need/question → normal purchase-signal rules.
Non-signals of any role are scored with the non-signal formula.

### 5.2 Out-of-area cap (binding — F3)

When a location is **explicitly stated** (city or province not in `inferred_fields`) and its province ≠ the dealer's province,
the signal score is capped at `thresholds.qualified − 1` (never Qualified for that dealer) and the scorer emits a component
`{factor: 'out_of_area_cap', points: <negative delta>, max: 0, reason: '异地买家（深圳），不在本店服务范围'}` so components still
sum to the score. IP 属地-only mismatches are not capped (IP is noisy) but earn no location points.

### 5.3 Group-level dealer matching (binding — F5)

Discovery evaluates every signal against **every dealer profile in the query dealer's group** and routes the lead to the
dealer with the highest signal score (ties → the query's dealer). The per-dealer scores are recorded in the `lead_score`
decision inputs. An existing lead only moves dealer when it has no active assignment and the new dealer scores strictly higher.

## 6. Pre-send guard pipeline (outreach, follow-ups, conversation replies)

Order and semantics (`GuardResult.blocking=true` → `BLOCKED`; `false` → route to `READY_FOR_REVIEW`):

1. `ownership` – sender is the lead's active assigned account (blocking)
2. `negative_feedback` – global `contact_suppressions`, lead suppressed, not_interested (blocking)
3. `duplicate` – another live first-touch exists for this lead from ANY account (blocking; also DB unique index)
4. `previous_contact` – first-touch after any prior sent touch; follow-up beyond `max_unanswered_touches` or before `follow_up_after_days` (blocking)
5. `account_health` – disabled/RESTRICTED (blocking); AT_RISK or auth `requires_auth` (review)
6. `rate_limit` – daily limit reached / min interval not elapsed (review; never auto-send)
7. `factual_verification` – `verifyClaims` against Dealer Brain (blocking)
8. `platform_rules` – no phone/WeChat/QQ/links/"加微信" (XHS rule since 2025-01-07; use 留资卡/名片), no prohibited claims, length ≤ 300 chars, no near-identical mass template (blocking)
9. `approval_policy` – DISABLED (blocking) · REVIEW_REQUIRED (review) · AUTO below `auto_send_min_score` (review)
10. `provider_capability` – `send_messages` not AVAILABLE for the account (review — a human sends it)

Only when every check passes is the message sent through the provider; the outreach becomes `SENT`
only with a provider-confirmed `provider_message_id`. A human can record a manual send
(`SENT_MANUALLY`) after blocking guards are re-checked.

## 7. Xiaohongshu provider capability truth table

| capability | simulation | live (`xiaohongshu-mcp`, per-account instance) | none |
|---|---|---|---|
| search_public_content | AVAILABLE | `search_feeds` → AVAILABLE if logged in else REQUIRES_AUTH | UNAVAILABLE |
| read_public_post | AVAILABLE | `get_feed_detail` | UNAVAILABLE |
| read_public_comments | AVAILABLE | `get_feed_detail(load_all_comments)` | UNAVAILABLE |
| read_public_profile | AVAILABLE | `user_profile` (needs xsec_token) | UNAVAILABLE |
| publish_content | configurable | `publish_content` (no note id returned) | UNAVAILABLE |
| read_engagement | AVAILABLE | `get_my_profile` feeds interactInfo (no views) | UNAVAILABLE |
| reply_comments | configurable | `reply_comment_in_feed` | UNAVAILABLE |
| receive_messages | configurable (scripted inbox) | **UNAVAILABLE** – no DM inbox tool; official DM access only via 私信通 / approved 三方客服 vendors | UNAVAILABLE |
| send_messages | configurable (default UNAVAILABLE) | **UNAVAILABLE** – no authorized API for DMs to users | UNAVAILABLE |

Additionally `juguang-webhook.ts` parses the official 聚光 "私信API对接" lead push (lead records incl.
voluntarily provided phone/WeChat) into CRM updates.

The simulation provider is clearly labelled `mode: 'simulation'` everywhere it surfaces (UI banner,
capability report, audit). It is for tests and demos only.

## 8. Module API contract (signatures other modules rely on)

### A1 · `src/skills/operations/dealer-brain/index.ts`
```ts
export interface DealerBrainBundle { group: {key: string; name: string}; dealers: DealerSeed[]; vehicles: VehicleSeed[];
  inventory: InventorySeed[]; offers: OfferSeed[]; knowledge: KnowledgeSeed[]; accounts: AccountSeed[] } // seeds reference natural keys
export interface ImportSummary { group_id: string; dealer_ids: Record<string,string>; account_ids: Record<string,string>;
  vehicle_ids: Record<string,string>; counts: Record<string, number> }
export function importDealerBrain(ctx, bundle: DealerBrainBundle): ImportSummary            // idempotent upsert by natural keys
export function getDealer(ctx, dealerId: string): Dealer
export function listDealers(ctx, groupId?: string): Dealer[]
export function getDealerProfile(ctx, dealerId: string): DealerProfile
export function findVehicles(ctx, groupId: string, q: {brand?: string; model?: string; trim?: string}): Vehicle[]
export function resolveVehicle(ctx, groupId: string, q: {brand?: string; model?: string; trim?: string}): Vehicle | null
export interface InventoryMatch { inventory: Inventory; vehicle: Vehicle }
export function findInventory(ctx, dealerId: string, q: {model?: string; trim?: string; vehicle_id?: string;
  exterior_color?: string; interior_color?: string; statuses?: InventoryStatus[]}): InventoryMatch[]
export function getActiveOffers(ctx, dealerId: string, q?: {model?: string; vehicle_id?: string; types?: OfferType[]}): Offer[]
export function getKnowledge(ctx, dealerId: string, categories?: KnowledgeCategory[]): DealerKnowledge[]
export function getProhibitedClaims(ctx, dealerId: string): {phrase: string; reason: string; knowledge_id: string}[]
export type FactQuestionKind = 'price'|'inventory'|'offer'|'finance'|'lease'|'trade_in'|'store'|'spec'|'highlights'
export interface FactQuestion { kind: FactQuestionKind; model?: string; trim?: string; exterior_color?: string; interior_color?: string }
export interface FactAnswer { found: boolean; text: string; facts: FactRef[]; missing: string[] }
export function answerFact(ctx, dealerId: string, q: FactQuestion): FactAnswer              // text built ONLY from rows
export interface ClaimCheck { passed: boolean; issues: string[]; verified: FactRef[]; unverified_claims: string[] }
export function verifyClaims(ctx, dealerId: string, text: string, declared: FactRef[]): ClaimCheck
export const skill
```
`FactRef.claim` holds the exact phrase used in text (e.g. "指导价35.39万"). `verifyClaims` extracts money
(`35.39万`, `8000元`, `2万`), rates (`3.99%`, `0息`), terms (`36期`), down payments (`首付3成`/`30%`),
inventory claims (`现车`/`有货`/`库存`), expiry dates, and prohibited phrases; every claim must match a
declared, currently-valid FactRef belonging to that dealer.

### A1 · `src/skills/operations/account-brain/index.ts`
```ts
export interface AccountPerformance { posts_published_30d: number; avg_engagement_30d: number; leads_owned_active: number;
  outreach_sent_30d: number; replies_30d: number; reply_rate_30d: number; appointments_90d: number; won_90d: number;
  conversion_rate_90d: number; negative_feedback_7d: number }
export interface AccountBrain { account: XhsAccount; persona: AccountPersona; health: AccountHealth | null;
  performance: AccountPerformance; recent_posts: Post[] }
export function getAccountBrain(ctx, accountId: string): AccountBrain
export function listFleet(ctx, q: {dealer_id?: string; group_id?: string}): AccountBrain[]
export function getAccountPerformance(ctx, accountId: string): AccountPerformance
export interface OutreachPolicy { policy: ApprovalPolicy; daily_limit: number; min_interval_minutes: number;
  max_unanswered_touches: number; follow_up_after_days: number; auto_send_min_score: number; timezone: string }
export function effectiveOutreachPolicy(ctx, accountId: string): OutreachPolicy
export function effectivePublishPolicy(ctx, accountId: string): { policy: ApprovalPolicy; daily_limit: number; timezone: string }
export function updatePersona(ctx, accountId: string, patch: Partial<AccountPersona>, actor: string): AccountPersona
```

### A1 · `src/skills/operations/account-health/index.ts`
```ts
export function computeAccountHealth(ctx, accountId: string): AccountHealth     // upsert today's snapshot + decision
export function computeFleetHealth(ctx, dealerId: string): AccountHealth[]
export function getLatestHealth(ctx, accountId: string): AccountHealth | null
export function isAccountOperable(ctx, accountId: string): { ok: boolean; blocking: boolean; reason: string }
```
### A1 · `test/helpers/fixtures.ts`
```ts
export function loadDealerFixture(ctx): ImportSummary   // imports fixtures/dealers/hangzhou-bmw-group.json
```

### A2 · `src/providers/xhs/*`
```ts
// simulation.ts
export interface SimulationCorpus { notes: SimNote[]; profiles: SimProfile[]; inbox_scripts: SimInboxScript[] }
export interface SimulationOptions { send_messages?: boolean; publish?: boolean; receive_messages?: boolean;
  reply_comments?: boolean; auth_required_accounts?: string[] }
export class SimulationXhsProvider implements XhsProvider {           // name 'simulation', mode 'simulation'
  constructor(clock: Clock, corpus: SimulationCorpus, opts?: SimulationOptions)
  static fromFile(clock: Clock, path: string, opts?: SimulationOptions): SimulationXhsProvider
  /** demo harness: record that a human sent a message so scripted replies can be released */
  recordManualContact(accountId: string, platformUserId: string): void
  sentMessages(): {account_id: string; to: string; text: string; at: string}[]
}
// mcp-client.ts — minimal MCP streamable-HTTP JSON-RPC client (initialize, tools/list, tools/call), injectable fetch
export class McpHttpClient { constructor(opts: {url: string; token?: string; fetchImpl?: typeof fetch; timeoutMs?: number}) ... }
// mcp-provider.ts — maps to xiaohongshu-mcp tools; one endpoint per managed account + a research endpoint
export class McpXhsProvider implements XhsProvider { constructor(clock: Clock, cfg: McpProviderConfig, fetchImpl?: typeof fetch) }
// juguang-webhook.ts
export function parseJuguangLeadPush(body: unknown): JuguangLead[]
// index.ts
export function createXhsProvider(clock: Clock, cfg: XhsProviderConfig): XhsProvider
```

### A3 · `src/domain/automotive-lexicon.ts`
Canonical names: brand `BMW` (宝马); models `i3` · `i4` · `iX3` · `X1` · `X3` · `X5` · `3 Series` (3系) ·
`5 Series` (5系); competitors `Tesla Model 3/Model Y`, `BYD Han`, `Xiaomi SU7`, `NIO ET5`, `Mercedes-Benz C-Class (C级)/GLC`,
`Audi A4L/Q5L`, `Volvo XC60`, `Lexus NX`. Trims: `i3 eDrive35L (35L)`, `i3 eDrive40L (40L)`,
`X3 xDrive25L`, `X3 xDrive30L`, `3 Series 325Li`, `3 Series 330Li`.
```ts
export function findBrands(text: string): {brand: string; brand_zh: string; quote: string}[]
export function findModels(text: string): {brand: string; model: string; quote: string}[]
export function findTrims(text: string, model?: string): {model: string; trim: string; quote: string}[]
export function findLocation(text: string): {city?: string; province?: string; quote: string} | null
export function provinceOfIp(ipLocation: string | null | undefined): string | null
export function competitorsOf(brand: string, model: string): {brand: string; model: string; model_zh: string}[]
export function modelDisplayName(brand: string, model: string, lang?: 'zh'|'en'): string   // 'BMW i3' / '宝马3系'
export const CITY_PROVINCE: Record<string, string>
```
### A3 · `src/skills/acquisition/intent-detection/`
```ts
// nlu.ts (pure)
export function prefilter(text: string, context?: SignalContext): PrefilterResult
export function detectIntentRules(text: string, context?: SignalContext, dealer?: DealerProfile): IntentDetection
// index.ts
export async function detectIntent(ctx, input: {text: string; context?: SignalContext; dealer?: DealerProfile;
  subject?: {type: string; id: string}}): Promise<IntentDetection>     // rules; optional LLM refinement; decision when subject
export const skill
```
### A3 · `src/skills/sales/conversation/nlu.ts` (pure)
```ts
export function detectConversationIntents(text: string): { intents: ConversationIntent[]; evidence: Evidence[] }
export function extractSlots(text: string, opts: { now: Date; tz: string; previous?: ConversationSlots }): ConversationSlots
export function resolveAppointmentTime(text: string, now: Date, tz: string): { at: string | null; text: string | null }
export function detectContactInfo(text: string): { phone?: string; wechat?: string }
```

### A4 · `src/skills/operations/crm/index.ts`
```ts
export const STAGE_INDEX: Record<LeadStage, number>
export const STAGE_WIN_PROBABILITY: Record<LeadStage, number>
export function canTransition(from: LeadStage, to: LeadStage): boolean
export function transitionLead(ctx, leadId: string, to: LeadStage, meta: {reason: string; actor: string}):
  { lead: Lead; changed: boolean; transition: LeadStageTransition | null }
export function reopenLead(ctx, leadId: string, to: 'CANDIDATE'|'QUALIFIED', meta: {reason: string; actor: string}): Lead
export function isSuppressed(ctx, platformUserId: string, platform?: Platform): ContactSuppression | null
export function suppressContact(ctx, input: {platform_user_id: string; reason: string; source: string; actor: string}):
  { suppression: ContactSuppression; leads_updated: string[]; outreach_cancelled: string[]; conversations_closed: string[] }
export function recordConversion(ctx, input: {lead_id: string; outcome: 'won'|'lost'; amount?: number; vehicle_id?: string;
  lost_reason?: string; actor: string}): Conversion
export function computeNextAction(ctx, lead: Lead): string
export function refreshNextAction(ctx, leadId: string): Lead
export function getLeadTimeline(ctx, leadId: string): { transitions: LeadStageTransition[]; events: AuditEvent[]; decisions: AgentDecision[] }
export const skill
```
### A4 · `src/skills/operations/compliance/index.ts` (pure)
```ts
export interface RuleIssue { code: string; message: string; quote?: string }
export function checkPlatformRules(text: string, opts: { prohibited: {phrase: string; reason: string}[]; max_length: number;
  channel: 'dm'|'comment'|'post' }): { passed: boolean; issues: RuleIssue[] }
export function detectContactInfoLeak(text: string): RuleIssue[]
export function isNearDuplicate(text: string, others: string[], threshold?: number): { duplicate: boolean; max_similarity: number }
```

### A5 · `src/skills/acquisition/lead-scoring/index.ts`
```ts
export const DEFAULT_WEIGHTS: ScoringWeights
export const DEFAULT_THRESHOLDS: ScoringThresholds
export function tierFor(score: number, t: ScoringThresholds): ScoreTier
export function getScoringConfig(ctx, dealerId: string): ScoringConfig             // ensures active v1 exists
export function updateScoringConfig(ctx, dealerId: string, patch: {weights?: Partial<ScoringWeights>;
  thresholds?: Partial<ScoringThresholds>}, actor: string): ScoringConfig          // new version
export interface SignalScoreInput { detection: IntentDetection; signal_at: string; now: string; dealer: DealerProfile;
  authenticity?: { score: number; reasons: string[] } }
export function scoreSignal(input: SignalScoreInput, cfg: Pick<ScoringConfig,'weights'|'thresholds'>):
  { score: number; tier: ScoreTier; components: ScoreComponent[] }                 // pure
export function scoreLead(ctx, leadId: string): LeadScore                           // persists + updates lead + decision
export const skill
```
Authenticity is derived from lead evidence codes written by lead-research: `industry_account` → 0,
`verified_local_user` → 5, otherwise 4 (always on the 0..5 calibration scale).
`detectionFromSignal` prefers the persisted v2 columns (`is_purchase_signal`, `strength`, `transaction_questions`,
`author_role`); rows with `strength = 0` and no transaction questions are legacy-shaped and fall back to evidence codes.

### A5 · `src/providers/llm/`
```ts
export class AnthropicLlmProvider implements LlmProvider { constructor(opts: {apiKey: string; model?: string; baseUrl?: string;
  fetchImpl?: typeof fetch; timeoutMs?: number; maxRetries?: number}) }
export function createLlmProvider(env: Record<string, string | undefined>): LlmProvider
```

### Foundation helpers (already implemented — import, do not re-implement)
```ts
// src/core/evidence.ts
export function isVerbatimQuote(sources: string | (string|null|undefined)[], quote: string|undefined|null): boolean
export function keepVerbatimEvidence(sources, evidence: Evidence[], opts?: {allowUnquoted?: boolean}): Evidence[]
export function dedupeEvidence(evidence: Evidence[]): Evidence[]
// src/domain/dealer-profile.ts   (A1's getDealerProfile simply re-exports/wraps this)
export function buildDealerProfile(ctx, dealerId: string): DealerProfile
// src/core/text.ts: normalizeText stripEmoji meaningfulChars meaningfulLength charNgrams jaccard textSimilarity findAll truncate escapeHtml clamp round formatCny
// src/core/time.ts: DEFAULT_TZ DAY_MS localParts localDateKey localTimeKey tzOffsetMs zonedTimeToUtc startOfLocalDay addDays addMinutes daysBetween addDaysToKey
// src/providers/xhs/unavailable.ts: UnavailableXhsProvider, buildReport(provider, mode, accountId, clock, states, fallback?)
```

### A6 · `src/operator/workflow-engine.ts`, `src/operator/scheduler.ts`
```ts
export interface StepContext { ctx: AppContext; run: WorkflowRun; input: Record<string, unknown>;
  outputs: Record<string, Record<string, unknown>> }
export interface WorkflowStepDef { key: string; agent: AgentName; skill: string; description: string;
  run(sc: StepContext): Promise<Record<string, unknown>> | Record<string, unknown>; retries?: number; optional?: boolean }
export interface WorkflowDef { name: string; description: string;
  steps: WorkflowStepDef[] | ((input: Record<string, unknown>) => WorkflowStepDef[]) }
export class WorkflowEngine {
  constructor(defs?: WorkflowDef[])
  register(def: WorkflowDef): void
  list(): WorkflowDef[]
  start(ctx, name: string, input: Record<string, unknown>, opts: {trigger: WorkflowTrigger; dealer_id?: string|null;
    goal_id?: string|null}): Promise<WorkflowRun>
  resume(ctx, runId: string): Promise<WorkflowRun>     // same run id; SUCCEEDED/SKIPPED steps skipped; outputs reloaded
  recoverInterrupted(ctx): WorkflowRun[]              // RUNNING runs after crash → FAILED(interrupted), resumable
  getRun(ctx, runId: string): { run: WorkflowRun; steps: WorkflowStep[] }
}
export const DEFAULT_DAILY_SCHEDULE: { workflow: string; cron: string }[]
export class Scheduler {
  constructor(engine: WorkflowEngine)
  ensureSchedules(ctx, dealerId: string, plan?: {workflow: string; cron: string}[]): Schedule[]
  due(ctx, now: Date): Schedule[]
  tick(ctx): Promise<WorkflowRun[]>
  start(ctx, intervalMs: number): () => void
}
```
Run status: all steps SUCCEEDED/SKIPPED → `SUCCEEDED`; an `optional` step failed → `PARTIAL`; a required step failed → `FAILED` (later steps stay PENDING).
Cron: `'HH:MM'` dealer-local daily; `'every:N'` minutes.
`DEFAULT_DAILY_SCHEDULE` (workflow names D1 must register): `refresh_dealer_data 08:00` · `market_research 08:30` ·
`account_planning 09:00` · `lead_discovery 09:30` · `signal_processing every:60` · `reply_processing every:30` ·
`content_publishing every:60` · `performance_collection 18:00` · `evening_analysis 20:00`.

### B1 · `src/skills/acquisition/lead-deduplication/index.ts`
```ts
export interface SignalInput { source_type: SignalSourceType; public_post_id?: string|null; public_comment_id?: string|null;
  post_title?: string|null; content: string; signal_at: string; search_run_id?: string|null; query_id?: string|null;
  detection: IntentDetection }
export interface UpsertLeadResult { lead: Lead; signal: LeadSignal | null; created: boolean; merged: boolean;
  stage_changes: LeadStage[] }
export function upsertLeadFromSignal(ctx, input: { dealer_id: string; identity: {platform_user_id: string; username: string;
  profile_url?: string|null}; signal: SignalInput; attributed_post_id?: string|null }): UpsertLeadResult
export function mergeIntents(base: AutomotiveIntent, next: AutomotiveIntent): AutomotiveIntent
export function findLeadByIdentity(ctx, groupId: string, platformUserId: string): Lead | undefined
export const skill
```
Persistence rules: every stored signal writes `is_purchase_signal`, `strength`, `transaction_questions`, `author_role` from the
detection and `evidence` unchanged (plus `signal_score` computed with `scoreSignal`). A signal with
`is_purchase_signal=false` never CREATES a lead (PolicyError `not_a_purchase_signal`) unless `source_type` is `reply` or
`import`; on an existing lead it is stored for history but never raises score or stage. Identities equal to a managed
account's `platform_account_id` are rejected (PolicyError `managed_account_identity`). Suppressed identities are stored
with `suppressed=true` and never advance past their current stage.
### B1 · `src/skills/acquisition/lead-research/index.ts`
```ts
export interface LeadResearchResult { lead_id: string; status: 'researched'|'skipped'; reason: string;
  authenticity: {score: number; reasons: string[]}; added_signals: number; industry_account: boolean }
export async function researchLead(ctx, leadId: string): Promise<LeadResearchResult>
export const skill
```
### B2 · `src/skills/acquisition/automotive-query-generation/index.ts`
```ts
export interface QueryPlanInput { dealer_id: string; goal: GoalSpec; goal_id?: string | null }
export function generateQueries(ctx, input: QueryPlanInput): SearchQuery[]           // persists, dedup by text
export interface QueryEffectiveness { query: SearchQuery; runs: number; posts_discovered: number; comments_scanned: number;
  users_evaluated: number; candidates: number; qualified: number; high_intent: number; lead_density: number;
  candidate_rate: number; appointments: number; won: number; conversion_rate: number; smoothed_density: number }
export function getQueryEffectiveness(ctx, dealerId: string, opts?: {from?: string; to?: string}): QueryEffectiveness[]
export function evolveQueries(ctx, dealerId: string): { reprioritized: number; derived: SearchQuery[]; retired: SearchQuery[] }
export function selectQueriesToRun(ctx, dealerId: string, limit: number, goalId?: string|null): SearchQuery[]
export const skill
```
`lead_density = qualified / max(1, users_evaluated)`.

### B3 · research & strategy & planning
```ts
// research/<kind>/index.ts
export async function runXhsResearch(ctx, input: {dealer_id: string; models?: string[]; location?: string|null; window_days?: number}): Promise<ResearchBrief>
export async function runCompetitorResearch(ctx, input): Promise<ResearchBrief>
export async function runMarketResearch(ctx, input): Promise<ResearchBrief>
export function runTrendDetection(ctx, input): ResearchBrief
// content/account-strategy/index.ts
export function buildAccountStrategy(ctx, accountId: string, opts?: {goal?: GoalSpec; goal_id?: string|null}): ContentPlan['strategy']
// content/content-planning/index.ts
export function planContent(ctx, input: {dealer_id: string; period_start: string; days?: number; goal_id?: string|null}):
  { plans: ContentPlan[]; posts: Post[] }        // PLANNED post slots for every active account, de-cannibalized
```
### B4 · `src/skills/operations/analytics/index.ts`
```ts
export interface AnalyticsFilters { dealer_id?: string; account_id?: string; brand?: string; model?: string; location?: string;
  from?: string; to?: string; source_type?: SignalSourceType; stage?: LeadStage }
export function resolvePeriod(ctx, f: AnalyticsFilters): { from: string; to: string }   // default: dealer-local today
export function getDashboard(ctx, f: AnalyticsFilters): DashboardMetrics
export function getLeadInbox(ctx, f: AnalyticsFilters & {tier?: ScoreTier; limit?: number; offset?: number}): LeadCard[]
export function getLeadDetail(ctx, leadId: string): LeadDetail
export function getContentAttribution(ctx, f: AnalyticsFilters): ContentAttributionRow[]
export function getFunnel(ctx, f: AnalyticsFilters): { stage: LeadStage; count: number; conversion_from_prev: number }[]
export function getAccountsOverview(ctx, dealerId?: string): AccountOverviewRow[]
```
### B5 · `src/skills/acquisition/account-assignment/index.ts` (Fleet Controller)
```ts
export function rankAccountsForLead(ctx, lead: Lead): AssignmentCandidate[]
export function assignLead(ctx, leadId: string, opts?: {reassign_to?: string; actor?: string; reason?: string}):
  { assignment: LeadAssignment | null; candidates: AssignmentCandidate[]; changed: boolean; reason: string }
export function getActiveAssignment(ctx, leadId: string): LeadAssignment | undefined
export function releaseAssignment(ctx, leadId: string, reason: string, actor: string): void
export const skill
```
Routing: rank the accounts of `lead.dealer_id` (section 5.3). Only when that dealer has no eligible account are other
group dealers' accounts ranked (with location points 0). Only leads with `score ≥ qualified`, not suppressed, not LOST/WON
are assigned; everything else returns `assignment:null` with a reason.
### C1 · `src/skills/acquisition/lead-discovery/index.ts`
```ts
export interface DiscoveryLimits { max_posts?: number; max_comments_per_post?: number }
export async function runSearchQuery(ctx, input: {dealer_id: string; query_id: string; limits?: DiscoveryLimits}): Promise<SearchRun>
export async function runDiscovery(ctx, input: {dealer_id: string; goal_id?: string|null; max_queries?: number; limits?: DiscoveryLimits}):
  Promise<{ runs: SearchRun[]; leads_touched: string[] }>
export function ingestPublicContent(ctx, input: {dealer_id: string; notes: (XhsNoteDetail & {comments: XhsComment[]})[];
  search_run_id?: string|null; query_id?: string|null}): Promise<IngestSummary>     // also the manual JSON import path
export const skill
```
### C2 · `src/skills/sales/outreach/index.ts`, `src/skills/sales/follow-up/index.ts`
```ts
export async function prepareOutreach(ctx, leadId: string, opts?: {kind?: OutreachKind; actor?: string}): Promise<Outreach>
export function runSendGuards(ctx, input: {lead: Lead; account_id: string; message: string; fact_refs: FactRef[];
  kind: OutreachKind; human_approved?: boolean; capability: CapabilityStatus}): GuardResult[]
export async function approveOutreach(ctx, outreachId: string, actor: string, editedMessage?: string): Promise<Outreach>
export async function sendOutreach(ctx, outreachId: string): Promise<Outreach>
export function markOutreachSentManually(ctx, outreachId: string, actor: string): Outreach
export function cancelOutreach(ctx, outreachId: string, actor: string, reason: string): Outreach
export async function planFollowUps(ctx, dealerId: string): Promise<Outreach[]>
```
### C3 · `src/skills/sales/{conversation,qualification,appointment}/index.ts`
```ts
export interface InboundResult { conversation: Conversation; message: ConversationMessage; lead: Lead; intents: ConversationIntent[];
  slots: ConversationSlots; reply_draft: ConversationMessage | null; actions: string[]; duplicate: boolean }
export async function processInboundMessage(ctx, input: {account_id: string; platform_user_id: string; username?: string|null;
  content: string; received_at?: string; provider_message_id?: string|null; source: 'provider'|'manual'}): Promise<InboundResult>
export async function pollInbox(ctx, accountId: string): Promise<{ status: CapabilityStatus; processed: number; reason: string }>
export async function approveReply(ctx, messageId: string, actor: string, editedText?: string): Promise<ConversationMessage>
export function markReplySentManually(ctx, messageId: string, actor: string): ConversationMessage
export function qualifyLead(ctx, leadId: string): { sales_qualified: boolean; reasons: string[]; missing: string[] }
export function upsertAppointment(ctx, input: {lead_id: string; account_id: string; conversation_id?: string|null;
  time_text?: string|null; scheduled_for?: string|null; vehicle_interest?: string; notes?: string}): Appointment
export function confirmAppointment(ctx, appointmentId: string, actor: string, scheduledFor?: string): Appointment
export function markVisited(ctx, appointmentId: string, actor: string): Appointment
export function markNoShow(ctx, appointmentId: string, actor: string): Appointment
```
### C4 · content production
```ts
export async function generatePost(ctx, postId: string): Promise<Post>                 // PLANNED → DRAFTED
export function reviewPost(ctx, postId: string): Post                                 // → IN_REVIEW | APPROVED+SCHEDULED | CHANGES_REQUIRED
export function approvePost(ctx, postId: string, actor: string): Post
export function rejectPost(ctx, postId: string, actor: string, reason: string): Post
export async function publishDuePosts(ctx, dealerId: string): Promise<{ published: Post[]; ready_to_publish: Post[]; skipped: {post_id: string; reason: string}[] }>
export function markPublishedManually(ctx, postId: string, input: {platform_note_id?: string|null; url?: string|null}, actor: string): Post
export async function collectPerformance(ctx, dealerId: string): Promise<{ updated: number; status: CapabilityStatus; reason: string }>
export function recordPostMetrics(ctx, postId: string, metrics: Partial<PostMetrics>, actor: string): Post
export async function draftEngagementReplies(ctx, dealerId: string): Promise<EngagementReply[]>
```
### D1 · operator
```ts
export function parseGoal(text: string, dealer: Dealer, now: Date): GoalSpec
export class AutomotiveOperator {
  constructor(engine: WorkflowEngine)
  submitGoal(ctx, input: {dealer_id: string; text: string; actor: string}): Promise<{ goal: OperatorGoal; run: WorkflowRun }>
  runDaily(ctx, dealerId: string): Promise<WorkflowRun[]>
}
export function buildWorkflows(): WorkflowDef[]
export function registerAllSkills(registry: SkillRegistry): SkillRegistry
export function generateOperatorReport(ctx, dealerId: string, date?: string): OperatorReport
export async function runOptimization(ctx, dealerId: string): Promise<Record<string, unknown>>
```

### Wave B additive exports & behaviour notes (integration gate — additive; the signatures above are unchanged)
- **A5 lead-scoring (§5.2/§5.3):** `listGroupDealerIds(ctx, dealerId): string[]` (given dealer first) ·
  `evaluateSignalForDealers(ctx, {dealer_ids, text, context, signal_at, authenticity?, preferred_dealer_id?}):
  {results: DealerSignalEvaluation[]; best: DealerSignalEvaluation}` (each dealer's own profile, active config and timezone;
  ties → `preferred_dealer_id`, then input order) · `statedAreaMatch` · `isLegacySignalRow` · `OUT_OF_AREA_FACTOR`.
  `detectIntentRules(text, context?, dealer?, opts?: {now?: Date; tz?: string})`. The `lead_score` decision records
  `inputs.group_dealer_scores[]` and `output.out_of_area_capped / out_of_area_place`; the §5.2 cap also holds at lead level
  (a purchase signal stating an out-of-area place and none stating an in-area place keeps the lead ≤ qualified − 1).
- **B1 lead-deduplication:** `UpsertLeadResult` adds `duplicate`, `dealer_rerouted` · `isPurchaseDetection`,
  `nonPurchaseReason`, `selectPrimarySignal`, `resolveSignalTime` · PolicyError `signal_identity_conflict` (the referenced
  public post/comment was written by another user). `signal_at` is an ISO instant with an offset or a dealer-local wall
  clock; more than 15 min in the future is rejected. A negative / marketing / owner / creator detection never creates a lead;
  the managed-identity guard also matches `xhs_accounts.platform_user_id`. Decisions `lead_qualification`,
  `lead_dedup_merge`; events `lead.created`, `lead.signal_added`, `lead.dealer_rerouted`.
- **B1 lead-research:** `detectIndustryAccount`, `STALE_NOTE_DAYS`; an industry account below CONTACTED is closed LOST and its
  assignment released through `releaseAssignment`.
- **B2 query generation:** `planQueries` (preview, no writes) · `EvolveResult` adds `paused, evaluated,
  best_smoothed_density, changes` · `QueryEffectiveness` adds `failed_runs, last_run_at` · a goal lifts / reactivates a
  shared query only the first time that goal is planned for the dealer (daily re-planning never undoes `evolveQueries`).
- **B3:** `planContent(ctx, input, opts?: {replace?: boolean})` counts every live post of an account in the period toward
  its cadence, so rolling daily plans never over-post · `runTrendDetectionWithProvider` is the skill entry
  (`runTrendDetection` stays synchronous) · `latestBrief(ctx, dealerId, kind, maxAgeDays?, {with_data?})` · headlines label
  synthetic data `【模拟数据】` / `【含模拟数据】` · evidence `source_ref` = `note:<platform_post_id>` |
  `comment:<platform_comment_id>` | `offer:<id>` | `inventory:<id>` · decision `research` with `subject_type:
  'research_brief'` · an xhs brief does not count buyer questions that name only models outside `scope.models`
  (`namesOnlyOutOfScopeModels`).
- **B4 analytics:** `resolvePeriod` returns `{from, to, timezone, is_today}` · funnel rows add `reached` ·
  `AccountOverviewRow.persona_name: string | null` · the skill returns `{kind, result}` for kinds
  `dashboard|inbox|funnel|attribution|accounts|lead_detail` · the plain functions are read-only.
- **B5 account-assignment:** `classifyLeadIntent`, `assignmentConfidence(candidates, chosenAccountId?)`, `summarizeFactors` ·
  industry / dealer-sales leads below CONTACTED are never assigned; CONTACTED-or-deeper leads are exempt from the score guard ·
  a new owner cancels every other account's undelivered outreach for the lead.
- **Gates:** `test/integration/contracts-wave-b.test.ts` (compile-time + runtime §8 B checks) and
  `test/integration/acquisition-core.test.ts` (the real acquisition chain over the simulation corpus).

## 9. Fixture canon (shared by A1 dealer fixture, A2 corpus, tests and demo)

- Group key `zj-bmw-group` "浙沪宝马经销商集团". Dealers: `hz-bmw` 杭州宝马中心 (杭州/浙江) and `sh-bmw` 上海宝马中心 (上海/上海).
- `hz-bmw` accounts (platform_account_id → type · nickname · focus):
  - `xhs-hz-official` official · 杭州宝马中心官方 · all models
  - `xhs-hz-sales-wang` salesperson · 销售小王·杭州宝马 · i3, 3 Series (salesperson_name 王磊)
  - `xhs-hz-sales-li` salesperson · 李姐聊宝马 · X3, X1 (salesperson_name 李娜)
  - `xhs-hz-i3` model_specialist · i3电车研究所 · i3, i4
  - `xhs-hz-guide` local_guide · 杭州买车攻略君 · all, Hangzhou buying guides
  - `xhs-hz-story` customer_story · 宝马车主故事馆 · customer stories
- `sh-bmw` accounts: `xhs-sh-official` official · 上海宝马中心官方; `xhs-sh-sales-zhao` salesperson · 赵哥说车·上海宝马 · X3, 5 Series.
- `hz-bmw` inventory includes: i3 eDrive35L 白/红 ×1 in_stock, i3 eDrive35L 黑/黑 ×2 in_stock, i3 eDrive40L 灰/黑 in_transit,
  X3 xDrive25L 白/棕 ×2 in_stock, X3 xDrive30L 黑/黑 ×1 in_stock, 3 Series 325Li 蓝/黑 ×1 in_stock.
- Own published notes (`posts.platform_note_id`): `note-own-hz-i3-001` (by `xhs-hz-i3`), `note-own-hz-x3-001` (by `xhs-hz-sales-li`).
- Corpus users: `u-hz-buyer-001` … ; the SAME user `u-hz-buyer-001` comments on ≥3 different notes (dedup); `u-negative-001`
  later replies "不需要，别再发了" (suppression); `u-dealer-spam-001` is a competitor salesperson ("私信我底价") — never a lead.
- The fixture is **fictional demo data**. Production dealers are configured by importing their own Dealer Brain bundle
  (`node src/cli.ts dealer import <file>` or the 系统 → Dealer Brain page); nothing in `src/` hard-codes a dealer.

## 10. Production, real data & deployment contract (v3)

### 10.1 Data provenance (migration v3)
- `DATA_MODES = live | simulation | import | manual | unknown` on `public_posts`, `public_comments`, `search_runs`, `leads`.
  `live` = fetched from Xiaohongshu by a provider whose `mode === 'live'`; `simulation` = synthetic corpus; `import` =
  operator-supplied JSON of real public content (`ingestPublicContent` without a provider); `manual` = typed by a human.
- `leads.data_mode` = mode of the signal that created the lead; becomes `live` as soon as any live signal merges.
- Every lead keeps its exact source: `lead_signals.public_post_id/public_comment_id` → `public_posts.url`
  (`https://www.xiaohongshu.com/explore/<note_id>?xsec_token=…`) + comment id + verbatim `content`. The console links to it.
- `APP_ENV=production` refuses `XHS_PROVIDER=simulation` at startup and the demo seeder refuses to run. There is no silent
  fallback from `mcp` to simulation: an unreachable / logged-out instance surfaces as UNAVAILABLE / REQUIRES_AUTH.

### 10.2 Actor classification (before scoring)
- `ACTOR_TYPES = BUYER | OWNER | CREATOR | DEALER_OR_SALES | ENTHUSIAST | UNKNOWN`,
  `classifyActor(detection, prefilter?)` in `src/domain/actor-classification.ts` (pure), first match wins:
  marketing (`is_marketing`, role `marketing`, evidence `marketing_account|industry_account`) → DEALER_OR_SALES ·
  role `owner` / evidence `already_purchased` → OWNER · role `creator` / evidence `content_creator` → CREATOR ·
  `is_purchase_signal` → BUYER · prefilter passed, automotive, not negative → ENTHUSIAST · else UNKNOWN.
- Persisted on `lead_signals.actor_type` and `leads.actor_type` (BUYER once any buyer signal exists; lead-research
  `industry_account` → DEALER_OR_SALES). Only BUYER signals create leads (unchanged `is_purchase_signal` rule).

### 10.3 One Xiaohongshu session per managed account
- Endpoint per account: env `XHS_MCP_ACCOUNTS` (wins) or `xhs_accounts.mcp_endpoint_url` (unique). Bearer tokens only via env.
- `xhs_accounts.platform_user_id` (verified id of the logged-in XHS user), `auth_checked_at`, `auth_detail`; `auth_state` is
  refreshed from live capability probes, never assumed.
- Optional provider auth API `XhsProvider.auth` (live provider only): `status(accountId|null)`,
  `loginQrcode(accountId|null) → {already_logged_in, image_data_url, expires_at}` for in-console QR login.

### 10.4 Human send accountability
- `outreach.sent_by` / `conversation_messages.sent_by` record the operator who sent a message by hand (`SENT_MANUALLY`,
  `sent_manually`). `SENT` / `sent` still require a provider-confirmed message id.

### 10.5 Runtime
- `src/app/config.ts` (`loadConfig(env)`, validated, secrets redacted in logs) · `src/app/bootstrap.ts`
  (`createRuntime(config) → {ctx, engine, scheduler, operator, close}`; migrates, recovers interrupted runs, registers skills
  and workflows, ensures schedules) · `src/server/` (JSON API + console, `/healthz` liveness, `/readyz` DB + provider
  readiness, cookie session auth required when `APP_ENV=production`) · `src/cli.ts` (serve, migrate, dealer import/export,
  seed-demo, goal, run, doctor, xhs-login).

### 10.6 Integration notes (binding)
- **Provenance is written by `upsertLeadFromSignal` for every signal path** (discovery, lead research, replies, 聚光
  imports, direct callers): `lead_signals.actor_type = detection.actor_type ?? classifyActor(detection)`;
  `SignalInput.data_mode` (optional) → else the linked public comment / post row's `data_mode` → else `import` (import
  signals) · `manual` (replies) · provider mode (profile signals) · `unknown`. `leads.actor_type = aggregateActorType(...)`
  (industry evidence → DEALER_OR_SALES; lead research also sets it), `leads.data_mode` upgrades to `live` and never
  downgrades. Lead discovery's own provenance update is kept and idempotent.
- **Console CSRF**: state-changing requests pass with `x-console-request: 1`, or browser fetch metadata
  `Sec-Fetch-Site: same-origin`, or a same-origin `Origin`; cross-site fetch metadata is always rejected.
  `Referrer-Policy: same-origin` (a `no-referrer` policy made browsers send `Origin: null` and broke the login form).
- **Unverified state is never shown as fact**: an account's login pill reads 登录未检测 until a live probe has set
  `auth_checked_at` (imported `auth_state` is a declaration, not a verification). The console's default dealer is the
  one operating the largest active account fleet.
- **Live login checks are never reused**: capability probes and `auth.status` always ask the instance, so a session that
  just logged in or expired is seen immediately (syncing N accounts on one shared instance costs N browser checks).
