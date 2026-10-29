import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeTree } from '../../server/core/remove-tree.js';

let dir = '';
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-remove-tree-'));
});
afterEach(async () => {
  await removeTree(dir);
});

const exists = (p: string) => fs.access(p).then(() => true, () => false);

describe('removeTree', () => {
  it('removes a tree whose folders are read-only, as the Go module cache leaves them', async () => {
    const root = path.join(dir, 'worktree');
    const cache = path.join(root, '.tools', 'go', 'pkg', 'mod');
    await fs.mkdir(cache, { recursive: true });
    await fs.writeFile(path.join(cache, 'CONTRIBUTING.md'), 'x');
    for (const folder of [cache, path.dirname(cache), path.dirname(path.dirname(cache)), path.dirname(path.dirname(path.dirname(cache)))]) await fs.chmod(folder, 0o555);
    await removeTree(root);
    expect(await exists(root)).toBe(false);
  });

  it('does nothing when the path is missing', async () => {
    await expect(removeTree(path.join(dir, 'missing'))).resolves.toBeUndefined();
  });
});
