# Architecture

This document describes how **TrustBridge Dashboard** is designed. For setup instructions see [SETUP.md](./SETUP.md). For directory layout see [PROJECT_STRUCTURE.md](./PROJECT_STRUCTURE.md).

← Back to [README](../README.md)

---

## Overview

TrustBridge Dashboard is a **Next.js 14 App Router** application that solves contributor payout coordination on Stellar:

```
GitHub Identity  ──►  Registration DB  ──►  Horizon Validation  ──►  Wave CSV Export
     (OAuth)            (Prisma/PG)         (stellar-sdk)            (Maintainers)
```

### Core responsibilities

1. **Identity binding** — Map `github_username` → `stellar_address` after GitHub OAuth
2. **Readiness validation** — Query Horizon for funding, USDC trustline, XLM balance
3. **Maintainer operations** — Aggregate view, filters, batch re-check, CSV export

---

## System diagram

```mermaid
flowchart TB
  subgraph Client["Browser"]
    LP[Landing Page]
    REG[Register Page]
    DASH[Dashboard Page]
  end

  subgraph NextJS["Next.js App Router"]
    MW[Middleware]
    API_AUTH["/api/auth"]
    API_CHECK["/api/check"]
    API_REG["/api/register"]
    API_CONT["/api/contributors"]
  end

  subgraph External["External Services"]
    GH[GitHub OAuth API]
    HZ[Stellar Horizon]
  end

  subgraph Data["Data Layer"]
    PG[(PostgreSQL)]
  end

  LP --> API_CONT
  REG --> MW
  DASH --> MW
  MW --> API_AUTH
  REG --> API_CHECK
  REG --> API_REG
  DASH --> API_CONT
  API_AUTH --> GH
  API_CHECK --> HZ
  API_REG --> PG
  API_REG --> HZ
  API_CONT --> PG
  API_CONT --> HZ
```

---

## Authentication & authorization

### GitHub OAuth (NextAuth.js)

- Provider: GitHub with scopes `read:user`, `user:email`, `read:org`
- Session strategy: **JWT** (no server-side session table required at runtime)
- On sign-in, user record is upserted in PostgreSQL with `githubId`, `githubUsername`, and `accessToken`
- The GitHub access token is **encrypted at rest** (AES-256-GCM, `TOKEN_ENCRYPTION_KEY`) before being written — see [`src/lib/token-crypto.ts`](../src/lib/token-crypto.ts) — and every encrypt/decrypt attempt is recorded in `TokenAuditLog` via [`src/lib/token-audit.ts`](../src/lib/token-audit.ts)
- The raw access token is **never** placed on the JWT or session object, so it is never sent to the browser; server code that needs it calls `getDecryptedGithubAccessToken(userId)` in `src/lib/auth.ts`

### Route protection (`src/middleware.ts`)

| Route | Requirement |
|-------|-------------|
| `/register` | Authenticated GitHub user |
| `/dashboard` | Authenticated + member of `GITHUB_MAINTAINER_ORG` (+ `GITHUB_MAINTAINER_TEAM`, if configured) |

Maintainer check flow (two-tier: org, then optionally team):

1. After GitHub OAuth, the JWT callback calls `GET https://api.github.com/user/orgs` and compares org logins against `GITHUB_MAINTAINER_ORG`.
2. If `GITHUB_MAINTAINER_TEAM` is set and the org check passed, it additionally calls `GET /orgs/{org}/teams/{team_slug}/memberships/{username}` and requires an `active` membership state. `GITHUB_MAINTAINER_TEAM` is optional — when unset, step 2 is skipped entirely and the org check alone determines maintainer status, matching prior behavior.
3. Sets `session.user.isMaintainer` boolean from the result.

**Fail closed on API errors.** Both checks treat a non-`ok` response (including `403`/`429` rate limiting) or a network failure as "not a member" rather than throwing — a GitHub outage degrades to non-maintainer access, never a crashed sign-in.

**Audit trail.** A user who passes the org check but fails the team check is recorded via `recordAuditLog` (`src/lib/audit.ts`) with action `maintainer_access_denied_team` and `{ team }` metadata, so maintainers can review near-misses through `/api/audit`. Successful checks are not logged individually to avoid noise.

