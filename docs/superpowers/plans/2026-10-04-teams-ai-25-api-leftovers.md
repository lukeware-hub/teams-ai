# Plan 25: API leftovers (audit M5 idle timeout, clone DNS rebinding)

## 1. SSE lifetime
- `startApi` takes `sseTimeouts { lifetimeMs, idleMs }` (defaults 30 min / 10 min). Each stream gets two timers; the idle one is refreshed on every event. On expiry the server writes `event: reconnect` and ends the response; timers are cleared on close and unref-ed.
- The browser `EventSource` reconnects by itself after a clean end and sends `Last-Event-ID`; `useJournal` keeps the source open on anything but `end` and drops replayed seqs. Test added in `web/src/useSse.test.tsx`.

## 2. Clone host rebinding
Options:
- (a) Clone via the pinned IP in the URL plus `http.extraHeader: Host:`. Rejected: plain git/curl then verifies the certificate against the IP and sends no SNI, so TLS fails against real hosts; disabling verification is not acceptable. `http.curloptResolve` needs a newer git than we can assume.
- (b) Chosen: refuse a host that does not resolve (previously allowed), keep refusing private/loopback/link-local results, resolve once up front.

Remaining window: git resolves again at clone time, so a record that flips between the check and the clone is not caught. Mitigations already present: the allowlist (`github.allowedHosts`, default github.com only), `http.followRedirects=false`, and cluster egress rules. Operators should keep the allowlist to hosts they control.

## Tests
`test/api/security.test.ts` (reconnect event on lifetime and idle; unresolvable host refused), `web/src/useSse.test.tsx`.
