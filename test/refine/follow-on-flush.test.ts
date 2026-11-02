import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeDocsMarker, writeState } from '../../server/docs/project-state.js';
import type { Store } from '../../server/docs/store.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { writeDoc, draftPaths } from '../../server/refine/draft.js';
import { makeProject } from '../fixtures/contracts.js';
import { cloneStore, publish } from '../fixtures/docs-store-clone.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';
import { makeRig, PROJECT, type Rig } from '../fixtures/docs-repo-rig.js';

const BOUND = '0123456789abcdef0123456789abcdef01234567';
const FIVE: Record<string, string> = {
  'docs/project.md': '# Projeto\n\nv1.\n',
  'docs/flow.md': '# Fluxo\n',
  'docs/briefing.md': '# Briefing\n',
  'docs/design.md': '# Design\n',
  'docs/stack.md': '# Stack\n',
};

let rig: Rig;
let remote: Remote;
let store: Store;

beforeEach(async () => {
  rig = await makeRig({ exec: execCommand, ghExec: execCommand });
  await fs.mkdir(path.join(rig.ws.repo, '.git'), { recursive: true });
  await writeDocsMarker(rig.ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: PROJECT }, firstSha: BOUND });
  remote = await makeRemote({ 'README.md': '# readme\n' });
  await fs.mkdir(rig.ws.root, { recursive: true });
  store = await cloneStore(rig.ws, remote);
  await publish(store, { draftId: 'hello-app-001', stepKey: 'close', scope: 'refine', label: 'documents', files: FIVE });
  await writeState(rig.ws, 'project.json', `${JSON.stringify(makeProject(), null, 2)}\n`);
});
afterEach(async () => {
  await remote.cleanup();
  await rig.close();
});

describe('a follow-on draft of a bound documentation repository flushes to its store', () => {
  it('is a documentation session, and its closing publishes its own edit of project.md on origin main', async () => {
    const session = await rig.registry.newSpec(PROJECT, 'hello-app-002', 'Listar usuários');
    expect(session.state.docsRepo).toBe(true);
    await writeDoc(draftPaths(rig.ws, 'hello-app-002'), 'project.md', '# Projeto\n\nv2 do rascunho.\n');
    await session.closeDocs([]);
    expect(await git(remote.origin, ['show', 'main:docs/project.md'])).toBe('# Projeto\n\nv2 do rascunho.');
    expect(await git(remote.origin, ['log', '-1', '--format=%s', 'main'])).toBe('docs: refinement closed, development starts [skip ci]');
  });

  it('deleting it before a start takes its alias folder out of the store and keeps the five documents', async () => {
    await rig.registry.newSpec(PROJECT, 'hello-app-002', 'Listar usuários');
    await publish(store, { draftId: 'hello-app-002', stepKey: 'docs', scope: 'refine', label: 'alias', files: { 'docs/specify/hello-app-002/spec.md': '# Spec\n' } });
    await rig.registry.deleteDraft(PROJECT, 'hello-app-002');
    const files = await git(remote.origin, ['ls-tree', '-r', '--name-only', 'main']);
    expect(files).not.toContain('docs/specify/hello-app-002/spec.md');
    expect(files).toContain('docs/project.md');
    expect(await git(remote.origin, ['show', 'main:docs/project.md'])).toBe('# Projeto\n\nv1.');
  });
});
