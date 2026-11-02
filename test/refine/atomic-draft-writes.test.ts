import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNewProject, writeDerived } from '../../server/refine/draft.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';
import { makeRig, PROJECT, type Rig } from '../fixtures/docs-repo-rig.js';

const derived = { project: makeProject({ projectId: PROJECT }), spec: makeSpec({ status: 'refining', specHash: null, repository: PROJECT }) };

let rig: Rig;

/** The names of the temporary files left under a folder; an atomic write leaves none. */
const tmpFilesUnder = async (dir: string): Promise<string[]> => {
  const names = await fs.readdir(dir, { recursive: true });
  return names.filter((name) => name.endsWith('.tmp'));
};

beforeEach(async () => {
  rig = await makeRig();
});

afterEach(async () => {
  await rig.close();
});

describe('draft writes are atomic', () => {
  it('createNewProject writes each of the five documents in full and leaves no tmp file', async () => {
    await createNewProject(rig.draft, 'Hello');
    const folder = path.dirname(rig.draft.briefMd);
    for (const file of [rig.draft.projectMd, rig.draft.stackMd, rig.draft.flowMd, rig.draft.briefMd]) {
      const text = await fs.readFile(file, 'utf8');
      expect(text.length).toBeGreaterThan(0);
      expect(text.endsWith('\n')).toBe(true);
    }
    expect(await fs.readFile(rig.draft.projectMd, 'utf8')).toContain('Hello');
    expect(await tmpFilesUnder(folder)).toEqual([]);
  });

  it('writeDerived writes project.json and spec.json as complete JSON and leaves no tmp file', async () => {
    await fs.mkdir(path.dirname(rig.draft.specJson), { recursive: true });
    await writeDerived(rig.draft, derived);
    expect(JSON.parse(await fs.readFile(rig.draft.specJson, 'utf8'))).toEqual(JSON.parse(JSON.stringify(derived.spec)));
    expect(JSON.parse(await fs.readFile(rig.draft.projectJson, 'utf8'))).toEqual(JSON.parse(JSON.stringify(derived.project)));
    expect(await tmpFilesUnder(path.dirname(rig.draft.specJson))).toEqual([]);
  });
});
