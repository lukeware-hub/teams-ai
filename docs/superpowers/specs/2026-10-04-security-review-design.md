# Security review (`sec` agent) — design

Extends the POC spec §6 Phase 3 (task loop) with a security gate between the Test review and the merge queue, and Phase 6 (report) with the findings it leaves.

## 1. Purpose

Test judges a task diff against acceptance criteria; nobody judged it for vulnerabilities. `sec` reads the code each task changes and sends security flaws back to Dev before the code reaches `main`.

### 1.1 Success criteria

- Every task that Test approves is reviewed by `sec` before `rebasing`; no task reaches the merge queue without a `SECURITY_APPROVED` event.
- A `critical` or `high` finding returns the task to Dev as one failed attempt (`review-changes`), with the findings as feedback.
- `medium` and `low` findings never block; they reach the report and the UI.
- `sec` cannot write: it has `Read`, `Grep` and `Glob` only, and no Bash.

### 1.2 Non-goals

- Dependency scanning (`npm audit` and similar): needs Bash and a Bash allow rule; not in this block.
- Reviewing the tech spec, the plan or documentation.
- Decision-layer (Jev) integration, e.g. choosing a review depth from PR risk. The review depth of `sec` is fixed.
- Running exploit attempts or dynamic scans against the deployed service.

## 2. Role

| | |
|---|---|
| Agent file | `.claude/agents/sec.md` (`model: sonnet`, `effort: high`) |
| Tools | `Read, Grep, Glob` (`ROLE_TOOL_POLICY.sec = READ_ONLY`, `ROLE_ALLOW.sec = []`) |
| Config | `roles.sec`, default `claude` / `sonnet` (`CLAUDE_DEFAULTS`) |
| Step kind | `security` (`STEP_KINDS`, `OUTPUT_SCHEMAS.security`) |
| Model tier | Not overridden by decision 10: a security review is never downgraded to a smaller tier. |

Because `sec` has no Bash it cannot run `git diff`; the orchestrator inlines `git diff origin/main...HEAD` into the prompt, cut at 80,000 characters. Anything beyond the cut is read from the worktree with `Read`.

## 3. Contract

`SecurityOutput` (`server/agents/outputs.ts`):

```
{ specHash, decision: 'approve' | 'changes',
  findings: [{ file, line | null, severity: 'critical'|'high'|'medium'|'low', category, problem, fix }] }
```

The orchestrator blocks when `decision === 'changes'` **or** any finding is `critical`/`high`; severity wins over a lenient `decision`. References are validated like the review step: every `file` must exist in the worktree.

## 4. Flow

`TaskRunner.review()` (`server/orchestrator/task-runner.ts`): Test approves → `REVIEW_APPROVED` → `securityReview()` → `SECURITY_APPROVED` → `rebasing`. On blocking findings: `SECURITY_CHANGES`, then `fail('review-changes', 'Security review requested changes: …')`, which follows the normal retry policy (attempt budget, replan after three).

A resume while in `reviewing` repeats both the Test review and the security review; there is no separate `securing` state. This costs one extra pair of steps and keeps the state machine unchanged.

## 5. Visibility

- Journal: `SECURITY_APPROVED` / `SECURITY_CHANGES` with `{ taskId, findings }`.
- Report (`phases/report.ts`): `securityFindings`, the latest review per task, most severe first. The SM receives them in the report pack to mention residual risks in the summary.
- UI: Validation screen section "Security"; task detail shows the findings of each attempt.
- Stop explanation: `Security review requested changes` is a known stop reason in `explainStop`.
- Accounting: `sec` is a role in the per-role token table.

## 6. Open points

- Dependency audit role (Bash allow rules for `npm audit`).
- Letting decision 5 (PR risk) scale the review depth for `sec`.
- Live check with the real Claude CLI: JSON validity and read-only behavior under `dontAsk` have only been exercised with fakes.
