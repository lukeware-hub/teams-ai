# Plan 35: e2e rows in the evidence matrix and report, e2e scope

## Goal

Two R8.4 gaps: (1) e2e rows were only in `DeployVerified` and the Phase 5 return; (2) the e2e gate demanded an `[AC-xxx]` test for every criterion.

## Approach

- Evidence: the matrix is built in Phase 4 (before deploy), so `attachE2e` in `server/evidence/matrix.ts` merges the Phase 5 e2e rows into it per criterion (`e2e`, `e2eReason`). Phase 6 applies it and also puts `e2e` rows in `report.service`. The Validation page gets an E2E column next to Tests.
- Scope rule: a criterion needs an e2e test only if it has a testable observable behavior over the service interface. The SM marks the others in `plan.e2eExemptions: [{acId, reason}]`. Why this shape: it is explicit and auditable (reason shown in the report), keeps the spec frozen (the spec is the PO's contract, so exemption lives in the plan), and keeps the rule conservative: default is covered, no silent skipping.
- Validator (`validateE2e(plan, spec)`): ids must exist, no duplicates, reason at least 10 chars, at least one criterion must stay covered.
- `evaluateE2e` yields `not-applicable` rows (with the reason) that do not fail the gate. `sm.md`, `test.md` and `E2E_CONTRACT` state the rule.

## Verification

Unit tests: exemption evaluation, validator, `attachE2e`, Validation page; tsc; full suite.
