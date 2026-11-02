import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeDocsMarker, writeState } from '../../server/docs/project-state.js';
import { ConflictError } from '../../server/refine/session.js';
import { makeProject } from '../fixtures/contracts.js';
import { makeRig, PROJECT, type Rig } from '../fixtures/docs-repo-rig.js';

const BOUND = '0123456789abcdef0123456789abcdef01234567';
const PROJECT_JSON = `${JSON.stringify(makeProject(), null, 2)}\n`;
const LONG = 'a'.repeat(41);
const REFUSED = /o alias .* não é válido/;
const HYPHEN_HINT = /o hífen não pode começar nem terminar o nome, nem aparecer duas vezes seguidas/;

let rig: Rig;

/** The names of the drafts on disk; a refused id writes none. */
const drafts = (): Promise<string[]> => fs.readdir(path.join(rig.ws.root, 'refine')).catch(() => []);

afterEach(async () => {
  await rig?.close();
});

describe('the alias of a spec of a documentation repository', () => {
  beforeEach(async () => {
    rig = await makeRig({ docsRepoLayout: true });
    await fs.mkdir(path.join(rig.ws.repo, '.git'), { recursive: true });
    await writeDocsMarker(rig.ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: PROJECT }, firstSha: BOUND });
    await writeState(rig.ws, 'project.json', PROJECT_JSON);
  });

  it.each(['con', LONG])('refuses a new spec whose id %s is not an alias, in plain words, before any write', async (specId) => {
    const refusal = rig.registry.newSpec(PROJECT, specId);
    await expect(refusal).rejects.toBeInstanceOf(ConflictError);
    await expect(refusal).rejects.toThrow(REFUSED);
    expect(await drafts()).toEqual([]);
  });

  it.each(['a--b', 'ab-'])('refuses a new spec whose id %s has a misplaced hyphen, and says where a hyphen may stand', async (specId) => {
    const refusal = rig.registry.newSpec(PROJECT, specId);
    await expect(refusal).rejects.toBeInstanceOf(ConflictError);
    await expect(refusal).rejects.toThrow(HYPHEN_HINT);
    expect(await drafts()).toEqual([]);
  });

  it('refuses a new project whose first spec id is not an alias, before any write', async () => {
    const other = await makeRig({ docsRepoLayout: true });
    try {
      const refusal = other.registry.newProject(PROJECT, 'Hello', undefined, 'con');
      await expect(refusal).rejects.toBeInstanceOf(ConflictError);
      await expect(refusal).rejects.toThrow(REFUSED);
      expect(await fs.readdir(path.join(other.ws.root, 'refine')).catch(() => [])).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('accepts a long spec id for a legacy project, which has no documentation repository', async () => {
    const legacy = await makeRig();
    try {
      const session = await legacy.registry.newProject(PROJECT, 'Hello', undefined, LONG);
      expect(session.state.mode).toBe('new-project');
      await session.close();
    } finally {
      await legacy.close();
    }
  });
});
