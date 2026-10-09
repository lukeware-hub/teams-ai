# New spec in an existing project — design

A new spec added to a project that already has a delivered spec is refined on its own. The project documents that already exist are loaded as context and change only through a change the human approves.

## 1. Purpose

Today a new spec copies every project document from `main`, but nothing protects them afterwards:

- The product owner re-derives `project.json` on every cycle (`server/refine/cycle.ts`), so a new spec can change the project silently.
- When the run starts on an existing repository, `runPhase0` (`server/orchestrator/phases/bootstrap.ts`) always overwrites `project.md` and `project.json` on `main`, even when nothing was approved, and it drops `stack.md`, `flow.md` and `design.md` whenever `main` already has them, so an approved change to them is lost.
- The session forgets its mode after creation (`REFINE_CREATED.mode` is not kept in the state), so the refinement cannot tell a new project from a new spec.
- The screen to create a spec asks for an identifier first, hides the description box, and gives the "Sugerir ID" button two jobs.

### 1.1 Success criteria

- In a new spec or a continued spec, a project document changes only through a proposal the human accepts or through the human's own edit.
- `project.json` stays equal to the copy taken from `main` unless `project.md` differs from that copy.
- When the run starts, `main` receives only the documents that differ from the copy taken at creation, plus the spec's own directory.
- When `main` changed a document after the copy and the draft changed it too, the start stops with a message that names the file; nothing is overwritten.
- Creating a spec takes a description, an identifier suggested from it (editable), and one button.
- The refinement screen shows the spec being refined apart from the project context.

### 1.2 Non-goals

- Locking the human's own edits of project documents.
- Merging a document that both `main` and the draft changed; the start stops and the human resolves it.
- Changing a new project's refinement (`new-project` mode keeps today's behavior).

## 2. Session mode and base

- `RefineSession.create` already records `REFINE_CREATED { mode }`; the reducer (`server/refine/state.ts`) now keeps `mode` in the session state, so the screen knows it.
- `createFromRepo` (`server/refine/draft.ts`) copies the draft `docs/` directory to `<draft root>/base/docs` right after it fills the project documents and before it writes the spec's brief. This copy is the base: the documents as the session received them.
- An existing-project session is one whose draft has a base. `new-spec` and `continue` drafts have one; `new-project` drafts and drafts created before this change do not, and keep today's behavior.

## 3. Protection rules in an existing-project session

- Agents already change documents only through `PATCH_PROPOSED`; that stays.
- The human may still edit any document (`saveDoc`); the human is the approver.
- `project.json`: after the product owner derives, the server keeps the base `project.json` unless the draft `project.md` differs from the base `project.md`. The same rule applies to the backlog step, which also writes `project.json`.

## 4. Start writes only what changed

`runPhase0`, existing-repository branch, when `<draft root>/base/docs` exists (the sibling of the draft `docs/` it already receives):

- The spec's own directory (`specs/<specId>/`) is always copied, as today.
- Any other file equal to its base copy is skipped.
- A file that differs from its base copy is copied, after one check: if `main` has that file and it differs from the base copy and from the draft, the start fails with `docs conflict: <file> changed on main since this spec was created; create the spec again from the current main`.
- Without a base (old drafts, new projects), today's copy rules stay.

## 5. Create screen

In the specs card of the project page (`web/src/pages/ProjectHub.tsx`):

- "Nova spec" is a button that opens a panel.
- The panel shows a large "Descreva o serviço" box and a "Continuar" button.
- "Continuar" calls the existing name suggestion (`onSuggestName`, kind `spec`) and shows the identifier in an editable field.
- If the suggestion fails, the field stays empty with the error, and the human types one.
- "Começar refinamento" is enabled when the identifier and the description are filled; it calls `onNewSpec(id, description)` as today.
- "Cancelar" closes the panel.

## 6. Refinement screen

In an existing-project session (`web/src/pages/Refinement.tsx`):

- The header reads "Spec nova `<specId>` no projeto `<projectId>`" (or "Continuação" for `continue`).
- The document tabs form two groups:
  - "Spec", holding `brief.md`, selected first.
  - "Contexto do projeto", holding `project.md`, `stack.md`, `flow.md` and `design.md`, with the note "muda só com sua aprovação".
- Proposals on project documents use the existing accept and reject cards.
- The session snapshot sent to the screen carries `mode`.

## 7. Errors

- A start conflict (section 4) blocks the start and the screen shows the message; the draft stays as it is.

## 8. Testing

- Unit tests:
  - the reducer keeps `mode`, and a new or continued spec draft has a base copy;
  - `project.json` is kept when `project.md` equals the base and re-derived when it differs, for the derive and the backlog steps;
  - `runPhase0` copies only the changed files;
  - `runPhase0` fails on a conflict;
  - `runPhase0` keeps today's rules without a base copy.
- Web tests:
  - the create panel goes from description to suggested identifier to start;
  - a failed suggestion leaves the field editable;
  - the refinement tabs are grouped and `brief.md` is selected first.
- Live check: create a spec on `user-api` at `http://localhost:8787` and confirm that `project.json` on `main` is unchanged after the run starts.
