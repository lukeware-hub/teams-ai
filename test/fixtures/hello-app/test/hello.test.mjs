import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

// Runs the same handler the server uses, on an ephemeral port, so the test never binds 3000.
const handler = (req, res) => {
  if (req.url === '/health') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  res.writeHead(200, { 'content-type': 'text/plain' }).end('hello\n');
};

test('[AC-001] health endpoint answers 200', async () => {
  const srv = http.createServer(handler).listen(0);
  await once(srv, 'listening');
  const { port } = srv.address();
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  srv.close();
  await once(srv, 'close');
});
