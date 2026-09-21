# Xiaohongshu provider layer (`src/providers/xhs`)

Business logic never talks to Xiaohongshu (小红书, "XHS") directly. Everything goes through the
`XhsProvider` interface (`types.ts`). Every capability reports `AVAILABLE | UNAVAILABLE |
REQUIRES_AUTH | REQUIRES_REVIEW`, and every call returns a `ProviderResult`. **No provider fakes
success for something it cannot do.**

| file | role |
|---|---|
| `types.ts`, `unavailable.ts` | interface, `buildReport`, `UnavailableXhsProvider` (foundation) |
| `simulation.ts` | `SimulationXhsProvider`: synthetic corpus for tests and demos (`mode: 'simulation'`) |
| `mcp-client.ts` | `McpHttpClient`: minimal MCP streamable-HTTP JSON-RPC client, typed `McpError` |
| `mcp-provider.ts` | `McpXhsProvider`: live adapter for [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) (`mode: 'live'`) |
| `visible-login.ts` | `runVisibleLoginHelper`: runs `tools/xhs-visible-login` (login window for a local instance), `parseHelperOutput` |
| `dm-send.ts` | `runDmSendHelper`: runs `tools/xhs-dm-send` (one reviewed DM from the account's own session), `parseSenderOutput` (verdict + the recipient's `peer_avatar_url`, xhscdn only), `DM_SEND_UNKNOWN_MARK` |
| `local-instance.ts` | `startLocalInstanceProcess`: starts a new account's own instance on this host (fleet-script layout, free port above the base port, `/health` before it is called started), `findInstancePort`, `isLoopbackHost` |
| `juguang-webhook.ts` | `parseJuguangLeadPush`: tolerant parser for the official 聚光 "私信API对接" lead push (`red_id`, scoped nested lookup, Shanghai-time parsing) |
| `index.ts` | `createXhsProvider(clock, cfg)`, `xhsProviderConfigFromEnv(env)`, re-exports |
| `../../../fixtures/xhs/simulation-corpus.json` | the simulation corpus (15 notes, 108 comments) |

## Capability truth table

| capability | simulation | live (`xiaohongshu-mcp`, one instance per account) | none |
|---|---|---|---|
| search_public_content | AVAILABLE | `search_feeds`: AVAILABLE when logged in, otherwise REQUIRES_AUTH | UNAVAILABLE |
| read_public_post | AVAILABLE | `get_feed_detail` (needs `xsec_token`) | UNAVAILABLE |
| read_public_comments | AVAILABLE | `get_feed_detail(load_all_comments)` | UNAVAILABLE |
| read_public_profile | AVAILABLE | `user_profile` (needs the `xsec_token` seen with the user) | UNAVAILABLE |
| publish_content | option `publish` (default off) | `publish_content`: at least 1 image, **no note id returned** | UNAVAILABLE |
| read_engagement | AVAILABLE | `get_my_profile` feeds interactInfo (**no views**) | UNAVAILABLE |
| read_notifications | **UNAVAILABLE** (the corpus has no notification centre) | `list_notifications` + `get_unread_count` | UNAVAILABLE |
| reply_comments | option `reply_comments` (default off) | `reply_comment_in_feed` | UNAVAILABLE |
| receive_messages | option `receive_messages` (scripted inbox, default off) | **UNAVAILABLE**: no DM inbox tool. Official DM access only via 私信通 / approved 三方客服 vendors | UNAVAILABLE |
| send_messages | option `send_messages` (default off) | **UNAVAILABLE**: no authorized API for DMs to users | UNAVAILABLE |

Live detection details:
- Capabilities come from `tools/list`, cached per endpoint for 5 minutes and dropped on any error,
  plus a fresh `check_login_status` call. Text containing `未登录`, or missing `已登录`, marks every
  login-dependent capability REQUIRES_AUTH. A missing tool gives UNAVAILABLE. An unreachable endpoint
  gives UNAVAILABLE, and method calls on it return `retryable: true`.
