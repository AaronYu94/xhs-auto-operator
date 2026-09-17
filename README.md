# AI 汽车运营官 — Automotive Xiaohongshu AI Operator

An AI operations employee for car dealers running **5+ Xiaohongshu (小红书) accounts**: it finds people who are
actually shopping for a car in public posts and comments, proves why (verbatim evidence), gives each lead to exactly
one account, prepares compliant personalized outreach, handles replies through qualification and appointments, and
runs per-account content operations — all on the dealer's own verified data.

```
dealer goal ─► search queries (from Dealer Brain) ─► public notes + comments (xiaohongshu-mcp)
 ─► cheap prefilter ─► actor classification (BUYER / OWNER / CREATOR / DEALER_OR_SALES / ENTHUSIAST / UNKNOWN)
 ─► intent extraction + evidence-backed score ─► group dedup (1 lead per person) ─► Fleet Controller (1 owner)
 ─► personalized outreach (10 pre-send guards) ─► REVIEW_REQUIRED / manual send ─► replies ─► qualification
 ─► contact + appointment ─► visit ─► WON / LOST ─► analytics & query/content optimization
```

## Real data, stated honestly

| capability | status |
|---|---|
| Public search, notes, comments, profiles | **Live** via [xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp), one logged-in web session per account + a research session. Logged-out sessions surface as `REQUIRES_AUTH` (“需要扫码登录”), never as “no results”. |
| DMs to users (send / inbox) | **Blocked by Xiaohongshu** — no authorized API. Outreach is generated, guarded and queued for review; a salesperson sends it in the app and records it (`SENT_MANUALLY` + `sent_by`). Nothing is ever marked `SENT` without a provider message id. 聚光 lead pushes arrive via webhook. |
| Publishing notes | Live with limits: needs ≥ 1 image, returns no note id; unknown outcomes are never auto-retried. |
| Replies on our own notes | Live through the owning account's session, guarded and reviewed. |

Every lead keeps its exact source (`https://www.xiaohongshu.com/explore/<note>?xsec_token=…`, the verbatim comment)
and a `data_mode` (`live` / `simulation` / `import` / `manual`). `APP_ENV=production` refuses the simulation provider.
Dealer facts (prices, stock, offers, finance, stores) come only from the imported Dealer Brain and every generated
claim is verified against it; the LLM (optional) cannot introduce facts.

## Quick start

Requirements: Node.js ≥ 24 (native TypeScript, `node:sqlite`); no runtime npm dependencies.

```bash
npm ci
npm run build                                   # typecheck + unit tests + build check

# Production-like, real Xiaohongshu data (see docs/XHS_LIVE_SETUP.md for the xiaohongshu-mcp instances)
cp .env.example .env && chmod 600 .env          # CONSOLE_PASSWORD, SESSION_SECRET, XHS_MCP_* …
set -a && . ./.env && set +a
node src/cli.ts doctor                          # shows exactly what is available / blocked
npm start                                       # console on PORT (default 8080)
# then in the console: 设置 → your own store, brands, city and models
#                      账号 → add your own Xiaohongshu accounts → 扫码登录 with each account's app
#                      总览 → 下达经营目标 (refused until at least one account's login is verified)
# (bulk migration alternative: node src/cli.ts dealer import ./your-dealer-brain.json)

# macOS app (runs this project in place): dist/AI汽车运营官.app starts the console (and the local research
# xiaohongshu-mcp instance when installed) and opens it in its own window; closing the window stops what it started.
scripts/macos/build-app.sh && open "dist/AI汽车运营官.app"
# config: ~/Library/Application Support/AI汽车运营官/console.env (generated on first launch, chmod 600)

# Local demo on the labelled simulation corpus (never for production)
APP_ENV=development XHS_PROVIDER=simulation XHS_SIM_REBASE_TO_NOW=true DATABASE_PATH=./data/demo.db \
  node src/cli.ts seed-demo && APP_ENV=development XHS_PROVIDER=simulation XHS_SIM_REBASE_TO_NOW=true \
  DATABASE_PATH=./data/demo.db node src/cli.ts serve
```

Nothing in `src/` hard-codes a dealer, brand, city or account: every store enters its own data in the console (设置 / 账号),
and goals are refused until one of its own accounts is logged in by QR code. `fixtures/dealers/hangzhou-bmw-group.json` is
a **fictional** bundle used only by tests and the development demo.

## Documentation

| document | content |
|---|---|
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | environment, first run, Docker Compose, health checks, backups, upgrades, security, what Xiaohongshu blocks |
| [docs/XHS_LIVE_SETUP.md](docs/XHS_LIVE_SETUP.md) | running one xiaohongshu-mcp instance per account, QR login, caveats |
| [docs/OPERATOR_GUIDE.md](docs/OPERATOR_GUIDE.md) | daily operator workflow (Chinese) |
| [ARCHITECTURE.md](ARCHITECTURE.md) | binding module contracts, scoring calibration, guard pipeline, capability truth table, §10 production contract |
| [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md) · [docs/UI_DESIGN.md](docs/UI_DESIGN.md) | requirements and console design spec |

## Layout

```
src/core src/db src/audit src/app      foundation · SQLite + migrations · config · bootstrap/runtime
src/providers/xhs                      xiaohongshu-mcp live adapter (+ auth/QR), simulation, 聚光 webhook parser
src/providers/llm                      optional Anthropic provider (validated output)
src/domain                             automotive lexicon, dealer profile, actor classification
src/skills/{research,content,acquisition,sales,operations}/<skill>   31 skills, each with SKILL.md
src/operator                           goal parser, planner, workflows, resumable workflow engine, scheduler
src/server src/cli.ts                  console + JSON API + health/readiness + webhook · CLI
test/{unit,integration,e2e,live}       node:test suites (live suite runs only with XHS_LIVE_MCP_URL)
```

## Verification

```bash
npm test                  # unit + integration (incl. test/integration/vertical-slice.test.ts) + e2e
npm run test:e2e          # real HTTP server + runtime + SQLite, restart persistence, production refusals
XHS_LIVE_MCP_URL=http://127.0.0.1:18060/mcp XHS_LIVE_MCP_TOKEN_FILE=… node --test test/live/xhs-live.test.ts
```
