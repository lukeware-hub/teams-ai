import { mkdirSync, promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { refineRoutes } from '../../server/api/refine-routes.js';
import type { RunControlDeps } from '../../server/api/run-control.js';
import { startApi } from '../../server/api/server.js';
import { execCommand } from '../../server/exec/command.js';
import { readUserConfig } from '../../server/onboarding/config-store.js';
import type { RunAgent } from '../../server/refine/cycle.js';
import { SessionRegistry } from '../../server/refine/registry.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';
import { calls, makeFakeRunAgent, type Script } from '../fixtures/fake-run-agent.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

let home = '';
let spawnShouldFail = false;
let registerShouldFail = false;
let failLog = '';
let api: { port: number; close(): Promise<void> };
let registry: SessionRegistry;
let script: Script;
let remote: Remote | null = null;
let fakeAgent: RunAgent;
let hangAgent: boolean;
let agentStarted: boolean;
let spawns: Array<{ args: string[]; logFile: string }>;
let registered: string[];
const base = () => `http://127.0.0.1:${api.port}`;
const call = (method: string, p: string, body?: unknown) =>
  fetch(`${base()}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const snapshot = async () => (await fetch(`${base()}/api/refine/hello-app/hello-app-001`)).json();
const settle = async () => {
  for (let i = 0; i < 100; i++) {
    const snap = await snapshot();
    if (!snap.busy && snap.state.status !== 'evaluating') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 30)); // the session clears `busy` a tick after the last event lands
};
const HELLO_PROJECT = makeProject({ projectId: 'hello-app' });
const derived = { project: HELLO_PROJECT, spec: { ...makeSpec(), status: 'refining', specHash: null } };
const PO = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions'].map((id) => ({ id, passed: true, detail: 'ok' }));
const SM = ['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'].map((id) => ({ id, passed: true, detail: 'ok' }));

beforeEach(async () => {
  home = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-refapi-'))).replace(/\\/g, '/');
  await fs.mkdir(`${home}/.teams-ai`, { recursive: true });
  await fs.writeFile(`${home}/.teams-ai/config.json`, JSON.stringify({ paths: { workspaces: `${home}/ws`, runs: `${home}/runs`, secrets: `${home}/secrets` }, projects: [] }));
  script = {};
  fakeAgent = makeFakeRunAgent(script);
  hangAgent = false;
  agentStarted = false;
  spawns = [];
  registered = [];
  spawnShouldFail = false;
  registerShouldFail = false;
  failLog ='preconditions failed:\n- docker daemon is not reachable\n';
  const control: RunControlDeps = {
    spawn: (a) => {
      spawns.push({ args: a.args, logFile: a.logFile });
      // The registry now waits for the child's journal before returning; simulate the child writing it immediately,
      // unless the test wants to simulate a child that dies on preconditions before ever writing one.
      const runId = a.args[a.args.indexOf('--run-id') + 1]!;
      const runDir = `${home}/runs/${runId}`;
      mkdirSync(runDir, { recursive: true });
      if (spawnShouldFail) writeFileSync(`${runDir}/ui.log`, failLog);
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
    runAgent: ((req, ctx) => {
      if (!hangAgent) return fakeAgent(req, ctx);
      return new Promise((resolve) => {
        agentStarted = true;
        ctx.signal?.addEventListener('abort', () => resolve({ ok: false, failure: 'timeout', errors: ['aborted'], summary: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, durationMs: 0, numTurns: 0, rateLimit: null }, sandboxDisabled: false } as never));
      });
    }) as RunAgent,
    secretsDir: `${home}/secrets`,
    exec: execCommand,
    projectDir: async (projectId) => (registered.find((d) => d.includes(`/${projectId}/refine/`)) ?? null),
    control,
    runsDir: async () => `${home}/runs`,
    register: async (dir) => {
      if (registerShouldFail) throw new Error('config.json is broken');
      registered.push(dir);
    },
    routeReport: async (_criteria, report) => ({ route: report.includes('/hello') ? 'bug-existing-ac' : 'unclear', confidence: 0.9, source: 'jev' }),
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
  it('suggests readable ids and creates a project with the suggested first spec', async () => {
    expect((await call('POST', '/api/names/suggest', { kind: 'bogus', description: 'x' })).status).toBe(400);
    expect((await call('POST', '/api/names/suggest', { kind: 'project', name: '', description: '' })).status).toBe(400);
    script['name/po'] = [{ id: 'order-service', firstSpecId: 'place-order' }];
    const suggested = await call('POST', '/api/names/suggest', { kind: 'project', name: 'Pedidos', description: 'Serviço de pedidos' });
    expect(await suggested.json()).toEqual({ id: 'order-service', firstSpecId: 'place-order' });
    const created = await call('POST', '/api/projects/new', { projectId: 'order-service', name: 'Pedidos', firstSpecId: 'place-order' });
    expect(await created.json()).toEqual({ sessionId: 'order-service/place-order' });
    script['name/po'] = [{ id: 'place-order' }];
    const spec = await call('POST', '/api/names/suggest', { kind: 'spec', projectId: 'order-service', description: 'fazer pedido' });
    expect(await spec.json()).toEqual({ id: 'place-order-2' });
  });
  it('creates a new project draft, lists it, saves a doc, evaluates and streams the journal', async () => {
    expect((await call('POST', '/api/projects/new', { projectId: 'Bad Id', name: 'x' })).status).toBe(400);
    const created = await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ sessionId: 'hello-app/hello-app-001' });
    expect((await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' })).status).toBe(409);
    expect((await call('POST', '/api/projects/new', { projectId: 'other-app', name: 'Other', description: 'x'.repeat(20_001) })).status).toBe(400);
    expect((await call('POST', '/api/projects/new', { projectId: 'other-app', name: 'Other', description: 'x'.repeat(20_001) })).status).toBe(400);
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
    expect(snap.docs['brief.md']).toBe('## Objectives\n- ship\n');
    expect(snap.state.questions[0]).toMatchObject({ questionId: 'po-c1-0', blocking: true });
    expect((await call('POST', '/api/refine/hello-app/hello-app-001/questions/po-c1-0/skip')).status).toBe(409);
    expect((await call('POST', '/api/refine/hello-app/hello-app-001/answers', { questionId: 'po-c1-0', text: '8080', docsAnswered: true })).status).toBe(200);
    const after = await fetch(`${base()}/api/refine/hello-app/hello-app-001/events`, { headers: { 'last-event-id': '1' } });
    const answered = after.body!.getReader();
    let journal = '';
    while (!journal.includes('QUESTION_ANSWERED')) journal += new TextDecoder().decode((await answered.read()).value);
    await answered.cancel();
    expect(journal).toContain('"docsAnswered":true');
    expect((await call('POST', '/api/refine/hello-app/hello-app-001/answers', { questionId: 'po-c1-0', text: '8080' })).status).toBe(409);
    expect((await call('POST', '/api/refine/hello-app/hello-app-001/answers', { questionId: 'nope', text: 'x' })).status).toBe(404);
  });

  it('starts the backlog of an imported project once, in backlog mode', async () => {
    hangAgent = true;
    remote = await makeRemote({
      'docs/project.md': '# Hello\n',
      'docs/project.json': JSON.stringify(HELLO_PROJECT),
      'docs/briefing.md': '## Objetivos\n- entregar\n',
      'docs/stack.md': '# Stack\n',
      'docs/flow.md': '# Fluxo\n',
      'docs/design.md': '# Design\n',
    });
    await fs.mkdir(`${home}/ws/hello-app`, { recursive: true });
    await execCommand({ bin: 'git', args: ['clone', '-q', remote.origin, `${home}/ws/hello-app/repo`], cwd: home, env: {}, timeoutMs: 60_000 });
    await registry.startImportedBacklog('hello-app');
    await registry.startImportedBacklog('hello-app');
    expect((await (await fetch(`${base()}/api/refine`)).json()).map((r: { specId: string }) => r.specId)).toEqual(['hello-app-backlog']);
    const session = await registry.get('hello-app', 'hello-app-backlog');
    expect(session.state.mode).toBe('backlog');
    expect(session.state.backlog?.enabled).toBe(true);
  });
  it('suggests a document from flow.md without saving it', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    const url = '/api/refine/hello-app/hello-app-001/docs';
    expect((await call('POST', `${url}/flow.md/suggest`)).status).toBe(400);
    expect((await call('POST', `${url}/stack.md/suggest`)).status).toBe(409);
    await call('PUT', `${url}/flow.md`, { text: '# Fluxo\n\nCliente se cadastra com nome e e-mail.' });
    const before = (await snapshot()).docs['stack.md'];
    script['suggest/sm'] = [{ text: '# Stack\n\n## Runtime\n\n- Node.js' }];
    const res = await call('POST', `${url}/stack.md/suggest`);
    expect(await res.json()).toEqual({ text: '# Stack\n\n## Runtime\n\n- Node.js' });
    expect(calls.at(-1)?.prompt).toContain('Cliente se cadastra com nome e e-mail.');
    expect(calls.at(-1)?.prompt).toContain('then docs/flow.md, then the rest');
    expect((await snapshot()).docs['stack.md']).toBe(before);
  });

  it('adjusts design.md from template images without saving, and deletes the images', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    const url = '/api/refine/hello-app/hello-app-001/docs/design.md/images';
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]).toString('base64');
    const before = (await snapshot()).docs['design.md'];
    script['suggest/po'] = [{ text: '# Design\n\nAzul #0055ff' }];
    const res = await call('POST', url, { images: [{ data: png }] });
    expect(await res.json()).toEqual({ text: '# Design\n\nAzul #0055ff' });
    expect(calls.at(-1)?.prompt).toMatch(/\.attach-[^/]+\/1\.png/);
    expect((await snapshot()).docs['design.md']).toBe(before);
    const draft = `${home}/ws/hello-app/refine/hello-app-001`;
    expect((await fs.readdir(draft)).filter((n) => n.startsWith('.attach-'))).toEqual([]);
    expect((await call('POST', url, { images: [{ data: Buffer.from('GIF89a').toString('base64') }] })).status).toBe(400);
    expect((await call('POST', url, { images: [] })).status).toBe(400);
  });

  it('concurrent first reads of a draft share one session instead of failing on the journal lock', async () => {
    expect((await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' })).status).toBe(200);
    await registry.close();
    const [a, b] = await Promise.all([registry.get('hello-app', 'hello-app-001'), registry.get('hello-app', 'hello-app-001')]);
    expect(a).toBe(b);
    expect((await fetch(`${base()}/api/refine/hello-app/hello-app-001`)).status).toBe(200);
  });

  it('backlog mode: enabling is idempotent, an evaluation derives the backlog, and starting waits for the next step', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    const url = '/api/refine/hello-app/hello-app-001';
    expect((await call('POST', `${url}/backlog`)).status).toBe(200);
    expect((await call('POST', `${url}/backlog`)).status).toBe(200);
    expect((await snapshot()).state.backlog).toMatchObject({ enabled: true, items: [] });
    // The brief became the target project's docs/briefing.md, and the session still opens from disk afterwards.
    const draftDocs = `${home}/ws/hello-app/refine/hello-app-001/docs`;
    expect(await fs.readFile(`${draftDocs}/briefing.md`, 'utf8')).toBe((await snapshot()).docs['brief.md']);
    await expect(fs.access(`${draftDocs}/specs/hello-app-001`)).rejects.toThrow();
    await registry.close();
    expect((await fetch(`${base()}${url}`)).status).toBe(200);
    const items = [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S' }];
    script['backlog/po'] = [{ project: HELLO_PROJECT, backlog: { epics: [{ key: 'core', title: 'Core' }], items } }];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    expect((await call('POST', `${url}/evaluate`)).status).toBe(202);
    await settle();
    const snap = await snapshot();
    expect(snap.state.status).toBe('ready');
    expect(snap.state.backlog.items).toEqual([expect.objectContaining({ key: 'base', rank: 1, priority: 'P0' })]);
    expect(snap.state.derived).toBeNull();
    const start = await call('POST', `${url}/start`);
    expect(start.status).toBe(409);
    expect(JSON.stringify(await start.json())).toMatch(/backlog/i);
    expect(spawns).toEqual([]);
    expect((await call('POST', '/api/refine/hello-app/nope-001/backlog')).status).toBe(404);
  });

  it('backlog detailing: refused until the outline is ready, then every item gets a spec and a pre-plan and the session is ready', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    const url = '/api/refine/hello-app/hello-app-001';
    expect((await call('POST', `${url}/backlog`)).status).toBe(200);
    expect((await call('POST', `${url}/backlog/detail`)).status).toBe(409);
    const items = [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S' }];
    script['backlog/po'] = [{ project: HELLO_PROJECT, backlog: { epics: [{ key: 'core', title: 'Core' }], items } }];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }, { checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }, { checklist: SM, questions: [], docPatch: [] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    expect((await snapshot()).state.status).toBe('ready');
    expect((await call('POST', `${url}/backlog/detail`)).status).toBe(200);
    expect((await call('POST', `${url}/backlog/detail`)).status).toBe(200);
    script['spec/po'] = [{ specs: [{ key: 'base', objectives: ['Base no ar'], features: ['Saúde'], acceptanceCriteria: [{ id: 'AC-001', given: 'o serviço no ar', when: 'GET /health', then: '200', smoke: true }], outOfScope: [], externalDependencies: [] }] }];
    script['preplan/sm'] = [{ preplans: [{ key: 'base', modules: [{ name: 'core', purpose: 'p' }], tasks: [{ id: 'P1', title: 'Esqueleto', module: 'core', owner: 'devops', criteriaRefs: ['AC-001'], dependsOn: [] }], risks: [] }] }];
    // The docs did not change, so the outline is not asked again: there is no second backlog answer scripted.
    expect((await call('POST', `${url}/evaluate`)).status).toBe(202);
    await settle();
    const snap = await snapshot();
    expect(snap.state.error).toBeNull();
    expect(snap.state.status).toBe('ready');
    expect(snap.state.backlog).toMatchObject({ detail: true, specs: { base: { specId: 'base', spec: { acceptanceCriteria: [{ id: 'AC-001' }] } } }, preplans: { base: { preplan: { tasks: [{ id: 'P1' }] } } } });
    const dir = `${home}/ws/hello-app/refine/hello-app-001/docs/specs/base`;
    expect(JSON.parse(await fs.readFile(`${dir}/spec.json`, 'utf8')).status).toBe('planned');
    // Detailed and ready: Start now starts the program, which freezes and launches the first item.
    const started = await call('POST', `${url}/start`);
    expect(started.status).toBe(200);
    const body = await started.json();
    expect(body.runId).toMatch(/^hello-app--base--run-\d+$/);
    expect(body.program.items).toEqual([expect.objectContaining({ key: 'base', specId: 'base', status: 'running', runId: body.runId })]);
    expect(spawns.at(-1)!.args).toEqual(expect.arrayContaining(['run', '--spec', 'base', '--run-id', body.runId, '--draft']));
    const frozen = JSON.parse(await fs.readFile(`${dir}/spec.json`, 'utf8'));
    expect(frozen).toMatchObject({ status: 'running', specVersion: 1 });
    expect(frozen.specHash).toMatch(/^sha256:/);
    expect(JSON.parse(await fs.readFile(`${home}/ws/hello-app/refine/hello-app-001/program.json`, 'utf8')).items[0].runId).toBe(body.runId);
    expect(registered).toContain(`${home}/ws/hello-app/refine/hello-app-001`);
    expect((await (await fetch(`${base()}${url}/program`)).json()).program.items[0].status).toBe('running');
    expect((await (await fetch(`${base()}${url}/program`)).json()).program.items[0].prs).toEqual([]);
    expect(await (await fetch(`${base()}${url}/program/decisions`)).json()).toEqual({ decisions: [], unanswered: 0 });
    // The docs are read-only from now on, and a second start does not launch another run.
    expect((await snapshot()).state.status).toBe('started');
    expect((await call('POST', `${url}/evaluate`)).status).toBe(409);
    expect((await call('POST', `${url}/start`)).status).toBe(409);
    expect(spawns).toHaveLength(1);

    // R11.4 continuation: the item failed verification; retry clears it and launches a new run.
    const programFile = `${home}/ws/hello-app/refine/hello-app-001/program.json`;
    const failedProgram = JSON.parse(await fs.readFile(programFile, 'utf8'));
    failedProgram.status = 'finished';
    failedProgram.items[0] = { ...failedProgram.items[0], status: 'failed', reason: 'verification-failed: AC-002 missing', finishedAt: new Date().toISOString() };
    await fs.writeFile(programFile, JSON.stringify(failedProgram, null, 2));
    const retried = await call('POST', `${url}/program/base/retry`);
    expect(retried.status).toBe(200);
    const retriedBody = await retried.json();
    expect(retriedBody.program.items[0]).toMatchObject({ status: 'running', reason: null });
    expect(retriedBody.program.items[0].runId).not.toBe(body.runId);
    expect(spawns).toHaveLength(2);

    // From the project page, a spec the program still has pending is prioritized there, never launched loose.
    expect(await registry.queueInProgram('hello-app', 'base')).toBeNull(); // running: nothing to queue
    const pending = JSON.parse(await fs.readFile(programFile, 'utf8'));
    pending.items[0] = { ...pending.items[0], status: 'pending', runId: null };
    await fs.writeFile(programFile, JSON.stringify(pending, null, 2));
    expect(await registry.queueInProgram('hello-app', 'base')).toEqual({ draftId: 'hello-app-001' });
    expect(spawns).toHaveLength(3);
    // A failed item runs again through its program; a blocked one says why it waits.
    const again = JSON.parse(await fs.readFile(programFile, 'utf8'));
    again.status = 'finished';
    again.items[0] = { ...again.items[0], status: 'failed', reason: 'verification-failed' };
    await fs.writeFile(programFile, JSON.stringify(again, null, 2));
    expect(await registry.queueInProgram('hello-app', 'base')).toEqual({ draftId: 'hello-app-001' });
    expect(spawns).toHaveLength(4);
    // A waiting item runs now through its program, never as a loose run beside it.
    again.status = 'running';
    again.items[0] = { ...again.items[0], status: 'waiting', reason: 'docker daemon down', retryAt: '2999-01-01T00:00:00.000Z', waits: 1 };
    await fs.writeFile(programFile, JSON.stringify(again, null, 2));
    expect(await registry.queueInProgram('hello-app', 'base')).toEqual({ draftId: 'hello-app-001' });
    expect(spawns).toHaveLength(5);
    again.items[0] = { ...again.items[0], status: 'blocked', reason: 'depends on x, which failed' };
    await fs.writeFile(programFile, JSON.stringify(again, null, 2));
    expect(await registry.queueInProgram('hello-app', 'base')).toEqual({ refused: 'A spec base está bloqueada no programa: depends on x, which failed. Rode antes a spec da qual ela depende.' });
    const prioritized = await call('POST', `${url}/program/base/prioritize`);
    expect(prioritized.status).toBe(400); // running now, so no longer pending
  });

  it('a program whose first run cannot launch leaves no ledger and the session able to start again', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    const url = '/api/refine/hello-app/hello-app-001';
    await call('POST', `${url}/backlog`);
    const items = [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S' }];
    script['backlog/po'] = [{ project: HELLO_PROJECT, backlog: { epics: [{ key: 'core', title: 'Core' }], items } }];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }, { checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }, { checklist: SM, questions: [], docPatch: [] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    await call('POST', `${url}/backlog/detail`);
    script['spec/po'] = [{ specs: [{ key: 'base', objectives: ['Base no ar'], features: ['Saúde'], acceptanceCriteria: [{ id: 'AC-001', given: 'o serviço no ar', when: 'GET /health', then: '200', smoke: true }], outOfScope: [], externalDependencies: [] }] }];
    script['preplan/sm'] = [{ preplans: [{ key: 'base', modules: [{ name: 'core', purpose: 'p' }], tasks: [{ id: 'P1', title: 'Esqueleto', module: 'core', owner: 'devops', criteriaRefs: ['AC-001'], dependsOn: [] }], risks: [] }] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    spawnShouldFail = true;
    const failed = await call('POST', `${url}/start`);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).toMatch(/nenhuma run/);
    await expect(fs.access(`${home}/ws/hello-app/refine/hello-app-001/program.json`)).rejects.toThrow();
    expect(await fs.readdir(`${home}/runs`).catch(() => [])).toEqual([]); // the failed launch left no run directory
    expect((await snapshot()).state.status).toBe('ready');
    spawnShouldFail = false;
    expect((await call('POST', `${url}/start`)).status).toBe(200);
  });

  // Plan 80 review: main retired this spec while this draft kept it; being in the backlog means the owner wants it again.
  it('starts an item whose spec main retired meanwhile, frozen from planned', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    const url = '/api/refine/hello-app/hello-app-001';
    await call('POST', `${url}/backlog`);
    const items = [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S' }];
    script['backlog/po'] = [{ project: HELLO_PROJECT, backlog: { epics: [{ key: 'core', title: 'Core' }], items } }];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }, { checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }, { checklist: SM, questions: [], docPatch: [] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    await call('POST', `${url}/backlog/detail`);
    script['spec/po'] = [{ specs: [{ key: 'base', objectives: ['Base no ar'], features: ['Saúde'], acceptanceCriteria: [{ id: 'AC-001', given: 'o serviço no ar', when: 'GET /health', then: '200', smoke: true }], outOfScope: [], externalDependencies: [] }] }];
    script['preplan/sm'] = [{ preplans: [{ key: 'base', modules: [{ name: 'core', purpose: 'p' }], tasks: [{ id: 'P1', title: 'Esqueleto', module: 'core', owner: 'devops', criteriaRefs: ['AC-001'], dependsOn: [] }], risks: [] }] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    const file = `${home}/ws/hello-app/refine/hello-app-001/docs/specs/base/spec.json`;
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), status: 'retired' }));
    expect((await call('POST', `${url}/start`)).status).toBe(200);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ status: 'running', specVersion: 1 });
  });

  // R11.7.6: the owner's answer about a criterion travels with the item spec the program freezes.
  it('freezes an item with the answers to the questions about its criteria, and only those', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    const url = '/api/refine/hello-app/hello-app-001';
    await call('POST', `${url}/backlog`);
    const items = [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S' }];
    script['backlog/po'] = [{ project: HELLO_PROJECT, backlog: { epics: [{ key: 'core', title: 'Core' }], items } }];
    const asked = [{ id: 'q1', text: 'O health responde em JSON?', blocking: false, relatedAcIds: ['AC-001'] }, { id: 'q2', text: 'Qual o nome do produto?', blocking: false, relatedAcIds: [] }];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }, { checklist: PO, questions: asked, docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }, { checklist: SM, questions: [], docPatch: [] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    await call('POST', `${url}/backlog/detail`);
    script['spec/po'] = [{ specs: [{ key: 'base', objectives: ['Base no ar'], features: ['Saúde'], acceptanceCriteria: [{ id: 'AC-001', given: 'o serviço no ar', when: 'GET /health', then: '200', smoke: true }], outOfScope: [], externalDependencies: [] }] }];
    script['preplan/sm'] = [{ preplans: [{ key: 'base', modules: [{ name: 'core', purpose: 'p' }], tasks: [{ id: 'P1', title: 'Esqueleto', module: 'core', owner: 'devops', criteriaRefs: ['AC-001'], dependsOn: [] }], risks: [] }] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    for (const q of (await snapshot()).state.questions) {
      await call('POST', `${url}/answers`, { questionId: q.questionId, text: q.text.includes('JSON') ? 'Sim, application/json.' : 'Hello.' });
    }
    // Plan 90: the answers went into the briefing, so the backlog is evaluated again before it starts; no spec cites them.
    expect((await call('POST', `${url}/start`)).status).toBe(409);
    script['backlog/po'] = [{ project: HELLO_PROJECT, backlog: { epics: [{ key: 'core', title: 'Core' }], items } }];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    expect((await call('POST', `${url}/start`)).status).toBe(200);
    const file = `${home}/ws/hello-app/refine/hello-app-001/docs/specs/base/spec.json`;
    expect(JSON.parse(await fs.readFile(file, 'utf8')).decisions).toEqual([{ question: 'O health responde em JSON?', answer: 'Sim, application/json.' }]);
  });

  // Plan 84 review: a start whose launch failed leaves the item frozen in the draft; an answer given since must still reach it.
  it('freezes an item again with an answer given after a failed start', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    const url = '/api/refine/hello-app/hello-app-001';
    await call('POST', `${url}/backlog`);
    const items = [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S' }];
    script['backlog/po'] = [{ project: HELLO_PROJECT, backlog: { epics: [{ key: 'core', title: 'Core' }], items } }];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }, { checklist: PO, questions: [{ id: 'q1', text: 'O health responde em JSON?', blocking: false, relatedAcIds: ['AC-001'] }], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }, { checklist: SM, questions: [], docPatch: [] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    await call('POST', `${url}/backlog/detail`);
    script['spec/po'] = [{ specs: [{ key: 'base', objectives: ['Base no ar'], features: ['Saúde'], acceptanceCriteria: [{ id: 'AC-001', given: 'o serviço no ar', when: 'GET /health', then: '200', smoke: true }], outOfScope: [], externalDependencies: [] }] }];
    script['preplan/sm'] = [{ preplans: [{ key: 'base', modules: [{ name: 'core', purpose: 'p' }], tasks: [{ id: 'P1', title: 'Esqueleto', module: 'core', owner: 'devops', criteriaRefs: ['AC-001'], dependsOn: [] }], risks: [] }] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    spawnShouldFail = true;
    expect((await call('POST', `${url}/start`)).status).toBe(500);
    spawnShouldFail = false;
    const [q] = (await snapshot()).state.questions;
    await call('POST', `${url}/answers`, { questionId: q.questionId, text: 'Sim, application/json.' });
    // Plan 90: the answers went into the briefing, so the backlog is evaluated again before it starts; no spec cites them.
    expect((await call('POST', `${url}/start`)).status).toBe(409);
    script['backlog/po'] = [{ project: HELLO_PROJECT, backlog: { epics: [{ key: 'core', title: 'Core' }], items } }];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    expect((await call('POST', `${url}/start`)).status).toBe(200);
    const frozen = JSON.parse(await fs.readFile(`${home}/ws/hello-app/refine/hello-app-001/docs/specs/base/spec.json`, 'utf8'));
    expect(frozen).toMatchObject({ status: 'running', specVersion: 1, decisions: [{ question: 'O health responde em JSON?', answer: 'Sim, application/json.' }] });
  });

  it('starts a detailed backlog by itself once it is ready, and tries a failed start again only after a new cycle', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    const url = '/api/refine/hello-app/hello-app-001';
    await call('POST', `${url}/backlog`);
    const items = [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S' }];
    script['backlog/po'] = [{ project: HELLO_PROJECT, backlog: { epics: [{ key: 'core', title: 'Core' }], items } }];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }, { checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }, { checklist: SM, questions: [], docPatch: [] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    // An outline that is ready but not detailed never starts by itself.
    await registry.tickPrograms();
    expect(spawns).toHaveLength(0);
    await call('POST', `${url}/backlog/detail`);
    script['spec/po'] = [{ specs: [{ key: 'base', objectives: ['Base no ar'], features: ['Saúde'], acceptanceCriteria: [{ id: 'AC-001', given: 'o serviço no ar', when: 'GET /health', then: '200', smoke: true }], outOfScope: [], externalDependencies: [] }] }];
    script['preplan/sm'] = [{ preplans: [{ key: 'base', modules: [{ name: 'core', purpose: 'p' }], tasks: [{ id: 'P1', title: 'Esqueleto', module: 'core', owner: 'devops', criteriaRefs: ['AC-001'], dependsOn: [] }], risks: [] }] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    expect((await snapshot()).state.status).toBe('ready');
    spawnShouldFail = true;
    await registry.tickPrograms();
    await registry.tickPrograms();
    expect(spawns).toHaveLength(1);
    const failed = (await snapshot()).state;
    expect(failed.status).toBe('ready');
    // The reason is on the journal, so the screen shows it and a restarted server does not try again in this cycle either.
    expect(failed.autoStartFailure).toMatchObject({ cycle: failed.cycle, reason: expect.stringMatching(/nenhuma run/) });
    spawnShouldFail = false;
    await registry.tickPrograms();
    expect(spawns).toHaveLength(1);
    // A new cycle clears the failed mark: the next tick starts the program.
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    await registry.tickPrograms();
    expect((await snapshot()).state.status).toBe('started');
    expect(spawns).toHaveLength(2);
  });

  // R11.10 (plan 90): in backlog mode the owner's answer is written into the briefing, so it reaches the specs through the docs.
  it('writes an answer of a backlog into the briefing as its own decision, and asks for a new evaluation', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    const url = '/api/refine/hello-app/hello-app-001';
    await call('POST', `${url}/backlog`);
    const items = [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S' }];
    script['backlog/po'] = [{ project: HELLO_PROJECT, backlog: { epics: [{ key: 'core', title: 'Core' }], items } }];
    script['refine/po'] = [{ checklist: PO, questions: [{ id: 'q1', text: 'O health responde em JSON?', blocking: true, relatedAcIds: [] }], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    const [q] = (await snapshot()).state.questions;
    expect((await call('POST', `${url}/answers`, { questionId: q.questionId, text: 'Sim, application/json.' })).status).toBe(200);
    const after = await snapshot();
    expect(after.docs['brief.md']).toMatch(/\n## Decisões\n\n### O health responde em JSON\?\n\n> Sim, application\/json\.\n$/);
    expect(after.state.stale).toBe(true);
  });

  // R11.10 (plan 89): a suggestion still pending holds back only the auto-start; Iniciar starts without it and moves it to the history.
  it('waits for the owner to start a ready backlog with a pending suggestion, and drops the suggestion at the start', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    const url = '/api/refine/hello-app/hello-app-001';
    await call('POST', `${url}/backlog`);
    const items = [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S' }];
    script['backlog/po'] = [{ project: HELLO_PROJECT, backlog: { epics: [{ key: 'core', title: 'Core' }], items } }];
    const suggestion = { file: 'docs/briefing.md', find: '- <objective>', replace: '- Mostrar a saúde do serviço.', reason: 'objetivo concreto' };
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }, { checklist: PO, questions: [], docPatch: [suggestion] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }, { checklist: SM, questions: [], docPatch: [] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    await call('POST', `${url}/backlog/detail`);
    script['spec/po'] = [{ specs: [{ key: 'base', objectives: ['Base no ar'], features: ['Saúde'], acceptanceCriteria: [{ id: 'AC-001', given: 'o serviço no ar', when: 'GET /health', then: '200', smoke: true }], outOfScope: [], externalDependencies: [] }] }];
    script['preplan/sm'] = [{ preplans: [{ key: 'base', modules: [{ name: 'core', purpose: 'p' }], tasks: [{ id: 'P1', title: 'Esqueleto', module: 'core', owner: 'devops', criteriaRefs: ['AC-001'], dependsOn: [] }], risks: [] }] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    const ready = (await snapshot()).state;
    expect(ready.status).toBe('ready');
    expect(ready.patches.filter((p: { status: string }) => p.status === 'pending')).toHaveLength(1);
    await registry.tickPrograms();
    expect(spawns).toHaveLength(0);
    expect((await call('POST', `${url}/start`)).status).toBe(200);
    const started = (await snapshot()).state;
    expect(started.status).toBe('started');
    expect(started.patches[0]).toMatchObject({ status: 'dropped', decision: 'não aplicada: a execução começou sem ela' });
  });

  // Plan 90 review: once the owner decides the last suggestion, the program starts by itself again.
  it('starts a ready backlog by itself once its last pending suggestion is rejected', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    const url = '/api/refine/hello-app/hello-app-001';
    await call('POST', `${url}/backlog`);
    const items = [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S' }];
    script['backlog/po'] = [{ project: HELLO_PROJECT, backlog: { epics: [{ key: 'core', title: 'Core' }], items } }];
    const suggestion = { file: 'docs/briefing.md', find: '- <objective>', replace: '- Mostrar a saúde do serviço.', reason: 'objetivo concreto' };
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }, { checklist: PO, questions: [], docPatch: [suggestion] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }, { checklist: SM, questions: [], docPatch: [] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    await call('POST', `${url}/backlog/detail`);
    script['spec/po'] = [{ specs: [{ key: 'base', objectives: ['Base no ar'], features: ['Saúde'], acceptanceCriteria: [{ id: 'AC-001', given: 'o serviço no ar', when: 'GET /health', then: '200', smoke: true }], outOfScope: [], externalDependencies: [] }] }];
    script['preplan/sm'] = [{ preplans: [{ key: 'base', modules: [{ name: 'core', purpose: 'p' }], tasks: [{ id: 'P1', title: 'Esqueleto', module: 'core', owner: 'devops', criteriaRefs: ['AC-001'], dependsOn: [] }], risks: [] }] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    await registry.tickPrograms();
    expect(spawns).toHaveLength(0);
    const [p] = (await snapshot()).state.patches;
    expect((await call('POST', `${url}/patches/${p.patchId}/reject`, {})).status).toBe(200);
    await registry.tickPrograms();
    expect(spawns).toHaveLength(1);
    expect((await snapshot()).state.status).toBe('started');
  });

  it('refuses to detail an outline the docs changed after it was reviewed', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    const url = '/api/refine/hello-app/hello-app-001';
    await call('POST', `${url}/backlog`);
    const items = [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S' }];
    script['backlog/po'] = [{ project: HELLO_PROJECT, backlog: { epics: [{ key: 'core', title: 'Core' }], items } }];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    await call('POST', `${url}/evaluate`);
    await settle();
    expect((await snapshot()).state.status).toBe('ready');
    expect((await call('PUT', `${url}/docs/flow.md`, { text: '# Fluxo\n\nMudou depois do esboço.\n' })).status).toBe(200);
    expect((await snapshot()).state.stale).toBe(true);
    expect((await call('POST', `${url}/backlog/detail`)).status).toBe(409);
  });

  it('new spec and continue spec copy docs from the project clone and enforce status rules', async () => {
    const spec = { ...makeSpec({ specId: 'hello-001' }), status: 'awaiting-validation', specHash: `sha256:${'a'.repeat(64)}` };
    const concluded = { ...spec, specId: 'hello-009', status: 'done' };
    remote = await makeRemote({ 'docs/project.json': JSON.stringify(HELLO_PROJECT), 'docs/specs/hello-001/spec.json': JSON.stringify(spec), 'docs/specs/hello-009/spec.json': JSON.stringify(concluded) });
    await fs.mkdir(`${home}/ws/hello-app`, { recursive: true });
    await fs.cp(remote.repo, `${home}/ws/hello-app/repo`, { recursive: true });
    expect((await call('POST', '/api/projects/hello-app/specs', { specId: 'hello-001' })).status).toBe(409);
    const ns = await call('POST', '/api/projects/hello-app/specs', { specId: 'hello-002' });
    expect(ns.status).toBe(200);
    const snap = await (await fetch(`${base()}/api/refine/hello-app/hello-002`)).json();
    expect(snap.docs['project.md']).toContain('## Personas');
    expect((await call('POST', '/api/projects/hello-app/specs/hello-002/continue')).status).toBe(409);
    const closed = await call('POST', '/api/projects/hello-app/specs/hello-009/continue');
    expect(closed.status).toBe(409); // a concluded spec is read-only; the next delivery is a new spec
    expect((await closed.json()).error).toContain('concluded');
    const described = await call('POST', '/api/projects/hello-app/specs', { specId: 'hello-003', description: 'Greet in Portuguese too.' });
    expect(described.status).toBe(200);
    const snap3 = await (await fetch(`${base()}/api/refine/hello-app/hello-003`)).json();
    expect(snap3.docs['brief.md']).toMatch(/^## Description\n\nGreet in Portuguese too\.\n\n## Type/);
    expect((await call('POST', '/api/projects/hello-app/specs', { specId: 'hello-004', description: 'x'.repeat(20_001) })).status).toBe(400);
    expect((await call('POST', '/api/projects/hello-app/specs', { specId: 'hello-005', description: 42 })).status).toBe(400);
    const cont = await call('POST', '/api/projects/hello-app/specs/hello-001/continue', { report: 'broken /hello' });
    expect(cont.status).toBe(200);
    const snap2 = await (await fetch(`${base()}/api/refine/hello-app/hello-001`)).json();
    expect(snap2.docs['brief.md']).toContain('broken /hello');
    expect(snap2.docs['brief.md']).toContain('Routing (System 1, jev): bug-existing-ac (0.90)');
    expect(snap2.state.derived.spec.status).toBe('refining');
  });

  it('writes listed and custom secrets without echoing values', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    expect((await call('PUT', '/api/refine/hello-app/hello-app-001/secrets/CUSTOM_KEY', { value: 'x' })).status).toBe(200);
    script['derive/po'] = [{ ...derived, spec: { ...derived.spec, externalDependencies: [{ name: 'db', purpose: 'p', secretNames: ['DB_URL'] }] } }];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    await call('POST', '/api/refine/hello-app/hello-app-001/evaluate');
    await settle();
    const put = await call('PUT', '/api/refine/hello-app/hello-app-001/secrets/DB_URL', { value: 'postgres://secret' });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ present: true });
    expect((await call('PUT', '/api/refine/hello-app/hello-app-001/secrets/DB_URL', { value: '' })).status).toBe(400);
    expect(await fs.readFile(`${home}/ws/hello-app/secrets/DB_URL`, 'utf8')).toBe('postgres://secret');
    expect((await (await fetch(`${base()}/api/refine/hello-app/hello-app-001`)).json()).secrets).toEqual([
      { name: 'CUSTOM_KEY', present: true, hint: '****' },
      { name: 'DB_URL', present: true, hint: '****' },
    ]);
  });

  it('lists a secret an external dependency needs even before it is saved', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    script['derive/po'] = [{ ...derived, spec: { ...derived.spec, externalDependencies: [{ name: 'db', purpose: 'p', secretNames: ['DB_URL'] }] } }];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    await call('POST', '/api/refine/hello-app/hello-app-001/evaluate');
    await settle();
    expect((await (await fetch(`${base()}/api/refine/hello-app/hello-app-001`)).json()).secrets).toEqual([{ name: 'DB_URL', present: false, hint: null }]);
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
    expect(await started.json()).toEqual({ runId: 'hello-app--hello-app-001--run-1' });
    const draftRoot = `${home}/ws/hello-app/refine/hello-app-001`;
    expect(spawns[0]!.args).toEqual(['cli', 'run', '--project', draftRoot, '--spec', 'hello-app-001', '--run-id', 'hello-app--hello-app-001--run-1', '--draft']);
    expect(registered).toEqual([draftRoot]);
    const spec = JSON.parse(await fs.readFile(`${draftRoot}/docs/specs/hello-app-001/spec.json`, 'utf8'));
    expect(spec).toMatchObject({ status: 'running', specVersion: 1 });
    expect(spec.specHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await fs.readFile(`${home}/runs/hello-app--hello-app-001--run-1/pid`, 'utf8')).toBe('5001');
    expect((await snapshot()).state).toMatchObject({ status: 'started', runId: 'hello-app--hello-app-001--run-1' });
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

  it('restart spec discards an existing draft and reopens from main, with or without a draft', async () => {
    const spec = { ...makeSpec({ specId: 'hello-001' }), status: 'awaiting-validation', specHash: `sha256:${'a'.repeat(64)}` };
    const open = { ...spec, specId: 'hello-002', status: 'planned' };
    remote = await makeRemote({ 'docs/project.json': JSON.stringify(HELLO_PROJECT), 'docs/specs/hello-001/spec.json': JSON.stringify(spec), 'docs/specs/hello-002/spec.json': JSON.stringify(open) });
    await fs.mkdir(`${home}/ws/hello-app`, { recursive: true });
    await fs.cp(remote.repo, `${home}/ws/hello-app/repo`, { recursive: true });
    const draftRoot = `${home}/ws/hello-app/refine/hello-001`;
    expect((await call('POST', '/api/projects/hello-app/specs/hello-001/restart')).status).toBe(200); // no draft yet
    await fs.writeFile(`${draftRoot}/stale.txt`, 'old');
    expect((await call('POST', '/api/projects/hello-app/specs/hello-001/restart')).status).toBe(200);
    expect(await fs.access(`${draftRoot}/stale.txt`).then(() => true, () => false)).toBe(false);
    expect(await fs.access(`${draftRoot}/docs/specs/hello-001/brief.md`).then(() => true, () => false)).toBe(true);
    expect((await call('POST', '/api/projects/hello-app/specs/hello-002/restart')).status).toBe(409); // only awaiting-validation specs
  });

  it('continue spec reopens a draft still refining and replaces one whose run already started', async () => {
    const spec = { ...makeSpec({ specId: 'hello-001' }), status: 'awaiting-validation', specHash: `sha256:${'a'.repeat(64)}` };
    remote = await makeRemote({ 'docs/project.json': JSON.stringify(HELLO_PROJECT), 'docs/specs/hello-001/spec.json': JSON.stringify(spec) });
    await fs.mkdir(`${home}/ws/hello-app`, { recursive: true });
    await fs.cp(remote.repo, `${home}/ws/hello-app/repo`, { recursive: true });
    const url = '/api/projects/hello-app/specs/hello-001/continue';
    const stale = `${home}/ws/hello-app/refine/hello-001/stale.txt`;
    const has = (file: string) => fs.access(file).then(() => true, () => false);
    expect((await call('POST', url)).status).toBe(200);
    await fs.writeFile(stale, 'old');
    expect((await call('POST', url)).status).toBe(200); // a draft still refining is reopened as it is
    expect(await has(stale)).toBe(true);
    const withReport = await call('POST', url, { report: 'broken /hello' });
    expect(withReport.status).toBe(409); // the report would be lost in a draft already refining
    expect((await withReport.json()).error).toContain('Reiniciar');
    await (await registry.get('hello-app', 'hello-001')).markStarted('hello-app--hello-001--run-1');
    expect((await call('POST', url, { report: 'broken /hello' })).status).toBe(200); // the run is over: a fresh draft from main
    expect(await has(stale)).toBe(false);
    const snap = await (await fetch(`${base()}/api/refine/hello-app/hello-001`)).json();
    expect(snap.state.status).not.toBe('started');
    expect(snap.docs['brief.md']).toContain('broken /hello');
  });

  it('deletes a draft that never started, refuses a started one, and 404s a missing one', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    const draftRoot = `${home}/ws/hello-app/refine/hello-app-001`;
    expect(await fs.access(draftRoot).then(() => true, () => false)).toBe(true);
    const del = await call('DELETE', '/api/refine/hello-app/hello-app-001');
    expect(del.status).toBe(200);
    expect(await fs.access(draftRoot).then(() => true, () => false)).toBe(false);
    expect((await fetch(`${base()}/api/refine`)).status).toBe(200);
    expect(await (await fetch(`${base()}/api/refine`)).json()).toEqual([]);
    expect((await call('DELETE', '/api/refine/hello-app/hello-app-001')).status).toBe(404);

    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    script['derive/po'] = [derived];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    await call('POST', '/api/refine/hello-app/hello-app-001/evaluate');
    await settle();
    await call('POST', '/api/refine/hello-app/hello-app-001/start');
    expect((await call('DELETE', '/api/refine/hello-app/hello-app-001')).status).toBe(409);
    expect(await fs.access(draftRoot).then(() => true, () => false)).toBe(true);
  });

  it('force-deletes a draft whose evaluation is running, aborting only that session', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    await call('POST', '/api/projects/new', { projectId: 'other-app', name: 'Other' });
    hangAgent = true;
    expect((await call('POST', '/api/refine/hello-app/hello-app-001/evaluate')).status).toBe(202);
    for (let i = 0; i < 100 && !agentStarted; i++) await new Promise((r) => setTimeout(r, 20));
    expect(agentStarted).toBe(true);
    expect((await call('DELETE', '/api/refine/hello-app/hello-app-001')).status).toBe(200);
    expect(await fs.access(`${home}/ws/hello-app/refine/hello-app-001`).then(() => true, () => false)).toBe(false);
    expect(await fs.access(`${home}/ws/other-app/refine/other-app-001`).then(() => true, () => false)).toBe(true);
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
    await expect(fs.access(`${home}/runs/hello-app--hello-app-001--run-1`)).rejects.toThrow(); // no empty run left to list

    spawnShouldFail = false;
    const retried = await call('POST', '/api/refine/hello-app/hello-app-001/start');
    expect(retried.status).toBe(200); // the earlier failure must not leave the session locked with 'a start is already in progress'
    expect(spawns).toHaveLength(2);
  });

  it('redacts a secret in the log tail of a start that failed (audit M3)', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    script['derive/po'] = [derived];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    await call('POST', '/api/refine/hello-app/hello-app-001/evaluate');
    await settle();
    await fs.mkdir(`${home}/secrets`, { recursive: true });
    await fs.writeFile(`${home}/secrets/DB_PASSWORD`, 'p@ss w0rd!');
    failLog = 'fail p@ss w0rd!\n';
    spawnShouldFail = true;
    const failed = await call('POST', '/api/refine/hello-app/hello-app-001/start');
    expect(failed.status).toBe(500);
    const text = JSON.stringify(await failed.json());
    expect(text).not.toContain('p@ss');
    expect(text).toContain('[REDACTED]');
  });

  it('a failure after the child wrote its journal stops the run and leaves the session retryable', async () => {
    await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
    script['derive/po'] = [derived];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    await call('POST', '/api/refine/hello-app/hello-app-001/evaluate');
    await settle();
    registerShouldFail = true;
    const failed = await call('POST', '/api/refine/hello-app/hello-app-001/start');
    expect(failed.status).toBe(500);
    expect((await failed.json()).error).toContain('config.json is broken');
    expect((await snapshot()).state.status).toBe('ready');
    await expect(fs.access(`${home}/runs/hello-app--hello-app-001--run-1`)).rejects.toThrow();
    registerShouldFail = false;
    expect((await call('POST', '/api/refine/hello-app/hello-app-001/start')).status).toBe(200);
  });

  it('a refinement retrieves the earlier specs of the project clone that match its objectives', async () => {
    const spec = { ...makeSpec({ specId: 'hello-001' }), status: 'awaiting-validation', specHash: `sha256:${'a'.repeat(64)}` };
    remote = await makeRemote({ 'docs/project.json': JSON.stringify(HELLO_PROJECT), 'docs/specs/hello-001/spec.json': JSON.stringify(spec), 'docs/specs/hello-001/spec.md': '# Spec 1\nThe quota checker uses marker zebracorn-7741.\n' });
    await fs.mkdir(`${home}/ws/hello-app`, { recursive: true });
    await fs.cp(remote.repo, `${home}/ws/hello-app/repo`, { recursive: true });
    expect((await call('POST', '/api/projects/hello-app/specs', { specId: 'hello-002' })).status).toBe(200);
    script['derive/po'] = [{ ...derived, spec: { ...derived.spec, objectives: ['Track the quota per tenant'] } }];
    script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }];
    script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
    calls.length = 0;
    expect((await call('POST', '/api/refine/hello-app/hello-002/evaluate')).status).toBe(202);
    const isPo = (c: { kind: string; role: string }) => c.kind === 'refine' && c.role === 'po';
    for (let i = 0; i < 100 && !calls.some(isPo); i++) await new Promise((r) => setTimeout(r, 20));
    expect(calls.find(isPo)?.prompt).toContain('zebracorn-7741');
  });

  it('a broken config.json never rejects the program tick, which would kill the UI server', async () => {
    await fs.writeFile(`${home}/.teams-ai/config.json`, '{');
    await expect(registry.tickPrograms()).resolves.toBeUndefined();
  });
});
