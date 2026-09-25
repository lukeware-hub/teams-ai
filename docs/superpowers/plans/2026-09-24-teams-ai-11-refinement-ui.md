# teams-ai Plan 11 — Refinement (Gate 1) and Phase 0 Implementation Plan

**Status: not started**

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the browser, turn Markdown documentation into a frozen `spec.json` through PO/SM questions and accepted patches, then start a run that creates the GitHub repository (or merges a docs PR) before Phase 1.

**Architecture:** A `RefineSession` lives in the `teams-ai ui` process and is the single writer of a per-spec journal (`EventStore`) under `workspaces/<projectId>/refine/<specId>/`; every state is a reduction of that journal. Agent steps reuse `runAgentStep` (governor, breaker, redaction, `STEP_*` events). The draft root holds `docs/project.json`, so it is a valid block A project directory: "Start" freezes the spec, registers the draft root, and spawns `teams-ai run --project <draftRoot> --spec <id> --run-id <id> --draft`; the run's new Phase 0 pushes `docs/` to `main` under intent → effect → confirm.

**Tech Stack:** Node 22, TypeScript, zod 4, `node:http` router (`server/api/server.ts`), Vitest; `diff` (new, server-side unified diffs); React 19 + react-router 7 in `web/`.

**Spec:** `docs/superpowers/specs/2026-09-24-refinement-ui-design.md` (block B). Block A interfaces it consumes: `docs/superpowers/plans/2026-09-24-teams-ai-10-run-api-execution-ui.md`.

## Global Constraints

- The UI process never runs `git`, `gh`, `docker`; Phase 0 runs inside the spawned CLI (spec §2, §7).
- Only `docs/project.md` and `docs/specs/<specId>/brief.md` are ever patched; derived JSON is written by the orchestrator only (spec §3.4, §7).
- Secrets: one file per name in `~/.teams-ai/secrets/` via `writeSecret`; the API returns `present` and a 4-character hint, never a value (spec §3.5).
- `projectId` and `specId` match `ID_PATTERNS.SLUG` (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`) before any path is built (spec §5).
- Agent packs contain secret names only, never values (spec §7).
- Copy in English; conventional commits; run `npm run typecheck && npm test` (root) and `npm run test:web` before each commit touching the respective tree.
- Every event appended to a refine journal is a `fact` except the run's Phase 0 intents; the journal `specHash` field is the literal `draft` (no frozen hash exists yet).

## Review Focus

1. A patch whose `find` occurs twice, or zero times, must be discarded with a reason and never applied — Task 3.
2. Accepting a patch after a manual edit removed its `find` must answer 409 and drop the patch, leaving the file untouched — Task 6.
3. A blocking question cannot be skipped (409) and `ready` is impossible while one is pending — Task 6.
4. Server restart mid-cycle must replay as `error: interrupted` and the next evaluate must work — Task 6.
5. `POST /refine/:id/start` on a stale or non-ready session must be 409 and must not spawn or register anything — Task 9.

---

### Task 1: Contracts — `derive` step kind, `DeriveOutput`, checklist ids, agent prompt sections, `AgentStepDeps.journal` narrowed

**Files:**
- Modify: `server/agents/outputs.ts:7` (STEP_KINDS), after `RefineOutput` (new schema), `OUTPUT_SCHEMAS`
- Create: `server/refine/checklist.ts`
- Modify: `server/orchestrator/steps.ts:171-183` (`AgentStepDeps.journal`)
- Modify: `.claude/agents/po.md`, `.claude/agents/sm.md`
- Test: `test/agents/outputs.test.ts` (existing file; add cases), `test/refine/checklist.test.ts`

**Interfaces:**
- Produces: `STEP_KINDS` gains `'derive'`; `DeriveOutput = z.object({ specHash, project: Project, spec: Spec })`; `OUTPUT_SCHEMAS.derive = DeriveOutput`.
- Produces (`server/refine/checklist.ts`):

```ts
export const PO_ITEMS = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions'] as const;
export const SM_ITEMS = ['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'] as const;
export type ChecklistId = (typeof PO_ITEMS)[number] | (typeof SM_ITEMS)[number];
export interface ChecklistItem { id: ChecklistId; role: 'po' | 'sm'; passed: boolean; detail: string }
export function mergeChecklist(po: ReadonlyArray<{ id: string; passed: boolean; detail: string }>, sm: ReadonlyArray<{ id: string; passed: boolean; detail: string }>): ChecklistItem[]
```
  `mergeChecklist` returns exactly the 8 ids in order; an id a role did not report is `{ passed: false, detail: 'not reported' }`; ids outside the role's list are ignored.
- Produces: `AgentStepDeps.journal: Pick<Journal, 'allocStepSeq' | 'fact'>` (was `Journal`), so a refine session can pass its own journal.

- [ ] **Step 1: Write the failing tests**

Append to `test/agents/outputs.test.ts`:

```ts
import { DeriveOutput, OUTPUT_SCHEMAS, STEP_KINDS } from '../../server/agents/outputs.js';
import { HELLO_PROJECT, HELLO_SPEC } from '../fixtures/contracts.js'; // add these two exports to the fixture if absent: parsed hello-app project.json / spec.json

describe('derive output', () => {
  it('is a step kind whose output carries a project and a spec', () => {
    expect(STEP_KINDS).toContain('derive');
    const out = DeriveOutput.parse({ specHash: 'a'.repeat(64), project: HELLO_PROJECT, spec: { ...HELLO_SPEC, status: 'refining', specHash: null } });
    expect(out.spec.status).toBe('refining');
    expect(OUTPUT_SCHEMAS.derive).toBe(DeriveOutput);
  });
});
```

Create `test/refine/checklist.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mergeChecklist, PO_ITEMS, SM_ITEMS } from '../../server/refine/checklist.js';

