# UI Design System: 驭客 Steer console (binding spec)

Source of truth: **`docs/design/steer-ui-kit.html`** (tokens, components, motion, sample views) and the logo
`docs/design/steer-logo.png`. This document records how the kit is applied to the running console and the rules the
kit does not spell out. Implementation: `src/server/assets.ts` (`CONSOLE_CSS`, `CONSOLE_JS`), shell in
`src/server/render.ts` (`layout`, `SVG_DEFS`), status bar and theme in `src/server/pages/shell.ts`, pages in
`src/server/pages/`. No CSS framework, no web fonts, no CDN, no inline script (CSP `script-src 'self'`).

History: the console first followed `docs/design/ui-reference.png` (retired), then a blue B2B system (replaced
2026-09 by this kit). Neither is a spec any more.

Product name in the UI: **驭客 Steer** (page titles `… · 驭客 Steer`, the agent is "Steer"). The S mark is the kit's
vector approximation of the logo; replace the `st-mark` symbol in `SVG_DEFS` with the designer's exported SVG.

---

## 1. Principles (from the kit, plus the product's honesty rules)

1. **Calm canvas, black actions, gold for Steer at work.** Warm off-white canvas, white cards, near-black primary
   buttons (at most one per view). Gold (`--st-gold`, text `--st-gold-ink`) only marks key states and AI execution:
   立即跟进 / 进行中 badges, the evidence-chip diamond, quote rules, the final pipeline stage, running Steer.
2. **Motion means Steer is working.** The 2.4s breathing dot and the flow particles on 今日 run only while a
   workflow is actually RUNNING; otherwise the flow is static and the dot is hollow. `prefers-reduced-motion` stops
   all animation.
3. **No sample data in the product.** The kit's rotating status texts, fake activity feed and simulated plan are
   design samples only. The status bar comes from `workflow_runs` (`agentStatus`), the rail from real
   `agent_decisions`, the command bar posts a real goal.
4. **Unverified state is never shown as fact.** Status dots: ok = logged in (verified), warn = needs QR login,
   hollow = not checked / unknown. Platform-absent metrics read 平台不提供 / 未知, never 0.

## 2. Tokens

`--st-*` tokens from the kit, light and dark (`:root[data-theme="dark"]` and `prefers-color-scheme: dark` unless
`data-theme="light"`). Key values (light): canvas `#F7F6F2`, surface `#FFFFFF`, surface-2 `#FAF9F6`, sunken
`#F0EEE8`, line `#E8E6E0` / strong `#D5D2CA`, text `#181817` / `#45443F`, muted `#6B6A66`, gold `#B69A70`,
gold-ink `#7D6440`, ok `#37704A`, warn `#9A6414`, bad `#A8403A`, primary `#181817`. Legacy aliases `--border`,
`--amber`, `--red`, `--green` map onto them for inline styles in older templates.

**Shape:** hero card and command box 20 · cards, tables, KPI tiles, panels 16 · buttons and inputs 10 (small
buttons 8) · badges, chips, filter pills full pill · avatars circle. Cards have no shadow; interactive cards lift on
hover (`--st-lift`).

**Type:** system font, Chinese first; numbers `.num` / `.st-num` (SF Pro Display, tabular, -0.02em). Page title 24,
hero title 30, section 16, body 14, helper 12-12.5, lead score 40, KPI 32.

**Motion:** ease `cubic-bezier(.2,.8,.2,1)`; 150ms hover/press, 200ms expand, 250ms view enter; 2.4s loop only for
Steer at work.

**Theme:** follows the system until the operator clicks the moon button; the choice is stored in cookie
`st_theme` and rendered server-side as `<html data-theme>` (no flash).

## 3. Shell

- **Sidebar** (76px, sticky): S mark → 今日 home; icon + label nav **今日 · 线索 · 对话 · 内容 · 账号 · 情报 · 系统 ·
  设置** (Feather icons, MIT); active item = white glyph box + bold label; 今日 carries the needs-you count; footer =
  theme toggle + operator initial (link to 退出 / 设置操作人). The kit's CRM / 资料库 views map onto the existing 线索 /
  对话 and 系统 (Dealer Brain) pages; the IA was not changed.
