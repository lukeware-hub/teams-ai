# teams-ai POC — Design Spec

- **Date:** 2026-09-23
- **Status:** Draft — awaiting human review
- **Type:** Proof of concept

## 1. Purpose

Build a small team of AI agents (SM, PO, Dev, Test, DevOps) that turns human-written product documentation into a deployed, tested service with no human intervention between documentation approval and deployment.

### 1.1 Human responsibilities (the only two human touchpoints)

1. **Documentation / project definition (Gate 1 — Refinement).** The human describes what the project is, what it does, who uses it, and its objectives. Tasks and stack are optional inputs. SM/PO agents validate the documentation and ask as many questions as needed until it is unambiguous. This applies both to starting a new spec and to continuing an existing one.
2. **Validation (after deploy).** The human verifies the service is up and performs exploratory functional testing. Problems found are reported back into Gate 1 as a continuation of the same spec.

Everything else — technical spec, plan, tasks, implementation, tests, code review, commit, push, PR, merge, deploy — is executed by agents under orchestrator control. There is **no** human approval of PRs or merges.

### 1.2 Core architectural rule

> **Agents decide, propose and generate. The orchestrator validates, executes and changes state.**

LLM output never directly causes a state transition. Every agent output is schema-validated, then semantically validated, and only then applied. Every command (lint, test, build, git, gh, docker, kubectl) is executed by the orchestrator, never by an agent.

### 1.3 Success criteria for the POC (golden run)

Using a reference spec (a small TODO REST API with 4–5 acceptance criteria):

- Zero human interaction between "Start" and `awaiting-validation`.
- Every acceptance criterion has `passed` evidence in JUnit output.
- Successful deploy to both `docker-local` and `kind`, with green acceptance smoke tests against the running service.
- Zero duplicate PRs; `main` stays green after every merge.
- Three runs compared on tokens, retries, wall time, blocked tasks and escalation rate:
  1. Baseline — Claude only, System 1 layer disabled.
  2. Mixed — OmniRoute for Test/DevOps, System 1 disabled.
  3. Full — OmniRoute for Test/DevOps, System 1 layer enabled (see 10A).

### 1.4 Non-goals

- Multi-user, authentication, or remote hosting of the orchestrator UI.
- Cloud/PaaS deploy targets (the adapter interface allows adding them later).
- Database migration management and rollback of schema changes.
- SAST, container scanning and IaC validation gates.
- Vector-embedding RAG.
- Graph visualization in the UI; config editing via UI.

## 2. Decisions summary

| Topic | Decision |
|---|---|
| Agent runtime | Claude Code CLI in headless mode (`claude -p`), agents defined in `.claude/agents/*.md`. No Agent SDK, no `ANTHROPIC_API_KEY`. |
| Orchestration | TypeScript/Node orchestrator owns a deterministic, event-sourced state machine; one `claude -p` process per step. |
| Host environment | WSL2 (Ubuntu). Claude Code native sandbox for agent processes. |
| Human interface | Local web UI (React + Vite) served by the orchestrator (Fastify, REST + SSE). |
| Product stack | Free. Chosen by the Dev agent (recorded as ADR) unless the human states a constraint. |
| Git hosting | GitHub, one new repository per project, owner configurable (`github.owner`, defaults to the authenticated `gh` user). |
| Code review | Test agent (tests + diff review). |
| Failure policy | Dev retries up to 3 times per task → SM replans once → task becomes `blocked`; dependents stop, independents continue. |
| Parallelism | SM declares `dependsOn` and `affectedPaths`; orchestrator runs independent tasks in parallel, max 3. |
| Merge | Serialized merge queue owned by the orchestrator. No human merge approval. |
| Deploy targets | Pluggable `DeployTarget` interface; POC ships `docker-local` and `kind` adapters. |
| Models | Per-role, configurable: `opus` for SM/PO/Dev, `sonnet` for Test/DevOps (Claude subscription). |
| Free LLMs | OmniRoute gateway, per-role provider profile; POC uses it for Test, DevOps and report steps with a pinned model. |
| Knowledge | Structured JSON contract (lookup by ID) + graphify code graph + BM25 text retrieval (SQLite FTS5). |
| Fast decisions | System One–style decision layer (Choice / Score / Noul) on a local 7–9B model via llama.cpp with logprobs; low confidence escalates to Claude agents. |

## 3. Architecture

### 3.1 Repository layout (teams-ai itself)

