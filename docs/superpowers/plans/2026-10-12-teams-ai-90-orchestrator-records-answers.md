# Plan 90 - The orchestrator writes each owner answer into the briefing (R11.10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** in backlog mode, every answer the owner gives reaches the docs at once and for sure, so it reaches the outline and the specs no matter which patches the reviewers propose, and a reviewer's patch can stay an optional suggestion (plan 89).

**Architecture:** today an answer reaches a backlog's specs only when the PO or the SM proposes a patch that records it in `docs/briefing.md` and the owner accepts it, and plan 89 makes such a patch optional once the checklist is green. Now `RefineSession.answer` (`server/refine/session.ts`) writes the answer itself, in backlog mode, through a pure helper `recordDecision` (`server/refine/decisions.ts`): a `### <question>` heading under `## Decisões`, created at the end of the briefing when missing, with the answer quoted below it, so no line of the answer becomes a heading. The write is journaled as `DOC_EDITED` with the source `decision`, which makes the session stale like any edit of the docs and makes the refinement screen read the docs again. The review packs and the PO and SM policies stop asking the agents to record an answer, since the orchestrator already did.

**Tech Stack:** TypeScript on Node 22 (ES modules), React for the screen, vitest.

**Spec:** decision of the human (2026-10-12, review of plan 89): "Cada resposta sua é gravada pelo orquestrador como título próprio em '## Decisões', sem depender de patch de agente; todo patch de agente vira sugestão." It builds on plan 87 (one heading per decision, narrow citations) and plan 89 (a green checklist makes a reviewer's patch a suggestion).

## Design decisions

- The briefing is written before the answer is journaled, and a heading for the same question gets the new answer, so a retry after a failure in between writes no second heading.
- The heading is the question on one line, which keeps it unique in the draft (questions are deduplicated) and readable on its own; the answer is a block quote, so a line starting with `#` stays inside it.
- Only answers the owner gives are written: an answer a role gives from the docs (R11.5.7) adds nothing the docs do not already say.
- A single spec is left as it is, since its answers already travel with the frozen spec (R11.7.1).
- The text is written with a function as the replacement, so a `$` in an answer is kept as it is.
- Answering now makes a backlog session stale, so it is evaluated again before it details or starts: that evaluation is what lets the outline cite the new decision and the specs take it.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite and the web suite stay green.
- The work stays in a private temporary worktree until its review passes, then goes to main together with plan 89.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. `recordDecision`: a briefing without `## Decisões`, one with earlier headings, one with an older list, one with a later section after it, the same question answered again, a multi-line answer, a line starting with `#`, CRLF line endings and a `$` in the answer.
2. An answer in backlog mode writes the briefing, journals the edit with the source `decision` and makes the session stale; a single spec writes nothing.
3. The packs and the policies no longer ask the agents to record an answer, and still ask them to turn an older list into headings.
4. Every flow that answered and then started or detailed at once now evaluates again first.

## Limits

- Each answer costs one more evaluation before a backlog details or starts, since the docs changed.
- An answer the owner gives to a question about a criterion still also travels as a decision of the frozen spec (R11.7.6), so it can appear in both places.
- The owner can edit or delete the written decision like any part of the briefing.

---

### Task 1: The orchestrator writes the answer

**Files:**
- Modify: `server/refine/decisions.ts` (`recordDecision`), `server/refine/session.ts` (`answer`), `web/src/refine/reducer.ts` (the source `decision` reloads the docs), `server/refine/packs.ts` (`DECISION_RULE`), `.claude/agents/po.md`, `.claude/agents/sm.md`
- Test: `test/refine/decisions.test.ts`, `test/refine/session.test.ts`, `test/refine/packs.test.ts`, `test/refine/backlog-policy.test.ts`, the screen reducer's test, and every flow that answered and started at once

- [ ] **Step 1: Write the failing tests** for the helper, the session, the reducer and the rule texts.
- [ ] **Step 2: Run** them and see them fail; run the whole suite to find the flows that answered and started at once.
- [ ] **Step 3: Implement** the helper, the session write, the reducer source and the texts.
- [ ] **Step 4: Run** the whole suite, the web suite and both typechecks, then commit.

### Task 2: Roadmap

- [ ] Record plans 89 and 90 in R11.10, with their limits, and commit.
