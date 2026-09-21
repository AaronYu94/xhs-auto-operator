# Deployment guide

AI 汽车运营官 is one Node.js process (console + JSON API + scheduler, SQLite) plus **one xiaohongshu-mcp instance per
managed Xiaohongshu account** (and one research instance for public search). Nothing in `src/` hard-codes a dealer:
you import your own Dealer Brain, point each account at its own session, scan the QR codes, and start.

```
          operators (browser, TLS)                 聚光 lead push (optional)
                   │                                        │
            reverse proxy (TLS) ──────────────► app :8080  (/webhooks/juguang?token=…)
                                                 │  SQLite (WAL) on a persistent volume
                                                 │  scheduler (daily workflows per dealer)
                  private network ───────────────┤
                                                 ├─► xhs-mcp-research   :18060  (public search / notes / comments)
                                                 ├─► xhs-mcp-account-1  :18060  (account 1 session: cookies-1)
                                                 ├─► …                            one instance per account
                                                 └─► xhs-mcp-account-N  :18060
                                                           │ outbound HTTPS
                                                      www.xiaohongshu.com
```

## 1. Requirements

| component | requirement |
|---|---|
| app | Node.js **≥ 24** (native TypeScript type stripping, `node:sqlite`). No runtime npm dependencies. ~200 MB RAM. |
| database | SQLite file on persistent storage (WAL mode). One writer process. |
| xiaohongshu-mcp | [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) — Docker image or `go build` (Go ≥ 1.24). Each instance drives a headless Chromium: plan ~300–500 MB RAM per instance; tool calls are slow (seconds) and serialized per instance. |
| accounts | Each managed account must be logged in on **its own** instance by scanning a QR code with that account's Xiaohongshu app. |
| optional | `ANTHROPIC_API_KEY` for LLM refinement (deterministic engines are complete without it); 聚光 (蓝V) for the lead push webhook. |

## 2. Configuration

All configuration is environment variables (see `.env.example`). `node src/cli.ts doctor` validates everything and
lists every problem at once. Secrets are redacted in logs (`redactConfig`).

| variable | production | meaning |
|---|---|---|
| `APP_ENV` | `production` | `production` refuses simulation data, requires console secrets and a persistent DB |
| `HOST` / `PORT` | | listen address (default `0.0.0.0:8080`) |
| `DATABASE_PATH` | **required** (not `:memory:`) | SQLite file, e.g. `/data/xhs-operator.db` |
| `DATA_DIR` | | runtime data directory (default: DB directory) |
| `LOG_LEVEL` | | `debug|info|warn|error|silent` (JSON lines on stderr) |
| `CONSOLE_PASSWORD` | **required** (≥ 8 chars) | shared console password; operators also enter their name (audit actor). A name with a personal account (`node src/cli.ts user add <姓名>`, password read from stdin or `CONSOLE_USER_PASSWORD`, stored as a scrypt hash) signs in only with its own password |
| `SESSION_SECRET` | **required** (≥ 32 chars) | HMAC key for session cookies — `openssl rand -hex 32` |
| `PUBLIC_BASE_URL` | recommended | external `https://` URL; enables `Secure` cookies |
| `COOKIE_SECURE` | | force `Secure` cookies (default: on in production when `PUBLIC_BASE_URL` is https) |
| `TRUST_PROXY` | behind a local reverse proxy | take the client address (login rate limiting) from `X-Forwarded-For` when the peer is loopback |
| `SCHEDULER_ENABLED` | `true` on exactly one process | daily workflows in each dealer's timezone |
| `SCHEDULER_INTERVAL_MS` | | tick interval (default 60000) |
| `XHS_PROVIDER` | `mcp` | `mcp` (live), `none` (no Xiaohongshu access), `simulation` (dev/test only — refused in production) |
| `XHS_MCP_RESEARCH_URL` | recommended | research instance, e.g. `http://xhs-mcp-research:18060/mcp` |
| `XHS_MCP_RESEARCH_TOKEN` | | bearer token of the research instance (default `XHS_MCP_TOKEN`) |
| `XHS_MCP_ACCOUNTS` | per account | `platform_account_id=url,…` or JSON `{"id":{"url":"…","token":"…"}}` — env wins over endpoints saved on the 账号 page |
| `XHS_MCP_TOKEN` | **required with mcp** | default bearer token (`AUTH_TOKEN` of each instance) |
| `XHS_MCP_TIMEOUT_MS` | | per tool call (default 120000) |
| `ANTHROPIC_API_KEY`, `LLM_MODEL`, `ANTHROPIC_BASE_URL` | optional | LLM refinement (output is always validated against evidence and Dealer Brain) |
| `JUGUANG_WEBHOOK_TOKEN` | optional (≥ 16 chars) | enables `POST /webhooks/juguang?token=…` |
| `JUGUANG_DEFAULT_DEALER_ID` | with webhook | dealer receiving pushed leads |

