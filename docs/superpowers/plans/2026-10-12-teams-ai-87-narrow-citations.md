# Plan 87 - A decision re-derives only the specs that cite it (R11.10, narrow citations)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** in backlog mode, a new owner decision or a new dependency re-derives only the specs it concerns, instead of every spec, so a refinement cycle costs a fraction of what it costs today.

**Architecture:** a spec is derived again when its input hash changes, and that hash covers the item and the text of every section it cites (`specInputHash`, `server/refine/details.ts`). Today the agents append every decision as one more line of a shared briefing section that nearly every item cites, and the hash also covers the item's dependencies. Three changes: the PO and the SM record each decision as its own `###` heading under `## Decisões` in `docs/briefing.md`; the outline cites the narrowest sections, and the validator sends back a citation of a section made only of sub-sections with the sub-headings to cite instead; and the dependencies leave the spec hash, so a dependency the outline adds re-derives only the pre-plan, whose hash already covers them.

**Tech Stack:** TypeScript on Node 22 (ES modules), vitest.

**Spec:** ROADMAP R11.10, candidates "one briefing heading per decision so citations stay narrow" and "`dependsOn` only in the pre-plan input hash". Evidence from the R11.2 live check: on the agenda docs every decision landed in briefing › Decisões, which all 9 items cited, so every cycle re-derived all 9 specs and 4 to 5 pre-plans (US$ 4.74 to 5.75 per cycle); and a dependency the outline added re-derived a spec whose text did not change.

## Design decisions

- The validator refuses only a citation of a section that holds nothing but sub-sections, so a section with text of its own, such as an older list of decisions, stays citable; flow.md is left out, since the coverage rule asks for every one of its headings.
- The refusal lists the widest sub-sections an item can cite, approvals aside, so the PO fixes it in the outline's one retry.
- The outline pack marks the items whose spec started or was delivered as `started`, and the rules ask to keep their sources, because narrowing them reads as a change and asks the owner for an adjustment (R11.7.4); the validator never checks them.
- The outline keeps an item's sources verbatim when its sections did not change, adding only the citation of each new decision that changes it, and the decision rule asks to turn an older list of decisions into headings in the same patch.
- `HASH_VERSION` stays 2: leaving `dependsOn` out already changes every spec hash, so each draft derives its specs again once, while the pre-plan hashes stay the same.
- The spec pack still shows the item's dependencies, which help the PO keep scopes apart; only the hash ignores them.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green after each task.
- The worktree is shared with other sessions: commit with an explicit pathspec (`git commit -m ... -- <files>`) and publish by cherry-pick from a clean temporary worktree.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A dependency the outline adds or removes re-derives the item's pre-plan and never its spec.
2. An outline that cites a section made only of sub-sections goes back to the PO with the sub-headings, and the retry that cites them passes.
3. A section with text of its own above its sub-sections, a section with no sub-sections, every flow.md citation and every citation of a started item stay accepted.
4. The review packs ask for each decision as its own heading under `## Decisões`, and the outline rules ask for the narrowest citations.

## Limits

- The policy cannot force the agents to write decisions as headings: a decision written as one more line of a list still re-derives every item that cites the list.
- A started or delivered spec that cites a broad section still asks for an adjustment whenever that section changes (R11.7.4).
- A `## Decisões` section that still holds lines of decisions saves nothing until those lines become headings, and turning them into headings re-derives once every item that cites the section and asks an adjustment for each started spec citing it.
- A new decision reaches an item only when the outline adds its citation, so an outline that misses it leaves the spec without that decision until a review notices.
- A spec is not derived again when its dependencies change, so it may still repeat the scope of a dependency added later until its own sources change.
- The stop rule, the outline that judges structure only and the criteria verified through what an item and its dependencies deliver are the next slices of R11.10.

---

### Task 1: Dependencies leave the spec hash

**Files:**
- Modify: `server/refine/details.ts` (`specInputHash`, `HASH_VERSION`)
- Test: `test/refine/details.test.ts`, `test/refine/detail-cycle.test.ts`

- [ ] **Step 1: Write the failing tests:** `specInputHash` ignores `dependsOn` while `preplanInputHash` follows it; in the detailing loop, a dependency the outline adds re-derives that item's pre-plan and no spec.
- [ ] **Step 2: Run** them and see them fail.
- [ ] **Step 3: Implement:** drop `dependsOn` from the spec hash.
- [ ] **Step 4: Run** the refine tests, then commit.

### Task 2: Narrow citations

**Files:**
- Modify: `server/refine/sections.ts` (`onlySubsections`), `server/validators/backlog.ts` (`validateBacklog`), `server/refine/backlog.ts` (`postProcessBacklog` gets the five docs, outline rules), `server/refine/cycle.ts` (passes them), `server/refine/packs.ts` (decision rule), `.claude/agents/po.md`
- Test: `test/refine/sections.test.ts`, `test/validators/backlog.test.ts`, `test/refine/backlog-derive.test.ts`, `test/refine/detail-cycle.test.ts`, `test/refine/packs.test.ts`

**Interfaces:**
- Produces: `onlySubsections(doc, heading): string[] | null`, the sub-headings of the section a citation names when that section holds nothing else; `validateBacklog(backlog, { flowHeadings, docs?, frozen? })`; `postProcessBacklog(out, previous, docs, approved, started)` with the five docs in place of flow.md.

- [ ] **Step 1: Write the failing tests:** `onlySubsections` for a container, a section with its own text, a section with no sub-sections and a missing heading; the validator refuses a container citation with its sub-headings and accepts the other three cases and a started item's citation; the cycle sends a container citation back to the PO and accepts the retry; the review pack carries the decision rule.
- [ ] **Step 2: Run** them and see them fail.
- [ ] **Step 3: Implement** the helper, the rule, the wiring and the three policy texts.
- [ ] **Step 4: Run** the whole suite and the typecheck, then commit.

### Task 3: Roadmap

- [ ] Record in R11.10 what plan 87 built, with its limits, and commit.
