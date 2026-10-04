import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAllowedHost, startApi } from '../../server/api/server.js';
import { onboardingRoutes } from '../../server/api/onboarding-routes.js';
import type { Pty, PtySpec } from '../../server/onboarding/pty.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const KEY = 'sk-or-v1-' + 'ab'.repeat(32);
const TOKEN = 'ghp_' + 'c'.repeat(36);

class FakePty implements Pty {
  writes: string[] = [];
  private data: Array<(c: string) => void> = [];
  private exit: Array<(c: number | null) => void> = [];
  write(d: string) { this.writes.push(d); }
  kill() { this.emitExit(143); }
  onData(cb: (c: string) => void) { this.data.push(cb); }
  onExit(cb: (c: number | null) => void) { this.exit.push(cb); }
  emit(c: string) { for (const cb of this.data) cb(c); }
  emitExit(code: number | null) { for (const cb of this.exit) cb(code); }
}

let home = '';
let api: { port: number; close(): Promise<void> };
let ptys: FakePty[];
let exec: FakeExec;
let logs: string[];
const base = () => `http://127.0.0.1:${api.port}`;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-api-'));
  ptys = [];
  logs = [];
  exec = new FakeExec()
    .onArgs('claude', ['auth', 'status'], () => ({ stdout: JSON.stringify({ loggedIn: true, email: 'a@b.c', subscriptionType: 'max' }) }))
    .onArgs('gh', ['auth', 'status'], () => ({ exitCode: 1, stderr: 'not logged in' }))
    .onArgs('gh', ['api', 'user/orgs'], () => ({ stdout: 'acme\nplatform\nacme\n' }))
    .onArgs('gh', ['api', 'user'], (s) => (s.env?.GH_TOKEN === TOKEN ? { stdout: `HTTP/2.0 200 OK\nX-Oauth-Scopes: repo\n\n{"login":"diego"}` } : { exitCode: 1, stderr: `HTTP 401 for ${s.env?.GH_TOKEN ?? ''}` }));
  const okFetch = (async () => new Response(JSON.stringify({ model: 'typesafe/jev-1.13', answers: { probe: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1, cost: 0.000001 } }), { status: 200 })) as typeof fetch;
  api = await startApi(
    { routes: onboardingRoutes({ exec: exec.exec, fetch: okFetch, home, secretsDir: path.join(home, 'secrets'), spawn: (_s: PtySpec) => { const p = new FakePty(); ptys.push(p); return p; } }), log: (l) => logs.push(l) },
    0,
  );
});
afterEach(async () => {
  await api.close();
  await fs.rm(home, { recursive: true, force: true });
});