Account endpoints may also be saved per account in the console (账号 → 保存实例地址, stored as
`xhs_accounts.mcp_endpoint_url`, unique per account); tokens are never stored in the database.

## 3. First run (bare metal / VM)

```bash
git clone … && cd 小红书获客系统
npm ci                                   # dev tooling only (typescript); runtime has no dependencies
npm run build                            # typecheck + unit tests + build check
cp .env.example .env && chmod 600 .env   # fill CONSOLE_PASSWORD, SESSION_SECRET, XHS_MCP_TOKEN, …
set -a && . ./.env && set +a

node src/cli.ts migrate                                  # creates/updates the SQLite schema (also automatic on start)
```

**Your own dealer data.** Nothing is pre-filled — no brand, city, model or account is assumed. After `npm start`, open
the console: **设置** → store name, brands, city (province is inferred when possible), optional phone / hours / address,
then the models you sell (brand, model, trim, model year, MSRP); **账号** → add each of your own Xiaohongshu accounts
(nickname, type, its xiaohongshu-mcp instance URL) and log it in with **扫码登录**.

For bulk migration you can import a Dealer Brain bundle instead:

```bash
node src/cli.ts dealer import ./my-dealer-brain.json --dry-run
node src/cli.ts dealer import ./my-dealer-brain.json     # prints dealer ids and account ids
```

**Dealer Brain bundle.** One JSON file per dealer group: `group`, `dealers` (address, hours, brands, settings),
`vehicles` (MSRP, specs, highlights, aliases), `inventory` (VIN, colours, status, quantity, list price), `offers`
(amount/APR/term/down payment, conditions, validity), `knowledge` (brand guidelines, prohibited claims, stores,
salespeople, campaigns, FAQ, policies) and `accounts` (≥ 5 per dealer, each with a distinct persona). The schema and
cross-references are validated on import (`fixtures/dealers/hangzhou-bmw-group.json` is a complete, **fictional**
example). Imports are idempotent upserts keyed by your natural keys; inventory defaults to **snapshot** mode (stock
missing from the file is set to 0 so sold cars are never offered). Re-import the same file with updated prices/stock
to update. `dealer export` produces a backup snapshot keyed by database ids (for restoring into a fresh instance).