- **Status bar** (56px, sticky, blurred): Steer dot + what Steer is doing (`agentStatus`) + relative time kept current
  client-side (`data-since`); right: search, data-source badge (真实数据 / 模拟数据模式 / 未连接小红书), store
  switcher pill, primary 「待你处理 N」.
- **Content**: max 1560px, 28px padding; page head (24px title + muted subtitle) except 今日, which has the hero.
- ≤1280px the 今日 rail stacks under the main column; ≤900px the sidebar becomes a top row with horizontal nav;
  ≤640px tables become stacked rows.

## 4. 今日 (kit "Today")

Hero card: date + store, 「Steer 今天在替你的门店做什么」, a lede built from today's real counts, the S-shaped flow
(labels = today's scanned notes / comments, chip = the top lead or 「还没有线索」), five stages (读取公开内容 ·
评估公开用户 · 合格买家 · 高意向 · 私信草稿等你发送), and the command bar (real `POST /api/goals`; suggestion chips
built only from the store's own city, models and accounts). Then 今天需要你 (bento: 线索 top 4 by score with the
verbatim quote · 待处理回复 · 今日内容 segments · 预约与成交, plus the full exception list), 客户进度 (cumulative
reach per stage), 账号编队 (real avatar, verified login dot, today's work), 经营目标, 今日简报 and the metric groups.
Right rail: Steer 动态 from real decisions — each line is `decisionTitle` + `decisionText` (`pages/decision-view.ts`,
shared with 系统 → AI 决策审计): a summary built from the decision's own output (pre-send checks, scores, screening),
never a raw id; a record with nothing readable shows its title alone. Plus the note that Steer never sends DMs.

## 5. Components (existing class names, kit styling)

- Buttons: `btn-primary` black; `btn-ink` / `btn-ghost` secondary (bordered surface); `btn-danger` red text.
- Badges (`pill()`): ok / warn / bad soft fills; `violet` / `coral` = gold (AI, 进行中, 立即跟进); `coral-soft` =
  outline; neutral = sunken.
- Tables: white 16px container, 12px muted headers, 14px rows separated by hairlines.
- Lead inbox lists open leads only; `显示已流失 / 已成交（N）` switches to the closed ones (`?closed=1`), which keep their
  Chinese lost reason (`已流失：大模型复核：不是本地在市买家`). Nothing is ever deleted.
- Lead inbox legend (`<details class="legend">` 「这些状态代表什么」, under the filters): explains 意向分层 · 阶段 ·
  关闭原因 · 大模型复核的判定, each with the live count for this store, and **only for the values the store actually
  has** (a stage nobody reached is not explained). The definitions describe the real rule behind each state, and the
  closing note says closed leads keep their quote, source and reason and can be reopened.
- Lead inbox filters: the bar carries only 搜索 · 分层 · 地区 plus 筛选 / 清除 and the 显示已流失 / 已成交（N） toggle.
  阶段 · 数据来源 · 身份 · 信号类型 · 车型 live in a `<details class="filters-more">` drawer, and each one is rendered
  only when it can actually split the list the operator is looking at (open leads, or all of them when closed ones are
  shown) or when it already carries a value from the URL; the drawer opens itself and reads 更多筛选（已启用） then.
  A filter with a single possible value is dead furniture and is not drawn at all.
- Lead inbox table (`.lead-list`, header `.lead-head` + `.lead-row`, ~37px per lead): the inbox is a work table, not a
  set of cards, so alignment groups the information instead of coloured badges. Six columns:
  **意向** (20px score, gold-ink when hot, tier word under it) · **客户与原话** (30px round avatar, the verbatim quote on one truncated
  line, then `昵称 · 地区 · 时间 · N 条信号`) · **判断依据** (2 evidence chips plus a `+N` chip whose tooltip lists the
  rest) · **来源** (信号类型 and the note title when it differs from the quote, then `搜索词「…」· 原帖`) ·
  **负责账号** (22px account avatar and nickname) · **状态** (what the lead waits for, gold when it needs a human, red when blocked, with the CRM stage
  under it). The row is clickable through a stretched `.lead-open::after`, so the 原帖 link inside it still works.
  Below 1400px the 判断依据 column drops, below 1120px 来源 and 负责账号 drop, below 900px the row stacks.
  The row preview strips Xiaohongshu topic tags and emoji codes; the stored signal and the detail page stay verbatim.
  Avatars (`.avatar`, people and accounts alike) load through `/media/xhs-image`; with no avatar on the platform the
  circle keeps the first character of the name, never a stock face.
- Account card: 64px real avatar with the login dot, bio, 粉丝 / 关注 / 获赞与收藏, own notes, 运营定位, footer
  actions.
- **移除账号**: the account card's 移除账号 says what happens before it happens (线索回到线索池) and the toast reports
  what the server actually did (how many leads went back, whether the account was deleted or kept for history, via
  `data-success-detail`). 账号 lists only the live fleet; a line under it counts accounts removed for history only.
  A lead never shows an account it no longer has: it reads 未分配 and can be assigned again from its detail page.
- **加入新账号**: 添加账号 → the new card's **启动本机实例** (only where the console's host runs the instances: `XHS_MCP_BIN`
  + `XHS_MCP_DATA_DIR` + `XHS_MCP_TOKEN`) → **扫码登录（登录窗口）** → 检测登录状态. The start button carries
  `data-pending="正在启动实例…"` because it waits for the instance's `/health`; 扫码登录 stays disabled until the account
  has an instance, and the card still says 登录未检测 until a live probe confirms the session. Without a local binary the
  card keeps the `scripts/xhs-mcp-fleet.sh start <账号标识>` hint and the 实例地址 field instead.
