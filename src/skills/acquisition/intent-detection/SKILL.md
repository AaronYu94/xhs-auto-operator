# intent-detection

## Responsibility
Decide whether ONE public Xiaohongshu post or comment is an automotive purchase-intent signal, WHO is speaking, and
explain why with verbatim evidence (spec §4, §6, §7; ARCHITECTURE §5, §5.1). It performs:

1. **Cheap prefilter** – rejects empty/emoji-only text, pure praise/noise (帅 · 好看 · 哈哈哈 · 蹲 · mark …),
   marketing / competitor-salesperson solicitation (私信我 · 加v · 4S店销售 · 代购 · 收车 …; buyer requests such as
   “可以加微信吗 / 哪个4S店销售靠谱” are exempt), too-short text, and text with no automotive signal. Generic purchase
   words (多少钱 · 优惠 · 在吗 …) only pass when the text or its parent post is automotive. The prefilter is content-only.
2. **Deterministic Chinese NLU** (complete without an LLM) using `src/domain/automotive-lexicon.ts`:
   brand / model / trim (longest-alias, word-boundary aware; model inferred from the post when the comment names none),
   competing models (还是 · vs · 对比 · 纠结 · 选哪个 · 和…比), stated city/province or IP 属地 province, budget
   (25万 · 25w · 预算30万 · 20-25万 · 二十五万 · 30万左右), purchase timeframe (relative terms plus calendar expressions
   such as 9月底 · 10月份 · 明年3月 · 国庆前, placed relative to the evaluation time), transaction questions
   (price · landing_price · discount · inventory · color_trim_availability · finance · lease · trade_in ·
   dealer_location · test_drive), intent flags, price sensitivity, negation-aware negative feedback
   (不需要 · 别发了 · 已经提了… — but “不需要贷款” only sets `financing_intent=false`).
3. **Author role** (ARCHITECTURE §5.1) — `asker | owner | creator | marketing | unknown`; only askers can be purchase
   signals (docs/PREVIEW_FINDINGS.md F1/F2).
4. **Purchase stage & strength** calibrated to ARCHITECTURE §5:
   awareness 0.1 · research 0.2 · comparison 0.4 · price_shopping 0.88 · active_shopping / dealer_selection /
   purchase_imminent 1.0.
5. **Optional LLM refinement**, strictly validated, and an auditable `intent_detection` decision.

