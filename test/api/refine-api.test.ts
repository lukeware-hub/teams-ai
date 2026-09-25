import { mkdirSync, promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refineRoutes } from '../../server/api/refine-routes.js';
import type { RunControlDeps } from '../../server/api/run-control.js';
import { startApi } from '../../server/api/server.js';
import { execCommand } from '../../server/exec/command.js';
import { readUserConfig } from '../../server/onboarding/config-store.js';
import { SessionRegistry } from '../../server/refine/registry.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';
import { makeFakeRunAgent, type Script } from '../fixtures/fake-run-agent.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

let home = '';
let spawnShouldFail = false;
let api: { port: number; close(): Promise<void> };
let registry: SessionRegistry;
let script: Script;
let remote: Remote | null = null;
let spawns: Array<{ args: string[]; logFile: string }>;
let registered: string[];
const base = () => `http://127.0.0.1:${api.port}`;
const call = (method: string, p: string, body?: unknown) =>
  fetch(`${base()}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const snapshot = async () => (await fetch(`${base()}/api/refine/hello-app/hello-app-001`)).json();
const settle = async () => {
  for (let i = 0; i < 100 && (await snapshot()).state.status === 'evaluating'; i++) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 30)); // the session clears `busy` a tick after the last event lands
};
const HELLO_PROJECT = makeProject({ projectId: 'hello-app' });
const derived = { project: HELLO_PROJECT, spec: { ...makeSpec(), status: 'refining', specHash: null } };
const PO = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions'].map((id) => ({ id, passed: true, detail: 'ok' }));
const SM = ['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'].map((id) => ({ id, passed: true, detail: 'ok' }));

beforeEach(async () => {
  home = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-refapi-'))).replace(/\\/g, '/');
  await fs.mkdir(`${home}/.teams-ai`, { recursive: true });
  await fs.writeFile(`${home}/.teams-ai/config.json`, JSON.stringify({ paths: { workspaces: `${home}/ws`, runs: `${home}/runs`, secrets: `${home}/secrets` }, projects: [] }));
  script = {};
  spawns = [];
  registered = [];
  spawnShouldFail = false;
  const control: RunControlDeps = {
    spawn: (a) => {
      spawns.push({ args: a.args, logFile: a.logFile });
      // The registry now waits for the child's journal before returning; simulate the child writing it immediately,
      // unless the test wants to simulate a child that dies on preconditions before ever writing one.
      const runId = a.args[a.args.indexOf('--run-id') + 1]!;
      const runDir = `${home}/runs/${runId}`;
      mkdirSync(runDir, { recursive: true });
      if (spawnShouldFail) writeFileSync(`${runDir}/ui.log`, 'preconditions failed:\n- docker daemon is not reachable\n');
      else writeFileSync(`${runDir}/events.ndjson`, '');
      return { pid: 5000 + spawns.length };
    },
    kill: () => !spawnShouldFail,
    sleep: async () => {},
    cliEntry: () => ({ bin: 'node', prefix: ['cli'] }),
    repoRoot: '/repo',
  };
  registry = new SessionRegistry({
    cfg: async () => (await readUserConfig(home)).cfg,
    home,
    runAgent: makeFakeRunAgent(script),
    secretsDir: `${home}/secrets`,
    exec: execCommand,
    projectDir: async (projectId) => (registered.find((d) => d.includes(`/${projectId}/refine/`)) ?? null),
    control,
    runsDir: async () => `${home}/runs`,
    register: async (dir) => { registered.push(dir); },
  });
  api = await startApi({ routes: refineRoutes({ registry }) }, 0);
});
afterEach(async () => {
  await api.close();
  await registry.close();
  await remote?.cleanup();
  remote = null;
  await fs.rm(home, { recursive: true, force: true });
});

describe('refine api', () => {
  it('creates a new project draft, lists it, saves a doc, evaluates and streams the journal', async () => {
    expect((await call('POST', '/api/projects/new', { projectId: 'Bad Id', name: 'x' })).status).toBe(400);
    const created = await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ sessionId: 'hello-app/hello-app-001' });
    expect((await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' })).status).toBe(409);
    expect(await (await fetch(`${base()}/api/refine`)).json()).toEqual([{ projectId: 'hello-app', specId: 'hello-app-001', state: 'drafting', registered: false }]);
    expect((await call('PUT', '/api/refine/hello-app/hello-app-001/docs/spec.json', { text: 'x' })).status).toBe(400);
    expect((await call('PUT', '/api/refine/hello-app/hello-app-001/docs/brief.md', { text: '## Objectives\n- ship' })).status).toBe(200);
    script['derive/po'] = [derived];
    script['refine/po'] = [{ checklist: PO, questions: [{ id: 'q', text: 'Port?', blocking: true, relatedAcIds: [] }], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    expect((await call('POST', '/api/refine/hello-app/hello-app-001/evaluate')).status).toBe(202);
    const events = await fetch(`${base()}/api/refine/hello-app/hello-app-001/events`, { headers: { 'last-event-id': '1' } });
    const reader = events.body!.getReader();
    let text = '';
    while (!text.includes('REFINE_EVALUATED')) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).not.toContain('"seq":1,');
    expect(text).toContain('event: journal');
    const snap = await snapshot();
    expect(snap.state.status).toBe('answering');
    expect(snap.docs['brief.md']).toBe('## Objectives\n- ship');
    expect(snap.state.questions[0]).toMatchObject({ questionId: 'po-c1-0', blocking: true });
    expect((await call('POST', '/api/refine/hello-app/hello-app-001/questions/po-c1-0/skip')).status).toBe(409);
    expect((await call('POST', '/api/refine/hello-app/hello-app-001/answers', { questionId: 'po-c1-0', text: '8080' })).status).toBe(200);
    expect((await call('POST', '/api/refine/hello-app/hello-app-001/answers', { questionId: 'po-c1-0', text: '8080' })).status).toBe(409);
    expect((await call('POST', '/api/refine/hello-app/hello-app-001/answers', { questionId: 'nope', text: 'x' })).status).toBe(404);
  });

  it('new spec and continue spec copy docs from the project clone and enforce status rules', async () => {
    const spec = { ...makeSpec({ specId: 'hello-001' }), status: 'awaiting-validation', specHash: `sha256:${'a'.repeat(64)}` };
    remote = await makeRemote({ 'docs/project.json': JSON.stringify(HELLO_PROJECT), 'docs/specs/hello-001/spec.json': JSON.stringify(spec) });
    await fs.mkdir(`${home}/ws/hello-app`, { recursive: true });
    await fs.cp(remote.repo, `${home}/ws/hello-app/repo`, { recursive: true });
    expect((await call('POST', '/api/projects/hello-app/specs', { specId: 'hello-001' })).status).toBe(409);
    const ns = await call('POST', '/api/projects/hello-app/specs', { specId: 'hello-002' });
    expect(ns.status).toBe(200);
    const snap = await (await fetch(`${base()}/api/refine/hello-app/hello-002`)).json();
    expect(snap.docs['project.md']).toContain('## Personas');
    expect((await call('POST', '/api/projects/hello-app/specs/hello-002/continue')).status).toBe(409);
    const cont = await call('POST', '/api/projects/hello-app/specs/hello-001/continue', { report: 'broken /hello' });
    expect(cont.status).toBe(200);
    const snap2 = await (await fetch(`${base()}/api/refine/hello-app/hello-001`)).json();
    expect(snap2.docs['brief.md']).toContain('broken /hello');
    expect(snap2.state.derived.spec.status).toBe('refining');
  });

  it('writes a listed secret without echoing it', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    expect((await call('PUT', '/api/refine/hello-app/hello-app-001/secrets/DB_URL', { value: 'x' })).status).toBe(404);
    script['derive/po'] = [{ ...derived, spec: { ...derived.spec, externalDependencies: [{ name: 'db', purpose: 'p', secretNames: ['DB_URL'] }] } }];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    await call('POST', '/api/refine/hello-app/hello-app-001/evaluate');
    await settle();
    const put = await call('PUT', '/api/refine/hello-app/hello-app-001/secrets/DB_URL', { value: 'postgres://secret' });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ present: true, hint: 'cret' });
    expect((await call('PUT', '/api/refine/hello-app/hello-app-001/secrets/DB_URL', { value: '' })).status).toBe(400);
    expect(await fs.readFile(`${home}/secrets/DB_URL`, 'utf8')).toBe('postgres://secret');
  });

  it('start freezes the spec, spawns run --draft with the draft root, registers it, and refuses when stale', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    expect((await call('POST', '/api/refine/hello-app/hello-app-001/start')).status).toBe(409);
    script['derive/po'] = [derived];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    await call('POST', '/api/refine/hello-app/hello-app-001/evaluate');
    await settle();
    expect((await snapshot()).state.status).toBe('ready');
    await call('PUT', '/api/refine/hello-app/hello-app-001/docs/brief.md', { text: '## Objectives\n- changed' });
    expect((await call('POST', '/api/refine/hello-app/hello-app-001/start')).status).toBe(409); // stale
    expect(spawns).toHaveLength(0);
    script['derive/po'] = [derived];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    await call('POST', '/api/refine/hello-app/hello-app-001/evaluate');
    await settle();
    const started = await call('POST', '/api/refine/hello-app/hello-app-001/start');
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ runId: 'hello-app-001-r1' });
    const draftRoot = `${home}/ws/hello-app/refine/hello-app-001`;
    expect(spawns[0]!.args).toEqual(['cli', 'run', '--project', draftRoot, '--spec', 'hello-app-001', '--run-id', 'hello-app-001-r1', '--draft']);
    expect(registered).toEqual([draftRoot]);
    const spec = JSON.parse(await fs.readFile(`${draftRoot}/docs/specs/hello-app-001/spec.json`, 'utf8'));
    expect(spec).toMatchObject({ status: 'running', specVersion: 1 });
    expect(spec.specHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await fs.readFile(`${home}/runs/hello-app-001-r1/pid`, 'utf8')).toBe('5001');
    expect((await snapshot()).state).toMatchObject({ status: 'started', runId: 'hello-app-001-r1' });
    expect((await call('POST', '/api/refine/hello-app/hello-app-001/evaluate')).status).toBe(409);
  });

  it('two concurrent start requests spawn exactly one run', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    script['derive/po'] = [derived];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    await call('POST', '/api/refine/hello-app/hello-app-001/evaluate');
    await settle();
    const [a, b] = await Promise.all([call('POST', '/api/refine/hello-app/hello-app-001/start'), call('POST', '/api/refine/hello-app/hello-app-001/start')]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(spawns).toHaveLength(1);
    expect(registered).toHaveLength(1);
  });

  it('a child that dies before writing its journal reports 500 with the log tail and leaves the session retryable', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    script['derive/po'] = [derived];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    await call('POST', '/api/refine/hello-app/hello-app-001/evaluate');
    await settle();
    spawnShouldFail = true;
    const failed = await call('POST', '/api/refine/hello-app/hello-app-001/start');
    expect(failed.status).toBe(500);
    expect((await failed.json()).error).toContain('docker daemon is not reachable');
    expect((await snapshot()).state.status).toBe('ready'); // never got to StartedRun; not stuck as 'started'

    spawnShouldFail = false;
    const retried = await call('POST', '/api/refine/hello-app/hello-app-001/start');
    expect(retried.status).toBe(200); // the earlier failure must not leave the session locked with 'a start is already in progress'
    expect(spawns).toHaveLength(2);
  });
});
