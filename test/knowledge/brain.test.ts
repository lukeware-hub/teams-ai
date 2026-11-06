import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGlobalBrainNow, globalBrainFailure, rebuildGlobalBrain, resetGlobalBrainForTests, scheduleGlobalBrain, type BrainDeps, type BrainProject } from '../../server/knowledge/brain.js';

let root = '';
beforeEach(async () => {
  resetGlobalBrainForTests();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-'));
});
afterEach(async () => {
  vi.useRealTimers();
  resetGlobalBrainForTests();
  await fs.rm(root, { recursive: true, force: true });
});

/** A project with a graph file on disk, so the brain finds it. */
async function project(projectId: string, confidential = false, withGraph = true): Promise<BrainProject> {
  const graphDir = path.join(root, projectId);
  if (withGraph) {
    await fs.mkdir(path.join(graphDir, 'graphify-out'), { recursive: true });
    await fs.writeFile(path.join(graphDir, 'graphify-out', 'graph.json'), '{}');
  }
  return { projectId, graphDir, confidential };
}

function deps(projects: BrainProject[], merge: BrainDeps['graphify']['merge'] = async () => true): BrainDeps & { merge: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(merge);
  return { graphify: { merge: fn }, projects: async () => projects, dir: path.join(root, '_brain'), merge: fn };
}

describe('rebuildGlobalBrain', () => {
  it('merges the graphs of the open projects and leaves out a confidential one', async () => {
    const d = deps([await project('shop'), await project('clinic', true), await project('blog')]);
    const result = await rebuildGlobalBrain(d);
    expect(result).toEqual({ included: ['shop', 'blog'], left: ['clinic'] });
    expect(d.merge).toHaveBeenCalledTimes(1);
    expect(d.merge.mock.calls[0]![0].map((g: { name: string }) => g.name)).toEqual(['shop', 'blog']);
    expect(d.merge.mock.calls[0]![1]).toBe(d.dir);
  });

  it('never hands a confidential project to the merge, whatever else is in the list', async () => {
    const d = deps([await project('a', true), await project('b', true)]);
    await rebuildGlobalBrain(d);
    expect(d.merge).not.toHaveBeenCalled();
  });

  it('leaves out a project that has no graph yet', async () => {
    const d = deps([await project('shop'), await project('new', false, false)]);
    expect((await rebuildGlobalBrain(d)).left).toEqual(['new']);
  });

  it('removes the old brain when no project is left, so a project that turns confidential disappears', async () => {
    const d = deps([await project('shop', true)]);
    await fs.mkdir(path.join(d.dir, 'graphify-out'), { recursive: true });
    await fs.writeFile(path.join(d.dir, 'graphify-out', 'graph.json'), '{"nodes":[{"id":"shop::x"}]}');
    await rebuildGlobalBrain(d);
    await expect(fs.access(d.dir)).rejects.toThrow();
  });

  it('records a failed merge, rethrows it, and clears the record after a good build', async () => {
    const bad = deps([await project('shop')], async () => false);
    await expect(rebuildGlobalBrain(bad)).rejects.toThrow('could not merge');
    expect(globalBrainFailure()?.message).toContain('could not merge');
    await rebuildGlobalBrain(deps([await project('shop')]));
    expect(globalBrainFailure()).toBeNull();
  });
});

describe('buildGlobalBrainNow and scheduleGlobalBrain', () => {
  it('builds once more for the requests that came during a build', async () => {
    let release: () => void = () => undefined;
    const d = deps([await project('shop')], () => new Promise<boolean>((resolve) => { release = () => resolve(true); }));
    const first = buildGlobalBrainNow(d);
    await vi.waitFor(() => expect(d.merge).toHaveBeenCalledTimes(1));
    const second = buildGlobalBrainNow(d);
    release();
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(d.merge).toHaveBeenCalledTimes(2));
    release();
  });

  it('turns several schedules into one build after the delay', async () => {
    const d = deps([await project('shop')]);
    scheduleGlobalBrain(d, 30);
    scheduleGlobalBrain(d, 30);
    scheduleGlobalBrain(d, 30);
    expect(d.merge).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(d.merge).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(d.merge).toHaveBeenCalledTimes(1);
  });

  it('never fails its caller when the scheduled build fails', async () => {
    const d = deps([await project('shop')], async () => {
      throw new Error('boom');
    });
    scheduleGlobalBrain(d, 10);
    await vi.waitFor(() => expect(globalBrainFailure()?.message).toBe('boom'));
  });
});
