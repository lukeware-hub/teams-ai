# Plan 69 - Docs accumulate (R11.5.4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the second spec of a project keeps what the first one wrote in `docs/README.md`, `docs/RUNBOOK.md` and `docs/API.md`.

**Architecture:** the two steps that rewrite the shared docs, the report step of Phase 6 (`server/orchestrator/phases/report.ts`) and the `spec readme` command (`Run.writeReadme` in `server/orchestrator/run.ts`), read the current docs from the docs worktree, which is a checkout of main, and get them in their pack with the rule to keep what is still true. The API check (`validateApiDocs` in `server/validators/docs.ts`) also asks for every endpoint the current `docs/API.md` documents. Phase 6 now makes its docs worktree before the report step and runs the step there, so a document cut in the pack can be read whole.

**Tech Stack:** TypeScript on Node 22 (ES modules), zod 4, vitest, git.

**Spec:** plan 66 (`docs/superpowers/plans/2026-10-12-teams-ai-66-autonomy-hardening.md`), section "Design", paragraph **R11.5.4 Docs accumulate**, and its "Where autonomy breaks today" bullet on the shared docs; roadmap item R11.5 in `docs/superpowers/ROADMAP.md`.

**Seen live (2026-10-12):** in `loja-eventos`, the `cancelar-pedido` report replaced the README section "Critérios de aceite atendidos" (AC-001 to AC-006 of `reservar-estoque`) with its own criteria; the endpoints survived only because the agent kept them on its own.

## Global Constraints

- Code comments: plain and short, one sentence at most; docs plain, no abbreviations, each point one sentence with its context (`.claude/CLAUDE.md` section 5).
- Every behavior change ships with a test that failed first; the whole suite stays green after each task.
- Validator messages and agent prompts stay in English, as every other docs gate message (`server/validators/docs.ts`).
- The first spec of a project, with no docs on main, behaves as before.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. The first spec of a project (no docs on main): the pack says there are none, the API check keeps nothing, and Phase 6 behaves as before.
2. A spec that removes an endpoint: the rewrite marks it as removed and passes, since the check only asks that the path still appears.
3. A current doc longer than the cap: the pack shows its first 8,000 characters and sends the step to the whole file in its working directory, a checkout of main.
4. An answer with an empty `apiDocs` while `docs/API.md` exists: the file stays as it is and nothing counts as dropped.
5. A crash or a pause after the docs worktree is made and before the report merges: the next attempt makes the worktree again from main and reads the docs again.

## Limits

- README and RUNBOOK keep their content through the prompt rule alone; only API endpoints are checked, since a section can be renamed or merged for good reasons.
- An endpoint counts as kept when its path appears anywhere, as in the existing feature check: `/orders` passes while `/orders/{id}` stays.
- Two runs of one project writing docs at the same time can still overwrite each other; a program runs its items one at a time (`server/program/controller.ts:3`).

---

### Task 1: The API check keeps what the current docs/API.md documents

**Files:**
- Modify: `server/validators/docs.ts:56-61` (`validateApiDocs`), `:80-89` (`validateDocs`)
- Test: `test/validators/docs.test.ts`

**Interfaces:**
- Produces: `validateApiDocs(md: string | null, features: readonly string[], current = ''): string[]` and `validateDocs(d: DocsInput, features: readonly string[], readmeSections: readonly string[] = [], current?: DocsInput): string[]`; the new message is `docs/API.md dropped endpoint <path>, which it documented before; keep it, or mark it as removed if this spec removed it`.

- [ ] **Step 1: Write the failing tests**

Add to `describe('validateApiDocs', ...)` in `test/validators/docs.test.ts`:

