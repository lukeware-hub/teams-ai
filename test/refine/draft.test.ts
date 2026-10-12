import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { briefTemplate, createFromRepo, createNewProject, DOC_REL, draftExists, draftHash, draftPaths, keepBaseProject, moveBriefingToProject, readBase, readDerived, readDoc, renderBriefMd, syncWithMain, writeDerived, writeDoc } from '../../server/refine/draft.js';
import { git } from '../../server/git/git.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

let root = '';
let ws: Workspace;
let remote: Remote | null = null;

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-draft-'))).replace(/\\/g, '/');
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/worktrees`, graph: `${root}/graph`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
});
afterEach(async () => {
  await remote?.cleanup();
  remote = null;
  await fs.rm(root, { recursive: true, force: true });
});

describe('draft', () => {
  it('keeps the base project.json bytes when the project is unchanged, so the start does not publish a reformatted copy', async () => {
    const compact = JSON.stringify(makeProject());
    remote = await makeRemote({ 'docs/project.json': compact });
    const d = draftPaths(ws, 'hello-022');
    await createFromRepo(d, remote.repo, execCommand, { kind: 'new-spec' });
    await writeDerived(d, { project: await keepBaseProject(d, makeProject({ name: 'Other' })), spec: makeSpec({ specId: 'hello-022' }) });
    expect(await fs.readFile(d.projectJson, 'utf8')).toBe(compact);
  });

  it('takes the derived project.json when only stack.md changed, since the platform lives there', async () => {
    const compact = JSON.stringify(makeProject());
    remote = await makeRemote({ 'docs/project.json': compact, 'docs/stack.md': '# Stack\n' });
    const d = draftPaths(ws, 'hello-023');
    await createFromRepo(d, remote.repo, execCommand, { kind: 'new-spec' });
    const derived = makeProject({ services: ['orders'], platform: [{ name: 'nats', image: 'nats:2.10.22-alpine' }] });
    expect((await keepBaseProject(d, derived)).platform).toBeUndefined();
    await fs.writeFile(d.stackMd, '# Stack\n\nNATS 2.10 for every service.\n');
    expect((await keepBaseProject(d, derived)).platform).toEqual(derived.platform);
  });

  it('copies the docs of main byte for byte, final newline included, into the draft and its base copy', async () => {
    const json = `${JSON.stringify(makeProject(), null, 2)}\n`;
    remote = await makeRemote({ 'docs/project.json': json, 'docs/flow.md': '# Flow\n\n' });
    const d = draftPaths(ws, 'hello-024');
    await createFromRepo(d, remote.repo, execCommand, { kind: 'new-spec' });
    expect(await fs.readFile(d.projectJson, 'utf8')).toBe(json);
    expect(await readBase(d, 'project.json')).toBe(json);
    expect(await readBase(d, 'flow.md')).toBe('# Flow\n\n');
  });

  it('brings what main changed since the draft began into the draft, merged with its own edits, and moves the base copy to main', async () => {
    remote = await makeRemote({ 'docs/project.json': JSON.stringify(makeProject()), 'docs/project.md': '# P\n\nalpha\n\nbeta\n', 'docs/flow.md': '# Flow\n' });
    const d = draftPaths(ws, 'hello-030');
    await createFromRepo(d, remote.repo, execCommand, { kind: 'new-spec' });
    expect(await syncWithMain(d, remote.repo, execCommand)).toEqual([]);
    await writeDoc(d, 'project.md', '# P\n\nalpha\n\nBETA from draft\n');
    const pushToMain = async (files: Record<string, string>) => {
      for (const [rel, text] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(remote!.repo, rel)), { recursive: true });
        await fs.writeFile(path.join(remote!.repo, rel), text);
      }
      await git(remote!.repo, ['add', '-A'], execCommand);
      await git(remote!.repo, ['commit', '-q', '-m', 'another spec'], execCommand);
      await git(remote!.repo, ['push', '-q', 'origin', 'main'], execCommand);
    };
    await pushToMain({ 'docs/project.md': '# P\n\nALPHA from main\n\nbeta\n', 'docs/flow.md': '# Flow v2\n', 'docs/specs/other-001/spec.json': '{}\n' });
    // Only the project docs make the evaluation stale; a sibling spec main delivered just comes in.
    expect((await syncWithMain(d, remote.repo, execCommand)).map((c) => c.file).sort()).toEqual(['flow.md', 'project.md']);
    expect(await readDoc(d, 'project.md')).toBe('# P\n\nALPHA from main\n\nBETA from draft\n');
    expect(await readDoc(d, 'flow.md')).toBe('# Flow v2\n');
    expect(await readBase(d, 'project.md')).toBe('# P\n\nALPHA from main\n\nbeta\n');
    expect(await fs.readFile(`${d.docs}/specs/other-001/spec.json`, 'utf8')).toBe('{}\n');
    expect(await syncWithMain(d, remote.repo, execCommand)).toEqual([]);
  });

  it('a new project has no main to bring in', async () => {
    const d = draftPaths(ws, 'shop-001');
    await createNewProject(d, 'Shop');
    expect(await syncWithMain(d, `${root}/no-repo`, execCommand)).toEqual([]);
  });

  it('keeps the base copy in a hidden folder the agents do not search', () => {
    expect(draftPaths(ws, 'hello-023').base).toBe(`${root}/refine/hello-023/.base/docs`);
  });

  it('an existing project keeps its project.json until project.md changes', async () => {
    const original = makeProject({ name: 'Original' });
    remote = await makeRemote({ 'docs/project.json': JSON.stringify(original) });
    const d = draftPaths(ws, 'hello-021');
    await createFromRepo(d, remote.repo, execCommand, { kind: 'new-spec' });
    const rewritten = { ...original, name: 'Rewritten by the agent' };
    expect((await keepBaseProject(d, rewritten)).name).toBe('Original');
    await writeDoc(d, 'project.md', `${await readDoc(d, 'project.md')}
