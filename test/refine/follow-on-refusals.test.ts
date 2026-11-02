import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeDocsMarker, writeState } from '../../server/docs/project-state.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { draftPaths } from '../../server/refine/draft.js';
import { ConflictError } from '../../server/refine/session.js';
import { makeProject } from '../fixtures/contracts.js';
import { cloneStore, publish } from '../fixtures/docs-store-clone.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';
import { makeRig, PROJECT, type Rig } from '../fixtures/docs-repo-rig.js';

const BOUND = '0123456789abcdef0123456789abcdef01234567';
const PROJECT_JSON = `${JSON.stringify(makeProject(), null, 2)}\n`;

let rig: Rig;
let remote: Remote | null = null;

beforeEach(async () => {
  rig = await makeRig({ exec: execCommand });
  await fs.mkdir(path.join(rig.ws.repo, '.git'), { recursive: true });
  await writeDocsMarker(rig.ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: PROJECT }, firstSha: BOUND });
});
afterEach(async () => {
  await remote?.cleanup();
  remote = null;
  await rig.close();
});

describe('a follow-on draft of a bound documentation repository', () => {
  it('is refused with a conflict when the mirror has no project.json, and writes no draft', async () => {
    await expect(rig.registry.newSpec(PROJECT, 'hello-app-002')).rejects.toBeInstanceOf(ConflictError);
    await expect(rig.registry.newSpec(PROJECT, 'hello-app-002')).rejects.toThrow(/project\.json/);
    await expect(fs.access(draftPaths(rig.ws, 'hello-app-002').root)).rejects.toThrow();
    await expect(rig.registry.continueSpec(PROJECT, 'hello-app-001')).rejects.toThrow(/project\.json/);
  });

  it('refuses an alias that the store already holds, in plain words, and writes nothing', async () => {
    remote = await makeRemote({ 'README.md': '# readme\n' });
    await fs.mkdir(rig.ws.root, { recursive: true });
    const store = await cloneStore(rig.ws, remote);
    await publish(store, { draftId: 'hello-app-001', stepKey: 'close', scope: 'refine', label: 'documents', files: { 'docs/specify/hello-app-001/spec.md': '# Spec\n' } });
    await writeState(rig.ws, 'project.json', PROJECT_JSON);
    const head = await git(store.dir, ['rev-parse', 'HEAD']);
    const refusal = rig.registry.newSpec(PROJECT, 'hello-app-001');
    await expect(refusal).rejects.toBeInstanceOf(ConflictError);
    await expect(refusal).rejects.toThrow('o alias hello-app-001 já existe no repositório de documentos');
    await expect(fs.access(draftPaths(rig.ws, 'hello-app-001').root)).rejects.toThrow();
    expect(await git(store.dir, ['rev-parse', 'HEAD'])).toBe(head);
  });

  it('is created when the mirror holds the project and the store has no such alias', async () => {
    remote = await makeRemote({ 'README.md': '# readme\n' });
    await fs.mkdir(rig.ws.root, { recursive: true });
    const store = await cloneStore(rig.ws, remote);
    await publish(store, { draftId: 'hello-app-001', stepKey: 'close', scope: 'refine', label: 'documents', files: { 'docs/project.md': '# Projeto\n' } });
    await writeState(rig.ws, 'project.json', PROJECT_JSON);
    const session = await rig.registry.newSpec(PROJECT, 'hello-app-002', 'Listar usuários');
    expect(session.state.mode).toBe('new-spec');
    expect(await fs.readFile(path.join(rig.ws.root, 'refine', 'hello-app-002', 'docs', 'project.md'), 'utf8')).toBe('# Projeto\n');
  });
});
