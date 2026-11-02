import { afterEach, describe, expect, it } from 'vitest';
import { readDocsMarker, writeDocsMarker } from '../../server/docs/project-state.js';
import { completeStages, makeRig, MICROSERVICES, MONOLITH, type Rig } from '../fixtures/docs-repo-rig.js';

let rig: Rig | null = null;
afterEach(async () => {
  await rig?.close();
  rig = null;
});

const PUBLISHED = { layout: 'docs-repo' as const, style: 'monolith' as const, target: { owner: 'acme', name: 'hello-app' }, firstSha: 'a'.repeat(40) };

describe('the style of a published repository is fixed', () => {
  it('a decision with another style journals ArchitectureFailed, names the repository, and keeps the marker', async () => {
    rig = await makeRig({ docsRepoLayout: true, owner: 'acme' });
    const s = await rig.registry.newProject('hello-app', 'Hello');
    await completeStages(rig, s);
    await writeDocsMarker(rig.ws, PUBLISHED);
    rig.script['architecture/sm'] = [MICROSERVICES];
    await s.decideArchitecture();
    await s.settled();
    expect(s.state.architecture ?? null).toBeNull();
    expect(s.state.architectureError).toContain('acme/hello-app');
    expect(s.state.architectureError).toContain('monolith');
    expect(await readDocsMarker(rig.ws)).toEqual(PUBLISHED);
    await s.close();
  });

  it('a decision with the published style is kept', async () => {
    rig = await makeRig({ docsRepoLayout: true, owner: 'acme' });
    const s = await rig.registry.newProject('hello-app', 'Hello');
    await completeStages(rig, s);
    await writeDocsMarker(rig.ws, PUBLISHED);
    rig.script['architecture/sm'] = [MONOLITH];
    await s.decideArchitecture();
    await s.settled();
    expect(s.state.architectureError ?? null).toBeNull();
    expect(s.state.architecture?.decision.style).toBe('monolith');
    await s.close();
  });
});
