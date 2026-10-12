# Plan 89 - A green checklist stops the review: a reviewer's patch becomes a suggestion (R11.10, stop rule)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a refinement whose checklist is all green, whose coverage is complete and that has no blocking question is ready, even while the reviewers keep proposing patches, so the loop stops instead of re-running cycle after cycle.

**Architecture:** `computeStatus` (`server/refine/state.ts`, the reducer the server and the refinement screen share) decides the status. Today `ready` also needs no pending patch, so every patch a reviewer proposes holds it back; once the checklist is green, a reviewer's pending patch now becomes a suggestion that blocks nothing, the way a question that is not blocking already works. An adjustment's approval (R11.7.4, a `## Ajuste aprovado:` patch) still waits for the owner, since it is the owner's decision and not a reviewer's suggestion. The refinement screen stops asking to accept or reject each patch when the session is ready, and says the suggestions are optional.

**Tech Stack:** TypeScript on Node 22 (ES modules), React for the screen, vitest.

**Spec:** ROADMAP R11.10, "the loop needs a stop rule, not only less noise". Evidence: on the agenda docs Opus did not reach `ready` in 12 rounds, with zero checklist items failing from cycle 9 on but 3 to 5 new patches every cycle; in the second live-check session the checklist was fully green after cycle 11 and each accepted patch opened new findings. Decision (human, 2026-10-12): with the checklist green and the coverage complete, a reviewer's pending patch becomes a suggestion; adjustment approvals and blocking questions still block.

## Design decisions

- Only the checklist, the coverage, the blocking questions and the adjustment approvals decide `ready`; a pending reviewer patch counts only while some checklist item fails.
- An approval patch is told apart by its heading, through `approvalKey` (`server/refine/sections.ts`), which runs in the browser too.
- Accepting a suggestion after `ready` makes the docs stale, as any accepted patch does, so starting or detailing waits for a new evaluation.
- Once green, a suggestion is nothing the owner owes: a session that is green but waits for its detailing reads `drafting`, not `answering`.
- The program's auto-start waits while a suggestion is pending (human, 2026-10-12, after the review): the owner starts it with Iniciar or decides the suggestions first, so an upgrade that turns an older draft ready never starts its program by itself.
- A suggestion still pending when a run starts is dropped with the reason "não aplicada: a execução começou sem ela", so it moves to the history instead of staying on screen with disabled buttons.
- The screen tells an adjustment approval apart from the suggestions, with its own label and next step.
- The refinement design spec (`docs/superpowers/specs/2026-09-24-refinement-ui-design.md`, section 3.1) gets the new definition of `ready`.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite and the web suite stay green.
- The work stays in a private temporary worktree until its review passes, then goes to main.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Green checklist, complete coverage and no blocking question: a pending reviewer patch leaves the session ready; a pending approval patch, a pending blocking question, a failing checklist item or a coverage gap does not.
2. Every reader of the status follows: starting, detailing, the program's auto-start (which waits for pending suggestions), the screen's buttons, labels and next-step message.
4. A suggestion still pending at the start is dropped to the history.
3. Accepting a suggestion after `ready` makes the session stale and asks for a new evaluation before anything starts.

## Limits

- In backlog mode an owner's answer reaches the specs only through the patch that records it in the briefing, which a green checklist would leave optional; plan 90 makes the orchestrator write each answer itself, and plan 89 ships with it.
- Suggestions still pending pile up across cycles, because the reviewers only see the rejected ones; a later slice can show them as already proposed.
- A reviewer that marks every item green while still proposing a real fix leaves that fix as an optional suggestion: the checklist is the gate.
- A live check is still needed to measure how many cycles a backlog takes to reach `ready` after plans 87 to 89.

---

### Task 1: The stop rule

**Files:**
- Modify: `server/refine/state.ts` (`computeStatus`), `web/src/pages/Refinement.tsx` (next-step message), `docs/superpowers/specs/2026-09-24-refinement-ui-design.md` (section 3.1)
- Test: `test/refine/state.test.ts`, the screen's test, and every test the old rule encoded

- [ ] **Step 1: Write the failing tests:** green with a pending reviewer patch is ready; green with a pending approval patch is not; the screen does not ask to accept or reject each patch once ready.
- [ ] **Step 2: Run** them and see them fail; run the whole suite to find the tests that encode the old rule, and update each one that only restates it.
- [ ] **Step 3: Implement** `computeStatus`, the message and the spec text.
- [ ] **Step 4: Run** the whole suite, the web suite and the typecheck, then commit.

### Task 2: Roadmap

- [ ] Record in R11.10 what plan 89 built, with its limits, and commit.