- New constraint
`);
    expect((await keepBaseProject(d, rewritten)).name).toBe('Rewritten by the agent');
    const fresh = draftPaths(ws, 'shop-021');
    await createNewProject(fresh, 'Shop');
    expect((await keepBaseProject(fresh, rewritten)).name).toBe('Rewritten by the agent');
  });

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

  it('puts the description the user wrote on top of the brief of a new spec, and keeps the template when there is none', async () => {
    remote = await makeRemote({ 'docs/project.json': JSON.stringify(makeProject()) });
    const withText = draftPaths(ws, 'hello-010');
    await createFromRepo(withText, remote.repo, execCommand, { kind: 'new-spec', description: '  Let users reset a password by e-mail.  ' });
    const brief = await readDoc(withText, 'brief.md');
    expect(brief.startsWith('## Description\n\nLet users reset a password by e-mail.\n\n## Type')).toBe(true);
    const blank = draftPaths(ws, 'hello-011');
    await createFromRepo(blank, remote.repo, execCommand, { kind: 'new-spec', description: '   ' });
    expect(await readDoc(blank, 'brief.md')).toBe(briefTemplate());
  });

  it('a new project brief starts with the description too', async () => {
    const d = draftPaths(ws, 'shop-001');
    await createNewProject(d, 'Shop', 'A small shop for handmade soap.');
    expect((await readDoc(d, 'brief.md')).startsWith('## Description\n\nA small shop for handmade soap.\n\n## Type')).toBe(true);
    const plain = draftPaths(ws, 'shop-002');
    await createNewProject(plain, 'Shop');
    expect(await readDoc(plain, 'brief.md')).toBe(briefTemplate());
  });

  it('renderBriefMd lists every acceptance criterion with its id', () => {
    const md = renderBriefMd(makeSpec({ acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w', then: 't', smoke: true }], externalDependencies: [{ name: 'db', purpose: 'p', secretNames: ['DB_URL'] }] }));
    expect(md).toContain('AC-001');
    expect(md).toContain('smoke');
    expect(md).toContain('DB_URL');
  });

  it('notes the System 1 routing under the validation report, and the human ask when unclear', () => {
    const md = renderBriefMd(makeSpec(), '/health answers 500', { route: 'bug-existing-ac', confidence: 0.9, source: 'jev' });
    expect(md).toContain('## Validation report\n\n/health answers 500\n\nRouting (System 1, jev): bug-existing-ac (0.90)');
    const unclear = renderBriefMd(makeSpec(), 'meh', { route: 'unclear', confidence: null, source: 'claude' });
    expect(unclear).toContain('Routing (System 1, claude): unclear');
    expect(unclear).toContain('PO: ask the human');
    expect(renderBriefMd(makeSpec(), 'x')).not.toContain('Routing');
    expect(renderBriefMd(makeSpec(), 'x', null)).not.toContain('Routing');
  });

  it('backlog mode moves the brief to the target project docs/briefing.md, and reads and writes follow it', async () => {
    const d = draftPaths(ws, 'hello-001');
    await createNewProject(d, 'Hello App', 'Ship a hello endpoint.');
    await fs.writeFile(d.specJson, '{}');
    const before = await readDoc(d, 'brief.md');
    const hash = await draftHash(d);
    await moveBriefingToProject(d);
    expect(await fs.readFile(`${d.docs}/briefing.md`, 'utf8')).toBe(before);
    await expect(fs.access(`${d.docs}/specs/hello-001`)).rejects.toThrow();
    expect(await readDoc(d, 'brief.md')).toBe(before);
    expect(await draftHash(d)).toBe(hash);
    expect(await draftExists(d)).toBe(true);
    await writeDoc(d, 'brief.md', '## Prioridades\n- P0 primeiro');
    expect(await fs.readFile(`${d.docs}/briefing.md`, 'utf8')).toBe('## Prioridades\n- P0 primeiro\n');
    await moveBriefingToProject(d);
    expect(await readDoc(d, 'brief.md')).toBe('## Prioridades\n- P0 primeiro\n');
  });

  it('keeps an existing docs/briefing.md and appends the new demand under its own heading, once, with its own headings demoted a level', async () => {
    const d = draftPaths(ws, 'hello-002');
    await createNewProject(d, 'Hello App', 'Add a goodbye endpoint.');
    await fs.writeFile(`${d.docs}/briefing.md`, '# Briefing\n\n## Prioridades\n\n- P0 primeiro\n');
    const brief = await readDoc(d, 'brief.md');
    await moveBriefingToProject(d);
    const once = await fs.readFile(`${d.docs}/briefing.md`, 'utf8');
    expect(once.startsWith('# Briefing\n\n## Prioridades\n\n- P0 primeiro\n\n## Nova demanda (hello-002)\n\n')).toBe(true);
    // The brief's own `##` sections (Description, Type, Objectives...) must not collide with the briefing's own `##`
    // level: appended a level down, so the briefing's structure (## Prioridades, ## Nova demanda) stays the only ## level.
    expect(once).not.toContain('\n## Description');
    expect(once).toContain('\n### Description\n\nAdd a goodbye endpoint.');
    expect(once).toContain('\n### Type\n\nfeature');
    expect(once).toContain('\n### Acceptance criteria\n\n- AC-001');
    // A crash after the append and before the cleanup: the next move finishes it without appending twice.
    await fs.mkdir(`${d.docs}/specs/hello-002`, { recursive: true });
    await fs.writeFile(d.briefMd, brief);
    await moveBriefingToProject(d);
    expect(await fs.readFile(`${d.docs}/briefing.md`, 'utf8')).toBe(once);
    await expect(fs.access(d.briefMd)).rejects.toThrow();
  });

  it('drops a bare template brief instead of appending it, and keeps other files of the spec directory', async () => {
    const d = draftPaths(ws, 'hello-003');
    await createNewProject(d, 'Hello App');
    await fs.writeFile(`${d.docs}/briefing.md`, '# Briefing\n');
    await fs.writeFile(d.specJson, '{}');
    await fs.writeFile(`${d.docs}/specs/hello-003/plan.json`, '{}');
    await moveBriefingToProject(d);
    expect(await fs.readFile(`${d.docs}/briefing.md`, 'utf8')).toBe('# Briefing\n');
    await expect(fs.access(d.briefMd)).rejects.toThrow();
    await expect(fs.access(d.specJson)).rejects.toThrow();
    expect(await fs.readFile(`${d.docs}/specs/hello-003/plan.json`, 'utf8')).toBe('{}');
  });

  it('a single-spec draft keeps its own brief even when the target project has a briefing', async () => {
    const d = draftPaths(ws, 'hello-004');
    await createNewProject(d, 'Hello App');
    await fs.writeFile(`${d.docs}/briefing.md`, '# Briefing\n');
    expect(await readDoc(d, 'brief.md')).toBe(briefTemplate());
    expect(DOC_REL['brief.md']('hello-004')).toBe('docs/specs/hello-004/brief.md');
    expect(DOC_REL['brief.md']('hello-004', true)).toBe('docs/briefing.md');
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