describe('mergeChecklist', () => {
  it('returns the eight fixed ids, filling omitted ones as not reported and ignoring foreign ids', () => {
    const items = mergeChecklist(
      [{ id: 'po.personas', passed: true, detail: 'two personas' }, { id: 'sm.constraints-clear', passed: true, detail: 'nope' }],
      [{ id: 'sm.constraints-clear', passed: false, detail: 'vague' }],
    );
    expect(items.map((i) => i.id)).toEqual([...PO_ITEMS, ...SM_ITEMS]);
    expect(items.find((i) => i.id === 'po.personas')).toMatchObject({ role: 'po', passed: true });
    expect(items.find((i) => i.id === 'po.objectives-verifiable')).toMatchObject({ passed: false, detail: 'not reported' });
    expect(items.find((i) => i.id === 'sm.constraints-clear')).toMatchObject({ role: 'sm', passed: false, detail: 'vague' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/agents/outputs.test.ts test/refine/checklist.test.ts`
Expected: FAIL — `DeriveOutput` not exported; module `server/refine/checklist.js` not found.

- [ ] **Step 3: Implement**

`server/agents/outputs.ts`: add `'derive'` to `STEP_KINDS`; import `Project` from `../contracts/project.js` and `Spec` from `../contracts/spec.js`; add after `RefineOutput`:

```ts
/** Spec (refinement) §3.2 step 1: Markdown → project.json + spec.json; the orchestrator re-validates and forces status/hash/version. */
export const DeriveOutput = z.object({ specHash, project: Project, spec: Spec });
export type DeriveOutput = z.infer<typeof DeriveOutput>;
```

and `derive: DeriveOutput` in `OUTPUT_SCHEMAS`.

Create `server/refine/checklist.ts`:

```ts
export const PO_ITEMS = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions'] as const;
export const SM_ITEMS = ['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'] as const;
export type ChecklistId = (typeof PO_ITEMS)[number] | (typeof SM_ITEMS)[number];
export interface ChecklistItem { id: ChecklistId; role: 'po' | 'sm'; passed: boolean; detail: string }
type Reported = ReadonlyArray<{ id: string; passed: boolean; detail: string }>;

/** Spec (refinement) §3.2 step 4: fixed ids per role; omitted items fail as "not reported". */
export function mergeChecklist(po: Reported, sm: Reported): ChecklistItem[] {
  const pick = (role: 'po' | 'sm', ids: readonly ChecklistId[], reported: Reported): ChecklistItem[] =>
    ids.map((id) => {
      const r = reported.find((x) => x.id === id);
      return r ? { id, role, passed: r.passed, detail: r.detail } : { id, role, passed: false, detail: 'not reported' };
    });
  return [...pick('po', PO_ITEMS, po), ...pick('sm', SM_ITEMS, sm)];
}
```

`server/orchestrator/steps.ts`: change `journal: Journal;` in `AgentStepDeps` to `journal: Pick<Journal, 'allocStepSeq' | 'fact'>;`.

`.claude/agents/po.md` — append:

```markdown
## Deriving the contracts (`derive` step)

You receive `project.md`, `brief.md`, the previous `project.json` and `spec.json` when they exist, and both JSON schemas. Return `{specHash, project, spec}` where `project` and `spec` are the JSON documents the Markdown describes. Keep the id of every acceptance criterion whose text did not change; number new ones after the highest existing id. `spec.status` is `refining`, `spec.specHash` is `null`, `spec.specVersion` is the previous value or 0. Invent nothing: an objective, persona or dependency absent from the Markdown is absent from the JSON.

## Refining the documentation (`refine` step)

You receive both Markdown files, the derived JSON, prior specs and ADRs, the answered and skipped questions, and the patches the human rejected with their reasons. Return `{specHash, checklist, questions, docPatch}`. Report exactly these checklist ids: `po.objectives-verifiable`, `po.personas`, `po.scope-explicit`, `po.no-contradictions`. Ask one question per ambiguity; do not repeat a question already answered or skipped. Each `docPatch` targets `docs/project.md` or `docs/specs/<specId>/brief.md` and its `find` is a verbatim excerpt that occurs exactly once; never propose again a patch the human rejected.
```

`.claude/agents/sm.md` — append:

```markdown
## Refining the documentation (`refine` step)

You receive both Markdown files, the derived JSON, prior specs and ADRs, the answered and skipped questions, and the patches the human rejected with their reasons. Return `{specHash, checklist, questions, docPatch}`. Report exactly these checklist ids: `sm.dependencies-and-secrets`, `sm.constraints-clear`, `sm.tasks-feasible`, `sm.no-open-questions` (the orchestrator overrides the first and the last from what it observes). Ask one question per ambiguity; do not repeat a question already answered or skipped. Each `docPatch` targets `docs/project.md` or `docs/specs/<specId>/brief.md` and its `find` is a verbatim excerpt that occurs exactly once; never propose again a patch the human rejected.
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/agents test/refine && npm run typecheck`
Expected: PASS; typecheck clean (`Journal` satisfies the `Pick`).

- [ ] **Step 5: Commit**

```bash
git add server/agents/outputs.ts server/refine/checklist.ts server/orchestrator/steps.ts .claude/agents/po.md .claude/agents/sm.md test/agents/outputs.test.ts test/refine/checklist.test.ts test/fixtures/contracts.ts
git commit -m "feat(refine): derive step contract, fixed checklist ids, refine prompt sections"
```

---

### Task 2: Draft layout — paths, templates, copy from `main`, renderers, draft hash

**Files:**
- Create: `server/refine/draft.ts`
- Test: `test/refine/draft.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Draft { projectId: string; specId: string; root: string; docs: string; projectMd: string; projectJson: string; briefMd: string; specJson: string; events: string; steps: (seq: number) => string }
export function draftPaths(ws: Workspace, specId: string): Draft            // root = <ws.root>/refine/<specId>
export type DocFile = 'project.md' | 'brief.md';
export function docPath(d: Draft, file: DocFile): string
export const DOC_REL: Record<DocFile, (specId: string) => string>          // 'docs/project.md', 'docs/specs/<id>/brief.md'
export function projectTemplate(name: string): string
export function briefTemplate(): string
export function renderProjectMd(p: Project): string                        // sections: Vision, Personas, Constraints, Stack, Principles, Deploy target, GitHub owner
export function renderBriefMd(s: Spec, validationReport?: string): string  // sections: Objectives, Features, Acceptance criteria (id + G/W/T + smoke), Out of scope, External dependencies (names + secretNames), Tasks, Validation report
export async function draftExists(d: Draft): Promise<boolean>
export async function createNewProject(d: Draft, name: string): Promise<void>      // templates only; no project.json yet
export async function createFromRepo(d: Draft, repo: string, exec: Exec, mode: { kind: 'new-spec' } | { kind: 'continue'; report?: string }): Promise<void>
export async function readDoc(d: Draft, file: DocFile): Promise<string>
export async function writeDoc(d: Draft, file: DocFile, text: string): Promise<void>
export async function readDerived(d: Draft): Promise<{ project: Project; spec: Spec } | null>
export async function writeDerived(d: Draft, v: { project: Project; spec: Spec }): Promise<void>
export async function draftHash(d: Draft): Promise<string>                 // sha256(canonicalJson({ project: md, brief: md }))
```

`createFromRepo` runs `git fetch`, lists `origin/main` with `git ls-tree -r --name-only origin/main docs/` and copies every file with `git show origin/main:<rel>` into `d.docs`. When `docs/project.md` is absent on `main`, it is rendered from `project.json`. `new-spec` writes `briefTemplate()` and no `spec.json`; `continue` renders `brief.md` from the spec on `main` (plus the report section) and writes `spec.json` with `status: 'refining'`.

- [ ] **Step 1: Write the failing tests**

Create `test/refine/draft.test.ts`:

```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { createFromRepo, createNewProject, draftHash, draftPaths, readDerived, readDoc, renderBriefMd, writeDoc } from '../../server/refine/draft.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const HELLO = path.resolve('test/fixtures/hello-app/docs');
let root = '';
let ws: Workspace;
let remote: Remote | null = null;

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-draft-'))).replace(/\\/g, '/');
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/worktrees`, graph: `${root}/graph`, knowledgeDb: `${root}/k.sqlite`, runs: `${root}/runs` };
});
afterEach(async () => {
  await remote?.cleanup();
  await fs.rm(root, { recursive: true, force: true });
});

describe('draft', () => {
  it('creates a new project from templates and hashes the two Markdown files', async () => {
    const d = draftPaths(ws, 'hello-001');
    await createNewProject(d, 'Hello App');
    expect(d.root).toBe(`${root}/refine/hello-001`);
    expect(await readDoc(d, 'project.md')).toContain('# Hello App');
    expect(await readDoc(d, 'brief.md')).toContain('## Acceptance criteria');
    expect(await readDerived(d)).toBeNull();
    const h1 = await draftHash(d);
    await writeDoc(d, 'brief.md', '## Objectives\n- ship');
    expect(await draftHash(d)).not.toBe(h1);
  });

  it('copies docs from origin/main, renders project.md when absent, and prefills brief.md on continue', async () => {
    const project = await fs.readFile(path.join(HELLO, 'project.json'), 'utf8');
    const spec = JSON.parse(await fs.readFile(path.join(HELLO, 'specs/hello-001/spec.json'), 'utf8'));
    spec.status = 'awaiting-validation';
    spec.validationReports = [{ at: '2026-09-24T10:00:00.000Z', text: 'GET /hello returned 500' }];
    remote = await makeRemote({ 'docs/project.json': project, 'docs/specs/hello-001/spec.json': JSON.stringify(spec), 'docs/adr/ADR-001-stack.md': '# ADR-001 stack' });
    const d = draftPaths(ws, 'hello-001');
    await createFromRepo(d, remote.repo, execCommand, { kind: 'continue', report: 'GET /hello returned 500' });
    expect(await readDoc(d, 'project.md')).toContain('## Personas');
    expect(await readDoc(d, 'brief.md')).toContain('## Validation report');
    expect(await readDoc(d, 'brief.md')).toContain('GET /hello returned 500');
    expect(await fs.readFile(path.join(d.docs, 'adr/ADR-001-stack.md'), 'utf8')).toBe('# ADR-001 stack');
    const derived = await readDerived(d);
    expect(derived?.spec.status).toBe('refining');
    expect(derived?.spec.specHash).toBeNull();
    const d2 = draftPaths(ws, 'hello-002');
    await createFromRepo(d2, remote.repo, execCommand, { kind: 'new-spec' });
    expect(await readDoc(d2, 'brief.md')).toContain('## Objectives');
    expect(await readDerived(d2)).toBeNull();
  });

  it('renderBriefMd lists every acceptance criterion with its id', () => {
    const md = renderBriefMd({ specId: 's', specVersion: 1, specHash: null, objectives: ['o'], features: [], acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w', then: 't', smoke: true }], outOfScope: [], externalDependencies: [{ name: 'db', purpose: 'p', secretNames: ['DB_URL'] }], status: 'refining', validationReports: [] });
    expect(md).toContain('AC-001');
    expect(md).toContain('smoke');
    expect(md).toContain('DB_URL');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/refine/draft.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/refine/draft.ts`**

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import { Project } from '../contracts/project.js';
import { Spec } from '../contracts/spec.js';
import type { Exec } from '../exec/command.js';
import { fetch as gitFetch, git } from '../git/git.js';
import { stepId } from '../core/ids.js';
import type { Workspace } from '../orchestrator/workspace.js';

export interface Draft { projectId: string; specId: string; root: string; docs: string; projectMd: string; projectJson: string; briefMd: string; specJson: string; events: string; steps: (seq: number) => string }
export type DocFile = 'project.md' | 'brief.md';

export const DOC_REL: Record<DocFile, (specId: string) => string> = {
  'project.md': () => 'docs/project.md',
  'brief.md': (specId) => `docs/specs/${specId}/brief.md`,
};

/** Spec (refinement) §2: the draft lives beside the workspace, never inside the clone. */
export function draftPaths(ws: Workspace, specId: string): Draft {
  const root = path.posix.join(ws.root, 'refine', specId);
  const docs = path.posix.join(root, 'docs');
  return {
    projectId: ws.projectId, specId, root, docs,
    projectMd: path.posix.join(docs, 'project.md'),
    projectJson: path.posix.join(docs, 'project.json'),
    briefMd: path.posix.join(docs, 'specs', specId, 'brief.md'),
    specJson: path.posix.join(docs, 'specs', specId, 'spec.json'),
    events: path.posix.join(root, 'events.ndjson'),
    steps: (seq) => path.posix.join(root, 'steps', stepId(seq)),
  };
}

export const docPath = (d: Draft, file: DocFile): string => (file === 'project.md' ? d.projectMd : d.briefMd);

export function projectTemplate(name: string): string {
  return `# ${name}\n\n## Vision\n\n<what the product is and why it exists>\n\n## Personas\n\n- <name>: <who they are and what they need>\n\n## Constraints\n\n- <free-text constraint>\n\n## Stack\n\n<optional; leave empty to let the Dev choose>\n\n## Principles\n\n- <non-negotiable rule every agent follows>\n\n## Deploy target\n\ndocker-local\n\n## GitHub owner\n\n<optional override of config.json github.owner>\n`;
}

export function briefTemplate(): string {
  return `## Objectives\n\n- <objective>\n\n## Features\n\n- <feature>\n\n## Acceptance criteria\n\n- AC-001 (smoke): Given <state>, when <action>, then <outcome>\n\n## Out of scope\n\n- <item>\n\n## External dependencies\n\n- <name>: <purpose> (secrets: <NAME>)\n\n## Tasks\n\n<optional; one "- title: description" per line>\n`;
}

const list = (items: readonly string[]) => (items.length === 0 ? '- (none)' : items.map((i) => `- ${i}`).join('\n'));

export function renderProjectMd(p: Project): string {
  return [
    `# ${p.name}`, '', '## Vision', '', p.vision, '', '## Personas', '', list(p.personas.map((x) => `${x.name}: ${x.description}`)), '',
    '## Constraints', '', list(p.constraints), '', '## Stack', '', p.stack ?? '', '', '## Principles', '', list(p.principles), '',
    '## Deploy target', '', p.deploy.target, '', '## GitHub owner', '', p.github.owner ?? '', '',
  ].join('\n');
}

export function renderBriefMd(s: Spec, validationReport?: string): string {
  const acs = s.acceptanceCriteria.map((c) => `- ${c.id}${c.smoke ? ' (smoke)' : ''}: Given ${c.given}, when ${c.when}, then ${c.then}`);
  const deps = s.externalDependencies.map((d) => `${d.name}: ${d.purpose} (secrets: ${d.secretNames.join(', ') || 'none'})`);
  const tasks = (s.tasks ?? []).map((t) => `${t.title}: ${t.description}`);
  const parts = [
    '## Objectives', '', list(s.objectives), '', '## Features', '', list(s.features), '', '## Acceptance criteria', '', acs.join('\n') || '- (none)', '',
    '## Out of scope', '', list(s.outOfScope), '', '## External dependencies', '', list(deps), '', '## Tasks', '', list(tasks), '',
  ];
  if (validationReport) parts.push('## Validation report', '', validationReport, '');
  return parts.join('\n');
}

export const draftExists = (d: Draft): Promise<boolean> => fs.access(d.briefMd).then(() => true, () => false);

export async function createNewProject(d: Draft, name: string): Promise<void> {
  await fs.mkdir(path.dirname(d.briefMd), { recursive: true });
  await fs.writeFile(d.projectMd, projectTemplate(name));
  await fs.writeFile(d.briefMd, briefTemplate());
}

export async function createFromRepo(d: Draft, repo: string, exec: Exec, mode: { kind: 'new-spec' } | { kind: 'continue'; report?: string }): Promise<void> {
  await gitFetch(repo, exec);
  const files = (await git(repo, ['ls-tree', '-r', '--name-only', 'origin/main', 'docs/'], exec)).split('\n').filter((f) => f !== '');
  for (const rel of files) {
    const target = path.posix.join(d.root, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await git(repo, ['show', `origin/main:${rel}`], exec));
  }
  await fs.mkdir(path.dirname(d.briefMd), { recursive: true });
  if (!files.includes('docs/project.md')) {
    const project = Project.parse(JSON.parse(await fs.readFile(d.projectJson, 'utf8')));
    await fs.writeFile(d.projectMd, renderProjectMd(project));
  }
  if (mode.kind === 'new-spec') {
    await fs.writeFile(d.briefMd, briefTemplate());
    return;
  }
  const spec = Spec.parse(JSON.parse(await fs.readFile(d.specJson, 'utf8')));
  await fs.writeFile(d.briefMd, renderBriefMd(spec, mode.report));
  await fs.writeFile(d.specJson, JSON.stringify({ ...spec, status: 'refining', specHash: null }, null, 2));
}

export const readDoc = (d: Draft, file: DocFile): Promise<string> => fs.readFile(docPath(d, file), 'utf8');
export const writeDoc = (d: Draft, file: DocFile, text: string): Promise<void> => fs.writeFile(docPath(d, file), text);

export async function readDerived(d: Draft): Promise<{ project: Project; spec: Spec } | null> {
  const read = (f: string) => fs.readFile(f, 'utf8').then(JSON.parse, () => null);
  const [p, s] = await Promise.all([read(d.projectJson), read(d.specJson)]);
  if (p === null || s === null) return null;
  return { project: Project.parse(p), spec: Spec.parse(s) };
}

export async function writeDerived(d: Draft, v: { project: Project; spec: Spec }): Promise<void> {
  await fs.writeFile(d.projectJson, JSON.stringify(v.project, null, 2));
  await fs.writeFile(d.specJson, JSON.stringify(v.spec, null, 2));
}

export async function draftHash(d: Draft): Promise<string> {
  const [project, brief] = await Promise.all([readDoc(d, 'project.md'), readDoc(d, 'brief.md')]);
  return sha256(canonicalJson({ project, brief }));
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/refine/draft.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/refine/draft.ts test/refine/draft.test.ts
git commit -m "feat(refine): draft directory layout, templates, copy from main, draft hash"
```

---

### Task 3: Patches — validate, apply, unified diff (`diff` dependency)

**Files:**
- Modify: `package.json` (add `diff` and `@types/diff`)
- Create: `server/refine/patches.ts`
- Test: `test/refine/patches.test.ts`

**Interfaces:**
- Produces:

```ts
import type { DocFile } from './draft.js';
export interface DocPatchIn { file: string; find: string; replace: string; reason: string }         // = DocPatch from outputs.ts
export interface PendingPatch { patchId: string; role: 'po' | 'sm'; file: DocFile; find: string; replace: string; reason: string; diff: string }
export type PatchCheck = { ok: true; file: DocFile } | { ok: false; reason: string };
export function checkPatch(p: DocPatchIn, specId: string, docs: Record<DocFile, string>): PatchCheck
   // reason: `unknown file <file>` | `find not found in <file>` | `find occurs N times in <file>`
export function applyPatch(text: string, p: { find: string; replace: string }): string | null   // null unless find occurs exactly once
export function unifiedDiff(file: DocFile, before: string, after: string): string             // diff.createPatch(rel, before, after)
export function patchId(role: 'po' | 'sm', cycle: number, index: number): string             // `${role}-c${cycle}-${index}`
```

- [ ] **Step 1: Install the dependency**

Run: `npm install --save-exact diff@8.0.2 && npm install --save-exact --save-dev @types/diff@8.0.0`
Expected: `package.json` lists both; `package-lock.json` updated.

- [ ] **Step 2: Write the failing tests**

Create `test/refine/patches.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyPatch, checkPatch, patchId, unifiedDiff } from '../../server/refine/patches.js';

const docs = { 'project.md': '# App\n\n## Vision\n\nfast\n', 'brief.md': '## Objectives\n\n- ship\n- ship\n' } as const;

describe('patches', () => {
  it('accepts a patch whose find occurs once in a known file', () => {
    expect(checkPatch({ file: 'docs/project.md', find: 'fast', replace: 'fast and small', reason: 'r' }, 'hello-001', docs)).toEqual({ ok: true, file: 'project.md' });
    expect(checkPatch({ file: 'docs/specs/hello-001/brief.md', find: '## Objectives', replace: '## Goals', reason: 'r' }, 'hello-001', docs)).toEqual({ ok: true, file: 'brief.md' });
  });
  it('rejects unknown files, absent finds and ambiguous finds with a reason', () => {
    expect(checkPatch({ file: 'docs/project.json', find: 'x', replace: 'y', reason: 'r' }, 'hello-001', docs)).toEqual({ ok: false, reason: 'unknown file docs/project.json' });
    expect(checkPatch({ file: 'docs/project.md', find: 'slow', replace: 'y', reason: 'r' }, 'hello-001', docs)).toEqual({ ok: false, reason: 'find not found in project.md' });
    expect(checkPatch({ file: 'docs/specs/hello-001/brief.md', find: '- ship', replace: 'y', reason: 'r' }, 'hello-001', docs)).toEqual({ ok: false, reason: 'find occurs 2 times in brief.md' });
  });
  it('applies exactly once and yields a unified diff naming the file', () => {
    expect(applyPatch('a fast b', { find: 'fast', replace: 'slow' })).toBe('a slow b');
    expect(applyPatch('a b', { find: 'fast', replace: 'slow' })).toBeNull();
    const d = unifiedDiff('project.md', 'a\nfast\nb\n', 'a\nslow\nb\n');
    expect(d).toContain('--- project.md');
    expect(d).toContain('-fast');
    expect(d).toContain('+slow');
    expect(patchId('po', 2, 0)).toBe('po-c2-0');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/refine/patches.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `server/refine/patches.ts`**

```ts
import { createPatch } from 'diff';
import { DOC_REL, type DocFile } from './draft.js';

export interface DocPatchIn { file: string; find: string; replace: string; reason: string }
export interface PendingPatch { patchId: string; role: 'po' | 'sm'; file: DocFile; find: string; replace: string; reason: string; diff: string }
export type PatchCheck = { ok: true; file: DocFile } | { ok: false; reason: string };

const count = (text: string, find: string): number => (find === '' ? 0 : text.split(find).length - 1);

/** Spec (refinement) §3.4: only the two Markdown files, and `find` must occur exactly once. */
export function checkPatch(p: DocPatchIn, specId: string, docs: Record<DocFile, string>): PatchCheck {
  const file = (Object.keys(DOC_REL) as DocFile[]).find((f) => DOC_REL[f](specId) === p.file);
  if (!file) return { ok: false, reason: `unknown file ${p.file}` };
  const n = count(docs[file], p.find);
  if (n === 0) return { ok: false, reason: `find not found in ${file}` };
  if (n > 1) return { ok: false, reason: `find occurs ${n} times in ${file}` };
  return { ok: true, file };
}

export function applyPatch(text: string, p: { find: string; replace: string }): string | null {
  return count(text, p.find) === 1 ? text.replace(p.find, () => p.replace) : null;
}

export function unifiedDiff(file: DocFile, before: string, after: string): string {
  return createPatch(file, before, after, '', '', { context: 2 });
}

export const patchId = (role: 'po' | 'sm', cycle: number, index: number): string => `${role}-c${cycle}-${index}`;
```

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run test/refine/patches.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add package.json package-lock.json server/refine/patches.ts test/refine/patches.test.ts
git commit -m "feat(refine): doc patch validation, application and unified diff"
```

---

### Task 4: Derive — pack builder and post-processing (AC ids, forced fields)

**Files:**
- Create: `server/refine/derive.ts`
- Test: `test/refine/derive.test.ts`

**Interfaces:**
- Produces:

```ts
export function derivePack(input: { specHash: string; principles: readonly string[]; projectMd: string; briefMd: string; previous: { project: Project; spec: Spec } | null; specId: string }): ContextPackInput
   // kind 'derive', role 'po', criteria = previous ACs or [], feedback carries both Markdown files, the previous JSON, both JSON schemas and "specId must be <specId>"
export type DeriveCheck = { ok: true; value: { project: Project; spec: Spec } } | { ok: false; issues: string[] };
export function postProcessDerived(out: { project: unknown; spec: unknown }, previous: Spec | null, specId: string): DeriveCheck
```

`postProcessDerived`: parses with `Project`/`Spec` (issues = zod issue paths + messages); forces `spec.specId = specId`, `status = 'refining'`, `specHash = null`, `specVersion = previous?.specVersion ?? 0`, `validationReports = previous?.validationReports ?? []`; AC ids: an AC whose `given/when/then` equals a previous AC keeps that previous id; otherwise the agent's id is kept unless it is already used or belongs to a previous AC with different text, in which case the next free `AC-nnn` above the highest id seen is assigned.

- [ ] **Step 1: Write the failing tests**

Create `test/refine/derive.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { derivePack, postProcessDerived } from '../../server/refine/derive.js';
import { HELLO_PROJECT, HELLO_SPEC } from '../fixtures/contracts.js';

const ac = (id: string, then: string) => ({ id, given: 'g', when: 'w', then, smoke: false });
const prev = { ...HELLO_SPEC, specVersion: 2, status: 'awaiting-validation' as const, specHash: 'b'.repeat(64), acceptanceCriteria: [ac('AC-001', 'one'), ac('AC-002', 'two')], validationReports: [{ at: '2026-09-24T10:00:00.000Z', text: 'r' }] };

describe('postProcessDerived', () => {
  it('keeps ids of unchanged criteria, renumbers a new one after the highest, and forces status/hash/version/reports', () => {
    const out = postProcessDerived(
      { project: HELLO_PROJECT, spec: { ...prev, specId: 'wrong', status: 'running', specHash: 'c'.repeat(64), specVersion: 9, validationReports: [], acceptanceCriteria: [ac('AC-001', 'two'), ac('AC-001', 'three'), ac('AC-007', 'one')] } },
      prev,
      'hello-001',
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.spec.acceptanceCriteria.map((c) => [c.id, c.then])).toEqual([['AC-002', 'two'], ['AC-008', 'three'], ['AC-001', 'one']]);
    expect(out.value.spec).toMatchObject({ specId: 'hello-001', status: 'refining', specHash: null, specVersion: 2 });
    expect(out.value.spec.validationReports).toHaveLength(1);
  });
  it('reports zod issues with paths', () => {
    const out = postProcessDerived({ project: { ...HELLO_PROJECT, personas: [] }, spec: prev }, null, 'hello-001');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.issues.join('\n')).toMatch(/project\.personas/);
  });
  it('derivePack carries both Markdown files, the schemas and the spec id', () => {
    const pack = derivePack({ specHash: 'd'.repeat(64), principles: ['p'], projectMd: '# P', briefMd: '## O', previous: null, specId: 'hello-001' });
    expect(pack.kind).toBe('derive');
    expect(pack.role).toBe('po');
    expect(pack.feedback).toContain('# P');
    expect(pack.feedback).toContain('## O');
    expect(pack.feedback).toContain('specId must be hello-001');
    expect(pack.feedback).toContain('acceptanceCriteria');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/refine/derive.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `server/refine/derive.ts`**

```ts
import { z } from 'zod';
import { Project } from '../contracts/project.js';
import { Spec, type AcceptanceCriterion } from '../contracts/spec.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';

export function derivePack(input: { specHash: string; principles: readonly string[]; projectMd: string; briefMd: string; previous: { project: Project; spec: Spec } | null; specId: string }): ContextPackInput {
  const schemas = { project: z.toJSONSchema(Project, { target: 'draft-07', io: 'input' }), spec: z.toJSONSchema(Spec, { target: 'draft-07', io: 'input' }) };
  const feedback = [
    `specId must be ${input.specId}. Derive project.json and spec.json from the Markdown below.`,
    '### docs/project.md', input.projectMd,
    '### brief.md', input.briefMd,
    '### previous derived JSON (keep unchanged acceptance criterion ids)', input.previous ? JSON.stringify(input.previous, null, 2) : '(none)',
    '### JSON schemas', JSON.stringify(schemas),
  ].join('\n\n');
  return { kind: 'derive', role: 'po', specHash: input.specHash, principles: input.principles, outputContract: outputContract('derive'), criteria: input.previous?.spec.acceptanceCriteria ?? [], feedback, budgetTokens: 20_000 };
}

export type DeriveCheck = { ok: true; value: { project: Project; spec: Spec } } | { ok: false; issues: string[] };

const acNum = (id: string) => Number(id.slice(3));
const acId = (n: number) => `AC-${String(n).padStart(3, '0')}`;
const sameText = (a: AcceptanceCriterion, b: AcceptanceCriterion) => a.given === b.given && a.when === b.when && a.then === b.then;

/** Spec (refinement) §3.2 step 1: the orchestrator, not the agent, owns ids, status, hash and version. */
export function postProcessDerived(out: { project: unknown; spec: unknown }, previous: Spec | null, specId: string): DeriveCheck {
  const p = Project.safeParse(out.project);
  const raw = typeof out.spec === 'object' && out.spec !== null ? (out.spec as Record<string, unknown>) : {};
  const s = Spec.safeParse({ ...raw, specId, status: 'refining', specHash: null, specVersion: previous?.specVersion ?? 0, validationReports: previous?.validationReports ?? [] });
  const issues = [
    ...(p.success ? [] : p.error.issues.map((i) => `project.${i.path.join('.')}: ${i.message}`)),
    ...(s.success ? [] : s.error.issues.map((i) => `spec.${i.path.join('.')}: ${i.message}`)),
  ];
  if (!p.success || !s.success) return { ok: false, issues };
  const prevAcs = previous?.acceptanceCriteria ?? [];
  const used = new Set<string>();
  let max = Math.max(0, ...prevAcs.map((c) => acNum(c.id)), ...s.data.acceptanceCriteria.map((c) => acNum(c.id)));
  const criteria = s.data.acceptanceCriteria.map((c) => {
    const kept = prevAcs.find((pc) => sameText(pc, c) && !used.has(pc.id));
    let id = kept ? kept.id : c.id;
    const takenByOther = !kept && prevAcs.some((pc) => pc.id === id && !sameText(pc, c));
    if (used.has(id) || takenByOther) id = acId(++max);
    used.add(id);
    return { ...c, id };
  });
  return { ok: true, value: { project: p.data, spec: { ...s.data, acceptanceCriteria: criteria } } };
}
```

Note on the test: `AC-001 → 'two'` matches previous `AC-002` by text and keeps `AC-002`; `AC-001 → 'three'` is new text whose id belongs to a different previous AC, so it gets `AC-008` (max seen is 7); `AC-007 → 'one'` matches previous `AC-001` by text.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run test/refine/derive.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add server/refine/derive.ts test/refine/derive.test.ts
git commit -m "feat(refine): derive pack and post-processing that owns AC ids and spec status"
```

---

### Task 5: Refine events and reducer

**Files:**
- Create: `server/refine/events.ts`, `server/refine/state.ts`
- Test: `test/refine/state.test.ts`

**Interfaces:**
- Produces (`events.ts`):

```ts
export const RefineEvent = {
  Created: 'REFINE_CREATED',            // { projectId, specId, mode: 'new-project' | 'new-spec' | 'continue' }
  DocEdited: 'DOC_EDITED',              // { file: DocFile, hash: string, source: 'human' | 'patch' }
  CycleStarted: 'REFINE_CYCLE_STARTED', // { cycle: number, draftHash: string }
  Derived: 'DERIVED',                   // { cycle, project, spec }
  Evaluated: 'REFINE_EVALUATED',        // { cycle, checklist: ChecklistItem[], questions: Question[], discardedPatches: [{ role, file, reason }] }
  CycleFailed: 'REFINE_CYCLE_FAILED',   // { cycle, reason: string }
  PatchProposed: 'PATCH_PROPOSED',      // PendingPatch & { cycle }
  PatchAccepted: 'PATCH_ACCEPTED',      // { patchId }
  PatchRejected: 'PATCH_REJECTED',      // { patchId, reason: string | null }
  PatchDropped: 'PATCH_DROPPED',        // { patchId, reason }
  QuestionAnswered: 'QUESTION_ANSWERED',// { questionId, text }
  QuestionSkipped: 'QUESTION_SKIPPED',  // { questionId }
  SecretWritten: 'SECRET_WRITTEN',      // { name }
  StartedRun: 'REFINE_STARTED_RUN',     // { runId }
} as const;
export interface Question { questionId: string; role: 'po' | 'sm'; text: string; blocking: boolean; relatedAcIds: string[]; cycle: number }
export const DRAFT_HASH = 'draft';      // the journal's specHash field before a spec is frozen
```
- Produces (`state.ts`):

```ts
export type RefineStatus = 'drafting' | 'evaluating' | 'answering' | 'ready' | 'error' | 'started';
export interface QuestionRow extends Question { status: 'pending' | 'answered' | 'skipped'; answer: string | null }
export interface PatchRow extends PendingPatch { cycle: number; status: 'pending' | 'accepted' | 'rejected' | 'dropped'; decision: string | null }
export interface RefineState { status: RefineStatus; stale: boolean; cycle: number; derived: { project: Project; spec: Spec } | null; checklist: ChecklistItem[]; questions: QuestionRow[]; patches: PatchRow[]; discarded: Array<{ cycle: number; role: string; file: string; reason: string }>; error: string | null; runId: string | null }
export function emptyRefineState(): RefineState
export function applyRefineEvent(s: RefineState, e: { type: string; data: Record<string, unknown> }): void   // mutates
export function reduceRefineEvents(events: ReadonlyArray<{ type: string; data: Record<string, unknown> }>): RefineState
export function computeStatus(s: RefineState): RefineStatus
```

Rules: `CycleStarted` → `evaluating`, `error = null`; `Derived` sets `derived`; `Evaluated` replaces `checklist`, appends its questions as pending, sets `stale = false`, recomputes; `CycleFailed` → `error`; `DocEdited` / `PatchAccepted` / `SecretWritten` → `stale = true` when `derived !== null`; `StartedRun` → `started`. `computeStatus`: `ready` when every checklist item passed, no pending patch and no pending question with `blocking: true`; `answering` when any pending question or patch; else `drafting`. `evaluating`, `error` and `started` are sticky until the next `CycleStarted`/`Evaluated`. A journal whose last cycle has no `Evaluated`/`CycleFailed` reduces to `evaluating`; the session (Task 6) turns that into `CycleFailed { reason: 'interrupted' }` on open.

- [ ] **Step 1: Write the failing tests**

Create `test/refine/state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RefineEvent } from '../../server/refine/events.js';
import { reduceRefineEvents } from '../../server/refine/state.js';
import { HELLO_PROJECT, HELLO_SPEC } from '../fixtures/contracts.js';

const item = (id: string, passed: boolean) => ({ id, role: id.startsWith('po') ? 'po' : 'sm', passed, detail: '' });
const allGreen = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions', 'sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'].map((id) => item(id, true));
const q = (questionId: string, blocking: boolean) => ({ questionId, role: 'po', text: 't', blocking, relatedAcIds: [], cycle: 1 });
const patch = (patchId: string) => ({ patchId, role: 'sm', file: 'brief.md', find: 'a', replace: 'b', reason: 'r', diff: '', cycle: 1 });
const derived = { project: HELLO_PROJECT, spec: { ...HELLO_SPEC, status: 'refining', specHash: null } };
const cycle = (n: number) => [{ type: RefineEvent.CycleStarted, data: { cycle: n, draftHash: 'h' } }, { type: RefineEvent.Derived, data: { cycle: n, ...derived } }];

describe('reduceRefineEvents', () => {
  it('evaluates into answering when questions or patches are pending', () => {
    const s = reduceRefineEvents([
      { type: RefineEvent.Created, data: { projectId: 'p', specId: 's', mode: 'new-project' } },
      ...cycle(1),
      { type: RefineEvent.PatchProposed, data: patch('sm-c1-0') },
      { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: allGreen, questions: [q('po-c1-0', true)], discardedPatches: [] } },
    ]);
    expect(s.status).toBe('answering');
    expect(s.questions[0]).toMatchObject({ questionId: 'po-c1-0', status: 'pending' });
    expect(s.patches[0]).toMatchObject({ patchId: 'sm-c1-0', status: 'pending' });
  });
  it('is ready only with all green, no pending patch and no pending blocking question; a blocking question keeps answering', () => {
    const base = [...cycle(1), { type: RefineEvent.PatchProposed, data: patch('sm-c1-0') }, { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: allGreen, questions: [q('po-c1-0', false)], discardedPatches: [] } }];
    expect(reduceRefineEvents(base).status).toBe('answering');
    const decided = reduceRefineEvents([...base, { type: RefineEvent.PatchRejected, data: { patchId: 'sm-c1-0', reason: null } }, { type: RefineEvent.QuestionSkipped, data: { questionId: 'po-c1-0' } }]);
    expect(decided).toMatchObject({ status: 'ready', stale: false });
    const blocking = reduceRefineEvents([...cycle(1), { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: allGreen, questions: [q('po-c1-1', true)], discardedPatches: [] } }]);
    expect(blocking.status).toBe('answering');
    const accepted = reduceRefineEvents([...base, { type: RefineEvent.PatchAccepted, data: { patchId: 'sm-c1-0' } }]);
    expect(accepted.stale).toBe(true);
    const red = reduceRefineEvents([...cycle(1), { type: RefineEvent.Evaluated, data: { cycle: 1, checklist: [...allGreen.slice(0, 7), item('sm.no-open-questions', false)], questions: [], discardedPatches: [] } }]);
    expect(red.status).toBe('drafting');
  });
  it('reports a failed cycle, an interrupted cycle and a started run', () => {
    expect(reduceRefineEvents([...cycle(1), { type: RefineEvent.CycleFailed, data: { cycle: 1, reason: 'derive: spec.objectives: too small' } }])).toMatchObject({ status: 'error', error: 'derive: spec.objectives: too small' });
    expect(reduceRefineEvents(cycle(1)).status).toBe('evaluating');
    expect(reduceRefineEvents([{ type: RefineEvent.StartedRun, data: { runId: 's-r1' } }])).toMatchObject({ status: 'started', runId: 's-r1' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/refine/state.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`server/refine/events.ts`:

```ts
export const RefineEvent = {
  Created: 'REFINE_CREATED', DocEdited: 'DOC_EDITED', CycleStarted: 'REFINE_CYCLE_STARTED', Derived: 'DERIVED', Evaluated: 'REFINE_EVALUATED', CycleFailed: 'REFINE_CYCLE_FAILED',
  PatchProposed: 'PATCH_PROPOSED', PatchAccepted: 'PATCH_ACCEPTED', PatchRejected: 'PATCH_REJECTED', PatchDropped: 'PATCH_DROPPED',
  QuestionAnswered: 'QUESTION_ANSWERED', QuestionSkipped: 'QUESTION_SKIPPED', SecretWritten: 'SECRET_WRITTEN', StartedRun: 'REFINE_STARTED_RUN',
} as const;
export interface Question { questionId: string; role: 'po' | 'sm'; text: string; blocking: boolean; relatedAcIds: string[]; cycle: number }
/** The journal's specHash field before a spec is frozen. */
export const DRAFT_HASH = 'draft';
```

`server/refine/state.ts`:

```ts
import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import type { ChecklistItem } from './checklist.js';
import { RefineEvent, type Question } from './events.js';
import type { PendingPatch } from './patches.js';

export type RefineStatus = 'drafting' | 'evaluating' | 'answering' | 'ready' | 'error' | 'started';
export interface QuestionRow extends Question { status: 'pending' | 'answered' | 'skipped'; answer: string | null }
export interface PatchRow extends PendingPatch { cycle: number; status: 'pending' | 'accepted' | 'rejected' | 'dropped'; decision: string | null }
export interface RefineState {
  status: RefineStatus; stale: boolean; cycle: number; derived: { project: Project; spec: Spec } | null; checklist: ChecklistItem[];
  questions: QuestionRow[]; patches: PatchRow[]; discarded: Array<{ cycle: number; role: string; file: string; reason: string }>; error: string | null; runId: string | null;
}

export const emptyRefineState = (): RefineState => ({ status: 'drafting', stale: false, cycle: 0, derived: null, checklist: [], questions: [], patches: [], discarded: [], error: null, runId: null });

const STICKY: ReadonlySet<RefineStatus> = new Set(['evaluating', 'error', 'started']);

export function computeStatus(s: RefineState): RefineStatus {
  if (STICKY.has(s.status)) return s.status;
  const pendingBlocking = s.questions.some((q) => q.status === 'pending' && q.blocking);
  const pendingAny = s.questions.some((q) => q.status === 'pending') || s.patches.some((p) => p.status === 'pending');
  const green = s.checklist.length > 0 && s.checklist.every((i) => i.passed);
  if (green && !pendingBlocking && !s.patches.some((p) => p.status === 'pending')) return 'ready';
  return pendingAny ? 'answering' : 'drafting';
}

export function applyRefineEvent(s: RefineState, e: { type: string; data: Record<string, unknown> }): void {
  const d = e.data as Record<string, never>;
  switch (e.type) {
    case RefineEvent.CycleStarted: s.cycle = Number(d.cycle); s.status = 'evaluating'; s.error = null; break;
    case RefineEvent.Derived: s.derived = { project: d.project as Project, spec: d.spec as Spec }; break;
    case RefineEvent.PatchProposed: s.patches.push({ ...(e.data as unknown as PendingPatch & { cycle: number }), status: 'pending', decision: null }); break;
    case RefineEvent.Evaluated: {
      const v = e.data as unknown as { cycle: number; checklist: ChecklistItem[]; questions: Question[]; discardedPatches: Array<{ role: string; file: string; reason: string }> };
      s.checklist = v.checklist;
      s.questions.push(...v.questions.map((q) => ({ ...q, status: 'pending' as const, answer: null })));
      s.discarded.push(...v.discardedPatches.map((x) => ({ cycle: v.cycle, ...x })));
      s.stale = false; s.status = 'drafting'; s.status = computeStatus(s);
      break;
    }
    case RefineEvent.CycleFailed: s.error = String(d.reason); s.status = 'error'; break;
    case RefineEvent.PatchAccepted: case RefineEvent.PatchRejected: case RefineEvent.PatchDropped: {
      const p = s.patches.find((x) => x.patchId === String(d.patchId));
      if (p) { p.status = e.type === RefineEvent.PatchAccepted ? 'accepted' : e.type === RefineEvent.PatchRejected ? 'rejected' : 'dropped'; p.decision = (d.reason as string | null | undefined) ?? null; }
      if (e.type === RefineEvent.PatchAccepted && s.derived) s.stale = true;
      s.status = computeStatus(s);
      break;
    }
    case RefineEvent.QuestionAnswered: case RefineEvent.QuestionSkipped: {
      const q = s.questions.find((x) => x.questionId === String(d.questionId));
      if (q) { q.status = e.type === RefineEvent.QuestionAnswered ? 'answered' : 'skipped'; q.answer = (d.text as string | undefined) ?? null; }
      s.status = computeStatus(s);
      break;
    }
    case RefineEvent.DocEdited: case RefineEvent.SecretWritten: if (s.derived) s.stale = true; break;
    case RefineEvent.StartedRun: s.status = 'started'; s.runId = String(d.runId); break;
    default: break;
  }
}

export function reduceRefineEvents(events: ReadonlyArray<{ type: string; data: Record<string, unknown> }>): RefineState {
  const s = emptyRefineState();
  for (const e of events) applyRefineEvent(s, e);
  return s;
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run test/refine/state.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add server/refine/events.ts server/refine/state.ts test/refine/state.test.ts
git commit -m "feat(refine): session events and reducer"
```

---

### Task 6: `RefineSession` — journal, evaluate cycle, answers, patches, secrets

**Files:**
- Create: `server/refine/session.ts`, `server/refine/cycle.ts`, `server/refine/packs.ts`
- Test: `test/refine/session.test.ts`

**Interfaces:**
- Consumes: `draftPaths`, `readDoc`, `writeDoc`, `readDerived`, `writeDerived`, `draftHash` (Task 2); `checkPatch`, `applyPatch`, `unifiedDiff`, `patchId` (Task 3); `derivePack`, `postProcessDerived` (Task 4); `RefineEvent`, `DRAFT_HASH`, `reduceRefineEvents`, `applyRefineEvent` (Task 5); `mergeChecklist` (Task 1); `EventStore.open/append/readAll` (`server/store/event-store.ts`); `runAgentStep`/`AgentStepRequest` (`server/orchestrator/steps.ts`); `loadSecrets`, `writeSecret`, `SECRET_NAME` (`server/core/secrets.ts`).
- Produces (`packs.ts`):

```ts
export function refinePack(input: { role: 'po' | 'sm'; specHash: string; principles: readonly string[]; specId: string; projectMd: string; briefMd: string; derived: { project: Project; spec: Spec }; retrieval: readonly Hit[]; history: readonly QuestionRow[]; rejected: readonly PatchRow[] }): ContextPackInput
  // kind 'refine', criteria = derived ACs, feedback = both Markdown files under headings, the derived JSON, "Answered questions" (role: text → answer), "Skipped questions", "Rejected patches" (file, find excerpt, reason) and the role's checklist ids
```
- Produces (`cycle.ts`):

```ts
export type RunAgent = <K extends StepKind>(req: AgentStepRequest<K>, ctx: { journal: Pick<Journal, 'allocStepSeq' | 'fact'>; stepDir: (seq: number) => string; specHash: string }) => Promise<StepOutcome<OutputOf<K>>>;
export interface CycleDeps { draft: Draft; journal: RefineJournal; runAgent: RunAgent; principles: () => readonly string[]; retrieval: (query: string) => readonly Hit[]; secretsDir: string; state: () => RefineState }
export async function runCycle(deps: CycleDeps, cycle: number): Promise<void>   // appends CycleStarted … Evaluated | CycleFailed; never throws for agent/derive failures
```
- Produces (`session.ts`):

```ts
export class RefineJournal {            // thin single-writer wrapper over EventStore, reducing into RefineState
  static open(file: string, ids: { projectId: string; specId: string }): Promise<RefineJournal>
  readonly state: RefineState; get events(): readonly StoredEvent[];
  fact(type: string, data?: Record<string, unknown>): Promise<StoredEvent>;
  allocStepSeq(): number;
}
export interface SessionDeps { ws: Workspace; draft: Draft; runAgent: RunAgent; secretsDir: string; retrieval: (query: string) => readonly Hit[]; clock?: () => Date }
export interface SecretRow { name: string; present: boolean; hint: string | null }
export interface Snapshot { projectId: string; specId: string; state: RefineState; docs: Record<DocFile, string>; secrets: SecretRow[]; tokens: { inputTokens: number; outputTokens: number; costUsd: number; steps: number } }
export class RefineSession {
  static open(deps: SessionDeps): Promise<RefineSession>           // replays; an open cycle becomes CycleFailed{interrupted}
  static create(deps: SessionDeps, mode: 'new-project' | 'new-spec' | 'continue'): Promise<RefineSession>  // appends REFINE_CREATED
  get busy(): boolean; get eventsFile(): string; get events(): readonly StoredEvent[]; get state(): RefineState;
  snapshot(): Promise<Snapshot>
  saveDoc(file: DocFile, text: string): Promise<void>               // ConflictError while busy or started
  evaluate(): Promise<void>                                          // ConflictError while busy or started; runs runCycle
  answer(questionId: string, text: string): Promise<void>            // NotFoundError / ConflictError (already decided)
  skip(questionId: string): Promise<void>                            // ConflictError when blocking
  accept(patchId: string): Promise<void>                             // ConflictError when find no longer matches (patch dropped)
  reject(patchId: string, reason: string | null): Promise<void>
  writeSecret(name: string, value: string): Promise<void>            // name must be listed by the derived spec → else NotFoundError
  markStarted(runId: string): Promise<void>
}
export class ConflictError extends Error {}   // → 409
export class NotFoundError extends Error {}   // → 404
```

`runCycle` steps (spec §3.2): `CycleStarted { cycle, draftHash }` → derive step (`runAgent` with `derivePack`, `specHash = draftHash`) → `postProcessDerived` → on issues `CycleFailed { reason: 'derive: ' + issues.join('; ') }` → `writeDerived` + `Derived` → PO and SM `refine` steps via `Promise.all` → any step not ok → `CycleFailed { reason: '<role> refine failed: <failure>' }` → merge questions (normalize = lowercase + collapse whitespace; drop duplicates within the cycle and any whose normalized text equals an answered/skipped question; blocking first, PO before SM within a class; ids `<role>-c<cycle>-<n>`) → for each patch `checkPatch` against the current docs → valid: `PatchProposed` with `unifiedDiff`; invalid: collected into `discardedPatches` → checklist: `mergeChecklist(po, sm)`, then override `sm.dependencies-and-secrets` (`passed` = every `secretNames` of `derived.spec.externalDependencies` is a key of `loadSecrets(secretsDir)`; detail lists missing names) and `sm.no-open-questions` (`passed` = no blocking question pending after this merge; detail counts them) → `Evaluated`.

The `runAgent` callback is how the UI process reaches `runAgentStep` with its own governor/breaker/agents (wired in Task 7); tests pass a fake.

- [ ] **Step 1: Write the failing tests**

Create `test/refine/session.test.ts`:

```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StepKind } from '../../server/agents/outputs.js';
import { writeSecret } from '../../server/core/secrets.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createNewProject, draftPaths, readDoc, writeDoc } from '../../server/refine/draft.js';
import { ConflictError, RefineSession, type RunAgent } from '../../server/refine/session.js';
import { HELLO_PROJECT, HELLO_SPEC } from '../fixtures/contracts.js';

let root = '';
let ws: Workspace;
let secretsDir = '';
type Scripted = Record<string, unknown[]>; // key `${kind}/${role}` → outputs per call
let script: Scripted;
let calls: Array<{ kind: StepKind; role: string; prompt: string }>;

const derived = { project: HELLO_PROJECT, spec: { ...HELLO_SPEC, status: 'refining', specHash: null, externalDependencies: [{ name: 'db', purpose: 'p', secretNames: ['DB_URL'] }] } };
const green = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
const PO = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions'];
const SM = ['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'];
const refineOut = (checklist: unknown[], questions: unknown[] = [], docPatch: unknown[] = []) => ({ specHash: 'x', checklist, questions, docPatch });

const runAgent: RunAgent = async (req, ctx) => {
  const key = `${req.kind}/${req.role}`;
  calls.push({ kind: req.kind, role: req.role, prompt: JSON.stringify(req.pack) });
  const seq = ctx.journal.allocStepSeq();
  await ctx.journal.fact('STEP_STARTED', { stepId: `s${seq}`, kind: req.kind, role: req.role, taskId: null, attempt: 0 });
  const next = script[key]?.shift();
  const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
  await ctx.journal.fact('STEP_FINISHED', { stepId: `s${seq}`, kind: req.kind, taskId: null, attempt: 0, ok: next !== undefined, failure: next === undefined ? 'schema' : null, usage, costUsd: 0.01, durationMs: 1, numTurns: 1 });
  const summary = { usage, costUsd: 0.01, durationMs: 1, numTurns: 1, rateLimit: null } as never;
  if (next === undefined) return { ok: false, failure: 'schema', errors: ['no scripted output'], summary, sandboxDisabled: false } as never;
  return { ok: true, value: { ...(next as object), specHash: ctx.specHash }, summary } as never;
};

const deps = () => ({ ws, draft: draftPaths(ws, 'hello-001'), runAgent, secretsDir, retrieval: () => [] });

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'))).replace(/\\/g, '/');
  secretsDir = `${root}/secrets`;
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, runs: `${root}/runs` };
  await createNewProject(draftPaths(ws, 'hello-001'), 'Hello');
  script = {};
  calls = [];
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('RefineSession', () => {
  it('evaluates: derive, PO ∥ SM, questions merged blocking-first, patches proposed or discarded, secrets item computed', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO), [{ id: 'q1', text: 'Which DB?', blocking: false, relatedAcIds: [] }], [{ file: 'docs/project.md', find: '## Vision', replace: '## Product vision', reason: 'clearer' }, { file: 'docs/project.md', find: 'nope', replace: 'x', reason: 'r' }])];
    script['refine/sm'] = [refineOut(green(SM), [{ id: 'q2', text: 'which db?', blocking: true, relatedAcIds: [] }, { id: 'q3', text: 'Port?', blocking: true, relatedAcIds: [] }])];
    await s.evaluate();
    const st = s.state;
    expect(st.status).toBe('answering');
    expect(st.derived?.spec.specId).toBe('hello-001');
    expect(st.questions.map((q) => [q.questionId, q.blocking])).toEqual([['sm-c1-0', true], ['po-c1-0', false]]); // 'which db?' deduped against 'Which DB?'; blocking first
    expect(st.patches.map((p) => p.status)).toEqual(['pending']);
    expect(st.patches[0]!.diff).toContain('+## Product vision');
    expect(st.discarded[0]).toMatchObject({ reason: 'find not found in project.md' });
    expect(st.checklist.find((i) => i.id === 'sm.dependencies-and-secrets')).toMatchObject({ passed: false });
    expect(st.checklist.find((i) => i.id === 'sm.no-open-questions')).toMatchObject({ passed: false });
    expect(calls.map((c) => c.kind)).toEqual(['derive', 'refine', 'refine']);
    expect((await s.snapshot()).tokens.steps).toBe(3);
  });

  it('routes answers and rejections into the next cycle, refuses skipping a blocking question, and reaches ready', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    script['derive/po'] = [derived, derived];
    script['refine/po'] = [refineOut(green(PO), [{ id: 'q', text: 'Port?', blocking: true, relatedAcIds: [] }], [{ file: 'docs/project.md', find: '## Vision', replace: '## V', reason: 'r' }]), refineOut(green(PO))];
    script['refine/sm'] = [refineOut(green(SM)), refineOut(green(SM))];
    await writeSecret(secretsDir, 'DB_URL', 'postgres://x');
    await s.evaluate();
    await expect(s.skip('po-c1-0')).rejects.toBeInstanceOf(ConflictError);
    await s.answer('po-c1-0', '8080');
    await s.reject('po-c1-0', 'keep heading');
    await s.evaluate();
    const prompt = calls.filter((c) => c.kind === 'refine').at(-1)!.prompt;
    expect(prompt).toContain('Port?');
    expect(prompt).toContain('8080');
    expect(prompt).toContain('keep heading');
    expect(s.state.status).toBe('ready');
    expect(s.state.stale).toBe(false);
  });

  it('accept applies the patch and marks stale; a stale find is dropped with 409; manual edits are refused while busy', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO), [], [{ file: 'docs/project.md', find: '## Vision', replace: '## V', reason: 'r' }, { file: 'docs/project.md', find: '## Personas', replace: '## People', reason: 'r' }])];
    script['refine/sm'] = [refineOut(green(SM))];
    await s.evaluate();
    await s.accept('po-c1-0');
    expect(await readDoc(s['deps'].draft, 'project.md')).toContain('## V');
    expect(s.state.stale).toBe(true);
    await s.saveDoc('project.md', '# Hello\n\n## Folks\n');
    await expect(s.accept('po-c1-1')).rejects.toBeInstanceOf(ConflictError);
    expect(s.state.patches[1]).toMatchObject({ status: 'dropped' });
    expect(await readDoc(s['deps'].draft, 'project.md')).toBe('# Hello\n\n## Folks\n');
  });

  it('replays after a restart and turns an open cycle into an interrupted error', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO), [{ id: 'q', text: 'A?', blocking: false, relatedAcIds: [] }])];
    script['refine/sm'] = [refineOut(green(SM))];
    await s.evaluate();
    await s.answer('po-c1-0', 'yes');
    const again = await RefineSession.open(deps());
    expect(again.state.questions[0]).toMatchObject({ status: 'answered', answer: 'yes' });
    // simulate a crash: append CycleStarted by hand, reopen
    await fs.appendFile(again.eventsFile, `${JSON.stringify({ seq: again.events.length + 1, at: new Date().toISOString(), runId: 'hello-app/hello-001', specHash: 'draft', type: 'REFINE_CYCLE_STARTED', kind: 'fact', data: { cycle: 2, draftHash: 'h' } })}\n`);
    const third = await RefineSession.open(deps());
    expect(third.state).toMatchObject({ status: 'error', error: 'interrupted' });
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO))];
    script['refine/sm'] = [refineOut(green(SM))];
    await third.evaluate();
    expect(third.state.status).toBe('ready');
  });

  it('writeSecret only accepts names the derived spec lists and marks the checklist stale', async () => {
    const s = await RefineSession.create(deps(), 'new-project');
    await expect(s.writeSecret('DB_URL', 'x')).rejects.toThrow(/not listed/);
    script['derive/po'] = [derived];
    script['refine/po'] = [refineOut(green(PO))];
    script['refine/sm'] = [refineOut(green(SM))];
    await s.evaluate();
    await s.writeSecret('DB_URL', 'postgres://x');
    expect(await fs.readFile(path.join(secretsDir, 'DB_URL'), 'utf8')).toBe('postgres://x');
    expect(s.state.stale).toBe(true);
    expect((await s.snapshot()).secrets).toEqual([{ name: 'DB_URL', present: true, hint: 's://x' }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/refine/session.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `server/refine/packs.ts`**

```ts
import type { Project } from '../contracts/project.js';
import type { Spec } from '../contracts/spec.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import type { Hit } from '../knowledge/retrieval.js';
import { outputContract } from '../orchestrator/steps.js';
import { PO_ITEMS, SM_ITEMS } from './checklist.js';
import { DOC_REL } from './draft.js';
import type { PatchRow, QuestionRow } from './state.js';

export function refinePack(input: { role: 'po' | 'sm'; specHash: string; principles: readonly string[]; specId: string; projectMd: string; briefMd: string; derived: { project: Project; spec: Spec }; retrieval: readonly Hit[]; history: readonly QuestionRow[]; rejected: readonly PatchRow[] }): ContextPackInput {
  const answered = input.history.filter((q) => q.status === 'answered').map((q) => `- [${q.role}] ${q.text}\n  answer: ${q.answer}`);
  const skipped = input.history.filter((q) => q.status === 'skipped').map((q) => `- [${q.role}] ${q.text}`);
  const rejected = input.rejected.map((p) => `- ${DOC_REL[p.file](input.specId)}: "${p.find.slice(0, 80)}" → rejected${p.decision ? `: ${p.decision}` : ''}`);
  const ids = input.role === 'po' ? PO_ITEMS : SM_ITEMS;
  const feedback = [
    `Report exactly these checklist ids: ${ids.join(', ')}.`,
    `Patch files: ${DOC_REL['project.md'](input.specId)}, ${DOC_REL['brief.md'](input.specId)}.`,
    `### ${DOC_REL['project.md'](input.specId)}`, input.projectMd,
    `### ${DOC_REL['brief.md'](input.specId)}`, input.briefMd,
    '### derived project.json', JSON.stringify(input.derived.project, null, 2),
    '### derived spec.json', JSON.stringify(input.derived.spec, null, 2),
    '### Answered questions (do not ask again)', answered.join('\n') || '(none)',
    '### Skipped questions', skipped.join('\n') || '(none)',
    '### Rejected patches (do not propose again)', rejected.join('\n') || '(none)',
  ].join('\n\n');
  return {
    kind: 'refine', role: input.role, specHash: input.specHash, principles: input.principles, outputContract: outputContract('refine'),
    criteria: input.derived.spec.acceptanceCriteria, objectives: input.derived.spec.objectives, retrieval: input.retrieval, feedback, budgetTokens: 24_000,
  };
}
```

- [ ] **Step 4: Implement `server/refine/cycle.ts`**

```ts
import type { OutputOf, StepKind } from '../agents/outputs.js';
import { loadSecrets } from '../core/secrets.js';
import type { Hit } from '../knowledge/retrieval.js';
import type { Journal } from '../orchestrator/events.js';
import type { AgentStepRequest } from '../orchestrator/steps.js';
import type { StepOutcome } from '../runner/step.js';
import { mergeChecklist, type ChecklistItem } from './checklist.js';
import { derivePack, postProcessDerived } from './derive.js';
import { draftHash, readDerived, readDoc, writeDerived, type Draft, type DocFile } from './draft.js';
import { RefineEvent, type Question } from './events.js';
import { checkPatch, patchId, unifiedDiff, applyPatch } from './patches.js';
import { refinePack } from './packs.js';
import type { RefineJournal } from './session.js';
import type { RefineState } from './state.js';

export type RunAgent = <K extends StepKind>(req: AgentStepRequest<K>, ctx: { journal: Pick<Journal, 'allocStepSeq' | 'fact'>; stepDir: (seq: number) => string; specHash: string }) => Promise<StepOutcome<OutputOf<K>>>;

export interface CycleDeps { draft: Draft; journal: RefineJournal; runAgent: RunAgent; principles: () => readonly string[]; retrieval: (query: string) => readonly Hit[]; secretsDir: string; state: () => RefineState }

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** Spec (refinement) §3.2: derive → PO ∥ SM → merge questions → check patches → checklist with orchestrator overrides. */
export async function runCycle(deps: CycleDeps, cycle: number): Promise<void> {
  const { draft, journal } = deps;
  const hash = await draftHash(draft);
  await journal.fact(RefineEvent.CycleStarted, { cycle, draftHash: hash });
  const ctx = { journal, stepDir: draft.steps, specHash: hash };
  const docs: Record<DocFile, string> = { 'project.md': await readDoc(draft, 'project.md'), 'brief.md': await readDoc(draft, 'brief.md') };
  const previous = await readDerived(draft);
  const fail = (reason: string) => journal.fact(RefineEvent.CycleFailed, { cycle, reason });

  const d = await deps.runAgent({ kind: 'derive', role: 'po', pack: derivePack({ specHash: hash, principles: deps.principles(), projectMd: docs['project.md'], briefMd: docs['brief.md'], previous, specId: draft.specId }), cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle }, ctx);
  if (!d.ok) { await fail(`derive failed: ${d.failure}: ${d.errors.join('; ')}`); return; }
  const checked = postProcessDerived(d.value, previous?.spec ?? null, draft.specId);
  if (!checked.ok) { await fail(`derive: ${checked.issues.join('; ')}`); return; }
  await writeDerived(draft, checked.value);
  await journal.fact(RefineEvent.Derived, { cycle, ...checked.value });

  const state = deps.state();
  const retrieval = deps.retrieval(checked.value.spec.objectives.join(' '));
  const step = (role: 'po' | 'sm') =>
    deps.runAgent({ kind: 'refine', role, pack: refinePack({ role, specHash: hash, principles: deps.principles(), specId: draft.specId, projectMd: docs['project.md'], briefMd: docs['brief.md'], derived: checked.value, retrieval, history: state.questions, rejected: state.patches.filter((p) => p.status === 'rejected') }), cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle }, ctx);
  const [po, sm] = await Promise.all([step('po'), step('sm')]);
  if (!po.ok) { await fail(`po refine failed: ${po.failure}: ${po.errors.join('; ')}`); return; }
  if (!sm.ok) { await fail(`sm refine failed: ${sm.failure}: ${sm.errors.join('; ')}`); return; }

  const decided = new Set(state.questions.filter((q) => q.status !== 'pending').map((q) => norm(q.text)));
  const seen = new Set<string>();
  const merged: Question[] = [];
  const counters = { po: 0, sm: 0 };
  for (const blocking of [true, false]) {
    for (const [role, out] of [['po', po.value], ['sm', sm.value]] as const) {
      for (const q of out.questions.filter((x) => x.blocking === blocking)) {
        const key = norm(q.text);
        if (seen.has(key) || decided.has(key)) continue;
        seen.add(key);
        merged.push({ questionId: `${role}-c${cycle}-${counters[role]++}`, role, text: q.text, blocking: q.blocking, relatedAcIds: q.relatedAcIds, cycle });
      }
    }
  }

  const discardedPatches: Array<{ role: string; file: string; reason: string }> = [];
  for (const [role, out] of [['po', po.value], ['sm', sm.value]] as const) {
    let i = 0;
    for (const p of out.docPatch) {
      const c = checkPatch(p, draft.specId, docs);
      if (!c.ok) { discardedPatches.push({ role, file: p.file, reason: c.reason }); continue; }
      const after = applyPatch(docs[c.file], p)!;
      await journal.fact(RefineEvent.PatchProposed, { patchId: patchId(role, cycle, i++), role, file: c.file, find: p.find, replace: p.replace, reason: p.reason, diff: unifiedDiff(c.file, docs[c.file], after), cycle });
    }
  }

  const checklist: ChecklistItem[] = mergeChecklist(po.value.checklist, sm.value.checklist);
  const present = await loadSecrets(deps.secretsDir);
  const missing = checked.value.spec.externalDependencies.flatMap((dep) => dep.secretNames).filter((n) => !(n in present));
  const secretsItem = checklist.find((i) => i.id === 'sm.dependencies-and-secrets')!;
  secretsItem.passed = missing.length === 0;
  secretsItem.detail = missing.length === 0 ? 'every listed secret is present' : `missing secrets: ${missing.join(', ')}`;
  const pendingBlocking = state.questions.filter((q) => q.status === 'pending' && q.blocking).length + merged.filter((q) => q.blocking).length;
  const openItem = checklist.find((i) => i.id === 'sm.no-open-questions')!;
  openItem.passed = pendingBlocking === 0;
  openItem.detail = pendingBlocking === 0 ? 'no blocking question open' : `${pendingBlocking} blocking question(s) open`;
  await journal.fact(RefineEvent.Evaluated, { cycle, checklist, questions: merged, discardedPatches });
}
```

- [ ] **Step 5: Implement `server/refine/session.ts`**

```ts
import { promises as fs } from 'node:fs';
import { SECRET_NAME, loadSecrets, writeSecret } from '../core/secrets.js';
import { sha256 } from '../contracts/hash.js';
import type { Hit } from '../knowledge/retrieval.js';
import type { Workspace } from '../orchestrator/workspace.js';
import { EventStore, type StoredEvent } from '../store/event-store.js';
import { runCycle, type RunAgent } from './cycle.js';
import { readDoc, writeDoc, type Draft, type DocFile } from './draft.js';
import { DRAFT_HASH, RefineEvent } from './events.js';
import { applyPatch } from './patches.js';
import { applyRefineEvent, emptyRefineState, type RefineState } from './state.js';

export type { RunAgent } from './cycle.js';
export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export class RefineJournal {
  readonly state: RefineState = emptyRefineState();
  private readonly log: StoredEvent[] = [];
  private stepSeq = 0;
  private constructor(private readonly store: EventStore, events: StoredEvent[]) {
    for (const e of events) this.push(e);
  }
  static async open(file: string, ids: { projectId: string; specId: string }): Promise<RefineJournal> {
    const store = await EventStore.open({ file, runId: `${ids.projectId}/${ids.specId}`, specHash: DRAFT_HASH });
    return new RefineJournal(store, await store.readAll());
  }
  get events(): readonly StoredEvent[] { return this.log; }
  private push(e: StoredEvent): void {
    this.log.push(e);
    applyRefineEvent(this.state, e);
    if (e.type === 'STEP_STARTED') this.stepSeq += 1;
  }
  async fact(type: string, data: Record<string, unknown> = {}): Promise<StoredEvent> {
    const stored = await this.store.append({ type, kind: 'fact', data });
    this.push(stored);
    return stored;
  }
  allocStepSeq(): number { return ++this.stepSeq; }
}

export interface SessionDeps { ws: Workspace; draft: Draft; runAgent: RunAgent; secretsDir: string; retrieval: (query: string) => readonly Hit[]; clock?: () => Date }
export interface SecretRow { name: string; present: boolean; hint: string | null }
export interface Snapshot { projectId: string; specId: string; state: RefineState; docs: Record<DocFile, string>; secrets: SecretRow[]; tokens: { inputTokens: number; outputTokens: number; costUsd: number; steps: number } }

export class RefineSession {
  private running: Promise<void> | null = null;
  private constructor(private readonly deps: SessionDeps, private readonly journal: RefineJournal) {}

  static async open(deps: SessionDeps): Promise<RefineSession> {
    await fs.mkdir(deps.draft.root, { recursive: true });
    const journal = await RefineJournal.open(deps.draft.events, { projectId: deps.draft.projectId, specId: deps.draft.specId });
    // Spec §8: a cycle cut by a restart is failed, never resumed; nothing was charged as an attempt.
    if (journal.state.status === 'evaluating') await journal.fact(RefineEvent.CycleFailed, { cycle: journal.state.cycle, reason: 'interrupted' });
    return new RefineSession(deps, journal);
  }
  static async create(deps: SessionDeps, mode: 'new-project' | 'new-spec' | 'continue'): Promise<RefineSession> {
    const s = await RefineSession.open(deps);
    await s.journal.fact(RefineEvent.Created, { projectId: deps.draft.projectId, specId: deps.draft.specId, mode });
    return s;
  }

  get busy(): boolean { return this.running !== null; }
  get eventsFile(): string { return this.deps.draft.events; }
  get events(): readonly StoredEvent[] { return this.journal.events; }
  get state(): RefineState { return this.journal.state; }

  private guard(): void {
    if (this.state.status === 'started') throw new ConflictError('session already started a run');
    if (this.busy) throw new ConflictError('evaluation in progress');
  }

  async snapshot(): Promise<Snapshot> {
    const docs = { 'project.md': await readDoc(this.deps.draft, 'project.md'), 'brief.md': await readDoc(this.deps.draft, 'brief.md') } as Record<DocFile, string>;
    const present = await loadSecrets(this.deps.secretsDir);
    const names = [...new Set((this.state.derived?.spec.externalDependencies ?? []).flatMap((d) => d.secretNames))];
    const secrets = names.map((name) => ({ name, present: name in present, hint: name in present ? present[name]!.slice(-4) : null }));
    const tokens = { inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 };
    for (const e of this.journal.events) {
      if (e.type !== 'STEP_FINISHED') continue;
      const u = e.data.usage as { inputTokens: number; outputTokens: number } | undefined;
      tokens.steps += 1; tokens.inputTokens += u?.inputTokens ?? 0; tokens.outputTokens += u?.outputTokens ?? 0; tokens.costUsd += Number(e.data.costUsd ?? 0);
    }
    return { projectId: this.deps.draft.projectId, specId: this.deps.draft.specId, state: this.state, docs, secrets, tokens };
  }

  async saveDoc(file: DocFile, text: string): Promise<void> {
    this.guard();
    await writeDoc(this.deps.draft, file, text);
    await this.journal.fact(RefineEvent.DocEdited, { file, hash: sha256(text), source: 'human' });
  }

  async evaluate(): Promise<void> {
    this.guard();
    const cycle = this.state.cycle + 1;
    this.running = runCycle({ draft: this.deps.draft, journal: this.journal, runAgent: this.deps.runAgent, principles: () => this.state.derived?.project.principles ?? [], retrieval: this.deps.retrieval, secretsDir: this.deps.secretsDir, state: () => this.state }, cycle).finally(() => { this.running = null; });
    await this.running;
  }

  private question(id: string) {
    const q = this.state.questions.find((x) => x.questionId === id);
    if (!q) throw new NotFoundError(`unknown question ${id}`);
    if (q.status !== 'pending') throw new ConflictError(`question ${id} already ${q.status}`);
    return q;
  }
  async answer(questionId: string, text: string): Promise<void> { this.guard(); this.question(questionId); await this.journal.fact(RefineEvent.QuestionAnswered, { questionId, text }); }
  async skip(questionId: string): Promise<void> {
    this.guard();
    if (this.question(questionId).blocking) throw new ConflictError(`question ${questionId} is blocking and cannot be skipped`);
    await this.journal.fact(RefineEvent.QuestionSkipped, { questionId });
  }

  private patch(id: string) {
    const p = this.state.patches.find((x) => x.patchId === id);
    if (!p) throw new NotFoundError(`unknown patch ${id}`);
    if (p.status !== 'pending') throw new ConflictError(`patch ${id} already ${p.status}`);
    return p;
  }
  async accept(patchId: string): Promise<void> {
    this.guard();
    const p = this.patch(patchId);
    const before = await readDoc(this.deps.draft, p.file);
    const after = applyPatch(before, p);
    if (after === null) {
      await this.journal.fact(RefineEvent.PatchDropped, { patchId, reason: 'find no longer matches the document' });
      throw new ConflictError(`patch ${patchId} no longer applies; dropped`);
    }
    await writeDoc(this.deps.draft, p.file, after);
    await this.journal.fact(RefineEvent.DocEdited, { file: p.file, hash: sha256(after), source: 'patch' });
    await this.journal.fact(RefineEvent.PatchAccepted, { patchId });
  }
  async reject(patchId: string, reason: string | null): Promise<void> { this.guard(); this.patch(patchId); await this.journal.fact(RefineEvent.PatchRejected, { patchId, reason }); }

  async writeSecret(name: string, value: string): Promise<void> {
    this.guard();
    if (!SECRET_NAME.test(name)) throw new NotFoundError(`invalid secret name ${name}`);
    const listed = (this.state.derived?.spec.externalDependencies ?? []).some((d) => d.secretNames.includes(name));
    if (!listed) throw new NotFoundError(`secret ${name} is not listed by the derived spec`);
    await writeSecret(this.deps.secretsDir, name, value);
    await this.journal.fact(RefineEvent.SecretWritten, { name });
  }

  async markStarted(runId: string): Promise<void> { await this.journal.fact(RefineEvent.StartedRun, { runId }); }
}
```

- [ ] **Step 6: Run tests and commit**

Run: `npx vitest run test/refine && npm run typecheck`
Expected: PASS (5 session tests plus the earlier refine tests).

```bash
git add server/refine/packs.ts server/refine/cycle.ts server/refine/session.ts test/refine/session.test.ts
git commit -m "feat(refine): session over a single-writer journal with the derive/refine cycle"
```

---

### Task 7: Refine API — session registry, agent wiring, routes, SSE, draft listing

**Files:**
- Create: `server/refine/agent.ts`, `server/refine/registry.ts`, `server/api/refine-routes.ts`
- Modify: `server/cli.ts:44-63` (`startUiReal` adds `refineRoutes`)
- Test: `test/api/refine-api.test.ts`

**Interfaces:**
- Consumes: `RefineSession`, `SessionDeps`, `ConflictError`, `NotFoundError`, `RunAgent` (Task 6); `draftPaths`, `createNewProject`, `createFromRepo`, `draftExists` (Task 2); `reduceRefineEvents` (Task 5); block A: `readUserConfig`, `readProject`, `listProjects`, `SAFE_ID`, `HttpError`, `Route`, `RouteContext.sse`, `tailJournal`; `workspacePaths`, `expandHome`; `loadAgents` (`server/agents/registry.ts`), `resolveProfile`, `Governor`, `QuotaBreaker`, `DEFAULT_BREAKER`, `Accounting`, `runStep`, `KnowledgeIndex.open/search`.
- Produces (`agent.ts`):

```ts
export interface AgentWiring { cfg: Config; agentsDir: string; hostEnv: NodeJS.ProcessEnv; secretsDir: string; workspacesRoot: string; claudeJsonPath?: string; runStep?: typeof runStepFn }
export async function makeRunAgent(w: AgentWiring): Promise<RunAgent>
   // one Governor(cfg.concurrency.maxClaudeProcesses) + one QuotaBreaker + one Accounting for the UI process; per call builds AgentStepDeps with
   // stepDeps = { binary: { bin: hostEnv.CLAUDE_BIN ?? 'claude', prefixArgs: [], env: {}, requireSandboxTools: platform === 'linux' }, caps: cfg.budgets.step, accounting, claudeJsonPath, settingsDir: <draft root>/settings (from req.cwd), workspacesRoot, network: { allowedDomains: [] } }
   // profile: (role) => resolveProfile(cfg, role, { confidential: false }); secretValues: () => Object.values(loadSecrets(secretsDir)) (read once per call); journal/stepDir/specHash from ctx
```
- Produces (`registry.ts`):

```ts
export interface RegistryDeps { cfg: () => Promise<Config>; home?: string; runAgent: RunAgent; secretsDir: string; exec: Exec; projectDir: (projectId: string) => Promise<string | null> }  // projectDir resolves a registered project's dir or null
export class SessionRegistry {
  constructor(deps: RegistryDeps)
  get(projectId: string, specId: string): Promise<RefineSession>                    // opens from disk when a draft exists; NotFoundError otherwise; cached in a Map
  newProject(projectId: string, name: string): Promise<RefineSession>               // ConflictError when a draft or registered project exists
  newSpec(projectId: string, specId: string): Promise<RefineSession>                // ConflictError when docs/specs/<specId> on main or a draft exists
  continueSpec(projectId: string, specId: string, report?: string): Promise<RefineSession>   // ConflictError unless status on main ∈ awaiting-validation | done
  list(): Promise<Array<{ projectId: string; specId: string; state: RefineStatus; registered: boolean }>>   // scans <workspaces>/*/refine/*/events.ndjson with loadEvents + reduceRefineEvents
}
```
  `newSpec`/`continueSpec` read the repository at `workspacePaths(cfg, projectId).repo` (must be a clone; otherwise ConflictError "project has no workspace clone; run it once from the CLI or add it as a project"). Retrieval for a session: `KnowledgeIndex.open(ws.knowledgeDb)` when the file exists, else `() => []`.
- Produces (`refine-routes.ts`): `refineRoutes(deps: { registry: SessionRegistry; log?: (l: string) => void }): Route[]` implementing spec §5 minus `start` (Task 9):

| Method | Path | Handler |
|---|---|---|
| GET | `/api/refine` | `registry.list()` |
| POST | `/api/projects/new` `{ projectId, name }` | 400 unless `projectId` matches SLUG and `name` non-empty; `registry.newProject`; 200 `{ sessionId }` |
| POST | `/api/projects/:projectId/specs` `{ specId }` | `registry.newSpec`; 200 `{ sessionId }` |
| POST | `/api/projects/:projectId/specs/:specId/continue` `{ report? }` | `registry.continueSpec`; 200 `{ sessionId }` |
| GET | `/api/refine/:projectId/:specId` | `session.snapshot()` |
| PUT | `/api/refine/:projectId/:specId/docs/:file` `{ text }` | `file` ∈ `project.md` \| `brief.md` else 400; `saveDoc`; 200 `{ ok: true }` |
| POST | `/api/refine/:projectId/:specId/evaluate` | `void session.evaluate()` (errors logged); 202 `{ state: 'evaluating' }`; 409 when busy/started |
| POST | `/api/refine/:projectId/:specId/answers` `{ questionId, text }` | 200 `{ ok: true }` |
| POST | `/api/refine/:projectId/:specId/questions/:questionId/skip` | 200 |
| POST | `/api/refine/:projectId/:specId/patches/:patchId/accept` | 200; 409 when dropped |
| POST | `/api/refine/:projectId/:specId/patches/:patchId/reject` `{ reason? }` | 200 |
| PUT | `/api/refine/:projectId/:specId/secrets/:name` `{ value }` | 200 `{ present: true, hint }`; value never echoed |
| GET | `/api/refine/:projectId/:specId/events` | SSE: replay `session.events` after `Last-Event-ID` as `event: journal`, then `tailJournal(session.eventsFile, last, send)`; no `end` event (a session has no terminal event except `REFINE_STARTED_RUN`, after which `end` is sent) |

  Error mapping: `ConflictError` → 409, `NotFoundError` → 404, `RangeError` (from `writeSecret`) → 400, everything else 500 with the message. `sessionId` in responses is `<projectId>/<specId>`.

- [ ] **Step 1: Write the failing tests**

Create `test/api/refine-api.test.ts` (the fake `runAgent` is the same shape as in Task 6; copy it into `test/fixtures/fake-run-agent.ts` exporting `makeFakeRunAgent(script)` and reuse it in both tests):

```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refineRoutes } from '../../server/api/refine-routes.js';
import { startApi } from '../../server/api/server.js';
import { execCommand } from '../../server/exec/command.js';
import { readUserConfig } from '../../server/onboarding/config-store.js';
import { SessionRegistry } from '../../server/refine/registry.js';
import { HELLO_PROJECT, HELLO_SPEC } from '../fixtures/contracts.js';
import { makeFakeRunAgent, type Script } from '../fixtures/fake-run-agent.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

let home = '';
let api: { port: number; close(): Promise<void> };
let script: Script;
let remote: Remote | null = null;
const base = () => `http://127.0.0.1:${api.port}`;
const call = (method: string, p: string, body?: unknown) => fetch(`${base()}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const derived = { project: HELLO_PROJECT, spec: { ...HELLO_SPEC, status: 'refining', specHash: null } };
const PO = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions'].map((id) => ({ id, passed: true, detail: 'ok' }));
const SM = ['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'].map((id) => ({ id, passed: true, detail: 'ok' }));

beforeEach(async () => {
  home = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-refapi-'))).replace(/\\/g, '/');
  await fs.mkdir(`${home}/.teams-ai`, { recursive: true });
  await fs.writeFile(`${home}/.teams-ai/config.json`, JSON.stringify({ paths: { workspaces: `${home}/ws`, runs: `${home}/runs`, secrets: `${home}/secrets` }, projects: [] }));
  script = {};
  const registry = new SessionRegistry({ cfg: async () => (await readUserConfig(home)).cfg, home, runAgent: makeFakeRunAgent(script), secretsDir: `${home}/secrets`, exec: execCommand, projectDir: async () => null });
  api = await startApi({ routes: refineRoutes({ registry }) }, 0);
});
afterEach(async () => {
  await api.close();
  await remote?.cleanup();
  remote = null;
  await fs.rm(home, { recursive: true, force: true });
});

describe('refine api', () => {
  it('creates a new project draft, lists it, saves a doc, evaluates and streams the journal', async () => {
    expect((await call('POST', '/api/projects/new', { projectId: 'Bad Id', name: 'x' })).status).toBe(400);
    const created = await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ sessionId: 'hello-app/hello-001' });
    expect((await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' })).status).toBe(409);
    expect(await (await fetch(`${base()}/api/refine`)).json()).toEqual([{ projectId: 'hello-app', specId: 'hello-001', state: 'drafting', registered: false }]);
    expect((await call('PUT', '/api/refine/hello-app/hello-001/docs/spec.json', { text: 'x' })).status).toBe(400);
    expect((await call('PUT', '/api/refine/hello-app/hello-001/docs/brief.md', { text: '## Objectives\n- ship' })).status).toBe(200);
    script['derive/po'] = [derived];
    script['refine/po'] = [{ specHash: 'x', checklist: PO, questions: [{ id: 'q', text: 'Port?', blocking: true, relatedAcIds: [] }], docPatch: [] }];
    script['refine/sm'] = [{ specHash: 'x', checklist: SM, questions: [], docPatch: [] }];
    expect((await call('POST', '/api/refine/hello-app/hello-001/evaluate')).status).toBe(202);
    const events = await fetch(`${base()}/api/refine/hello-app/hello-001/events`, { headers: { 'last-event-id': '1' } });
    const reader = events.body!.getReader();
    let text = '';
    while (!text.includes('REFINE_EVALUATED')) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).not.toContain('"seq":1,');
    expect(text).toContain('event: journal');
    const snap = await (await fetch(`${base()}/api/refine/hello-app/hello-001`)).json();
    expect(snap.state.status).toBe('answering');
    expect(snap.docs['brief.md']).toBe('## Objectives\n- ship');
    expect(snap.state.questions[0]).toMatchObject({ questionId: 'po-c1-0', blocking: true });
    expect((await call('POST', '/api/refine/hello-app/hello-001/questions/po-c1-0/skip')).status).toBe(409);
    expect((await call('POST', '/api/refine/hello-app/hello-001/answers', { questionId: 'po-c1-0', text: '8080' })).status).toBe(200);
    expect((await call('POST', '/api/refine/hello-app/hello-001/answers', { questionId: 'po-c1-0', text: '8080' })).status).toBe(409);
    expect((await call('POST', '/api/refine/hello-app/hello-001/answers', { questionId: 'nope', text: 'x' })).status).toBe(404);
  });

  it('new spec and continue spec copy docs from the project clone and enforce status rules', async () => {
    const spec = { ...HELLO_SPEC, status: 'awaiting-validation', specHash: 'a'.repeat(64) };
    remote = await makeRemote({ 'docs/project.json': JSON.stringify(HELLO_PROJECT), 'docs/specs/hello-001/spec.json': JSON.stringify(spec) });
    await fs.mkdir(`${home}/ws/hello-app`, { recursive: true });
    await fs.symlink(remote.repo, `${home}/ws/hello-app/repo`, 'junction').catch(() => fs.cp(remote.repo, `${home}/ws/hello-app/repo`, { recursive: true }));
    expect((await call('POST', '/api/projects/hello-app/specs', { specId: 'hello-001' })).status).toBe(409);
    const ns = await call('POST', '/api/projects/hello-app/specs', { specId: 'hello-002' });
    expect(ns.status).toBe(200);
    const snap = await (await fetch(`${base()}/api/refine/hello-app/hello-002`)).json();
    expect(snap.docs['project.md']).toContain('## Personas');
    expect((await call('POST', '/api/projects/hello-app/specs/hello-002/continue')).status).toBe(409); // not on main
    const cont = await call('POST', '/api/projects/hello-app/specs/hello-001/continue', { report: 'broken /hello' });
    expect(cont.status).toBe(200);
    const snap2 = await (await fetch(`${base()}/api/refine/hello-app/hello-001`)).json();
    expect(snap2.docs['brief.md']).toContain('broken /hello');
    expect(snap2.state.derived.spec.status).toBe('refining');
  });

  it('writes a listed secret without echoing it', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    expect((await call('PUT', '/api/refine/hello-app/hello-001/secrets/DB_URL', { value: 'x' })).status).toBe(404);
    script['derive/po'] = [{ ...derived, spec: { ...derived.spec, externalDependencies: [{ name: 'db', purpose: 'p', secretNames: ['DB_URL'] }] } }];
    script['refine/po'] = [{ specHash: 'x', checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ specHash: 'x', checklist: SM, questions: [], docPatch: [] }];
    await call('POST', '/api/refine/hello-app/hello-001/evaluate');
    for (let i = 0; i < 50 && (await (await fetch(`${base()}/api/refine/hello-app/hello-001`)).json()).state.status === 'evaluating'; i++) await new Promise((r) => setTimeout(r, 20));
    const put = await call('PUT', '/api/refine/hello-app/hello-001/secrets/DB_URL', { value: 'postgres://secret' });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ present: true, hint: 'cret' });
    expect((await call('PUT', '/api/refine/hello-app/hello-001/secrets/DB_URL', { value: '' })).status).toBe(400);
    expect(await fs.readFile(`${home}/secrets/DB_URL`, 'utf8')).toBe('postgres://secret');
  });
});
```

`test/fixtures/fake-run-agent.ts`:

```ts
import type { RunAgent } from '../../server/refine/session.js';
export type Script = Record<string, unknown[]>; // `${kind}/${role}` → outputs per call
export const calls: Array<{ kind: string; role: string; prompt: string }> = [];
export function makeFakeRunAgent(script: Script): RunAgent {
  return (async (req, ctx) => {
    calls.push({ kind: req.kind, role: req.role, prompt: JSON.stringify(req.pack) });
    const seq = ctx.journal.allocStepSeq();
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await ctx.journal.fact('STEP_STARTED', { stepId: `s${seq}`, kind: req.kind, role: req.role, taskId: null, attempt: req.attempt });
    const next = script[`${req.kind}/${req.role}`]?.shift();
    await ctx.journal.fact('STEP_FINISHED', { stepId: `s${seq}`, kind: req.kind, taskId: null, attempt: req.attempt, ok: next !== undefined, failure: next === undefined ? 'schema' : null, usage, costUsd: 0.01, durationMs: 1, numTurns: 1 });
    const summary = { usage, costUsd: 0.01, durationMs: 1, numTurns: 1, rateLimit: null };
    if (next === undefined) return { ok: false, failure: 'schema', errors: ['no scripted output'], summary, sandboxDisabled: false } as never;
    return { ok: true, value: { ...(next as object), specHash: ctx.specHash }, summary } as never;
  }) as RunAgent;
}
```

(Task 6's test then imports `makeFakeRunAgent` instead of defining its own; update it in this task.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/api/refine-api.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `server/refine/agent.ts`**

```ts
import path from 'node:path';
import { loadAgents } from '../agents/registry.js';
import { Accounting } from '../budget/accounting.js';
import { Governor } from '../budget/governor.js';
import { DEFAULT_BREAKER, QuotaBreaker } from '../budget/quota-breaker.js';
import { resolveProfile, type Config } from '../config/config.js';
import { loadSecrets } from '../core/secrets.js';
import { runAgentStep } from '../orchestrator/steps.js';
import { expandHome } from '../orchestrator/workspace.js';
import { runStep as runStepFn } from '../runner/step.js';
import type { RunAgent } from './cycle.js';

export interface AgentWiring { cfg: Config; agentsDir: string; hostEnv: NodeJS.ProcessEnv; secretsDir: string; workspacesRoot: string; claudeJsonPath?: string; runStep?: typeof runStepFn }

/** One governor, breaker and ledger for every refinement session of the UI process (spec §2). */
export async function makeRunAgent(w: AgentWiring): Promise<RunAgent> {
  const agents = await loadAgents(w.agentsDir);
  const governor = new Governor(w.cfg.concurrency.maxClaudeProcesses);
  const breaker = new QuotaBreaker(DEFAULT_BREAKER, () => new Date());
  const accounting = new Accounting();
  const binary = { bin: w.hostEnv.CLAUDE_BIN ?? 'claude', prefixArgs: [], env: {}, requireSandboxTools: process.platform === 'linux' };
  return async (req, ctx) => {
    const secrets = await loadSecrets(w.secretsDir);
    return runAgentStep(req, {
      runStep: w.runStep ?? runStepFn,
      stepDeps: { binary, caps: w.cfg.budgets.step, accounting, claudeJsonPath: w.claudeJsonPath ?? expandHome('~/.claude.json'), settingsDir: path.posix.join(req.cwd, 'settings'), workspacesRoot: w.workspacesRoot, network: { allowedDomains: [] }, hostEnv: w.hostEnv },
      agents,
      profile: (role) => resolveProfile(w.cfg, role, { confidential: false }),
      governor, breaker,
      journal: ctx.journal, stepDir: ctx.stepDir,
      secretValues: () => Object.values(secrets),
      specHash: ctx.specHash,
    });
  };
}
```

- [ ] **Step 4: Implement `server/refine/registry.ts`**

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/config.js';
import { Spec } from '../contracts/spec.js';
import { ID_PATTERNS } from '../core/ids.js';
import type { Exec } from '../exec/command.js';
import { fetch as gitFetch, git } from '../git/git.js';
import { KnowledgeIndex } from '../knowledge/retrieval.js';
import { expandHome, workspacePaths, type Workspace } from '../orchestrator/workspace.js';
import { loadEvents } from '../store/event-store.js';
import type { RunAgent } from './cycle.js';
import { createFromRepo, createNewProject, draftExists, draftPaths, type Draft } from './draft.js';
import { ConflictError, NotFoundError, RefineSession } from './session.js';
import { reduceRefineEvents, type RefineStatus } from './state.js';

export interface RegistryDeps { cfg: () => Promise<Config>; home?: string; runAgent: RunAgent; secretsDir: string; exec: Exec; projectDir: (projectId: string) => Promise<string | null> }

const slug = (v: string, what: string) => {
  if (!ID_PATTERNS.SLUG.test(v)) throw new RangeError(`${what} must match ${ID_PATTERNS.SLUG}`);
  return v;
};

export class SessionRegistry {
  private readonly open = new Map<string, Promise<RefineSession>>();
  constructor(private readonly deps: RegistryDeps) {}

  private async ws(projectId: string): Promise<Workspace> { return workspacePaths(await this.deps.cfg(), projectId, this.deps.home); }
  private async session(draft: Draft, ws: Workspace, create?: 'new-project' | 'new-spec' | 'continue'): Promise<RefineSession> {
    const key = `${draft.projectId}/${draft.specId}`;
    const retrieval = (await fs.access(ws.knowledgeDb).then(() => true, () => false)) ? (q: string) => KnowledgeIndex.open(ws.knowledgeDb).search(q, { k: 5 }) : () => [];
    const deps = { ws, draft, runAgent: this.deps.runAgent, secretsDir: this.deps.secretsDir, retrieval };
    const p = create ? RefineSession.create(deps, create) : RefineSession.open(deps);
    this.open.set(key, p);
    p.catch(() => this.open.delete(key));
    return p;
  }

  async get(projectId: string, specId: string): Promise<RefineSession> {
    slug(projectId, 'projectId'); slug(specId, 'specId');
    const key = `${projectId}/${specId}`;
    const cached = this.open.get(key);
    if (cached) return cached;
    const ws = await this.ws(projectId);
    const draft = draftPaths(ws, specId);
    if (!(await draftExists(draft))) throw new NotFoundError(`no refinement session for ${key}`);
    return this.session(draft, ws);
  }

  async newProject(projectId: string, name: string): Promise<RefineSession> {
    slug(projectId, 'projectId');
    if (name.trim() === '') throw new RangeError('name must not be empty');
    const ws = await this.ws(projectId);
    const specId = `${projectId}-001`.slice(0, 64);
    const draft = draftPaths(ws, specId);
    if ((await this.deps.projectDir(projectId)) || (await draftExists(draft)) || (await fs.access(ws.repo).then(() => true, () => false))) throw new ConflictError(`project ${projectId} already exists; register it instead`);
    await createNewProject(draft, name);
    return this.session(draft, ws, 'new-project');
  }

  private async specOnMain(ws: Workspace, specId: string): Promise<Spec | null> {
    if (!(await fs.access(path.join(ws.repo, '.git')).then(() => true, () => false))) throw new ConflictError(`project ${ws.projectId} has no workspace clone; run it once from the CLI or add it as a project`);
    await gitFetch(ws.repo, this.deps.exec);
    const text = await git(ws.repo, ['show', `origin/main:docs/specs/${specId}/spec.json`], this.deps.exec).catch(() => null);
    return text === null ? null : Spec.parse(JSON.parse(text));
  }

  async newSpec(projectId: string, specId: string): Promise<RefineSession> {
    slug(projectId, 'projectId'); slug(specId, 'specId');
    const ws = await this.ws(projectId);
    const draft = draftPaths(ws, specId);
    if (await draftExists(draft)) throw new ConflictError(`spec ${specId} already has a refinement session`);
    if (await this.specOnMain(ws, specId)) throw new ConflictError(`spec ${specId} already exists on main`);
    await createFromRepo(draft, ws.repo, this.deps.exec, { kind: 'new-spec' });
    return this.session(draft, ws, 'new-spec');
  }

  async continueSpec(projectId: string, specId: string, report?: string): Promise<RefineSession> {
    slug(projectId, 'projectId'); slug(specId, 'specId');
    const ws = await this.ws(projectId);
    const draft = draftPaths(ws, specId);
    if (await draftExists(draft)) throw new ConflictError(`spec ${specId} already has a refinement session`);
    const spec = await this.specOnMain(ws, specId);
    if (!spec || (spec.status !== 'awaiting-validation' && spec.status !== 'done')) throw new ConflictError(`spec ${specId} is ${spec?.status ?? 'absent'} on main; only awaiting-validation or done specs continue`);
    await createFromRepo(draft, ws.repo, this.deps.exec, { kind: 'continue', report });
    return this.session(draft, ws, 'continue');
  }

  async list(): Promise<Array<{ projectId: string; specId: string; state: RefineStatus; registered: boolean }>> {
    const cfg = await this.deps.cfg();
    const root = expandHome(cfg.paths.workspaces, this.deps.home);
    const out: Array<{ projectId: string; specId: string; state: RefineStatus; registered: boolean }> = [];
    for (const projectId of await fs.readdir(root).catch(() => [] as string[])) {
      const refine = path.posix.join(root, projectId, 'refine');
      for (const specId of await fs.readdir(refine).catch(() => [] as string[])) {
        const file = path.posix.join(refine, specId, 'events.ndjson');
        const events = await loadEvents(file).catch(() => null);
        if (!events) continue;
        out.push({ projectId, specId, state: reduceRefineEvents(events).status, registered: (await this.deps.projectDir(projectId)) !== null });
      }
    }
    return out;
  }
}
```

- [ ] **Step 5: Implement `server/api/refine-routes.ts`**

```ts
import { SECRET_NAME } from '../core/secrets.js';
import type { DocFile } from '../refine/draft.js';
import type { SessionRegistry } from '../refine/registry.js';
import { ConflictError, NotFoundError } from '../refine/session.js';
import type { StoredEvent } from '../store/event-store.js';
import { tailJournal } from './journal-tail.js';
import { HttpError, type Route, type RouteContext } from './server.js';

const P = '/api';
const str = (v: unknown, field: string, optional = false): string => {
  const x = (v as Record<string, unknown> | null)?.[field];
  if (x === undefined && optional) return '';
  if (typeof x !== 'string') throw new HttpError(400, `${field} must be a string`);
  return x;
};
const wrap = (h: (ctx: RouteContext) => Promise<void>) => async (ctx: RouteContext) => {
  try { await h(ctx); } catch (err) {
    if (err instanceof ConflictError) throw new HttpError(409, err.message);
    if (err instanceof NotFoundError) throw new HttpError(404, err.message);
    if (err instanceof RangeError) throw new HttpError(400, err.message);
    throw err;
  }
};

export function refineRoutes(deps: { registry: SessionRegistry; log?: (l: string) => void }): Route[] {
  const { registry } = deps;
  const get = (params: Record<string, string>) => registry.get(params.projectId!, params.specId!);
  const id = (s: { snapshot(): Promise<{ projectId: string; specId: string }> }) => s.snapshot().then((x) => ({ sessionId: `${x.projectId}/${x.specId}` }));
  const S = `${P}/refine/:projectId/:specId`;
  return [
    { method: 'GET', path: `${P}/refine`, handler: wrap(async ({ json }) => json(200, await registry.list())) },
    { method: 'POST', path: `${P}/projects/new`, handler: wrap(async ({ body, json }) => { const b = await body(); json(200, await id(await registry.newProject(str(b, 'projectId'), str(b, 'name')))); }) },
    { method: 'POST', path: `${P}/projects/:projectId/specs`, handler: wrap(async ({ params, body, json }) => json(200, await id(await registry.newSpec(params.projectId!, str(await body(), 'specId'))))) },
    { method: 'POST', path: `${P}/projects/:projectId/specs/:specId/continue`, handler: wrap(async ({ params, body, json }) => { const report = str(await body().catch(() => ({})), 'report', true); json(200, await id(await registry.continueSpec(params.projectId!, params.specId!, report || undefined))); }) },
    { method: 'GET', path: S, handler: wrap(async ({ params, json }) => json(200, await (await get(params)).snapshot())) },
    { method: 'PUT', path: `${S}/docs/:file`, handler: wrap(async ({ params, body, json }) => {
      const file = params.file!;
      if (file !== 'project.md' && file !== 'brief.md') throw new HttpError(400, `unknown doc ${file}`);
      await (await get(params)).saveDoc(file as DocFile, str(await body(), 'text'));
      json(200, { ok: true });
    }) },
    { method: 'POST', path: `${S}/evaluate`, handler: wrap(async ({ params, json }) => {
      const s = await get(params);
      if (s.busy || s.state.status === 'started') throw new ConflictError(s.busy ? 'evaluation in progress' : 'session already started a run');
      s.evaluate().catch((err: Error) => deps.log?.(`refine ${params.projectId}/${params.specId}: ${err.message}`));
      json(202, { state: 'evaluating' });
    }) },
    { method: 'POST', path: `${S}/answers`, handler: wrap(async ({ params, body, json }) => { const b = await body(); await (await get(params)).answer(str(b, 'questionId'), str(b, 'text')); json(200, { ok: true }); }) },
    { method: 'POST', path: `${S}/questions/:questionId/skip`, handler: wrap(async ({ params, json }) => { await (await get(params)).skip(params.questionId!); json(200, { ok: true }); }) },
    { method: 'POST', path: `${S}/patches/:patchId/accept`, handler: wrap(async ({ params, json }) => { await (await get(params)).accept(params.patchId!); json(200, { ok: true }); }) },
    { method: 'POST', path: `${S}/patches/:patchId/reject`, handler: wrap(async ({ params, body, json }) => { const reason = str(await body().catch(() => ({})), 'reason', true); await (await get(params)).reject(params.patchId!, reason || null); json(200, { ok: true }); }) },
    { method: 'PUT', path: `${S}/secrets/:name`, handler: wrap(async ({ params, body, json }) => {
      const name = params.name!;
      if (!SECRET_NAME.test(name)) throw new HttpError(400, 'invalid secret name');
      const value = str(await body(), 'value');
      await (await get(params)).writeSecret(name, value);
      json(200, { present: true, hint: value.trim().slice(-4) });
    }) },
    { method: 'GET', path: `${S}/events`, handler: wrap(async ({ req, params, sse }) => {
      const s = await get(params);
      const header = req.headers['last-event-id'];
      const after = Number(Array.isArray(header) ? header[0] : (header ?? 0)) || 0;
      const w = sse();
      let last = after;
      let tail: { close(): void } | null = null;
      const send = (e: StoredEvent) => {
        last = e.seq;
        w.send('journal', e, String(e.seq));
        if (e.type === 'REFINE_STARTED_RUN') { w.send('end', {}); tail?.close(); w.close(); }
      };
      for (const e of s.events) if (e.seq > after) send(e);
      if (s.state.status === 'started') return;
      tail = tailJournal(s.eventsFile, last, send);
      w.onClose(() => tail?.close());
    }) },
  ];
}
```

- [ ] **Step 6: Wire into `teams-ai ui`**

In `server/cli.ts` `startUiReal`, after `runRoutes(...)`:

```ts
        ...refineRoutes({
          registry: new SessionRegistry({
            cfg: async () => (await readUserConfig()).cfg,
            runAgent: await makeRunAgent({ cfg, agentsDir: path.join(repoRoot, '.claude', 'agents'), hostEnv: io.env, secretsDir: expandHome(cfg.paths.secrets), workspacesRoot: expandHome(cfg.paths.workspaces) }),
            secretsDir: expandHome(cfg.paths.secrets),
            exec: execCommand,
            projectDir: async (projectId) => {
              for (const { dir } of (await readUserConfig()).cfg.projects) {
                const read = await readProject(dir).catch(() => null);
                if (read?.project.projectId === projectId) return dir;
              }
              return null;
            },
          }),
          log: io.stderr,
        }),
```

with the imports `refineRoutes`, `SessionRegistry`, `makeRunAgent`, `readProject` (from `./api/run-index.js`).

- [ ] **Step 7: Run tests and commit**

Run: `npx vitest run test/api test/refine && npm run typecheck`
Expected: PASS.

```bash
git add server/refine/agent.ts server/refine/registry.ts server/api/refine-routes.ts server/cli.ts test/api/refine-api.test.ts test/fixtures/fake-run-agent.ts test/refine/session.test.ts
git commit -m "feat(api): refinement sessions over REST and SSE; draft listing; agent wiring in the UI process"
```

---

### Task 8: Phase 0 bootstrap and `run --draft`

**Files:**
- Create: `server/orchestrator/phases/bootstrap.ts`
- Modify: `server/orchestrator/events.ts:33-41` (`Intent.RepoCreate`, `OrchEvent.RepoBootstrapped`), `server/orchestrator/phases/shared.ts:76-78` (phase `0 | 1 | 2`), `server/orchestrator/phases/index.ts` (export), `server/orchestrator/reconcile.ts:52-70` (`RepoCreate` case; `DocsCommit` tolerates a repo without HEAD), `server/orchestrator/run.ts:36-58` (`RunDeps.bootstrap`), `:376-378` (`execute` runs Phase 0 first), `server/cli.ts:16-19` (usage), `:95-107` (preconditions skip main checks with `--draft`), `:109-150` (`loadRunDeps` takes `draft`)
- Test: `test/orchestrator/phase0.test.ts`, `test/cli.test.ts` (add one case)

**Interfaces:**
- Produces: `Intent.RepoCreate = 'REPO_CREATE'` (data `{ owner, name }`), `OrchEvent.RepoBootstrapped = 'REPO_BOOTSTRAPPED'` (data `{ fullName, url, created }`).
- Produces: `RunDeps.bootstrap?: { docsDir: string; owner: string | undefined }` — when set, `Run.execute()` runs Phase 0 before Phase 1.
- Produces (`bootstrap.ts`): `runPhase0(deps: PhaseDeps & { ghExec: Exec }, opts: { docsDir: string; owner: string | undefined }): Promise<PhaseResult>`.
- Produces: `docsCommitKey(deps, phase: 0 | 1 | 2)`, `commitAndMergeDocs(deps, phase: 0 | 1 | 2, ...)`.
- Produces: CLI flag `--draft` on `run` (boolean). With it, preconditions skip "main lacks docs/…" and "repo/ is not a git clone"; `loadRunDeps` sets `bootstrap = { docsDir: <projectDir>/docs, owner: project.github.owner ?? cfg.github.owner }`.

Phase 0 algorithm (spec §4), idempotent by journal:

```
PHASE_STARTED {0} once.
remoteExists := ghExec(gh repo view <owner>/<projectId> --json nameWithOwner).exitCode === 0   (owner undefined → gh api user login first, as ensureRepo does)
if !remoteExists:
  if ws.repo lacks .git: git init -b main
  copy docsDir → ws.repo/docs (overwrite)
  key = `${specId}-0`; unless confirmed DocsCommit key: intent {worktree: ws.repo, branch: 'main', message}, commitAll(ws.repo, `docs: ${projectId} ${specId} v${specVersion}`), confirm {sha}
  unless confirmed RepoCreate projectId: intent {owner, name}; ensureRepo({owner, name: projectId, private: true, cwd: ws.repo}, ghExec); confirm {fullName, url, created}; fact REPO_BOOTSTRAPPED
  git fetch
else:
  if ws.repo lacks .git: git clone <url from gh repo view --json url> ws.repo
  wt = docsWorktree(deps, `docs/${specId}-v${specVersion}`)
  copy docsDir/{project.md, project.json, specs/<specId>/brief.md, specs/<specId>/spec.json} → wt (mkdir -p)
  commitAndMergeDocs(deps, 0, branch, wt, `docs(${specId}): spec v${specVersion}`)
```

- [ ] **Step 1: Write the failing tests**

Create `test/orchestrator/phase0.test.ts` (uses the same `deps()` construction as `test/orchestrator/loop.test.ts`; extract that helper into `test/fixtures/run-deps.ts` exporting `makeRunDeps(remote, scenario, over)` in this task and make `loop.test.ts` import it):

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { Intent, OrchEvent } from '../../server/orchestrator/events.js';
import { Run } from '../../server/orchestrator/run.js';
import { makeRunDeps } from '../fixtures/run-deps.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';
import { HELLO_PROJECT, HELLO_SPEC } from '../fixtures/contracts.js';

let remote: Remote;
let draftDocs: string;
const frozen = { ...HELLO_SPEC, status: 'running', specHash: 'a'.repeat(64), specVersion: 1 };

beforeEach(async () => {
  remote = await makeRemote({ 'README.md': 'seed' });   // origin exists; ws.repo will be replaced per case
  draftDocs = path.join(remote.root, 'draft', 'docs');
  await fs.mkdir(path.join(draftDocs, 'specs', 'hello-001'), { recursive: true });
  await fs.writeFile(path.join(draftDocs, 'project.md'), '# Hello');
  await fs.writeFile(path.join(draftDocs, 'project.json'), JSON.stringify(HELLO_PROJECT));
  await fs.writeFile(path.join(draftDocs, 'specs', 'hello-001', 'brief.md'), '## Objectives');
  await fs.writeFile(path.join(draftDocs, 'specs', 'hello-001', 'spec.json'), JSON.stringify(frozen));
});
afterEach(() => remote.cleanup());

/** gh that says the repo is absent, then "creates" it by pointing origin at the bare remote and pushing. */
function ghAbsentThenCreate(exec: FakeExec, repoDir: string) {
  let created = false;
  exec.onArgs('gh', ['repo', 'view'], () => (created ? { stdout: JSON.stringify({ nameWithOwner: 'o/hello-app', url: 'https://github.example/o/hello-app' }) } : { exitCode: 1, stderr: 'Could not resolve to a Repository' }));
  exec.onArgs('gh', ['repo', 'create'], async () => {
    created = true;
    await git(repoDir, ['remote', 'add', 'origin', remote.origin], execCommand);
    await git(repoDir, ['push', '-u', 'origin', 'main'], execCommand);
    return { stdout: 'https://github.example/o/hello-app\n' };
  });
}

describe('phase 0', () => {
  it('creates the repository from the draft when none exists, then Phase 1 starts', { timeout: 60_000 }, async () => {
    const wsRepo = path.join(remote.root, 'fresh-repo');
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    ghAbsentThenCreate(exec, wsRepo);
    new FakeGh().install(exec);
    // empty the bare remote's main so the "no repository" case is honest
    const d = makeRunDeps(remote, null, { exec: exec.exec, ghExec: exec.exec, spec: frozen, firstSpec: true, bootstrap: { docsDir: draftDocs, owner: 'o' } });
    d.ws = { ...d.ws, repo: wsRepo };
    const run = await Run.create(d, 'hello-001-r1');
    const result = await run.executePhase0();   // exposed for tests; execute() calls it first
    expect(result).toEqual({ ok: true });
    const types = run.journal.events.map((e) => `${e.kind}:${e.type}`);
    expect(types).toContain('intent:DOCS_COMMIT');
    expect(types).toContain('confirm:DOCS_COMMIT');
    expect(types).toContain('confirm:REPO_CREATE');
    expect(types).toContain(`fact:${OrchEvent.RepoBootstrapped}`);
    expect(await git(wsRepo, ['show', 'origin/main:docs/specs/hello-001/spec.json'], execCommand)).toContain('"specHash"');
  });

  it('merges a docs PR when the repository exists, and resume after a crash does not duplicate the commit', { timeout: 60_000 }, async () => {
    const exec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
    exec.onArgs('gh', ['repo', 'view'], () => ({ stdout: JSON.stringify({ nameWithOwner: 'o/hello-app', url: remote.origin }) }));
    const gh = new FakeGh().install(exec);
    const d = makeRunDeps(remote, null, { exec: exec.exec, ghExec: exec.exec, spec: frozen, bootstrap: { docsDir: draftDocs, owner: 'o' }, crashAfterIntent: (id) => id === `${Intent.DocsCommit}:hello-001-0` });
    const first = await Run.create(d, 'hello-001-r1');
    await expect(first.executePhase0()).rejects.toThrow(/crash injected/);
    await first.close();
    const resumed = await Run.resume({ ...d, crashAfterIntent: undefined }, 'hello-001-r1');
    expect(await resumed.executePhase0()).toEqual({ ok: true });
    expect(gh.prs.filter((p) => p.title === 'docs(hello-001): spec v1')).toHaveLength(1);
    const log = await git(remote.repo, ['log', '--oneline', 'origin/main', '--', 'docs/specs/hello-001/spec.json'], execCommand);
    expect(log.trim().split('\n')).toHaveLength(1);
    expect(resumed.journal.events.filter((e) => e.kind === 'confirm' && e.type === Intent.DocsCommit)).toHaveLength(1);
  });
});
```

Append to `test/cli.test.ts`:

```ts
  it('run --draft is accepted and reaches the factory', async () => {
    const a = io(['run', '--project', '/tmp/p', '--spec', 'spec-001', '--draft']);
    let seenDraft: boolean | undefined;
    const code = await main(a.io, async (deps) => { seenDraft = deps === null ? undefined : true; return { runId: 'x', execute: async () => 'complete', requestStop: async () => {}, close: async () => {}, journal: { state: { tasks: new Map() } }, accounting: { total: () => ({ costUsd: 0 }) } } as never; }, { signals: () => () => {} });
    expect(code).toBe(0);
    expect(seenDraft ?? undefined).toBeUndefined(); // deps load is best-effort under a custom factory; the flag must not make parsing fail
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/orchestrator/phase0.test.ts test/cli.test.ts`
Expected: FAIL — `executePhase0` / `bootstrap` unknown; `--draft` rejected.

- [ ] **Step 3: Events, shared and reconcile changes**

`server/orchestrator/events.ts`: add `RepoBootstrapped: 'REPO_BOOTSTRAPPED'` to `OrchEvent` and `RepoCreate: 'REPO_CREATE'` to `Intent`.

`server/orchestrator/phases/shared.ts`: change both `phase: 1 | 2` to `phase: 0 | 1 | 2`.

`server/orchestrator/reconcile.ts`: in the `Intent.Commit`/`Intent.DocsCommit` case wrap `headSha` so a repository without commits redoes instead of throwing:

```ts
        const head = await headSha(wt, exec).catch(() => null);
        if (head === null) { redo(e); break; }
```

and add before `default`:

```ts
      case Intent.RepoCreate: {
        const view = await ghExec({ bin: 'gh', args: ['repo', 'view', `${String(d.owner)}/${String(d.name)}`, '--json', 'nameWithOwner,url'], cwd: deps.ws.repo, timeoutMs: 60_000 });
        view.exitCode === 0 ? await confirm(e, JSON.parse(view.stdout)) : redo(e);
        break;
      }
```

- [ ] **Step 4: Implement `server/orchestrator/phases/bootstrap.ts`**

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Exec } from '../../exec/command.js';
import { commitAll, fetch as gitFetch, git } from '../../git/git.js';
import { ensureRepo } from '../../git/github.js';
import { Intent, OrchEvent } from '../events.js';
import { commitAndMergeDocs, docsWorktree, type PhaseDeps, type PhaseResult } from './shared.js';

const isRepo = (dir: string) => fs.access(path.join(dir, '.git')).then(() => true, () => false);

async function copyDir(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  await fs.cp(from, to, { recursive: true, force: true });
}

/** Spec (refinement) §4: put the draft's docs on main — by creating the repository or by a docs PR. */
export async function runPhase0(deps: PhaseDeps & { ghExec: Exec }, opts: { docsDir: string; owner: string | undefined }): Promise<PhaseResult> {
  const { journal, ws, spec, project } = deps;
  if (!journal.events.some((e) => e.type === OrchEvent.PhaseStarted && e.data.phase === 0)) await journal.fact(OrchEvent.PhaseStarted, { phase: 0 });
  const owner = opts.owner ?? JSON.parse((await deps.ghExec({ bin: 'gh', args: ['api', 'user'], cwd: ws.root, timeoutMs: 60_000 })).stdout).login as string;
  const fullName = `${owner}/${project.projectId}`;
  const view = await deps.ghExec({ bin: 'gh', args: ['repo', 'view', fullName, '--json', 'nameWithOwner,url'], cwd: ws.root, timeoutMs: 60_000 });
  const version = spec.specVersion;

  if (view.exitCode !== 0) {
    await fs.mkdir(ws.repo, { recursive: true });
    if (!(await isRepo(ws.repo))) await git(ws.repo, ['init', '-b', 'main'], deps.exec);
    await copyDir(opts.docsDir, path.join(ws.repo, 'docs'));
    const key = `${spec.specId}-0`;
    if (!journal.isConfirmed(Intent.DocsCommit, key)) {
      await journal.intent(Intent.DocsCommit, key, { worktree: ws.repo, branch: 'main', message: `docs: ${project.projectId} ${spec.specId} v${version}` });
      const sha = (await commitAll(ws.repo, `docs: ${project.projectId} ${spec.specId} v${version}`, {}, deps.exec)) ?? (await git(ws.repo, ['rev-parse', 'HEAD'], deps.exec));
      await journal.confirm(Intent.DocsCommit, key, { sha });
    }
    if (!journal.isConfirmed(Intent.RepoCreate, project.projectId)) {
      await journal.intent(Intent.RepoCreate, project.projectId, { owner, name: project.projectId });
      const created = await ensureRepo({ owner, name: project.projectId, private: true, cwd: ws.repo }, deps.ghExec);
      await journal.confirm(Intent.RepoCreate, project.projectId, created);
      await journal.fact(OrchEvent.RepoBootstrapped, created);
    }
    await gitFetch(ws.repo, deps.exec);
    return { ok: true };
  }

  const { url } = JSON.parse(view.stdout) as { url: string };
  if (!(await isRepo(ws.repo))) {
    await fs.mkdir(path.dirname(ws.repo), { recursive: true });
    await git(path.dirname(ws.repo), ['clone', url, path.basename(ws.repo)], deps.exec);
  }
  const branch = `docs/${spec.specId}-v${version}`;
  const wt = await docsWorktree(deps, branch);
  const rel = ['project.md', 'project.json', `specs/${spec.specId}/brief.md`, `specs/${spec.specId}/spec.json`];
  for (const r of rel) {
    await fs.mkdir(path.dirname(path.join(wt, 'docs', r)), { recursive: true });
    await fs.copyFile(path.join(opts.docsDir, r), path.join(wt, 'docs', r));
  }
  return commitAndMergeDocs(deps, 0, branch, wt, `docs(${spec.specId}): spec v${version}`);
}
```

Export it from `server/orchestrator/phases/index.ts`.

- [ ] **Step 5: `Run` and CLI**

`server/orchestrator/run.ts`: add to `RunDeps`:

```ts
  /** Spec (refinement) §4: docs to put on main before Phase 1 (run --draft). */
  bootstrap?: { docsDir: string; owner: string | undefined };
```

add the method (public, used by `execute` and tests):

```ts
  async executePhase0(): Promise<PhaseResult> {
    if (!this.deps.bootstrap) return { ok: true };
    return runPhase0({ ...this.phaseDeps(), ghExec: this.deps.ghExec }, this.deps.bootstrap);
  }
```

and at the top of `execute()`:

```ts
    const phase0 = await this.executePhase0();
    if (!phase0.ok) return phase0.reason === PAUSED_AUTH ? 'paused:auth' : this.finish('phase-failed', phase0.reason);
```

`server/cli.ts`: usage line `teams-ai run --project <dir> [--spec <id>] [--run-id <id>] [--max-parallel N] [--dry-run] [--draft]`; `preconditions(exec, repo, specId, draft: boolean)` skips the first three checks when `draft`; `loadRunDeps(..., opts: { dryRun; maxParallel?; draft: boolean })` passes `draft` and returns `bootstrap: opts.draft ? { docsDir: path.join(projectDir, 'docs'), owner: project.github.owner ?? cfg.github.owner } : undefined`; `main` reads `draft: f.draft === true`.

- [ ] **Step 6: Run tests and commit**

Run: `npx vitest run test/orchestrator test/cli.test.ts && npm run typecheck`
Expected: PASS (loop tests unchanged: `bootstrap` undefined).

```bash
git add server/orchestrator test/orchestrator test/fixtures/run-deps.ts server/cli.ts test/cli.test.ts
git commit -m "feat(orchestrator): phase 0 bootstrap from a draft; run --draft"
```

---

### Task 9: Start — freeze, spawn `run --draft`, register the draft root

**Files:**
- Modify: `server/api/run-control.ts:22-34` (`RunTarget.draft`), `server/api/refine-routes.ts` (start route), `server/refine/registry.ts` (`start`), `server/refine/session.ts` (`freeze()`)
- Test: `test/api/run-control.test.ts` (one case), `test/api/refine-api.test.ts` (one case)

**Interfaces:**
- Produces: `RunTarget.draft?: boolean` → `runCommand` appends `--draft` for `mode: 'run'`.
- Produces: `RefineSession.freeze(): Promise<{ spec: Spec; project: Project }>` — `ConflictError` unless `ready` and not stale; `freezeSpec(derived.spec)`; writes both JSON files to the draft; returns them.
- Produces: `SessionRegistry.start(projectId, specId, deps: { control: RunControlDeps; runsDir: string; register: (dir: string) => Promise<void> }): Promise<{ runId }>` — `freeze` → `runId = nextRunId({ runs }, specId)` → `spawnRun(control, { projectDir: draft.root, specId, runId, mode: 'run', draft: true, logFile: <runs>/<runId>/ui.log })` (create the run dir first) → `writePid` → `register(draft.root)` → `session.markStarted(runId)`.
- Produces: `POST /api/refine/:projectId/:specId/start` → `{ runId }`; 409 (ConflictError) when not ready/stale/started.

`RegistryDeps` gains `control: RunControlDeps` and `register: (dir: string) => Promise<void>` (= `addProject(dir, home)`), and `runsDir: () => Promise<string>` (= `runsDir({ cfg, home, isAlive })` from block A's `run-index.ts`). `startUiReal` passes `control: defaultRunControl(repoRoot)`, `register: (dir) => addProject(dir).then(() => undefined)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/api/run-control.test.ts`:

```ts
  it('adds --draft to a run command when asked', () => {
    const args = runCommand(deps, { projectDir: '/d', specId: 's', runId: 's-r1', mode: 'run', draft: true }).args;
    expect(args.slice(-1)).toEqual(['--draft']);
    expect(runCommand(deps, { projectDir: '/d', specId: 's', runId: 's-r1', mode: 'run' }).args).not.toContain('--draft');
  });
```

Append to `test/api/refine-api.test.ts` (the registry in `beforeEach` now also receives `control` — the same fake `control` object as `test/api/run-api.test.ts` builds, recording `spawns` — plus `register: async (dir) => { registered.push(dir); }` and `runsDir: async () => `${home}/runs``):

```ts
  it('start freezes the spec, spawns run --draft with the draft root, registers it, and refuses when stale', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    expect((await call('POST', '/api/refine/hello-app/hello-001/start')).status).toBe(409);
    script['derive/po'] = [derived];
    script['refine/po'] = [{ specHash: 'x', checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ specHash: 'x', checklist: SM, questions: [], docPatch: [] }];
    await call('POST', '/api/refine/hello-app/hello-001/evaluate');
    for (let i = 0; i < 50 && (await (await fetch(`${base()}/api/refine/hello-app/hello-001`)).json()).state.status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 20));
    await call('PUT', '/api/refine/hello-app/hello-001/docs/brief.md', { text: '## Objectives\n- changed' });
    expect((await call('POST', '/api/refine/hello-app/hello-001/start')).status).toBe(409); // stale
    expect(spawns).toHaveLength(0);
    script['derive/po'] = [derived]; script['refine/po'] = [{ specHash: 'x', checklist: PO, questions: [], docPatch: [] }]; script['refine/sm'] = [{ specHash: 'x', checklist: SM, questions: [], docPatch: [] }];
    await call('POST', '/api/refine/hello-app/hello-001/evaluate');
    for (let i = 0; i < 50 && (await (await fetch(`${base()}/api/refine/hello-app/hello-001`)).json()).state.status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 20));
    const started = await call('POST', '/api/refine/hello-app/hello-001/start');
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ runId: 'hello-001-r1' });
    const draftRoot = `${home}/ws/hello-app/refine/hello-001`;
    expect(spawns[0]!.args).toEqual(['cli', 'run', '--project', draftRoot, '--spec', 'hello-001', '--run-id', 'hello-001-r1', '--draft']);
    expect(registered).toEqual([draftRoot]);
    const spec = JSON.parse(await fs.readFile(`${draftRoot}/docs/specs/hello-001/spec.json`, 'utf8'));
    expect(spec).toMatchObject({ status: 'running', specVersion: 1 });
    expect(spec.specHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await fs.readFile(`${home}/runs/hello-001-r1/pid`, 'utf8')).toBe('5001');
    expect((await (await fetch(`${base()}/api/refine/hello-app/hello-001`)).json()).state).toMatchObject({ status: 'started', runId: 'hello-001-r1' });
    expect((await call('POST', '/api/refine/hello-app/hello-001/evaluate')).status).toBe(409);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/api/run-control.test.ts test/api/refine-api.test.ts`
Expected: FAIL — `--draft` missing; start route 404.

- [ ] **Step 3: Implement**

`server/api/run-control.ts`: `RunTarget` gains `draft?: boolean`; in `runCommand`, for `mode === 'run'` append `'--draft'` when `o.draft`.

`server/refine/session.ts` — add:

```ts
  /** Spec (refinement) §3.6 steps 1–2. */
  async freeze(): Promise<{ spec: Spec; project: Project }> {
    this.guard();
    if (this.state.status !== 'ready' || this.state.stale) throw new ConflictError(`session is ${this.state.status}${this.state.stale ? ' (stale)' : ''}; evaluate until ready`);
    const frozen = freezeSpec(this.state.derived!.spec);
    const value = { project: this.state.derived!.project, spec: frozen };
    await writeDerived(this.deps.draft, value);
    return value;
  }
```

(imports: `freezeSpec` from `../contracts/spec.js`, `writeDerived` from `./draft.js`, types `Spec`, `Project`).

`server/refine/registry.ts` — `RegistryDeps` gains `control: RunControlDeps; runsDir: () => Promise<string>; register: (dir: string) => Promise<void>`; add:

```ts
  async start(projectId: string, specId: string): Promise<{ runId: string }> {
    const session = await this.get(projectId, specId);
    const ws = await this.ws(projectId);
    const draft = draftPaths(ws, specId);
    await session.freeze();
    const runs = await this.deps.runsDir();
    const runId = await nextRunId({ runs }, specId);
    await fs.mkdir(path.posix.join(runs, runId), { recursive: true });
    const { pid } = spawnRun(this.deps.control, { projectDir: draft.root, specId, runId, mode: 'run', draft: true, logFile: path.posix.join(runs, runId, 'ui.log') });
    await writePid(runs, runId, pid);
    await this.deps.register(draft.root);
    await session.markStarted(runId);
    return { runId };
  }
```

(imports: `nextRunId` from `../orchestrator/workspace.js`, `spawnRun`, `RunControlDeps` from `../api/run-control.js`, `writePid` from `../api/run-index.js`).

`server/api/refine-routes.ts` — add `{ method: 'POST', path: `${S}/start`, handler: wrap(async ({ params, json }) => json(200, await registry.start(params.projectId!, params.specId!))) }`.

`server/cli.ts` `startUiReal`: pass `control: defaultRunControl(repoRoot)`, `runsDir: async () => runsDir({ cfg: (await readUserConfig()).cfg, isAlive: () => false })`, `register: (dir) => addProject(dir).then(() => undefined)`.

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run test/api && npm run typecheck`
Expected: PASS.

```bash
git add server/api/run-control.ts server/api/refine-routes.ts server/refine/registry.ts server/refine/session.ts server/cli.ts test/api/run-control.test.ts test/api/refine-api.test.ts
git commit -m "feat(refine): start freezes the spec, spawns run --draft and registers the draft"
```

---

### Task 10: Web — refine API client, browser reducer, Refinement page

**Files:**
- Modify: `web/src/api.ts` (append refine types and `refineApi`)
- Create: `web/src/refine/reducer.ts`, `web/src/refine/reducer.test.ts`, `web/src/pages/Refinement.tsx`, `web/src/pages/Refinement.test.tsx`
- Modify: `web/src/App.tsx` (route `/refine/:projectId/:specId`), `web/src/styles.css` (three-column layout, diff colours)

**Interfaces:**
- Consumes: `useJournal(url)` from `web/src/useSse.ts` (block A: `{ events: StoredEvent[]; ended: boolean; error: string | null }`); `StoredEvent` type in `web/src/api.ts`.
- Produces (`web/src/api.ts`):

```ts
export type RefineStatus = 'drafting' | 'evaluating' | 'answering' | 'ready' | 'error' | 'started';
export interface ChecklistItem { id: string; role: 'po' | 'sm'; passed: boolean; detail: string }
export interface QuestionRow { questionId: string; role: 'po' | 'sm'; text: string; blocking: boolean; relatedAcIds: string[]; cycle: number; status: 'pending' | 'answered' | 'skipped'; answer: string | null }
export interface PatchRow { patchId: string; role: 'po' | 'sm'; file: 'project.md' | 'brief.md'; find: string; replace: string; reason: string; diff: string; cycle: number; status: 'pending' | 'accepted' | 'rejected' | 'dropped'; decision: string | null }
export interface RefineState { status: RefineStatus; stale: boolean; cycle: number; derived: { project: unknown; spec: { acceptanceCriteria: AcceptanceCriterion[]; tasks?: Array<{ title: string; description: string }>; externalDependencies: Array<{ name: string; secretNames: string[] }> } & Record<string, unknown> } | null; checklist: ChecklistItem[]; questions: QuestionRow[]; patches: PatchRow[]; discarded: Array<{ cycle: number; role: string; file: string; reason: string }>; error: string | null; runId: string | null }
export interface Snapshot { projectId: string; specId: string; state: RefineState; docs: { 'project.md': string; 'brief.md': string }; secrets: Array<{ name: string; present: boolean; hint: string | null }>; tokens: { inputTokens: number; outputTokens: number; costUsd: number; steps: number } }
export interface DraftRow { projectId: string; specId: string; state: RefineStatus; registered: boolean }
export const refineApi = {
  list: () => Promise<DraftRow[]>,                                            // GET /api/refine
  newProject: (projectId, name) => Promise<{ sessionId }>,                    // POST /api/projects/new
  newSpec: (projectId, specId) => Promise<{ sessionId }>,                     // POST /api/projects/:p/specs
  continueSpec: (projectId, specId, report?) => Promise<{ sessionId }>,       // POST .../continue
  snapshot: (projectId, specId) => Promise<Snapshot>,
  saveDoc: (projectId, specId, file, text) => Promise<void>,
  evaluate, answer, skip, accept, reject, secret (→ { present, hint }), start (→ { runId }),
  events: (projectId, specId) => string,                                      // SSE URL
};
```
- Produces (`web/src/refine/reducer.ts`): `applyRefineEvent` and `reduceRefineEvents` re-exported from `@server/refine/state` (the Vite alias block A set up for `run-state`; `state.ts` imports only types and `events.ts`, so it is browser-safe) plus `applyToSnapshot(snap: Snapshot, e: StoredEvent): Snapshot` — clones `snap.state`, applies the event, and for `DOC_EDITED` with `source: 'patch'` marks `docsDirty = true` so the page refetches the snapshot (the journal carries a hash, not the text).
- Produces (`Refinement.tsx`): `RefinementView(props)` pure component and `RefinementPage` route component. Props: `{ snap: Snapshot; busy: boolean; onSaveDoc(file, text); onEvaluate(); onAnswer(id, text); onSkip(id); onAccept(id); onReject(id, reason); onSecret(name, value); onStart() }`.

Page layout (spec §6): left column — tabs `project.md` / `brief.md`, one `<textarea data-testid="doc-<file>">` each, saved on blur; button `data-testid="evaluate"` labelled "Evaluate" when `cycle === 0` else "Re-evaluate", disabled while `status === 'evaluating'`; notice `data-testid="stale"` "Checklist out of date — re-evaluate" when `stale`; error box when `status === 'error'`. Centre — current question (first pending; blocking first) with role badge, "blocking" tag, related AC ids, `<textarea data-testid="answer">`, buttons `answer-<id>` and `skip-<id>` (hidden when blocking); pending patches as `<pre>` diff with `accept-<id>` / `reject-<id>` (reject asks for an optional reason via a small input `reject-reason-<id>`); history list; discarded warnings. Right — checklist grouped PO/SM (`✓`/`✗` + detail), derived `spec.json` and `project.json` in `<pre>`, derived tasks list, secrets rows with `<input type="password" data-testid="secret-<NAME>">` + "Save", tokens line, `<button data-testid="start">` enabled only when `status === 'ready' && !stale`.

`RefinementPage`: reads params, fetches `snapshot` once, opens `useJournal(refineApi.events(...))`, applies every event with seq greater than the last applied; when an event is `DOC_EDITED { source: 'patch' }` or `REFINE_EVALUATED` it refetches the snapshot (docs and secrets are not in the journal). Every action calls the API then relies on SSE for state; errors from the API show in a banner. `REFINE_STARTED_RUN` navigates to `/runs/<runId>`.

- [ ] **Step 1: Write the failing tests**

`web/src/refine/reducer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyToSnapshot } from './reducer.js';
import type { Snapshot } from '../api.js';

const snap: Snapshot = { projectId: 'p', specId: 's', docs: { 'project.md': '', 'brief.md': '' }, secrets: [], tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 }, state: { status: 'drafting', stale: false, cycle: 0, derived: null, checklist: [], questions: [], patches: [], discarded: [], error: null, runId: null } };
const ev = (seq: number, type: string, data: Record<string, unknown>) => ({ seq, at: '', runId: 'p/s', specHash: 'draft', type, kind: 'fact' as const, data });

describe('applyToSnapshot', () => {
  it('reduces journal events into the state and flags a patch edit for refetch', () => {
    const s1 = applyToSnapshot(snap, ev(1, 'REFINE_CYCLE_STARTED', { cycle: 1, draftHash: 'h' }));
    expect(s1.state.status).toBe('evaluating');
    expect(snap.state.status).toBe('drafting');
    const s2 = applyToSnapshot(s1, ev(2, 'DOC_EDITED', { file: 'brief.md', hash: 'x', source: 'patch' }));
    expect(s2.docsDirty).toBe(true);
  });
});
```

`web/src/pages/Refinement.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { Snapshot } from '../api.js';
import { RefinementView } from './Refinement.js';

const green = (ids: string[]) => ids.map((id) => ({ id, role: id.startsWith('po') ? 'po' as const : 'sm' as const, passed: true, detail: 'ok' }));
const ALL = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions', 'sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'];
const base = (over: Partial<Snapshot['state']>): Snapshot => ({
  projectId: 'hello-app', specId: 'hello-001', docs: { 'project.md': '# Hello', 'brief.md': '## Objectives' }, secrets: [{ name: 'DB_URL', present: false, hint: null }], tokens: { inputTokens: 10, outputTokens: 5, costUsd: 0.02, steps: 3 },
  state: { status: 'answering', stale: false, cycle: 1, derived: { spec: { acceptanceCriteria: [], externalDependencies: [{ name: 'db', secretNames: ['DB_URL'] }] }, project: {} }, checklist: green(ALL), questions: [
    { questionId: 'po-c1-0', role: 'po', text: 'Port?', blocking: true, relatedAcIds: ['AC-001'], cycle: 1, status: 'pending', answer: null },
    { questionId: 'sm-c1-0', role: 'sm', text: 'DB?', blocking: false, relatedAcIds: [], cycle: 1, status: 'pending', answer: null },
  ], patches: [{ patchId: 'sm-c1-0', role: 'sm', file: 'brief.md', find: 'a', replace: 'b', reason: 'clearer', diff: '--- brief.md\n-a\n+b\n', cycle: 1, status: 'pending', decision: null }], discarded: [{ cycle: 1, role: 'po', file: 'docs/project.md', reason: 'find not found in project.md' }], error: null, runId: null, ...over },
});
const on = () => ({ onSaveDoc: vi.fn(), onEvaluate: vi.fn(), onAnswer: vi.fn(), onSkip: vi.fn(), onAccept: vi.fn(), onReject: vi.fn(), onSecret: vi.fn(), onStart: vi.fn() });

describe('RefinementView', () => {
  it('shows the blocking question first without a skip button, patches with accept/reject, and disables Start while answering', () => {
    const h = on();
    render(<MemoryRouter><RefinementView snap={base({})} busy={false} {...h} /></MemoryRouter>);
    expect(screen.getByText('Port?')).toBeTruthy();
    expect(screen.queryByTestId('skip-po-c1-0')).toBeNull();
    fireEvent.change(screen.getByTestId('answer'), { target: { value: '8080' } });
    fireEvent.click(screen.getByTestId('answer-po-c1-0'));
    expect(h.onAnswer).toHaveBeenCalledWith('po-c1-0', '8080');
    fireEvent.click(screen.getByTestId('accept-sm-c1-0'));
    expect(h.onAccept).toHaveBeenCalledWith('sm-c1-0');
    expect(screen.getByText(/find not found in project.md/)).toBeTruthy();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Re-evaluate')).toBeTruthy();
  });
  it('saves a doc on blur, enables Start only when ready and not stale, and shows secrets rows', () => {
    const h = on();
    const { rerender } = render(<MemoryRouter><RefinementView snap={base({ status: 'ready', questions: [], patches: [] })} busy={false} {...h} /></MemoryRouter>);
    fireEvent.change(screen.getByTestId('doc-brief.md'), { target: { value: '## Objectives\n- ship' } });
    fireEvent.blur(screen.getByTestId('doc-brief.md'));
    expect(h.onSaveDoc).toHaveBeenCalledWith('brief.md', '## Objectives\n- ship');
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByTestId('secret-DB_URL'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('save-secret-DB_URL'));
    expect(h.onSecret).toHaveBeenCalledWith('DB_URL', 'x');
    rerender(<MemoryRouter><RefinementView snap={base({ status: 'ready', stale: true, questions: [], patches: [] })} busy={false} {...h} /></MemoryRouter>);
    expect(screen.getByTestId('stale')).toBeTruthy();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });
  it('locks the editor and the evaluate button while evaluating and shows a cycle error', () => {
    render(<MemoryRouter><RefinementView snap={base({ status: 'evaluating', questions: [], patches: [] })} busy={true} {...on()} /></MemoryRouter>);
    expect((screen.getByTestId('doc-project.md') as HTMLTextAreaElement).readOnly).toBe(true);
    expect((screen.getByTestId('evaluate') as HTMLButtonElement).disabled).toBe(true);
    render(<MemoryRouter><RefinementView snap={base({ status: 'error', error: 'derive: spec.objectives: too small', questions: [], patches: [] })} busy={false} {...on()} /></MemoryRouter>);
    expect(screen.getByText(/spec.objectives: too small/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:web`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `web/src/api.ts` additions**

Append the types from Interfaces and:

```ts
const R = '/api';
const send = (method: string, p: string, body?: unknown) => fetch(`${R}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
export const refineApi = {
  list: () => fetch(`${R}/refine`).then((r) => json<DraftRow[]>(r)),
  newProject: (projectId: string, name: string) => send('POST', '/projects/new', { projectId, name }).then((r) => json<{ sessionId: string }>(r)),
  newSpec: (projectId: string, specId: string) => send('POST', `/projects/${projectId}/specs`, { specId }).then((r) => json<{ sessionId: string }>(r)),
  continueSpec: (projectId: string, specId: string, report?: string) => send('POST', `/projects/${projectId}/specs/${specId}/continue`, { report }).then((r) => json<{ sessionId: string }>(r)),
  snapshot: (p: string, s: string) => fetch(`${R}/refine/${p}/${s}`).then((r) => json<Snapshot>(r)),
  saveDoc: (p: string, s: string, file: 'project.md' | 'brief.md', text: string) => send('PUT', `/refine/${p}/${s}/docs/${file}`, { text }).then((r) => json<{ ok: true }>(r)),
  evaluate: (p: string, s: string) => send('POST', `/refine/${p}/${s}/evaluate`).then((r) => json<{ state: string }>(r)),
  answer: (p: string, s: string, questionId: string, text: string) => send('POST', `/refine/${p}/${s}/answers`, { questionId, text }).then((r) => json<{ ok: true }>(r)),
  skip: (p: string, s: string, questionId: string) => send('POST', `/refine/${p}/${s}/questions/${questionId}/skip`).then((r) => json<{ ok: true }>(r)),
  accept: (p: string, s: string, patchId: string) => send('POST', `/refine/${p}/${s}/patches/${patchId}/accept`).then((r) => json<{ ok: true }>(r)),
  reject: (p: string, s: string, patchId: string, reason: string | null) => send('POST', `/refine/${p}/${s}/patches/${patchId}/reject`, { reason: reason ?? undefined }).then((r) => json<{ ok: true }>(r)),
  secret: (p: string, s: string, name: string, value: string) => send('PUT', `/refine/${p}/${s}/secrets/${name}`, { value }).then((r) => json<{ present: boolean; hint: string }>(r)),
  start: (p: string, s: string) => send('POST', `/refine/${p}/${s}/start`).then((r) => json<{ runId: string }>(r)),
  events: (p: string, s: string) => `${R}/refine/${p}/${s}/events`,
};
```

- [ ] **Step 4: Implement `web/src/refine/reducer.ts`**

```ts
import { applyRefineEvent } from '@server/refine/state';
import type { Snapshot, StoredEvent } from '../api.js';

export type LiveSnapshot = Snapshot & { docsDirty?: boolean };

/** The journal carries state, not document text: a patch edit or an evaluation asks the page to refetch. */
export function applyToSnapshot(snap: LiveSnapshot, e: StoredEvent): LiveSnapshot {
  const state = structuredClone(snap.state);
  applyRefineEvent(state as never, e);
  const dirty = snap.docsDirty === true || (e.type === 'DOC_EDITED' && e.data.source === 'patch') || e.type === 'REFINE_EVALUATED';
  return { ...snap, state, docsDirty: dirty };
}
```

Confirm the `@server` alias in `web/vite.config.ts` (block A Task 7) resolves `server/refine/state.ts`; `state.ts` must import only `./events.js` and types (it does).

- [ ] **Step 5: Implement `web/src/pages/Refinement.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { refineApi, type ChecklistItem, type Snapshot } from '../api.js';
import { useJournal } from '../useSse.js';
import { applyToSnapshot, type LiveSnapshot } from '../refine/reducer.js';

type DocFile = 'project.md' | 'brief.md';
export interface ViewProps {
  snap: Snapshot; busy: boolean;
  onSaveDoc(file: DocFile, text: string): void; onEvaluate(): void; onAnswer(id: string, text: string): void; onSkip(id: string): void;
  onAccept(id: string): void; onReject(id: string, reason: string | null): void; onSecret(name: string, value: string): void; onStart(): void;
}

function Checklist({ items, role }: { items: ChecklistItem[]; role: 'po' | 'sm' }) {
  return (
    <ul className="checklist">
      {items.filter((i) => i.role === role).map((i) => (
        <li key={i.id} className={i.passed ? 'pass' : 'fail'} title={i.detail}>{i.passed ? '✓' : '✗'} {i.id.slice(3)} <small>{i.detail}</small></li>
      ))}
    </ul>
  );
}

export function RefinementView(p: ViewProps) {
  const { snap, busy } = p;
  const st = snap.state;
  const [tab, setTab] = useState<DocFile>('brief.md');
  const [docs, setDocs] = useState(snap.docs);
  const [answer, setAnswer] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  useEffect(() => setDocs(snap.docs), [snap.docs]);
  const locked = busy || st.status === 'evaluating' || st.status === 'started';
  const pending = [...st.questions.filter((q) => q.status === 'pending')].sort((a, b) => Number(b.blocking) - Number(a.blocking));
  const current = pending[0];
  const canStart = st.status === 'ready' && !st.stale && !busy;
  return (
    <div className="refine">
      <section className="docs">
        <div className="tabs">{(['project.md', 'brief.md'] as DocFile[]).map((f) => <button key={f} className={tab === f ? 'active' : ''} onClick={() => setTab(f)}>{f}</button>)}</div>
        <textarea data-testid={`doc-${tab}`} value={docs[tab]} readOnly={locked} onChange={(e) => setDocs({ ...docs, [tab]: e.target.value })} onBlur={() => { if (!locked && docs[tab] !== snap.docs[tab]) p.onSaveDoc(tab, docs[tab]); }} />
        {st.stale && <p data-testid="stale" className="notice">Checklist out of date — re-evaluate</p>}
        {st.status === 'error' && <p className="error">{st.error}</p>}
        <button data-testid="evaluate" disabled={locked} onClick={p.onEvaluate}>{st.cycle === 0 ? 'Evaluate' : 'Re-evaluate'}</button>
        {st.status === 'evaluating' && <span className="spinner">evaluating…</span>}
      </section>
      <section className="conversation">
        {current ? (
          <div className="question">
            <span className={`badge ${current.role}`}>{current.role.toUpperCase()}</span>
            {current.blocking && <span className="tag">blocking</span>}
            <p>{current.text}</p>
            {current.relatedAcIds.length > 0 && <small>{current.relatedAcIds.join(', ')}</small>}
            <textarea data-testid="answer" value={answer} onChange={(e) => setAnswer(e.target.value)} />
            <button data-testid={`answer-${current.questionId}`} disabled={locked || answer.trim() === ''} onClick={() => { p.onAnswer(current.questionId, answer); setAnswer(''); }}>Answer</button>
            {!current.blocking && <button data-testid={`skip-${current.questionId}`} disabled={locked} onClick={() => p.onSkip(current.questionId)}>Skip</button>}
            <small>{pending.length - 1} more pending</small>
          </div>
        ) : <p className="muted">No open question.</p>}
        {st.patches.filter((x) => x.status === 'pending').map((x) => (
          <div key={x.patchId} className="patch">
            <span className={`badge ${x.role}`}>{x.role.toUpperCase()}</span> <b>{x.file}</b> — {x.reason}
            <pre className="diff">{x.diff}</pre>
            <button data-testid={`accept-${x.patchId}`} disabled={locked} onClick={() => p.onAccept(x.patchId)}>Accept</button>
            <input data-testid={`reject-reason-${x.patchId}`} placeholder="reason (optional)" value={reasons[x.patchId] ?? ''} onChange={(e) => setReasons({ ...reasons, [x.patchId]: e.target.value })} />
            <button data-testid={`reject-${x.patchId}`} disabled={locked} onClick={() => p.onReject(x.patchId, reasons[x.patchId] || null)}>Reject</button>
          </div>
        ))}
        {st.discarded.map((d, i) => <p key={i} className="warning">Discarded {d.role} patch on {d.file}: {d.reason}</p>)}
        <h4>History</h4>
        <ul className="history">
          {[...st.questions].filter((q) => q.status !== 'pending').reverse().map((q) => <li key={q.questionId}><span className={`badge ${q.role}`}>{q.role}</span> {q.text} → {q.status === 'skipped' ? <i>skipped</i> : q.answer}</li>)}
          {[...st.patches].filter((x) => x.status !== 'pending').reverse().map((x) => <li key={x.patchId}>patch {x.file} ({x.reason}) → {x.status}{x.decision ? `: ${x.decision}` : ''}</li>)}
        </ul>
      </section>
      <section className="panels">
        <h4>Checklist</h4><h5>PO</h5><Checklist items={st.checklist} role="po" /><h5>SM</h5><Checklist items={st.checklist} role="sm" />
        <h4>Derived</h4>
        <details><summary>spec.json</summary><pre>{JSON.stringify(st.derived?.spec ?? null, null, 2)}</pre></details>
        <details><summary>project.json</summary><pre>{JSON.stringify(st.derived?.project ?? null, null, 2)}</pre></details>
        <h5>Tasks</h5><ul>{(st.derived?.spec.tasks ?? []).map((t, i) => <li key={i}><b>{t.title}</b>: {t.description}</li>)}</ul>
        <h4>Secrets</h4>
        <ul>{snap.secrets.map((s) => (
          <li key={s.name}>{s.present ? '●' : '○'} {s.name} {s.hint && <code>…{s.hint}</code>}
            <input type="password" data-testid={`secret-${s.name}`} value={secretValues[s.name] ?? ''} onChange={(e) => setSecretValues({ ...secretValues, [s.name]: e.target.value })} />
            <button data-testid={`save-secret-${s.name}`} disabled={locked || !(secretValues[s.name] ?? '')} onClick={() => { p.onSecret(s.name, secretValues[s.name]!); setSecretValues({ ...secretValues, [s.name]: '' }); }}>Save</button>
          </li>
        ))}</ul>
        <p className="tokens">{snap.tokens.steps} steps · {snap.tokens.inputTokens + snap.tokens.outputTokens} tokens · ${snap.tokens.costUsd.toFixed(2)}</p>
        <button data-testid="start" className="primary" disabled={!canStart} onClick={p.onStart}>Start</button>
      </section>
    </div>
  );
}

export function RefinementPage() {
  const { projectId = '', specId = '' } = useParams();
  const navigate = useNavigate();
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const applied = useRef(0);
  const { events } = useJournal(snap ? refineApi.events(projectId, specId) : null);
  const load = () => refineApi.snapshot(projectId, specId).then((s) => { setSnap({ ...s, docsDirty: false }); }).catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, [projectId, specId]);
  useEffect(() => {
    if (!snap) return;
    let next: LiveSnapshot = snap;
    for (const e of events) { if (e.seq <= applied.current) continue; applied.current = e.seq; next = applyToSnapshot(next, e); if (e.type === 'REFINE_STARTED_RUN') navigate(`/runs/${String(e.data.runId)}`); }
    if (next !== snap) { if (next.docsDirty) void load(); else setSnap(next); }
  }, [events]);
  if (!snap) return <main><p>{error ?? 'loading…'}</p></main>;
  const act = (f: () => Promise<unknown>) => () => { setError(null); f().catch((e: Error) => setError(e.message)); };
  return (
    <main>
      <header><a href="/projects">Projects</a> › {projectId} / {specId} <span className={`status ${snap.state.status}`}>{snap.state.status}</span></header>
      {error && <p className="error">{error}</p>}
      <RefinementView snap={snap} busy={snap.state.status === 'evaluating'}
        onSaveDoc={(f, t) => act(() => refineApi.saveDoc(projectId, specId, f, t))()}
        onEvaluate={act(() => refineApi.evaluate(projectId, specId))}
        onAnswer={(id, t) => act(() => refineApi.answer(projectId, specId, id, t))()}
        onSkip={(id) => act(() => refineApi.skip(projectId, specId, id))()}
        onAccept={(id) => act(() => refineApi.accept(projectId, specId, id))()}
        onReject={(id, r) => act(() => refineApi.reject(projectId, specId, id, r))()}
        onSecret={(n, v) => act(() => refineApi.secret(projectId, specId, n, v).then(load))()}
        onStart={act(() => refineApi.start(projectId, specId).then(({ runId }) => navigate(`/runs/${runId}`)))} />
    </main>
  );
}
```

Add `<Route path="/refine/:projectId/:specId" element={<RefinementPage />} />` to `web/src/App.tsx`; add to `styles.css`: `.refine { display: grid; grid-template-columns: 1fr 1fr 22rem; gap: 1rem }`, `.refine textarea { width: 100%; min-height: 60vh; font-family: monospace }`, `.diff { background: #f6f8fa; font-size: .85rem; overflow: auto }`, `.checklist .pass { color: #1a7f37 } .checklist .fail { color: #cf222e }`, `.badge.po { background: #ddf4ff } .badge.sm { background: #fff8c5 }`, `.notice { color: #9a6700 }`.

- [ ] **Step 6: Run web tests and commit**

Run: `npm run test:web`
Expected: PASS.

```bash
git add web/src/api.ts web/src/refine web/src/pages/Refinement.tsx web/src/pages/Refinement.test.tsx web/src/App.tsx web/src/styles.css
git commit -m "feat(web): refinement screen with live journal, questions, patches, checklist and secrets"
```

---

### Task 11: Projects screen entry points, navigation, docs and live check

**Files:**
- Modify: `web/src/pages/Projects.tsx`, `web/src/pages/Projects.test.tsx` (add cases), `web/src/App.tsx` (`/` redirect rule)
- Modify: `docs/superpowers/plans/README.md` (plan 11 row), this plan's `**Status**` line

**Interfaces:**
- Consumes: `refineApi.list/newProject/newSpec/continueSpec` (Task 10); `ProjectsView` props from block A Task 7.
- Produces: `ProjectsView` props gain `drafts: DraftRow[]`, `onNewProject(projectId, name)`, `onNewSpec(projectId, specId)`, `onContinue(projectId, specId)`. Rendering: a "New project" form (`data-testid="new-project"` with inputs `new-project-id`, `new-project-name`); per project a "New spec" input + button (`new-spec-<projectId>`); per spec row "Continue spec" (`continue-<specId>`) when `status` ∈ `awaiting-validation` | `done`; an "Open refinement" link (`refine-<projectId>-<specId>`, href `/refine/<p>/<s>`) for every draft whose state is not `started`, listed under its project or under a "Drafts (unregistered)" block when `registered === false`.
- Produces: `Projects` page polls `refineApi.list()` together with the existing 5 s poll; `onNewProject`/`onNewSpec`/`onContinue` call the API and navigate to `/refine/<sessionId>`.
- Produces: `/` redirects to `/projects` when `api.projects()` returns at least one project or `refineApi.list()` at least one draft, else `/onboarding` (extend block A Task 10's redirect component).

- [ ] **Step 1: Write the failing tests**

Append to `web/src/pages/Projects.test.tsx` (inside its `describe`, reusing `projects`/`runs` fixtures):

```tsx
  it('offers new project, new spec, continue spec and open refinement', () => {
    const on = { start: vi.fn(), resume: vi.fn(), stop: vi.fn(), add: vi.fn(), newProject: vi.fn(), newSpec: vi.fn(), cont: vi.fn() };
    const drafts = [
      { projectId: 'hello-app', specId: 'hello-003', state: 'answering', registered: true },
      { projectId: 'fresh', specId: 'fresh-001', state: 'drafting', registered: false },
      { projectId: 'hello-app', specId: 'hello-004', state: 'started', registered: true },
    ];
    render(
      <MemoryRouter>
        <ProjectsView projects={projects} runs={runs} drafts={drafts} error={null} onStart={on.start} onResume={on.resume} onStop={on.stop} onAdd={on.add} onNewProject={on.newProject} onNewSpec={on.newSpec} onContinue={on.cont} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByTestId('new-project-id'), { target: { value: 'shop' } });
    fireEvent.change(screen.getByTestId('new-project-name'), { target: { value: 'Shop' } });
    fireEvent.click(screen.getByTestId('new-project'));
    expect(on.newProject).toHaveBeenCalledWith('shop', 'Shop');
    fireEvent.change(screen.getByTestId('new-spec-id-hello-app'), { target: { value: 'hello-005' } });
    fireEvent.click(screen.getByTestId('new-spec-hello-app'));
    expect(on.newSpec).toHaveBeenCalledWith('hello-app', 'hello-005');
    fireEvent.click(screen.getByTestId('continue-hello-000'));
    expect(on.cont).toHaveBeenCalledWith('hello-app', 'hello-000');
    expect(screen.queryByTestId('continue-hello-001')).toBeNull();
    expect(screen.getByTestId('refine-hello-app-hello-003').getAttribute('href')).toBe('/refine/hello-app/hello-003');
    expect(screen.getByTestId('refine-fresh-fresh-001').getAttribute('href')).toBe('/refine/fresh/fresh-001');
    expect(screen.queryByTestId('refine-hello-app-hello-004')).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:web`
Expected: FAIL — unknown test ids / props.

- [ ] **Step 3: Implement**

In `Projects.tsx`: extend the props; render the "New project" form at the top; inside each project card, after the specs table, a row `<input data-testid="new-spec-id-<projectId>"> <button data-testid="new-spec-<projectId>">New spec</button>`; in the spec row actions add `<button data-testid="continue-<specId>">Continue spec</button>` when `spec.status === 'awaiting-validation' || spec.status === 'done'`; after the runs table list `drafts.filter(d => d.projectId === projectId && d.state !== 'started')` as `<a data-testid="refine-<p>-<s>" href="/refine/<p>/<s>">Open refinement (<state>)</a>` (use `Link` from react-router); at the bottom a "Drafts (unregistered)" block for `drafts.filter(d => !d.registered && d.state !== 'started')` with the same links. In `Projects` (the route component) add `refineApi.list()` to the poll and the three handlers:

```ts
const go = (p: Promise<{ sessionId: string }>) => p.then(({ sessionId }) => navigate(`/refine/${sessionId}`)).catch((e: Error) => setError(e.message));
onNewProject={(id, name) => go(refineApi.newProject(id, name))} onNewSpec={(p, s) => go(refineApi.newSpec(p, s))} onContinue={(p, s) => go(refineApi.continueSpec(p, s))}
```

`App.tsx`: the `/` element becomes a small `Home` component that fetches `api.projects()` and `refineApi.list()` and navigates to `/projects` when either is non-empty, else `/onboarding` (block A Task 10 may already have a `Home`; extend it).

- [ ] **Step 4: Run web tests and commit**

Run: `npm run test:web && cd web && npx tsc --noEmit -p . && cd ..`
Expected: PASS.

```bash
git add web/src/pages/Projects.tsx web/src/pages/Projects.test.tsx web/src/App.tsx
git commit -m "feat(web): new project, new spec, continue spec and open refinement from the Projects screen"
```

- [ ] **Step 5: Live check (WSL), then docs**

1. `npm run web:build && npm run ui` in WSL with `claude`, `gh`, Docker green on `/status`.
2. Projects → New project `hello-live` / "Hello Live". Paste the hello-app `project.json` contents as Markdown sections into `project.md` and the spec's objectives/ACs into `brief.md` (one AC with `(smoke)`; one external dependency with secret `DEMO_TOKEN`). Evaluate.
3. Expect: derived JSON appears; PO/SM questions listed blocking-first; at least one patch. Answer three questions, accept one patch, reject one with a reason, enter `DEMO_TOKEN`, Re-evaluate until Start enables. Note token cost.
4. Start. Expect: redirect to `/runs/hello-live-001-r1`; the Execution page shows Phase 0 events (`REPO_CREATE` confirm, `REPO_BOOTSTRAPPED`) then `PHASE_STARTED {1}`; `gh repo view <owner>/hello-live` shows the private repo with `docs/` on `main`; `config.json.projects` contains the draft root.
5. Stop the run from the Execution page (the live check is about Gate 1 and Phase 0, not a full run). Delete the GitHub repo afterwards (`gh repo delete <owner>/hello-live --yes`).
6. Record what was observed under a `## Findings` heading at the end of this plan (URL/prompt wording of the derive step, patch quality, time per cycle, anything the spec's §10 open items resolve to), set this plan's status line to "Implemented and merged to main, live-tested", and update `docs/superpowers/plans/README.md`: add the row `| 11 | 2026-09-24-teams-ai-11-refinement-ui.md | <status> |` and remove block B from the "designed and not yet planned" sentence.

```bash
git add docs/superpowers/plans/2026-09-24-teams-ai-11-refinement-ui.md docs/superpowers/plans/README.md
git commit -m "docs: plan 11 findings from the live refinement check; plans index"
```

---

## Self-review notes

- Spec §3.1 entry points → Task 2 (`createNewProject`, `createFromRepo` modes) and Task 7 (`newProject`/`newSpec`/`continueSpec`); §3.2 cycle → Task 6; §3.3 questions → Tasks 5–6; §3.4 patches → Tasks 3, 6; §3.5 secrets → Tasks 6–7; §3.6 Start → Task 9; §4 Phase 0 → Task 8; §5 API → Tasks 7, 9; §6 UI → Tasks 10–11; §7 security → Global Constraints (validated slugs in `registry.ts`, `refine-routes.ts` accepts no paths); §8 errors → Task 6 (`interrupted`), Task 7 (error mapping), Task 8 (`PHASE_FAILED {0}` through `commitAndMergeDocs`); §9 tests → one file per line of the spec's list, with `web/src/refine/reducer.test.ts` added.
- Deviations from the spec text, all applied to the spec file in the same commit as this plan: secrets are one file per name under `~/.teams-ai/secrets/` (the existing store), drafts are listed by `GET /api/refine` instead of extra fields on `GET /api/projects`, and the run is started with `--project <draftRoot> --spec <id> --draft` because the draft root already satisfies block A's project-directory contract.
- The refine journal's `specHash` field is the literal `draft` and every agent step echoes the cycle's `draftHash`, so `runStep`'s hash check still guards against a stale answer.
- `Run.executePhase0()` is public so Phase 0 tests do not have to script Phases 1–3.
