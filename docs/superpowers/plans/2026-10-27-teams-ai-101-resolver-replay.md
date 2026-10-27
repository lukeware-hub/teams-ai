# Plan 101 - The resolver replay: the tiers measured on the journal before any flow acts

## Context

Plan 95 measured the cost of questions: about 730 distinct questions in four days, 83% of the owner's answers agreed with the recommended option, and stage questions repeated earlier answers in 39 of 96 cases. The resolver is the module that decides, for each question, whether the owner needs to see it (the design is in `docs/superpowers/specs/2026-10-27-autonomous-refinement-design.md`).

Before any flow acts on a resolution, the resolver is measured on data that already exists: the live journal, and the saved steps of each agent call. This plan has three steps. Step 1 builds the resolver and its replay. Step 2 adds the evidence diagnostics. Step 3 runs both on the live draft and sets the next plan from the numbers. No step changes a flow, an event, the state or a page.

## Change

Step 1 (done, commit `3bd771bf`):

- `server/refine/resolver.ts` (new, pure). The rules are one frozen object, stamp `r1`, pinned by a test. The impact of a question is `scope`, `detail` or `unclassified`, failing closed: a system question is scope; a scope cue anywhere in the question or its options wins; `detail` needs a positive ask for a value. A repeat is a question of the same context (the same Spec Kit item, the same stage file, or a shared criterion) with the same numbers and a word overlap of at least 0.8 between texts of at least four content words. The verdict follows one order: escalate (scope), repeat, evidence (a verified triage card), assume (exactly one recommended option on a detail question), otherwise ask. `resolveLanding` resolves what an event lands against the state before it; `resolveCard` re-decides a Spec Kit question from its triage card.
- `server/refine/resolver-replay.ts` (new, pure). One pass over a journal with the existing reducer. Each owner answer is labelled by the verdict's own rule: an assumption agrees when the answer is the recommended option; a repeat agrees when the answer equals the twin's answer, and disagrees when both are options of the question and differ; anything else is unlabelled. Only independent labels count (three seconds or more after the owner's previous answer, the rule of plan 95). A round whose floor was armed is left out. The summary gives the verdict table per site, the impact table on the recommended option, the similarity bins for repeats, and the cluster interval.
- `scripts/evals/refine-replay.ts` (extended). The output of plan 95 is unchanged; the resolver report follows it. Flags: `--since <ISO time>` (labels answered on or after the time), `--bins`, `--audit <n>` (question texts to read, ordered by a hash of the question id, so the sample is the same on every run).
- `server/refine/agreement.ts`, `server/refine/question-pairs.ts`: exports only (`define`, `Asked`, `words`, `overlap`). Nothing pinned changes.
- Tests: `test/refine/resolver.test.ts` (rules pinned; impact canaries in Portuguese and English with placeholder questions only; the verdict order; the repeat thresholds; the landing and card rules; the agent-answer exclusion; the read-only check that resolving changes no state) and `test/refine/resolver-replay.test.ts` (parity with `ownerAnswers`; labels per verdict; the first answer labels nothing; a bulk burst is not a label; an armed floor is left out; `--since`; the report and the audit).

Docs in the same change: this plan, the design specification (saved from the session plan file), the plan index row and the feature list item.

Step 2 (done in this change):

- `server/refine/speckit-answers.ts`, in place. `locate` becomes `scan`, which returns where a quote sits or the reason it does not verify (`source-unknown`, `not-in-file`, `in-other-file`, `joins-lines`, `too-short`, `negation`, `decisions`). `verifyEvidence` is the strict rule over `scan`, so every pinned test passes unchanged. `diagnoseEvidence` gives each quote's reason, the numbers no quote holds (`number-missing` or `number-format`), and whether each rule set admits the answer: strict, `sourceNames` (a folder or another spelling names the document), `decisions` (a quote under the owner's decisions counts when the owner wrote it), and `perQuote` (the verified quotes stand when they hold every number). Strict implies every other rule set, and each relaxed rule changes only its own case.
- `server/refine/evidence-replay.ts` (new). Reads the answer steps the journal started and whose saved output is ok, the six inputs of the last preparation, and the owner's answers. The replay counts what each rule set admits, how many proposals each relaxed rule gains over strict, and how each admitted or refused proposal compares with the owner's later answer to the same question.
- `scripts/evals/refine-replay.ts --evidence`: reads the saved steps next to the journal and prints the replay after the resolver report.
- Tests: `test/refine/speckit-evidence.test.ts` (one case per reason; each relaxed rule flips only its case; the strict verdict agrees with `verifyEvidence` over mutated quotes and sources; numbers) and `test/refine/evidence-replay.test.ts` (the counts and the joins; the readers over a temporary draft folder, with a failed step and a step of another kind left out).

Known limits of Step 2: the six inputs are the last preparation's, while some agents saw digests of them, so a quote the agent copied from a digest is checked against the full document. The report says which source it used.

## Deviations

- Repeat-open verdicts and a ledger built from the briefing's `## Decisões` section are not built: no owner label can score the first, and the second repeats the journal's own answer rows.
- The stage repeats before and after plan 100, with `--since`, are not printed yet: that comparison belongs to Step 3, on the live journal.
- No live shadow event and no flag: this plan measures; a live record is added later only if an acting tier needs an audit trail.

## Verification

- `npm run typecheck`: exit 0.
- `test/refine/resolver.test.ts`: 32 passed. `test/refine/resolver-replay.test.ts`: passed in the same run as the pinned `agreement.test.ts`, `question-pairs.test.ts` and `test/decide/evals.test.ts` (56 passed in that run, before the read-only test was added).
- Smoke run of `scripts/evals/refine-replay.ts` on a four-event synthetic journal: exit 0, the report prints the verdicts, the impacts and the audit.
- Full root and web suites and the web build: exit codes in the commit message.

## Next

Step 3: copy the live draft out of the container read-only, run the replay in development mode (headed DEV, never promotable), freeze the rules under a new stamp, and record the numbers in this plan. The next plan follows from those numbers.
