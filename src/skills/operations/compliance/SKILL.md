# compliance

## Responsibility
Pure platform-compliance checks for customer-facing text: outreach DMs, follow-ups, conversation replies,
public comment replies and posts. It backs guard 8 (`platform_rules`) of the pre-send pipeline (ARCHITECTURE §6)
and the compliance part of content review.
- **Contact info / off-platform steering.** Since 2025-01-07, Xiaohongshu professional accounts may not send
  phone numbers or WeChat ids and must exchange contacts via 留资卡 / 名片 (docs/XHS_INTEGRATION_RESEARCH.md).
  The check catches:
  - phone numbers (mobile, landline, 400/800), including spaced, dashed, slashed, emoji-separated, full-width and
    Chinese-numeral digits, and landlines written `（0571）8888 6666`
  - WeChat ids and "加微信" solicitations: 微信 / 薇信 / 威信 (also spaced, e.g. `威 信`) / v信 / vx / wx / 加V / ➕V /
    slang 加微 / ➕薇 / `V❤：id`, including ids wrapped in brackets (`微信（abc123）`, `微信【abc123】`)
  - QQ numbers and e-mail addresses
  - URLs and domains, including extra TLDs (`.store`, `.ai`, `.tech` …) and obfuscated dots (`bmw点com`, `bmw。cn`)
  - 引流 phrases: 加我, 扫码, 二维码, 主页/简介联系方式, 公众号, 同名公众号, 私域, 留个电话
- **Dealer-prohibited claims** (from Dealer Brain), matched case-insensitively after NFKC normalization, ignoring spaces
  (`No.1` also matches `NO. 1`).
- **Advertising-law absolute terms**: 全网最低, 最低价, 史上最低, 第一品牌, 国家级, 最佳, 最好的, 顶级, 绝对,
  100%保证, 独家, 万能, plus 价格最低, 最便宜, 全国第一, 销量第一, 百分百保证, 百分之百保证. Spaces are ignored (`100% 保证`).
- **Length limit**; more than 8 emoji, counted as rendered glyphs (a flag, a ZWJ family or a keycap counts once); runs of repeated `!?~`.
- **DM only**: mass-marketing boilerplate (回复TD退订, 【签名】, 尊敬的客户, 点击链接) and any link, including on-platform short links.
- **Near-duplicate detection** against other texts (mass-template guard).

## Owning agent
`content-review-agent` (skill category `operations`). Outreach guards call the pure functions directly.

## Inputs
Pure functions take plain values. Skill input (validated with `v.*`):
`{ text: string; channel: 'dm'|'comment'|'post'; max_length?: int ≥ 1; prohibited?: {phrase, reason?}[];
compare_with?: string[]; duplicate_threshold?: 0..1 }`.
The default `max_length` is `dm` 300 (system policy, §6), `comment` 280 and `post` 1000. These are conservative, configurable defaults.

## Outputs
- `detectContactInfoLeak(text) → RuleIssue[]`: `{code, message, quote}`, where `code` is one of `contact_phone | contact_wechat |
  contact_qq | contact_email | contact_link | off_platform_solicitation`.
- `checkPlatformRules(text, opts) → {passed, issues}`. Issue codes: `empty_text`, the contact codes above, `prohibited_claim`,
  `ad_law_absolute_term`, `too_long`, `excessive_emoji`, `punctuation_spam`, and for `dm` also `marketing_boilerplate` and `link_in_dm`.
- `isNearDuplicate(text, others, threshold=0.85) → {duplicate, max_similarity}` (bigram Jaccard via `textSimilarity`).
- Skill → `{passed, issues, max_length, duplicate}`. A `near_duplicate` issue is added when the text duplicates `compare_with`.
  Messages are in Simplified Chinese, for reviewers.

## Validation & guarantees
- Every `quote` is a verbatim substring of the **original** text. Matching runs on NFKC and lower-cased text with an index map
  back to the source, so full-width `１３８－００００－１２３４` is detected and quoted as written.
- Overlapping matches of the same kind merge into one issue (`加我微信abc12345`). A weak phrase inside a stronger match is not repeated,
  and a link already reported as `contact_link` is not reported again as `link_in_dm`.
- False-positive guards (covered by tests):
  - `支持微信支付` and `微信扫码支付`
  - trims and prices: `325Li`, `35.39万`, `36期0息`, `3.5L`
  - `参加我们`, `2.0T+V型`, `稍微信任`, `权威信息`, `增加微调`, `Mr.Wang`
  - `可以通过留资卡留下联系方式`: 留…联系方式 is exempt only when 留资卡 / 名片 is in the **same clause** and not negated.
    `不用留资卡，直接留个电话给我` is still flagged.
  - `最低首付2成` / `首付最低2成`: factual finance phrasing never triggers 最低-style claims unless the prohibited phrase itself
    mentions 首付 / 月供
- Deterministic and side-effect free. `checkPlatformRules` throws `ValidationError` for a non-positive `max_length` or an unknown channel.

## Runtime entry points
`src/skills/operations/compliance/index.ts`:
```ts
interface RuleIssue { code: string; message: string; quote?: string }
checkPlatformRules(text, { prohibited, max_length, channel }): { passed: boolean; issues: RuleIssue[] }
detectContactInfoLeak(text): RuleIssue[]
isNearDuplicate(text, others, threshold?): { duplicate: boolean; max_similarity: number }
countEmoji(text): number
RULE_CHANNELS, CONTACT_LEAK_CODES, AD_LAW_ABSOLUTE_TERMS, MAX_EMOJI, DEFAULT_MAX_LENGTH
skill            // name 'compliance'
```

## Failure modes
- These are pattern rules, not an oracle. Unusual obfuscation, such as ids split across several messages or images, can slip through.
  Ambiguous wording is flagged on the safe side, which routes it to review or blocks it.
- An English word of 6 or more letters right after a WeChat keyword (e.g. `微信 payment`) is read as an id.
- Only the first occurrence of each prohibited phrase or absolute term is quoted; `passed` is still false.

## Tests
`test/unit/compliance/compliance.test.ts`:
- contact-leak positives with verbatim quotes, and false-positive guards
- each advertising-law term, full-width normalization, the finance exemption, dealer-prohibited phrases (case-insensitive)
- length by characters, emoji threshold, punctuation spam
- DM boilerplate and links (DM vs comment)
- option validation
- near-duplicate thresholds and emoji-only texts
- skill validation, defaults and the `near_duplicate` issue
