import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOCS_REPO_LAYOUT_ENV, docsMarkerPath, docsRepoLayoutEnabled, readDocsMarker, writeDocsMarker, type DocsMarker } from '../../server/docs/project-state.js';

let root: string;
const at = () => ({ root });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-state-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const marker: DocsMarker = {
  layout: 'docs-repo',
  style: 'monolith',
  target: { owner: 'acme', name: 'kayron-hub' },
  firstSha: null,
};

describe('docsRepoLayoutEnabled', () => {
  it('is off when the variable is unset', () => {
    expect(docsRepoLayoutEnabled({})).toBe(false);
  });

  it('is on only when the variable is 1', () => {
    expect(docsRepoLayoutEnabled({ [DOCS_REPO_LAYOUT_ENV]: '1' })).toBe(true);
    expect(docsRepoLayoutEnabled({ [DOCS_REPO_LAYOUT_ENV]: 'junk' })).toBe(false);
    expect(docsRepoLayoutEnabled({ [DOCS_REPO_LAYOUT_ENV]: 'true' })).toBe(false);
  });
});

describe('docs marker', () => {
  it('reads no marker for a project that has none', async () => {
    expect(await readDocsMarker(at())).toBeNull();
  });

  it('round-trips the marker, with and without the first pushed commit', async () => {
    await writeDocsMarker(at(), marker);
    expect(await readDocsMarker(at())).toEqual(marker);
    const pushed = { ...marker, firstSha: 'ab'.repeat(20) };
    await writeDocsMarker(at(), pushed);
    expect(await readDocsMarker(at())).toEqual(pushed);
  });

  it('refuses a marker that is not JSON', async () => {
    await fs.mkdir(path.dirname(docsMarkerPath(at())), { recursive: true });
    await fs.writeFile(docsMarkerPath(at()), '{not json');
    await expect(readDocsMarker(at())).rejects.toThrow();
  });

  it('refuses a marker of another layout or a first commit that is not a full id', async () => {
    await expect(writeDocsMarker(at(), { ...marker, layout: 'legacy' } as unknown as DocsMarker)).rejects.toThrow();
    await expect(writeDocsMarker(at(), { ...marker, firstSha: 'abc' })).rejects.toThrow();
  });
});
