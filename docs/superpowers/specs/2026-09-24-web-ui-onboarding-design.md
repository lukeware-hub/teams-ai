# teams-ai — Web UI Onboarding (design)

Companion to `2026-09-23-teams-ai-poc-design.md` (the POC spec). This document designs the first slice of the Web UI (POC spec §11): a browser-only onboarding that gets the orchestrator host authenticated and configured without the user touching a terminal. Everything else about the UI (run views, Gate 1, validation) stays in the POC spec and later designs.

## 1. Purpose

The orchestrator runs in WSL and drives two CLIs that need a login (`claude`, `gh`), one configuration value (GitHub owner) and two secrets (GitHub token, OpenRouter key). Today each of those is a terminal ritual. The onboarding turns them into one guided screen: the server runs the CLI login flows behind a pseudo-terminal, shows the user the link and the one-time code, accepts the code the browser hands back, and verifies every item with a real probe.

### 1.1 Success criteria

- A fresh WSL host with `claude`, `gh`, Node and the orchestrator installed reaches "all five items green" from the browser alone.
- No secret value is ever returned by the API, written to a log, or shown in the UI after being entered.
- Every item's "green" comes from a live probe (CLI status or API call), never from "the user clicked save".
- Each item can be redone later from a status screen (tokens expire, accounts change).
- `npm test` covers the login state machine, the pty driver and the API against fake CLIs; no test touches the real CLIs or the network.

### 1.2 Non-goals

- Multi-user, authentication of the UI itself, HTTPS, exposure beyond `127.0.0.1` (POC spec §1.4).
- Managing project-level secrets (`secrets/<projectId>.env`); that stays with Gate 1.
- SSH keys for GitHub; git protocol is fixed to HTTPS.
- Replacing the CLIs' own credential stores. Claude Code and gh keep owning their tokens.

## 2. Architecture

```
web/                              React + Vite. Routes: /onboarding, /status (redirect to /onboarding while any item is red)
server/api/server.ts              node:http on 127.0.0.1:<port>; routes REST + SSE; serves web/dist in production
server/api/onboarding-routes.ts   handlers for §5
server/onboarding/status.ts       computes the five items (§4)
server/onboarding/login-session.ts one CLI login as a state machine (§3)
server/onboarding/pty.ts          Pty interface + `script`-based implementation
server/onboarding/probes.ts       claude auth status --json, gh auth status, gh api, one Jev call
server/onboarding/transcripts.ts  regexes that pull URL / one-time code / "paste code" prompt out of pty output
server/core/secrets.ts            + writeSecret(dir, name, value): 0600, atomic rename
```

- No new server dependency. The API is `node:http`; SSE is a chunked `text/event-stream` response. The web app is the first use of React + Vite in the repo (POC spec §11 already fixes that stack).
- Dev mode: `vite` dev server with a proxy for `/api` to the API port. Production: the API serves `web/dist` statically.
- The server binds `127.0.0.1` only. The browser on Windows reaches it through WSL's localhost forwarding.
- Every child process (CLI login, probe) gets the runner's sanitized environment (`sanitizeEnv`, POC spec §3.3) plus `HOME`, so no host secret leaks into a CLI that echoes its environment.

## 3. Login session (Claude and gh)

One state machine serves both CLIs; only the command line and the transcript regexes differ.

```
idle → starting → awaiting-browser → [awaiting-code] → verifying → done
                       │                   │              │
                       └───────────────────┴──────────────┴──→ failed { reason }
```

| State | Meaning | UI |
|---|---|---|
| `starting` | Process spawned, no URL yet | Spinner |
| `awaiting-browser { url, code? }` | URL found in output; for gh also the one-time code | "Open link" button; gh shows the code to type on GitHub |
| `awaiting-code` | CLI printed its "paste the code" prompt (Claude flow) | Text field + "Send"; the server writes the code plus newline to the pty |
| `verifying` | Process exited 0 or printed its success line; probe running | Spinner |
| `done { detail }` | Probe green (email + plan, or gh account) | Green item |
| `failed { reason }` | Non-zero exit, probe red, timeout, or user cancel | Red item + "Retry" |

