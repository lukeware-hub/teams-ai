# Plan 101 - The resolver replay: the tiers measured on the journal before any flow acts

## Context

Plan 95 measured the cost of questions: about 730 distinct questions in four days, 83% of the owner's answers agreed with the recommended option, and stage questions repeated earlier answers in 39 of 96 cases. The resolver is the module that decides, for each question, whether the owner needs to see it (the design is in `docs/superpowers/specs/2026-10-27-autonomous-refinement-design.md`).

Before any flow acts on a resolution, the resolver is measured on data that already exists: the live journal, and the saved steps of each agent call. This plan has three steps. Step 1 builds the resolver and its replay. Step 2 adds the evidence diagnostics. Step 3 runs both on a copy of the live draft and records what the numbers say. No step changes a flow, an event, the state or a page.

## Change

Step 1 (commit `3bd771bf`):

- `server/refine/resolver.ts` (new, pure). The rules are one frozen object, pinned by a test. The impact of a question is `scope`, `detail` or `unclassified`, failing closed: a system question is scope; a scope cue anywhere in the question or its options wins; `detail` needs a positive ask for a value. A repeat is a question of the same context (the same Spec Kit item, the same stage file, or a shared criterion) with the same numbers and a word overlap of at least 0.8 between texts of at least four content words. The verdict follows one order: escalate (scope), repeat, evidence (a verified triage card), assume (exactly one recommended option on a detail question), otherwise ask. `resolveLanding` resolves what an event lands against the state before it; `resolveCard` re-decides a Spec Kit question from its triage card.
- `server/refine/resolver-replay.ts` (new, pure). One pass over a journal with the existing reducer. Each owner answer is labelled by the verdict's own rule: an assumption agrees when the answer is the recommended option; a repeat agrees when the answer equals the twin's answer, and disagrees when both are options of the question and differ; anything else is unlabelled. Only independent labels count (three seconds or more after the owner's previous answer, the rule of plan 95). A round whose floor was armed is left out.
- `scripts/evals/refine-replay.ts` (extended). The output of plan 95 is unchanged; the resolver report follows it. Flags: `--since <ISO time>`, `--bins`, `--audit <n>`.
- `server/refine/agreement.ts` and `server/refine/question-pairs.ts`: exports only.
- Tests: `test/refine/resolver.test.ts` and `test/refine/resolver-replay.test.ts`.

Step 2 (commit `db6e0ee2`):

- `server/refine/speckit-answers.ts`, in place. `locate` becomes `scan`, which returns where a quote sits or the reason it does not verify. `verifyEvidence` is the strict rule over `scan`, so every pinned test passes unchanged. `diagnoseEvidence` gives each quote's reason, the numbers no quote holds, and whether each rule set admits the answer: strict, `sourceNames`, `decisions` and `perQuote`. Strict implies every other rule set.
- `server/refine/evidence-replay.ts` (new). Reads the answer steps the journal started and whose saved output is ok, the six inputs of the last preparation, and the owner's answers; joins each proposal with the owner's later answer to the same question.
- `scripts/evals/refine-replay.ts --evidence`.
- Tests: `test/refine/speckit-evidence.test.ts` and `test/refine/evidence-replay.test.ts`.

Step 3 (this commit): the frozen rules become stamp `r2`, after one tuning pass on the DEV copy. The changes are listed below, with the reason for each. The numbers of Step 3 are DEV numbers and are reported as in-sample.

### Tuning from the DEV audit (r1 to r2)

The first replay of the live copy (stamp `r1`) listed the scope cues that fired. Five cue families fired on words that do not mean scope in this project. They were removed; nothing else changed.

| Removed cue | Why |
|---|---|
| `versao` (version) | the domain term for the version of a rule or a policy, not the scope of a delivery (92 hits) |
| `posterior` (later) and `proximo` (next, close) | the domain term "regularização posterior" and the ordinary "próximo vencimento" |
| `entreg*` (delivery, delivered, to deliver) | kept only the noun `entrega` and `entregas`; "entregue" and "entregar" are verbs about a delivered thing |
| `inclusive` (even) | an ordinary word; the inclusion cue keeps `incluir`, `inclui`, `incluído`, `inclusão` and `include` |
| `exclusão`, `exclusivo` (deletion, exclusive) | not cuts of functionality; `excluir` keeps the cut verb |

Each removal has a test: a question with the ordinary or domain sense of the word is `detail` when it asks for a value.

## Results (DEV, in-sample)

The copy of the live draft was taken with `docker cp` (read only) and kept outside the repository: 9,210 events, 540 saved steps, the six inputs of the last preparation.

**The baseline is reproduced.** The first 8,999 events, the journal plan 95 measured, give 641 owner answers with a recommended option, 357 independent labels at 76.5%, Wilson lower bound 0.726, under 3 s at 91.9%, 3 to 30 s at 82.6%, and 30 s or more at 63.5%. These are plan 95's numbers.

**The full copy** (647 answers with a recommended option, 363 independent labels): 76.3%, Wilson lower bound 0.725, cluster bootstrap interval 68.7% to 84.9%, largest cluster 20.4% of the labels, and leave-one-item-out between 74.1% and 81.0%.

### Verdicts under `r2`

| Site / verdict | Resolved | Labels | Agreed |
|---|---|---|---|
| speckit / ask | 352 | 0 | - |
| speckit / escalate (scope cue) | 235 | 0 | - |
| speckit / assume | 23 | 6 | 6 |
| speckit / repeat | 1 | 1 | 0 |
| stage / ask | 73 | 0 | - |
| stage / escalate | 22 | 0 | - |
| stage / assume | 1 | 1 | 0 |
| round / ask | 12 | 0 | - |
| round / escalate | 13 | 0 | - |
| round / assume | 1 | 1 | 1 |

### Impact, agreement with the recommended option (independent labels)

| Impact | Labels | Agreed | Share | Wilson lower | State |
|---|---|---|---|---|---|
| detail | 8 | 7 | 87.5% | 0.589 | probation |
| unclassified | 211 | 170 | 80.6% | 0.757 | below |
| scope | 144 | 100 | 69.4% | 0.628 | below |

Under `r1` (before the tuning) the scope class had 189 labels at 73.0%, and detail had 4 labels at 100%. The tuning moved 45 labels out of scope, and the agreement of the scope class fell, which shows that the old scope class mixed questions the owner decides easily with questions the owner decides hard.

### Repeats and near repeats

Under the frozen threshold (0.8, same digits, same context), the journal has one repeat (Spec Kit, the owner disagreed) and no stage repeat. The near repeats in the band 0.6 to 0.8, with the same digits, are 2 at stage and 8 at Spec Kit (one more at Spec Kit has different digits): they are reported, not acted on. Plan 95's 39 of 96 stage repeats came from a looser match and is not reproduced by this rule.

### The evidence replay

Of 115 saved answer steps, 54 proposals carry an answer, with 95 quotes in all.

- The strict rule admits 0 of 54: 6 of the 95 quotes verify on their own, and every proposal has at least one quote that does not. The refusals per quote are `source-unknown` 49 (the agents name a document with a folder, as `docs/briefing.md`), `not-in-file` 19 (the quote is not verbatim in the document), `too-short` 8, `decisions` 9, `negation` 3, and `in-other-file` 1.
- The relaxed rules admit a few more: `sourceNames` 1, `decisions` 1, `perQuote` 5. All five labelled proposals that the relaxed rules admit were answered differently by the owner.
- The 54 refused proposals were never shown to the owner (a refused proposal is not journaled), so the owner's later answer is independent of them. The owner's answer equals the refused proposal in 4 of 54 cases (7%).

## Reading of the DEV numbers

- No stratum clears the gate. The detail class agrees 87.5%, but it has 8 labels, not 40, and the owner gave a few hundred answers in four days.
- The assumable population is small: 25 of 733 questions carry exactly one recommended option on a detail question. The master plan's estimate of about 465 assumed answers does not hold on this journal.
- Tier 0 (repeats) finds one repeat in 733 questions under the frozen rule. The estimate of about 100 repeats does not hold.
- Tier 1 (evidence) admits no proposal under the strict rule, and the relaxed rules admit five, all answered differently by the owner. Verifying the quotes better would not remove questions on this evidence.
- Tier 5 (scope by cue) escalates 270 questions (37%). The cue list is still crude: the owner's audit of 40 printed scope questions (in the replay report) shows questions that a person could read either way. Scope agreement at 69% is an upper bound on the scope class's real quality until the audit is done.
- Most questions (about 60%) are `ask`, with no tier that acts on them. The unclassified class agrees 80.6%, a little above the 0.80 point estimate but with a lower bound of 0.757.

## Holdout and what happens next

The rules are frozen as `r2` by this commit. Promotion needs labels answered after this commit, so the holdout is `--since <commit time>` on the live journal. The next plan depends on the owner's decisions below; no build starts before them.

Owner decisions:

1. Accept that the master plan's estimates (about 100 repeats, about 465 assumptions) are not supported by this journal, and choose the next plan from the table above, or wait for the holdout.
2. Audit the scope sample (40 questions printed in the replay report, `--audit 40`), since the scope class is the largest escalated class and its cue list is crude.
3. Choose whether the next classifier is a model judge (tier 4, low effort, never sees the recommendation), with its own DEV and holdout, or whether the program keeps the crude rules and waits for holdout labels.

## Verification

- `npm run typecheck`: exit 0.
- `test/refine/resolver.test.ts` (rules pinned to `r2`, the scope vocabulary after the audit, impact canaries in both languages) and `test/refine/resolver-replay.test.ts`: passed.
- `test/refine/speckit-evidence.test.ts` and `test/refine/evidence-replay.test.ts`: passed (Step 2).
- Replay of the first 8,999 events: 641 answers, 357 labels, 76.5%, as plan 95.
- Full root and web suites and the web build: exit codes in the commit message.

## Known limits

- The replay sees only questions that were asked. The questions dropped by the existing de-duplication are invisible, and nothing records them.
- The six inputs are the last preparation's, while some agents saw digests of them: a quote copied from a digest is checked against the full document, and the report says so.
- The labels are the owner's own answers, given after the agents' recommendation was shown. Agreement is acceptance of a recommendation the owner saw, an upper bound on the owner's own preference.
- The tuning of `r1` to `r2` was done on the DEV copy, so the DEV numbers are in-sample. They are not promotable, and the holdout after this commit is the first honest test.
