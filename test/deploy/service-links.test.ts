import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assignDeployPort, serviceLinks } from '../../server/deploy/service-links.js';

describe('serviceLinks', () => {
  it('builds the app and docs urls for an api inside the published range', () => {
    expect(serviceLinks({ url: 'http://dind:3000', port: 3000, kind: 'api', docsPath: '/docs' }, 'localhost')).toEqual({ appUrl: 'http://localhost:3000', docsUrl: 'http://localhost:3000/docs' });
  });

  it('gives a front-end only the app url', () => {
    expect(serviceLinks({ url: 'http://dind:3001', port: 3001, kind: 'front', docsPath: '/docs' }, 'localhost')).toEqual({ appUrl: 'http://localhost:3001', docsUrl: null });
  });

  it('reads the port from the url of an older report', () => {
    expect(serviceLinks({ url: 'http://dind:3000' }, 'localhost')).toEqual({ appUrl: 'http://localhost:3000', docsUrl: null });
  });

  it('offers no link when the port is outside the published range or unknown', () => {
    expect(serviceLinks({ url: 'http://dind:8080', port: 8080, kind: 'api', docsPath: '/docs' }, 'localhost')).toEqual({ appUrl: null, docsUrl: null });
    expect(serviceLinks({ url: 'http://dind' }, 'localhost')).toEqual({ appUrl: null, docsUrl: null });
    expect(serviceLinks({ url: 'not a url' }, 'localhost')).toEqual({ appUrl: null, docsUrl: null });
  });
});

describe('assignDeployPort', () => {
  const plan = async (root: string, project: string, spec: string, port: number) => {
    const dir = path.join(root, project, 'repo', 'docs', 'specs', spec);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'plan.json'), JSON.stringify({ deploy: { port } }));
  };

  it('gives a new project the lowest port no other project plans with, and keeps a project on its own free port', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-ports-'));
    await plan(root, 'custumer-api', 'custumer-api-001', 3000);
    await plan(root, 'node-hello-api', 'node-hello-api-001', 3001);
    expect(await assignDeployPort(root, 'rust-hello-api')).toEqual({ port: 3002, taken: [3000, 3001] });
    await plan(root, 'rust-hello-api', 'rust-hello-api-001', 3007);
    expect((await assignDeployPort(root, 'rust-hello-api')).port).toBe(3007);
    // A project that planned a port another project holds moves to a free one.
    await plan(root, 'go-hello-api', 'go-hello-api-001', 3000);
    expect((await assignDeployPort(root, 'go-hello-api')).port).toBe(3002);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('never follows a plan.json symlink nor reads an oversized one', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-ports-'));
    const target = path.join(root, 'outside.json');
    await fs.writeFile(target, JSON.stringify({ deploy: { port: 3000 } }));
    const dir = path.join(root, 'evil', 'repo', 'docs', 'specs', 'evil-001');
    await fs.mkdir(dir, { recursive: true });
    await fs.symlink(target, path.join(dir, 'plan.json'));
    const big = path.join(root, 'huge', 'repo', 'docs', 'specs', 'huge-001');
    await fs.mkdir(big, { recursive: true });
    await fs.writeFile(path.join(big, 'plan.json'), JSON.stringify({ deploy: { port: 3001 }, pad: 'x'.repeat(1_100_000) }));
    expect((await assignDeployPort(root, 'mine')).taken).toEqual([]);
    await fs.rm(root, { recursive: true, force: true });
  });
});