```ts
  it('keeps every endpoint the current docs/API.md documents, since earlier specs wrote it', () => {
    const current = '# API\n\n### POST /stock\n\n### GET /stock/{sku}\n';
    expect(validateApiDocs('### POST /orders', ['POST /orders creates an order'], current)).toEqual([
      'docs/API.md dropped endpoint /stock, which it documented before; keep it, or mark it as removed if this spec removed it',
      'docs/API.md dropped endpoint /stock/{sku}, which it documented before; keep it, or mark it as removed if this spec removed it',
    ]);
    expect(validateApiDocs(`${current}\n### POST /orders`, ['POST /orders creates an order'], current)).toEqual([]);
  });
  it('accepts an endpoint the rewrite marks as removed', () => {
    expect(validateApiDocs('### POST /orders\n\n`/stock` was removed by this spec.', [], '### POST /stock')).toEqual([]);
  });
  it('lets an empty answer through, since it leaves the current file in place', () => {
    expect(validateApiDocs('', ['sums numbers'], '### POST /stock')).toEqual([]);
  });
```

Add to `describe('validateDocs', ...)`:

```ts
  it('checks the API answer against the docs/API.md it replaces', () => {
    expect(validateDocs({ readme: GOOD_README, runbook: GOOD_RUNBOOK, apiDocs: '/health' }, ['GET /health'], [], { readme: '', runbook: '', apiDocs: '### GET /stock' })).toEqual([
      'docs/API.md dropped endpoint /stock, which it documented before; keep it, or mark it as removed if this spec removed it',
    ]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/validators/docs.test.ts`
Expected: the "keeps every endpoint" and "checks the API answer" cases FAIL (nothing reported); the "marks as removed" and "empty answer" cases pass already, since they pin what must stay allowed.

- [ ] **Step 3: Implement**

In `server/validators/docs.ts`, replace `validateApiDocs` with:

```ts
/** `current`: the docs/API.md the answer replaces; earlier specs wrote it, so its endpoints stay. */
export function validateApiDocs(md: string | null, features: readonly string[], current = ''): string[] {
  const endpoints = featureEndpoints(features);
  // An empty answer leaves the current file in place, so only a rewrite has to keep what it documents.
  if (!md?.trim()) return endpoints.length === 0 ? [] : ['docs/API.md is empty; the spec features name endpoints'];
  return [
    ...endpoints.filter((e) => !md.includes(e)).map((e) => `docs/API.md does not document endpoint ${e}`),
    ...featureEndpoints([current]).filter((e) => !endpoints.includes(e) && !md.includes(e)).map((e) => `docs/API.md dropped endpoint ${e}, which it documented before; keep it, or mark it as removed if this spec removed it`),
  ];
}
```

and `validateDocs` with:

```ts
/** `readmeSections`: the plan's delivery sections; the standard five are already required with their content. `current`: the docs on main the answer replaces. */
export function validateDocs(d: DocsInput, features: readonly string[], readmeSections: readonly string[] = [], current?: DocsInput): string[] {
  const planned = missingReadmeSections(d.readme, readmeSections.filter((s) => !standardSection(s)));
  return [
    ...validateReadme(d.readme),
    ...planned.map((s) => `docs/README.md is missing a "${s}" section the plan requires (add a heading naming it)`),
    ...validateRunbook(d.runbook ?? ''),
    ...validateApiDocs(d.apiDocs ?? null, features, current?.apiDocs ?? ''),
  ];
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run test/validators test/orchestrator/phase6-docs.test.ts && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 5: Commit**

```bash
git add server/validators/docs.ts test/validators/docs.test.ts
git commit -m "fix(docs): the API check keeps what the current API.md documents

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: The report and readme steps rewrite the current docs

**Files:**
- Modify: `server/orchestrator/steps.ts:340-383` (`DOCS_STRUCTURE`, `readmePack`, `reportPack`, a new `currentDocsLines`)
- Modify: `server/orchestrator/phases/shared.ts` (a new `currentDocs`, after `docsWorktree`)
- Modify: `server/orchestrator/phases/report.ts:53-73` (worktree first, current docs, `cwd`)
- Modify: `server/orchestrator/run.ts:668-686` (`writeReadme`)
- Test: `test/orchestrator/steps.test.ts`, `test/orchestrator/phase6-docs.test.ts`, `test/orchestrator/run.test.ts`

**Interfaces:**
- Consumes: `validateDocs(d, features, readmeSections, current?)` from Task 1; `DocsInput` from `server/validators/docs.ts`.
- Produces: `currentDocs(worktree: string): Promise<DocsInput>` in `server/orchestrator/phases/shared.ts`; `readmePack(base, { tasks, current?, docsErrors?, readmeSections? })` (the `existing` option is gone) and `reportPack(base, { ..., current? })`.

- [ ] **Step 1: Write the failing tests**

In `test/orchestrator/steps.test.ts`, drop `existing: null, ` from the three `readmePack(...)` calls (lines 174, 180 and 183), and add after the test "report and readme packs name the README sections the plan requires":

```ts
  it('report and readme packs carry the current docs with the rule to keep what earlier specs wrote', () => {
    const current = { readme: '# Loja\n\n- AC-001: o estoque cadastra um sku.', runbook: '', apiDocs: '### POST /stock' };
    const opts = { delivered: ['T1'], blocked: [], evidence: '[]', assumptions: [], deploy: '{}', hostUrl: null, tokens: '{}', security: '' };
    for (const f of [reportPack(base, { ...opts, current }).feedback!, readmePack(base, { tasks: [], current }).feedback!]) {
      expect(f).toContain('keep every section, acceptance criterion and endpoint they hold that is still true');
      expect(f).toContain('Current docs/README.md:\n# Loja\n\n- AC-001: o estoque cadastra um sku.');
      expect(f).toContain('There is no docs/RUNBOOK.md yet.');
      expect(f).toContain('Current docs/API.md:\n### POST /stock');
    }
  });

  it('cuts a long current doc and sends the step to the whole file, so the instructions stay inside the pack budget', () => {
    const f = readmePack(base, { tasks: [], current: { readme: `# Big\n${'x'.repeat(20_000)}`, runbook: '', apiDocs: '' } }).feedback!;
    expect(f).toContain('Current docs/README.md (cut at 8000 characters; read the whole file before you rewrite it):\n# Big');
    expect(f.length).toBeLessThan(12_000);
  });
```

In `test/orchestrator/phase6-docs.test.ts`, add `import { promises as fs } from 'node:fs';` at the top, this helper after `p6`:

```ts
/** Earlier specs' docs reach main from elsewhere, so the run's own checkout stays behind main, as between runs. */
async function mainWrites(files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) await fs.writeFile(path.join(remote.repo, rel), text);
  await git(remote.repo, ['add', '-A'], execCommand);
  await git(remote.repo, ['commit', '-q', '-m', 'earlier spec docs'], execCommand);
  await git(remote.repo, ['push', '-q', 'origin', 'HEAD:main'], execCommand);
  await git(remote.repo, ['reset', '-q', '--hard', 'HEAD~1'], execCommand);
}
```

and this test at the end of `describe('Phase 6 documentation gate', ...)`:

```ts
  it('gives the report step the docs earlier specs wrote, in its working directory too, and keeps the endpoints they document', async () => {
    await mainWrites({ 'docs/README.md': '# Loja\n\n- AC-001: o estoque cadastra um sku.\n', 'docs/API.md': '# API\n\n### POST /stock\n' });
    const seen: string[] = [];
    let n = 0;
    const r = await p6(async (req) => {
      seen.push(await fs.readFile(path.join(req.cwd, 'docs', 'API.md'), 'utf8').catch(() => 'missing'));
      return report({ ...GOOD, apiDocs: ++n === 1 ? '# API\n\n### GET /orders\n' : '# API\n\n### POST /stock\n\n### GET /orders\n' });
    });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[0]!.pack)).toContain('AC-001: o estoque cadastra um sku.');
    expect(seen[0]).toContain('### POST /stock');
    expect(JSON.stringify(calls[1]!.pack)).toContain('docs/API.md dropped endpoint /stock');
    await git(remote.repo, ['fetch', '-q', 'origin'], execCommand);
    expect(await git(remote.repo, ['show', 'origin/main:docs/API.md'], execCommand)).toContain('### POST /stock');
  });
```

In `test/orchestrator/run.test.ts`, add at the end of `describe('Run', ...)`:

```ts
  it('spec readme hands the SM the current docs and keeps every endpoint the current API.md documents', async () => {
    await fs.writeFile(path.join(remote.repo, 'docs', 'API.md'), '# API\n\n### POST /stock\n');
    await git(remote.repo, ['add', '-A'], execCommand);
    await git(remote.repo, ['commit', '-q', '-m', 'earlier spec docs'], execCommand);
    await git(remote.repo, ['push', '-q', 'origin', 'HEAD:main'], execCommand);
    const section = (t: string) => `## ${t}\n\nReal explanatory content that is long enough to count.\n`;
    const prompts: string[] = [];
    const script: Script = async (req) => {
      prompts.push(req.prompt);
      const apiDocs = prompts.length === 1 ? '# API\n\n### GET /orders\n' : '# API\n\n### POST /stock\n\n### GET /orders\n';
      return { ok: true, value: { specHash: HASH, readme: ['Run', 'Test', 'Environment variables', 'Architecture', 'Pipeline'].map(section).join('\n'), runbook: ['Start', 'Stop', 'Logs', 'Rollback'].map(section).join('\n'), apiDocs }, summary: summary() };
    };
    const run = await Run.create(await withAgents(deps(script)));
    expect(await run.writeReadme()).toBe('done');
    expect(prompts[0]).toContain('Current docs/API.md:\n# API\n\n### POST /stock');
    expect(prompts[1]).toContain('docs/API.md dropped endpoint /stock');
    await git(remote.repo, ['fetch', '-q', 'origin'], execCommand);
    expect(await git(remote.repo, ['show', 'origin/main:docs/API.md'], execCommand)).toContain('### POST /stock');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/orchestrator/steps.test.ts test/orchestrator/phase6-docs.test.ts test/orchestrator/run.test.ts`
Expected: the four new cases FAIL (the packs say there is no docs/README.md, Phase 6 accepts the first answer and runs in the run's own checkout, the readme step accepts the first answer); every other case passes.

- [ ] **Step 3: Implement the packs**

In `server/orchestrator/steps.ts`, add `import type { DocsInput } from '../validators/docs.js';` to the imports, replace the `apiDocs` line of `DOCS_STRUCTURE` with:

```ts
  '- `apiDocs` (docs/API.md): every endpoint named in the spec features or documented in the current docs/API.md, written with its exact path (only needed when the features name endpoints; an empty `apiDocs` leaves the current file as it is).',
```

add after `plannedSections`:

```ts
/** Long enough for real docs, short enough that the step's own instructions stay inside the pack budget. */
const CURRENT_DOC_CHARS = 8_000;

/** The shared docs on main, which earlier specs wrote; a rewrite keeps what is still true of them. */
function currentDocsLines(current: DocsInput | undefined): string[] {
  const shown = (file: string, text: string | null | undefined) => (!text?.trim()
    ? `There is no ${file} yet.`
    : `Current ${file}${text.length > CURRENT_DOC_CHARS ? ` (cut at ${CURRENT_DOC_CHARS} characters; read the whole file before you rewrite it)` : ''}:\n${text.slice(0, CURRENT_DOC_CHARS)}`);
  return [
    'Rewrite the current docs below, which earlier specs of this project wrote: keep every section, acceptance criterion and endpoint they hold that is still true, and add what this spec delivered. An endpoint docs/API.md documents stays in it; one this spec removed is marked as removed, never deleted.',
    shown('docs/README.md', current?.readme),
    shown('docs/RUNBOOK.md', current?.runbook),
    shown('docs/API.md', current?.apiDocs),
  ];
}
```

In `readmePack`, change the option `existing: string | null` to `current?: DocsInput`, and replace its last line (`opts.existing ? ... : 'There is no docs/README.md yet.',`) with `...currentDocsLines(opts.current),`.

In `reportPack`, add `current?: DocsInput` to the options and `...currentDocsLines(opts.current),` after the `Token usage` line.

- [ ] **Step 4: Implement the two writers**

In `server/orchestrator/phases/shared.ts`, add `import type { DocsInput } from '../../validators/docs.js';` and after `docsWorktree`:

```ts
/** The shared docs a docs worktree holds, which earlier specs wrote; a missing file reads as empty. */
export async function currentDocs(worktree: string): Promise<DocsInput> {
  const read = (file: string) => fs.readFile(path.join(worktree, 'docs', file), 'utf8').catch(() => '');
  return { readme: await read('README.md'), runbook: await read('RUNBOOK.md'), apiDocs: await read('API.md') };
}
```

In `server/orchestrator/phases/report.ts`, import `currentDocs` from `./shared.js`, and add before `let script` (line 54):

```ts
  // The step works in the docs worktree, a checkout of main, so it can read whole any document the pack cuts.
  const branch = `docs/${deps.spec.specId}-report`; const wt = await docsWorktree(deps, branch); const current = await currentDocs(wt);
```

then in the loop pass `current` to `reportPack(...)`, `cwd: wt` instead of `cwd: deps.ws.repo`, and `current` as the fourth argument of `validateDocs(...)`; and start line 69 at `const dir = path.join(wt, specDir(deps.spec.specId));` (the branch and worktree already exist).

In `server/orchestrator/run.ts` `writeReadme`, replace `const existing = await fs.readFile(rel('docs', 'README.md'), 'utf8').catch(() => null);` with `const current = await shared.currentDocs(wt);`, pass `current` instead of `existing` to `readmePack(...)`, and `current` as the fourth argument of `validateDocs(...)`.

- [ ] **Step 5: Run them to verify they pass**

Run: `npx vitest run test/orchestrator test/validators && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 6: Commit**

```bash
git add server/orchestrator/steps.ts server/orchestrator/phases/shared.ts server/orchestrator/phases/report.ts server/orchestrator/run.ts test/orchestrator/steps.test.ts test/orchestrator/phase6-docs.test.ts test/orchestrator/run.test.ts
git commit -m "fix(docs): the report and readme steps rewrite the current docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Record R11.5.4 in the roadmap and the plans index

**Files:**
- Modify: `docs/superpowers/ROADMAP.md` (section `### R11.5 Autonomy hardening`, after the R11.5.3 lines)
- Modify: `docs/superpowers/plans/README.md` (the table, after row 68)

- [ ] **Step 1: Update the roadmap**

Add after the last R11.5.3 line:

```md
- Built R11.5.4 (plan 69): the report step and the `spec readme` command get the current `docs/README.md`, `docs/RUNBOOK.md` and `docs/API.md` with the rule to keep what earlier specs wrote that is still true, and run in the docs worktree, a checkout of main, so a document cut in the pack can be read whole (`currentDocs`, `currentDocsLines`); the API check also keeps every endpoint the current `docs/API.md` documents, unless the rewrite marks it as removed (`validateApiDocs`). Seen live: `cancelar-pedido` replaced the criteria section `reservar-estoque` wrote in the README.
```

- [ ] **Step 2: Update the plans index**

Add after row 68 of `docs/superpowers/plans/README.md`:

```md
| 69 | [`2026-10-12-teams-ai-69-docs-accumulate.md`](2026-10-12-teams-ai-69-docs-accumulate.md) | Done — the report and readme steps rewrite the current docs and keep the endpoints the current API.md documents; ROADMAP R11.5.4. |
```

- [ ] **Step 3: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit -p . && (cd web && npx vitest run && npx tsc --noEmit -p .)`
Expected: every suite passes, both type checks clean.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/ROADMAP.md docs/superpowers/plans/README.md
git commit -m "docs(roadmap): R11.5.4 docs accumulate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
