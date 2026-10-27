# Autonomous refinement: design of the program

## Why

Refining one real project took 95.6 hours of wall clock, 1,091 owner actions and US$ 111.76, and it was not finished (11 of 40 backlog items prepared). The agents worked 36 hours; the other 60 hours were idle, waiting for the owner, and 36 of them right after a failure that needed a retry click. The owner's active time was 6 to 9 hours. The bottleneck is the owner's presence, not the owner's effort.

The goal: refinement runs by itself, stops only for a real doubt the available sources cannot settle, and keeps quality, traceability and safety.

Evidence: the refinement journal of the live project (8,999 events over four days, 726 distinct questions, 699 agent steps), the code, and two rounds of study. Estimates are marked as estimates.

## Owner decisions (binding, 2026-10-27)

1. Autonomy at maximum. Agents decide nearly everything, including business facts without evidence, recorded as marked assumptions. The owner mainly sees a final review.
2. The only class that always reaches the owner is a scope change: adding or cutting functionality, or changing backlog priority. Legal, money, and security or access questions are per-project switches, off by default.
3. Starting development (Iniciar desenvolvimento) stays a manual click. The analysis never starts by itself.
4. Standing rules: cost is an alert only, so loop guards must not rely on a cost cap. Owner notices appear only as a banner on the project screen. Everything is local. The factory is generic: no domain terms from any example project in rules, prompts or tests. A confidential project never sends a document to the Jev (the OpenRouter model service) or to the web. The existing look is kept, and every visual change is shown as a mock first. Every change has tests.

## What the journal shows

| Measure | Value |
|---|---|
| Wall clock, agents busy, idle | 95.6 h, 36 h, 60 h (63% idle) |
| Idle right after a failure, waiting for a retry click | 36 h |
| Idle waiting for answers | 22 h (stage questions 13.7 h) |
| Owner actions | 1,091: 510 Spec Kit answers, 112 stage answers, 306 patch accepts, 37 evaluations |
| Owner took the recommended option | 83% of answers; 76% when the owner read for 3 seconds or more |
| Agent answers accepted by the evidence check | 0 of 57 proposed |
| Stage questions repeating an earlier answered one | 39 of 96 |
| Effort at maximum | 80% of cost and 91% of agent time |

## Architecture

```
owner: switches, confidentiality, scope answers, final review, Iniciar
   |
   v
autopilot driver: one existing session call at a time; heals failures, parks exceptions, guards loops; never calls start
   |
   v
agents run stage reviews, evaluations and Spec Kit steps
   |
   v
question candidate --> resolver --> settled, or assumed (journaled, audited) --> the flow goes on
                          |
                          +--> scope change --> escalated: the flow goes on with the default; Iniciar waits for the owner
safety and measurement under everything: honest labels, shadow mode, guard, audit, scope guard
```

### The resolver: decide before asking

One shared module for the three question sites: the full round, the stage review, and each Spec Kit step.

| Tier | What it does |
|---|---|
| 0 repeats | A new question that repeats an answered one is recognised by the same context and the same numbers. Only the owner's own answers count. |
| 1 evidence | An answer is accepted only when its quotes are in the documents, checked by one fixed verifier. |
| 2 another role | A different role than the asker answers from the same sources. |
| 3 assume | The recommended option is recorded as an assumption with its provenance, and the owner can change it cheaply. |
| 4 judge | A low-effort judge decides only borderline or unclassified cases, and never sees the recommendation. |
| 5 escalate | Only scope changes. Confidentiality and secrets are never resolved by an agent. |

A scope question that escalates does not stop anything: the flow goes on with the default, and only Iniciar waits for the owner.

Guards never interrupt: an audit sample of assumptions is shown in the final review; disputed decisions are shown first; each stratum (a group of similar questions) must clear a gate before it acts; a stratum that does badly falls back to asking.

### Ask less at the source

One ask policy per Spec Kit command, aligned with the installed upstream templates. Agents settle first and record their decisions. The product and scrum master rules stop forcing an interview before every question. Stage answers are read from the journal as history, so no stage asks again what it already asked.