Non-maintainers hitting `/dashboard` are redirected to `/register?error=maintainer`.

### Read-only GraphQL (`POST /api/graphql`)

The endpoint exposes two query fields:

- `stats` returns the same aggregate `totalContributors`, `readyCount`, and
  `readyPercent` data as `GET /api/stats`; it remains publicly readable.
- `contributors(first, after)` returns a cursor-paginated `nodes` page,
  `hasMore`, and `nextCursor`. It requires the same maintainer session as
  `GET /api/contributors/paginated`. `first` defaults to 25 and is limited to
  1–100.

The schema is intentionally allow-listed and read-only. It exposes no user
tokens, wallet-proof data, or Horizon debug payloads, and it defines no
mutation or subscription operation. Production requests cannot use schema
introspection.

Requests are JSON POST bodies with a `query` string and optional `variables`.
The endpoint rejects bodies over 16 KiB, queries deeper than 5 fields, queries
with more than 100 selected fields, and queries with a weighted cost over 2,500
(each selected contributor field costs one unit per requested row). These
limits are checked before resolver execution.
Requests are also limited to 120 per minute per client IP, matching the public
stats REST endpoint.

Example:

```graphql
query ContributorRead($first: Int!, $after: String) {
  stats {
    totalContributors
    readyCount
    readyPercent
  }
  contributors(first: $first, after: $after) {
    nodes {
      githubUsername
      stellarAddress
      readiness
    }
    hasMore
    nextCursor
  }
}
```

---

## Data model

See `prisma/schema.prisma`.

### PostgreSQL tenant isolation

All persisted models include `maintainerOrgId`. The migration
`20260828000000_add_maintainer_org_rls` enables and forces RLS with a policy
that compares this column to `current_setting('app.maintainer_org_id', true)`.
The runtime Prisma role must receive that setting through its connection URL;
an unset setting returns no rows. `trustbridge_migrator` is a separate
`BYPASSRLS` role used only by Prisma migrations. See
[`PRISMA_POOL_TUNING.md`](./PRISMA_POOL_TUNING.md) for role creation, grants,
and connection examples.

```
User
├── githubId (unique)
├── githubUsername (unique)
├── accessToken (encrypted at rest — AES-256-GCM ciphertext, never plaintext)
├── registration → Registration (1:1)
└── auditLogs → TokenAuditLog (1:many)

Registration
├── stellarAddress (unique)
├── funded, trustlineReady, xlmBalance, spendableXlmBalance
└── lastCheckedAt

TokenAuditLog
├── userId
├── action (token_encrypted_at_signin | token_encryption_skipped | token_decrypted | token_decrypt_failed)
├── success
└── createdAt
```

NextAuth adapter models (`Account`, `Session`, `VerificationToken`) are included for future database-session support but JWT is used by default.

---

## Horizon validation pipeline

Implemented in `src/lib/horizon.ts` using **stellar-sdk** `Horizon.Server`.

### `/api/check` flow

1. Validate G-address format via `StrKey.isValidEd25519PublicKey`
2. `server.loadAccount(address)` — 404 means unfunded
3. Parse native XLM balance from `account.balances`, then compute the
   **spendable** balance (`computeSpendableXlmBalance()`) by subtracting the
   Stellar minimum reserve (`BASE_RESERVE_XLM * (2 + subentry_count +
   num_sponsoring − num_sponsored)`) and any `selling_liabilities`
4. Check for matching asset trustline (`asset_code` + `asset_issuer`)
5. Compute readiness via `computeReadiness()` in `src/lib/readiness.ts`, using
   the spendable balance for the reserve check

### Readiness rules

| Condition | Status |
|-----------|--------|
| Not funded OR no trustline | `not_ready` |
| Funded + trustline, spendable XLM < `NEXT_PUBLIC_MIN_XLM_BALANCE` | `low_reserve` |
| Funded + trustline + sufficient spendable XLM | `ready` |

Default asset: **USDC** on Stellar mainnet (configurable via env).

