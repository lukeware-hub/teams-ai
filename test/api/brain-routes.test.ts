import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRoutes } from '../../server/api/run-routes.js';
import { resetGlobalBrainForTests } from '../../server/knowledge/brain.js';

let dir = '';
afterEach(async () => {
  resetGlobalBrainForTests();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

const find = (method: string, suffix: string, deps: object = {}) =>
  runRoutes({ cfg: async () => ({ projects: [] }) as never, home: '/tmp/teams-ai-none', control: {} as never, ...deps } as never).find((r) => r.method === method && r.path.endsWith(suffix))!.handler;

describe('global brain routes', () => {
  it('answers 501 for both routes when the server has no brain', async () => {
    await expect(find('GET', '/brain')({ params: {}, json: vi.fn() } as never)).rejects.toMatchObject({ status: 501 });
    await expect(find('POST', '/brain/rebuild')({ params: {}, json: vi.fn() } as never)).rejects.toMatchObject({ status: 501 });
  });

  it('says there is no brain yet when nothing was built, and shows the graph and its date once there is one', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-routes-'));
    const brain = { graphify: { merge: async () => true }, projects: async () => [], dir };
    const json = vi.fn();
    await find('GET', '/brain', { brain })({ params: {}, json } as never);
    expect(json).toHaveBeenLastCalledWith(200, expect.objectContaining({ available: false, status: { updatedAt: null, failure: null } }));
    await fs.mkdir(path.join(dir, 'graphify-out'), { recursive: true });
    await fs.writeFile(path.join(dir, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [{ id: 'shop::api::a', label: 'A' }], links: [] }));
    await find('GET', '/brain', { brain })({ params: {}, json } as never);
    const view = json.mock.calls.at(-1)![1];
    expect(view).toMatchObject({ available: true, nodes: 1, communities: 1 });
    expect(typeof view.status.updatedAt).toBe('string');
  });

  it('rebuilds the brain on request, and says why when it cannot', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brain-routes-'));
    await fs.mkdir(path.join(dir, 'shop', 'graphify-out'), { recursive: true });
    await fs.writeFile(path.join(dir, 'shop', 'graphify-out', 'graph.json'), '{}');
    const merge = vi.fn(async () => true);
    const open = { graphify: { merge }, projects: async () => [{ projectId: 'shop', graphDir: path.join(dir, 'shop'), confidential: false }], dir: path.join(dir, '_brain') };
    const json = vi.fn();
    await find('POST', '/brain/rebuild', { brain: open })({ params: {}, json } as never);
    expect(json).toHaveBeenCalledWith(200, { ok: true });
    expect(merge).toHaveBeenCalledTimes(1);
    const broken = { ...open, graphify: { merge: async () => false } };
    await expect(find('POST', '/brain/rebuild', { brain: broken })({ params: {}, json } as never)).rejects.toMatchObject({ status: 500 });
  });
});
