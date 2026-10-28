# Plan 112 - Retry until green within a token budget, and the model each role runs

## Context

FEATURES item 5 (Autonomy) lists two pending parts that this plan covers: (a) retry until green within the token budget, and (d) confirm the model each role runs.

Today a task gets three attempts, then one replan, then it blocks. The rule lives in `server/scheduler/retry-policy.ts` (`attemptFailure`) and the replan and early-replan handling in `server/orchestrator/task-runner.ts` (`fail`).

## Built (part a, 2026-10-28)

- **Config key `retry.taskTokenBudget`.** Optional positive whole number, in the `retry` section of `server/config/config.ts`. Unset by default, so the attempt count alone decides, exactly as before. The key is validated by the config schema.
- **Policy.** When the budget is set, a failure that consumes an attempt retries while the task has spent less than the budget. A repeated identical failure, or a spent budget, ends the attempts at once: the task replans once, then blocks. A repeated identical failure is the one already used by the attempt-progress rule (`repeatedFailure` in `server/decide/decisions/attempt-progress.ts`).
- **Wiring.** `TaskRunner` passes the task's spent tokens and its repeated-failure flag into the policy (`server/orchestrator/task-runner.ts`, `fail`). The run supplies the spent tokens from its accounting (`server/orchestrator/run.ts`, `runnerDeps`).
- **Default unchanged.** With the key unset, `decideOnFailure` gives the same answer as before for every failure kind. The existing test pins `DEFAULT_POLICY` to its old shape.

## Decisions for the owner (part a)

1. **Which tokens count.** Built: the task's accounted tokens (input, output and both cache counts), the same count the existing per-task cap uses. Alternative: cost in dollars (`budgets.perTaskCostUsd`). Ask if cost should drive retries instead.
2. **Relation to `budgets.perTaskTokens`.** That key is a separate hard cap, and it is only enforced when `budgets.observeOnly` is false (its default is true). The new key only changes retries. A value of `retry.taskTokenBudget` above `budgets.perTaskTokens` therefore does not stop a task at the lower value. Ask whether one budget should serve both purposes.
3. **Repeated failure is compared by text.** The check reuses `repeatedFailure`: for review findings it compares the findings, for any other failure it compares the text after trimming. A gate log that carries a timing or a changing number is not identical, so it does not stop the task. Ask whether to normalise numbers first.
4. **Early replan still applies.** The attempt-progress judge (decision 6) still runs from the third attempt on, so a task past three attempts can still replan early when its progress is judged stalled. This is unchanged behaviour.

## Model finding (part d)

No model setting was changed. The table gives the model each role runs in the default configuration, and the source that sets it. Priority is set by `server/orchestrator/steps.ts` lines 591 and 592: a manual pick from Settings first, then the step's own model, then `routing.stepModels` for the step kind, then the role profile.

| Role | Frontmatter (`.claude/agents/*.md`, line 4) | What runs by default | Source of the running model |
| --- | --- | --- | --- |
| sm | `opus` (`sm.md:4`) | `opus` for the plan and services plan steps; `sonnet` for the others | Role profile `sonnet` at `server/config/config.ts:24`. Architecture steps `opus` at `config.ts:35` and `config.ts:149` (`stepModels` default). The plan steps run as role `sm` at `server/orchestrator/phases/plan.ts:54` and `:64`. |
| po | `opus` (`po.md:4`) | `sonnet` | Role profile `sonnet` at `server/config/config.ts:25`. No architecture step runs as `po`. |
| front | `opus` (`front.md:4`) | `sonnet` | Role profile `sonnet` at `server/config/config.ts:26`. Used by the refinement cycle (`server/refine/cycle.ts:471`); later cycles use `sonnet` from `laterCycleModels` (`config.ts:150`). |
| dev | `opus` (`dev.md:4`) | `opus` for the tech spec step; `haiku`, `sonnet` for implement and review steps by task size | Tech spec runs as role `dev` (`server/orchestrator/phases/tech-spec.ts:37`) and gets `opus` from `config.ts:35`. Implement and review steps get a size tier from `routing.tiers` `on` (`config.ts:147`) and `routing.models` (`config.ts:148`), applied at `server/orchestrator/task-runner.ts:180`. Otherwise the role profile `sonnet` (`config.ts:27`). |
| test | `sonnet` (`test.md:4`) | `sonnet` | Role profile `sonnet` at `server/config/config.ts:28`. The size tier is not applied to role `test` (`task-runner.ts:180`). |
| sec | `sonnet` (`sec.md:4`) | `sonnet` | Role profile at `server/config/config.ts:29`. |
| devops | `sonnet` (`devops.md:4`) | `sonnet` | Role profile at `server/config/config.ts:30`. |
| env | `sonnet` (`env.md:4`) | `sonnet` | Role profile at `server/config/config.ts:31`. |

**The frontmatter model is never sent.** `server/agents/registry.ts:69-71` says so, and `server/runner/invocation.ts:120` and `:125` pass only `input.model`. So the `opus` in `dev.md`, `front.md`, `po.md` and `sm.md` has no effect. The real choice comes from the config described above.

**The manual pin rule.** A model and effort set in Settings for one project and role (`agentSettings`, `server/config/config.ts:124`; written by `server/api/settings-routes.ts:26-30`) overrides every other choice for that role, including the architecture models and the size tier (`server/orchestrator/steps.ts:591-592`). A pinned step keeps its model when quota runs short (`steps.ts:594`), and its effort is the pinned effort (`steps.ts:597`). The plan preparation step (`speckit`) ignores the pin (`steps.ts:591`) and runs `sonnet` at low effort (`server/refine/plan-prepare.ts:22`).

**Effort.** An `opus` or `haiku` step always runs at low effort (`server/runner/model-policy.ts:11-22`).

**Quota fallback.** A fresh automatic `opus` step moves to `sonnet` when its model is paused (`steps.ts:594`, `model-policy.ts:26`).

## Decision needed (part d)

The mismatch is between the frontmatter and the config, and only the owner can say which is right. The frontmatter is documentation, so it is misleading as it stands. Options:

1. **Keep the config as the source (current behaviour).** Change the frontmatter to `sonnet` for `dev`, `front` and `po`, and to `opus` for `sm` only if the owner wants the plan steps to keep their current opus. This removes the mismatch and changes no run.
2. **Make the config match the frontmatter.** Set `CLAUDE_DEFAULTS` to `opus` for `dev`, `front` and `po`. This is expensive: every step of those roles would run on opus, and opus is forced to low effort.

The owner also needs to confirm the live `~/.teams-ai/config.json`. A `roles` section there would override the defaults above, and that file is not in the repository.

## Verification

- `npx tsc --noEmit` passes.
- `npx vitest run` on the scheduler, config, orchestrator, budget and decide attempt-progress test files (48 files, 562 tests) passes. The retry policy tests cover: retry past three attempts while under budget; a spent budget stops; a repeated identical failure stops; the budget-kind failure follows the budget; the unset budget keeps the old rule.
- The web screens are unchanged.
