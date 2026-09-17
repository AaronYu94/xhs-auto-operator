# UI Design System — binding spec for the operator console

Source of truth: `docs/design/ui-reference.png` (customer-provided reference, "Overview of Operations").
Colors below were **sampled from the reference pixels**. Fidelity to the reference beats generic taste
guidance. The product is Chinese-first; the reference's Latin conventions (uppercase, letter-spacing) are
translated for Chinese as noted.

Product name in the UI: **AI 汽车运营官** (logo mark + name, top-left).

---

## 1. Design tokens

```css
:root {
  color-scheme: light;

  /* grounds */
  --bg: #FAF9F6;            /* warm off-white page */
  --surface: #FFFFFF;       /* cards, search pill, tabs container, activity panel */
  --surface-muted: #F2F0ED; /* muted full-width buttons ("View All Activity") */
  --surface-sunken: #F1F1EE;/* small outlined id pills, "Live" pill */
  --border: #ECEAE5;        /* hairline around white surfaces (very subtle) */
  --divider: #F3F2F0;       /* table row separators */
  --divider-dashed: #E7E5E1;/* activity list dashed separators */

  /* text */
  --text: #0D0D0D;          /* headlines, primary cell text */
  --text-2: #4E4E4F;        /* subtitles, inactive tabs, button text */
  --text-3: #5C5C5C;        /* secondary cell text / categories */
  --text-muted: #979797;    /* table headers, captions */
  --text-faint: #9A9A9A;    /* timestamps */

  /* brand + accents */
  --coral: #EC6644;         /* brand mark, primary button, hero KPI card, high intent */
  --coral-strong: #EA532D;  /* big numbers on white ("04") */
  --coral-soft: #FDF3EF;    /* tinted icon circles, soft coral pills */
  --coral-on: #FAD7CE;      /* decorative dot / faint text on coral */
  --lavender: #C5B7EE;      /* secondary KPI card */
  --lavender-soft: #EFEAFC; /* AI-decision icon circles, qualified pills */
  --violet: #6852F6;        /* glyphs on lavender-soft */
  --avatar: #D4C7F2;
  --ink: #0D0D0D;           /* black KPI card, active tab, secondary buttons */

  /* semantic soft pills (bg / text) */
  --green-soft: #EBF5EA;  --green: #2C6A22;
  --amber-soft: #FDF4E2;  --amber: #D95A09;
  --red-soft:   #FCECEE;  --red:   #AE2219;

  --grad-title: linear-gradient(90deg, #9F84E2 0%, #CC7A8B 55%, #ED7857 100%);

  /* shape */
  --radius-xl: 28px;   /* KPI cards, panels */
  --radius-lg: 22px;   /* lead cards, inner cards */
  --radius-pill: 999px;

  /* type */
  --font-sans: "Inter", -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Hiragino Sans GB",
               "Microsoft YaHei", "Noto Sans SC", sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace;
}
```

No dark theme is required (internal operator tool); paint `body { background: var(--bg); color: var(--text) }` explicitly.
Shadows are essentially absent: white surfaces sit on the warm ground with at most a 1px `--border`
hairline. Never use heavy drop shadows, gradients on surfaces, or glassmorphism.

## 2. Typography scale

| Role | Size / weight | Notes |
|---|---|---|
| Page title (H1) | 40px / 700, line-height 1.1, letter-spacing -0.02em | One key phrase uses gradient text (`background: var(--grad-title); -webkit-background-clip: text; color: transparent`) |
| Page subtitle | 16px / 400, `--text-2` | |
| KPI label | 13px / 600, letter-spacing 0.14em (Latin uppercase) · Chinese: 14px / 600, letter-spacing 0.08em | on coral/ink cards use white |
| KPI number | 56px / 400, `font-variant-numeric: tabular-nums`, letter-spacing -0.02em | outline card number in `--coral-strong`; counts < 10 zero-padded ("04") |
| Section title | 24px / 500 | followed by a soft "Live"/"实时" pill |
| Panel title | 22px / 700 | |
| Table header | 12px / 500 uppercase 0.12em (Chinese 13px / 500 0.06em), `--text-muted` | |
| Primary cell | 17px / 500 `--text` | |
| Secondary cell | 13px / 400 `--text-3` | |
| Mono cell | 15px `--font-mono` `--text-3` | ids, query text, note ids |
| Body | 15px / 400 | |
| Caption / time | 12–13px `--text-faint` | |

## 3. Layout

- Container `max-width: 1440px`, centered, side gutter `clamp(16px, 4vw, 48px)`; page block padding 28px top.
- Top bar height 76px: left logo (28px coral circle with 10px white inner dot) + "AI 汽车运营官" 22px/700;
  center search pill (max 420px, white, pill radius, search icon, placeholder "搜索线索、用户、车型、笔记…");
  right: dealer switcher pill ("杭州宝马中心 ▾"), bell in 44px white circle (coral dot when exceptions > 0),
  44px avatar circle `--avatar` with operator initial.
- Header row: H1 + subtitle left; segmented tabs right (white pill container, 6px inner padding; active tab = ink pill with
  white text; inactive `--text-2`). Tabs: **总览 · 线索 · 对话 · 内容 · 账号 · 情报 · 系统**.
- KPI row: 4-column grid, gap 28px, card min-height 186px, padding 28px.
- Main grid: `grid-template-columns: 2fr 1fr; gap: 40px` → table/list section left, activity panel right.
- Spacing base 4/8px; section gaps 48–56px.

Responsive: KPI grid 4 → 2 (≤1100px) → 1 (≤640px); main grid stacks ≤1100px; tables turn into stacked row-cards
≤760px; tabs container scrolls horizontally; search collapses to an icon button ≤760px; never horizontal page scroll.

