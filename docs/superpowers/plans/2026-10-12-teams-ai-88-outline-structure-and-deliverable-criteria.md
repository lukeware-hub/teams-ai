# Plan 88 - The outline review judges structure only, and criteria rest on what an item and its dependencies deliver (R11.10)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fewer refinement rounds in backlog mode: the review of the outline stops asking about details a spec decides, and every acceptance criterion can be checked once its own item is delivered, so later reviews stop finding criteria that need a later item.

**Architecture:** two rules in the packs, with no code path changed. In `refinePack` (`server/refine/packs.ts`), the PO and the SM reviewing an outline that has no spec yet get a rule to judge the items, their boundaries, priorities and dependencies and the coverage of the docs, and to leave every detail a spec decides to the detailing. In the spec rules of `specPack` (`server/refine/detail-packs.ts`), each criterion is checked only through what its item and the items it depends on deliver, and the review of a detailed backlog reads the criteria the same way.

**Tech Stack:** TypeScript on Node 22 (ES modules), vitest.

**Spec:** ROADMAP R11.10, candidates "the outline review judges structure only and leaves detail to the spec step" and "criteria verified only through what the item and its dependencies deliver". Evidence: six outline rounds for a three-section product, because the PO asked for success codes and e-mail content while reviewing the outline (R11.10); and on `r112-biblio` a later cycle found a criterion verified through a route a later item delivers (R11.2).

## Design decisions

- Both are prompt rules: whether a question is about structure, or whether a criterion needs a later item, is a judgement, and no deterministic check can tell it.
- The outline rule goes to the PO and the SM only, before the detailing; once the backlog is detailed, the review reads the specs, so spec detail is in scope again.
- The criteria rule names routes, screens and data, the three things a criterion of a later item usually borrows.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green.
- The work stays in a private temporary worktree until its review passes, then goes to main (the shared feature branch can be published by other sessions).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. The PO and the SM reviewing an outline before the detailing get the structure rule; a detailed backlog, a single spec and the Front do not.
2. The spec rules and the review of a detailed backlog both read each criterion against what its item and its dependencies deliver.
3. The new texts agree with the rules already in the packs (the convergence rule, the decision rule, the delivery contract, keeping sources verbatim).

## Limits

- The rules rely on the agents: a PO may still ask a detail question at the outline, and a spec may still borrow a later item's route, which the review can then flag.
- A Jev check of a criterion against its item's deliverables could come later, with an eval before it is switched on, as R11.5a asks.
- The stop rule for reviews that keep finding gaps is the next slice of R11.10.

---

### Task 1: The two rules

**Files:**
- Modify: `server/refine/packs.ts` (`OUTLINE_REVIEW_RULE`, `DETAIL_REVIEW_RULE`), `server/refine/detail-packs.ts` (`SPEC_RULES`)
- Test: `test/refine/packs.test.ts`, `test/refine/detail-packs.test.ts`

- [ ] **Step 1: Write the failing tests:** the outline review of the PO and the SM carries the structure rule, while a detailed backlog, a single spec and the Front do not; the spec pack and the detailed review carry the deliverables rule.
- [ ] **Step 2: Run** them and see them fail.
- [ ] **Step 3: Implement** the three texts.
- [ ] **Step 4: Run** the whole suite and the typecheck, then commit.

### Task 2: Roadmap

- [ ] Record in R11.10 what plan 88 built, with its limits, and commit.
