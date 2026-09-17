# Live Xiaohongshu setup (xiaohongshu-mcp)

This system reads REAL public Xiaohongshu content through [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp),
which drives a logged-in Xiaohongshu **web** session in a headless browser. There is no official public API for search,
notes or comments. Nothing in production falls back to simulated data: an instance that is down, logged out or logged into
the wrong account is shown as such (UNAVAILABLE / REQUIRES_AUTH) in the console and in every workflow step.

## 1. Build the upstream server

```bash
git clone --depth 1 https://github.com/xpzouying/xiaohongshu-mcp.git
cd xiaohongshu-mcp && go build -o xiaohongshu-mcp .
```

On first start the binary downloads its bundled Chromium (148.x, ~150–190 MB) — see the caveats in §7.

## 2. One instance per managed account

Each managed account needs its **own** process, port and `COOKIES_PATH` (the cookies file *is* the session). Two accounts
sharing an instance would act in each other's session; the provider refuses such configurations. Logging the same
Xiaohongshu account into the web anywhere else ends that instance's session.

```bash
export XHS_MCP_BIN=/opt/xhs/xiaohongshu-mcp XHS_MCP_DATA_DIR=/srv/xhs-mcp XHS_MCP_TOKEN="$(openssl rand -hex 24)"
scripts/xhs-mcp-fleet.sh start <账号标识1> <账号标识2> …   # the 账号标识 (platform_account_id) of each account you added
scripts/xhs-mcp-fleet.sh status
```

The script starts a `research` instance (public reads) on `XHS_MCP_BASE_PORT` (18060) and one instance per account on the
following ports, bound to `127.0.0.1`, each requiring `AUTH_TOKEN`, with `chmod 700` state directories. It explicitly unsets
`XHS_PROXY` and `XHS_FP_SEED`. It prints the operator configuration:

```
XHS_PROVIDER=mcp
XHS_MCP_RESEARCH_URL=http://127.0.0.1:18060/mcp
XHS_MCP_ACCOUNTS=<账号标识1>=http://127.0.0.1:18061/mcp,…   # env endpoints win
XHS_MCP_TOKEN=<token>
```

Alternatively leave `XHS_MCP_ACCOUNTS` empty and bind endpoints per account in the console (账号 → 实例地址), stored in
`xhs_accounts.mcp_endpoint_url` (unique; URLs with embedded credentials are rejected — tokens only via env).

## 3. Log every instance in (QR code)

1. Console → 账号 → the account card → **扫码登录**. The server calls `get_login_qrcode` on *that account's* instance (never
   on another one) and shows the QR code; it is never stored or logged.
2. Scan within ~4 minutes with the Xiaohongshu app **of that account**. Requesting a new QR code cancels the previous pending one.
3. Click **检测登录** (`syncAccountAuth`). It calls `check_login_status` and `get_my_profile`, stores `auth_state`,
   `auth_checked_at`, `auth_detail` and — the first time — the verified Xiaohongshu user id (`platform_user_id`, read from the
   author of the account's own notes; accounts without any note show "用户ID未能校验").
4. If a later check finds a different user id, or a user id already bound to another managed account, the account turns
   `requires_auth` with `登录的小红书账号与该账号记录不一致` — log in again with the right account.

The research instance can be logged in with a dedicated research account (`startAccountLogin(ctx, null, actor)`).

## 4. Verify the real path

```bash
XHS_LIVE_MCP_URL=http://127.0.0.1:18060/mcp XHS_LIVE_MCP_TOKEN_FILE=/srv/xhs-mcp/token node --test test/live/xhs-live.test.ts
```

- Logged out: asserts `search_public_content` is REQUIRES_AUTH and `searchNotes` fails with REQUIRES_AUTH.
- Logged in: runs a real search (`XHS_LIVE_QUERY`, default 买车 — set it to your own model), reads the first note and its comments, asserts real note
  ids, `https://www.xiaohongshu.com/explore/<id>?xsec_token=…` URLs and comment authors, and prints them.

## 5. Why "logged out" needs special handling

A logged-out xiaohongshu-mcp does not answer read tools with a login error (captured from a real instance,
`test/unit/providers/fixtures/xhs-mcp-logged-out.json`):

| tool | logged-out result |
|---|---|
| `search_feeds` | tool error `context deadline exceeded` after 60 s |
| `get_feed_detail` | tool error `笔记不可访问: 当前笔记暂时无法浏览` |
| `user_profile` | **success** with an all-empty `userBasicInfo` |
| `get_my_profile` | tool error `context deadline exceeded` |

The provider therefore checks `check_login_status` before read tools (cached ≤ 60 s per instance, dropped on any login text
or new QR request) and re-verifies the session whenever a read fails or comes back empty. Logged out → REQUIRES_AUTH, so
discovery shows "需要登录" instead of "0 posts found".

## 6. Operations

- **Throughput**: every tool call launches a headless browser (5–60 s). Run one call per instance at a time; the default
  per-call timeout is 120 s (`XHS_MCP_TIMEOUT_MS`).
- **Security**: the instances hold live account sessions. Keep them on localhost or a private network behind a firewall,
  always set `AUTH_TOKEN`, keep cookie files `600` / directories `700`, never expose `/mcp` publicly, never commit cookies.
- **Health**: `scripts/xhs-mcp-fleet.sh status`; the console's 系统 page shows per-capability snapshots.
- **Session loss**: sessions expire or are kicked when the same account logs in elsewhere on the web; the next check
  marks the account `requires_auth` and workflows skip steps that need it.

## 7. Honest limitations and caveats

- **DMs are not available.** No authorized API sends or reads Xiaohongshu DMs; xiaohongshu-mcp has no DM tool. Outreach
  stays `READY_FOR_REVIEW`: a salesperson copies the approved message, sends it in the owning account's app, then clicks
  "已在小红书发送" (`SENT_MANUALLY`, `sent_by`). Leads marked in 聚光 arrive through the 私信API对接 webhook.
- **Publishing** (`publish_content`) needs at least one image and returns no note id; the note id must be reconciled
  (`markPublishedManually`) and web publishing can be blocked by risk control.
- **Upstream browser fingerprinting**: current upstream builds download their bundled Chromium from `cdn.one-world.ai`
  and enable fingerprint flags by default (log lines `fingerprint enabled`, `fingerprint seed pinned`). This system does not
  configure proxies or fingerprint seeds and does not rely on evasion; review the upstream behaviour and your platform
  obligations before running it, and pin/verify the upstream version you deploy (the download is a third-party binary).
- **Public data only**: search results, public notes, public comments and profiles reachable with the observed `xsec_token`.
  Respect the platform rules; negative replies suppress the user across all managed accounts.
