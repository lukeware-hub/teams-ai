import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { Journal } from '../../server/orchestrator/events.js';
import { reviewWorktree } from '../../server/orchestrator/phases/converge.js';
import type { PhaseDeps } from '../../server/orchestrator/phases/shared.js';
import { makeFrozenSpec } from '../fixtures/contracts.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
let remote: Remote;
let journal: Journal;

beforeEach(async () => {
  remote = await makeRemote({ 'app.ts': 'export const a = 1;\n' });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: spec.specHash! });
});
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

function deps(): PhaseDeps {
  const ws = { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: '', knowledgeDb: '', secrets: path.join(remote.root, 'secrets'), runs: remote.root };
  return { journal, ws, spec, exec: execCommand } as unknown as PhaseDeps;
}

describe('the plan review worktree', () => {
  it('reads main as it is now, not the checkout an earlier run left behind', async () => {
    const first = await reviewWorktree(deps(), 1);
    // Main moves on: a later run merges new code while the review worktree stays registered.
    await fs.writeFile(path.join(remote.repo, 'later.ts'), 'export const b = 2;\n');
    await git(remote.repo, ['add', '-A']);
    await git(remote.repo, ['commit', '-q', '-m', 'feat: later']);
    await git(remote.repo, ['push', '-q', 'origin', 'main']);
    const again = await reviewWorktree(deps(), 1);
    expect(again).toBe(first);
    await expect(fs.access(path.join(again, 'later.ts'))).resolves.toBeUndefined();
  });
});
