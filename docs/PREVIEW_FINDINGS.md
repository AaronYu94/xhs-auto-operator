# Findings from the live preview (real Wave A modules over the simulation corpus)

Observed 2026-09-13 by running dealer fixture + SimulationXhsProvider (12 spec example queries, 14 notes,
103 comments, 46 users) through prefilter → detectIntentRules → scoreSignal → per-user aggregation.
These are **product defects** to fix in the real modules (NLU A3 / scoring A5 / dedup B1), with regression tests.

## F1 — Post authors who INFORM are scored as buyers (critical)
- `杭州买车指南针` post "杭州买宝马攻略｜到店前必看的6件事" → 97 immediate.
- `杭州小众探店车` post "杭州i3试驾体验｜续航、空间、优惠一次说清" → 96 immediate.
- `电车老司机阿杰` (IP 上海) post "宝马i3现在值得买吗？ 最近好多粉丝问我…开了一周35L" → 83 high_intent.
Cause: transaction keywords inside informational content (攻略, 体验, 一次说清, 分享, 测评, 粉丝问我) are treated as questions.
Fix: author-role classification for `source_type: 'post'` — **asker** (question forms: 吗/？/求推荐/怎么选/预算…推荐) vs
**informer/creator** (攻略, 测评, 体验, 分享, 一次说清, 必看, 合集, 干货, 粉丝问我, 开了N天/一周) vs **owner** (提车, 车主, 开了半年).
Only askers are purchase signals; informers/creators get `is_purchase_signal=false` + evidence `content_creator` and are never leads.

## F2 — Already purchased users are scored as buyers (critical)
- `第一次买宝马的Coco` post "第一次买宝马｜4S店砍价全过程，落地价公开 … 人生第一台宝马终于提啦🎉" → 93 immediate.
- `i3车主小严` comment "开了半年i3，做工和底盘真的好，推荐去试驾对比下" → 82 high_intent, although NLU already emitted evidence
  "已购车（非在市买家）".
Fix: ownership/purchase-completed detection (终于提啦, 提车了, 提车N个月, 车主, 开了半年/一年, 已经买了, 入手了 + past tense) ⇒
`negative`/non-signal for acquisition (they may be customer-story/referral candidates, not leads). Scoring must treat an
`already_purchased`/`owner` evidence code as non-signal (score via the non-signal formula). Aggregation must not let owner
remarks add corroboration bonus.

## F3 — Out-of-area buyers rank as high intent for a local dealer (major)
- `深圳湾跑步的阿辉` "深圳i3 35L落地多少" (stated 深圳/广东) → 81 high_intent for 杭州宝马中心 (2 signals + corroboration).
Fix (contract addition): when the lead **explicitly states** a city/province outside the dealer's province, cap the signal
score at `qualified threshold − 1` (i.e. at most candidate tier) and add evidence `out_of_area` ("异地买家（深圳）") so the
Fleet Controller can route it to a dealer in that region (if the group has one) instead of this dealer's accounts.
IP-only mismatches are not capped (IP 属地 is noisy) but receive no location points.

## F4 — Corroboration from low-value signals (minor)
`i3车主小严` had 5 merged signals (owner remarks) → bonus. Only signals that are themselves purchase signals ≥ candidate
threshold may count toward corroboration (contract already says "qualifying"; ensure owner/creator signals are excluded).

## F5 — Leads are scored only against one dealer, not the group (major)
- `陆家嘴搬砖人` (IP 上海) "325Li现在落地多少" → 81 high_intent for 杭州宝马中心, while the group also owns 上海宝马中心.
- `SUV测评君` (content creator, IP 广东) → 78 qualified (also F1).
Fix: discovery evaluates a signal against EVERY dealer profile in the group and assigns `lead.dealer_id` to the
best-matching dealer (location first, then model/inventory); the Fleet Controller then only ranks that dealer's accounts
(falling back to group accounts when the matched dealer has no operable account). Record the per-dealer scores in the
lead_score decision so salespeople can see why the lead went to that store.

## UI notes (preview)
Design fidelity to docs/UI_DESIGN.md is good. Keep: evidence chips, quote block with source line, merged-signal banner,
collapsible score breakdown with per-factor reasons, honest "构建中"/"人工发送" labels.
