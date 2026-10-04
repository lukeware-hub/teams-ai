# Plan 30: R8.6 documentation gate

## Goal

Documentation is a gate, not best effort. A failed or invalid docs step blocks Phase 6 with a clear reason.

## Approach

- `server/validators/docs.ts`: pure validators. README needs run, test, env, architecture, pipeline headings
  (case-insensitive, English or Portuguese, minimum 40 characters of body). RUNBOOK needs start, stop, logs, rollback.
  API docs must name every endpoint path found in the spec features (not required when none are named).
- `ReportOutput` and `ReadmeOutput` gain optional `runbook` and `apiDocs`; the validator makes them mandatory in practice.
- `phases/report.ts`: validate after each report attempt, feed errors back through `reportPack`, at most two agent
  attempts; on failure journal `PhaseFailed` (phase 6) and return `ok: false` instead of swallowing.
  Valid docs are written to docs/README.md, docs/RUNBOOK.md, docs/API.md.
- `Run.writeReadme` (`spec readme`) uses the same validator and retry loop.
- `sm.md` and the report/readme packs describe the required structure.

## Files

server/validators/docs.ts, server/agents/outputs.ts, server/orchestrator/steps.ts, server/orchestrator/phases/report.ts,
server/orchestrator/run.ts, .claude/agents/sm.md, tests under test/validators and test/orchestrator.

## Verification

Unit tests for the validators; Phase 6 with a fake agent (valid first try, invalid then valid, invalid twice blocks,
report failure blocks); tsc; full vitest suite.