```
teams-ai/
├─ .claude/agents/          sm.md, po.md, dev.md, test.md, devops.md
├─ .claude/settings.json    project-scoped settings for agent runs (sandbox, permissions)
├─ schemas/                 project.schema.json, spec.schema.json, plan.schema.json,
│                           one output schema per agent step (refine, tech-spec, coverage,
│                           plan, dev-result, review, deployment, report)
├─ server/
│  ├─ runner/               spawns claude processes; the only unit aware of the CLI
│  ├─ validators/           schema → semantic → transition; DAG, coverage, consistency
│  ├─ pipeline/             event-sourced phase state machine
│  ├─ scheduler/            DAG + affectedPaths, maxParallel, retry/replan/blocked, deadlock
│  ├─ exec/                 command runner: gates in disposable containers
│  ├─ git/                  git controller + merge queue (idempotent)
│  ├─ evidence/             JUnit XML parser → AC evidence matrix
│  ├─ knowledge/            context pack builder, graphify wrapper, FTS5 retrieval
│  ├─ deploy/               DeployTarget interface + docker-local, kind adapters
│  ├─ budget/               token accounting, budgets, concurrency governor, quota breaker
│  ├─ decide/               System 1 decision layer: choice/score/noul, backends, policies, calibration
│  ├─ store/                state.json + events.ndjson persistence
│  └─ api/                  REST + SSE
├─ web/                     React + Vite UI
└─ test/                    unit, contract, integration fixtures (fake claude binary, JUnit samples)

~/.teams-ai/                runtime data (outside the repo)
├─ config.json              global config (roles, providers, budgets, github.owner)
├─ secrets/<projectId>.env  secret values; never visible to agents
└─ workspaces/<projectId>/
   ├─ repo/                 clone of the product repository (main)
   ├─ worktrees/<taskId>/   one git worktree per running task
   ├─ graph/                graphify output for main (never committed)
   └─ runs/<runId>/         state.json, events.ndjson, steps/<stepId>.ndjson (raw agent streams)
```

### 3.2 Units and boundaries

- **runner** — Input `{role, prompt, contextPack, schema, cwd, budget, providerProfile}`; output: validated JSON result plus an event stream. Builds the `claude -p` invocation (see 3.3), enforces timeout and turn/token caps by watching the stream and killing the process, records usage. Nothing else in the system knows a `claude` binary exists; the binary path is configurable (`CLAUDE_BIN`) so tests can substitute a fake.
- **validators** — Pure functions. JSON Schema validation, then semantic checks (DAG acyclic, every AC covered by at least one task, evidence references exist, frozen files untouched, spec↔plan↔tasks consistency). Only a validated result may trigger a transition.
- **pipeline** — Owns the phase state machine. Records an intent event before every side effect and a confirm event after it. Contains no agent logic.
- **scheduler** — Pure logic over the task DAG: returns the next runnable tasks respecting dependencies, path overlap, `maxParallel` and the LLM concurrency semaphore. Handles retry counters, replan trigger, `blocked` propagation and deadlock detection. Testable without any LLM.
- **exec** — Runs gate commands in disposable Docker containers with CPU, memory and time limits, network disabled for test gates. Secrets are injected only here and only for steps that require them.
- **git** — The only unit that commits, rebases, pushes, creates PRs and merges. All operations are idempotent and keyed by deterministic IDs. Hosts the merge queue.
- **evidence** — Parses JUnit XML, maps tests tagged `[AC-xxx]` to acceptance criteria and tasks, and produces the evidence matrix.
- **knowledge** — Builds the per-step context pack from the JSON contract (by ID), graphify queries and FTS5 retrieval.
- **deploy** — `DeployTarget` interface: `validate()`, `apply()`, `verify()` (readiness + healthcheck), `smoke()`, `rollback()`, `destroy()`. Adapter selected by `project.deploy.target`.
- **budget** — Reads usage from each step result, aggregates per role/phase/task/attempt, enforces budgets, runs the global concurrency semaphore and the quota circuit breaker.
- **decide** — Fast typed decisions (see 10A). Input `{decisionId, state, questions}`; output per question `{value, probabilities, confidence, backend, escalated}`. Callers never know which backend answered.
- **store** — Append-only `events.ndjson` plus a derived `state.json` snapshot. Rebuilds state by replay on boot.
- **api / web** — The UI reads state and events. Its only writes are Gate 1 inputs (documents, answers, tasks, stack constraint, secret values, "Start") and validation actions ("Report problem", "Complete spec").

### 3.3 Agent process invocation

Each step is a fresh process started in the task worktree (or the repo for non-task steps):

```
claude -p \
  --agent <role> \
  --output-format stream-json --verbose \
  --json-schema <step-output-schema> \
  --setting-sources project \
  --strict-mcp-config --mcp-config <empty-config> \
  --tools <role-specific minimal list> \
  --disallowed-tools "Bash(git push:*)" "Bash(gh:*)" "Bash(docker:*)" "Bash(kubectl:*)" \
  --exclude-dynamic-system-prompt-sections \
  --no-session-persistence
```