Rules:
- One live session per CLI. Starting a new one while another is live kills the old process first.
- Timeout 10 minutes from `starting`; on timeout the process is killed and the state is `failed { reason: 'timeout' }`.
- The pty output is redacted with `redactSecrets` before it is stored or streamed. The raw output is never persisted; the last 4 kB (redacted) are kept in memory for the UI's "show CLI output" toggle and for the failure reason.
- One-time codes and pasted codes are never persisted or logged.
- The success of a session is the probe, never the process exit code alone (POC spec §7 idempotency spirit: state comes from observation).

### 3.1 Claude flow (assumed from the observed OAuth URL; validated in implementation)

Command: `claude auth login --claudeai`. Expected transcript: a `https://claude.com/cai/oauth/authorize?…` URL, then a prompt asking for the code the callback page shows. The user completes the browser flow, copies the code (`<code>#<state>` form), pastes it in the UI. Server writes it to the pty. Then `claude auth status --json` must report `loggedIn: true`; the UI shows `email` and `subscriptionType`.

If the CLI instead completes on its own (a local callback), the state goes `awaiting-browser → verifying` and the code field never appears. The parser handles both.

### 3.2 gh flow (observed)

Command: `gh auth login --hostname github.com --web --git-protocol https --skip-ssh-key`. Transcript: `! One-time code (XXXX-XXXX) …` then `Press Enter to open https://github.com/login/device …`. The server extracts the code and the URL, shows both, and writes Enter itself (the CLI would try to open a browser inside WSL, which does not exist). The CLI polls GitHub until the user enters the code; on success it prints `✓ Logged in as <account>` and exits 0. Probe: `gh auth status` must list `github.com` as logged in; the UI shows the account.

### 3.3 Pty driver

```ts
interface Pty { write(data: string): void; kill(): void; onData(cb: (chunk: string) => void): void; onExit(cb: (code: number | null) => void): void }
spawnPty(spec: { bin: string; args: string[]; env: Record<string, string> }): Pty
```

Implementation: `script -qfec "<bin> <args>" /dev/null` (util-linux, present on the WSL Ubuntu image). `script` allocates a real pty, so both CLIs behave as in a terminal; the orchestrator writes to `script`'s stdin and reads its stdout. Arguments are shell-quoted. If validation shows `script` cannot carry the flow (for example the Claude CLI probing terminal size), the implementation switches to `node-pty` behind the same interface; that is the only allowed new dependency for this design.

## 4. Onboarding items

| # | Item | Stored where | Probe (defines green) | UI detail shown |
|---|---|---|---|---|
| 1 | Claude login | `~/.claude/.credentials.json`, owned by the CLI; never read or copied | `claude auth status --json` → `loggedIn === true` | `email`, `subscriptionType` |
| 2 | GitHub owner | `config.json` → `github.owner` (POC spec §3 config) | `gh api users/<owner>` or `gh api orgs/<owner>` returns 200 (uses the gh login or `GH_TOKEN`) | owner, type (user/org) |
| 3 | gh login | `~/.config/gh/hosts.yml`, owned by gh | `gh auth status` reports `github.com` logged in | account name |
| 4 | GitHub token | `~/.teams-ai/secrets/GITHUB_TOKEN` (0600) | `GH_TOKEN=<value> gh api user` returns 200 | login of the token's user, `X-OAuth-Scopes` header |
| 5 | OpenRouter key | `~/.teams-ai/secrets/OPENROUTER_API_KEY` (0600) | one `noul` question to Jev through `JevOpenRouterBackend` (POC spec 10A.2) returns `ok: true` | model id, cost of the probe |

- `status()` recomputes all five live on every request; there is no cached "onboarded" flag. The UI treats "any item red" as "onboarding needed".
- Secrets are written with `writeSecret`: temp file in the same directory, `chmod 600`, `rename`. A probe failure after writing keeps the file (the value may be right and the network wrong) but the item stays red with the probe's message.
- The GitHub token exists in addition to the gh login because the orchestrator's own `gh`/`git` calls and the project pipelines run with `GH_TOKEN` (POC spec §3.2 git unit); the interactive gh login is for the human's convenience and for `gh api` probes.
- Both secrets feed the existing `loadSecrets` reader; the decision layer picks up `OPENROUTER_API_KEY` from there with no change.

## 5. API

