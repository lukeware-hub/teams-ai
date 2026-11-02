import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeDocsMarker, writeState } from '../../server/docs/project-state.js';
import { openStore, type Store } from '../../server/docs/store.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { draftPaths } from '../../server/refine/draft.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';
import { cloneStore, publish } from '../fixtures/docs-store-clone.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';
import { makeRig, PROJECT, type Rig } from '../fixtures/docs-repo-rig.js';

const SPEC = 'hello-app-001';
let rig: Rig;
let remote: Remote;

beforeEach(async () => {
  rig = await makeRig({ exec: execCommand, ghExec: execCommand });
  await fs.mkdir(path.join(rig.ws.repo, '.git'), { recursive: true });
  await writeDocsMarker(rig.ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: PROJECT }, firstSha: '0123456789abcdef0123456789abcdef01234567' });
  remote = await makeRemote({ 'README.md': '# readme\n' });
  await fs.mkdir(rig.ws.root, { recursive: true });
  const store = await cloneStore(rig.ws, remote);
  await publish(store, { draftId: SPEC, stepKey: 'close', scope: 'refine', label: 'documents', files: { 'docs/project.md': '# Projeto\n', [`docs/specify/${SPEC}/spec.md`]: '# Spec\n' } });
  await writeState(rig.ws, 'project.json', `${JSON.stringify(makeProject(), null, 2)}\n`);
  await writeState(rig.ws, `specs/${SPEC}/spec.json`, JSON.stringify(makeSpec({ specId: SPEC, status: 'awaiting-validation', specHash: `sha256:${'a'.repeat(64)}` })));
});
afterEach(async () => {
  await remote.cleanup();
  await rig.close();
});

/** Publishes an alias folder of `draftId` from the local store, as a draft's flush does. */
async function flushAlias(draftId: string): Promise<Store> {
  const store = await openStore(rig.ws, 'monolith', execCommand);
  await publish(store, { draftId, stepKey: 'docs', scope: 'refine', label: 'alias', files: { [`docs/specify/${draftId}/spec.md`]: '# Spec\n' } });
  return store;
}

describe('discarding a draft of a bound documentation repository', () => {
  it('keeps the alias folder that main holds when the draft is a continuation of that spec', async () => {
    await rig.registry.continueSpec(PROJECT, SPEC);
    await rig.registry.deleteDraft(PROJECT, SPEC);
    expect(await git(remote.origin, ['show', `main:docs/specify/${SPEC}/spec.md`])).toBe('# Spec');
  });

  it('removes the alias folder that the draft created on main', async () => {
    const alias = 'hello-app-002';
    await rig.registry.newSpec(PROJECT, alias, 'Listar usuários');
    await flushAlias(alias);
    await rig.registry.deleteDraft(PROJECT, alias);
    expect(await git(remote.origin, ['ls-tree', '-r', '--name-only', 'main'])).not.toContain(`docs/specify/${alias}/spec.md`);
  });
});
