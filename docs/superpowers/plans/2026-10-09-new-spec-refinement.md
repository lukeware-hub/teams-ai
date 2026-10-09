# New Spec Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new spec in an existing project is refined on its own: the project documents are context that changes only with the human's approval, and the run's start writes only what changed.

**Architecture:** `createFromRepo` saves a base copy of the draft documents at `<draft root>/base/docs`. The cycle keeps the base `project.json` while `project.md` is unchanged. `runPhase0` copies to `main` only the files that differ from the base and stops on a conflict. The web gets a create panel and grouped document tabs.

**Tech Stack:** TypeScript, Node.js, vitest, React.

**Spec:** `docs/superpowers/specs/2026-10-09-new-spec-refinement-design.md`

## Global Constraints

- Official written language is English for code, comments, commits and docs; screen text stays in Portuguese (Brazil), like the rest of the web.
- Code comments: plain and very short, one sentence at most.
- A draft without `<draft root>/base/docs` (new project, or created before this change) keeps today's behavior everywhere.
- Server tests: `npx vitest run <path>` from the repository root; web tests: `npx vitest run <path>` from `web/`.

## Review Focus

- A draft created before this change, then started: no base, so `runPhase0` must keep today's rules (tested in Task 3).
- The human edits `project.md` by hand: `project.json` must follow the new derivation (tested in Task 2).
- `main` lacks a file the draft has unchanged (e.g. a generated `stack.md`): it must still be copied, as today (tested in Task 3).
- The name suggestion fails: the identifier field stays editable and the start button works once it is typed (tested in Task 4).
- A continued spec (`continue` mode) gets the same protection as a new spec (covered by Task 1: both modes go through `createFromRepo`).

---

### Task 1: Base copy and session mode

**Files:**
- Modify: `server/refine/draft.ts` (`Draft` type, `draftPaths`, `createFromRepo`, new `readBase`)
- Modify: `server/refine/state.ts` (`RefineState.mode`, `emptyRefineState`, `applyRefineEvent`)
- Modify: `web/src/api.ts` (`RefineState.mode`)
- Test: `test/refine/draft.test.ts`, `test/refine/state.test.ts`

**Interfaces:**
- Produces: `Draft.base: string` (`<root>/base/docs`); `readBase(d: Draft, rel: string): Promise<string | null>`; `RefineState.mode: 'new-project' | 'new-spec' | 'continue' | null`.

- [ ] **Step 1: Write the failing tests**

In `test/refine/draft.test.ts`, add `readBase` to the import from `../../server/refine/draft.js` and add inside `describe('draft', ...)`:

```ts
  it('a new or continued spec keeps a base copy of the docs it started from; a new project has none', async () => {
    remote = await makeRemote({ 'docs/project.json': JSON.stringify(makeProject()), 'docs/flow.md': '# Flow' });
    const d = draftPaths(ws, 'hello-020');
    await createFromRepo(d, remote.repo, execCommand, { kind: 'new-spec', description: 'List users' });
    expect(await readBase(d, 'flow.md')).toBe('# Flow');
    expect(await readBase(d, 'project.md')).toBe(await readDoc(d, 'project.md'));
    expect(await readBase(d, 'specs/hello-020/brief.md')).toBeNull();
    const fresh = draftPaths(ws, 'shop-020');
    await createNewProject(fresh, 'Shop');
    expect(await readBase(fresh, 'project.md')).toBeNull();
  });
```

In `test/refine/state.test.ts` add (import `applyRefineEvent`, `emptyRefineState` from `../../server/refine/state.js` if not imported yet):

```ts
describe('session mode', () => {
  it('keeps the mode the session was created in', () => {
    const s = emptyRefineState();
    expect(s.mode).toBeNull();
    applyRefineEvent(s, { type: 'REFINE_CREATED', data: { projectId: 'p', specId: 's', mode: 'new-spec' } });
    expect(s.mode).toBe('new-spec');
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run test/refine/draft.test.ts test/refine/state.test.ts`
Expected: FAIL (`readBase` is not exported; `mode` is undefined).

- [ ] **Step 3: Implement**

In `server/refine/draft.ts`:
- Add `base: string;` to the `Draft` interface and `base: path.posix.join(root, 'base', 'docs'),` to the object `draftPaths` returns.
- In `createFromRepo`, right before `if (mode.kind === 'new-spec') {`, add:

