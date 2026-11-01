import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { refineRoutes } from '../../server/api/refine-routes.js';
import { runRoutes } from '../../server/api/run-routes.js';
import type { RunControlDeps } from '../../server/api/run-control.js';
import { startApi } from '../../server/api/server.js';
import { execCommand } from '../../server/exec/command.js';
import { readUserConfig } from '../../server/onboarding/config-store.js';
import type { RunAgent } from '../../server/refine/cycle.js';
import { SessionRegistry } from '../../server/refine/registry.js';
import { EventStore } from '../../server/store/event-store.js';
import { makePlanTask, makeProject } from '../fixtures/contracts.js';
import { makeFakeRunAgent, type Script } from '../fixtures/fake-run-agent.js';

// Browser end to end: the real API serves the built UI, the refinement and run routes are the real ones, and only the
// agents are scripted. The owner starts a backlog, stops its run on the run page, sees every screen say it stopped,
// resumes it, and sees the card run again. Drives the system Chrome (CHROME_PATH overrides it); no browser download.

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// The vitest setup points HOME at a temporary home, and Chrome refuses to start with that override: launch it with the real one.
const CHROME_ENV = { ...process.env, HOME: os.userInfo().homedir, USERPROFILE: os.userInfo().homedir };
const HELLO_PROJECT = makeProject({ projectId: 'hello-app' });
const PO = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions'].map((id) => ({ id, passed: true, detail: 'ok' }));
const SM = ['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'].map((id) => ({ id, passed: true, detail: 'ok' }));
const DRAFT = 'hello-app-001';
/** A plan that passes the shape check for one item: its header, one task naming the criteria, and an assumption with its reason. */
const planFor = (key: string, ids: string[]): string =>
  `# ${key} Implementation Plan\n\n**Goal:** Build ${key}.\n\n**Architecture:** One module.\n\n**Tech Stack:** TypeScript.\n\n**Spec:** docs/specs/${key}/spec.md.\n\n## Global Constraints\n\n- The stack values of stack.md.\n\n## Review Focus\n\n- A repeated submit writes once.\n\n### Task 1: ${key} core\n\n**Files:**\n- Create: \`src/${key}.ts\`\n\n**Criteria:** ${ids.join(', ')}\n\n## Assumptions\n\n- None.\n`;

