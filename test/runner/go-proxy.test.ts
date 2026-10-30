import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { goProxyHandler } from '../../server/runner/go-proxy.js';

const servers: http.Server[] = [];
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const status = (url: string) => fetch(url).then((r) => r.status, () => 0);
const listen = async (handler: http.RequestListener): Promise<string> => {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

describe('goProxyHandler', () => {
  it('serves a module zip the upstream redirects to its storage, which the sandbox itself may not reach', async () => {
    // Live: proxy.golang.org answers klauspost/compress with a 302 to storage.googleapis.com.
    const storage = await listen((_req, res) => res.writeHead(200, { 'content-type': 'application/zip' }).end('zip-bytes'));
    const upstream = await listen((req, res) => {
      if (req.url === '/github.com/klauspost/compress/@v/v1.17.9.zip') res.writeHead(302, { location: `${storage}/blob` }).end();
      else if (req.url === '/github.com/nats-io/nats.go/@v/list') res.writeHead(200, { 'content-type': 'text/plain' }).end('v1.37.0\n');
      else res.writeHead(404).end('not found');
    });
    const proxy = await listen(goProxyHandler(upstream));
    const zip = await fetch(`${proxy}/github.com/klauspost/compress/@v/v1.17.9.zip`);
    expect([zip.status, zip.headers.get('content-type'), await zip.text()]).toEqual([200, 'application/zip', 'zip-bytes']);
    expect(await (await fetch(`${proxy}/github.com/nats-io/nats.go/@v/list`)).text()).toBe('v1.37.0\n');
    // A module the upstream does not know stays a 404, which the go command reads as "no such version".
    expect((await fetch(`${proxy}/github.com/none/x/@v/v1.0.0.info`)).status).toBe(404);
  });

  it('runs as a plain node script, so the goproxy service needs no tsx', async () => {
    const port = await freePort();
    const script = fileURLToPath(new URL('../../server/runner/go-proxy.ts', import.meta.url));
    const child = spawn(process.execPath, ['--experimental-strip-types', script], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
    try {
      let answer = 0;
      for (let i = 0; i < 50 && answer === 0; i++) {
        answer = await status(`http://127.0.0.1:${port}/`);
        if (answer === 0) await sleep(100);
      }
      expect(answer).toBe(404);
    } finally {
      child.kill();
    }
  }, 15_000);

  it('answers only the module protocol: anything else is a 404, so the go command checks sums at sum.golang.org itself', async () => {
    let reached = 0;
    const upstream = await listen((_req, res) => {
      reached += 1;
      res.writeHead(200).end('upstream');
    });
    const proxy = await listen(goProxyHandler(upstream));
    for (const path of ['/sumdb/sum.golang.org/supported', '/', '/github.com/x/y/@v/v1.0.0.zip?x=1']) expect((await fetch(`${proxy}${path}`)).status).toBe(404);
    expect((await fetch(`${proxy}/github.com/x/y/@v/list`, { method: 'POST', body: 'x' })).status).toBe(404);
    expect(reached).toBe(0);
  });
});
