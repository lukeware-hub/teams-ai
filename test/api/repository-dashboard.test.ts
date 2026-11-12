import { describe, expect, it } from 'vitest';
import { buildDashboard, dashboardPage, type DashboardInput, type DashboardRun, type DashboardSpecInput, type DashboardTable } from '../../server/api/repository-dashboard.js';
import { DEPENDENCY_BLOCKED } from '../../server/pipeline/task-state.js';
import type { StoredEvent } from '../../server/store/event-store.js';

const page = <K extends DashboardTable>(input: DashboardInput, table: K) => dashboardPage(input, table, { page: 1, size: 100, q: '', facet: '', sort: null, dir: 'asc' });

let seq = 0;
const AT = '2026-11-01T10:00:00.000Z';
const ev = (runId: string, type: string, data: Record<string, unknown> = {}, at = AT): StoredEvent => ({ seq: ++seq, at, runId, specHash: 'h', type, kind: 'fact', data });
const task = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Tarefa ${id}`, description: 'faz a parte', criteriaRefs: [], dependsOn: [], affectedPaths: ['src/app.ts'], owner: 'dev', origin: 'plan', ...extra });
const planned = (runId: string, id: string, extra: Record<string, unknown> = {}) => ev(runId, 'TASK_PLANNED', { task: task(id, extra) });
const to = (runId: string, taskId: string, state: string) => ev(runId, 'TASK_STATE_CHANGED', { taskId, to: state });
const run = (runId: string, specId: string, n: number, status: string, events: StoredEvent[], extra: Partial<DashboardRun> = {}): DashboardRun => ({ runId, specId, kind: 'run', n, status, at: events.at(-1)?.at ?? null, cost: 0, stopped: false, events, ...extra });
const spec = (specId: string, extra: Partial<DashboardSpecInput> = {}): DashboardSpecInput => ({ specId, title: null, priority: null, status: 'running', tasks: 0, plan: false, blocked: false, activeRunId: null, ...extra });
const input = (extra: Partial<DashboardInput> = {}): DashboardInput => ({ specs: [], runs: [], questions: [], missingSecrets: [], programStops: [], ...extra });
const states = (d: ReturnType<typeof buildDashboard>) => Object.fromEntries(d.tasks.list.map((t) => [t.taskId, t.state]));

describe('task states across runs', () => {
  it('counts a task delivered in an earlier run once, even when a successor run delivers it again', () => {
    const first = run('cart-run-1', 'cart', 1, 'complete', [planned('cart-run-1', 'T1-route'), to('cart-run-1', 'T1-route', 'merged')]);
    const second = run('cart-run-2', 'cart', 2, 'complete', [planned('cart-run-2', 'T1-route'), to('cart-run-2', 'T1-route', 'merged')]);
    const inp = input({ specs: [spec('cart', { tasks: 1 })], runs: [first, second] });
    const d = buildDashboard(inp);
    expect(d.counts).toMatchObject({ tasks: 1, delivered: 1, progress: 100 });
    expect(d.tasks.list).toHaveLength(1);
  });

  it('lets a merge in one run beat a block of the same task in a later run', () => {
    const first = run('cart-run-1', 'cart', 1, 'complete', [planned('cart-run-1', 'T1-route'), to('cart-run-1', 'T1-route', 'merged')]);
    const second = run('cart-run-2', 'cart', 2, 'blocked', [planned('cart-run-2', 'T1-route'), ev('cart-run-2', 'TASK_BLOCKED', { taskId: 'T1-route', reason: 'o banco recusou a conexão' }), to('cart-run-2', 'T1-route', 'blocked')]);
    const inp = input({ specs: [spec('cart', { tasks: 1 })], runs: [first, second] });
    const d = buildDashboard(inp);
    expect(states(d)).toEqual({ 'T1-route': 'delivered' });
  });

  it('splits a dependency or an owner decision from a block on the task itself', () => {
    const events = [
      planned('r1', 'T1-a'),
      planned('r1', 'T2-b'),
      planned('r1', 'T3-c'),
      to('r1', 'T1-a', 'blocked'),
      ev('r1', 'TASK_BLOCKED', { taskId: 'T1-a', reason: DEPENDENCY_BLOCKED }),
      to('r1', 'T2-b', 'blocked'),
      ev('r1', 'TASK_BLOCKED', { taskId: 'T2-b', reason: 'a verificação pediu uma decisão' }),
      ev('r1', 'DECISION_REQUESTED', { taskId: 'T2-b', question: 'Qual caminho?', options: [] }),
      to('r1', 'T3-c', 'blocked'),
      ev('r1', 'TASK_BLOCKED', { taskId: 'T3-c', reason: 'o banco recusou a conexão' }),
    ];
    const inp = input({ specs: [spec('cart', { tasks: 3 })], runs: [run('r1', 'cart', 1, 'blocked', events)] });
    const d = buildDashboard(inp);
    expect(states(d)).toEqual({ 'T1-a': 'blocked', 'T2-b': 'blocked', 'T3-c': 'failed' });
    expect(page(inp, 'failures').list.map((f) => f.taskId)).toEqual(['T3-c']);
    expect(page(inp, 'blockers').list.filter((b) => b.kind === 'task').map((b) => b.taskId)).toEqual(['T1-a', 'T2-b']);
  });

  it('counts a task on a live run as running and on a finished run as pending', () => {
    const live = run('r1', 'cart', 1, 'running', [planned('r1', 'T1-a'), to('r1', 'T1-a', 'ready'), to('r1', 'T1-a', 'implementing')]);
    const done = run('r2', 'pay', 1, 'paused:quota', [planned('r2', 'T1-b'), to('r2', 'T1-b', 'ready'), to('r2', 'T1-b', 'implementing')]);
    const inp = input({ specs: [spec('cart', { tasks: 1 }), spec('pay', { tasks: 1 })], runs: [live, done] });
    const d = buildDashboard(inp);
    expect(d.counts).toMatchObject({ running: 1, pending: 1 });
    expect(page(inp, 'blockers').list.map((b) => b.text)).toEqual(['Run r2 pausada: limite de uso dos modelos']);
  });

  it('a missing secret blocker carries what it is, what it is for and where it is used', () => {
    const inp = input({ missingSecrets: ['A_KEY', 'B_KEY'], secretInfo: { A_KEY: { what: 'Chave', purpose: 'Cobrar', usage: 'Pagamentos', mentions: ['stack.md › Pagamentos'] } } });
    const secrets = page(inp, 'blockers').list.filter((b) => b.kind === 'secret').map((b) => b.secret);
    expect(secrets).toEqual([
      { name: 'A_KEY', what: 'Chave', purpose: 'Cobrar', usage: 'Pagamentos', mentions: ['stack.md › Pagamentos'] },
      { name: 'B_KEY', what: null, purpose: null, usage: null, mentions: [] },
    ]);
  });

  it('counts a superseded task nowhere and its replacements instead', () => {
    const events = [planned('r1', 'T1-route'), ev('r1', 'TASK_REPLANNED', { taskId: 'T1-route', replacements: [task('T1-a'), task('T1-b')] })];
    const inp = input({ specs: [spec('cart', { tasks: 1 })], runs: [run('r1', 'cart', 1, 'running', events)] });
    const d = buildDashboard(inp);
    expect(d.counts.tasks).toBe(2);
    expect(d.tasks.list.map((t) => t.taskId)).toEqual(['T1-a', 'T1-b']);
  });

  it('counts the tasks a spec has not planned yet as not started', () => {
    const inp = input({ specs: [spec('cart', { status: 'planned', tasks: 4, plan: true })] });
    const d = buildDashboard(inp);
    expect(d.counts).toMatchObject({ tasks: 4, pending: 4, delivered: 0 });
    expect(d.specs[0]?.state).toBe('pending');
  });

  it('counts a spec delivered before journals existed as delivered', () => {
    const inp = input({ specs: [spec('old', { status: 'done', tasks: 3 })] });
    const d = buildDashboard(inp);
    expect(d.counts).toMatchObject({ tasks: 3, delivered: 3, progress: 100, specsDelivered: 1 });
  });

  it('lists a journal that does not replay as a failure instead of counting its tasks as not started', () => {
    const broken = run('r1', 'cart', 1, 'running', [to('r1', 'T1-a', 'implementing')]);
    const inp = input({ specs: [spec('cart', { tasks: 1 })], runs: [broken] });
    const d = buildDashboard(inp);
    expect(page(inp, 'failures').list).toEqual([{ kind: 'run', specId: 'cart', runId: 'r1', taskId: null, text: 'Run r1: journal não pôde ser lido' }]);
    expect(d.counts.pending).toBe(1);
  });

  it('reads zeros and no progress for a repository with no specs', () => {
    const inp = input({ specs: [spec('x', { status: 'refining' })] });
    const d = buildDashboard(inp);
    expect(d.counts).toMatchObject({ tasks: 0, runs: 0, progress: null });
    expect(d.specs[0]?.state).toBe('not-started');
  });

  it('drops a failed task of an older run that the newest run does not carry, and keeps the merged ones', () => {
    const old = run('cart-run-1', 'cart', 1, 'phase-failed', [
      planned('cart-run-1', 'T1-route'),
      planned('cart-run-1', 'T2-pay'),
      to('cart-run-1', 'T1-route', 'merged'),
      to('cart-run-1', 'T2-pay', 'blocked'),
      ev('cart-run-1', 'TASK_BLOCKED', { taskId: 'T2-pay', reason: 'o banco recusou a conexão' }),
    ]);
    const next = run('cart-run-2', 'cart', 2, 'done', [planned('cart-run-2', 'T1-route'), planned('cart-run-2', 'T3-ui'), to('cart-run-2', 'T3-ui', 'merged')]);
    const inp = input({ specs: [spec('cart', { tasks: 2 })], runs: [old, next] });
    const d = buildDashboard(inp);
    expect(states(d)).toEqual({ 'T1-route': 'delivered', 'T3-ui': 'delivered' });
    expect(d.counts).toMatchObject({ tasks: 2, delivered: 2, failed: 0 });
    expect(page(inp, 'failures').list).toEqual([]);
  });
});

describe('failed runs once the spec moves on', () => {
  it('lists a failed run as history when a newer run of the spec finished', () => {
    const failed = run('cart-run-1', 'cart', 1, 'phase-failed', []);
    const done = run('cart-run-2', 'cart', 2, 'done', []);
    const inp = input({ specs: [spec('cart')], runs: [failed, done] });
    const d = buildDashboard(inp);
    expect(page(inp, 'failures').list).toEqual([]);
  });

  it('keeps a failed run a failure while no newer run finished', () => {
    const done = run('cart-run-1', 'cart', 1, 'done', []);
    const failed = run('cart-run-2', 'cart', 2, 'phase-failed', []);
    const inp = input({ specs: [spec('cart')], runs: [done, failed] });
    const d = buildDashboard(inp);
    expect(page(inp, 'failures').list).toEqual([{ kind: 'run', specId: 'cart', runId: 'cart-run-2', taskId: null, text: 'Run cart-run-2: falhou em uma fase' }]);
  });
});

describe('activity from the journals', () => {
  it('sums each agent\'s steps, reads its files, tests and retries', () => {
    const events = [
      planned('r1', 'T1-route'),
      ev('r1', 'STEP_STARTED', { stepId: 's1', role: 'dev', kind: 'implement', taskId: 'T1-route' }),
      ev('r1', 'STEP_FINISHED', { stepId: 's1', ok: true, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.5, durationMs: 1000, kind: 'implement' }),
      ev('r1', 'STEP_STARTED', { stepId: 's2', role: 'test', kind: 'verify', taskId: 'T1-route' }),
      ev('r1', 'STEP_FINISHED', { stepId: 's2', ok: false, failure: 'x', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0, durationMs: 200, kind: 'verify' }),
      ev('r1', 'DEV_COMMITTED', { taskId: 'T1-route', changedFiles: ['src/a.ts', 'src/a.ts', 'src/b.ts'] }),
      ev('r1', 'GATE_FAILED', { taskId: 'T1-route', gate: 'unit', junit: [{ name: 'soma', status: 'passed' }, { name: 'subtrai', status: 'failed' }] }),
      ev('r1', 'ATTEMPT_CONSUMED', { taskId: 'T1-route' }),
      ev('r1', 'INFRA_RETRY', { taskId: 'T1-route', gate: 'unit' }),
    ];
    const inp = input({ specs: [spec('cart', { tasks: 1 })], runs: [run('r1', 'cart', 1, 'running', events)] });
    const d = buildDashboard(inp);
    const dev = page(inp, 'agents').list.find((a) => a.role === 'dev');
    const test = page(inp, 'agents').list.find((a) => a.role === 'test');
    expect(dev).toMatchObject({ steps: 1, ok: 1, failed: 0, tokens: 15, costUsd: 0.5, durationMs: 1000, files: 2, created: 1, tests: null });
    expect(test).toMatchObject({ steps: 1, failed: 1, tests: { passed: 1, failed: 1 }, created: null });
    expect(d.files.total).toBe(2);
    expect(d.tests).toMatchObject({ passed: 1, failed: 1 });
    expect(d.tests.failures.list).toEqual([{ taskId: 'T1-route', gate: 'unit', name: 'subtrai' }]);
    expect(d.retries).toMatchObject({ attempts: 1, infra: 1 });
  });

  it('gives the last deploy of the newest run that verified one', () => {
    const first = run('r1', 'cart', 1, 'done', [ev('r1', 'DEPLOY_VERIFIED', { url: 'http://localhost:3001', docsPath: '/docs' })]);
    const second = run('r2', 'cart', 2, 'done', [ev('r2', 'DEPLOY_VERIFIED', { url: 'http://localhost:3002', docsPath: '/docs' })]);
    const inp = input({ specs: [spec('cart')], runs: [second, first] });
    const d = buildDashboard(inp);
    expect(d.lastDeploy).toEqual({ runId: 'r2', specId: 'cart', url: 'http://localhost:3002', kind: null, docsPath: '/docs', healthcheckPath: null, services: null });
  });

  it('gives the kind the plan declared for the last deploy', () => {
    const api = run('r1', 'cart', 1, 'done', [ev('r1', 'DEPLOY_VERIFIED', { url: 'http://localhost:3001', kind: 'api' })]);
    const inp = input({ specs: [spec('cart')], runs: [api] });
    const d = buildDashboard(inp);
    expect(d.lastDeploy).toMatchObject({ kind: 'api', docsPath: null });
  });

  it('lists a failed run among the failures and pages the timeline newest first', () => {
    const events = Array.from({ length: 25 }, (_, i) => ev('r1', 'RUN_RESUMED', {}, `2026-11-01T10:${String(i).padStart(2, '0')}:00.000Z`));
    const inp = input({ specs: [spec('cart')], runs: [run('r1', 'cart', 1, 'phase-failed', events)] });
    expect(page(inp, 'failures').list).toEqual([{ kind: 'run', specId: 'cart', runId: 'r1', taskId: null, text: 'Run r1: falhou em uma fase' }]);
    const second = dashboardPage(inp, 'timeline', { page: 2, size: 10, q: '', facet: '', sort: null, dir: 'asc' });
    expect(second).toMatchObject({ total: 25, matched: 25, page: 2, pages: 3 });
    expect(second.list).toHaveLength(10);
    expect(second.list[0]!.at >= second.list[1]!.at).toBe(true);
  });
});

describe('the tasks table', () => {
  const tasksPage = (inp: DashboardInput, req: { page?: number; size?: number; q?: string; facet?: string } = {}) =>
    dashboardPage(inp, 'tasks', { page: req.page ?? 1, size: req.size ?? 100, q: req.q ?? '', facet: req.facet ?? '', sort: null, dir: 'asc' });
  const events = [
    planned('r1', 'T1-done'),
    to('r1', 'T1-done', 'merged'),
    planned('r1', 'T2-dep'),
    to('r1', 'T2-dep', 'blocked'),
    ev('r1', 'TASK_BLOCKED', { taskId: 'T2-dep', reason: DEPENDENCY_BLOCKED }),
    planned('r1', 'T3-bad'),
    to('r1', 'T3-bad', 'blocked'),
    ev('r1', 'TASK_BLOCKED', { taskId: 'T3-bad', reason: 'o banco recusou a conexão' }),
    planned('r1', 'T4-wait'),
  ];
  const inp = input({ specs: [spec('cart', { tasks: 4 })], runs: [run('r1', 'cart', 1, 'blocked', events)] });

  it('lists every task with its state and keeps the raw reason only for a task that did not finish', () => {
    const byId = Object.fromEntries(tasksPage(inp).list.map((t) => [t.taskId, t]));
    expect(byId['T1-done']).toMatchObject({ state: 'delivered', rawReason: null });
    expect(byId['T2-dep']).toMatchObject({ state: 'blocked', rawReason: DEPENDENCY_BLOCKED });
    expect(byId['T3-bad']).toMatchObject({ state: 'failed', rawReason: 'o banco recusou a conexão' });
    expect(byId['T4-wait']).toMatchObject({ state: 'pending', rawReason: null });
  });

  it('filters by state and searches by title', () => {
    expect(tasksPage(inp, { facet: 'failed' }).list.map((t) => t.taskId)).toEqual(['T3-bad']);
    expect(tasksPage(inp, { q: 'tarefa t2' }).list.map((t) => t.taskId)).toEqual(['T2-dep']);
    expect(tasksPage(inp).facets.sort()).toEqual(['blocked', 'delivered', 'failed', 'pending']);
  });

  it('lists the tasks of a spec no run has started yet, from its task list, as pending, without counting them twice', () => {
    const taskList = [
      { taskId: 'T1', title: 'Criar a rota de login' },
      { taskId: 'T2', title: 'Documentar a rota' },
    ];
    const pre = input({ specs: [spec('auth', { tasks: 2, taskList, status: 'pending' })] });
    expect(tasksPage(pre).list).toEqual([
      { specId: 'auth', runId: null, taskId: 'T1', title: 'Criar a rota de login', owner: '', state: 'pending', attempts: 0, reason: null, rawReason: null, pr: null },
      { specId: 'auth', runId: null, taskId: 'T2', title: 'Documentar a rota', owner: '', state: 'pending', attempts: 0, reason: null, rawReason: null, pr: null },
    ]);
    expect(buildDashboard(pre).counts).toMatchObject({ tasks: 2, pending: 2, delivered: 0 });
  });

  it('pages every task of a large repository, past the dashboard cap', () => {
    const many = Array.from({ length: 520 }, (_, i) => planned('r2', `T${i}`));
    const big = input({ specs: [spec('pay', { tasks: 520 })], runs: [run('r2', 'pay', 1, 'running', many)] });
    expect(tasksPage(big, { page: 2, size: 100 })).toMatchObject({ total: 520, matched: 520, page: 2, pages: 6 });
    expect(tasksPage(big, { page: 2, size: 100 }).list).toHaveLength(100);
  });
});