let home = '';
let api: { port: number; close(): Promise<void> };
let registry: SessionRegistry;
let script: Script;
let registered: string[];
let pidSeq: number;
let browser: Browser;
const base = () => `http://127.0.0.1:${api.port}`;
const call = (method: string, p: string, body?: unknown) =>
  fetch(`${base()}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const snapshot = async () => (await fetch(`${base()}/api/refine/hello-app/${DRAFT}`)).json();
const settle = async () => {
  for (let i = 0; i < 100; i++) {
    const snap = await snapshot();
    if (snap.state && !snap.busy && snap.state.status !== 'evaluating') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 30));
};

/** The plan preparation every start waits for: one plan step per backlog item, each writing its plan file. */
async function preparePlans(url: string): Promise<void> {
  const { backlog } = (await snapshot()).state;
  const items = [...backlog.items]
    .sort((a: { rank: number }, b: { rank: number }) => a.rank - b.rank)
    .map((i: { key: string }) => ({ key: i.key, ids: (backlog.specs[i.key].spec.acceptanceCriteria as Array<{ id: string }>).map((c) => c.id) }));
  script['speckit/dev'] = items.map(({ key, ids }) => ({ status: 'done', summary: 'ok', files: [`docs/specs/${key}/implementation-plan.md`], questions: [], content: planFor(key, ids) }));
  await call('POST', `${url}/plans`);
  await settle();
}

/** Points the config at the draft roots the registry registered, so the hub and the run routes see the project. */
async function registerProjects(): Promise<void> {
  const config = JSON.parse(await fs.readFile(`${home}/.teams-ai/config.json`, 'utf8'));
  config.projects = registered.map((dir) => ({ dir }));
  await fs.writeFile(`${home}/.teams-ai/config.json`, JSON.stringify(config));
}

/** Drives the real backlog flow to a started program, with the agents scripted, and returns the first item's run. */
async function startBacklog(): Promise<string> {
  await call('POST', '/api/projects/new', { projectId: 'hello-app', name: 'Hello' });
  const url = `/api/refine/hello-app/${DRAFT}`;
  await call('POST', `${url}/backlog`);
  const items = [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S' }];
  script['backlog/po'] = [{ project: HELLO_PROJECT, backlog: { epics: [{ key: 'core', title: 'Core' }], items } }];
  script['refine/po'] = [{ checklist: PO, questions: [], docPatch: [] }];
  script['refine/sm'] = [{ checklist: SM, questions: [], docPatch: [] }];
  script['spec/po'] = [{ specs: [{ key: 'base', objectives: ['Base no ar'], features: ['Saúde'], acceptanceCriteria: [{ id: 'AC-001', given: 'o serviço no ar', when: 'GET /health', then: '200', smoke: true }], outOfScope: [], externalDependencies: [] }] }];
  script['preplan/sm'] = [{ preplans: [{ key: 'base', modules: [{ name: 'core', purpose: 'p' }], tasks: [{ id: 'P1', title: 'Esqueleto', module: 'core', owner: 'devops', criteriaRefs: ['AC-001'], dependsOn: [] }], risks: [] }] }];
  await call('POST', `${url}/evaluate`);
  await settle();
  await preparePlans(url);
  const started = await call('POST', `${url}/start`);
  expect(started.status).toBe(200);
  const { runId } = (await started.json()) as { runId: string };
  await registerProjects();
  // A live run has a state snapshot and its start in the journal; the spawn fake only creates the empty journal.
  const runDir = path.join(home, 'runs', runId);
  await fs.writeFile(path.join(runDir, 'state.json'), JSON.stringify({ runId, status: 'running', at: new Date().toISOString(), tasks: [], tokens: {} }));
  const store = await EventStore.open({ file: path.join(runDir, 'events.ndjson'), runId, specHash: 'sha256:e2e' });
  await store.append({ type: 'RUN_STARTED', data: { runId, specId: 'base', projectId: 'hello-app' } });
  // Two tasks in flight, as the owner's run had: one implementing and one reviewing.
  const task = (id: string) => makePlanTask({ id, criteriaRefs: ['AC-001'], affectedPaths: [`src/${id}`] });
  await store.append({ type: 'TASK_PLANNED', data: { task: task('T21'), replan: false } });
  await store.append({ type: 'TASK_PLANNED', data: { task: task('T22'), replan: false } });
  for (const [taskId, to] of [['T21', 'ready'], ['T21', 'implementing'], ['T22', 'ready'], ['T22', 'implementing'], ['T22', 'validating'], ['T22', 'reviewing']]) {
    await store.append({ type: 'TASK_STATE_CHANGED', data: { taskId, to } });
  }
  await store.close();
  return runId;
}

/** Waits until some element matching the selector shows the text. */
const waitText = (page: Page, selector: string, text: string) =>
  page.waitForFunction((sel: string, t: string) => [...document.querySelectorAll(sel)].some((e) => (e.textContent ?? '').includes(t)), { timeout: 20_000 }, selector, text);

/** Clicks a control once it is on screen. */
const clickWhenVisible = async (page: Page, selector: string) => {
  await page.waitForSelector(selector, { visible: true, timeout: 20_000 });
  await page.click(selector);
};

/** Width the page overflows its viewport by; zero means no horizontal scroll. */
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

beforeAll(async () => {
  execSync('npm run build', { cwd: path.resolve('web'), stdio: 'pipe' });
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, env: CHROME_ENV });
}, 300_000);

afterAll(async () => {
  await browser?.close();
});

beforeEach(async () => {
  home = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-e2e-'))).replace(/\\/g, '/');
  await fs.mkdir(`${home}/.teams-ai`, { recursive: true });
  await fs.writeFile(`${home}/.teams-ai/config.json`, JSON.stringify({ paths: { workspaces: `${home}/ws`, runs: `${home}/runs`, secrets: `${home}/secrets` }, projects: [] }));
  script = {};
  registered = [];
  pidSeq = 5000;
  const fakeAgent = makeFakeRunAgent(script);
  // The run stays alive until the owner stops it: the stop route signals the group, and the fake process never exits by itself.
  const control: RunControlDeps = {
    spawn: (a) => {
      const runId = a.args[a.args.indexOf('--run-id') + 1]!;
      const dir = `${home}/runs/${runId}`;
      mkdirSync(dir, { recursive: true });
      // The journal exists before spawn returns; a resumed run keeps the journal it already wrote.
      if (!existsSync(`${dir}/events.ndjson`)) writeFileSync(`${dir}/events.ndjson`, '');
      pidSeq += 1;
      return { pid: pidSeq };
    },
    kill: () => true,
    sleep: async () => {},
    cliEntry: () => ({ bin: 'node', prefix: ['cli'] }),
    repoRoot: '/repo',
  };
  registry = new SessionRegistry({
    repositoryFlow: false,
    cfg: async () => (await readUserConfig(home)).cfg,
    home,
    runAgent: fakeAgent as RunAgent,
    secretsDir: `${home}/secrets`,
    exec: (spec) => (spec.bin === 'specify' ? Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1, truncated: false }) : execCommand(spec)),
    scoreDocs: async (_docs, files = []) => ({
      available: true,
      model: 'fake-jev',
      average: 0.8,
      docs: Object.fromEntries(files.map((file) => [file, { score: 0.8, checks: { complete: 0.8, concrete: 0.8, consistent: 0.8, scoped: 0.8 } }])),
      usage: null,
    }),
    projectDir: async (projectId) => registered.find((d) => d.includes(`/${projectId}/refine/`)) ?? null,
    control,
    runsDir: async () => `${home}/runs`,
    register: async (dir) => {
      registered.push(dir);
    },
    routeReport: async () => ({ route: 'unclear', confidence: 0.9, source: 'jev' }),
  });
  const cfg = async () => (await readUserConfig(home)).cfg;
  api = await startApi(
    {
      routes: [...refineRoutes({ registry }), ...runRoutes({ cfg, home, control })],
      staticDir: path.resolve('web/dist'),
    },
    0,
  );
});

afterEach(async () => {
  await api.close();
  await registry.close();
  // Windows keeps a handle on a file for a moment after the server closes: retry the removal, as the service tests do.
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('a stopped backlog run, end to end in the browser', () => {
  it('reads as interrupted on the card, the list, the hub and the run page, and runs again once resumed', async () => {
    const runId = await startBacklog();
    const program = `${base()}/refine/hello-app/${DRAFT}/program`;
    const runPage = `${base()}/runs/${runId}`;
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1440, height: 900 });
      // While the process lives, the card and the list say the backlog runs.
      await page.goto(program);
      await waitText(page, '[role="status"]', 'Executando o backlog');
      await waitText(page, '[data-testid="program-item-base"]', 'em execução');

      // The owner presses Parar execução on the run page.
      await page.goto(runPage);
      await waitText(page, '[data-testid="task-active"]', '2 em andamento');
      await clickWhenVisible(page, '[data-testid="stop"]');
      await waitText(page, '[data-testid="status"]', 'interrompida');
      // The two tasks in flight are interrupted now: none is counted as running.
      await waitText(page, '[data-testid="task-interrupted"]', '2 interrompidas');
      expect(await page.$('[data-testid="task-active"]')).toBeNull();

      // Every screen now says it stopped.
      await page.goto(program);
      await waitText(page, '[role="status"]', 'Backlog interrompido');
      await waitText(page, '[data-testid="program-item-base"]', 'interrompida');
      await page.goto(`${base()}/projects/hello-app`);
      await waitText(page, '[role="status"]', 'Backlog interrompido');

      // The stopped card fits a phone without horizontal scroll.
      await page.setViewport({ width: 390, height: 844 });
      await page.goto(program);
      await waitText(page, '[role="status"]', 'Backlog interrompido');
      expect(await overflow(page)).toBe(0);

      // The owner resumes on the run page; the card runs again.
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(runPage);
      await clickWhenVisible(page, '[data-testid="resume"]');
      await waitText(page, '[data-testid="status"]', 'em execução');
      await page.goto(program);
      await waitText(page, '[role="status"]', 'Executando o backlog');
    } finally {
      await page.close();
    }
  }, 240_000);
});
