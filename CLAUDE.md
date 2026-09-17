# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AI 汽车运营官: an AI operations employee for car dealers who run 5 or more Xiaohongshu (小红书, "XHS") accounts. It does two jobs: **lead acquisition** (find people shopping for a car in public notes and comments, then assign, reach out, qualify and book appointments) and **content operations** (plan, write, review and publish notes for each account). It uses no runtime npm dependencies. Node ≥ 24 runs the TypeScript directly (type stripping), and `node:sqlite` is the database.

`ARCHITECTURE.md` is the **binding module contract**: signatures, scoring calibration, guard pipeline, capability truth table and the §10 production contract. Read the relevant section before changing a module's public API. A breaking change must update ARCHITECTURE.md and every caller. The UI must follow `docs/UI_DESIGN.md` and `docs/design/ui-reference.png`.

## Commands

```bash
npm run typecheck                      # tsc --noEmit (no emit; nothing is compiled)
npm test                               # unit + integration + e2e
npm run test:unit | test:integration | test:e2e
node --test test/unit/crm/funnel.test.ts          # single test file
node --test --test-name-pattern="<regex>" test/unit/x/y.test.ts
npm run build                          # typecheck + unit tests + `doctor --build-check`
node src/cli.ts doctor [--offline] [--json]       # reports config/DB/provider/login/LLM status
npm run dev                            # console with --watch (APP_ENV=development)
npm run demo                           # simulation provider + fictional demo dealer in ./data/demo.db
npm start                              # APP_ENV=production serve (scheduler runs in-process unless SCHEDULER_ENABLED=false)
npm run scheduler                      # scheduler-only worker process, no HTTP
```

There is no linter; `typecheck` + tests are the gate. Config is env-only (`src/app/config.ts`, template in `.env.example`); load it with `set -a && . ./.env && set +a`. `dist/` only holds the built macOS `.app` bundles.

