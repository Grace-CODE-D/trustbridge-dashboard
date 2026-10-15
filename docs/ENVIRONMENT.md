# Environment Variables

Complete reference for all configuration used by TrustBridge Dashboard.

← Back to [README](../README.md) · See also [Setup guide](./SETUP.md) · [Deployment](./DEPLOYMENT.md)

Copy `.env.example` to `.env.local` (development) or configure in your Vercel project settings (production).

---

## Required variables

### `GITHUB_CLIENT_ID`

GitHub OAuth App client ID.

- **Where:** [GitHub Developer Settings](https://github.com/settings/developers)
- **Used by:** NextAuth.js GitHub provider

### `GITHUB_CLIENT_SECRET`

GitHub OAuth App client secret.

- **Server-only** — never expose to the browser
- **Used by:** NextAuth.js token exchange

### `NEXTAUTH_URL`

Canonical URL of the deployment.

| Environment | Value |
|-------------|-------|
| Local | `http://localhost:3000` |
| Production | `https://your-domain.vercel.app` |

Used for OAuth callback generation.

### `NEXTAUTH_SECRET`

Random string for JWT/session encryption.

Generate:

```bash
openssl rand -base64 32
```

**Required in production.** Missing value causes auth failures.

### `GITHUB_MAINTAINER_ORG`

GitHub organization **slug** (login name) whose members can access `/dashboard`.

Example: if your org URL is `https://github.com/stellar`, set `GITHUB_MAINTAINER_ORG=stellar`.

- Checked via GitHub API `GET /user/orgs` after sign-in
- Non-members can still use `/register`

### `DATABASE_URL`

PostgreSQL connection string.

```
postgresql://USER:PASSWORD@HOST:PORT/DATABASE?sslmode=require
```

Providers: local Postgres, Neon, Supabase, Vercel Postgres, Railway, etc.

### `TOKEN_ENCRYPTION_KEY`

Base64-encoded 32-byte key used to encrypt GitHub access tokens at rest (AES-256-GCM) before they are written to `User.accessToken`. See [`src/lib/token-crypto.ts`](../src/lib/token-crypto.ts).

Generate:

```bash
openssl rand -base64 32
```

**Required.** If unset, invalid, or not exactly 32 bytes after base64 decoding, sign-in fails closed — no access token is stored (rather than falling back to plaintext) and a `token_encryption_skipped` row is written to `TokenAuditLog`.

---

## Stellar / Horizon (public)

> **These values must match [trustbridge-action](https://github.com/Stellar-TrustBridge/trustbridge-action).**
> See [Alignment with trustbridge-action](#alignment-with-trustbridge-action) below.

These are prefixed with `NEXT_PUBLIC_` and available in the browser.

### `NEXT_PUBLIC_HORIZON_URL`

Horizon API base URL.

| Network | URL |
|---------|-----|
| Mainnet | `https://horizon.stellar.org` |
| Testnet | `https://horizon-testnet.stellar.org` |

Must match the network your contributors use.

> **Network consistency:** `NEXT_PUBLIC_HORIZON_URL` and `SOROBAN_RPC_URL` (below) should point at the **same** Stellar network. The project's own defaults do not — Horizon defaults to mainnet while `SOROBAN_RPC_URL` defaults to testnet — so a maintainer who only sets one of the two can end up validating contributor funding against a different network than the one Soroban events are read from. The dashboard detects this: `GET /api/settings/network` (maintainer-only) and the "Network configuration" panel on `/dashboard` compare the resolved networks and show a warning banner when they mismatch, and a `network_config_mismatch_detected` entry is written to the audit log (visible via `GET /api/audit`) so the misconfiguration has a durable record. See [`src/lib/network-config.ts`](../src/lib/network-config.ts).

### `NEXT_PUBLIC_DEFAULT_ASSET_CODE`

Asset code for trustline checks. Default: `USDC`

### `NEXT_PUBLIC_DEFAULT_ASSET_ISSUER`

Asset issuer public key. Default: Circle USDC on Stellar mainnet:

```
GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
```

Change both code and issuer together for testnet or custom assets.

### `NEXT_PUBLIC_MIN_XLM_BALANCE`

Minimum **spendable** XLM balance for **Ready** status (string parsed as float). Default: `1.5`

Accounts below this threshold show **Low Reserve** even with a valid trustline. Compared against the spendable balance (raw balance minus reserve and liabilities), not the raw `xlm_balance`.

### `NEXT_PUBLIC_BASE_RESERVE_XLM`

Stellar network base reserve, in XLM, used to compute each account's minimum reserve (string parsed as float). Default: `0.5`

Every Stellar account locks up `baseReserve * (2 + subentry_count + num_sponsoring − num_sponsored)` XLM that cannot be spent. This value rarely changes on mainnet; override only for custom networks or if the protocol-wide base reserve changes. See [Architecture — Readiness rules](./ARCHITECTURE.md#readiness-rules).

---

## Alignment with trustbridge-action

The dashboard and [trustbridge-action](https://github.com/Stellar-TrustBridge/trustbridge-action) answer the same question — *is this contributor ready to be paid?* — from **two independently configured environments**. The dashboard reads `NEXT_PUBLIC_*` variables; the Action reads workflow inputs declared in its `action.yml`. Nothing links them at runtime.

When they drift, the failure is quiet and lands on the contributor: the dashboard shows a green **Ready** badge, the contributor closes the tab, and the workflow that actually gates their payout rejects them (or the reverse — they fix a problem the dashboard never reported).

### The contract

These four values are mirrored in [`ACTION_DEFAULTS`](../src/lib/constants.ts) and must stay equal to the Action's defaults:

| Dashboard variable | Action input (`action.yml`) | Shared default |
| --- | --- | --- |
| `NEXT_PUBLIC_HORIZON_URL` | `horizon_url` | `https://horizon.stellar.org` |
| `NEXT_PUBLIC_DEFAULT_ASSET_CODE` | `asset_code` | `USDC` |
| `NEXT_PUBLIC_DEFAULT_ASSET_ISSUER` | `asset_issuer` | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` |
| `NEXT_PUBLIC_MIN_XLM_BALANCE` | `min_xlm_reserve` | `1.5` |

**The chosen issuer** is Circle's USDC issuing account on the Stellar **public network (mainnet)**. It is the issuer the Action ships with, and the one contributors are told to trust in the generated outreach templates. Verify any replacement with `StrKey.isValidEd25519PublicKey` before committing it — see the note on checksums below.

`min_xlm_reserve` and `NEXT_PUBLIC_MIN_XLM_BALANCE` are not *quite* the same measurement: the Action compares the account's native XLM balance, while the dashboard compares the **spendable** balance (raw balance minus reserve and liabilities). The dashboard is therefore the stricter of the two at equal thresholds, which is the safe direction. Keeping the numbers equal keeps the two verdicts as close as the different measurements allow.

### How drift is detected

[`checkActionAlignment()`](../src/lib/network-config.ts) compares the *resolved* environment against `ACTION_DEFAULTS` on every call to `getNetworkConfig()`. Its findings are attached to the `actionAlignment` field of `GET /api/settings/network` (maintainer-only) and merged into the same `warnings` list the **Network configuration** panel on `/dashboard` already renders.

It reports rather than fails, because a deliberate testnet or custom-asset deployment is legitimate and only an operator can tell the difference between that and a mistake. Two cases are worth calling out:

- **Invalid issuer.** An issuer that fails StrKey checksum validation is flagged as *invalid*, not merely different. A malformed G-address cannot be a real account on any network, so no trustline check against it can ever succeed. This is not hypothetical: the issuer this project shipped before [#119](https://github.com/Stellar-TrustBridge/trustbridge-dashboard/issues/119) had the right length, prefix, and alphabet, and failed the checksum — a regex-shaped validation would have waved it through.
- **A minimum balance *below* the Action's floor** is flagged; a value *above* it is not. Only the low side produces "ready here, rejected there". A stricter dashboard is conservative, not dangerous.

### Changing the defaults

Change the Action first, then mirror it here in the same wave:

1. Update the input default in `trustbridge-action/action.yml`.
2. Update `ACTION_DEFAULTS` in [`src/lib/constants.ts`](../src/lib/constants.ts).
3. Update the Zod defaults in [`src/lib/env-validation.ts`](../src/lib/env-validation.ts), `.env.example`, and the table above.
4. Run `npm test -- network`. The "bare environment" test in `src/lib/network-config.test.ts` fails if the shipped defaults drift from `ACTION_DEFAULTS`.

Deployments that override any of these in their environment keep their override — nothing here silently switches a running production deployment onto a different asset or network.

---

## Optional variables

### `FREEZE_WINDOW_ENABLED`

Master switch for the Wave freeze window. When set to `false` the freeze is
always inactive regardless of `FREEZE_WINDOW_START` / `FREEZE_WINDOW_END`.

| Value | Behaviour |
|-------|-----------|
| Unset | Freeze is determined by `FREEZE_WINDOW_START` and `FREEZE_WINDOW_END` |
| `false` | Freeze is always **off** (explicit override) |
| `true` / any truthy value | Freeze is governed by the time-range variables |

### `FREEZE_WINDOW_START`

ISO-8601 datetime string marking the **start** of the active freeze window.

```
FREEZE_WINDOW_START=2026-09-25T00:00:00.000Z
```

- Parsed with `new Date()`. Invalid values are silently ignored (freeze inactive).
- Must be set alongside `FREEZE_WINDOW_END`; either variable alone has no effect.
- Setting `FREEZE_WINDOW_ENABLED=false` overrides both time variables.

### `FREEZE_WINDOW_END`

ISO-8601 datetime string marking the **end** of the freeze window.

```
FREEZE_WINDOW_END=2026-09-25T08:00:00.000Z
```

- Same parsing rules as `FREEZE_WINDOW_START`.
- Once the current time passes this value the freeze deactivates automatically;
  no deploy or restart is required.

#### Freeze-window behaviour

While a freeze window is active:

- **`POST /api/contributors`** (batch recheck) returns `423 WAVE_FREEZE_ACTIVE`.
- **`POST /api/contributors/[id]`** (single recheck) returns `423 WAVE_FREEZE_ACTIVE`.
- **`POST /api/register`** (address change) returns `423 WAVE_FREEZE_ACTIVE`.
- **`GET /api/freeze-status`** returns `{ "active": true, ... }` — the maintainer
  dashboard polls this every 30 s and shows a **FreezeWindowBanner** automatically.
- The banner disappears as soon as `active` flips back to `false` (i.e. the window
  ends or `FREEZE_WINDOW_ENABLED` is changed to `false` and the 30 s poll fires).

Maintainers can bypass a freeze by sending `x-freeze-override: true` (header) or
`?overrideFreeze=true` (query parameter). Every override is written to the audit
log.

#### Example — schedule a freeze

```bash
FREEZE_WINDOW_ENABLED=true
FREEZE_WINDOW_START=2026-09-25T00:00:00.000Z
FREEZE_WINDOW_END=2026-09-25T08:00:00.000Z
```

#### Example — disable entirely

```bash
FREEZE_WINDOW_ENABLED=false
```

> **See also:** [`src/lib/freeze-window.ts`](../src/lib/freeze-window.ts) —
> `isFreezeWindowActive()` and `enforceFreezeWindowGuard()` for implementation
> details. [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md) for Wave operations runbook.
> [`docs/FEATURE_FLAGS.md`](./FEATURE_FLAGS.md) for the complementary
> `maintenance_mode` feature flag.

---

### `REGISTRY_MODE`

Reported by the contributor REST endpoints (`/api/contributors`, `/api/contributors/paginated`) as `registryMode` in their response body, via `src/lib/registry-mode.ts`.

| Value | Meaning |
|-------|---------|
| `live` (default) | Reads reflect whatever is currently persisted; maintainers are expected to trigger a Horizon recheck to refresh it. |
| `synced` | Signals that a scheduled contract-to-Postgres sync job (see `CONTRACT_SYNC_MIN_INTERVAL_MS` above) is responsible for keeping registrations fresh. |

Reads are identical in both modes — Postgres is always the source of truth. An unset or unrecognized value falls back to `live` rather than failing.

### `GITHUB_MAINTAINER_TEAM`

GitHub team **slug** within `GITHUB_MAINTAINER_ORG`. When set, a user must belong to both the org **and** this team to be treated as a maintainer.

Example: if the team URL is `https://github.com/orgs/stellar/teams/dashboard-maintainers`, set `GITHUB_MAINTAINER_TEAM=dashboard-maintainers`.

- Checked via GitHub API `GET /orgs/{org}/teams/{team_slug}/memberships/{username}` after the org check passes
- **Unset by default** — the org-only check runs exactly as before, so existing deployments are unaffected
- A user who passes the org check but fails the team check is denied and an audit log entry (`maintainer_access_denied_team`) is recorded, visible via `/api/audit`
- A GitHub API error or rate limit on either check fails closed (`isMaintainer = false`) rather than blocking sign-in

### `CHECK_CACHE_TTL_MS`

Time-to-live, in milliseconds, for entries in the `/api/check` **KV response cache**.

| Value | Behaviour |
|-------|-----------|
| Unset / invalid | Falls back to **120 000 ms (2 minutes)** |
| Any positive integer | Cache entries expire after this many ms |

**How it works:**

`POST /api/check` maintains a dedicated in-process KV cache (`checkCache` in [`src/lib/cache.ts`](../src/lib/cache.ts)) keyed by `check:<address>:<assetCode>:<assetIssuer>`. On a cache hit the route returns the stored result without making a Horizon API call.

- **Transient errors are never cached.** If `checkStellarAddress` returns an error that includes `"temporarily unavailable"` or `"Horizon error:"`, the result is not written to the cache so the next request retries Horizon.
- **Cache bypass:** callers can force a fresh Horizon check by sending the `X-Cache-Bypass: 1` request header or the `?cache_bypass=1` query parameter. When bypass is active the route also passes `useCache: false` into `checkStellarAddress`, skipping the internal `verificationCache` in `horizon.ts` as well.
- **Independence from verificationCache:** `checkCache` and `verificationCache` (used inside `horizon.ts`) are separate `CacheStore` instances with independent TTLs. This lets the route-level and library-level caches be invalidated separately — useful when a maintainer batch-rechecks addresses.

Example — aggressive caching for a read-heavy deployment:

```bash
CHECK_CACHE_TTL_MS=300000  # 5 minutes
```

Example — effectively disable the route cache (still benefits from horizon.ts internal cache):

```bash
CHECK_CACHE_TTL_MS=1  # 1 ms ≈ no caching
```

---

### `TRUSTBRIDGE_ACTION_SECRET`

Shared secret used to verify the authenticity of webhook payloads received from the TrustBridge GitHub Action.

- **Server-only** — never expose to the browser
- **Used by:** Webhook verification at `POST /api/webhooks/trustbridge-action`
- **Recommended in production.** If unset, signature verification fails and incoming webhooks are rejected with a 401 status.
- Generate: `openssl rand -base64 32`

### `BADGE_SIGNING_KEY`

Secret key used for HMAC-SHA256 badge URL signing (`/api/badge/[username]?sig=...`).

- **Server-only** — never expose to the browser
- **Used by:** Badge endpoint authentication to prevent hotlink spoofing/faking of contributor readiness SVG badges
- **Fallback:** If unset, falls back to `NEXTAUTH_SECRET` or `TOKEN_ENCRYPTION_KEY`. Throws in production if no secret is available.
- Generate: `openssl rand -base64 32`

### `SOROBAN_SECRET_KEY`

Secret key for the Soroban fee-payer account used to sign write-through transactions. Required for the `mirrorRegistrationToSoroban()` function to submit transactions to the Soroban contract.

- **Server-only** — never expose to the browser
- **Required for write-through:** If unset, the write-through is skipped with a logged error (registration still succeeds)
- **Security:** The key is used to sign transactions but never stored in the database or logs
- Generate: Use an existing Stellar secret key or generate a new one for the fee-payer account

### `SOROBAN_CONTRACT_ID`

Soroban contract ID the maintainer dashboard's **Soroban event timeline** panel reads events for. Registrations are not yet mirrored to this contract — see the write-through design note below.

When unset, registrations are stored in PostgreSQL only and the event timeline panel renders an empty state explaining that configuration is missing. See [Architecture — Soroban register write-through](./ARCHITECTURE.md#soroban-register-write-through) for the read-vs-write-through breakdown.

### `SOROBAN_RPC_URL`

Soroban RPC endpoint used to fetch contract events for the timeline panel. Defaults to `https://soroban-testnet.stellar.org` when unset.

| Network | URL |
|---------|-----|
| Mainnet | `https://mainnet.sorobanrpc.com` |
| Testnet | `https://soroban-testnet.stellar.org` |

**Keep this on the same network as `NEXT_PUBLIC_HORIZON_URL` above.** The default here is testnet while the default Horizon URL is mainnet — see the network consistency note above and [Architecture — network hardening](./ARCHITECTURE.md#network-hardening) for how the mismatch is surfaced.

### `SOROBAN_OUTBOX_INTERVAL_MS`

Polling interval in milliseconds for the Soroban outbox worker loop in `scripts/worker.mjs`. Defaults to `15000` (15 seconds) when unset.

- **Optional.** Controls how frequently the background worker checks for pending outbox items to mirror to Soroban.

### `CRON_SECRET`

Bearer token that authorizes a scheduler (e.g. Vercel Cron) to trigger `POST /api/contract-sync` and `POST /api/cron/export` without a maintainer session. Send as `Authorization: Bearer $CRON_SECRET`.

- **Optional.** With it unset, only maintainer sessions can trigger automated syncs or exports — the endpoints never fall back to open/unauthenticated triggers.
- Generate the same way as `NEXTAUTH_SECRET`: `openssl rand -base64 32`

### `TREASURY_EXPORT_EMAIL`

Destination email address for automated nightly treasury CSV exports (`POST /api/cron/export`).

- **Optional.** When set (e.g., `treasury@yourorg.com`), scheduled runs generate the full contributor CSV dump and email it as an attachment along with operational metrics (total contributors, ready count, stale count).
- **Fork-safe & Privacy:** If unset, exports are generated and audited without sending emails to unconfigured destinations. The email notification body only contains aggregate metrics and warnings; contributor records are contained within the attached CSV file.
- **Service:** Uses Resend when `RESEND_API_KEY` is configured, or logs to console in development.

### `CRON_EXPORT_MIN_INTERVAL_MS`

Minimum time between `/api/cron/export` runs; repeated triggers within this window return `{ status: "skipped" }` to prevent duplicate emails and scheduler retry storms. Defaults to `60000` (1 minute).

### `NEXT_PUBLIC_POSTHOG_API_KEY`

PostHog project API key for product analytics. When set, the dashboard tracks key events like registration completions, rechecks, and CSV exports.

- **Optional.** When unset, analytics events are silently ignored (no-op) or logged to console in development.
- **Security:** This is a public key (prefixed with `NEXT_PUBLIC_`) — PostHog project API keys are safe to expose in the browser.

### `NEXT_PUBLIC_POSTHOG_HOST`

PostHog instance host URL. Defaults to `https://app.posthog.com` (PostHog Cloud).

- **Optional.** Only needed if using a self-hosted PostHog instance.

### `CONTRACT_SYNC_MIN_INTERVAL_MS`

Minimum time between `/api/contract-sync` runs; a trigger inside this window returns `{ status: "skipped" }` instead of re-running Horizon checks for every registration. Defaults to `60000` (1 minute).

---

## Prometheus metrics (optional)

### `PROMETHEUS_SCRAPE_TOKENS`

Comma-separated list of bearer tokens that authorize `/api/metrics/prometheus`
scrapes without requiring a maintainer browser session. Intended for
Prometheus / VictoriaMetrics / Grafana Agent.

```
PROMETHEUS_SCRAPE_TOKENS=prod-scrape-token-abc,staging-scrape-token-xyz
```

- Each token should be ≥ 32 chars of high entropy; generate with `openssl rand -base64 32`
- **Server-only** — never commit tokens or expose them in `NEXT_PUBLIC_*`
- When unset, the endpoint falls back to requiring a maintainer session (cookie auth)
- Session auth and token auth are OR'd: either succeeds, both are never required

#### Example Prometheus `scrape_configs`

```yaml
scrape_configs:
  - job_name: trustbridge-dashboard
    scrape_interval: 30s
    metrics_path: /api/metrics/prometheus
    static_configs:
      - targets: ["trustbridge.example.com"]
    scheme: https
    authorization:
      type: Bearer
      credentials: "prod-scrape-token-abc"
```

#### Exported metrics (all maintainer-scoped, no PII in labels)

| Metric | Type | Labels | Notes |
| --- | --- | --- | --- |
| `trustbridge_contributors_total` | gauge | — | |
| `trustbridge_contributors_ready` | gauge | — | |
| `trustbridge_contributors_low_reserve` | gauge | — | |
| `trustbridge_contributors_not_ready` | gauge | — | |
| `trustbridge_circuit_breaker_state` | gauge | — | 0=CLOSED, 1=HALF_OPEN, 2=OPEN |
| `trustbridge_circuit_breaker_total_trips` | counter | — | Process-local since start |
| `trustbridge_circuit_breaker_failure_count` | gauge | — | Current consecutive failures |
| `trustbridge_circuit_breaker_last_failure_timestamp_seconds` | gauge | — | 0 if none, else Unix seconds |
| `trustbridge_rate_limit_active_identifiers` | gauge | — | Count inside current window (process-local) |
| `trustbridge_rate_limit_requests_allowed_total` | counter | — | Process-local since start |
| `trustbridge_rate_limit_requests_blocked_total` | counter | — | Process-local since start |
| `trustbridge_process_local_info` | gauge | `scope="process"` | Always 1 — honest marker that counters are per-process, not globally aggregated, until Redis-backed state ships. |

⚠️ **Cardinality / PII policy:** the route never emits dynamic labels (no per-user,
per-IP, per-address). All label sets are static. Addresses / GitHub handles / IPs
are never serialized into the metrics body. If you add new metrics, keep this
contract.

---

## Vercel configuration

1. Project → **Settings** → **Environment Variables**
2. Add all required variables for **Production**, **Preview**, and **Development**
3. Redeploy after changes

For preview deployments, set `NEXTAUTH_URL` to the preview URL or use Vercel's automatic `VERCEL_URL` pattern in custom auth config if needed.

---

## Rate limiting

### `RATE_LIMIT_WINDOW_MS`

Sliding-window duration in milliseconds for the `POST /api/check` per-IP rate
limiter.

| Value | Behaviour |
|-------|-----------|
| Unset / invalid | Falls back to **60 000 ms (1 minute)** |
| Any positive integer | Window resets after this many ms |

### `RATE_LIMIT_MAX_REQUESTS`

Maximum number of requests a single IP may make within one `RATE_LIMIT_WINDOW_MS`
window.

| Value | Behaviour |
|-------|-----------|
| Unset / invalid | Falls back to **10 requests per window** |
| Any positive integer | Requests beyond this threshold receive `429 Too Many Requests` with a `Retry-After` header |

### ⚠️ Process-local caveat (important for multi-instance deployments)

The rate-limit store (`store` in `src/lib/rate-limit.ts`) is a plain in-process
`Map`. **It is not shared across Node.js processes, server instances, or
serverless function invocations.** This means:

- On a horizontally scaled deployment (e.g. multiple Vercel Edge or Lambda
  containers, a PM2 cluster, or a Kubernetes replica set) each instance
  enforces limits independently.
- A client that lands on a different instance for each request effectively gets
  `RATE_LIMIT_MAX_REQUESTS × <instance count>` requests before any single
  process throttles it.
- Serverless cold-starts reset the in-process state — a burst of cold invocations
  each start with a clean counter.

The limit therefore provides a **best-effort, single-process guardrail** rather
than a hard cluster-wide cap.

#### Recommended mitigations

Choose the approach that best fits your deployment topology:

| Approach | When to use | Notes |
|----------|-------------|-------|
| **Edge / CDN rate limiting** | All multi-instance deployments | Vercel WAF, Cloudflare Rate Limiting, or AWS WAF can enforce a true global cap in front of the origin. This is the recommended first line of defense at scale. |
| **Sticky sessions (IP affinity)** | Load-balanced multi-instance setups | Routes the same IP to the same origin instance, so the in-process store sees all requests from that IP. Does not help with serverless cold-starts. |
| **Shared external store (Redis / Upstash)** | When strict per-IP enforcement is required | Replace the `Map` in `src/lib/rate-limit.ts` with a Redis-backed sliding window (e.g. [`@upstash/ratelimit`](https://github.com/upstash/ratelimit)). Provides exact counts across all instances at the cost of an additional network hop per request. |
| **Lower `RATE_LIMIT_MAX_REQUESTS`** | Single-instance or low-traffic deployments | A stricter per-process limit reduces the worst-case over-allowance on small clusters. |

> **Single-instance note:** If your deployment runs exactly one server process
> (e.g. a single Vercel Serverless Function container with no concurrency, or a
> single Node.js server), the process-local limit is effectively cluster-wide and
> no further action is required.

#### How to adopt a Redis-backed store (example)

```typescript
// src/lib/rate-limit.ts — optional Redis upgrade
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(
    Number(process.env.RATE_LIMIT_MAX_REQUESTS ?? "10"),
    `${Number(process.env.RATE_LIMIT_WINDOW_MS ?? "60000")}ms`,
  ),
});

export async function checkRateLimitRedis(identifier: string) {
  const { success, remaining, reset } = await ratelimit.limit(identifier);
  const retryAfter = success ? 0 : Math.max(1, Math.ceil((reset - Date.now()) / 1000));
  return { allowed: success, retryAfter, remaining };
}
```

Add `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` to your environment
and replace calls to `checkRateLimit()` with `checkRateLimitRedis()` in
`src/app/api/check/route.ts`.

---

## Security checklist
## Rate-Limit Headers

Public API endpoints (`/api/check`, `/api/actions/lookup`, `/api/stats`) emit standard rate-limit response headers on every response:

| Header | Description |
|--------|-------------|
| `RateLimit-Limit` | Max requests allowed per window (default: 10 for `/api/check`, 60 for lookup, 120 for stats) |
| `RateLimit-Remaining` | Requests remaining in the current window |
| `RateLimit-Reset` | Seconds until the window resets |
| `Retry-After` | Seconds to wait before retrying (only on 429 responses) |

These follow the [IETF RateLimit Headers draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers-07/) standard.

**Multi-instance note:** The rate limiter uses an in-memory sliding window. When running behind a load balancer with N instances, the effective limit is approximately `N × maxRequests`. For strict per-client limits, consider a shared store (Redis, etc.) — but the current approach is sufficient for abuse prevention.

---

## API keys (maintainer export automation)

Maintainer API keys let cron jobs and CI pipelines authenticate against the contributor export endpoints **without a browser session or GitHub OAuth cookie**. They are scoped to the minimum required permission and are hashed at rest — the raw secret is shown exactly once at creation time and never stored.

### No new environment variables required

API keys are self-contained in the database. The only prerequisite is that `DATABASE_URL` and `TOKEN_ENCRYPTION_KEY` are already configured. See [docs/API_KEYS.md](./API_KEYS.md) for the full workflow.

### `API_KEY_RATE_LIMIT_WINDOW_MS` _(optional, reserved)_

Currently the per-IP rate limit for API key–authenticated export requests is hardcoded to **60 requests per 60 seconds**. A future release will read `API_KEY_RATE_LIMIT_WINDOW_MS` and `API_KEY_RATE_LIMIT_MAX_REQUESTS` from the environment to allow operators to tune the window. For now, use the existing `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_REQUESTS` env vars to tune the process-wide default, which also affects `/api/check` and other guarded endpoints.

### Security properties

| Property | Implementation |
|---|---|
| Raw key storage | Never — only SHA-256 hex digest is persisted |
| Key format | `tb_<43 url-safe base64 chars>` (~258 bits entropy) |
| Scope enforcement | `export:read` required; checked on every request |
| Expiry | Optional per-key ISO-8601 datetime |
| Revocation | Soft-delete (`revokedAt` timestamp); effective immediately |
| Rate limiting | 60 requests / 60 s per IP (in-process sliding window) |
| Audit trail | Every create / revoke / rejected use written to `AuditLog` |
| Max active keys | 10 per user (prevents credential sprawl) |

---

## Digest emails (daily/weekly not-ready contributor digest)

The digest cron job emails maintainers a readiness summary on a schedule —
counts of ready / low-reserve / not-ready contributors plus a direct link to
the dashboard. No contributor PII (usernames, addresses) is sent by default;
the full list is opt-in.

### `DIGEST_EMAIL`

Destination email address for digest emails.

- **Optional.** Falls back to `TREASURY_EXPORT_EMAIL`, then `CRON_EXPORT_EMAIL`
  when unset, so teams with a single ops address only need to set one variable.
- When all three are unset the digest still runs and writes an audit log entry,
  but no email is sent.

### `DIGEST_CADENCE`

Controls the label in the digest subject line (`Daily` or `Weekly`). Does not
affect when the cron fires — that is controlled by your Vercel Cron schedule or
equivalent. Default: `daily`.

| Value | Subject prefix |
|-------|---------------|
| `daily` (default) | `[TrustBridge] Daily Not-Ready Contributor Digest` |
| `weekly` | `[TrustBridge] Weekly Not-Ready Contributor Digest` |

### `DIGEST_INCLUDE_FULL_LIST`

Privacy control. When unset (the default) the digest body contains only
aggregate counts and a dashboard link — no contributor usernames or reasons.

Set to `true` / `1` / `yes` to include a per-contributor table of GitHub
usernames and block reasons in the email body.

> **Privacy note:** the full list contains GitHub usernames (not emails or
> Stellar addresses). Restrict access to the destination mailbox accordingly,
> and review your data-handling obligations before enabling this.

| Value | Behaviour |
|-------|-----------|
| unset / `false` / `0` | Counts + link only (default) |
| `true` / `1` / `yes` | Usernames + reasons included |

### `DIGEST_CRON_MIN_INTERVAL_MS`

Minimum milliseconds between digest runs. Prevents a misconfigured cron
schedule from spamming the inbox. Default: `3600000` (1 hour).

```bash
DIGEST_CRON_MIN_INTERVAL_MS=3600000   # 1 hour (default)
DIGEST_CRON_MIN_INTERVAL_MS=86400000  # 24 hours
```

**Multi-instance note:** like the export rate gate, this is in-process state.
Each Vercel instance has its own counter. In practice this is fine — a
misconfigured per-minute schedule fires once per instance per hour, not
unboundedly.

### Vercel Cron configuration

Add entries to `vercel.json` to trigger the digest automatically:

```json
{
  "crons": [
    {
      "path": "/api/cron/digest",
      "schedule": "0 8 * * *"
    }
  ]
}
```

This fires at 08:00 UTC daily. For weekly, use `"0 8 * * 1"` (Monday 08:00 UTC)
and set `DIGEST_CADENCE=weekly`. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`
automatically when `CRON_SECRET` is set in the project environment variables.

### Digest audit trail

Every digest run writes a `digest.cron` entry to `AuditLog` (visible in
`/dashboard/settings → Recent activity`):

| `action` | When |
|---|---|
| `digest.cron` | Run completed (including no-destination runs). `metadata` includes `cadence`, `totalContributors`, `readyCount`, `notReadyCount`, `lowReserveCount`, `emailSent`, `destination`. |
| `digest.cron.failed` | DB or unexpected error. `metadata.error` contains the message. |

---

- [ ] Never commit `.env.local` or secrets
- [ ] Rotate `GITHUB_CLIENT_SECRET` if exposed
- [ ] Use `sslmode=require` for remote Postgres
- [ ] Generate unique `NEXTAUTH_SECRET` per environment

---

## Related docs

- [Setup guide](./SETUP.md)
- [Deployment](./DEPLOYMENT.md)
- [Feature flags](./FEATURE_FLAGS.md)
- [Architecture](./ARCHITECTURE.md)
- [API keys](./API_KEYS.md)
- [Digest emails](./DIGEST.md)

- // src/lib/notifications/webhook.ts

export type WebhookPayload = {
  event: string;
  message: string;
  count?: number;
  timestamp: string;
};

const MAX_MESSAGE_LENGTH = 2000;

function validateWebhookUrl(value: string): URL {
  const url = new URL(value);

  if (url.protocol !== "https:") {
    throw new Error("Webhook URL must use HTTPS");
  }

  if (url.username || url.password) {
    throw new Error("Webhook URL must not contain credentials");
  }

  return url;
}

function sanitizeMessage(message: string): string {
  return message
    .replace(/G[A-Z0-9]{20,}/gi, "[redacted-address]")
    .replace(/0x[a-fA-F0-9]{40}/g, "[redacted-address]")
    .slice(0, MAX_MESSAGE_LENGTH);
}

export async function sendWebhook(
  webhookUrl: string,
  payload: WebhookPayload,
): Promise<void> {
  const url = validateWebhookUrl(webhookUrl);

  const body = {
    ...payload,
    message: sanitizeMessage(payload.message),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "error",
    });

    if (!response.ok) {
      throw new Error(`Webhook returned HTTP ${response.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
// src/lib/notifications/notify.ts

import { sendWebhook } from "./webhook";

type NotificationConfig = {
  dropThreshold?: number;
  notReadyThreshold?: number;
  webhookUrl?: string;
};

type DropEvent = {
  collection: string;
  count: number;
};

type ReadinessEvent = {
  count: number;
};

const lastPost = new Map<string, number>();
const RATE_LIMIT_MS = 60_000;

function canPost(key: string): boolean {
  const now = Date.now();
  const previous = lastPost.get(key) ?? 0;

  if (now - previous < RATE_LIMIT_MS) {
    return false;
  }

  lastPost.set(key, now);
  return true;
}

function getConfig(): NotificationConfig {
  return {
    webhookUrl: process.env.WAVE_WEBHOOK_URL,
    dropThreshold: Number(process.env.WAVE_DROP_THRESHOLD ?? 10),
    notReadyThreshold: Number(
      process.env.WAVE_NOT_READY_THRESHOLD ?? 10,
    ),
  };
}

export async function notifyDropBelowThreshold(
  event: DropEvent,
): Promise<boolean> {
  const config = getConfig();

  if (!config.webhookUrl) return false;

  if (event.count > (config.dropThreshold ?? 10)) {
    return false;
  }

  if (!canPost("drop-threshold")) {
    return false;
  }

  await sendWebhook(config.webhookUrl, {
    event: "drop_below_threshold",
    message:
      `Collection ${event.collection} dropped below threshold. ` +
      `Current count: ${event.count}.`,
    count: event.count,
    timestamp: new Date().toISOString(),
  });

  return true;
}

export async function notifyNotReadySpike(
  event: ReadinessEvent,
): Promise<boolean> {
  const config = getConfig();

  if (!config.webhookUrl) return false;

  if (event.count < (config.notReadyThreshold ?? 10)) {
    return false;
  }

  if (!canPost("not-ready-spike")) {
    return false;
  }

  await sendWebhook(config.webhookUrl, {
    event: "not_ready_spike",
    message:
      `Not-ready item count has spiked. ` +
      `Current count: ${event.count}.`,
    count: event.count,
    timestamp: new Date().toISOString(),
  });

  return true;
}


# Environment Variables

## Wave Notifications

### `WAVE_WEBHOOK_URL`

Optional HTTPS webhook used for Wave operational notifications.

Example:

WAVE_WEBHOOK_URL=https://example.com/webhook

Only HTTPS webhook URLs are accepted.

Do not commit webhook URLs to Git.

Do not print the webhook URL in logs, errors, or test output.

### `WAVE_DROP_THRESHOLD`

Controls when a low-drop notification is emitted.

Default:

WAVE_DROP_THRESHOLD=10

### `WAVE_NOT_READY_THRESHOLD`

Controls when a not-ready spike notification is emitted.

Default:

WAVE_NOT_READY_THRESHOLD=10

## Privacy

Notifications do not include wallet addresses by default.

Counts and operational events are preferred over individual records.

If an address is ever required for debugging, it must be
redacted or hashed before being sent to the webhook.

## Rate Limiting

Notifications are limited to one message per notification type
per minute to prevent webhook spam.

## Security

Webhook URLs must use HTTPS.

Webhook credentials must not be embedded in URLs.

Webhook URLs must never be logged.

Notification messages must not contain unnecessary PII.
