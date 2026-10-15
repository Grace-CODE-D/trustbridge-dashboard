# CSRF Protection

TrustBridge Dashboard uses stateless **origin validation** to protect mutating API routes from Cross-Site Request Forgery (CSRF) attacks.

← Back to [README](../README.md)

---

## Threat model

Without CSRF protection, a malicious page could trick an authenticated maintainer or contributor into performing unwanted actions:

- An attacker site submits a hidden `<form>` to `POST /api/register`, overwriting the contributor's payout address to an attacker-controlled G-address
- An attacker triggers `POST /api/contributors` (batch re-check), exhausting Horizon API quota at 100+ contributor scale
- An attacker triggers `POST /api/contributors/[id]` (single-contributor recheck), forcing an unwanted re-check of a contributor's account

Because the application uses **cookie-based session authentication** (NextAuth JWT cookie), these requests would otherwise inherit the victim's session automatically.

---

## Protected routes

Every mutating route handler under `src/app/api/` calls `assertSameOrigin` from `src/lib/csrf.ts` before any downstream logic. The table below lists all mutating (non-safe) API routes and their CSRF protection status, followed by the read-only routes for completeness.

### Mutating routes (CSRF-checked)

| Route | Method | Protected |
|-------|--------|-----------|
| `/api/check` | POST | Yes |
| `/api/register` | POST | Yes |
| `/api/contributors` | POST | Yes |
| `/api/contributors/[id]` | POST | Yes |
| `/api/auth/[...nextauth]` | POST | No (handled by NextAuth internal CSRF) |

### Sensitive read routes (CSRF token-validated)

| Route | Method | Protected |
|-------|--------|-----------|
| `/api/address-history` | GET | Yes (requires valid CSRF token via `x-csrf-token` header or `csrfToken` query param) |

Sensitive read endpoints exposing payout timeline data enforce CSRF token validation via `validateCsrfToken` in `src/lib/csrf.ts` in addition to session authentication. This prevents cross-site data exposure and unauthorized history queries.

### Read-only routes (safe methods)

| Route | Method | Protected |
|-------|--------|-----------|
| `/api/auth/[...nextauth]` | GET | No (handled by NextAuth internal CSRF) |
| `/api/stats` | GET | No (read-only, safe method) |
| `/api/contributors` | GET | No (read-only, auth already enforced) |
| `/api/contributors/[id]` | GET | No (read-only, auth already enforced) |
| `/api/register` | GET | No (read-only, auth already enforced) |

---

## Mechanism

`src/lib/csrf.ts` enforces a simple, stateless policy:

1. **Safe methods bypass** — `GET`, `HEAD`, `OPTIONS` are never checked
2. **Origin check** — If the `Origin` header is present, its host must match one of the allowed hosts:
   - `x-forwarded-host` header
   - `host` header
   - Request URL host (fallback for tests/serverless)
   - `NEXTAUTH_URL` host (covers proxy/CDN scenarios; malformed values are ignored gracefully)
3. **Referer fallback** — If `Origin` is absent, `Referer` is checked the same way
4. **Non-browser allowance** — If both `Origin` and `Referer` are absent, the request is allowed. Non-browser API clients (curl, scripts, server-to-server) do not carry a browser session cookie, so they pose no cookie-based CSRF risk

---

## Error shape

When a request is rejected:

```json
{
  "error": "Invalid request origin"
}
```

HTTP status: `403 Forbidden`

This error is **distinct** from authentication and authorization errors:

| Layer | Status | Body |
|-------|--------|------|
| CSRF | 403 | `{ error: "Invalid request origin" }` |
| Not authenticated | 401 | `{ error: "Unauthorized" }` |
| Not a maintainer | 403 | `{ error: "Forbidden" }` |

Tests rely on this distinction to assert the correct layer rejected the request.

---

## Non-browser clients

If you call the API from a server, curl, or script, you do not need to send an `Origin` header (it will be allowed automatically). If you do send one, it must match the app's host.

### Example: curl (no Origin)

```bash
curl -X POST https://your-app.com/api/check \
  -H "Content-Type: application/json" \
  -d '{"address":"G..."}'
```

### Example: fetch from another server

```js
fetch("https://your-app.com/api/check", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ address: "G..." }),
});
```

---

## Environment & configuration

No new environment variables are required. `NEXTAUTH_URL` is used as an **additional allowed origin** if set. If `NEXTAUTH_URL` is malformed, the check degrades gracefully to the request host.

| Variable | Role |
|----------|------|
| `NEXTAUTH_URL` | Optional extra allowed origin (e.g., production canonical URL behind a proxy) |

---

## Testing

All CSRF behavior is covered by automated tests.

### Run tests

```bash
npm run test        # all unit + API tests
npm run test:unit   # unit tests only
npm run test:api    # API route handler tests only
```

### What is tested

- **Unit** (`tests/unit/csrf.test.ts`): same-origin pass, cross-origin 403, `x-forwarded-host`, `NEXTAUTH_URL`, Referer fallback, non-browser allowance, port mismatch, malformed Origin
- **API** (`tests/api/*.test.ts`): each route asserts that a foreign Origin returns 403 before any downstream logic (Horizon/Prisma/session) is touched, and that same-origin requests proceed to the auth layer

---

## Known limitations & future hardening

| Hardening | Status | Notes |
|-----------|--------|-------|
| Strict mode (deny missing Origin) | Future | Could add `CSRF_STRICT=true` env toggle for high-security deployments |
| Custom header defense (`X-Requested-With`) | Future | Lightweight but requires client-side header injection on every `fetch` |
| Rate-limiting `/api/check` | Future | Public POST endpoint; CSRF reduces abuse surface but does not replace rate limits |
| Playwright end-to-end tests | Future | E2E hermetic tests were descoped from Wave #19; can be added to `tests/e2e/` later |

---

## Related docs

- [Architecture overview](./ARCHITECTURE.md)
- [Environment variables](./ENVIRONMENT.md)
- [Contributing guide](./CONTRIBUTING.md)