- Banners 12px radius tinted (warn / bad / gold for simulation / ok); empty states dashed on surface-2.
- **Honest capability UI**: when `send_messages` is not AVAILABLE, the outreach card shows 复制私信 and
  我已在小红书发送, never "发送成功". Metrics the platform never provides read 平台不提供.
- **内容页 = 一次只看一件事**: one muted line says the whole page (`AI 排选题 → 写正文 → 事实与合规核查 → 你点头 →
  发布 → 回看哪篇带来成交`), then exactly one primary action (never pointing at the tab already open) with the other
  workflow buttons inside 更多操作, then four counted tabs: 本周要发什么 / 等你处理 / 发出去之后 / 评论回复. The page
  opens on 等你处理 when anything waits for a person. A post renders as a **note card** (`.note`): a 4:5 cover tile
  carrying `cover_text` (or the topic before the AI writes), the title, its status pill, pillar and date, plus the
  fact-check and compliance marks in the 等你处理 view and 线索 / 预约 / 成交 under it in 发出去之后. 本周要发什么 is a
  board (`.board`): one row per account, one column per day, today's column marked, each account row saying how many
  notes it has that week. A store with no accounts or no vehicles gets an amber banner explaining what that blocks
  (the AI only cites imported dealer facts), separate from the action.
- **对话页 = 小红书式收件箱** (`.im`): left column 消息 with 全部 / 需要人工 tabs and person rows (40px real avatar, name,
  last line, owning account + flag, relative time); right column the thread with that person. Rows are ordered
  needs-human first, then by recency, and include people who were messaged and never wrote back (their row says
  你已发出私信，等待回复) so the inbox is the whole worklist. The thread carries day dividers, our sent DM as a dark
  bubble on the right, the customer's words as a bordered bubble on the left, and an AI draft as a gold card with
  复制 / 审核通过 / 我已发送 on it — a draft never renders as a delivered message. Under the header sit the handoff
  reason (amber bar) and 已提取信息 as a disclosure. The composer looks like the app's but takes the **customer's**
  words: its label says 客户说了什么（粘贴原话）, the account and user id are hidden fields, and a do-not-contact
  customer has no composer at all. With nothing open the right pane explains the page (four-step flow strip, the
  customer-reply step amber, the AI step gold). `[data-scroll-bottom]` opens a thread at the newest message. Below
  900px it becomes one column: the list on top, and an open thread hides it behind a ← 消息 link.