describe('api server', () => {
  it('binds 127.0.0.1 and refuses a foreign Host header', async () => {
    expect(isAllowedHost('localhost:3000')).toBe(true);
    expect(isAllowedHost('127.0.0.1')).toBe(true);
    expect(isAllowedHost('evil.example')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
    // fetch drops the forbidden Host header, so the request goes through node:http.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: api.port, path: '/api/onboarding/status', headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    expect(status).toBe(403);
    expect(logs.some((l) => l.includes('403'))).toBe(true);
  });

  it('GET /status reports the five items, unknown routes are 404', async () => {
    const r = await fetch(`${base()}/api/onboarding/status`);
    expect(r.status).toBe(200);
    const s = (await r.json()) as { items: Record<string, { ok: boolean }>; allOk: boolean };
    expect(Object.keys(s.items).sort()).toEqual(['claude', 'ghLogin', 'githubOwner', 'githubToken', 'openrouterKey']);
    expect(s.items.claude!.ok).toBe(true);
    expect(s.allOk).toBe(false);
    expect((await fetch(`${base()}/api/onboarding/nope`)).status).toBe(404);
  });

  it('serves onboarding through the versioned API prefix', async () => {
    const r = await fetch(`${base()}/teams-ai/v1/api/onboarding/status`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ items: { claude: { ok: true } } });
  });

  it('PUT /secrets/<NAME> writes the secret, probes it and never echoes the value; other names are 404', async () => {
    const r = await fetch(`${base()}/api/onboarding/secrets/GITHUB_TOKEN`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: TOKEN }) });
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).not.toContain(TOKEN);
    expect(JSON.parse(body)).toMatchObject({ item: { ok: true, detail: 'diego · scopes: repo', secret: { set: true, hint: '****' } } });
    expect(await fs.readFile(path.join(home, 'secrets', 'GITHUB_TOKEN'), 'utf8')).toBe(TOKEN);
    expect((await fetch(`${base()}/api/onboarding/secrets/OTHER`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x' }) })).status).toBe(404);
    expect((await fetch(`${base()}/api/onboarding/secrets/GITHUB_TOKEN`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'two\nlines' }) })).status).toBe(400);
  });

  it('a rejected secret value never appears in the response body or the log', async () => {
    const wrong = 'ghp_' + 'w'.repeat(36);
    const r = await fetch(`${base()}/api/onboarding/secrets/GITHUB_TOKEN`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: wrong }) });
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(JSON.parse(body).item.ok).toBe(false);
    expect(body).not.toContain(wrong);
    expect(logs.join('\n')).not.toContain(wrong);
  });

  it('PUT /github-owner validates and probes', async () => {
    exec.onArgs('gh', ['api', 'users/diego-dm-morais'], () => ({ stdout: JSON.stringify({ login: 'diego-dm-morais', type: 'User' }) }));
    const bad = await fetch(`${base()}/api/onboarding/github-owner`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'has space' }) });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base()}/api/onboarding/github-owner`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'diego-dm-morais' }) });
    expect(await ok.json()).toEqual({ item: { ok: true, detail: 'diego-dm-morais (User)' } });
    expect(JSON.parse(await fs.readFile(path.join(home, '.teams-ai', 'config.json'), 'utf8'))).toEqual({ github: { owner: 'diego-dm-morais' } });
  });

  it('GET /github-organizations lists unique organizations and the saved owner', async () => {
    const r = await fetch(`${base()}/api/onboarding/github-organizations`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ organizations: ['acme', 'platform'], owner: null });
  });

  it('login session over SSE: state events, code posting, 409 outside awaiting-code, replay on connect', async () => {
    expect((await fetch(`${base()}/api/onboarding/claude/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'x' }) })).status).toBe(409);
    const started = await fetch(`${base()}/api/onboarding/claude/login`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual({ state: { name: 'starting' } });
    const es = await fetch(`${base()}/api/onboarding/claude/events`);
    expect(es.headers.get('content-type')).toContain('text/event-stream');
    const reader = es.body!.getReader();
    const read = async (): Promise<string> => new TextDecoder().decode((await reader.read()).value);
    expect(await read()).toContain('event: state\ndata: {"name":"starting"}');
    ptys[0]!.emit('https://claude.example/a\nPaste code here if prompted > ');
    const chunk = await read();
    expect(chunk).toContain('awaiting-browser');
    expect(chunk).toContain('event: output');
    const posted = await fetch(`${base()}/api/onboarding/claude/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'c0de#st' }) });
    expect(posted.status).toBe(202);
    expect(ptys[0]!.writes).toEqual(['c0de#st\n']);
    ptys[0]!.emitExit(0);
    let all = '';
    for (let i = 0; i < 5 && !all.includes('"done"'); i++) all += await read();
    expect(all).toContain('"name":"done"');
    expect(all).not.toContain('c0de#st');
    await reader.cancel();
    const cancel = await fetch(`${base()}/api/onboarding/claude/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(cancel.status).toBe(200);
  });

  it('masks a secret stored after startup, written through the API or straight to disk, in the login transcript (audit M4)', async () => {
    const viaApi = 'plain-token-no-known-shape-12345';
    const onDisk = 'other-opaque-value-98765';
    expect((await fetch(`${base()}/api/onboarding/secrets/OPENROUTER_API_KEY`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: viaApi }) })).status).toBe(200);
    await fs.writeFile(path.join(home, 'secrets', 'DB_PASSWORD'), onDisk);
    await fetch(`${base()}/api/onboarding/claude/login`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    const es = await fetch(`${base()}/api/onboarding/claude/events`);
    const reader = es.body!.getReader();
    const read = async (): Promise<string> => new TextDecoder().decode((await reader.read()).value);
    await read();
    ptys[0]!.emit(`echo ${viaApi} and ${onDisk}
https://claude.example/a
`);
    let all = '';
    for (let i = 0; i < 3 && !all.includes('output'); i++) all += await read();
    expect(all).toContain('[REDACTED]');
    expect(all).not.toContain(viaApi);
    expect(all).not.toContain(onDisk);
    await reader.cancel();
  });

  it('rejects oversized bodies with 413', async () => {
    const r = await fetch(`${base()}/api/onboarding/github-owner`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner: 'x'.repeat(70_000) }) });
    expect(r.status).toBe(413);
  });
});