All routes under `/api/onboarding`, JSON in and out, `127.0.0.1` only.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/status` | — | `{ items: { claude, githubOwner, ghLogin, githubToken, openrouterKey }: { ok: boolean; detail: string; secret?: { set: boolean; hint: string } } }` |
| POST | `/claude/login` | — | `202 { state }` |
| POST | `/claude/code` | `{ code }` | `202 { state }` or `409` when not in `awaiting-code` |
| POST | `/claude/cancel` | — | `200 { state }` |
| GET | `/claude/events` | — | SSE: one `state` event per transition, `output` events with redacted chunks |
| POST | `/gh/login`, `/gh/cancel`; GET `/gh/events` | — | same shapes as Claude |
| PUT | `/github-owner` | `{ owner }` | `200 { item }` after probe; `400` when the owner fails the slug/GitHub name pattern |
| PUT | `/secrets/GITHUB_TOKEN` | `{ value }` | `200 { item }` after write + probe; value never echoed |
| PUT | `/secrets/OPENROUTER_API_KEY` | `{ value }` | same |

- `hint` is the last 4 characters of the stored secret, nothing more.
- Request bodies are never logged. Server logs carry route, status and duration.
- SSE reconnection replays the current state on connect.

## 6. Web UI

- `/onboarding`: five cards in order, each with its own state (red/yellow/green), the action for that item, and a collapsible "CLI output" for the two login cards. A card can be redone at any time. A "Continue" button appears when all five are green and leads to the run views (later design).
- `/status`: the same five cards, compact, reachable from the app header.
- Copy is in English (repo rule); nothing is hard-coded to a Portuguese UI.
- The UI never receives a secret value back; input fields are cleared after a successful save.

## 7. Security

- Bind `127.0.0.1`; refuse `Host` headers that are not `localhost`/`127.0.0.1` (blocks DNS-rebinding from a web page).
- Child processes: sanitized env + `HOME`; `GH_TOKEN` is passed only to the token probe, never to the interactive gh login.
- `redactSecrets` on every pty chunk and probe output before storage or streaming; known values = the two secrets and any one-time code seen.
- Secrets directory `0700`, files `0600`, atomic write. Never under `/mnt`.
- No secret leaves the host except to its own service (GitHub, OpenRouter) during its probe.

## 8. Error handling

| Failure | Response |
|---|---|
| `claude` or `gh` binary missing | Item red with "binary not found", link to POC spec §15 prerequisites |
| `script` missing | Same message for both login cards; suggests `apt install bsdutils` |
| Login timeout (10 min) | Process killed, `failed { reason: 'timeout' }`, Retry |
| Code rejected by the CLI (non-zero exit after paste) | `failed` with the redacted last output line |
| Probe network error | Item stays red with the error; stored value kept |
| Second login started while one is live | Old process killed, new session starts |
| Server restart mid-login | In-memory session lost; UI shows `idle`; user retries. CLI credential stores are unaffected |

## 9. Testing

- `test/fixtures/fake-cli/claude.sh` and `gh.sh`: shell scripts that print recorded transcripts with small delays, read a pasted code from stdin (Claude) or exit after a delay (gh), and support scenarios via an env var (`FAKE_CLI_SCENARIO=success|bad-code|timeout|no-url`).
- Pty driver: spawns the fake through `script`, asserts chunks arrive and stdin writes reach the child. Skipped automatically when `script` is unavailable (Windows host running the suite), and the CI/WSL run exercises it.
- Login session: fed with recorded chunks directly (no process), asserts every transition in §3 including timeout (fake clock) and cancel.
- Status and probes: probe functions take an `Exec` (POC spec Plan 4) and a `fetch`; tests use the scripted fake exec and a fake fetch.
- API: real `node:http` server on an ephemeral port, real requests, SSE read as a stream; secrets written into a temp dir; asserts no secret value appears in any response body.
- Web: Vitest + Testing Library for the card state rendering from a status payload and for the code field appearing only in `awaiting-code`. Live end-to-end (real Claude, real gh, real key) is a manual task at the end of the plan, like the smoke scripts of Plans 4 and 5.

## 10. Open items to validate during implementation

1. Exact transcript of `claude auth login --claudeai` without a browser: URL line, presence and wording of the "paste code" prompt, whether it also accepts the `code#state` form the callback page shows.
2. Whether `script -qfec` is enough for the Claude CLI (it may probe terminal size or `TERM`); fallback is `node-pty`.
3. `gh auth login --web` behaviour when Enter is written before the user finished on GitHub: it should keep polling; if it exits, the server writes Enter only after a short delay.
4. Whether `claude auth status --json` reflects the new login immediately after the process exits or needs a short retry loop.
