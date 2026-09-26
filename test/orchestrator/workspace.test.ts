import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../server/config/config.js';
import { eventsFile, expandHome, graphDir, nextRunId, stepDir, workspacePaths, worktreeDir } from '../../server/orchestrator/workspace.js';

let dir = '';
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

describe('workspace', () => {
  it('expands ~ against the given home and lays out the project directories', () => {
    expect(expandHome('~/.teams-ai/x', '/home/u')).toBe('/home/u/.teams-ai/x');
    const ws = workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u');
    expect(ws).toEqual({
      projectId: 'shop',
      root: '/home/u/.teams-ai/workspaces/shop',
      repo: '/home/u/.teams-ai/workspaces/shop/repo',
      worktrees: '/home/u/.teams-ai/workspaces/shop/worktrees',
      graph: '/home/u/.teams-ai/workspaces/shop/graph',
      knowledgeDb: '/home/u/.teams-ai/workspaces/shop/knowledge.sqlite',
      secrets: '/home/u/.teams-ai/workspaces/shop/secrets',
      runs: '/home/u/.teams-ai/runs',
    });
    expect(worktreeDir(ws, 'task/checkout-T1')).toBe('/home/u/.teams-ai/workspaces/shop/worktrees/task__checkout-T1');
    expect(graphDir(ws, null)).toBe('/home/u/.teams-ai/workspaces/shop/graph/main');
    expect(graphDir(ws, 'task/checkout-T1')).toBe('/home/u/.teams-ai/workspaces/shop/graph/worktrees/task__checkout-T1');
    expect(eventsFile(ws, 'checkout-r1')).toBe('/home/u/.teams-ai/runs/checkout-r1/events.ndjson');
    expect(stepDir(ws, 'checkout-r1', 7)).toBe('/home/u/.teams-ai/runs/checkout-r1/steps/s00007');
  });

  it('numbers runs per spec from the existing run directories', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-runs-'));
    const ws = { ...workspacePaths(DEFAULT_CONFIG, 'shop', '/home/u'), runs: dir };
    expect(await nextRunId(ws, 'checkout')).toBe('checkout-r1');
    await fs.mkdir(path.join(dir, 'checkout-r1'));
    await fs.mkdir(path.join(dir, 'checkout-r2'));
    await fs.mkdir(path.join(dir, 'other-r9'));
    expect(await nextRunId(ws, 'checkout')).toBe('checkout-r3');
  });
});
