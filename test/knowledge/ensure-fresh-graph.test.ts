import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureFreshGraph, GRAPH_TTL_MS } from '../../server/knowledge/project-graph.js';

let dir = '';
let file = '';
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fresh-graph-'));
  file = path.join(dir, 'graph.json');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ensureFreshGraph', () => {
  it('builds nothing when the graph is younger than the limit', async () => {
    await fs.writeFile(file, '{}');
    const build = vi.fn(async () => undefined);
    await ensureFreshGraph(file, 'p', build, new Map());
    expect(build).not.toHaveBeenCalled();
  });

  it('waits for the build when there is no graph', async () => {
    let built = false;
    await ensureFreshGraph(file, 'p', async () => { built = true; }, new Map());
    expect(built).toBe(true);
  });

  it('goes on at once from an old graph while the build runs in the background', async () => {
    await fs.writeFile(file, '{}');
    const old = new Date(Date.now() - GRAPH_TTL_MS - 1000);
    await fs.utimes(file, old, old);
    let release: () => void = () => undefined;
    const build = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    await ensureFreshGraph(file, 'p', build, new Map());
    expect(build).toHaveBeenCalledTimes(1);
    release();
  });

  it('runs one build per key at a time and logs a failed one without throwing', async () => {
    const running = new Map<string, Promise<void>>();
    const log = vi.fn();
    const build = vi.fn(() => new Promise<void>((_, reject) => setTimeout(() => reject(new Error('boom')), 30)));
    await Promise.all([ensureFreshGraph(file, 'p', build, running, log), ensureFreshGraph(file, 'p', build, running, log)]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('project graph not built for p: boom');
  });
});
