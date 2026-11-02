import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeDocsMarker, writeState } from '../../server/docs/project-state.js';
import { makeProject } from '../fixtures/contracts.js';
import { makeRig, PROJECT, type Rig } from '../fixtures/docs-repo-rig.js';

const BOUND = '0123456789abcdef0123456789abcdef01234567';
const PROJECT_JSON = `${JSON.stringify(makeProject(), null, 2)}\n`;

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

/** Asks for a spec name, with the agent answering the alias ask-login. */
async function suggestSpecName(r: Rig): Promise<{ id: string }> {
  r.script['name/po'] = [{ specHash: 'x', id: 'ask-login' }];
  return r.registry.suggestName('spec', { projectId: PROJECT, name: '', description: 'login' }) as Promise<{ id: string }>;
}

describe('suggestName skips the aliases already used under the layout folder', () => {
  it('skips an alias that the documentation repository already holds in the mirror', async () => {
    rig = await makeRig({ docsRepoLayout: true });
    await writeDocsMarker(rig.ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: PROJECT }, firstSha: BOUND });
    await writeState(rig.ws, 'project.json', PROJECT_JSON);
    await writeState(rig.ws, 'specs/ask-login/spec.json', '{}');
    expect(await suggestSpecName(rig)).toEqual({ id: 'ask-login-2' });
  });

  it('skips an alias that the legacy docs/specs folder of the workspace already holds', async () => {
    rig = await makeRig();
    await fs.mkdir(path.join(rig.ws.repo, 'docs', 'specs', 'ask-login'), { recursive: true });
    expect(await suggestSpecName(rig)).toEqual({ id: 'ask-login-2' });
  });
});