```ts
  // The docs as the session received them: the start publishes only what differs from this copy.
  await fs.cp(d.docs, d.base, { recursive: true });
```

- Add after `writeDoc`:

```ts
/** A file of the base copy, or null when the draft has no base or the file was not in it. */
export const readBase = (d: Draft, rel: string): Promise<string | null> => fs.readFile(path.posix.join(d.base, rel), 'utf8').catch(() => null);
```

If any test fixture builds a `Draft` object by hand and the type check fails, add `base` to it the same way.

In `server/refine/state.ts`:
- Add to `RefineState`: `mode: 'new-project' | 'new-spec' | 'continue' | null;`
- Add to `emptyRefineState`: `mode: null,`
- Add a case in `applyRefineEvent`:

```ts
    case RefineEvent.Created:
      s.mode = (d.mode as RefineState['mode']) ?? null;
      break;
```

In `web/src/api.ts`, add to `RefineState`: `mode?: 'new-project' | 'new-spec' | 'continue' | null;`

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run test/refine && npx tsc --noEmit -p .`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/refine/draft.ts server/refine/state.ts web/src/api.ts test/refine/draft.test.ts test/refine/state.test.ts
git commit -m "feat(refine): keep a base copy of the docs a new or continued spec starts from"
```

### Task 2: project.json follows project.md only

**Files:**
- Modify: `server/refine/draft.ts` (new `keepBaseProject`)
- Modify: `server/refine/cycle.ts` (derive and backlog steps)
- Test: `test/refine/draft.test.ts`

**Interfaces:**
- Consumes: `readBase(d, rel)`, `Draft.projectMd` (Task 1).
- Produces: `keepBaseProject(d: Draft, derived: Project): Promise<Project>`.

- [ ] **Step 1: Write the failing test**

In `test/refine/draft.test.ts`, add `keepBaseProject` to the import and add:

```ts
  it('an existing project keeps its project.json until project.md changes', async () => {
    const original = makeProject({ name: 'Original' });
    remote = await makeRemote({ 'docs/project.json': JSON.stringify(original) });
    const d = draftPaths(ws, 'hello-021');
    await createFromRepo(d, remote.repo, execCommand, { kind: 'new-spec' });
    const rewritten = { ...original, name: 'Rewritten by the agent' };
    expect((await keepBaseProject(d, rewritten)).name).toBe('Original');
    await writeDoc(d, 'project.md', `${await readDoc(d, 'project.md')}\n- New constraint\n`);
    expect((await keepBaseProject(d, rewritten)).name).toBe('Rewritten by the agent');
    const fresh = draftPaths(ws, 'shop-021');
    await createNewProject(fresh, 'Shop');
    expect((await keepBaseProject(fresh, rewritten)).name).toBe('Rewritten by the agent');
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/refine/draft.test.ts -t "keeps its project.json"`
Expected: FAIL (`keepBaseProject` is not exported).

- [ ] **Step 3: Implement**

In `server/refine/draft.ts`, after `readBase`:

```ts
/** In an existing project, project.json changes only when project.md changed. */
export async function keepBaseProject(d: Draft, derived: Project): Promise<Project> {
  const [baseJson, baseMd] = await Promise.all([readBase(d, 'project.json'), readBase(d, 'project.md')]);
  if (baseJson === null || baseMd === null) return derived;
  return (await fs.readFile(d.projectMd, 'utf8')) === baseMd ? Project.parse(JSON.parse(baseJson)) : derived;
}
```

In `server/refine/cycle.ts`, import `keepBaseProject` from `./draft.js`, then:
- Backlog step: replace `const { project, backlog: ranked } = accepted.value;` with

```ts
      const { backlog: ranked } = accepted.value;
      const project = await keepBaseProject(draft, accepted.value.project);
```

- Derive step: replace `const checked = postProcessDerived(...)` handling so that, right after the `if (!checked.ok) {...}` block and before `await writeDerived(draft, checked.value);`, the project is replaced:

```ts
    checked.value.project = await keepBaseProject(draft, checked.value.project);
```

If `checked.value` is read-only in its type, use `const value = { ...checked.value, project: await keepBaseProject(draft, checked.value.project) };` and use `value` in place of `checked.value` in the four lines that follow.

- [ ] **Step 4: Run the refine tests and the type check**