**Start one xiaohongshu-mcp instance per account** (never share an instance between accounts — actions would run
in the wrong account's session):

```bash
# build once: git clone https://github.com/xpzouying/xiaohongshu-mcp && cd xiaohongshu-mcp && go build -o xiaohongshu-mcp .
export XHS_MCP_TOKEN=$(openssl rand -hex 24)
mkdir -p /srv/xhs/{research,acc-official,acc-sales-1} && chmod 700 /srv/xhs
COOKIES_PATH=/srv/xhs/research/cookies.json    AUTH_TOKEN=$XHS_MCP_TOKEN ./xiaohongshu-mcp -port 127.0.0.1:18060 -headless=true &
COOKIES_PATH=/srv/xhs/acc-official/cookies.json AUTH_TOKEN=$XHS_MCP_TOKEN ./xiaohongshu-mcp -port 127.0.0.1:18061 -headless=true &
COOKIES_PATH=/srv/xhs/acc-sales-1/cookies.json  AUTH_TOKEN=$XHS_MCP_TOKEN ./xiaohongshu-mcp -port 127.0.0.1:18062 -headless=true &
```

Then configure `.env`:

```bash
XHS_PROVIDER=mcp
XHS_MCP_RESEARCH_URL=http://127.0.0.1:18060/mcp
XHS_MCP_ACCOUNTS=acc-official=http://127.0.0.1:18061/mcp,acc-sales-1=http://127.0.0.1:18062/mcp   # keys = platform_account_id
```

```bash
node src/cli.ts doctor            # search will show REQUIRES_AUTH until the QR codes are scanned
npm start                         # = APP_ENV=production node src/cli.ts serve
```

**Log in each session.** Console → 账号 → 扫码登录 (per account) and 研究实例扫码登录. The QR image is shown only in the
dialog (never stored or logged); scan it with that account's own Xiaohongshu app within ~4 minutes. The page polls the
real login state. CLI alternative: `node src/cli.ts xhs-login <account_id|research> --out qr.png` (delete the file
afterwards). Run `node src/cli.ts doctor` again: `xhs.search_public_content` must be `AVAILABLE`.

Goals and manual workflow runs are refused (`409 setup_incomplete`) until the store has at least one active account whose
login a live probe verified. Then submit a goal on 总览 in your own words (e.g. “这个月在〈城市〉获取〈车型〉线索”) and
follow its run under 系统.

## 3a. Scripted bare metal (Ubuntu 24.04 + systemd, no Docker)

For hosts that cannot pull from Docker Hub (e.g. mainland China cloud servers). From your workstation, with an SSH host
alias that logs in as root:

```bash
scripts/deploy.sh setup   <ssh-host>   # once: pinned xiaohongshu-mcp + Chromium + Node 24, users, secrets, systemd units
scripts/deploy.sh release <ssh-host>   # every release: upload source, npm run build on the server, DB backup, restart
```

- `deploy/server/setup.sh` is idempotent. It installs Node.js 24 from the Aliyun mirror (sha256 checked against
  nodejs.org), the xiaohongshu-mcp release binary (pinned sha256; github.com or a download proxy) and its bundled Chromium
  (pinned sha256) read-only under `/opt/xhs-mcp`, adds 4 GB swap, and creates the service users `xhs` (app) and
  `xhsmcp` (instances).
- Instances: `xhs-mcp@research` on `127.0.0.1:18060` and `xhs-mcp@slot1…slotN` on `18061…` (`MCP_SLOTS`, default 5),
  each with its own session in `/var/lib/xhs-mcp/<instance>`. `XHS_MCP_ACCOUNTS` stays empty: bind each account to its
  slot in the console (账号 → 实例地址 `http://127.0.0.1:1806N/mcp`).
- `xhs-operator.service` listens on `127.0.0.1:8080` only; database `/var/lib/xhs-operator/xhs-operator.db`, backups
  (14 newest) in `/var/lib/xhs-operator/backups` before every release.
- Secrets are generated once into `/etc/xhs-operator/app.env` and `mcp.env` and never printed. Read the console password
  on the server: `grep CONSOLE_PASSWORD /etc/xhs-operator/app.env`.
- Open the console through a tunnel: `ssh -N -L 8080:127.0.0.1:8080 <ssh-host>` → http://localhost:8080. Only port 22
  needs to be reachable, restricted to your own address.
- Logs: `journalctl -u xhs-operator -f`, `journalctl -u xhs-mcp@slot1 -f`.

## 3b. Desktop app for store staff (HTTPS on the server IP)

Store staff use the desktop app (`desktop/`, Electron, macOS + Windows): a window onto the cloud console. Nothing runs
or is stored locally besides the session cookie.

```bash
scripts/deploy.sh tls <ssh-host> <public-ip>   # nginx :443 + self-signed cert for the IP; prints url + fingerprint
# open TCP 443 in the cloud security group, then put the printed values into desktop/server.json:
#   { "url": "https://<public-ip>", "fingerprints": ["sha256/…="] }
cd desktop && npm ci && npm run dist:mac && npm run dist:win   # desktop/dist/*.dmg, *.exe
```

- The app accepts the server's certificate **only** when its SHA-256 fingerprint is pinned in `server.json`; every other
  host uses normal certificate verification, and links outside the console open in the system browser.
- `tls.sh` generates the certificate once (5 years) and never replaces it on re-runs. To rotate: ship a desktop build
  pinning both the old and the new fingerprint, then run `tls.sh` with `ROTATE_CERT=1`.
- It sets `PUBLIC_BASE_URL=https://<ip>` (Secure cookies) and `TRUST_PROXY=true` (login rate limiting per client
  address from nginx's `X-Forwarded-For`; only honoured for loopback peers).
- Builds are unsigned: macOS asks to confirm on first open (right-click → 打开), Windows SmartScreen shows “更多信息 →
  仍要运行”. Sign with an Apple Developer ID / Windows code-signing certificate before wide distribution.

## 3c. A domain name (Let's Encrypt)

```bash
scripts/deploy.sh domain <ssh-host> <domain> <email>   # asks before accepting the Let's Encrypt agreement
```

- Preconditions, checked by `deploy/server/domain.sh` rather than assumed: an **A record** for `<domain>` and
  `www.<domain>` pointing at the server, and — on a mainland-China server — an **ICP filing (备案)** for the domain.
  Without the filing the cloud provider intercepts HTTP on the domain, the ACME challenge never reaches nginx, and the
  script stops with that explanation. Filing needs the domain's real-name verification (域名实名认证) first.
- It adds a second nginx site (`xhs-operator-domain`): `:80` answers the ACME challenge and redirects to https,
  `www` redirects to the bare domain, and the bare domain proxies to the app. The IP-address site with its pinned
  self-signed certificate stays the default server, so installed desktop apps keep working.
- Certificates renew through certbot's own timer; a deploy hook reloads nginx. `PUBLIC_BASE_URL` becomes
  `https://<domain>`.
- To move the desktop app to the domain, set `desktop/server.json` `url` to `https://<domain>`: a publicly trusted
  certificate needs no pinned fingerprint.

## 4. Docker Compose

```bash
cp .env.example .env    # set CONSOLE_PASSWORD, SESSION_SECRET, XHS_MCP_TOKEN, PUBLIC_BASE_URL, XHS_MCP_ACCOUNTS
# XHS_MCP_ACCOUNTS=acc-official=http://xhs-mcp-account-1:18060/mcp,acc-sales-1=http://xhs-mcp-account-2:18060/mcp,…
docker compose up -d --build
docker compose cp ./my-dealer-brain.json app:/data/my-dealer-brain.json
docker compose exec app node src/cli.ts dealer import /data/my-dealer-brain.json
docker compose exec app node src/cli.ts doctor
```

- The image's `verify` stage runs typecheck, unit tests and the build check; a failure fails the build.
- The app listens on `127.0.0.1:8080` of the host; MCP instances publish no ports and only join the private
  `backend` network (they still need outbound internet to reach xiaohongshu.com).
- Add or remove `xhs-mcp-account-N` services to match your fleet; each needs its own volume.
- Pin `XHS_MCP_IMAGE` to an exact tag/digest.
- **Not verified in the build environment:** Docker was not installed where this release was built, so the
  Dockerfile and compose file were validated by review only. Run `docker compose config` and a test deployment before
  production.

## 5. Operations

**Health.** `GET /healthz` (liveness, no auth, no I/O beyond the process) and `GET /readyz` (no auth: DB query,
pending migrations, provider mode and capability summary, LLM status; `503` when the DB is not ready). The container
HEALTHCHECK uses `/healthz`.

**Logs.** JSON lines on stderr: `http.request` (method, path without query string, status, ms, actor), workflow
start/step/complete events, `scheduler.tick`, `config.warning`, `xhs.simulation_mode`, errors with stack frames.
Request bodies, tokens, passwords and QR images are never logged.

**Scheduler.** Runs in the `serve` process when `SCHEDULER_ENABLED=true` (or as a separate `node src/cli.ts scheduler`
worker). Enable it on **one** process only. Daily plan per dealer (dealer timezone): refresh 08:00 · research 08:30 ·
planning 09:00 · discovery 09:30 · signal processing hourly · reply processing every 30 min · publishing hourly ·
performance 18:00 · evening analysis & report 20:00. Every run and step is persisted; runs interrupted by a restart are
marked FAILED and can be resumed from 系统 → 自动任务.

**Backups.** Use SQLite's online backup: `sqlite3 /data/xhs-operator.db ".backup '/backup/xhs-$(date +%F).db'"`, or stop
the app and copy the `.db` together with `-wal`/`-shm`. Back up the xiaohongshu-mcp cookie volumes separately if you
want to avoid re-scanning (treat them as credentials). `dealer export` is an additional human-readable backup of
Dealer Brain.

**Upgrades.** Deploy the new version and restart; migrations run automatically at startup (`schema_migrations`
records applied versions; `node src/cli.ts migrate` applies them explicitly). Graceful shutdown on SIGTERM stops the
scheduler, waits for an in-flight tick (≤ 10 s), closes HTTP connections and the database.

**Reverse proxy (TLS).** Example (Caddy): `console.example.com { reverse_proxy 127.0.0.1:8080 }`. nginx: proxy
`/` to `http://127.0.0.1:8080`, set `proxy_read_timeout 180s` (a few live provider actions wait on Xiaohongshu),
`client_max_body_size 2m`. Set `PUBLIC_BASE_URL=https://console.example.com`.

## 6. Security

- Console: name + `CONSOLE_PASSWORD` → HMAC-SHA256 signed, HttpOnly, SameSite=Strict session cookie (12 h), `Secure`
  behind TLS; failed logins are rate-limited per client address. Every state-changing request needs the console's
  `x-console-request: 1` header, a browser-set `Sec-Fetch-Site: same-origin`, or a same-origin `Origin` (CSRF;
  cross-site fetch metadata is always rejected). HTML responses carry a strict CSP and `Referrer-Policy: same-origin`
  (own form posts keep their Origin; outbound links send no referrer); external links (原帖) open with
  `noopener noreferrer`.
- The operator's name is the audit actor on approvals, manual sends (`sent_by`), conversions and Dealer Brain edits.
- xiaohongshu-mcp instances hold live account sessions: private network only, `AUTH_TOKEN` required, cookie
  directories `chmod 700`. The app never stores tokens in the database and never persists QR images.
- The 聚光 webhook is disabled unless `JUGUANG_WEBHOOK_TOKEN` is set; the token is compared in constant time and the
  push is acknowledged with 200 only after the leads are persisted.
- `.env` must not be committed (`.gitignore`/`.dockerignore` exclude it).

## 7. What Xiaohongshu blocks (by design, reported honestly)

| capability | status | what the system does |
|---|---|---|
| Search public notes, read notes/comments/profiles | **Works** through a logged-in xiaohongshu-mcp web session | Shows `REQUIRES_AUTH` / “需要扫码登录” when a session is logged out — never an empty “no results” |
| Send DMs to users | **Blocked** — no authorized API for cold DMs; xiaohongshu-mcp has no DM tool | Outreach is generated, guarded and queued as READY_FOR_REVIEW; the owning account's salesperson copies it, sends it in the app and clicks “我已在小红书发送” (`SENT_MANUALLY`, with `sent_by`). Nothing is marked SENT without a provider message id |
| Read the DM inbox | **Blocked** — official access only via 私信通 / approved 三方客服 vendors (inbound only) | Replies are entered on the lead/对话 page; 聚光 lead pushes arrive via the webhook |
| Publish notes | **Works with limits**: needs ≥ 1 image, returns no note id, web publishing may be stopped by risk control | Posts without images stay READY_TO_PUBLISH; unknown outcomes are REQUIRES_REVIEW (never auto-retried); manual publish is registered with the note URL |
| Reply to comments on our own notes | Works through the owning account's session | Drafts are guarded and reviewed; cold commenting on others' notes is not done |
| View counts | Not exposed | Likes/collects/comments/shares only; views recorded manually if needed |

Session caveats: logging the same account into the Xiaohongshu web elsewhere ends the instance's session; sessions
expire and must be re-scanned; new accounts may be asked for real-name verification. Every tool call drives a headless
browser — keep query volume modest.

**Upstream browser caveat.** Current xiaohongshu-mcp downloads its own Chromium build (from the upstream CDN on first
run or at image build) and enables browser fingerprint flags by default. This system never sets `XHS_PROXY` or
`XHS_FP_SEED` and performs no captcha solving or other evasion, but review the upstream behaviour against your
compliance policy before deploying.

## 8. Verification

```bash
npm run build          # typecheck + unit tests + build check
npm test               # all tests (unit, integration, e2e)
npm run test:e2e       # real server + runtime + SQLite: login, import, goal → leads, manual send, reply, appointment, restart
node src/cli.ts doctor # live: config, DB, provider capabilities per account, LLM, auth, webhook
```

## 9. Troubleshooting

| symptom | cause / fix |
|---|---|
| Banner “需要扫码登录” / doctor `REQUIRES_AUTH` | the instance's session is logged out → 账号 → 扫码登录 |
| `no xiaohongshu-mcp endpoint configured for this account` | add the account to `XHS_MCP_ACCOUNTS` or save its instance URL on 账号 |
| `xiaohongshu-mcp endpoint unreachable` | instance down / wrong URL / network → check the process and `curl http://host:18060/health` |
| `rejected the request … check AUTH_TOKEN` | `XHS_MCP_TOKEN` differs from the instance's `AUTH_TOKEN` |
| startup `配置无效（N 项）` | fix every listed variable (doctor prints the same list) |
| outreach stays “已通过·待人工发送” | expected: DM sending has no authorized API — send in the app and record it |
| posts stay “待人工发布” | add images on the post page, or publish in the app and register the note URL |
| 账号 → 检测全部账号 takes ~5 s per account | expected: every login check drives a headless browser on the instance, and checks are deliberately never reused (a session that just logged in or expired must be seen immediately). Accounts without their own instance each re-check the research instance; give every account its own instance |