Live XHS test (`npm test`'s glob includes it, but it skips itself unless this env var is set): `XHS_LIVE_MCP_URL=http://127.0.0.1:18060/mcp XHS_LIVE_MCP_TOKEN_FILE=… node --test test/live/xhs-live.test.ts`.
Run one xiaohongshu-mcp instance for each account: `scripts/xhs-mcp-fleet.sh start|status|stop`. The macOS app is built with `scripts/macos/build-app.sh`. Server deploy without Docker (Ubuntu + systemd): `scripts/deploy.sh setup|release <ssh-host>` and `tls <ssh-host> <ip>` (DEPLOYMENT.md §3a/§3b). `desktop/` is a separate Electron package (its own devDependencies, not part of the server runtime): a window onto the cloud console that pins the server certificate fingerprint from `desktop/server.json`.
Other CLI subcommands (`dealer import/export`, `goal`, `run <workflow>`, `xhs-login`, `import-content`) are listed in the header of `src/cli.ts`.

## Code conventions (enforced by tsconfig / contract)

- **Erasable syntax only**: no `enum`, `namespace`, constructor parameter properties or decorators. Use `as const` arrays with union types instead.
- Relative imports **must include the `.ts` extension**. Type-only imports use `import type`.
- Every skill and operator function takes `ctx: AppContext` first (`src/app/context.ts`: `db, clock, audit, xhs, llm, skills, log, runId`). There are no globals.
- Time: always use `ctx.clock.now()` / `ctx.clock.iso()`, never `new Date()` / `Date.now()` in business logic. Dealer-local days come from `src/core/time.ts` using `dealer.settings.timezone`.
- `ctx.db.tx(() => …)` is **synchronous only**. Never `await` inside it. Call providers and the LLM first, then persist inside the transaction.
- IDs come from `newId(prefix)` with the fixed prefix list in ARCHITECTURE §1. Inputs are validated with `src/core/validate.ts`. Errors use `NotFoundError` / `ValidationError` / `PolicyError(code, msg)`.
- AI decisions are recorded with `ctx.audit.decision(...)` and state changes with `ctx.audit.event(...)`.
- DB entities are snake_case and map 1:1 to columns. JSON and boolean columns are converted using `TABLE_META` in `src/db/schema.ts`. Schema changes are new entries appended to `MIGRATIONS` (currently v1–v3). Never edit an existing migration.
- Customer-facing generated text is Simplified Chinese. The UI is Chinese-first. Code and comments are English.
- Tests use `node:test` + `node:assert/strict` with `createTestContext()` from `test/helpers/context.ts`. It gives an in-memory migrated DB and a `ManualClock` fixed at `2026-09-12T02:00:00Z` (Saturday 10:00 Shanghai).

## Architecture

**Layers:** `src/core` (types, ids, clock, validate, errors) → `src/db` + `src/audit` → `src/providers/{xhs,llm}` → `src/domain` (automotive lexicon, dealer profile, pure actor classification) → `src/skills` → `src/operator` → `src/server` + `src/cli.ts`. `src/app/bootstrap.ts` `createRuntime(config)` migrates the DB, recovers interrupted runs, registers skills and workflows, and ensures schedules.

**Skills** live at `src/skills/<category>/<name>/index.ts`, grouped into the categories research, content, acquisition, sales and operations. Each one exports plain typed functions for direct use **and** `export const skill = defineSkill({name, category, agent, input, run})` so the Operator can invoke it by name. Each skill directory has a `SKILL.md`. Every skill must be registered in `src/skills/index.ts`: `test/unit/operator/workflows.test.ts` checks that every skill directory on disk is registered.

**Operator** (`src/operator`): goal-parser → planner → `workflows.ts` (named daily workflows such as `lead_discovery`, `reply_processing`, `content_publishing`, `evening_analysis`) run by a resumable `workflow-engine.ts`. `scheduler.ts` triggers them in the dealer's timezone. `onboarding.ts` `requireReadyToRun` refuses goals and manual runs until the dealer has at least one active account whose QR login was verified by a live probe. Only `refresh_dealer_data` is exempt.

**Lead pipeline** (ARCHITECTURE §3, §5, §10): query generation → provider search → notes and comments stored with `data_mode` provenance → prefilter → intent detection → `classifyActor` (only `BUYER` signals create leads) → scoring → `upsertLeadFromSignal` (one lead per person per group; writes provenance for every signal path) → Fleet Controller assigns exactly one owning account → outreach through the **10 ordered pre-send guards** (§6). CRM stage rules are in §4 (`WON` only from `CONTACTED` or later; `LOST` is left only via `reopenLead`).

**XHS provider** (`src/providers/xhs`): `mcp` is live (one xiaohongshu-mcp instance/login session per managed account plus a research instance, configured by `XHS_MCP_ACCOUNTS` or `xhs_accounts.mcp_endpoint_url`), `simulation` is a labelled synthetic corpus, and `none` is unavailable. Truths the code depends on (§7):
- DMs cannot be sent or received through any authorized API. Outreach ends at review, a human sends it and records `SENT_MANUALLY` + `sent_by`. `SENT` requires a provider-confirmed message id.
- A logged-out session surfaces as `REQUIRES_AUTH`, never as "no results". There is no silent fallback from `mcp` to simulation. Login checks are never cached.
- Publishing needs at least 1 image and returns no note id. Unknown outcomes are never auto-retried.
- 聚光 lead pushes arrive through `/webhooks/juguang` (`juguang-webhook.ts`).

**LLM** (`src/providers/llm`, Anthropic) is optional. The deterministic engines must be complete without it, and LLM output is always validated: quotes must be verbatim substrings, and claims are checked against the Dealer Brain with `verifyClaims`. Dealer facts (prices, stock, offers) come only from the imported Dealer Brain.

**Server** (`src/server`): hand-rolled router (`http.ts`), JSON API in `api/`, server-rendered pages in `pages/`, cookie session auth (required in production), CSRF via `x-console-request: 1` or same-origin fetch metadata, `/healthz` and `/readyz`.

## Hard rules for this project

- **Never assume a dealer, brand, city, model or account.** Nothing in `src/` may hard-code one. Each store enters its own data in the console (设置 / 账号) and logs its own XHS accounts in by QR code. `fixtures/dealers/hangzhou-bmw-group.json` is a fictional bundle **for tests and the dev demo only**. Never import it into a non-test database, and never use BMW or other placeholder defaults in the UI.
- `APP_ENV=production` refuses the simulation provider and `seed-demo`, and requires `CONSOLE_PASSWORD`, `SESSION_SECRET` and a persistent `DATABASE_PATH`. Keep these refusals.
- Unverified state is never shown as fact. For example, an account shows 登录未检测 until a live probe sets `auth_checked_at`.