Run: `npx vitest run test/refine && npx tsc --noEmit -p .`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/refine/draft.ts server/refine/cycle.ts test/refine/draft.test.ts
git commit -m "feat(refine): an existing project's project.json changes only when project.md does"
```

### Task 3: The start publishes only what changed

**Files:**
- Modify: `server/orchestrator/phases/bootstrap.ts` (existing-repository copy loop)
- Test: `test/orchestrator/phase0.test.ts`

**Interfaces:**
- Consumes: the base copy at `<draft root>/base/docs`, the sibling of `opts.docsDir` (Task 1).

- [ ] **Step 1: Write the failing tests**

In `test/orchestrator/phase0.test.ts`, inside `describe('phase 0', ...)`, add:

```ts
  describe('a draft with a base copy', () => {
    const setup = async (main: Record<string, string>, base: Record<string, string>, draft: Record<string, string>) => {
      await remote.cleanup();
      remote = await makeRemote({ 'README.md': 'seed', ...Object.fromEntries(Object.entries(main).map(([k, v]) => [`docs/${k}`, v])) });
      draftDocs = path.join(remote.root, 'draft', 'docs');
      const put = async (dir: string, files: Record<string, string>) => {
        for (const [rel, text] of Object.entries(files)) {
          await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
          await fs.writeFile(path.join(dir, rel), text);
        }
      };
      await put(path.join(remote.root, 'draft', 'base', 'docs'), base);
      await put(draftDocs, { ...draft, 'specs/hello-001/spec.json': JSON.stringify(spec) });
      const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
      exec.onArgs('gh', ['repo', 'view'], () => ({ stdout: JSON.stringify({ nameWithOwner: 'o/hello-app', url: remote.origin }) }));
      new FakeGh().install(exec);
      return Run.create(deps(exec, remote.repo), 'hello-001-r1');
    };
    const show = (rel: string) => git(remote.repo, ['show', `origin/main:docs/${rel}`], execCommand);

    it('publishes the changed docs, skips the unchanged ones and still adds what main lacks', { timeout: 60_000 }, async () => {
      const json = JSON.stringify(project);
      const run = await setup(
        { 'project.json': json, 'project.md': '# Main', 'flow.md': '# Flow v1' },
        { 'project.json': json, 'project.md': '# Main', 'flow.md': '# Flow v1', 'stack.md': '# Stack' },
        { 'project.json': json, 'project.md': '# Main', 'flow.md': '# Flow v2', 'stack.md': '# Stack' },
      );
      expect(await run.executePhase0()).toEqual({ ok: true });
      expect(await show('flow.md')).toBe('# Flow v2');
      expect(await show('project.md')).toBe('# Main');
      expect(await show('stack.md')).toBe('# Stack');
      expect(await show('specs/hello-001/spec.json')).toContain('"specHash"');
      await run.close();
    });

    it('stops on a doc that both main and the draft changed', { timeout: 60_000 }, async () => {
      const run = await setup({ 'flow.md': '# Flow from another spec' }, { 'flow.md': '# Flow v1' }, { 'flow.md': '# Flow v2' });
      const result = await run.executePhase0();
      expect(result).toEqual({ ok: false, reason: expect.stringContaining('docs conflict: flow.md') });
      expect(await show('flow.md')).toBe('# Flow from another spec');
      await run.close();
    });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/orchestrator/phase0.test.ts -t "base copy"`
Expected: FAIL (`flow.md` is not updated; no conflict is raised).

- [ ] **Step 3: Implement**

In `server/orchestrator/phases/bootstrap.ts`, replace the comment and loop that start at `// The project docs and this run's own spec directory always go` with:

```ts
  // This run's spec directory always goes. With a base copy (an existing project) every other doc goes only when the draft
  // changed it or main lacks it, and a doc main changed meanwhile stops the start; without one, the project docs always go
  // and everything else only when main lacks it, so a spec already delivered keeps the status main gave it.
  const own = `specs/${spec.specId}/`;
  const baseDir = path.join(path.dirname(opts.docsDir), 'base', 'docs');
  const hasBase = await exists(baseDir);
  for (const rel of await listFiles(opts.docsDir)) {
    const source = path.join(opts.docsDir, rel);
    const target = path.join(wt, 'docs', rel);
    if (!rel.startsWith(own)) {
      const main = await read(target);
      if (hasBase && main !== null) {
        const [base, draft] = await Promise.all([read(path.join(baseDir, rel)), read(source)]);
        if (draft === base) continue;
        if (main !== base && main !== draft) {
          const reason = `docs conflict: ${rel} changed on main since this spec was created; create the spec again from the current main`;
          await journal.fact(OrchEvent.PhaseFailed, { phase: 0, reason });
          return { ok: false, reason };
        }
      } else if (!hasBase && main !== null && rel !== 'project.md' && rel !== 'project.json') continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
```

Add next to `exists`:

```ts
const read = (p: string) => fs.readFile(p, 'utf8').catch(() => null);
```

- [ ] **Step 4: Run the phase 0 tests and the type check**

Run: `npx vitest run test/orchestrator/phase0.test.ts && npx tsc --noEmit -p .`
Expected: all PASS, including the existing tests (no base copy: today's rules).

- [ ] **Step 5: Commit**

```bash
git add server/orchestrator/phases/bootstrap.ts test/orchestrator/phase0.test.ts
git commit -m "feat(phase0): publish only the docs a spec changed and stop on a conflict with main"
```

### Task 4: Create panel

**Files:**
- Modify: `web/src/pages/ProjectHub.tsx` (the `project-new-spec` form and its state)
- Test: `web/src/pages/ProjectHub.test.tsx`

**Interfaces:**
- Consumes: the existing props `onNewSpec(id: string, description: string)` and `onSuggestName({ kind, projectId, name, description }): Promise<{ id: string }>`.
- Keeps the test ids `new-spec-id`, `new-spec-description`, `new-spec`; adds `open-new-spec`, `continue-new-spec`, `cancel-new-spec`; removes `suggest-spec-id`.

- [ ] **Step 1: Rewrite the create test**

In `web/src/pages/ProjectHub.test.tsx`, replace the test that clicks `suggest-spec-id` (lines that render with `onSuggestName={suggest}` and assert `user-login`) with:

```tsx
  it('creates a spec from a description: Continuar suggests the id, which stays editable', async () => {
    const o = { start: vi.fn(), resume: vi.fn(), stop: vi.fn(), newSpec: vi.fn(), cont: vi.fn(), deleteDraft: vi.fn() };
    const suggest = vi.fn().mockResolvedValue({ id: 'user-login' });
    render(
      <MemoryRouter>
        <ProjectHubView project={project} notFound={false} runs={runs} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onDeleteDraft={o.deleteDraft} onSuggestName={suggest} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('new-spec-description')).toBeNull();
    fireEvent.click(screen.getByTestId('open-new-spec'));
    expect((screen.getByTestId('continue-new-spec') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('new-spec-description'), { target: { value: 'Entrar com e-mail e senha' } });
    fireEvent.click(screen.getByTestId('continue-new-spec'));
    await waitFor(() => expect((screen.getByTestId('new-spec-id') as HTMLInputElement).value).toBe('user-login'));
    expect(suggest).toHaveBeenCalledWith({ kind: 'spec', projectId: 'hello-app', name: '', description: 'Entrar com e-mail e senha' });
    fireEvent.change(screen.getByTestId('new-spec-id'), { target: { value: 'user-sign-in' } });
    fireEvent.click(screen.getByTestId('new-spec'));
    expect(o.newSpec).toHaveBeenCalledWith('user-sign-in', 'Entrar com e-mail e senha');
  });

  it('a failed suggestion leaves the id field to fill by hand, and Cancelar closes the panel', async () => {
    const o = { start: vi.fn(), resume: vi.fn(), stop: vi.fn(), newSpec: vi.fn(), cont: vi.fn(), deleteDraft: vi.fn() };
    const suggest = vi.fn().mockRejectedValue(new Error('IA indisponível'));
    render(
      <MemoryRouter>
        <ProjectHubView project={project} notFound={false} runs={runs} drafts={[]} error={null} deleteError={null} onStart={o.start} onResume={o.resume} onStop={o.stop} onNewSpec={o.newSpec} onContinue={o.cont} onDeleteDraft={o.deleteDraft} onSuggestName={suggest} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByTestId('open-new-spec'));
    fireEvent.change(screen.getByTestId('new-spec-description'), { target: { value: 'Listar usuários' } });
    fireEvent.click(screen.getByTestId('continue-new-spec'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('IA indisponível'));
    expect((screen.getByTestId('new-spec') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('new-spec-id'), { target: { value: 'list-users' } });
    fireEvent.click(screen.getByTestId('new-spec'));
    expect(o.newSpec).toHaveBeenCalledWith('list-users', 'Listar usuários');
    fireEvent.click(screen.getByTestId('cancel-new-spec'));
    expect(screen.queryByTestId('new-spec-description')).toBeNull();
  });
```

If another test in the file types into `new-spec-id` without opening the panel, add `fireEvent.click(screen.getByTestId('open-new-spec'));` first.

- [ ] **Step 2: Run them to see them fail**

Run (from `web/`): `npx vitest run src/pages/ProjectHub.test.tsx`
Expected: FAIL (`open-new-spec` not found).

- [ ] **Step 3: Implement**

In `web/src/pages/ProjectHub.tsx`:
- Replace the state `describing` with `const [creating, setCreating] = useState(false);` and add `const [idShown, setIdShown] = useState(false);`.
- Replace `suggestSpecId` with:

```tsx
  const closeNewSpec = () => {
    setCreating(false);
    setIdShown(false);
    setSpecDraft('');
    setSpecDescription('');
    setSuggestError(null);
  };
  const continueNewSpec = async () => {
    setIdShown(true);
    if (!p.onSuggestName || !p.project) return;
    setSuggesting(true);
    setSuggestError(null);
    try {
      setSpecDraft((await p.onSuggestName({ kind: 'spec', projectId: p.project.projectId, name: '', description: specDescription })).id);
    } catch (e) {
      setSuggestError((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  };
```

- Replace the whole `<form className={`project-new-spec...`}>...</form>` element with:

```tsx
            {creating ? null : (
              <button type="button" className="project-action" data-testid="open-new-spec" onClick={() => setCreating(true)}>
                <Icon name="plus" size={14} />
                Nova spec
              </button>
            )}
          </div>
          {creating ? (
            <form
              className="project-new-spec with-description"
              onSubmit={(e) => {
                e.preventDefault();
                p.onNewSpec(specDraft.trim(), specDescription);
              }}
            >
              <label htmlFor="new-spec-description">Descreva o serviço</label>
              <textarea id="new-spec-description" data-testid="new-spec-description" rows={5} autoFocus value={specDescription} onChange={(e) => setSpecDescription(e.target.value)} placeholder="Ex.: listar todos os usuários com o e-mail mascarado. Os documentos do projeto entram como contexto; só esta spec passa pelo refinamento." />
              {idShown ? (
                <>
                  <label htmlFor="new-spec-id">ID da spec</label>
                  <input id="new-spec-id" data-testid="new-spec-id" value={specDraft} disabled={suggesting} onChange={(e) => setSpecDraft(e.target.value)} placeholder={suggesting ? 'Sugerindo…' : 'ex.: list-users'} />
                </>
              ) : null}
              {suggestError ? <span className="error" role="alert">{suggestError}</span> : null}
              <div className="project-new-spec-actions">
                <button type="button" className="project-action secondary" data-testid="cancel-new-spec" onClick={closeNewSpec}>Cancelar</button>
                {idShown ? (
                  <button type="submit" className="project-action" data-testid="new-spec" disabled={suggesting || specDraft.trim() === '' || specDescription.trim() === ''}>Começar refinamento</button>
                ) : (
                  <button type="button" className="project-action" data-testid="continue-new-spec" disabled={specDescription.trim() === ''} onClick={() => void continueNewSpec()}>Continuar</button>
                )}
              </div>
            </form>
          ) : null}
```

The `</div>` added before the form closes `project-section-heading`; remove the original `</div>` that closed it after the form so the markup stays balanced. Remove the now unused `describing`/`setDescribing` and the old `suggestSpecId`.

- In `web/src/styles.css` (or the stylesheet that defines `.project-new-spec`; find it with `grep -rn "project-new-spec" web/src`), add:

```css
.project-new-spec.with-description { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.project-new-spec-actions { display: flex; justify-content: flex-end; gap: 8px; }
```

- [ ] **Step 4: Run the web tests and type check**

Run (from `web/`): `npx vitest run src/pages/ProjectHub.test.tsx && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/ProjectHub.tsx web/src/pages/ProjectHub.test.tsx web/src/styles.css
git commit -m "feat(web): create a spec from a description, with the id suggested and editable"
```

### Task 5: Refinement screen groups the docs

**Files:**
- Modify: `web/src/pages/Refinement.tsx` (docs section heading and tabs; breadcrumb)
- Test: `web/src/pages/Refinement.test.tsx`

**Interfaces:**
- Consumes: `snap.state.mode` (Task 1).

- [ ] **Step 1: Write the failing test**

In `web/src/pages/Refinement.test.tsx`, add a test that renders the refinement view the way the existing tests do, with the snapshot state carrying `mode: 'new-spec'`, and asserts:

```tsx
    expect(screen.getByTestId('docs-group-spec').textContent).toContain('Spec');
    expect(screen.getByTestId('docs-group-project').textContent).toContain('Contexto do projeto');
    expect(screen.getByTestId('docs-group-project').textContent).toContain('muda só com sua aprovação');
    expect(screen.getByTestId('doc-brief.md')).toBeTruthy();
```

and a second render with `mode: 'new-project'` (or no mode) that asserts `screen.queryByTestId('docs-group-project')` is null.

- [ ] **Step 2: Run it to see it fail**

Run (from `web/`): `npx vitest run src/pages/Refinement.test.tsx`
Expected: FAIL (`docs-group-spec` not found).

- [ ] **Step 3: Implement**

In `web/src/pages/Refinement.tsx`, in the docs section:
- Add above `return (`: `const existing = st.mode === 'new-spec' || st.mode === 'continue';` and `const tabButton = (f: DocFile) => (<button key={f} className={tab === f ? 'active' : ''} onClick={() => setTab(f)}>{docLabel[f]}</button>);`
- Change the heading `<h2>Documentos do projeto</h2>` to `<h2>{existing ? (st.mode === 'continue' ? 'Continuação da spec' : 'Spec nova') : 'Documentos do projeto'}</h2>`.
- Replace the tabs `div` with:

```tsx
        {existing ? (
          <div className="tabs tab-groups" role="tablist" aria-label="Documentos">
            <div className="tab-group" data-testid="docs-group-spec"><span className="tab-group-label">Spec</span>{tabButton('brief.md')}</div>
            <div className="tab-group" data-testid="docs-group-project">
              <span className="tab-group-label">Contexto do projeto · muda só com sua aprovação</span>
              {(['project.md', 'stack.md', 'flow.md', 'design.md'] as DocFile[]).map(tabButton)}
            </div>
          </div>
        ) : (
          <div className="tabs" role="tablist" aria-label="Documentos do projeto">
            {(['project.md', 'brief.md', 'stack.md', 'flow.md', 'design.md'] as DocFile[]).map(tabButton)}
          </div>
        )}
```

- In the breadcrumb, change `<span>{specId} rascunho</span>` to `<span>{specId} {snap?.state.mode === 'new-spec' ? 'spec nova' : 'rascunho'}</span>` (use the snapshot variable name that page uses).
- Add to the stylesheet that holds `.tabs` (find with `grep -rn "\.tabs" web/src/*.css`):

```css
.tab-groups { display: flex; flex-wrap: wrap; gap: 16px; }
.tab-group { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.tab-group-label { font-size: 12px; color: var(--muted); margin-right: 4px; }
```

- [ ] **Step 4: Run the web tests and type check**

Run (from `web/`): `npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Refinement.tsx web/src/pages/Refinement.test.tsx web/src/*.css
git commit -m "feat(web): a new spec's refinement shows the spec apart from the project context"
```

### Task 6: Full check, deploy and live validation

- [ ] **Step 1:** Run `npx vitest run` (root) and `npx vitest run` (in `web/`), and `npx tsc --noEmit -p .`. Expected: all PASS.
- [ ] **Step 2:** Push, then deploy from a clean export (no run may be active: `docker exec teams-ai-teams-ai-1 ps -eo args | grep cli.ts`): `git archive <HEAD> | tar -x -C <scratch>`, `docker build -q -t teams-ai:local <scratch>`, `docker compose up -d --no-build --wait teams-ai`.
- [ ] **Step 3:** In Chrome at `http://localhost:8787/projects/user-api`, open "Nova spec", check the panel at 360 px and 1440 px wide, and check the refinement page groups for a new spec. The human finishes the flow in their own authenticated tab.
