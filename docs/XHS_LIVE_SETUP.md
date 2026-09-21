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

### Adding an account later, without a terminal

When the console runs on the same host as the instances, give it the binary and the state dir and it starts a new
account's instance itself:

```bash
XHS_MCP_BIN=/opt/xhs/xiaohongshu-mcp   # the same binary the fleet script uses
XHS_MCP_DATA_DIR=/srv/xhs-mcp          # the same state dir
XHS_MCP_TOKEN=<token>                  # AUTH_TOKEN of every instance
# optional: XHS_MCP_BIND=127.0.0.1, XHS_MCP_BASE_PORT=18060
```

Then 账号 → 添加账号 (leave 实例地址 empty) → **启动本机实例** on the new card: the console takes the first free port
above `XHS_MCP_BASE_PORT`, starts the instance with its own `cookies.json` under `<XHS_MCP_DATA_DIR>/<账号标识>/`, waits
for its `/health`, and saves the address on the account. Then **扫码登录（登录窗口）** as in §3 — the instance is logged
out until that account scans, and the console keeps showing 登录未检测 until a probe confirms it. An instance that is
already running is reused, never duplicated; accounts pinned by `XHS_MCP_ACCOUNTS` and hosts without `XHS_MCP_BIN`
(systemd slots, Docker, another machine) keep using `scripts/xhs-mcp-fleet.sh` and the 实例地址 field. The macOS app
sets these three variables automatically when it finds the binary at `~/xhs-mcp-src/bin/xiaohongshu-mcp` or
`/opt/xhs/xiaohongshu-mcp`.

## 2b. Sending private messages (optional, off by default)

Checked against the official docs: the **私信 / IM API is open only to approved third-party 客服服务商**, the **聚光
Marketing API** has ads, reports and 客资 but no message sending, the **千帆 / 电商** platform is shop-scoped, and
**pro.xiaohongshu.com** requires its own login (it does not share the instance's session). A store that is not an IM
vendor therefore has one channel it can operate itself: the account's own logged-in session — the same one that
already publishes notes and replies to comments.

```bash
go build -o "$XHS_MCP_DATA_DIR/.bin/xhs-dm-send" ./cmd/xhs-dm-send   # built from tools/xhs-dm-send in this repo
XHS_DM_SENDER="$XHS_MCP_DATA_DIR/.bin/xhs-dm-send"                   # + XHS_MCP_DATA_DIR; optional XHS_DM_SEND_TIMEOUT_MS
```

Check one conversation first — this types nothing and sends nothing:

```bash
COOKIES_PATH=<instance dir>/cookies.json "$XHS_MCP_DATA_DIR/.bin/xhs-dm-send" -profile <lead profile url> -dry-run -shot /tmp/dm
```

With `XHS_DM_SENDER` set, 私信 on a lead shows 「通过平台发送」 for an approved draft on an account whose instance runs
on this host. An outreach becomes `SENT` only when the helper read the message back in the conversation; when the
outcome cannot be established the console says so, removes the send button for that message and asks a human to check
Xiaohongshu and then register or cancel it — it is never sent a second time automatically. The ten pre-send guards,
the per-account daily limit and the approval policy are unchanged.

**This automates your own account, which Xiaohongshu's terms do not allow, and carries rate-limit / ban risk.** Start
on an account you can afford to lose, keep `daily_outreach_limit` low for the first days, and watch the account's
health and login state.

## 3. Log every instance in (QR code, in a visible login window)

**Xiaohongshu rejects QR logins scanned from the instance's headless browser**: the phone shows "fail to login" and the
instance never sees the scan (observed 2026-09-19 with the current upstream build, with and without console polling).
Upstream's own login tool (`cmd/login`) therefore opens a visible window, but it waits on one page element with
`MustElement` and panics (`Session with given id not found`) when the page target changes right after the scan, before
it saves the cookies. This repo ships a replacement, `tools/xhs-visible-login`: same browser binary and fingerprint seed as
the instance (it is built against your xiaohongshu-mcp checkout), cookies watched at the browser level, success reported
only after a fresh page sees the logged-in session. It writes the instance's `cookies.json`; the running instance loads it
on its next call, so no restart is needed.

Build it once (needs Go; `XHS_MCP_SRC` = the xiaohongshu-mcp source the instances were built from):

```bash
XHS_MCP_SRC=/opt/xhs/xiaohongshu-mcp scripts/xhs-mcp-fleet.sh build-login-helper   # → $XHS_MCP_DATA_DIR/.bin/xhs-visible-login
```

Then log each instance in **on the host where it runs** (it needs a display):

- **Console (instances on the console's own host)**: set `XHS_LOGIN_HELPER=<built helper>` and
  `XHS_MCP_DATA_DIR=<the fleet state dir>` for the console. 账号 → the account card → **扫码登录（登录窗口）** (or
  **研究实例扫码登录（登录窗口）**) opens a Chromium window on that host; scan the QR code in it with the Xiaohongshu app
  **of that account** and leave the window open until it closes itself. The console polls the job (one request at a
  time) and re-checks the login when it finishes. Instance names are the directory names under the state dir:
  `research`, or the account's 账号标识 (platform_account_id), exactly as `scripts/xhs-mcp-fleet.sh start` creates them.
- **Terminal / other hosts**: `scripts/xhs-mcp-fleet.sh login <research|账号标识>` does the same. A server without a
  display cannot open the window: log in on a Mac with the same helper and copy that `cookies.json` into the server
  instance's directory (`chmod 600`).
- The in-console QR code (**二维码（备用）**, `get_login_qrcode` on the headless instance) is kept as a fallback; its modal
  says what to do when the phone reports a failed login. Requesting a new QR code cancels the previous pending one.

After logging in, click **检测登录** (`syncAccountAuth`). It calls `check_login_status` and `get_my_profile`, stores
`auth_state`, `auth_checked_at`, `auth_detail` and — the first time — the verified Xiaohongshu user id
(`platform_user_id`, read from the author of the account's own notes; accounts without any note show "用户ID未能校验").
If a later check finds a different user id, or a user id already bound to another managed account, the account turns
`requires_auth` with `登录的小红书账号与该账号记录不一致` — log in again with the right account.

While a QR code or login window is pending, status checks skip `get_my_profile` (on a logged-out instance it hangs for
60 s); concurrent checks of one instance share a single probe.

The research instance can be logged in with a dedicated research account (`startAccountLogin(ctx, null, actor)` /
`startLoginWindow(ctx, null, actor)`).

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

- **Throughput**: every tool call launches a headless browser (5–60 s). The provider queues tool calls per instance so
  they never overlap (overlapping calls pile up browsers on one session, and upstream leaks the browser of a call that
  panics); the default per-call timeout is 120 s (`XHS_MCP_TIMEOUT_MS`).
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
