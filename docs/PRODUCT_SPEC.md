# Product Specification (source requirements)

Build one production-oriented, end-to-end **Automotive Xiaohongshu AI Operations & Lead Acquisition System**.
(Faithful restatement of the customer's requirements — the source of truth for scope.)

Context from the customer: "自动找意向客户 → 判断意向 → 主动发私信" has no mature open-source project.
Existing projects cover parts: haoyu-haoyu/xhs-mcp (search, note detail + comments, creator profile),
Algovate/xhs-mcp (search/detail/comment/publish, no DM), puyujian/xhssx and XHS-YYDS (auto-reply inside
existing 私信通 conversations, not cold outreach). Recommended pipeline: keyword search → posts/comments →
LLM purchase-intent judgement → find author → lead database → personalized first message →
**human confirmation / compliant sending** → automatic follow-up. The biggest gap is proactive DMs to
strangers; the sending layer must be handled separately, stably, with account risk control and without
harassment-style outreach.

## Product goal
An AI operating system for automotive dealers, dealer groups and sales teams that manages 5+ Xiaohongshu
accounts simultaneously and replaces a substantial portion of repetitive XHS operations work.

Two loops:
1. **Content operations**: Research → Strategy → Planning → Content Generation → Review → Scheduling/Publishing → Engagement → Analytics → Optimization.
2. **Lead acquisition**: Market Search → Public Post/Comment Discovery → Purchase Intent Detection → Lead Research → Lead Scoring → Deduplication → Account Assignment → Personalized Outreach → Reply Handling → Qualification → CRM → Appointment/Conversion.

Primary outcomes are NOT content volume but: qualified automotive leads, meaningful customer conversations,
contact acquisition, dealership appointments, sales pipeline.

## 1. Multi-tenant dealer structure
Dealer Group → Dealer/Store → 5+ XHS Accounts → Leads / Content / Conversations.
Example: Group ├ Shanghai BMW Dealer (Official, Salesperson A, Salesperson B, BMW i3 Account, Shanghai Car Buying Account) └ Hangzhou BMW Dealer.
Each XHS account has an independent **Account Brain** storing: identity, account type, persona, location, target
customers, focus brands/models, content positioning, tone, content mix, goals, historical performance,
historical content, lead ownership, account health, activity state. Accounts must NOT behave like clones; shared
dealer facts may be reused but content and outreach are differentiated by persona and context.

## 2. Dealer Brain
Centralized, structured, source-aware dealership knowledge:
- BRAND: brand information, communication guidelines, prohibited claims
- VEHICLES: brand, model, trim, specifications, MSRP, product knowledge
- INVENTORY: VIN where available, model, trim, color, inventory state, dealer location
- PRICING: current offers, pricing, finance programs, lease programs, trade-in programs, expiration dates
- DEALER: stores, addresses, business hours, salespeople, campaigns
- CONTENT INTELLIGENCE: historical posts, performance, successful/failed topics, comments, lead attribution
- SALES INTELLIGENCE: leads, conversations, appointments, conversions, lost reasons
The LLM must not invent dealership facts. Price, inventory, offers, financing, store info and similar factual
claims must be retrieved from structured Dealer Brain data.

## 3. Automotive Operator
Orchestration layer coordinating: Research, Account Strategy, Content, Content Review, Publishing, Lead Hunting,
Intent Detection, Lead Research, Lead Scoring, Fleet Controller, Outreach, Conversation, CRM, Analytics,
Optimization agents. Users do not manually invoke agents. Accepts business goals like
"Generate BMW i3 leads in Hangzhou this month." and determines the tasks.

## 4. Lead Hunting Engine (core)
Discover potential customers from PUBLICLY ACCESSIBLE XHS content: public posts, public comments, public
profiles/context when accessible. Not simple username scraping — the searched object is a PURCHASE INTENT
SIGNAL: choosing between vehicles; asking prices / landing (drive-away) prices / discounts / inventory
availability / specific trim-colour availability; buying soon; financing; leasing; trade-in; comparing competing
vehicles; requesting dealership recommendations; where to buy; regional pricing; whether a model is worth buying.

## 5. Automotive Query Generator
From dealer goals (e.g. Location Hangzhou, Brand BMW, Inventory i3/3 Series/X3, Priority i3+X3) generate classes:
- DIRECT MODEL: 宝马i3 · 宝马i3价格 · 宝马i3落地 · i3优惠 · i3值得买吗
- COMPETITOR: i3 vs Model 3 · X3 vs GLC · X3 vs Q5L · 3系还是C级
- PURCHASE SCENARIO: 25万买什么车 · 30万SUV · 第一次买宝马 · 家用SUV推荐 · 准备换车
- TRANSACTION INTENT: 落地价 · 优惠多少 · 有现车吗 · 贷款方案 · 置换补贴 · 什么时候买便宜
- LOCATION: 杭州宝马 · 杭州宝马优惠 · 杭州i3 · 杭州买宝马 · 浙江宝马价格
Queries must evolve based on discovered lead quality.

## 6. Post + comment discovery
For each relevant public post analyze BOTH the post author and comment authors.
Example post "宝马i3现在值得买吗？": "帅" → not a lead; "后排怎么样" → weak intent; "现在优惠多少" → medium/high;
"杭州35L现在落地多少" → high; "杭州白外红内有现车吗？" → extremely high.
Do not save every commenter as a Lead. Cheap filtering first, deeper AI analysis only on plausible candidates.

## 7. Intent detection
Extract where possible: brand, model, trim, competing models, location, budget, purchase timeframe, price
sensitivity, inventory intent, financing intent, leasing intent, trade-in intent, purchase stage, confidence.
Purchase stages: awareness, research, comparison, price_shopping, active_shopping, dealer_selection, purchase_imminent.
Every classification preserves evidence. Never output only "High intent." — store WHY.

## 8. Lead object
Canonical lead with platform, source {type, post_id, post_title, content, timestamp}, identity {platform_user_id,
username, profile_url}, intent {brand, model, trim, location, inventory_intent, purchase_stage}, score, evidence
["asked about inventory","specified trim","specified location","recent activity"], status. Maintain source
provenance: a salesperson must always see the original signal that identified the user.

## 9. Lead scoring
Configurable. Consider explicit purchase intent, model match, inventory match, location match, purchase stage,
recency, transaction questions, user authenticity/confidence, dealer relevance.
Examples: "帅" 2 · "这车后排怎么样" 30 · "现在优惠多少" 70 · "杭州i3 35L现在落地多少" 94 ·
"杭州i3 35L白色有现车吗？这周想去看看" 99. Configurable thresholds: Candidate, Qualified, High Intent, Immediate Follow-up.

## 10. Lead deduplication (mandatory)
Same user may appear across posts, comments, searches, dealer accounts. Merge signals into ONE lead profile where
identity resolution supports it; preserve all historical evidence. Never allow five dealer accounts to
independently spam the same user.

## 11. Fleet controller
For each Qualified lead choose the best account considering dealer location, model specialization, persona,
account type, historical response rate, historical conversion rate, current lead load, previous contact, lead
ownership, account health. Example lead Hangzhou/i3/inventory/96 → Official 61, Sales A 95, Sales B 84,
i3 Account 81 → Sales A. Only one account owns the active outreach relationship unless explicitly reassigned.

## 12. Outreach engine
Personalized outreach from REAL lead evidence (the user's public signal, requested vehicle, location, relevant
dealer info, inventory/pricing when appropriate, assigned persona). No generic spam templates.
Before any send: duplicate check, previous-contact check, factual verification, account health check,
rate/frequency policy, platform-rule guard, negative-feedback guard, configurable approval policy.
Sending is a provider/action interface supporting AUTO / REVIEW_REQUIRED / DISABLED. Do not hard-code unsupported
platform capabilities. If DMs cannot be performed through an authorized/supported integration, preserve the lead
and generated outreach as READY_FOR_REVIEW rather than pretending it was sent.

## 13. Conversation agent
When a contacted user replies, create/update a Conversation. Detect intents: price_query, inventory_query,
model_comparison, finance_query, trade_in, appointment, contact_exchange, not_interested. Retrieve factual answers
from Dealer Brain. Continuously extract desired model, trim, budget, location, purchase timeframe, financing,
trade-in, contact info when voluntarily provided, appointment intention. Do not keep AI conversations running
unnecessarily — the goal is progression toward a useful sales outcome.

## 14. Sales funnel
DISCOVERED, CANDIDATE, QUALIFIED, ASSIGNED, OUTREACH_READY, CONTACTED, REPLIED, SALES_QUALIFIED, CONTACT_ACQUIRED,
APPOINTMENT, VISITED, NEGOTIATING, WON, LOST. Track timestamps and transitions.

## 15. Content operations
Per account: Research → Account Strategy → Content Plan → Post Generation → Fact Review → Duplicate Review →
Approval → Scheduling/Publishing → Performance Collection → Optimization. Content is account-specific; the same
dealership fact becomes different posts for Official, Sales Persona, Model Specialist, Local Car Guide, Customer
Story accounts. Avoid content cannibalization across accounts.

## 16. Content → lead attribution
Track which dealer-created content generates comments, profiles, qualified leads, conversations, appointments,
sales. Answer "Which content actually sells cars?", not "Which content gets likes?".

## 17. Analytics dashboard
TODAY — CONTENT: posts published, views, engagement · DISCOVERY: posts scanned, comments scanned, users evaluated,
candidates, qualified leads, high-intent leads · OUTREACH: outreach ready, contacted, replies, reply rate ·
SALES: sales qualified, contacts acquired, appointments, visits, won, lost · PIPELINE: estimated pipeline value ·
ACCOUNTS: active, healthy, requiring attention. Filters: dealer, account, brand, model, location, date, lead source, lead stage.

## 18. Lead inbox
Each card immediately shows: score, model, location, intent, purchase stage, source, original evidence, assigned
account, current stage, recommended next action. Example: "96 — HIGH INTENT / BMW i3 eDrive35L / Hangzhou /
Signal: "杭州现在35L白色有现车吗？" / Detected: inventory intent, specific trim, local buyer, active shopping /
Assigned: 销售小王 / Next: personalized outreach ready". Do not bury source evidence behind multiple pages.

## 19. Search intelligence
Per query track posts discovered, comments scanned, candidate leads, qualified leads, high-intent leads,
conversion rate. Example lead density: "宝马i3" 2% · "杭州i3落地" 17% · "杭州i3有现车吗" 31%.
Feed back into query generation; the Lead Hunter improves its search strategy over time.

## 20. Automation & scheduling
Daily: 08:00 refresh dealer/inventory data · 08:30 research market + competitors · 09:00 generate account plans ·
09:30 start lead discovery · throughout day: process public signals, score candidates, assign qualified leads,
prepare compliant outreach, process replies, update CRM · evening: collect performance, analyze funnel, update
strategies, generate operator report. All jobs observable and resumable.

## 21. Data / state (minimum)
DealerGroup, Dealer, DealerKnowledge, Vehicle, Inventory, Offer, XHSAccount, AccountPersona, AccountHealth,
ContentPlan, Post, SearchQuery, SearchRun, PublicPost, PublicComment, Lead, LeadSignal, LeadScore, LeadAssignment,
Outreach, Conversation, ConversationMessage, Appointment, Conversion, WorkflowRun, AgentDecision, AuditEvent.
No fake static dashboard data as the primary implementation.

## 22. Auditability
Store decision, agent, inputs, evidence, output, confidence, timestamp — especially for lead qualification, lead
score, account assignment, outreach generation, content factual review.

## 23. Xiaohongshu integration layer
Provider abstraction. Capabilities may include: search public content, read public posts, read public comments,
read accessible public profile context, publish content, read engagement, receive messages, send messages.
Do not assume any capability exists. Each reports AVAILABLE / UNAVAILABLE / REQUIRES_AUTH / REQUIRES_REVIEW.
Platform integration separate from business logic; the system continues functioning when an action is unavailable.

## 24. Safety / platform controls
No uncontrolled mass messaging. Explicit controls: per-account activity limits, duplicate prevention, lead
ownership, negative response suppression, do-not-contact state, account health, manual approval, provider
capability detection, audit logs. If a user indicates they do not want contact, immediately suppress further
outreach across all managed accounts.

## 25. Skill architecture
skills/research (xhs-research, competitor-research, automotive-market-research, trend-detection) ·
content (account-strategy, content-planning, post-generation, content-review, publishing) ·
acquisition (automotive-query-generation, lead-discovery, intent-detection, lead-research, lead-scoring,
lead-deduplication, account-assignment) · sales (outreach, conversation, qualification, appointment, follow-up) ·
operations (dealer-brain, account-health, crm, analytics, reporting, optimization).
No empty SKILL.md files; each skill has a responsibility, inputs, outputs, validation and runtime integration.

## 26. UX principle
Design around an AI employee, not AI buttons. Bad: "Generate Post / Analyze Lead / Generate Reply".
Good: "TODAY — 7 posts planned · 1 post requires approval · 428 new public signals analyzed · 34 qualified leads ·
11 high-intent · 8 outreach actions ready · 5 replies require attention · 3 appointments generated".
The operator primarily reviews exceptions and important decisions.

## 27. Verification
Validate each component independently: Dealer Brain, Account Brain, Query Generator, post ingestion, comment
ingestion, intent detection, lead scoring, deduplication, fleet controller, outreach generation, provider capability
handling, conversation extraction, funnel transitions, content planning, analytics, scheduled workflows.
Fixtures: "帅" must NOT become Qualified · "这车后排空间怎么样" weak/medium · "现在i3优惠多少" stronger ·
"杭州i3 35L落地多少" high · "杭州i3 35L白外红内有现车吗？这周想去看看" extremely high. Test duplicate discovery of
the same user across comments; only one managed account receives ownership; unavailable messaging capability;
negative-response suppression; factual retrieval from Dealer Brain; then integration tests; finally one full
simulated vertical slice: Dealer → 5 accounts → goal → queries → public posts/comments → candidates → intent →
scoring → dedup → qualified leads → assignment → personalized outreach → reply → qualification → appointment →
analytics update.

## 28. Definition of done
A functional vertical slice demonstrating ONE DEALER + ≥5 DISTINCT XHS ACCOUNTS + public post/comment discovery +
purchase intent detection + evidence-based scoring + dedup + multi-account assignment + personalized outreach
preparation/action through available provider capabilities + reply processing + sales qualification + CRM/funnel
state + analytics + content operations, working together. Do not fake unavailable XHS capabilities; do not silently
replace real integrations with mock success responses. Mocks acceptable for automated tests, but production
capability status must remain explicit. Final report: what was implemented, architecture changes, tests executed,
integration capabilities genuinely working, capabilities blocked by external XHS/API limitations, remaining
production risks.
