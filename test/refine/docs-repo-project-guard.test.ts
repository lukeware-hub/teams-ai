import { afterEach, describe, expect, it } from 'vitest';
import { writeDocsMarker } from '../../server/docs/project-state.js';
import { ConflictError } from '../../server/refine/session.js';
import { makeRig, type Rig } from '../fixtures/docs-repo-rig.js';

let rig: Rig | null = null;
afterEach(async () => {
  await rig?.close();
  rig = null;
});

describe('a new project under the documentation repository layout', () => {
  it('refuses the name of the central repository with a plain message the request reports as 400', async () => {
    rig = await makeRig({ docsRepoLayout: true });
    await expect(rig.registry.newProject('artefacty', 'Central')).rejects.toThrow(RangeError);
    await expect(rig.registry.newProject('artefacty', 'Central')).rejects.toThrow('nome do repositório central');
  });

  it('keeps the name legacy projects always had when the flag is off', async () => {
    rig = await makeRig({ docsRepoLayout: false });
    const s = await rig.registry.newProject('artefacty', 'Central');
    expect(s.state.docsRepo).toBeUndefined();
    await s.close();
  });

  it('names the existing project in plain words and asks to register it instead', async () => {
    rig = await makeRig({ docsRepoLayout: true, owner: 'acme' });
    await writeDocsMarker(rig.ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: 'hello-app' }, firstSha: null });
    await expect(rig.registry.newProject('hello-app', 'Hello')).rejects.toThrow('O projeto hello-app já existe. Cadastre-o em vez de criar outro.');
  });

  it('refuses a project whose id already has a documentation repository marker', async () => {
    rig = await makeRig({ docsRepoLayout: true, owner: 'acme' });
    await writeDocsMarker(rig.ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: 'hello-app' }, firstSha: null });
    await expect(rig.registry.newProject('hello-app', 'Hello')).rejects.toThrow(ConflictError);
  });
});
