import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeDocsMarker, writeState } from '../../server/docs/project-state.js';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';
import { cloneStore, publish } from '../fixtures/docs-store-clone.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';
import { makeRig, PROJECT, type Rig } from '../fixtures/docs-repo-rig.js';

const SPEC = 'hello-app-001';
let rig: Rig;
let remote: Remote;

beforeEach(async () => {
  rig = await makeRig({ exec: execCommand });
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

describe('restarting a spec of a documentation repository', () => {
  it('keeps the alias folder the spec committed', async () => {
    await rig.registry.continueSpec(PROJECT, SPEC);
    await rig.registry.restartSpec(PROJECT, SPEC);
    const store = path.join(rig.ws.root, 'docs-store');
    expect(await fs.readFile(path.join(store, 'docs', 'specify', SPEC, 'spec.md'), 'utf8')).toBe('# Spec\n');
    expect(await git(store, ['show', 'HEAD:docs/project.md'])).toBe('# Projeto');
  });
});