Raw balance overstates what an account can actually spend: every Stellar
account locks up a minimum reserve for its subentries (trustlines, offers,
signers) and sponsorships, plus any XLM tied up in open sell offers. The
reserve check above therefore runs against `spendableXlmBalance`
(`spendable_xlm_balance` in the Horizon check response), not the raw
`xlm_balance`, so a funded account with trustlines eating its reserve is
correctly flagged `low_reserve` rather than `ready`.

---

## Registration flow

```mermaid
sequenceDiagram
  participant C as Contributor
  participant R as /register
  participant A as /api/check
  participant S as /api/register
  participant H as Horizon
  participant D as PostgreSQL

  C->>R: Enter G-address
  R->>A: POST (debounced)
  A->>H: loadAccount
  H-->>A: balances
  A-->>R: readiness badge
  C->>S: POST save
  S->>H: re-validate
  S->>D: upsert Registration
```

Registration enforces:

- Authenticated session
- Valid Stellar address format
- Unique `stellarAddress` across users (409 if taken)

---

## Maintainer dashboard flow

1. `GET /api/contributors` — list all registrations with computed readiness
2. **Re-check all** — `POST /api/contributors` batch-queries Horizon, updates DB
3. **Export CSV** — client-side download via `exportContributorsCsv()`

CSV columns: `github_username`, `stellar_address`, `readiness`, `funded`, `trustline`, `trustline_authorized`, `verified`, `xlm_balance`, `last_checked_at`, `spendable_xlm_balance`

---

## Contract sync

The `syncContractToPostgres()` function (`src/lib/contract-sync.ts`) performs a TRUE contract→Postgres sync, reading on-chain registrations and updating Postgres accordingly. This is distinct from Horizon re-checks, which refresh account balances and trustline status.

### How it works