- **账号语言风格** (账号卡片里的折叠块): 学过之后显示 学自 N 篇 + 学到的规则，每条后面跟着依据（「41% 的历史标题带 emoji」），
  再给一条它自己的笔记做样子；没学过时显示 未学习 和一个「学习语言风格」按钮。规则是可执行的写法，不是「专业」「年轻」这种标签。
- **说人话**: every page speaks the dealer's language. Provider failures become one sentence about what happened and
  what to do (「小红书页面改版了，这次搜索没走通」), capability rows say what the store can do with them
  (「可以直接发笔记（图文至少 1 张图，视频 1 个文件）」), AI decisions name the role (AI 账号调度) and the customer or
  note they were about, not the skill and the row id, and 账号 shows 运行位置：本机 with the address tucked into
  高级设置. Raw records stay one click deep on 系统 as 技术详情. `src/server/humanize.ts` owns the wording;
  `test/unit/server/no-internals.test.ts` is the guard.
- **车型库** (`/vehicles`): the line-up as photo cards (`.veh`), not a table — cover (a real photo through
  `/media/vehicle-image`, else the model name on a plate), name + 年款/配置, 当前售价 with the struck-through 指导价 and a
  ↓差额 pill, spec chips, then 现车 N 台 / 在途 / 暂无车源, the number of policies and an AI-资料 flag (gold when the card
  has AI material, amber 资料待生成 when it does not). 在售 / 已归档 are tabs; 批量导入 and 试一下检索 are disclosures above
  the grid. The card page (`/vehicles/:id`) splits the screen: **事实** (参数, 颜色与库存, 金融/租赁方案, 其他优惠) on the
  left with the edit form under it, **资料素材** (描述, 卖点, 适合人群, 竞品对比, 常见问题, 选题角度) on the right — the same
  split the prompts use, so it is visible which half may become a number in customer-facing text. 数据来源 and
  更新时间 sit under the hero, and a trim with no stock says 当前没有可售库存 rather than showing nothing.
- **消息中心 tabs** (对话页顶部): 私信 · 评论和@ · 赞和收藏 · 新增关注 — the same four places the app's 消息 page has, as
  `.im-tab` pills with the unhandled count (`tab-n`). A notification tab replaces the two-column inbox with one wide
  list (`.ntf`): avatar, nickname, kind pill, the platform's own wording (赞了你的笔记 / 开始关注你了), the comment as a
  quoted block, the account that received it and a link that opens the note on Xiaohongshu with its `xsec_token`.
  Unhandled rows carry an amber dot (they wait for a person). Actions are only the ones that row allows: 回复 (a
  `<details>` composer, public reply) and 点赞 exist only where there is a comment; 转为线索 / 处理完 / 忽略 always do,
  and a row that already produced a lead links to it instead. 同步消息 re-reads the centre for the whole store.
- **视频笔记** (内容详情 → 发布): next to the image list a single 视频笔记 field takes an absolute path on the machine
  that runs that account's instance. Filled in, the post is published as a video note (no images); emptied, it goes
  back to being an image note. The panel says the two are 二选一.
- **退出登录** (账号卡片): next to 检测登录状态 / 扫码登录, shown only for an account that has its own instance. It deletes
  that instance's session and the card immediately reads 需要登录 — for handing an account over, moving it to another
  machine, or clearing a wrong login.
- **私信发送**: with `XHS_DM_SENDER` on, an approved draft shows 「通过平台发送」 and the capability note says the message
  goes out through that account's own login session. A send whose outcome could not be established shows an amber
  banner, loses its send button and keeps only 我已在小红书发送 / 取消 — the console never offers a second automatic send.
- **私信渠道** (`dealer.settings.dm_channel`, 设置 → 运营策略): each store says where its salespeople actually
  send DMs — 小红书 App / 网页版 (default) or 专业号客服工作台. The draft's numbered steps, the capability note and
  the 录入客户回复 hint use that place, and the 专业号 channel adds a 打开客服工作台 link
  (`pro.xiaohongshu.com/im/multiCustomerService`, `target="_blank"`) next to 复制私信. It stays a link: the console
  never types into either surface, and 我已在小红书发送 is still how a send gets recorded.
