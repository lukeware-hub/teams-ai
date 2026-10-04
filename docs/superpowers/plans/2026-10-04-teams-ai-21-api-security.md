# 21 api-security: audit H2, M1, M3, M4, M5, L1-L6 and in-cluster Host configuration

## Goal
Close the API and web findings of `docs/superpowers/security/2026-10-04-system-audit.md` (H2, M1, M3, M4, M5, L1, L2, L3, L4, L5, L6) and finish plan 15 for in-cluster use (configurable allowed Hosts, tests for `useSse` and `ensureSession`). Every claim was re-read against the code before acting.

## Approach
- H2: every non-GET request needs `Content-Type: application/json` (415 otherwise). Requests to `/api/*` without a valid bearer are cross-site checked: `Sec-Fetch-Site` must be `same-origin`/`none` when present, else `Origin` must match `Host`. All responses carry `X-Frame-Options: DENY` and a CSP with `frame-ancestors 'none'`. The web `ensureSession` and body-less POSTs now send the JSON content type.
- L3: `server/api/security.ts` holds the headers (nosniff, no-referrer, CSP `default-src 'self'` with inline styles allowed for React style attributes), applied to API, SSE and static responses.
- L1/L2: `SAFE_ID` rejects `.`/`..` (and leading dots); static prefix check uses `resolve(dir) + path.sep`.
- M1: `POST /projects` accepts only hosts in `github.allowedHosts` (config, default `github.com`), refuses loopback/private/link-local literals and internal names, and resolves the name (injectable) refusing private answers; clone runs with `http.followRedirects=false` and `--`; git stderr is not echoed. The `dir` branch only accepts directories under `paths.workspaces`; parser messages are not echoed.
- M3/M4/L5: `loadSecretValues(dir)` is read per call. `ui.log` tails are redacted. Onboarding re-reads secrets on every transcript chunk (no startup cache). `redactSecrets` masks known values of 3 to 7 characters as whole tokens (longer ones anywhere; 1-2 characters stay unmasked, they would shred ordinary output), URL-encoded and base64 forms in all three byte alignments, and more key shapes (Google, Slack, Stripe, npm, JWT, PEM blocks, `password:`/`api_key`-style pairs).
- M5: global and per-address SSE caps (503), `headersTimeout`/`requestTimeout`, and one shared journal poller per file with per-subscriber catch-up.
- L4: the refine secret route returns `{ present: true }` only. The audit named one site; two more returned secret characters (`server/refine/session.ts` snapshot and `server/onboarding/status.ts` `hint()`) and now return `****`.
- L6: `web/src/safeUrl.ts` `safeHttpUrl()` used at the three `href` sites.
- Plan 15: `TEAMS_AI_ALLOWED_HOSTS` (comma list) extends the loopback default; tests for `useSse` and `ensureSession`.

## Files
server/api/{server,security,run-index,run-routes,onboarding-routes,refine-routes,journal-tail}.ts, server/core/{redact,secrets}.ts, server/config/config.ts (one field, owned elsewhere), server/cli.ts (pass secrets dir; one line), web/src/{auth,safeUrl}.ts, LoginCard, TaskDetail, Run, tests.

## Verification
`npx tsc --noEmit`, `npx vitest run` on touched tests, full suite, web tests.