1. **Fetch from contract:** Calls `get_registered_paginated()` on the Soroban contract to get all on-chain registrations
2. **Merge into Postgres:** For each on-chain registration:
   - If exists in Postgres but not in contract → keep it (don't delete)
   - If exists in contract but not in Postgres → log it (can't create without a user)
   - If exists in both → update GitHub username if changed
3. **Rate-limited:** Respects `CONTRACT_SYNC_MIN_INTERVAL_MS` to prevent hammering the RPC
4. **Never throws:** All errors are caught and returned in the result

### Merge rules

| Contract | Postgres | Action |
|----------|----------|--------|
| ✅ | ✅ | Update if GitHub username changed |
| ✅ | ❌ | Log (can't create without a user) |
| ❌ | ✅ | Keep (don't delete from Postgres) |

### Horizon re-check vs Contract sync

| Feature | Horizon Re-check | Contract Sync |
|---------|------------------|---------------|
| Purpose | Refresh account balances, trustline status | Sync on-chain registrations |
| Trigger | Manual (maintainer) or batch | Scheduler (cron) |
| Function | `refreshAllContributors()` | `syncContractToPostgres()` |
| Route | `POST /api/contributors` | `POST /api/contract-sync` |

---

| Concern | Approach |
|---------|----------|
| Server components | Landing page (stats), layout metadata |
| Client components | Register, dashboard, interactive inputs |
| Server state | React Query (`Providers.tsx`) |
| Theming | `next-themes` + CSS variables (light/dark) |
| UI primitives | shadcn/ui-style components in `src/components/ui/` |

Key components:

- `AddressInput` — debounced live `/api/check` validation
- `TrustlineStatusBadge` — readiness indicator
- `ContributorTable` — sort, filter, CSV export
- `WaveReadinessBar` — aggregate progress bar

---

## Security considerations

- **Secrets server-side only** — `GITHUB_CLIENT_SECRET`, `DATABASE_URL`, `NEXTAUTH_SECRET` never exposed to client
- **Horizon calls server-side** — `/api/check` prevents CORS/rate-limit issues and keeps validation logic centralized
- **Maintainer API guard** — `/api/contributors` verifies `isMaintainer` on every request
- **CSRF protection on mutating routes** — `POST /api/check`, `POST /api/register`, `POST /api/contributors` validate `Origin`/`Referer` against allowed hosts (see [docs/CSRF.md](../docs/CSRF.md))
- **Rate limiting on `/api/check`** — per-IP sliding window (default 10 req/min) prevents Horizon abuse; configurable via `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX_REQUESTS`
- **CSV / JSON exports** — `src/lib/csv.ts` provides `buildCsv` and `buildJson` with snapshot-tested output; used by the maintainer dashboard for Wave payout prep
- **Secrets server-side only** — `GITHUB_CLIENT_SECRET`, `DATABASE_URL`, `NEXTAUTH_SECRET`, `TOKEN_ENCRYPTION_KEY` never exposed to client
- **Tokens encrypted at rest** — `User.accessToken` is AES-256-GCM ciphertext; sign-in fails closed (stores nothing) if `TOKEN_ENCRYPTION_KEY` is missing or malformed rather than falling back to plaintext
- **No client-side access tokens** — the GitHub access token never appears on the NextAuth JWT or `session` object; it exists only encrypted in PostgreSQL, decrypted on demand server-side via `getDecryptedGithubAccessToken()`
- **Horizon calls server-side** — `/api/check` and `/api/actions/lookup` prevent CORS/rate-limit issues and keep validation logic centralized
- **Maintainer API guard** — `/api/contributors`, `/api/soroban/events`, and `/api/settings/network` verify `isMaintainer` on every request
- **Address uniqueness** — prevents duplicate payout mappings

---

## Action lookup readiness API

`GET /api/actions/lookup?address=G...` (`src/app/api/actions/lookup/route.ts`) wraps the same Horizon check used by `/api/check`, but as a cacheable `GET` that also computes a `nextAction` hint (`fund_account`, `add_trustline`, `increase_reserve`, `none`) via [`src/lib/action-lookup.ts`](../src/lib/action-lookup.ts). Results are cached for 30s per `address:asset_code:asset_issuer` key in `verificationCache` (`src/lib/cache.ts`) to absorb bursts against Horizon rate limits. The registration wizard (`AddressInput`) uses the same pure `computeNextAction()` helper to show contributors what to do next.

---

## Soroban event timeline

The maintainer dashboard's **Soroban event timeline** panel (`src/components/SorobanEventTimeline.tsx`) shows recent contract events for `SOROBAN_CONTRACT_ID`, fetched server-side via `getSorobanEventTimeline()` (`src/lib/soroban.ts`) using `stellar-sdk`'s Soroban RPC client (`SOROBAN_RPC_URL`, default `soroban-testnet.stellar.org`). Exposed through `GET /api/soroban/events` (maintainer-only). RPC outages, rate limits, or a missing `SOROBAN_CONTRACT_ID` never throw — they surface as an `errors` array the panel renders inline, with an empty event list.

---

## Network hardening

Horizon and Soroban RPC network selection is env-var driven (`NEXT_PUBLIC_HORIZON_URL`, `SOROBAN_RPC_URL`) with independent defaults that do not agree with each other — Horizon defaults to **mainnet**, Soroban RPC defaults to **testnet**. Left unchecked, this lets a maintainer validate contributor funding against one network while reading Soroban events from another with no indication anything is wrong.

[`src/lib/network-config.ts`](../src/lib/network-config.ts) classifies each resolved URL by hostname (`mainnet` / `testnet` / `custom`) and flags `mismatched: true` only when both URLs resolve to two different *known* named networks — a custom or self-hosted RPC endpoint on either side is never treated as a false positive, since it cannot be confidently classified.

- **API:** `GET /api/settings/network` (maintainer-only) returns the current classification and any warnings.
- **UI:** the `NetworkStatusPanel` component (`src/components/NetworkStatusPanel.tsx`) renders on `/dashboard`, showing the Horizon/Soroban network badges and a warning banner when mismatched.
- **Audit trail:** a mismatch writes a `network_config_mismatch_detected` entry to the existing `AuditLog` table via `recordAuditLog()`, visible through `GET /api/audit`.

This is intentionally read-only and additive — it surfaces the misconfiguration rather than attempting to auto-correct it, since the "right" network is a deployment decision, not something the dashboard can infer.

---

## Future: Soroban registry

This section covers the full lifecycle of Soroban integration: the read path that ships today, and the write-through path that is designed but intentionally **not yet implemented**.

### Read path (implemented today)

- `getSorobanEventTimeline()` (`src/lib/soroban.ts`) opens a `stellar-sdk` `rpc.Server` against `SOROBAN_RPC_URL` (default `soroban-testnet.stellar.org`), reads the latest ledger, and fetches recent events for `SOROBAN_CONTRACT_ID` over a fixed ~7-hour ledger window.
- Exposed via `GET /api/soroban/events` (`src/app/api/soroban/events/route.ts`), guarded by `isMaintainer` — same guard pattern as `/api/contributors`.
- **Never throws.** A missing `SOROBAN_CONTRACT_ID` short-circuits before any RPC call and returns `{ events: [], latestLedger: 0, errors: ["SOROBAN_CONTRACT_ID is not configured"] }`. An RPC failure (outage, rate limit, timeout) is caught and returns `{ events: [], latestLedger: 0, errors: ["Soroban RPC error: <message>"] }`. Either way the API responds `200` with an `errors` array the `SorobanEventTimeline` panel renders inline — the maintainer dashboard degrades gracefully instead of failing.
- No caching layer sits in front of this call today (unlike `/api/actions/lookup`, which caches Horizon reads for 30s in `src/lib/cache.ts`); each request re-queries the RPC endpoint. A cache would be a reasonable addition if this panel sees high-frequency polling.
- Unit coverage: `src/lib/soroban.test.ts` (success, missing config, RPC failure) and `src/app/api/soroban/events/route.test.ts` (maintainer guard: 403 for anonymous/non-maintainer, 200 with the timeline payload for a maintainer).

### Write-through path (implemented)

The write-through path is now implemented (`src/lib/soroban-register.ts`), wired into `/api/register`'s `POST` handler, with real on-chain execution logic:

- **PostgreSQL stays the source of truth.** A Soroban write is a mirror, not a replacement — dashboard reads, Wave aggregation, and CSV export continue to query Postgres exclusively.
- **Ordering:** the contract write is attempted in `/api/register`'s `POST` handler **after** `prisma.registration.upsert()` resolves successfully — never before, and never in a way that blocks or gates the Postgres write. Implementation: `mirrorRegistrationToSoroban(registration, githubUsername)` is called without `await`, allowing it to complete asynchronously after the HTTP response returns.
- **Best-effort and failure-isolated:** the write attempt is wrapped in `mirrorRegistrationToSoroban()` (`src/lib/soroban-register.ts`) so that a Soroban RPC outage, rate limit, or a missing `SOROBAN_CONTRACT_ID` can never fail the request. Follows the `getSorobanEventTimeline()` "never throw, return an `errors` array" convention — returns a `SorobanRegistrationResult` with `success` boolean and `errors[]`. Errors are logged to console but never surfaced as a request failure.
- **Zero on-chain dependency for the core flow:** contributors register successfully with `SOROBAN_CONTRACT_ID` unset (the write is skipped with no errors). Registration works end-to-end even if Soroban is down.
- **Implementation details:**
  - Uses `stellar-sdk` `rpc.Server` to connect to `SOROBAN_RPC_URL`
  - Signs transactions with `SOROBAN_SECRET_KEY` (fee-payer secret key)
  - Calls `register(contributor: Address, github_username: Bytes)` on the contract
  - Handles `PENDING` status (submitted but not yet confirmed)
  - Handles `ERROR` status with specific error codes
  - 30-second timeout for transaction submission
  - Never throws — all errors are caught and returned in the `errors` array

### Edge cases

| Case | Read path (today) | Write-through (design) |
|------|--------------------|--------------------------|
| RPC outage / timeout | Caught, `errors: ["Soroban RPC error: ..."]`, empty events, `200` response | Caught, logged, registration still succeeds |
| Missing/invalid `SOROBAN_CONTRACT_ID` | Short-circuits before any RPC call, `errors: ["SOROBAN_CONTRACT_ID is not configured"]` | Write attempt skipped entirely; registration unaffected |
| Rate limiting | Same as outage — surfaces in `errors`, no throw | Same as outage — best-effort, never blocks Postgres |

### Out of scope for this iteration

End-to-end/browser coverage (e.g. Playwright) for the event timeline panel and any future write-through flow is a deliberate follow-up, not a gap in this pass — this repo currently has no Playwright/e2e harness, and adding one is a separate infrastructure change (new CI browser setup) tracked independently of this documentation and unit/API test work.

---

### Unified Transactional Outbox for Soroban write-through (#199, #488)

To ensure reliable write-through to Soroban without losing registrations during chain or RPC outages, while supporting fast, hermetic unit tests:

1. **Unified Outbox Abstraction (`src/lib/soroban-outbox.ts`):** Unifies production transactional writes with an in-memory adapter sink (`setSorobanOutboxSink`) for unit tests. In production runtime, `enqueueSorobanOutbox()` creates persistent `SorobanOutbox` rows in PostgreSQL (scoped by `maintainerOrgId`). In tests, the registered sink handles delivery directly in memory without database dependencies.
2. **Transactional Enqueue:** During registration write paths, `enqueueSorobanOutbox()` stages the mirror payload with `status: PENDING`. Duplicate exports have been consolidated under `src/lib/soroban-outbox.ts`.
3. **Outbox Worker (`processSorobanOutbox()`):** Background workers (`scripts/worker.mjs` / `src/lib/soroban-outbox-worker.ts`) periodically fetch pending outbox rows and invoke `mirrorRegistrationToSoroban()`.
4. **At-Least-Once Delivery & Audit Trail:** On success, outbox records transition to `COMPLETED`. On failures, records retry with exponential backoff up to `maxAttempts` (default 5). If `maxAttempts` is exhausted, status transitions to `FAILED` and an audit event (`soroban_outbox_exhausted`) is logged.

---

### Soroban Event Cursor & Backfill (#198)

To support historical event timeline syncing without missing past ledger events:

1. **Persistent Event Cursor (`SorobanEventCursor`):** Stores event paging tokens and cursors per `maintainerOrgId` + `eventType` in `prisma.sorobanEventCursor`.
2. **Background Backfill (`backfillSorobanEvents()`):** `src/lib/soroban-events-backfill.ts` processes historical events idempotently and persists the latest paging token.
3. **Non-Blocking:** Backfills run asynchronously in background workers without blocking HTTP requests.

---

## CORS Policy

The trustbridge-action runs **server-side** (Node.js fetch in GitHub Actions), so CORS does not apply to its calls. However, the public endpoints `/api/actions/lookup` and `/api/check` may be called from browser-based tools (Swagger UI, custom scripts), so we lock them down defensively.

### Configuration

CORS headers are applied via `next.config.mjs` → `headers()`:

| Header | Value |
|--------|-------|
| `Access-Control-Allow-Origin` | `https://github.com` |
| `Access-Control-Allow-Methods` | `GET, POST, OPTIONS` |
| `Access-Control-Allow-Headers` | `Content-Type, Authorization, X-Cache-Bypass` |
| `Access-Control-Max-Age` | `86400` (24 hours) |
| `Vary` | `Origin` |

### Security constraints

- **Single origin, no multi-value lists.** The CORS specification requires `Access-Control-Allow-Origin` to specify either a single origin or `*`. Browsers reject comma-separated origin lists. Next.js statically sets `ALLOWED_ORIGIN`. Dynamic origin checking across multiple domains can be handled dynamically in middleware or route handlers if needed.
- **No wildcard (`*`) with credentials.** The allowed origin is explicitly specified.
- **Default deny.** Only the two paths above receive CORS headers. Authenticated endpoints (`/api/register`, `/api/contributors`, `/api/stats`) are same-origin only.
- **No credentials header.** `Access-Control-Allow-Credentials` is intentionally omitted — these endpoints don't use cookies.
- **To configure the allowed origin**, update `ALLOWED_ORIGIN` in `next.config.mjs`.

### Tests

CORS configuration is tested in `tests/unit/cors.test.ts`:
- Verifies correct origins are allowed
- Verifies no wildcard origin
- Verifies authenticated endpoints are excluded

---

## Related docs

- [Project structure](./PROJECT_STRUCTURE.md)
- [Environment variables](./ENVIRONMENT.md)
- [Deployment](./DEPLOYMENT.md)
- [Contributing](./CONTRIBUTING.md)
