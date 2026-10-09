# Plan 55 - Token cost and run speed, slices 1 and 2 (R11.13)

Goal: cut the cost of a run without lowering review quality. Evidence and the other ten slices are in ROADMAP R11.13.

## Slice 1 - 5-minute prompt cache for steps with no long command

- `promptCacheTtl(kind)` (`server/runner/invocation.ts`) returns `5m` for refine, derive, coverage, plan, review, security, report, readme, decide, spec-gap, replan, fix-tasks, backlog, spec, preplan and name; `dev`, `tech-spec` and `deployment` keep the CLI default (1h), because a suite or install longer than 5 minutes would expire the cache mid-step.
- `runStep` passes it to `buildInvocation` as `cacheTtl`, which sets `CLAUDE_CODE_PROMPT_CACHE_TTL` in the child env (the env var wins over settings; a per-kind value cannot live in the per-role settings file).
- Verified live on CLI 2.1.295: writes move to `ephemeral_5m_input_tokens`, -36% on the probe call.

## Slice 2 - the Test review gets the diff and the gate results

- `reviewPack` pins a change set (changed files, diff stat, gate test results from `TaskRunner.junit`, the diff) instead of only the diff stat; the security review reads the same diff, now computed once (`boundedDiff`).
- `runStep` removes Edit, Write and MultiEdit from the tools of a `review` step (also in the inline `--agents` definition).
- `.claude/agents/test.md`: judge from the change set, do not re-run the suite or the build.

## Verification

- Unit: `test/runner/step.test.ts` (TTL per kind, review tools), `test/runner/invocation.test.ts`, `test/orchestrator/steps.test.ts`, `test/orchestrator/task-runner.test.ts`; full suite 148 files green.
- Live (pending): one real run; compare cost per completed task, review turns (was ~14) and wall time against `todo-001-r1` (US$ 13.26, 80 min).
- Risk: a review that now has the diff but no suite re-run could approve a test that does not run; `verifyClaimedEvidence` still rejects any claim not backed by a passed test in the gate JUnit.