### Where agents look before asking

The orchestrator (never the agents) checks, in order: the decision ledger of the owner's answers, the five documents in full, prior specs and decisions, the skills as rule sources, the code and its graph, library documentation (off by default, never for a confidential project), MCP servers (each needs the owner's approval), and web search last (factual questions only, never for a confidential project).

### Owner surface

Every screen waits for an approved mock. Planned: an autopilot switch, a final review at the end of the last stage (scope exceptions first, the recommended option pre-selected, then disputed decisions and the audit sample), history rows with undo, and a project banner that lists only what needs the owner. Existing components are reused: the agent answers list, the move notice, the question card and the backlog banner.

## Roadmap

Each increment ships alone, with its tests, the full root and web suites, a plan file, a commit and a push.

| # | Increment | Status |
|---|---|---|
| 1 | Measurement: full decision records and an honest-label replay | done (plan 95) |
| 2 | Safety: save with a base hash (compare and swap), patch scope flag, journal only | done (plans 96, 97) |
| 3 | Spec Kit repair rounds and lane isolation | done (plan 98) |
| 4 | Heal driver behind `refine.heal.enabled`, off by default | done (plan 99) |
| 5 | Stage history in the stage review pack | done (plan 100) |
| 6 | Unified evidence verifier with diagnostics | next (plan 101) |
| 7 | Ask policy and caps in shadow; effort comparison | planned |
| 8 | One scope definition, canary set, and the shared hold on Iniciar | planned |
| 9 | Resolver replay with strata and gates; a live record only if an acting tier needs one | plan 101 starts it |
| 10 | Assume mode for Spec Kit specify, clarify and plan, per stratum that clears the gate | planned |
| 11 | Autopilot chain: stage chain, parked exceptions, answer queue | planned |
| 12 | Auto-apply safe patches with undo; notice auto-close | planned, needs the owner's yes |
| 13 | Resolver at the stage and round sites | planned |
| 14 | Owner surface after mock approval | planned |
| 15 | Effort tiers, per-item slices, stable prefix | planned |
| 16 | Optional adapters, one at a time, off by default | planned |
| 17 | Retire the old answer paths | planned |

Estimates (not promises): increments 1 to 5 about 20 to 25 days; the full autopilot about 85 days from the start. Promotion of any acting tier needs at least 200 independent owner labels on a live project.

## Gates and labels

- A label is an owner's own answer, given at least 3 seconds after the owner's previous answer. Bulk clicks, script bursts, agent-marked answers and answers under an armed floor are left out.
- A stratum acts only when its one-sided Wilson lower bound is at least 0.80 on at least 40 independent labels. A stratum under 0.60 is bad. Between them it is below the gate.
- The rules are frozen in one pinned object. A change of any number is a new stamp, and promotion needs a holdout made after the stamp.
- Agreement with the recommended option is acceptance of a recommendation the owner saw. It is an upper bound on the owner's own preference.

## Success metrics per project (targets)

Owner actions at most 110 (baseline 1,091); idle at most 6 hours (baseline 60); at least 95% of failures healed without an owner event; at most one pause; automatic-patch undo at most 3%; assumption agreement lower bound at least 0.80; scope leak at most 5%.

## Not in scope

Starting development automatically; a cost cap that stops runs; cloud or a public URL; iOS; any screen before its mock is approved; changing who owns confidentiality; brownfield adapters before the greenfield core is proven.

## Known gaps found along the way

- The confidentiality check in the backlog detailing uses its own formula, which is weaker than the one the other flows use. It needs a small fix of its own.
- Above the floor, the full round lets the asker answer itself with no evidence check, and the answer step has a wider tool list than the Spec Kit answer step. Tighten it before anything arms the floor.
- The configuration comment says question routing never answers, but its default lets it answer once a floor is measured. The comment and the default disagree.
- The step plan of record for the program was kept only in a session file. This document saves it.