## 4. Components

**KPI card variants** (exactly four styles from the reference):
1. `coral` — bg `--coral`, white text, top-right 12px dot `--coral-on`, footer chip (bg white 22% opacity, white text,
   e.g. "+12%") + caption; decoration: large faint ring (2px stroke slightly darker coral, ~120px, bottom-right, clipped).
2. `lavender` — bg `--lavender`, ink text, top-right dark dot `#36333E`, footer chip (white bg, ink text) + caption; decoration: faint wave stroke.
3. `ink` — bg `--ink`, white text, top-right small icon, caption in white 70%.
4. `outline` — bg white + hairline border, label `--text-muted`, number `--coral-strong`, top-right coral dot, caption `--text-2`.

**Buttons**: primary = coral pill, white 15px/500, padding 12px 24px, leading "+" for create actions;
secondary = ink pill; ghost = white pill with hairline; muted = `--surface-muted` full-width 48px ("查看全部动态");
row action = 40px white circle with hairline + chevron/play glyph. Hover: 150ms, slight darken; cards `translateY(-1px)`.
Focus: 2px `--ink` outline, 2px offset.

**Pills**: id pill (outlined, `--surface-sunken`, 12px mono, e.g. score "96" or "A-01"); status soft pills (13px/500, padding 4px 12px):

| semantic | bg / text | used for |
|---|---|---|
| success | green-soft / green | SENT, SENT_MANUALLY, WON, PUBLISHED, HEALTHY, AVAILABLE |
| waiting / needs you | amber-soft / amber | READY_FOR_REVIEW, APPROVED(待手动发送), IN_REVIEW, needs_human, WATCH, AT_RISK, REQUIRES_REVIEW, REQUIRES_AUTH |
| blocked / negative | red-soft / red | BLOCKED, LOST, 勿扰(suppressed), RESTRICTED, UNAVAILABLE, FAILED |
| AI | lavender-soft / violet | AI decisions, recommendations, QUALIFIED tier |
| neutral | surface-sunken / text-3 | CANDIDATE, PLANNED, DISCOVERED |

Score tier pills: immediate = coral solid + white text ("立即跟进"); high_intent = coral-soft + coral-strong ("高意向");
qualified = lavender-soft + violet ("合格"); candidate = neutral ("候选"); none = faint text.

**Data table** ("Recent Movement" pattern): header row uppercase-muted; rows ~88–100px (dense 64px) separated by
`--divider` hairlines; col 1 id/score pill; col 2 two-line primary/secondary; a mono column; status pill; circular action.

**Activity panel** ("Activity Log" pattern): white card radius 28px, padding 28px; items = 44px tinted circle icon
(lavender-soft+violet for AI decisions, coral-soft+coral for alerts/blocks, green-soft+green for wins) + bold 15px title +
13px description + 12px time; dashed dividers; muted full-width footer button.

**Lead card** (Lead Inbox, spec §18 — evidence never hidden):
```
┌──────────────────────────────────────────────────────────┐
│ 96  [立即跟进]  [ASSIGNED]                        销售小王 ○ │
│ BMW i3 eDrive35L · 杭州 · purchase_imminent             │
│ ┃ “杭州i3 35L白外红内有现车吗？这周想去看看”                │  ← quote block: bg --bg, 3px coral left bar
│ ┃ 评论 ·《宝马i3现在值得买吗？》· 1天前                      │
│ [询问现车] [指定配置 eDrive35L] [本地买家（杭州）] [本周到店]  │  ← evidence chips (lavender-soft)
│ 下一步：审核私信：通过后在小红书发送            [审核私信 →] │
└──────────────────────────────────────────────────────────┘
```

**Honest capability UI**: when the XHS provider is `simulation`, show a persistent lavender pill "模拟数据模式" next to the
logo. When `send_messages` is not AVAILABLE, outreach actions read "复制私信 · 我已在小红书发送" — never "发送成功".

## 5. Page mapping

| Tab | Content (reference pattern → our data) |
|---|---|
| 总览 | H1 "今天的 <gradient>获客进展</gradient>", subtitle "{dealer} · {date} · 公开购买信号 → 线索 → 私信 → 到店". KPI: coral **高意向线索** (+N 较昨日) · lavender **预计管道价值** (¥万, chip 阶段加权) · ink **今日到店预约** (待确认 N) · outline **需要你处理** (zero-padded count, "待审核私信 · 待审批内容 · 人工接管"). Left: "需要你处理 · 实时" exception table + primary "+ 下达经营目标" (goal input). Right: "AI 员工动态" from agent decisions/audit. Below: funnel strip, CONTENT / DISCOVERY / OUTREACH / SALES / ACCOUNTS stat groups, filter pills (dealer, account, brand, model, location, date, source, stage). |
| 线索 | filter pills + lead cards; lead detail = signals timeline with verbatim quotes, score breakdown, assignment ranking, outreach + guard results, conversation, funnel transitions, decisions. |
| 对话 | conversation list (needs_human first) + thread with extracted slots, fact-grounded reply draft and facts used. |
| 内容 | week calendar per account, review queue (fact/duplicate/compliance results), attribution table "哪些内容真正带来成交". |
| 账号 | 5+ account cards: persona, focus models, health pill, load, reply/conversion rate, per-account capability status. |
| 情报 | search queries with lead density bars and conversions, research briefs, trend terms. |
| 系统 | workflow runs & steps (resume), schedules, provider/LLM capability table, audit decisions, Dealer Brain browser, scoring config. |

Charts: minimal — coral / lavender / ink bars, no gridlines, direct labels.
