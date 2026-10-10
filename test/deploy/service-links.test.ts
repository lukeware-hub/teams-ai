import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Exec } from '../../server/exec/command.js';
import { PUBLISHED_PORTS, assignDeployPort, releaseDeployPort, serviceLinks } from '../../server/deploy/service-links.js';

describe('serviceLinks', () => {
  it('builds the app and docs urls for an api inside the published range', () => {
    expect(serviceLinks({ url: 'http://dind:20000', port: 20000, kind: 'api', docsPath: '/docs' }, 'localhost')).toEqual({ appUrl: 'http://localhost:20000', docsUrl: 'http://localhost:20000/docs' });
  });

  it('gives a front-end only the app url', () => {
    expect(serviceLinks({ url: 'http://dind:20001', port: 20001, kind: 'front', docsPath: '/docs' }, 'localhost')).toEqual({ appUrl: 'http://localhost:20001', docsUrl: null });
  });

  it('reads the port from the url of an older report', () => {
    expect(serviceLinks({ url: 'http://dind:20000' }, 'localhost')).toEqual({ appUrl: 'http://localhost:20000', docsUrl: null });
  });

  it('offers no link when the port is outside the published range or unknown', () => {
    expect(serviceLinks({ url: 'http://dind:8080', port: 8080, kind: 'api', docsPath: '/docs' }, 'localhost')).toEqual({ appUrl: null, docsUrl: null });
    expect(serviceLinks({ url: 'http://dind' }, 'localhost')).toEqual({ appUrl: null, docsUrl: null });
    expect(serviceLinks({ url: 'not a url' }, 'localhost')).toEqual({ appUrl: null, docsUrl: null });
  });
});

describe('serviceLinks legacy range', () => {
  it('still links a run deployed on the older 3000-3019 range', () => {
    expect(serviceLinks({ url: 'http://dind:3001', port: 3001, kind: 'front' }, 'localhost').appUrl).toBe('http://localhost:3001');
  });
});

describe('assignDeployPort', () => {
  const docker = (stdout = ''): Exec => async () => ({ exitCode: 0, stdout, stderr: '' }) as never;
  const root = () => fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-ports-'));
  const inRange = (p: number | null) => p !== null && p >= PUBLISHED_PORTS.from && p <= PUBLISHED_PORTS.to;

  it('draws a port in the range, registers it and keeps it for the project', async () => {
    const dir = await root();
    const first = await assignDeployPort(dir, 'node-hello-api', docker());
    expect(inRange(first.port)).toBe(true);
    expect((await assignDeployPort(dir, 'node-hello-api', docker())).port).toBe(first.port);
    expect(JSON.parse(await fs.readFile(path.join(dir, '.ports.json'), 'utf8'))).toEqual({ 'node-hello-api': first.port });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('never gives two projects the same port nor one the daemon already publishes', async () => {
    const dir = await root();
    const busy = Array.from({ length: PUBLISHED_PORTS.to - PUBLISHED_PORTS.from }, (_, i) => `0.0.0.0:${PUBLISHED_PORTS.from + i}->3000/tcp`).join(', ');
    const a = await assignDeployPort(dir, 'a', docker(busy));
    expect(a.port).toBe(PUBLISHED_PORTS.to);
    const b = await assignDeployPort(dir, 'b', docker(busy));
    expect(b).toEqual({ port: null, taken: expect.arrayContaining([PUBLISHED_PORTS.to]) });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('frees the port when the project is released', async () => {
    const dir = await root();
    const { port } = await assignDeployPort(dir, 'a', docker());
    await releaseDeployPort(dir, 'a');
    expect((await assignDeployPort(dir, 'b', docker())).taken).not.toContain(port);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('still allocates when docker is unavailable', async () => {
    const dir = await root();
    const failing: Exec = async () => { throw new Error('no docker'); };
    expect(inRange((await assignDeployPort(dir, 'a', failing)).port)).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });
});
