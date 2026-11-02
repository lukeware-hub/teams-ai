import { afterEach, describe, expect, it } from 'vitest';
import { completeStages, makeRig, MONOLITH, MICROSERVICES, PROJECT, type Rig } from '../fixtures/docs-repo-rig.js';
import type { Exec } from '../../server/exec/command.js';
import type { RefineSession } from '../../server/refine/session.js';

let rig: Rig | null = null;

/** GitHub is configured: the registry hands the session its exec, which the target needs. */
const configured: Exec = async () => ({ exitCode: 1, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1, truncated: false });

afterEach(async () => {
  await rig?.close();
  rig = null;
});

/** A new project whose five documents are graphed and whose architecture is decided in the given style. */
async function decided(r: Rig, style: typeof MONOLITH | typeof MICROSERVICES): Promise<RefineSession> {
  const s = await r.registry.newProject(PROJECT, 'Hello');
  await completeStages(r, s);
  r.script['architecture/sm'] = [style];
  await s.decideArchitecture();
  await s.settled();
  return s;
}

describe('the snapshot says whether the session is a documentation-repository session', () => {
  it('a docs-repo session has docsRepo true and the target of its monolith repository', async () => {
    rig = await makeRig({ docsRepoLayout: true, owner: 'acme', ghExec: configured });
    const s = await decided(rig, MONOLITH);
    const snap = await s.snapshot();
    expect(snap.docsRepo).toBe(true);
    expect(snap.docsTarget).toEqual({ owner: 'acme', name: PROJECT });
  });

  it('a microservices docs-repo session targets the central documentation repository', async () => {
    rig = await makeRig({ docsRepoLayout: true, owner: 'acme', ghExec: configured });
    const s = await decided(rig, MICROSERVICES);
    expect((await s.snapshot()).docsTarget).toEqual({ owner: 'acme', name: 'artefacty' });
  });

  it('a docs-repo session with no decided architecture has no target yet', async () => {
    rig = await makeRig({ docsRepoLayout: true, owner: 'acme', ghExec: configured });
    const s = await rig.registry.newProject(PROJECT, 'Hello');
    const snap = await s.snapshot();
    expect(snap.docsRepo).toBe(true);
    expect(snap.docsTarget).toBeUndefined();
  });

  it('a legacy session has no docsRepo key and no target', async () => {
    rig = await makeRig({ docsRepoLayout: false, owner: 'acme' });
    const s = await decided(rig, MONOLITH);
    const snap = await s.snapshot();
    expect(snap).not.toHaveProperty('docsRepo');
    expect(snap.docsTarget).toBeUndefined();
  });
});
