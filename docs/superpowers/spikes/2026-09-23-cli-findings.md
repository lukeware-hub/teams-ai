# CLI spike findings — Claude Code headless behavior

- **Date:** 2026-09-24  **CLI version in WSL:** 2.1.281  **Distro:** Ubuntu 24.04.5 (WSL2, kernel 6.18.33.2)
- **Model during probes:** `claude-opus-5-5[1m]` (subscription login, `claude.ai` auth method)
- Recordings: `docs/superpowers/spikes/recordings/*.ndjson` (scanned for secrets: none). Trimmed copies are the parser fixtures `test/fixtures/stream/real-*.ndjson`.

| # | Open item (spec §16) | Probe | Finding | Decision for Plan 3 |
|---|---|---|---|---|
| 1 | Does `--setting-sources project` + `--strict-mcp-config` stop user plugins, hooks and MCP from loading? Baseline token cost of an empty call. | p1 | **MCP removed** (1 server → 0), `commands_changed` events gone, slash commands 63 → 54, skills 27 → 18. What remains (54 commands, 18 skills, 6 agents, 2 plugins `agents-md`/`telemetry`) is **built into the CLI**, not user config. System prompt cost of an empty call: **~1.8k cache-write + 0.5k cache-read tokens isolated** vs 2.8k + 3.1k default; `total_cost_usd` 0.0148 vs 0.0234. | Keep the flags. Budget the fixed per-step overhead at ~2.5k tokens. Built-in skills/agents cannot be removed by flags; irrelevant for cost since they are listed, not expanded. |
| 2 | `--json-schema`: shape of a valid structured result; what happens when the model cannot satisfy the schema? | p2 | Valid: `result.structured_output` holds the parsed object and `result.result` holds the same JSON as text; `stop_reason: "tool_use"` (structured output is implemented as a tool call), `num_turns: 2`. Impossible request (`status: 'finished'` not in enum): **no error** — the model coerced to a valid value (`{"status":"done","specHash":""}`). | Read `structured_output`, never re-parse text. Schema conformance is guaranteed only syntactically; the semantic layer (specHash echo, reference validation) is mandatory, as designed. |
| 3 | Native turn cap available? Shape of `error_max_turns`. | p3 | `--max-turns` **absent** from `claude --help` in 2.1.281. No recording. | The runner's own cap (watch `num_turns` in `assistant` events / elapsed time, kill the process) is the only mechanism. `result` may then be missing → `summarizeStream` reports `found: false`. |
| 4 | How auto-compaction surfaces in stream-json. | p4 | `{"type":"system","subtype":"status","status":"compacting"}` → `{"type":"system","subtype":"status","status":null,"compact_result":"success"}` → `{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":79499,"post_tokens":915,...}}`. After 3 compactions within 3 turns the CLI aborts: `terminal_reason: "rapid_refill_breaker"`, **`is_error: true` with `subtype: "success"`**, result text "Autocompact is thrashing...". Also emits `system:thinking_tokens` progress events. Cost of this probe: $2.55 / 224k cache-write tokens. | Detect `compact_boundary` (count in `summarizeStream.compactions`). Treat `is_error` as authoritative, not `subtype`. Any compaction inside a step marks it suspect (spec §9A.1). Never let an agent read a file larger than the context budget: the context pack must size inputs. |
| 5 | Sandbox + deny rules hold headless. | p5, p5b | Deny rules work without the sandbox: `Read(~/.teams-ai/secrets/**)` and `Bash(gh:*)` denied (`system:permission_denied` event, `permission_denials[]` in result, `decision_reason_type: "subcommandResults"`). **Sandbox was silently disabled** at first: stderr `Sandbox disabled: ... bubblewrap (bwrap) not installed, socat not installed`. After `apt install bubblewrap socat`: outbound to `example.com` blocked by the sandbox proxy (`curl: (56) CONNECT tunnel failed, response 403`, tool result carries `<sandbox_violations>deny network-outbound example.com:443</sandbox_violations>`), `registry.npmjs.org` allowed (HTTP 200). Two traps: (a) in `--permission-mode dontAsk` a Bash call not in `permissions.allow` is denied by the mode before the sandbox is consulted; (b) **project `permissions.allow` is ignored unless the workspace is trusted** (`projects[<dir>].hasTrustDialogAccepted: true` in `~/.claude.json`, stderr warns). | Setup script installs `bubblewrap` and `socat`; runner refuses to start if stderr shows "Sandbox disabled". Runner writes the trust entry for every worktree before spawning. Allow rules per role are explicit (`Bash(npm:*)`, `Bash(curl:*)`, ...) since dontAsk denies everything else. |
| 6 | OmniRoute env redirection works with `claude -p`; subscription untouched. | p6 | **Not run** — OmniRoute is not installed yet. | Deferred to Plan 3, where the provider profile is implemented; p6 script is ready. |
| 7 | Usage-limit error shape. | p1/p4 | Every run emits `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":<epoch>,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0,"resetsAt":...},"seven_day":{"utilization":0.64,"resetsAt":...}}}}` even when allowed. The exhausted shape was not observed (status presumably `"rejected"`/`"exceeded"` with the same `resetsAt`). | Quota breaker reads `rateLimit` from `summarizeStream` **proactively**: pause before starting a step when a window utilization ≥ 0.95, resume at `resetsAt`. Fallback classification when a step fails: `status !== "allowed"` on the last `rate_limit_event`, or result text matching `/usage limit|rate limit|out of .*quota/i`. |

