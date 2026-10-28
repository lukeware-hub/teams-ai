# Plan 114 - Show the model and effort each agent uses now

## Context

The owner approved a mock on 2026-10-28 for Settings > Projeto > Agentes. Each agent row gets a read-only column "Em uso agora": the model and effort the role's next step will use. Today the row shows only the setting the owner chose, so for an automatic agent the screen says "Orquestrador escolhe" and nothing more.

## Rule for "in use"

- A manual role shows its stored setting, or the default manual setting (Haiku 5.5 at low) when none is stored.
- An automatic role shows its role profile model (`cfg.roles[role].model`, Sonnet 5.5 today) at the effort `effortFor(model, undefined)` returns (low today), the same deterministic default the orchestrator applies when a step asks for nothing.

## Built

- **Server.** `GET /api/settings/agents/:projectId` returns `inUse` on every row. `PUT /api/settings/agents/:projectId/:role` also returns `inUse`, so the row shows the new value after a change without reloading the list. Both use `automaticSetting` and `inUseOf` in `server/api/settings-routes.ts`.
- **Web.** `AgentRow.inUse` and the `setAgent` response carry the value (`web/src/api.ts`). `AgentLine` in `web/src/pages/Settings.tsx` shows "Em uso agora: <model> · <effort>" under the Modelo summary, with the existing `MODEL_LABELS` and `EFFORT_LABELS`.
- **Tests.** `test/api/settings-routes.test.ts` covers `inUse` for a manual and an automatic row, and the PUT response. `web/src/pages/Settings.test.tsx` covers the rendered labels for a manual and an automatic row, and the update after switching to automatic.

## Open points

1. **Column layout.** The row has three grid tracks, so the new value sits in the Modelo cell as a second line, not as a fifth column. Turning it into a column needs a change to the row grid in `web/src/pages/project-shared.ts`, which other tables use. Ask before changing it.
2. **Visual check.** The change was not viewed in Chrome in this plan. Check the Settings page at desktop and phone width before the release.
3. **Effort of an automatic role.** The orchestrator picks the effort per step, so the row shows the default only. A step that asks for a higher effort still runs at that effort.
