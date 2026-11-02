import { afterEach, describe, expect, it } from 'vitest';
import { createNewProject } from '../../server/refine/draft.js';
import { RefineEvent } from '../../server/refine/events.js';
import { RefineSession } from '../../server/refine/session.js';
import { makeRig, type Rig } from '../fixtures/docs-repo-rig.js';
import { makeFakeRunAgent } from '../fixtures/fake-run-agent.js';

let rig: Rig | null = null;
afterEach(async () => {
  await rig?.close();
  rig = null;
});

/** The data of the Created event the journal holds for a session. */
const createdData = (s: RefineSession) => s.events.find((e) => e.type === RefineEvent.Created)?.data;

describe('docs-repo stamp of a new project', () => {
  it('gives no stamp when the flag is off, and keeps the repository flow as it was', async () => {
    rig = await makeRig({ docsRepoLayout: false });
    const s = await rig.registry.newProject('hello-app', 'Hello');
    expect(createdData(s)).not.toHaveProperty('docsRepo');
    expect(s.state.docsRepo).toBeUndefined();
    expect(s.state.repositories).toBe(true);
    await s.close();
  });

  it('gives the docsRepo stamp in the Created event when the flag is on', async () => {
    rig = await makeRig({ docsRepoLayout: true });
    const s = await rig.registry.newProject('hello-app', 'Hello');
    expect(createdData(s)).toMatchObject({ docsRepo: true, repositories: true });
    expect(s.state.docsRepo).toBe(true);
    await s.close();
  });

  it('a session created without the stamp is legacy when it is opened again', async () => {
    rig = await makeRig({ docsRepoLayout: false });
    await createNewProject(rig.draft, 'Hello');
    const deps = { ws: rig.ws, draft: rig.draft, runAgent: makeFakeRunAgent(rig.script), secretsDir: rig.home, retrieval: () => [] };
    const s = await RefineSession.create(deps, 'new-project', { repositories: true });
    await s.close();
    const again = await RefineSession.open(deps);
    expect(again.state.docsRepo).toBeUndefined();
    await again.close();
  });
});