## Additional facts recorded

- `result` event keys (2.1.281): `duration_api_ms, stop_reason, session_id, total_cost_usd, usage, modelUsage, permission_denials, terminal_reason, fast_mode_state, subagent_stats, is_error, num_turns, subtype, api_error_status, result, structured_output?, ttft_ms, duration_ms, uuid, queued_turn_count, result_index`.
- `usage` includes `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens_details.thinking_tokens`, per-iteration breakdown, `service_tier`.
- `system:init` lists `tools, mcp_servers, model, permissionMode, slash_commands, agents, skills, plugins, claude_code_version` — useful to assert isolation at runtime (assert `mcp_servers` is empty).
- Prompt caching uses the 1h ephemeral tier by default (`ephemeral_1h_input_tokens`), which favors the stable-prefix strategy of spec §8.3.
- Windows interop: without `~/.profile` loading nvm, `bash -lc` resolves `npm`/`claude` from `/mnt/c` (Windows installs). The setup script now writes the nvm block into `~/.profile`.

## Fixture updates

- `test/fixtures/stream/real-json-schema.ndjson` — trimmed `init` + `rate_limit_event` + `result` from p2-valid.
- `test/fixtures/stream/real-compaction-breaker.ndjson` — `init`, 3× (`status` compacting / `status` result / `compact_boundary`), `result` from p4.
- Parser changes (RED→GREEN): `structuredOutput`, `terminalReason`, `rateLimit` added to `ResultSummary`; `isError` already trusted `is_error` over `subtype`. Synthesized fixtures kept for the malformed-line and killed-process cases.

## Environment checklist result

`scripts/wsl/check-tools.sh` on Ubuntu-24.04 (all required tools present; `llama-server` optional, Plan 8):

node v22.23.3 · npm 10.9.9 · git 2.43.0 · claude 2.1.281 · gh 2.101.0 · docker 29.7.2 · kind v0.29.0 · kubectl v1.36.1 · gitleaks 8.24.3 · osv-scanner 2.6.0 · graphify 0.9.67 · nvidia-smi 616.92 (RTX 3060 Ti, 8 GB, visible in WSL and in containers via `--gpus all`) · bubblewrap + socat installed after p5.

## Runner smoke (Plan 3, 2026-09-24, CLI 2.1.281, WSL)

`npx tsx scripts/smoke/real-step.ts` — one real `dev` step through `runStep` (Claude subscription, model `sonnet`):

| Attempt | Result | Finding |
|---|---|---|
| 1 | `failure: code` — `--agent 'dev' not found. Available agents: claude, Explore, ...` | **Agents in `.claude/agents` are resolved from the process cwd**, i.e. the product worktree, not the orchestrator repo. Fix: the runner passes the registry definition inline with `--agents '{"dev":{"description","prompt","tools","model"}}'` and keeps `--agent dev` to select it. |
| 2 | `failure: schema` — `(root): expected object, received null`; `stop_reason: end_turn`, `structured_output` **absent**, `result` text = fenced ```` ```json {...} ``` ```` | With `--agents` + `--json-schema` the model answered the JSON as text and never triggered the structured-output tool (p2, with `--tools ""`, did populate `structured_output`). Fix: `summarizeStream` falls back to a JSON object extracted from the result text (fences stripped) and reports `structuredSource: 'text'`; semantic validation runs on it unchanged. |
| 3 | **`ok: true`**, 1 turn, `structuredSource: text`, usage 2 in / 134 out / 8250 cache-read / 837 cache-write, `total_cost_usd` 0.0063, breaker `closed` | The agent prompt + schema are served from the 1h prompt cache on repeated steps (8.2k cache-read vs 9.1k cache-write on the first run). |

Amendment to row 2: read `structured_output` when present, otherwise the fenced/plain JSON object in `result`; either way the zod contract and the semantic checks decide.

## Review-driven verifications (Plan 3 fix pass, 2026-09-24)

| Question | Probe | Result | Decision |
|---|---|---|---|
| Does `--settings <file>` apply together with `--setting-sources project`? | temp workspace, role settings file with `Bash(cat ./secrets/*)` deny + sandbox allowlist | `cat ./secrets/x.env` → `permission_denied` event; `curl https://example.com` → `sandbox_violations: deny network-outbound example.com:443` | The orchestrator ships a per-role settings file via `--settings`; the worktree's own `.claude/settings.json` is never relied on, and agents are denied `Edit/Write(.claude/**)`. |
| Can the prompt be given on stdin? | `printf '--- not a flag\n...' \| claude -p ...` | exit 0, prompt consumed (the model answered to its content) | Prompt always on stdin; never as an argv value. |
| Hardened runner end to end (`scripts/smoke/real-step.ts`) | real `dev` step, model `sonnet` | `ok: true`, settings file written to `~/.teams-ai/settings/dev.settings.json`, no "Sandbox disabled" on stderr, 1 turn, 11.8k cache-write (fresh prefix after the prompt change) | — |
