# teams-ai plan 59: model routing, per-kind step models and API-key login (R11.13 slices 6, 10 and 12)

All three are config, off or harmless by default, and each leaves a journal trail so a real run can be compared with `scripts/evals/compare-runs.ts`.

## Slice 6: route the Dev by task size

- `heuristicTier(task, attempt)` (`server/decide/decisions/model-tier.ts`): a free, deterministic tier from the plan: `large` for risky words (auth, session, token, password, migration, schema, concurrency, lock, queue, transaction, scaffold), 6+ paths, 4+ criteria or a description over 1,200 characters; `small` for one criterion or fewer, two paths or fewer and a description of 400 characters or fewer; `medium` otherwise. Each failed attempt moves one tier up. It never sets an effort (that waits for the slice 8 profile).
- Why not the `model-tier` decision: the decision layer is off (`decisions.enabled: false`) and its backends cost money (Jev) or do not exist yet (local). The heuristic is used only when the decision gives no answer; an answer still wins.
- `routing.tiers`: `off`; `shadow` (the default: journals `MODEL_TIER_CHOSEN` with the tier, the model it maps to and `applied: false`, runs the role profile); `on` (the Dev runs on `routing.models[tier]`, default small and medium on `sonnet`, large on `opus`). The Test review keeps its role profile.
- Evidence to decide `on`: run the same plan with `shadow` and with `on`, compare `compare-runs.ts` (cost per merged task, attempts after the first, blocked tasks).

## Slice 10: a model per step kind

- `routing.stepModels`: `{ "<step kind>": "<model>" }`, ahead of the role profile and behind an explicit per-step model. It reaches the orchestrator (`run.ts`) and the refinement agent (`refine/agent.ts`). `STEP_STARTED` now carries the resolved `model`.
- To test Sonnet on the PO and SM checklists, set `routing.stepModels` for `refine`, `derive` and `coverage` (the PO and SM refinement kinds) and re-run the R11.2 refinement driver (`scripts/live-check/refine.mjs`) on the same documents, then compare cost, number of cycles to converge and the questions left open against the Opus baseline (US$ 11.66, 76 steps for `r11p-svc-001`).

## Slice 12: log in with a Console API key

- `claude.auth`: `subscription` (default) or `api-key`. In `api-key` mode the secret `ANTHROPIC_API_KEY` goes to the agent steps through `StepDeps.apiKey` and nothing else: it is removed from the secrets the gates, smoke and e2e runs receive, it is redacted from every journaled output, and a key in the orchestrator's own environment is never forwarded. A step HOME then gets no credential file, the refresh gate and the credential write-back are skipped (no refresh token rotates between concurrent steps, plan 38), and a run refuses to start without the secret.
- Steps then bill the Console organization; Max plans include monthly API credits (US$ 100 on Max 5x, US$ 200 on 20x). Cap the spend with a workspace limit in the Console. `--bare` was left out: the step isolation flags already cover what it removes, and it would also drop what the role settings rely on.
- Turning it on is the human's call (money against the 5h/7d window).