- If `tools/list` ever exposes a DM-like tool (`DM_TOOL_PATTERN`: the documented
  `/private.?message|direct.?message|send_?message|\bdm\b|chat/i` plus snake/kebab-case `send_dm`/`dm_list`,
  `inbox`, `conversation`, `私信`), both message capabilities become **REQUIRES_REVIEW** ("DM-like tool
  detected but unverified; not enabled"). That stays true even with `enable_dm_tools: true`.
  `sendMessage` / `listInboundMessages` report the same status (they read `tools/list` themselves). The tool
  is never called. None of the 18 real xiaohongshu-mcp tool names match.
- AVAILABLE reasons include the logged-in user parsed from `check_login_status` ("logged in as …"), so an
  operator can spot an instance that is logged into the wrong account.
- Tool text is classified by its **earliest** marker (`classifyToolText`): `成功`, `失败`, or login-required
  text. xiaohongshu-mcp echoes the post content in its confirmation (`内容发布成功: {Title:… Content:…}`), so
  a `失败` inside echoed content does not turn a confirmed success into a failure, and the reverse holds too.
  - Reads: `isError`, or non-JSON text whose earliest marker is `失败`, is a failure. Login-required text
    gives REQUIRES_AUTH.
  - **Writes** (`publish_content`, `reply_comment_in_feed`) succeed **only** on a `成功` confirmation.
    `失败` is a retryable UNAVAILABLE and login text gives REQUIRES_AUTH. Any other text (including empty
    text) is **REQUIRES_REVIEW, `retryable: false`** ("outcome unknown … verify on the Xiaohongshu account
    before retrying").
  - Writes whose `tools/call` may already have reached the server also get **REQUIRES_REVIEW,
    `retryable: false`**, so a retry cannot publish or reply twice. That covers timeouts, a socket failing
    mid-request, HTTP 5xx other than 503, and unparseable responses. Failures where the call never left the
    process get a retryable UNAVAILABLE: connection refused or DNS failure, a failed handshake, HTTP 503.
- The provider constructor rejects configurations where two `account_endpoints` point to the **same**
  instance, ignoring URL case and trailing slashes. Otherwise account actions would run in another
  account's session. The research endpoint may reuse an account instance.
- A throwing `resolveAccount` (for example a closed DB) produces a failed `ProviderResult` that carries the
  reason; nothing is thrown. Account ids such as `toString` or `__proto__` never resolve to a prototype property.

## Logged-out honesty, login session API and DB endpoints (v3)

- **Logged-out reads never look like "no results".** A logged-out xiaohongshu-mcp answers `search_feeds` / `get_my_profile`
  with `context deadline exceeded`, `get_feed_detail` with `笔记不可访问`, and `user_profile` with an all-empty *successful*
  profile (verbatim captures in `test/unit/providers/fixtures/xhs-mcp-logged-out.json`). Read methods (`searchNotes`,
  `getNote`, `getComments`, `getUserProfile`, `getEngagement`) first consult a per-endpoint login state (live
  `check_login_status`, cached ≤ `LOGIN_CACHE_TTL_MS` = 60 s, dropped on login text or a new QR request). Logged out →
  `REQUIRES_AUTH` without calling the read tool. A read that fails or returns empty from a cached login state re-probes the
  session; logged out → `REQUIRES_AUTH`. Unreachable instances stay UNAVAILABLE (retryable), never REQUIRES_AUTH.
  A read that returns content renews a cached `logged_in` state (a logged-out session cannot return content), so a
  discovery batch probes the login once instead of every 60 s; it never turns an unknown or logged-out state into
  logged in. Account status (`provider.auth.status`) still probes live every time.
- **One page load per note.** `getNoteWithComments` returns the detail and comments from one `get_feed_detail`
  (`load_all_comments: true`); a note with an empty comment section is not re-verified (the note proves the page
  loaded). lead-discovery also skips notes it fetched within `REFETCH_AFTER_MS` (12 h), including notes an earlier
  query of the same batch already read.
- **`provider.auth`** (live provider only; simulation / none leave it undefined):
  `status(accountId | null)` → `{logged_in, username, platform_user_id, red_id, detail, endpoint_label}` (user id from the
  author of the account's own notes via `get_my_profile`, cached 10 min per nickname);
  `loginQrcode(accountId | null)` → `{already_logged_in, image_data_url, expires_at (now + 4 min), detail}`. An account id
  never falls back to the research instance. Concurrent `status` calls for one instance share one probe; while a QR code
  or login window is pending, a logged-out status skips `get_my_profile` (it hangs 60 s on a logged-out instance).
- **`provider.auth.visibleLogin`** (only with `visible_login` configured): Xiaohongshu rejects QR logins scanned from the
  headless instance, so `start(accountId | null)` runs the login helper for a **loopback** instance, which opens a visible
  browser window and writes `<data_dir>/<instance>/cookies.json` (`instance` = `research` or the platform account id).
  `status(…)` → the latest `XhsVisibleLoginJob`. Remote instances, a missing helper or state dir fail with the fix in the
  reason (`scripts/xhs-mcp-fleet.sh login <instance>` on the instance's host).
- **One call at a time per instance**: every `tools/call` is queued per instance URL (`normalizeEndpointUrl`), so browser
  calls on one session never overlap; a failed call does not block the queue.
- **DB-configured endpoints**: `McpProviderOptions.resolveEndpoint(accountId)` supplies an endpoint when the account has none
  in `XHS_MCP_ACCOUNTS` (bootstrap: `xhs_accounts.mcp_endpoint_url` + `XHS_MCP_TOKEN`). Env wins. A DB URL equal to another
  account's env instance, an invalid URL or a throwing resolver is an explicit UNAVAILABLE failure.
  `endpointInfo(accountId)` → `{source: 'env' | 'db' | 'none', url}` (never a token).
- `XHS_PROVIDER=mcp` without any env endpoint is valid; capabilities then name the missing endpoint.
- Account-level persistence and console read models live in `src/skills/operations/account-sessions`; operator guide in
  `docs/XHS_LIVE_SETUP.md`; live check `test/live/xhs-live.test.ts`.

## Running xiaohongshu-mcp: one instance per managed account

xiaohongshu-mcp drives a logged-in Xiaohongshu **web** session. The cookies file selects the
session, so each managed account needs its own process with its own port and `COOKIES_PATH`.
Logging the same account into the web anywhere else kicks the session.

```bash
# research instance (public reads; can be a dedicated research account)
COOKIES_PATH=/srv/xhs/research/cookies.json AUTH_TOKEN=$XHS_MCP_TOKEN \
  ./xiaohongshu-mcp -port :18060 -headless=true

# one instance per dealer account (fixture canon ids shown)
COOKIES_PATH=/srv/xhs/xhs-hz-official/cookies.json   AUTH_TOKEN=$XHS_MCP_TOKEN ./xiaohongshu-mcp -port :18061 -headless=true
COOKIES_PATH=/srv/xhs/xhs-hz-sales-wang/cookies.json AUTH_TOKEN=$XHS_MCP_TOKEN ./xiaohongshu-mcp -port :18062 -headless=true
COOKIES_PATH=/srv/xhs/xhs-hz-sales-li/cookies.json   AUTH_TOKEN=$XHS_MCP_TOKEN ./xiaohongshu-mcp -port :18063 -headless=true
COOKIES_PATH=/srv/xhs/xhs-hz-i3/cookies.json         AUTH_TOKEN=$XHS_MCP_TOKEN ./xiaohongshu-mcp -port :18064 -headless=true
COOKIES_PATH=/srv/xhs/xhs-hz-guide/cookies.json      AUTH_TOKEN=$XHS_MCP_TOKEN ./xiaohongshu-mcp -port :18065 -headless=true
```

- **Endpoint**: `http://<host>:<port>/mcp` (streamable HTTP, stateless, plain JSON). `/health` is the liveness probe.
- **Auth**: `AUTH_TOKEN` (or `-token`) makes the server require `Authorization: Bearer <token>`. The client sends it when a token is configured.
- **Login**: Xiaohongshu rejects QR logins scanned from the instance's headless browser (`get_login_qrcode`), and
  upstream's `cmd/login` panics after the scan before saving cookies. Use `scripts/xhs-mcp-fleet.sh login <instance>` (or
  the console's 登录窗口 button): `tools/xhs-visible-login` opens a visible window with the instance's browser and
  fingerprint seed and writes its `COOKIES_PATH`; the instance uses it on the next call. Re-check capabilities afterwards.
- **Throughput**: every tool call launches a headless browser. Calls are slow, so the default
  timeout is 120 s. The provider runs one call per instance at a time.
- Keep the instances on a private network. They hold live account sessions.

## Configuration

`createXhsProvider(clock, cfg)` accepts:

```ts
type XhsProviderConfig =
  | { kind: 'none' }
  | { kind: 'simulation'; corpus_path: string; options?: SimulationOptions }
  | { kind: 'mcp'; mcp: McpProviderConfig; resolveAccount?: (internalAccountId) => platformAccountId | null };
```

The bootstrap passes a `resolveAccount` DB lookup (`xhs_accounts.id → platform_account_id`) so
skills can pass internal account ids. Endpoints are keyed by **platform account id**.

`xhsProviderConfigFromEnv(process.env)` reads:

| variable | meaning |
|---|---|
| `XHS_PROVIDER` | `none` (default) · `simulation` · `mcp` |
| `XHS_SIM_CORPUS` | corpus path (default `fixtures/xhs/simulation-corpus.json`) |
| `XHS_SIM_SEND_MESSAGES` / `XHS_SIM_RECEIVE_MESSAGES` / `XHS_SIM_PUBLISH` / `XHS_SIM_REPLY_COMMENTS` | booleans enabling simulated write-like capabilities |
| `XHS_SIM_AUTH_REQUIRED_ACCOUNTS` | comma list of account ids reported REQUIRES_AUTH |
| `XHS_SIM_REBASE_TO_NOW` | shift corpus timestamps so the newest is now − 1 h (computed at startup) |
| `XHS_SIM_ID_NAMESPACE` | inserted into generated ids (`sim-msg-<ns>-<n>`). Set it when a demo reuses a persistent database |
| `XHS_MCP_ACCOUNTS` | `xhs-hz-official=http://10.0.0.5:18061/mcp,xhs-hz-i3=http://10.0.0.5:18064/mcp` or JSON `{"xhs-hz-i3":{"url":"…","token":"…"}}`. Optional (v3): accounts without an entry use `xhs_accounts.mcp_endpoint_url` via `resolveEndpoint`; env entries win |
| `XHS_MCP_TOKEN` | default bearer token for account endpoints |
| `XHS_MCP_RESEARCH_URL` / `XHS_MCP_RESEARCH_TOKEN` | research endpoint for public reads |
| `XHS_MCP_TIMEOUT_MS` | per-call timeout (default 120000) |
| `XHS_MCP_ENABLE_DM_TOOLS` | accepted, but DM-like tools still only reach REQUIRES_REVIEW |
| `XHS_LOGIN_HELPER` / `XHS_MCP_DATA_DIR` | together: login window for instances on this host (helper built by `scripts/xhs-mcp-fleet.sh build-login-helper`; state dir `<dir>/<instance>/cookies.json`) |
| `XHS_DM_SENDER` (+ `XHS_MCP_DATA_DIR`, optional `XHS_DM_SEND_TIMEOUT_MS`) | opt-in DM sending: `send_messages` becomes AVAILABLE for accounts whose instance runs on this host, and `sendMessage` drives `tools/xhs-dm-send` on that account's `cookies.json`. SENT only with the message read back in the conversation; an unknown outcome is REQUIRES_REVIEW and never retried; a DM-like tool on the instance still forces REQUIRES_REVIEW. Unset = no DM is ever sent |
| `XHS_MCP_BIN` (+ `XHS_MCP_DATA_DIR`, `XHS_MCP_TOKEN`, optional `XHS_MCP_BIND` / `XHS_MCP_BASE_PORT`) | this host runs the instances: `auth.localInstance.start(accountId)` gives a new account its own instance (own port above the base port, own `cookies.json`, detached, `AUTH_TOKEN` = `XHS_MCP_TOKEN`). Loopback only; env-pinned accounts (`XHS_MCP_ACCOUNTS`) and accounts whose instance process is alive are refused instead of duplicated |

Endpoint selection: account-specific calls (publish, engagement, comment reply) use that account's
instance. Without one they return UNAVAILABLE `no xiaohongshu-mcp endpoint configured for this
account`. Public reads use the account's instance when an account id is given and configured,
otherwise the research endpoint, otherwise any configured account instance.

## Payload notes (xiaohongshu-mcp)

- `search_feeds {keyword, filters{sort_by: 综合|最新|最多点赞, publish_time: 一天内|一周内|半年内|不限}}` returns feeds with
  **no timestamp or description**, so `published_at` is normally null. `published_within_days` is sent as
  the coarse server filter. When a feed does carry a time, the exact window is also applied client-side.
  Non-`note` `modelType` entries are skipped. Counts such as `"1.2万"` are parsed to numbers.
- `get_feed_detail {feed_id, xsec_token, load_all_comments, limit, click_more_replies, reply_limit}`.
  Note `time` and comment `createTime` are epoch ms and are converted to ISO. With `include_replies`,
  sub-comments are flattened and carry `parent_comment_id`. That is the comment they actually reply to
  (`targetComment.id`) when present, otherwise their root comment.
- `user_profile {user_id, xsec_token}`: followers come from `interactions[type='fans']`. `note_count` is unknown (null).
- `publish_content {title, content, images, tags}` confirms success in text only, so the provider
  returns `{platform_note_id: null, url: null}`. The note id must be reconciled later, for example by
  matching titles in `get_my_profile`, or a human records it with `markPublishedManually`.
- `reply_comment_in_feed` returns no id. The provider returns a local reference `xhs-mcp-reply:<comment_id>:<ms>`.
- `delete_cookies {}` logs the instance out. The provider drops its login / tool / pending-login caches for that
  endpoint afterwards, whatever the tool answered. A logged-out instance then reports 未登录 **and** stops returning an
  own profile — both are needed, since a logged-out report alone is only trusted when `get_my_profile` agrees.
- `get_unread_count {}` → `{mentions, likes, connections, unread}`; it does **not** clear the badges.
- `list_notifications {tab: mentions|likes|connections, limit}` → `{tab, filtered, items[]}`. It **does** clear that
  tab's unread badge (same as opening the page in the app), so counts are always read first. Each item carries
  `id`, `type` (`comment/item`, `liked/item`, `faved/item`, `follow/you`, …), `title` (the platform's own wording),
  `time` (epoch **seconds**), `from{user_id, nickname, xsec_token}`, `liked`, and for comments `comment_id` /
  `comment_text`, for note-bound events `feed_id` / `feed_xsec_token` / `feed_title`. No avatar. `filtered` counts
  entries the platform hid (deleted comment, note under review) and is carried through, never swallowed.
- `reply_notification {comment_id, content}` and `like_notification {comment_id, unlike}` confirm by returning the
  JSON record of what they did (no 成功 text) — the provider's `write_json` call mode. The reply's local reference is
  `xhs-mcp-notify-reply:<comment_id>:<ms>`.
- URLs: `https://www.xiaohongshu.com/explore/<id>?xsec_token=<token>` and `https://www.xiaohongshu.com/user/profile/<id>`.

## The DM limitation and the manual-send workflow

No open-source integration can send or read Xiaohongshu DMs, and there is **no authorized API to
DM arbitrary users**. Official DM access covers only **inbound** conversations, through 私信通 or
approved 三方客服 vendors (蓝V + 聚光). The system therefore works like this:

1. Outreach is generated from real lead evidence and passes the pre-send guards.
2. The `provider_capability` guard sees `send_messages` ≠ AVAILABLE, so the outreach becomes
   **READY_FOR_REVIEW**. It is never marked SENT without a provider-confirmed message id.
3. A salesperson opens the lead card, copies the approved message and sends it by hand in the
   owning account's Xiaohongshu app. Only the assigned account may do this.
4. The salesperson clicks "已手动发送", which records `SENT_MANUALLY` after the blocking guards are
   re-checked. The lead moves to CONTACTED.
5. The user's replies are entered through the manual inbound path
   (`processInboundMessage(..., source: 'manual')`). Leads marked in 聚光 arrive through the webhook below.

In demos, `SimulationXhsProvider.recordManualContact(accountId, platformUserId)` records step 4,
and the scripted inbox (`receive_messages: true`) then releases that user's replies after their
`delay_minutes`.

## Simulation behaviour notes

- **Search**: the query is normalized (NFKC full-width → half-width, lower-case, emoji stripped). It is
  then split into token groups: maximal CJK runs and maximal Latin/digit runs, with comparison connectors
  (还是/和/与/对比/或者, vs/pk/or) removed. For example `杭州i3落地` → `杭州 · i3 · 落地` and `3系还是C级` → `3 · 系 · c · 级`.
  A note matches when one of its `keywords` equals the whole query, or when every group appears in its
  title, tags, keywords or content. `simulationQueryGroups(query)` exposes the tokenizer.
- **Scripted inbox routing**: a script with `to_account_platform_id` goes to that account (internal ids
  are resolved through `account_platform_ids`), provided that account contacted the user. A `null`-target
  script goes **only to the account that contacted the user first**. The deterministic ids
  `sim-in-<user>-<index>` are therefore never delivered to two accounts, and
  `conversation_messages.provider_message_id` is globally unique. Several scripts for one account are
  released in order (`sent_at = max(previous, contact + delay)`).
- Content with a timestamp later than `clock.now()` is invisible. That covers search, detail, comments and
  profiles, and replies to such comments are refused.
- Corpus validation rejects duplicate note/comment/profile ids, unknown `recent_note_ids`, and parent
  references on top-level comments or ones pointing outside the comment's own thread.

## 聚光 私信API对接 lead webhook

`parseJuguangLeadPush(body)` accepts a single object, an array, a JSON string, or nested envelopes such
as `{data: [...]}` or `{code, data: {list: [...]}}`. The field keys are **unverified**, so Chinese labels
and snake/camel variants are all accepted:
小红书号|red_id|user_id, 用户昵称|nickname, 省份|province, 城市|city, 线索标签|tags, 电话|phone,
微信|wechat, 备注|remark, 笔记链接|note_url (the note id is parsed from it), 广告计划ID|campaign_id,
单元ID|unit_id, 创意ID|creative_id, 私信接收人|receiver, 操作类型|operation, 时间|time|push_time.
- `platform_user_id` is the user id when one is present, otherwise the 小红书号. `red_id` always carries the
  小红书号 separately.
- Person fields (identity, nickname, contact, region, tags, remark) come only from the record itself or
  from a nested person container (`user`, `user_info`, `lead`, `customer`, …). They never come from nested
  `note` / `author` / `receiver` / ad objects, so a note author or the receiving account is never mistaken for the lead.
- Times: epoch seconds, ms or µs; compact `yyyyMMdd[HHmm[ss]]`; `YYYY-MM-DD HH:mm[:ss[.SSS]]`,
  `YYYY/MM/DD` and `YYYY年M月D日 HH:mm`, all read as Asia/Shanghai; and ISO with an explicit offset.
  Impossible dates and zone-less free text give `occurred_at: null`, because their meaning would depend on
  the server's timezone.

It throws `ValidationError` when no usable lead is present. `parseJuguangLeadPushDetailed` also returns the reasons for
rejected items. Reply HTTP 200 only after the leads are persisted, because the push is considered
delivered on 200. Phone and WeChat here were **voluntarily provided** by the user (留资卡) and may
be stored on the CRM lead.

## Compliance notes

- **No 引流 in messages**: since 2025-01-07, 专业号 messages must not contain phone numbers, WeChat
  ids, QQ or external links (the `platform_rules` guard blocks them). Use 名片 / 留资卡 for contact
  exchange.
- Respect the platform rules and each user's wishes. Negative replies ("不需要，别再发了") suppress
  the user across every managed account. There is no mass messaging and no near-duplicate templates.
- **No anti-detection**: this system does not configure proxies, fingerprint seeds, captcha solving or
  any evasion, even though xiaohongshu-mcp has options for some of them. Web publishing can be blocked
  by risk control. When that happens the provider surfaces the failure and a human decides.
- Public data only: search results, public notes, public comments and profiles reachable with the
  token observed alongside them.
- The simulation provider is labelled `mode: 'simulation'` in every capability report. Its corpus is
  synthetic and is for tests and demos only.

## Tests

```bash
node --test test/unit/providers/xhs-simulation.test.ts test/unit/providers/xhs-mcp.test.ts test/unit/providers/juguang-webhook.test.ts
```

The MCP tests run against an in-test fake `fetch` that implements JSON-RPC (tools/list,
check_login_status logged in or out, search_feeds, get_feed_detail, user_profile, publish_content,
get_my_profile, reply_comment_in_feed). They also cover SSE responses, stateless servers, expired
sessions, timeouts and network failures. On top of that they check write-outcome classification: echoed
content, unconfirmed text, and timeouts, socket resets and 5xx after dispatch versus failures before
dispatch. The remaining cases are duplicate endpoint rejection, snake_case DM tools, throwing account
resolvers and exact recency filtering.