- `--setting-sources project` and `--strict-mcp-config` prevent the user's global plugins, hooks and MCP servers from being loaded into agent runs (token leakage and behavior contamination). `--bare` is not usable because it requires `ANTHROPIC_API_KEY`.
- The environment is sanitized: no GitHub token, no cloud credentials, no secrets. For OmniRoute-profile roles the runner adds `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` and `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
- The Claude Code sandbox restricts filesystem access to the working directory and network access to an allowlist (package registries, OmniRoute on localhost). `~/.teams-ai/secrets/` is explicitly denied.
- Refinement steps are the only ones that keep a session (`--session-id` / `--resume`), so the chat has continuity.
- Exact flag behavior is verified in the first implementation task (see 12).

### 3.4 Agent roles

| Role | Model (default) | Responsibilities |
|---|---|---|
| PO | opus | Refinement (product readiness), AC coverage check of the tech spec |
| SM | opus | Refinement (execution readiness), plan/DAG, replan, final report |
| Dev | opus | Tech spec, stack ADR, implementation, unit tests, fixes, conflict resolution |
| Test | sonnet → OmniRoute (run 2) | Review of commands/gates in plan, diff review, acceptance tests, integrated verification |
| DevOps | sonnet → OmniRoute (run 2) | Repo bootstrap intent, infra files (Dockerfile, manifests), deployment intent |

Agents only edit files and return structured JSON. They never run git remote operations, `gh`, `docker` or `kubectl`.

## 4. Data contract

All contract files live in the product repository under `docs/` and are versioned. The human layer is written during Gate 1; the team layer is generated after "Start".

### 4.1 `docs/project.json` (per project)

- `projectId`, `name`, `vision`
- `personas[]` — who uses the product and why
- `constraints[]` — including optional `stack` constraint
- `principles[]` — the project constitution: non-negotiable rules loaded by every agent (test conventions, security rules, style)
- `deploy.target` — `docker-local` | `kind`
- `github.owner` — optional override
- `confidential` — boolean; when `true`, OmniRoute profiles are disabled for this project

### 4.2 `docs/specs/<specId>/spec.json` (human layer, per spec)

- `specId`, `specVersion`, `specHash` (set on "Start")
- `objectives[]`
- `features[]`
- `acceptanceCriteria[]` — `{id: "AC-001", given, when, then, smoke: boolean}`
- `outOfScope[]`
- `externalDependencies[]` — `{name, purpose, secretNames[]}` (names only, never values)
- `tasks[]` — optional human-defined tasks
- `status` — `refining` | `running` | `paused:quota` | `paused:auth` | `awaiting-validation` | `done`
- `validationReports[]` — problems reported by the human after deploy

### 4.3 `docs/specs/<specId>/plan.json` (team layer)

- `stack` and `adrRefs[]`
- `commands` — `{install, format, lint, typecheck?, test, build, run, healthcheck}`; `test` must emit JUnit XML to a known path
- `gates[]` — ordered list, each `{name, command, blocking}`; POC blocking gates: format/lint, typecheck (when applicable), unit tests, build, secret scan (gitleaks); non-blocking: dependency scan (osv-scanner)
- `tasks[]` — `{id, title, description, criteriaRefs[], dependsOn[], affectedPaths[], owner}`; includes structural tasks `T0-scaffold` (first spec only; all tasks depend on it) and a deploy-infrastructure task owned by DevOps
- `deploy` — adapter-specific intent (image, ports, manifests paths, healthcheck path)

### 4.4 Frozen files

After the plan phase, the files that define `commands` and `gates` (and the build/test configuration they reference) are **frozen**; `plan.frozenPaths` lists them as globs. A task PR that modifies them is rejected automatically. The only exception is `T0-scaffold` on the first spec, which creates these files; they are frozen from the moment it merges. This prevents an agent from weakening its own gates (e.g. `"test": "exit 0"`).

### 4.5 Evidence rules

- Acceptance tests carry the AC ID in their name, e.g. `[AC-003] rejects invalid email`.
- The orchestrator (not the agent) builds the matrix `AC → task → test → result` from JUnit XML.
- A spec cannot reach `awaiting-validation` with any AC lacking at least one passing test, unless its task is `blocked` (which is reported).
- A JUnit report with zero tests fails the gate.

## 5. Gate 1 — Refinement

### 5.1 Readiness checklist

The "Start" button is enabled only when all items pass.

**PO (product):**
- Every objective has at least one verifiable acceptance criterion in Given/When/Then form.
- Personas are defined.
- Scope and out-of-scope are explicit.
- No contradictions within the spec or with prior specs/ADRs (checked via retrieval, see 9).

**SM (execution):**
- External dependencies are listed and every required secret is present in `~/.teams-ai/secrets/<projectId>.env`.
- Constraints are clear.
- Human-defined tasks, if any, are feasible and acyclic.
- No open questions remain.

### 5.2 Mechanics

1. The human pastes or uploads Markdown documents, optionally adding a stack constraint and tasks, or selects an existing spec to continue.
2. PO and SM each run a refinement step returning `{checklist, questions[], docPatch}`.
3. The orchestrator merges both agents' questions into one queue, deduplicates, and orders blocking questions first. The UI shows one question at a time, labeled with the asking role.
4. Each answer is routed to the agent that asked; the resulting `docPatch` is applied to the documentation and shown as a diff.
5. A full readiness re-evaluation runs when the queue empties (not after every answer), to limit token use. With the System 1 layer enabled, checklist items are first evaluated as individual Noul questions and only failed or low-confidence items reach PO/SM (10A.5, decisions 2–4).
6. When the checklist is fully green, the UI shows the final documentation and `spec.json`. The human clicks "Start".
7. "Start" freezes the spec (`specVersion`, `specHash`). Every subsequent event carries the hash. Changes after this point require a new refinement cycle after the run ends.

For the first spec of a project, documentation lives in the workspace until the repository exists; the bootstrap phase commits it.

## 6. Autonomous phases

### Phase 0 — Bootstrap (first spec only)
DevOps returns repository intent. The orchestrator runs `gh repo create` (idempotent: checks existence first), clones to `repo/`, commits `docs/` to `main`.

### Phase 1 — Technical spec
- Dev writes `docs/specs/<id>/tech-spec.md` and, on the first spec, the stack ADR.
- PO returns a coverage matrix `AC → tech-spec section`. Any uncovered AC sends the spec back to Dev (counts as an attempt of this phase).

### Phase 2 — Plan
- SM produces `plan.json`, starting from human tasks if provided, otherwise deriving tasks from objectives. For spec 2+, SM receives graphify `god-nodes` and module summaries.
- Test reviews `commands` and `gates` for adequacy.
- Validators: DAG acyclic, every AC covered by at least one task, spec↔plan↔tasks consistency ("analyze").
- On pass, commands/gates files become frozen.

### Phase 3 — Task loop
The scheduler selects runnable tasks: all `dependsOn` merged, no `affectedPaths` overlap with a running task (overlap is treated as an implicit dependency; for spec 2+ overlap is derived from `graphify affected` on the symbols a task touches), at most 3 in parallel.

For each task:
1. Orchestrator creates worktree `task/<specId>-<taskId>` from current `main`.
2. **Dev** implements and writes unit tests; returns `{status: "done" | "spec-gap", specHash, summary, commitMessage, scopeJustification?, question?}`. On `done` the orchestrator commits; on `spec-gap` the question goes to SM (9A.4).
3. **Orchestrator** runs blocking gates in a container. Failure returns the delta (failed tests from JUnit, truncated log tail) to Dev.
4. **Test** receives the diff plus graphify `affected` output for changed symbols (graph updated on the worktree), reviews against ACs and tech spec, may add acceptance tests, returns `{decision, criteria[{id, status, evidence[]}], findings[]}`. The orchestrator verifies the claimed evidence against the JUnit report. `changes` returns findings to Dev.
5. **Merge queue** (serialized by a mutex; only the orchestrator writes `main`):
   1. Acquire lock.
   2. Rebase on current `main`; on conflict, Dev resolves (counts as an attempt).
   3. Re-run blocking gates.
   4. Push; create PR if none exists for the branch (`gh pr list --head`); body includes summary, ACs and gate results.
   5. `gh pr merge --squash --match-head-commit <sha>`; skip if already merged.
   6. Release lock; run `graphify update` on `main`; remove worktree.
6. Gate failures are triaged first (10A.5, decision 1); only `code`/`dependency` failures return to Dev. Before review, PR risk selects the review profile (decision 5). From attempt 2 onward, attempt progress may trigger early replan (decision 6).
7. Each return to Dev is one attempt. After 3 failed attempts, SM replans once (split or change the task; the new tasks re-enter the loop). If that fails, the task and its dependents become `blocked`.

### Phase 4 — Integrated verification
Test runs the full suite plus all acceptance tests on `main`. Failures make SM create fix tasks (one round only), which go through Phase 3.

### Phase 5 — Deploy
DevOps provides deployment intent (manifests and `deployment.json`, already merged via the infrastructure task). The orchestrator runs `validate → apply → readiness → healthcheck → smoke [AC-* with smoke=true]` against the service URL. On failure: rollback to the previous image tag (`kubectl rollout undo` for kind, previous tag for compose), then DevOps fixes via a PR through the merge queue; up to 3 deploy attempts. If exhausted, the run ends with `deploy-failed` in the report.

### Phase 6 — Report
SM produces the report: delivered tasks, blocked tasks with reasons, service URL, evidence matrix, assumptions log, token usage, and an exploratory test script derived from the ACs. The spec moves to `awaiting-validation`.

### Validation (human)
The human checks the service and runs exploratory tests. "Report problem" opens Gate 1 in "continue spec" mode with the report prefilled; "Complete spec" sets `done`.

## 7. State machine, persistence and idempotency

### 7.1 Task states
`planned → ready → implementing → validating → reviewing → rebasing → merging → merged`, plus terminal `blocked` and `superseded` (a task replaced by a replan; its dependents are rewired to the replacement tasks). Run-level states include `paused:quota` and `paused:auth`.

### 7.2 Events
Examples: `RUN_STARTED`, `PHASE_STARTED`, `TASK_READY`, `TASK_STARTED`, `DEV_COMMITTED`, `GATE_FAILED`, `GATE_PASSED`, `REVIEW_CHANGES`, `REVIEW_APPROVED`, `MERGE_LOCK_ACQUIRED`, `PR_CREATED`, `PR_MERGED`, `TASK_BLOCKED`, `REPLAN_STARTED`, `DEPLOY_APPLIED`, `DEPLOY_VERIFIED`, `ROLLBACK_DONE`, `RUN_PAUSED`, `RUN_RESUMED`, `REPORT_READY`.

Every side effect follows **intent → effect → confirm**: the intent event is appended before the side effect, the confirm event after it.

### 7.3 Crash recovery
On boot, the orchestrator replays `events.ndjson`, finds intents without a confirm, and reconciles against external reality (does the branch exist? was it pushed? does the PR exist? is it merged? is the deployment applied?) before resuming. An interrupted LLM step is re-run and not counted as an attempt.

### 7.4 Deterministic identifiers
`projectId`, `specId`, `taskId`, `runId`, `attemptId`, `stepId`. Repository name derives from `projectId`; branch name from `specId` + `taskId`. All external operations (repo creation, branch, PR, merge, deploy apply) check for existing state before acting.

## 8. Token and quota management

The Claude subscription imposes usage windows rather than per-token billing; tokens are treated as quota and time.

1. **Zero-token work.** Gates, git, evidence, graphify updates and deploy execution are deterministic code.
2. **Config isolation.** Agent runs load only project settings and no MCP servers (see 3.3). The first implementation task measures the baseline cost of an empty call to confirm no leakage.
3. **Lean context.**
   - Per-step context pack: the task, referenced ACs, relevant tech-spec excerpt, principles, graphify query result. Never the whole documentation.
   - Fresh session per step; only refinement resumes sessions.
   - Retries send only the delta (failed tests, truncated log tail, review findings).
   - Stable prompt prefix (agent prompt + principles) first, to benefit from automatic prompt caching.
   - Small structured JSON outputs.
4. **Measurement.** The runner reads the `result` event (`usage`: input, output, cache read/write tokens; `num_turns`; duration; equivalent cost) and records it per role/phase/task/attempt/provider. The UI displays it.
5. **Budgets.**
   - Per step: timeout and turn/token cap, enforced by the runner killing the process.
   - Per task: sum across attempts; exceeding it counts as a failure (retry policy applies).
   - Per run: when exceeded, the scheduler starts no new tasks, finishes in-flight ones and proceeds to the report.
   - Calibration: the first run is observe-only; caps are then set to observed p95 × margin.
6. **Concurrency governor.** Global semaphore of 3 concurrent `claude` processes (independent of gate containers). Drops to 1 on rate-limit signals.
7. **Quota circuit breaker.** On a usage-limit error the orchestrator pauses all LLM work (`paused:quota`), does not count the interrupted step as an attempt, parses the reset time from the error if present, otherwise probes with backoff (5 → 10 → 20 → max 60 minutes), and resumes automatically.

## 9. Knowledge layers

1. **Structured contract (source of truth).** Requirements, ACs, tasks and evidence are addressed by ID. The context pack includes exactly what a step references. No similarity search is used for these.
2. **Code graph (graphify).** After each merge the orchestrator runs `graphify update` (AST-based, no LLM) on `main`, writing to `workspaces/<p>/graph/` outside the repository. Uses:
   - Plan (spec 2+): `god-nodes` and module overview for SM.
   - Scheduler (spec 2+): `affected` on symbols a task touches to derive real path overlap.
   - Dev: `query "<task + criteria>" --budget 2000` included in the context pack.
   - Review: `update` on the worktree, then `affected` on changed symbols, given to Test as the impact radius.
   - Replan: module boundaries used to split tasks.
   - Agents may also call `graphify query|affected|explain|path` read-only via the sandbox allowlist.
   - Community labeling (LLM) is skipped (`--no-label`).
   - Fallback: if the stack's language has poor graphify extraction coverage, the context pack falls back to grep-based lookup.
3. **Text retrieval (RAG).** A `retrieve(query)` interface backed by BM25 over SQLite FTS5, indexing `docs/`, ADRs and refinement Q&A history. Used by PO/SM during refinement to detect contradictions with prior decisions, and by Dev to pull relevant ADRs. Embeddings are added only if BM25 is shown to miss relevant material.

## 9A. Context integrity and hallucination control

Root causes addressed: **ambiguity** (agents invent when the spec has gaps) and **long context** (sessions compact and lose details). Agents are never expected to remember the spec; every step is given the right slice and every claim is checked against real artifacts.

### 9A.1 Prevent — no reliance on agent memory
- Gate 1 removes ambiguity before any autonomous work (5.1).
- Fresh session per step with a context pack rebuilt from the frozen `spec.json` (ACs addressed by ID), principles and ADRs.
- Tasks are sized to fit a single step budget; exceeding the turn cap triggers replan into smaller tasks.
- **Compaction detection:** if the stream shows auto-compaction inside a step, the step is marked suspect, its output is discarded, and the task is replanned smaller.
- **Task handoff:** the context pack of a task includes the merged summaries of its `dependsOn` tasks plus a graphify query over the code already merged to `main`. Merged code is the source of truth, not agent recollection.

### 9A.2 Anchor — every output cites things that exist
- **`specHash` echo:** every agent output returns the `specHash` it received; a mismatch rejects the output.
- **Reference validation:** every cited identifier must resolve — AC and task IDs in the spec/plan, file paths in the diff or repository, test names in the JUnit report, ADR IDs in `docs/`. Any unresolved reference rejects the output (schema-retry path, 12).
- Mandatory traceability AC → tech spec → task → test → result (4.5).

### 9A.3 Catch — independent verification
- Real gates (compile, typecheck, tests) catch invented APIs and imports; gates are frozen (4.4).
- The Test agent sees only the spec slice, the diff and the impact radius — never the Dev agent's reasoning — to avoid confirmation bias.
- **Scope guard:**
  - Deterministic: a diff touching files outside the task's declared `affectedPaths` requires a `scopeJustification` in the Dev output; missing justification rejects the output.
  - System 1: decision 9 (10A.5) asks one Noul per out-of-scope item ("does the diff implement this?") and one for "does the diff contain changes not required by any referenced AC?". High values force the `deep` review profile.
- Integrated verification (Phase 4) catches cross-task drift and requires a complete evidence matrix.

### 9A.4 Escape hatch — "spec gap" is a valid answer
- The Dev output allows `status: "spec-gap"` with the unanswered question, instead of improvising.
- The orchestrator routes it to SM, which decides using principles and ADRs, and records the decision in an **assumptions log** (`docs/specs/<id>/assumptions.md`, one entry per decision with task, question, decision and rationale). The task resumes with the explicit decision in its context pack. A spec gap does not consume a task attempt.
- Agents never ask the human mid-run. Assumptions are listed on the Validation screen and in the report, so the human validates them together with the exploratory test; a wrong assumption is reported and flows back to Gate 1.

## 10. Provider profiles and OmniRoute

- Each role has a provider profile: `{provider: "claude" | "omniroute", model}`.
- `claude`: no extra environment; uses the WSL Claude Code login.
- `omniroute`: OmniRoute runs as a pinned-version container in WSL on `localhost:20128`. The runner injects `ANTHROPIC_BASE_URL=http://localhost:20128`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` (a pinned model — never `auto` combos, to keep attempts reproducible) and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` matching the model's real context window.
- OmniRoute compression is disabled for agent traffic (header `x-omniroute-compression: off` or a compression-free combo), because RTK/Caveman compression can truncate test output and rewrite structured content.
- The Claude subscription is **never** routed through OmniRoute (Anthropic's terms restrict subscription credentials to official clients; risk of account suspension). OmniRoute serves only non-Claude providers.
- Projects with `confidential: true` cannot use OmniRoute profiles (free tiers may log or train on prompts).
- If OmniRoute is unavailable, the affected role falls back to its Claude profile and the fallback is recorded.
- The model that actually served a request is taken from OmniRoute logs (`X-OmniRoute-Decision`), since the CLI does not expose response headers.
- Run 1 (baseline) uses Claude for all roles; run 2 switches Test and DevOps (and the report step) to OmniRoute.

## 10A. System 1 decision layer

Inspired by TypeSafe's System One models (Jev): instead of asking a text-generating agent for a judgment, ask **atomic typed questions** against a state and get **probabilities** back, then combine answers with thresholds in code. Jev itself is a hosted, paid, early-access API, so the POC emulates the concept locally and for free. A `typesafe-jev` backend may be added later.

### 10A.1 Primitives

| Primitive | Question | Returns |
|---|---|---|
| `choice(state, instructions, options)` | Pick one option from a fixed set (2–10) | `value`, `probabilities` per option, `confidence` |
| `score(state, instructions, levels)` | Position on an ordered scale (2–10 levels) | `value` (may fall between levels), `probabilities` per level, `confidence` |
| `noul(state, statement, criteria?)` | Is this statement true? | `value` = P(yes) in [0, 1] |

- Several questions against the same state are sent in one call and evaluated independently (no cross-question context).
- `confidence`: for Choice, the calibrated probability of the selected option; for Score, derived from the spread of the level distribution (1 − normalized entropy); for Noul, `value` itself carries the certainty.
- Questions must be atomic ("a judgment an expert makes in seconds"). Multi-factor judgments are decomposed into several questions and combined in code.

### 10A.2 Local backend (`local-logprobs`)

- **Runtime:** llama.cpp server built with CUDA, running in WSL2 on the RTX 3060 Ti (8 GB VRAM). Parallel slots (`-np`) with continuous batching; one server shared by all decisions.
- **Model:** a 7–9B instruct model quantized to Q4_K_M or Q5_K_M (~5 GB), leaving room for an 8–16k-token KV cache. 14B-class models do not fit fully in 8 GB and are excluded. The concrete model is selected by the decision eval (10A.6), not fixed in this spec.
- **Type safety:** grammar-constrained decoding restricts the single answer token to valid labels, so the output can never be outside the defined type.
- **Probabilities from one forward pass:**
  - Choice: options are labeled `A`…`J`; read the next-token logprobs restricted to those labels and renormalize.
  - Noul: P(`yes`) / (P(`yes`) + P(`no`)).
  - Score: levels are labeled `0`…`9`; `value` = Σ i · pᵢ.
- **Parallel questions:** the state is sent as a shared prompt prefix (prompt cache); each question is a short suffix, so N questions cost roughly one state evaluation.
- **State size cap:** states are truncated or summarized by the caller (e.g. diff stats + changed symbols instead of a full diff) to stay within the context budget.

### 10A.3 Escalation backend (`claude-escalate`)

When local confidence is below the decision's threshold, or the local backend is unavailable, the same question is answered by a Claude agent step (`claude -p --json-schema`) with a schema matching the primitive. System 2 answers carry no calibrated probabilities; they are recorded with `confidence: null` and treated as final.

### 10A.4 Calibration

Raw LLM token probabilities are typically overconfident. The pipeline produces its own ground truth, so each decision is logged together with its later real outcome (e.g. triage said `infra` → did the re-run pass without code changes?). After enough runs, per-decision calibration (temperature scaling or isotonic regression) is fitted and thresholds are tuned. Until then, conservative initial thresholds apply.

### 10A.5 Decisions in the POC

Rule: **deterministic rules first, System 1 second, System 2 on low confidence.** System 1 may route, prioritize and triage; it may **never** waive a gate, approve a review, or mark evidence as passed.

| # | Decision | Primitive | Where | Action | Escalates to |
|---|---|---|---|---|---|
| 1 | Gate failure triage: `code` / `flaky-test` / `infra` / `environment` / `dependency` | Choice | Phase 3, after a failed gate not resolved by rules (exit codes, OOM 137, Docker daemon and network error patterns) | `infra`/`environment`: retry with backoff, no attempt consumed (max 3 per gate, then treated as `code`); `flaky-test`: re-run once; `code`/`dependency`: back to Dev | Test |
| 2 | Readiness per checklist item (one Noul per AC and per checklist item) | Noul | Gate 1 | Only failed or low-confidence items are sent to PO/SM to generate questions | PO / SM |
| 3 | Question deduplication (one Noul per question pair) | Noul | Gate 1 queue | Merge duplicates | SM |
| 4 | Contradiction with history (one Noul per retrieved chunk vs the new spec) | Noul | Gate 1, after FTS5 retrieval | Contradiction → PO asks the human | PO |
| 5 | PR risk: `trivial` … `high` | Score | Phase 3, before review | Selects review profile (quick / standard / deep: more context, graphify impact radius); review is never skipped | Test |
| 6 | Attempt progress: `diverging` / `stalled` / `converging` | Score | Phase 3, from attempt 2 onward | `stalled` or `diverging` triggers early replan instead of spending remaining attempts | SM |
| 7 | Validation report routing: `bug-existing-ac` / `new-requirement` / `environment` / `unclear` | Choice | After human validation report | Sets the continuation mode of the spec; `unclear` → PO asks the human | PO |
| 8 | CLI error classification: `usage-limit` / `auth-expired` / `network` / `invalid-output` / `other` | Choice | Runner, when rules do not match | Feeds the quota breaker and pause states | — (falls back to `other` → generic retry) |
| 9 | Scope drift: one Noul per out-of-scope item, one for changes not required by referenced ACs | Noul | Phase 3, before review | High values force the `deep` review profile (9A.3) | Test |

Each decision has a config entry `{enabled, threshold, backend, escalateTo}`. With the layer disabled (runs 1 and 2), every decision goes straight to its System 2 path or deterministic default.

### 10A.6 Decision evals

- A labeled fixture set per decision (initially hand-built from recorded runs, then grown from logged outcomes).
- Metrics per decision and model: accuracy, Brier score, expected calibration error (ECE), escalation rate at the configured threshold, latency.
- Used to select the local model and to set thresholds.

## 11. Web UI

Fastify serves REST + SSE, bound to `127.0.0.1`, no authentication. SSE supports `Last-Event-ID` with replay from `events.ndjson`.

1. **Projects** — list of projects/specs with status; "New project", "New spec", "Continue spec".
2. **Refinement** (the only editable screen) — document input, optional stack constraint and tasks; chat showing one question at a time labeled PO/SM; live side panel with readiness checklist, documentation diff preview, `spec.json` preview and SM-derived tasks (accept or adjust); secrets panel listing required names with present/missing status, value entry writes directly to the secrets file and is never displayed back; "Start" enabled only when the checklist is green.
3. **Execution** (read-only) — phase timeline; task DAG colored by state with parallel tasks side by side and merge-queue lock holder; task detail with attempts, gate results, review findings, PR link and live agent log; token usage per phase/task/agent/provider with `paused until HH:MM` display; live evidence matrix.
4. **Validation** — service URL, healthcheck and smoke results; exploratory test script as a checklist; assumptions made by agents during the run (from the assumptions log); blocked tasks with reasons; "Report problem" (opens Refinement in continue mode, prefilled); "Complete spec".

## 12. Error handling

**Rule:** infrastructure failures never consume a task attempt; code failures do.

| Failure | Response | Consumes task attempt |
|---|---|---|
| Agent output fails schema | Re-run the same step up to 2 times with the validation error in the prompt | Only after those 2 (then counts as 1) |
| Timeout or turn/token cap exceeded | Kill process | Yes |
| Blocking gate fails | Return delta to Dev | Yes |
| Review returns `changes` | Return findings to Dev | Yes |
| Rebase conflict | Dev resolves | Yes |
| Usage quota exhausted | Global `paused:quota`, automatic resume | No |
| OmniRoute unavailable | Fall back to Claude profile for that role | No |
| Docker / GitHub / network transient error | Backoff on idempotent operation | No |
| Output with `specHash` mismatch or unresolved reference | Same as schema failure (re-run up to 2 times) | Only after those 2 |
| Auto-compaction detected inside a step | Discard output, replan task smaller | No |
| Dev returns `spec-gap` | SM decides and logs assumption; task resumes | No |
| Local System 1 backend unavailable | All decisions escalate to System 2 | No |
| Gate failure triaged as `infra`/`environment` | Retry with backoff, max 3 per gate, then treated as `code` | No (until the cap) |
| Claude login expired in WSL | `paused:auth`, UI notice; resumes after `claude login` | No |
| Orchestrator crash | Replay + reconcile (7.3) | No |
| Deploy failure | Rollback, fix via PR, up to 3 deploy attempts; then `deploy-failed` in report | Separate counter |
| DAG deadlock (all remaining tasks depend on blocked ones) | End run, go to report | — |

Raw agent streams are stored per step in `runs/<runId>/steps/<stepId>.ndjson`. Worktrees are removed after merge or block; logs are retained.

## 13. Testing strategy (for teams-ai itself)

1. **Unit (Vitest, every commit, no LLM):** scheduler (DAG, `maxParallel`, path overlap, deadlock, retry→replan→blocked); validators (valid/invalid fixture per output type); pipeline transitions and replay (kill at each state, verify resume); evidence parser (zero tests, AC without test, failing test, malformed XML); merge queue under simulated concurrency with `main` advancing; budget and circuit breaker with a fake clock; frozen-file rejection; context pack builder (including dependency handoff summaries); `specHash` echo mismatch; reference validation (unknown AC/task/file/test/ADR); scope guard (files outside `affectedPaths` without justification); spec-gap routing and assumptions log; compaction-detected step handling.
2. **Runner contract:** a fake `claude` binary (via `CLAUDE_BIN`) replays recorded stream-json fixtures — success, invalid JSON, quota error, timeout, oversized output. A record mode captures real outputs to create fixtures.
3. **Integration (on demand):** git controller against a local bare repository and a fake `gh` (create PR twice, merge twice → idempotent); deploy adapters against real Docker and kind with a "hello" fixture app exposing a healthcheck and a smoke test.
4. **Agent evals (on demand, consume tokens):** small set of context packs per role; outputs must pass schema and semantic validation; pass rate tracked per role and provider.
5. **Decision evals (on demand, local, free):** see 10A.6. Unit tests for the decide layer use a fake backend returning fixed distributions to test thresholds, escalation and disabled mode.
6. **Golden run:** see 1.3.

## 14. Security model

- Agents run in the Claude Code sandbox in WSL2: filesystem limited to the working directory, network limited to an allowlist.
- Agents have no GitHub token, no secrets and no cloud credentials in their environment; `gh`, `git push`, `docker` and `kubectl` are denied.
- Gate commands run in disposable containers with resource limits; test gates run without network.
- Secrets are stored outside workspaces and injected only into gate/deploy containers that need them; the UI never displays secret values.
- Residual risk (documented, accepted for the POC): `gh` is authenticated for the WSL user; isolation relies on the sandbox and tool deny rules rather than on separate OS users.

## 15. Prerequisites (host setup)

- Ubuntu distribution on WSL2 (currently only `docker-desktop` exists).
- Docker Desktop with WSL integration enabled for that distribution.
- Inside Ubuntu: Node LTS, Claude Code CLI (logged in), `gh` (authenticated), `kind`, `kubectl`, `gitleaks`, `osv-scanner`, `graphify`.
- OmniRoute container (pinned version) for runs 2 and 3.
- NVIDIA driver with CUDA support for WSL2; llama.cpp server built with CUDA inside Ubuntu; a 7–9B GGUF model (Q4_K_M/Q5_K_M) for the System 1 layer.
- teams-ai and `~/.teams-ai/` located on the Linux filesystem, not under `/mnt/c`.

## 16. Open items to verify during implementation

- Exact behavior of `--setting-sources project` regarding user plugins and hooks; confirm with a baseline empty-call token measurement.
- Availability of a turn cap flag (`--max-turns` is not listed in `--help` for CLI 2.1.280); the runner's own cap is the primary mechanism regardless.
- Format of usage-limit errors in stream-json, to parse reset times.
- How auto-compaction surfaces in stream-json events, for compaction detection (9A.1).
- `--json-schema` reliability with non-Claude models through OmniRoute.
- graphify language coverage for likely product stacks.
- llama.cpp server logprobs API shape for restricted-label next-token probabilities, and prompt-cache reuse across parallel slots.
- Which 7–9B model gives the best accuracy/ECE on the decision evals within 8 GB VRAM, alongside Docker and kind on the same host.
