# 15 api-auth: bearer-token authentication for the UI/API server

## Goal
Verified: `server/api/server.ts` had no authentication (only a Host allow-list against DNS rebinding). Every `/api` route now requires `Authorization: Bearer <TEAMS_AI_UI_TOKEN>`.

## Approach
- `server/api/auth.ts`: constant-time compare (SHA-256 of both sides + `timingSafeEqual`), loopback check, `resolveAuth`.
- 401 `{error:'unauthorized'}` for any `/api/*` request without a valid credential. Static files stay public (the UI must load to prompt).
- No token: allowed only when the listen host is loopback (warning logged); a non-loopback host without a token makes `startApi` throw. The token is never logged.
- SSE: EventSource cannot set headers. Chosen: an HttpOnly, SameSite=Strict cookie, issued by `POST /api/auth/session` (which itself requires the bearer). Rejected: a `?token=` query parameter, because URLs leak into access logs, proxies, browser history and Referer, and the token would be long-lived there. The cookie is invisible to page JS, is not in URLs, and is accepted on GET only, so it cannot enable CSRF on mutating routes.
- Web: `web/src/auth.ts` (`authFetch`, `ensureSession`); token prompted once on a 401 and kept in sessionStorage; `api.ts` uses `authFetch`; `useSse.ts` calls `ensureSession()` before opening an EventSource.

## Files
server/api/auth.ts, server/api/server.ts, web/src/auth.ts, web/src/api.ts, web/src/useSse.ts, tests test/api/auth.test.ts and web/src/auth.test.ts.

## Verification
`npx tsc --noEmit`, `npx vitest run` (full suite).
