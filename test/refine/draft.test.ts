import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createFromRepo, createNewProject, draftHash, draftPaths, readDerived, readDoc, renderBriefMd, writeDoc } from '../../server/refine/draft.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

let root = '';
let ws: Workspace;
let remote: Remote | null = null;

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-draft-'))).replace(/\\/g, '/');
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/worktrees`, graph: `${root}/graph`, knowledgeDb: `${root}/k.sqlite`, runs: `${root}/runs` };
});
afterEach(async () => {
  await remote?.cleanup();
  remote = null;
  await fs.rm(root, { recursive: true, force: true });
});

describe('draft', () => {
  it('creates a new project from templates and includes design.md in the draft hash', async () => {
    const d = draftPaths(ws, 'hello-001');
    await createNewProject(d, 'Hello App');
    expect(d.root).toBe(`${root}/refine/hello-001`);
    expect(await readDoc(d, 'project.md')).toContain('# Hello App');
    expect(await readDoc(d, 'brief.md')).toContain('## Acceptance criteria');
    expect(await readDoc(d, 'design.md')).toContain('executable visual contract');
    expect(await readDerived(d)).toBeNull();
    const h1 = await draftHash(d);
    await writeDoc(d, 'brief.md', '## Objectives\n- ship');
    expect(await draftHash(d)).not.toBe(h1);
  });

  it('copies docs from origin/main, renders project.md when absent, and prefills brief.md on continue', async () => {
    const project = makeProject();
    const spec = { ...makeSpec({ specId: 'hello-001' }), status: 'awaiting-validation', specHash: `sha256:${'a'.repeat(64)}`, validationReports: [{ at: '2026-09-24T10:00:00.000Z', text: 'GET /hello returned 500' }] };
    remote = await makeRemote({ 'docs/project.json': JSON.stringify(project), 'docs/specs/hello-001/spec.json': JSON.stringify(spec), 'docs/adr/ADR-001-stack.md': '# ADR-001 stack' });
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
    const md = renderBriefMd(makeSpec({ acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w', then: 't', smoke: true }], externalDependencies: [{ name: 'db', purpose: 'p', secretNames: ['DB_URL'] }] }));
    expect(md).toContain('AC-001');
    expect(md).toContain('smoke');
    expect(md).toContain('DB_URL');
  });

  it('renders the work item type and bug details', () => {
    const md = renderBriefMd(makeSpec({
      type: 'bug',
      bug: { actual: '500', expected: '200', reproduction: 'GET /todos', evidence: 'log.txt' },
    }));
    expect(md).toContain('## Type');
    expect(md).toContain('bug');
    expect(md).toContain('## Bug details');
    expect(md).toContain('GET /todos');
    expect(md.indexOf('## Bug details')).toBeLessThan(md.indexOf('## Tasks'));
  });
});
