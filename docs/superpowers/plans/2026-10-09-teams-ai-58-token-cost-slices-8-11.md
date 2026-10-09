# teams-ai plan 58: step profile, cost budget and the dependsOn rule (R11.13 slices 8 and 11)

**Slice 8 (measure before tuning effort), built:**
- `summarizeStream` returns `profile` (`thinkingTokens`, `durationApiMs`, `toolCalls` by tool, `toolResultChars`); `runAgentStep` journals it in `STEP_FINISHED`. Nothing is tuned yet: read it from a real run first, then try `low`/`medium` effort on coverage, spec-gap, report and the refine checklists.
- `budgets.perTaskCostUsd` (optional): when set, a task is capped by what it cost instead of by `perTaskTokens`, which counts a cache read like an output token. `observeOnly` still decides whether the cap blocks or only journals (the event then carries `costUsd` and `capUsd`).
- Not done: per-step `--max-turns`/`--max-budget-usd` caps; `budgets.step.maxOutputTokens` is still unused.

**Slice 11 (wider plans), built:** the plan rules and `sm.md` say `dependsOn` is for a real dependency only (the task needs code or files the other creates), so independent tasks run in parallel. Risk to watch: more rebases. Check `maxParallel` use on the next real plan.

**Not started, and why:**
- Slice 6 (model routing in shadow) and slice 10 (Sonnet on the PO and SM checklists) need several real runs to compare cost per completed task and quality; `model-tier` needs a decision backend that is not spending (Jev is off to avoid external spend).
- Slice 12 (API credits instead of the subscription window) is a human decision, money against window.
