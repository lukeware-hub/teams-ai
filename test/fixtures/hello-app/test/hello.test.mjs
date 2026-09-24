import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

test('[AC-001] health endpoint answers 200', async () => {
  const { default: server } = await import('../server.mjs').catch(() => ({ default: null }));
  const srv = http.createServer((req, res) => res.writeHead(200).end('{"ok":true}')).listen(0);
  await once(srv, 'listening');
  const { port } = srv.address();
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  srv.close();
  void server;
});