## Owning agent
`intent-detection-agent` (skill category `acquisition`). Called by lead discovery (C1) for every comment/post that
passes ingestion (through lead scoring's `evaluateSignalForDealers` for group-level matching), and by lead research
(B1) for profile signals.

## Inputs
Direct call:
```ts
detectIntent(ctx, { text: string; context?: SignalContext; dealer?: DealerProfile; subject?: { type: string; id: string };
  tz?: string })                                             // now = ctx.clock; tz = input.tz ?? dealer timezone ?? Asia/Shanghai
detectIntentRules(text, context?, dealer?, opts?: { now?: Date; tz?: string })   // pure
analyzeSignal(text, context?, dealer?, opts?)                // pure: { analyzed_text, prefilter, detection }
prefilter(text, context?)                                    // pure
```
`SignalContext = { source_type: 'post'|'comment'|'profile'|'reply'|'import'; post_title?; post_content?; ip_location?;
author_nickname? }`. For `source_type: 'post'` the analyzed text is `post_title + '\n' + text` (title not duplicated if
already contained). `author_nickname` feeds the role hints below; `opts.now` places calendar expressions — without it
they are ignored (never guessed).

Skill (Operator) input, validated with `v.object`:
`{ text: string (≤10000); context?: SignalContext (author_nickname ≤200); dealer_id?: string; subject?: { type; id } }` —
when `dealer_id` is given the DealerProfile is loaded with `buildDealerProfile`.

## Outputs
`IntentDetection` (`src/core/types.ts`): `is_purchase_signal`, `intent: AutomotiveIntent`, `evidence: Evidence[]`,
`transaction_questions`, `strength`, `negative`, `engine ('rules' | 'llm+rules')`, and — always set by the rules engine —
`author_role` and `is_marketing`. The skill returns `{ prefilter: PrefilterResult; detection: IntentDetection }`.

Evidence codes (labels are Chinese, for salespeople): `stated_model`, `stated_brand`, `model_from_post_context`
(source_ref `post_context`), `model_from_trim`, `specified_trim` (指定配置 eDrive35L), `specified_color`
(指定颜色 白外红内), `stated_location` (本地买家（杭州）/ 同省买家 / 所在地; `提及地点（杭州）` for non-buyer authors),
`ip_location` (IP属地 浙江, source_ref `ip_location`), `competing_model` (对比 Model 3), `comparison`, `budget`,
`purchase_timeframe` (计划本周到店), `financing_declined`, `full_payment`, `leasing_declined`, `no_trade_in`,
`price_sensitivity`, `purchase_commitment`, `product_research`, `purchase_scenario`, `purchase_desire`, `not_interested`,
role codes `content_creator` · `already_purchased` (+ `negative_feedback` when the purchase is stated in the text) ·
`marketing_account` (emitted once; hits listed in the label), and prefilter reasons `empty_or_emoji` · `pure_praise` ·
`too_short` · `no_signal`. Role evidence derived from the nickname carries source_ref `author_nickname` and a “（昵称）”
label suffix.

**Transaction-question evidence uses the question itself as the code** — `price` (询问价格), `landing_price`
(询问落地价), `discount` (询问优惠), `inventory` (询问现车), `color_trim_availability`, `finance`, `lease`, `trade_in`,
`dealer_location`, `test_drive` (想到店看车 / 想试驾). This keeps a detection that is persisted only as evidence
(legacy lead_signals rows) identical after lead scoring rebuilds it with `detectionFromSignal`. Every negative detection
carries `not_interested` or `negative_feedback`, the codes lead scoring reads as negative.

## Validation & guarantees
- Every evidence `quote` is a verbatim substring of its source: the analyzed text by default, the post title/content
  when `source_ref='post_context'`, the IP string when `source_ref='ip_location'`, the author nickname when
  `source_ref='author_nickname'` (offset-mapped slicing, property-tested).
- `inferred_fields` lists fields not stated by the user (`brand`/`model` from the post, `province` from IP 属地).
- `is_purchase_signal` is true only when the prefilter passed, a stage was detected, the text is not negative, and the
  author role is `asker`/`unknown` (never `owner`/`creator`/`marketing`). Non-signals have `strength = 0`, no stage and
  no transaction questions.
- **Author roles** (ARCHITECTURE §5.1), first match wins:
  - `marketing` — prefilter solicitation, or a dealer-sales / trade nickname (宝马顾问 · 销售顾问 · 4S店 · 车行 · 二手车 …).
    `is_marketing = true`.
  - `owner` — the author states a completed purchase (提车了 · 终于提啦 · 提车三个月了 · 开了半年/一年 · 用了N个月 ·
    我是…车主 · 车主一枚 · 入手了 · 人生第一台…提 · 已经买了/提了 · 在…店提的), or has an owner nickname (车主 · 提车日记)
    and asks no buying question. Not ownership: cues about someone else as the clause subject (朋友已经提了 ·
    陪朋友去提车了 — a vocative such as 姐妹们 / 家人们 is not a subject), the trade-in car (旧车开了五年), a future owner
    (准车主 · 未来车主) and a plan before 入手了 (准备 / 决定 / 想 / 终于要入手了). Exception: an author shopping for a
    (another) car — 换车 · 再买一台 · 给老婆买, or a first-person wish to buy (想买了 · 我也打算买一台; not 想买的姐妹, not
    当初也想买, not 打算买个充电桩) — plus a question or transaction question is an asker ('租了一辆i3开了一个月，想买了，
    现车多少钱'). A stated purchase sets `negative = true` (not in market); a nickname-only owner does not.
  - `creator` — for posts/profiles: strong informational cues (攻略 · 测评/评测 · 实拍 · 合集 · 干货 · 一次说清 · 必看 ·
    避坑 · 科普 · 探店 · 整理了 · 清单 · 汇总 · 给大家 · 粉丝问我 · 深度对比 · 我的建议 · 姐妹们注意 · 评论区聊聊 …) unless the
    author asks a first-person buying question (求推荐 · 求助 · 帮我选 · 我想买… · 求…推荐); weak cues (体验 · 分享 ·
    开了一周/N天 · 说几点感受 · 思路) that a transaction question or a first-person dilemma question (还是纠结…选哪个？ —
    not 给纠结的朋友) overrides; advice replies that ask nothing (建议到店问清楚 · 推荐去试驾); creator nicknames (测评 · 攻略 ·
    探店 · 车评 · 说车 · 买车指南 · 研究所) unless a buying question is asked. A creator word the author asks FOR is a
    request, not content: a request word before it in its clause (求分享 · 有没有攻略 · 怎么避坑 — but 教你怎么避坑 informs)
    or a question particle right after it.
  - `asker` — prefilter passed and a purchase stage or a refusal was detected; `unknown` — everything else (praise, noise).
- Stage rules: purchase_imminent = commitment (准备下定 / 这周去提) or near timeframe (this_week / soon) AND
  (inventory | visit | price question); dealer_selection = where-to-buy question (哪家店 · 哪家宝马店 · 靠谱的门店推荐 ·
  宝马销售推荐); active_shopping = inventory, colour/trim availability, visit/test drive (incl. '去看i3'), price question
  with trim/stated location/colour, or a finance/lease/trade-in question on a known vehicle WITH specifics (trim / stated
  location / colour, or programme details such as 首付 · 月供 · 利率 · 36期 · 月租 · 残值 · 置换补贴 · 旧车估价);
  price_shopping = price/landing/discount or a generic finance/lease/trade-in question ('能贷款吗' scores like '优惠多少');
  comparison; research (product questions on a vehicle — a product topic counts only when the text asks something, so
  '后排一般' / '红内饰好好看' are not research — purchase scenario, budget); awareness (想买/种草/心动 + vehicle).
- Calendar timeframes (`opts.now`, dealer-local date in `opts.tz`): current month part not yet over → this_month
  ('9月底', '9月中旬'); 'N月前' / '国庆前' deadlines inside next month's start → this_month; upcoming periods starting
  ≤ 92 days ahead → within_3_months ('10月底', '国庆期间'), later otherwise ('12月底', '明年3月'); a month 1–6 months back
  or an explicit past year is the past → no timeframe; months up to 5 ahead wrap into next year ('3月' in December).
  Dates ('9月20号') are left to appointment NLU. An invalid timezone falls back to Asia/Shanghai.
- Precision guards (each has a regression test in `test/unit/nlu/hardening.test.ts` or `author-roles.test.ts`):
  - Timeframes ignore past or recurring words: 上周六 · 上周末 · 每周末 · 上个月底 · 三年前 · 去年年底 · 两年内 · 8月底 (in September).
  - Negative feedback:
    - A soft refusal (不需要 · 不考虑 · 不买了 · 没兴趣) counts only when its clause names no other object. '不需要四驱' and '不考虑电车' are not refusals; '不需要，谢谢' and 'i3不买了' are.
    - '区别发…' is not '别发'. '被骚扰' / '骚扰电话' complain about third parties. '刚提的问题' is not a purchase.
  - Marketing detection skips buyers' wording: 找我老婆 · 联系我了 · 微信转账.
  - '有没有优惠' is a discount question, not a trim-availability question. '绿色牌照' is not a colour. '加速多少' / '油耗大概多少' / '利率多少' are not price questions.
  - Price / stock / where-to-buy questions about non-vehicle objects ('博主这件外套哪里买的') are ignored.
  - Joint-venture brand names are not locations (北京现代 · 上海大众). Recognizing brands outside the catalog (丰田, 北京现代, …) stops such comments inheriting the post's model. '宝马M3' is never Tesla slang.
- LLM refinement runs only when `ctx.llm.status().status === 'AVAILABLE'`, the prefilter passed, the author is not an
  owner/creator/marketing account, and (`strength < 0.9` or no model). The response is structurally validated; evidence
  without a verbatim quote is dropped; model / trim / location / budget / timeframe are accepted only when the verbatim
  quote re-parses (lexicon) to that value (numbers come from re-parsing, never from the LLM); the stage moves at most one
  step; the LLM can add but never remove negative feedback, and an added negative must quote an actual refusal cue
  (不/别/没/算了/已经…). `refineWithLlm` returns the rules detection unchanged (`rejected: ['non_buyer_author_role']`) for
  non-buyer authors. LLM quotes are re-anchored to the exact raw substring. Result `engine = 'llm+rules'`; accepted/
  rejected fields are recorded in the decision inputs.
- When `subject` is provided an `AgentDecision` (`decision_type 'intent_detection'`, agent `intent-detection-agent`,
  skill `intent-detection`) records inputs (text, context, dealer_id, evaluated_at, timezone, prefilter, llm usage or
  `skipped_reason: 'author_role:<role>'`), evidence, output (incl. `author_role`, `is_marketing`) and confidence.

- Seller detection (prefilter `marketing_account`): dealer-store phrasing (`DEALER_TEXT_RE`: 品鉴, 展车/新车已到店,
  试驾有礼, 评论区扣1, contact homophones 厚台/厚苔/🐍信/丝我) unless a question follows the hit; promotion terms
  (`PROMO_TERM_RE`: 限时, 至高…元, 尾款减免, 0首付, 2年0息, 名额有限…) when ≥ 3 distinct, or 2 in a text without a
  question. Account names matching `DEALER_ACCOUNT_NAME_RE` set `is_marketing`. '想入手的别错过' / '想买X的宝子' is the
  readers' wish, not the author's (`READER_AUDIENCE_AFTER_RE`). Real samples: `test/unit/nlu/live-dealer-posts.test.ts`.

## Runtime entry points
- `src/skills/acquisition/intent-detection/index.ts`
  - `detectIntent(ctx, input): Promise<IntentDetection>`
  - `refineWithLlm(analysis, data, context?, dealer?, opts?): { detection, accepted, rejected }` (pure)
  - `parseLlmIntentPayload(data)`, `INTENT_LLM_SCHEMA`
  - `skill` — name `intent-detection`, category `acquisition`, agent `intent-detection-agent`
  - re-exports `analyzeSignal`, `detectIntentRules`, `prefilter`, `STAGE_STRENGTH`, `NON_BUYER_ROLES`, `isNonBuyerRole`,
    type `IntentRuleOptions`
- `src/skills/acquisition/intent-detection/nlu.ts` (pure): `prefilter`, `detectIntentRules`, `analyzeSignal`,
  `analyzedTextFor`, `isPurePraise`, `stageIndex`, `STAGE_STRENGTH`, `QUESTION_EVIDENCE`, `PREFILTER_REASONS`,
  `NON_BUYER_ROLES`, `isNonBuyerRole`, `locationLabel`, type `IntentRuleOptions`.
- `src/domain/automotive-lexicon.ts`: `detectTimeframe(text, opts?)`, `detectTimeframeMapped(mt, opts?)`,
  type `TimeframeOptions`.

## Failure modes
- LLM unavailable, returns `ok:false`, throws, or returns malformed JSON → silently falls back to the rules result
  (`engine 'rules'`); the fallback reason is logged at debug level and stored in the decision inputs.
- Unknown `dealer_id` in the skill → `NotFoundError('dealer', id)` from `buildDealerProfile`.
- Invalid skill input (missing text, bad `source_type`) → `ValidationError`.
- Out-of-lexicon models are only recognized when present in the DealerProfile (`models` / `trims[].aliases`).
- Ambiguous slang is deliberately not resolved: 'M3'/'MY' map to Tesla only with 特斯拉/毛豆/Model context; '杭' alone is
  not a location (only '杭城'); bare '汉' is not BYD Han.
- Role detection is lexical: an owner or creator who writes like a buyer without any cue is classified as an asker, and a
  buyer whose nickname looks like a dealer account (e.g. contains 车行) is classified as marketing. Nickname-only hints are
  overridden by a buying question (creator/owner) but not for dealer-sales nicknames.
- Calendar expressions are ignored when no `now` is supplied (pure calls without `opts`).

## Tests
- `test/unit/nlu/intent-rules.test.ts` — prefilter reasons, ARCHITECTURE §5 reference comments (fields, stages,
  strengths) and a reference scoring oracle reproducing the expected score bands, comparisons, budget, IP-only location,
  post analysis, negation, marketing exemptions, verbatim-evidence property over every fixture.
- `test/unit/nlu/author-roles.test.ts` — §5.1 roles on the corpus phrasings (creator posts, owner posts/remarks, nickname
  hints and their buying-question overrides, repeat purchase, trade-in/other-person exclusions, marketing evidence once,
  dealer nicknames, genuine askers), precision guards (non-vehicle objects, spec/finance 多少, dealer-selection phrasings,
  statements vs research), LLM never promoting non-buyers, calendar timeframes via `opts` and `ctx.clock`.
- `test/unit/nlu/intent-detection-skill.test.ts` — LLM gating, verbatim/field validation, one-step stage clamp,
  negative never removed, failure/malformed fallback, audit decision, skill invocation through `SkillRegistry` with a
  DB-backed dealer.
- `test/unit/nlu/lexicon.test.ts` — aliases, boundaries, locations, IP, competitors, display names, budget/timeframe/
  negation, calendar timeframes relative to now (month parts, National Day, past months, years, timezone).
- `test/unit/nlu/hardening.test.ts` — adversarial regressions:
  - past-tense timeframes; feature-object refusals; 区别发 / 被骚扰 / 刚提的问题
  - marketing false positives; availability vs discount; finance specifics; 绿色牌照 / 加速多少
  - JV brand locations, brand-blocked context inference, 宝马M3
  - question-code round-trip and negative markers
  - LLM negative cue and quote re-anchoring
  - conversation refusals, appointment negation and meeting times, contact refusal, WeChat 搜
- `test/integration/corpus-signal-quality.test.ts` — every corpus post and comment through the simulation provider:
  roles, spam, creator/owner non-signals, out-of-area, group routing and a qualified-signal sanity band.
