import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { docsStoreDir, writeDocsMarker } from '../../server/docs/project-state.js';
import { draftPaths, refineHistoryRoot } from '../../server/refine/draft.js';
import { makeRig, PROJECT, type Rig } from '../fixtures/docs-repo-rig.js';

const BOUND = '0123456789abcdef0123456789abcdef01234567';
const SPEC = `${PROJECT}-001`;

let rig: Rig | undefined;

afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

describe('the release of a discarded draft', () => {
  it('leaves a legacy project store untouched when its last draft is discarded', async () => {
    rig = await makeRig();
    await rig.registry.newProject(PROJECT, 'Hello');
    const store = docsStoreDir(rig.ws);
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(path.join(store, 'keep.md'), 'legacy\n');

    await rig.registry.deleteDraft(PROJECT, SPEC);

    expect(await fs.readFile(path.join(store, 'keep.md'), 'utf8')).toBe('legacy\n');
  });

  it('removes the store of a documentation repository when its last not-started draft is discarded', async () => {
    rig = await makeRig({ docsRepoLayout: true });
    await rig.registry.newProject(PROJECT, 'Hello');
    await writeDocsMarker(rig.ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: PROJECT }, firstSha: BOUND });
    await fs.mkdir(docsStoreDir(rig.ws), { recursive: true });

    await rig.registry.deleteDraft(PROJECT, SPEC);

    await expect(fs.access(docsStoreDir(rig.ws))).rejects.toThrow();
  });

  it('keeps the journal of a discarded draft, so what it cost still counts', async () => {
    rig = await makeRig();
    await rig.registry.newProject(PROJECT, 'Hello');
    const journal = await fs.readFile(path.join(draftPaths(rig.ws, SPEC).root, 'events.ndjson'), 'utf8');

    await rig.registry.deleteDraft(PROJECT, SPEC);

    const history = path.join(refineHistoryRoot(rig.ws), SPEC);
    const kept = await fs.readdir(history);
    expect(kept).toHaveLength(1);
    expect(await fs.readFile(path.join(history, kept[0]!, 'events.ndjson'), 'utf8')).toBe(journal);
  });

  it('keeps the store of a documentation repository when its last draft is restarted', async () => {
    rig = await makeRig({ docsRepoLayout: true });
    await rig.registry.newProject(PROJECT, 'Hello');
    await writeDocsMarker(rig.ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: PROJECT }, firstSha: BOUND });
    await fs.mkdir(docsStoreDir(rig.ws), { recursive: true });

    // The restart may fail after the discard, since the spec has no mirror yet; only the store matters here.
    await rig.registry.restartSpec(PROJECT, SPEC).catch(() => undefined);

    await expect(fs.access(docsStoreDir(rig.ws))).resolves.toBeUndefined();
  });
});
