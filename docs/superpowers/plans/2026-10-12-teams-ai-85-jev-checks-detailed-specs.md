# Plan 85 - The Jev checks each spec and pre-plan before the review (R11.5a item 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** before the PO and the SM review a detailed backlog, the Jev checks each new spec and pre-plan against three rules their packs already state, and an item it flags goes back to its agent once with the flags, so the review no longer spends a whole cycle finding them.

**Architecture:** a new decision `detail-check` (`server/decide/decisions/detail-check.ts`) asks the Jev yes-or-no questions. For each spec it asks whether the spec adds a capability or rule that neither the item nor its cited sections ask for, and for each acceptance criterion whether it depends on what its test cannot control on the shared deploy. For each pre-plan it asks whether it contradicts a technical decision of project.md or stack.md. The detailing loop (`server/refine/detail-cycle.ts`) runs the check on the first answer of each valid item. A flagged item is retried alone once with the flags, exactly as a rejected item is today, and its first answer stands when the retry is not valid or cannot run, so a flag never fails an item and never leaves it worse than without the Jev.

**Tech Stack:** TypeScript on Node 22 (ES modules), vitest.

**Spec:** ROADMAP R11.5a item 3: "check each spec and pre-plan before the review (only cited sections, criteria testable on one shared deploy, pre-plan follows project.md), failures feeding the solo retry". Evidence from the R11.2 live check: the reviews flagged fixed calendar dates and an empty database in criteria, and a pre-plan used the database clock against the clock port project.md asked for.

## Design decisions

- The check is on by default inside the decision layer, like `patch-dedup` and `failure-cause`: a wrong flag costs at most one more agent call for that item in that cycle, and the first answer stands when the retry is not valid. The Docker config turns the layer on, so the container runs it.
- The chain is `jev` then `local` and the escalation role is the PO, as for the other refinement decisions, because the UI server has no Claude step to escalate to.
- Each question is its own decide call, since a call's confidence is its least sure answer and one unsure question would silence the others (the lesson written in `gate1.ts`).
- A spec whose state is longer than the 24,000 character cap skips the cited-sections question, because a cut state would hide cited sections and flag what they say.
- The pre-plan comes first in its state, so a cut only loses the end of the docs, which can only hide a contradiction.
- Only the first answer of each item is checked and a solo retry never is, so the Jev adds at most one agent call per item and cycle.
- The check runs on a dry run of the spec and the criteria are numbered after it, so a batch running beside it never takes the same criterion numbers.
- Every check is journaled as `DECISION_MADE` through the cycle's recorded decider, so a later eval can read it.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green after each task.
- The worktree is shared with other sessions: commit with an explicit pathspec (`git commit -m ... -- <files>`) and verify in a clean worktree.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A spec the Jev flags is retried alone once with the flags, the retry's spec is recorded, and every criterion number stays unique across the backlog.
2. A flagged spec whose retry is not valid, or whose retry stops on quota, keeps its first answer, so the item never fails because of a flag.
3. The Jev never checks a solo retry, and with the decision layer off or no decider the detailing makes the same calls as before.
4. A pre-plan the Jev flags is retried alone once with the flag.
5. A spec over the state cap skips the cited-sections question, and a pre-plan state is cut only at the end of the docs.

## Limits

- The flags are not shown on the refinement screen: they reach the agent's retry and the journal only.
- The solo retries of one batch still run one after the other, so a batch with three flagged items adds three calls in a row.
- The check cannot see the other items, so an overlap with another item's scope stays with the review.
- A criterion that needs a route a later item delivers is not checked here, since it belongs to R11.10.

---

### Task 1: The `detail-check` decision

**Files:**
- Create: `server/decide/decisions/detail-check.ts`
- Modify: `server/decide/types.ts` (`DECISION_IDS`), `server/config/config.ts` (`DECISION_DEFAULTS`), `server/decide/decisions/gate1.ts` (export `noul`)
- Test: `test/decide/detail-check.test.ts`, `test/config/decisions.test.ts`

**Interfaces:**
- Produces: `specFlags({ item, sections, spec }, decider, ctx): Promise<string[]>` and `preplanFlags({ preplan, projectMd, stackMd }, decider, ctx): Promise<string[]>`, each returning the issues for the agent's retry in Brazilian Portuguese, empty when the Jev flags nothing or does not answer.

- [ ] **Step 1: Write the failing tests** in `test/decide/detail-check.test.ts`, with a fake decider that answers `detail-check` by the instructions and the state it gets:
  - a spec the Jev finds outside its cited sections gets one issue, and each criterion it flags gets an issue that quotes the criterion;
  - an unanswered decision (layer off) flags nothing;
  - a spec state over `MAX_STATE_CHARS` asks no cited-sections question, while its criteria are still asked;
  - every call uses the decision id `detail-check` and one question;
  - a flagged pre-plan gets one issue, and its state starts with the pre-plan, so a long project.md is the part the cap cuts.
- [ ] **Step 2: Run** `npx vitest run test/decide/detail-check.test.ts` and see it fail (module missing).
- [ ] **Step 3: Implement** `detail-check.ts`: three questions (cited sections, shared deploy, project decisions), one `noul` call per question, a flag when P(yes) is at least `FLAG_MIN` (0.5); `'detail-check'` appended to `DECISION_IDS`; `DECISION_DEFAULTS['detail-check'] = { chain: ['jev', 'local'], escalateTo: 'po' }`.
- [ ] **Step 4: Update** `test/config/decisions.test.ts`: the Docker config's enabled list ends with `'detail-check'`.
- [ ] **Step 5: Run** the two test files, then commit.

### Task 2: The detailing loop checks each first answer

**Files:**
- Modify: `server/refine/detail-cycle.ts` (`runBatches`, `acceptSpec`, `acceptPreplan`), `server/refine/detail-packs.ts` (`citedSections`, used by `specPack` and the check), `server/refine/cycle.ts` (the detailing gets the recorded decider)
- Test: `test/refine/detail-cycle.test.ts`

**Interfaces:**
- `accept(item, entry, review)` returns `{ issues, flagged? }`; `review` is true on the first answer only; `flagged` marks a valid answer the Jev flagged, which `runBatches` records when the retry is not valid or does not run.

- [ ] **Step 1: Write the failing tests** in `test/refine/detail-cycle.test.ts` (a `decider` argument on the `run` helper):
  - a spec the Jev flags is retried alone once with the flags in its pack, the retry's spec is recorded, the retry is not checked again, the backlog reaches `ready`, and the checks are journaled as `DECISION_MADE` with `detail-check`;
  - a flagged spec whose retry is not valid keeps its first answer, and all criterion numbers stay unique;
  - a flagged spec whose retry stops on quota keeps its first answer while the cycle fails as interrupted;
  - a pre-plan the Jev flags is retried alone once with the flag.
- [ ] **Step 2: Run** `npx vitest run test/refine/detail-cycle.test.ts` and see the new tests fail.
- [ ] **Step 3: Implement**: `runBatches` passes `review` true for the first answer, keeps a flagged first answer, and records it again (`accept(item, entry, false)`) when the solo retry is not valid or did not run; `acceptSpec` checks a dry run of the spec and numbers the criteria after the check; `acceptPreplan` checks the parsed pre-plan before recording it; the project's `confidential` flag keeps a confidential project away from the Jev; `runCycleSteps` passes the recorded decider.
- [ ] **Step 4: Run** the detailing, packs and cycle tests, then the whole suite and the typecheck, then commit.

### Task 3: Roadmap

- [ ] Record in R11.5a that item 3 is built (plan 85), with its limits, and commit.