- **设计系统（2026-09 重做）**: the console is a work tool, so the dials are `DESIGN_VARIANCE 3 / MOTION 2 / VISUAL_DENSITY 7`, not a marketing page's. Concretely: one six-step type scale and no literal `font-size` in any rule; three radii with a documented rule (control 6px / surface 10px / pill = status badge only); two control heights (32 / 26); hairlines and column rules instead of nested card boxes for tables, KPI rows, funnels and pipelines; motion limited to hover, focus and `:active`.
- **卡片不是默认容器**: a `.card` is for a real object (vehicle, note, account) or a form. Tables, metric strips, funnels, pipelines, to-do lists, the activity rail and detail `.panel`s carry no fill and no border: `.section-head` draws a rule under the title, rows are separated by hairlines, and the side column is divided by a single vertical rule. Grouping by repetition of the same white box is what made this console read as generated.
- **元素细节**: customer text goes through `previewText` (Xiaohongshu's own `#话题[话题]#` and `[表情]` markup never reaches a page); stored English brand names go through `zhBrands` before a Chinese sentence prints them; a definition list drops the rows it has no value for and says what is still unknown in one muted line, instead of printing a column of 「—」; evidence shorter than 12 characters is a chip, longer evidence is a read-as-text line; a count is a number, not a bordered badge; a row that opens something says 「去处理 ›」 rather than showing a play triangle.
- **导航**: a labelled sidebar grouped 每天 / 门店资料 / 回看 (`NAV_GROUPS` in `render.ts`), collapsible to a 60px icon rail. The collapsed state is the cookie `st_rail`, read server-side (`railFromRequest`) so the shell never renders wide and snaps shut. ≤1180px it is the icon rail; ≤900px it becomes one scrollable row above the content. Nav labels and routes are stable — they are muscle memory and analytics keys.
- **A page opens on the work.** 今日 leads with 今天要你处理 N 件事 and the list itself; the greeting headline and the decorative flow diagram it used to carry are gone (a drawn data-flow that encodes nothing real is decoration, and it pushed the actual queue below the fold). Empty panes state the one true sentence and offer the one next action instead of a numbered four-card diagram.
- **一行工具栏**: what you are looking at on the left, what you can do on the right (`.toolbar`). Filters, extra filters, view switches and page actions never stack on three separate lines.
- **说明收进「?」** (`hint()` in `src/server/render.ts`, re-exported from `src/server/hint.ts`): a page carries one
  sentence of conclusion; everything that explains it goes behind a small 「?」 next to the title, label or button it
  belongs to (`<details class="hint">`, opens as a popover, no JS). `sectionHead(title, { help })` puts one on a
  section title, and `renderPage({ help })` puts one on the page's own `h1`. `note` stays for a short line that is
  worth reading every time; footnote paragraphs at the bottom of a page are gone.
- **A page subtitle is the store's name, not a pitch.** What a page is for goes in its `help`, behind the 「?」 on the
  `h1` — never spelled out in the subtitle (「杭州宝马中心 · 每个账号发什么、谁来写、谁来把关」) and never as a lede
  paragraph above the content. A subtitle may add one short fact that changes (`· 共 6 个号`), nothing else.
- **Unfinished-feature placeholders** (`src/server/unfinished.ts`, helpers `unfinishedTag` / `unfinishedButton` /
  `unfinishedBlock`): the registry stays — a feature that does not exist must never look like it works — but the
  helpers now render **nothing**. A disabled 「未完成」 button on every screen taught salespeople that the product is
  broken, so the disclosure lives in exactly one place: 系统 → 还没做完的功能. Finishing a feature removes its entry
  and the helper call together (`test/unit/server/unfinished.test.ts`).
- **Speak the store's language** (`src/server/humanize.ts`): tool names, instance ids, endpoints, env names, English
  status codes, skill/agent names and provider errors never reach a page. Everything user-facing goes through
  `scrubInternals` / `humanProblem` / `humanActor` / `humanAction` / `humanCapability` / `humanProviderMode` first,
  and `test/unit/server/no-internals.test.ts` renders every page with live-shaped ugly data to prove it.
