# account-sessions

## Responsibility
Keep every managed Xiaohongshu account bound to its OWN live session (ARCHITECTURE §10.3): probe the real login state of
each account's xiaohongshu-mcp instance, verify the logged-in Xiaohongshu user, persist the result on `xhs_accounts`
(`auth_state`, `auth_checked_at`, `auth_detail`, `platform_user_id`) and in `capability_snapshots`, request login QR codes
for the console, and bind accounts to instance URLs (`xhs_accounts.mcp_endpoint_url`). Nothing is assumed — a logged-out,
unreachable or wrong-account session is surfaced as such.

## Owning agent
`fleet-controller` (account operability is a precondition for lead ownership and outreach).

## Inputs
- `syncAccountAuth(ctx, accountId)` / `syncFleetAuth(ctx, dealerId)` — account or dealer ids.
- `startAccountLogin(ctx, accountId | null, actor)` — null targets the research instance.
- `setAccountEndpoint(ctx, accountId, url | null, actor)` — http(s) URL of the account's own instance, or null to unbind.
- `recordCapabilitySnapshots(ctx, report, accountId?)` — a provider `CapabilityReport`.
- `getAccountSessions(ctx, dealerId)`.
- Skill `account-sessions`: `{action: 'sync' | 'sessions', dealer_id?, account_id?}` (sync needs one of them, sessions needs `dealer_id`).

## Outputs
- `AccountAuthSyncResult {account, status, reason, applicable, capabilities}` — `status` AVAILABLE only for a logged-in,
  verified-or-unverifiable-but-not-conflicting session; REQUIRES_AUTH for logged out / wrong user / user bound to another
  managed account; the provider's failure status (UNAVAILABLE / REQUIRES_REVIEW) when the probe failed (`auth_state` unknown).
- `XhsLoginQrcode {already_logged_in, image_data_url, expires_at, detail}` — returned to the caller only, never persisted or logged.
- Updated `XhsAccount` rows, `CapabilitySnapshot[]`, `AccountSessionRow[]` (endpoint source env/db/none without tokens,
  login state, latest snapshot per capability, provider name/mode/login_api).

## Validation & guarantees
- Login state comes only from live probes (`ctx.xhs.capabilities` + `ctx.xhs.auth.status`); providers without a login API
  (simulation, none) are reported as "不适用" and keep their `auth_state` unless a capability says REQUIRES_AUTH.
- A verified `platform_user_id` different from the stored one → `requires_auth` with `登录的小红书账号与该账号记录不一致`;
  a verified user already bound to another managed account → `requires_auth` (one Xiaohongshu user per managed account).
- The first verified user id is stored; it is never silently replaced.
- Endpoint URLs: http(s) only, no embedded username/password (tokens only via env), normalized, unique across accounts
  (also enforced by the `uq_account_mcp_endpoint` index). Changing or removing an endpoint resets `auth_state` to unknown.
- Audit events: `account.auth_synced` (only when the state or verified id changed), `account.login_qrcode_requested`
  (without the image), `account.endpoint_updated`.
- Provider calls happen before the synchronous DB transaction.

## Runtime entry points
- Operator workflow `refresh_dealer_data` (daily) → `syncFleetAuth` so health and assignment see real session states.
- Console 账号 page → `getAccountSessions`, "扫码登录" → `startAccountLogin`, endpoint form → `setAccountEndpoint`,
  "检测登录" → `syncAccountAuth`.
- Skill registry `account-sessions` for the Automotive Operator.

## Failure modes
- Unknown account / dealer → `NotFoundError`.
- Provider without login API or instance cannot produce a QR code → `PolicyError` (`xhs_login_not_applicable`,
  `xhs_login_unavailable`, …) with the provider's reason.
- Invalid URL → `ValidationError`; URL in use by another account → `PolicyError('endpoint_in_use')`.
- Probe failures never throw: they are persisted as `auth_state: unknown` with the provider's reason.
- `get_my_profile` can be slow or fail; the login is then reported with "用户ID未能校验" instead of failing the sync.

## Tests
`node --test test/unit/account-sessions/account-sessions.test.ts` — fake xiaohongshu-mcp servers over an injected fetch:
logged in / logged out / unreachable / wrong user / user bound elsewhere, capability snapshots, fleet sync skipping disabled
accounts, QR login audit without image data, endpoint validation (scheme, credentials, uniqueness, reset of auth state),
session read model with env/db endpoint sources, simulation provider reported as not applicable, skill input validation.
Live verification: `XHS_LIVE_MCP_URL=… node --test test/live/xhs-live.test.ts`.
