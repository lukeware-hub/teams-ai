import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildChatContext } from '../../server/chat/context.js';
import { loadConfig } from '../../server/config/config.js';
import { makePlanTask, makeSpec } from '../fixtures/contracts.js';
import { writeRun, type FixtureEvent } from '../fixtures/runs/write-run.js';

const HELLO = path.resolve('test/fixtures/hello-app');
const GO_MOD = 'Gate install failed (code, exit 1)\n\nstderr (tail):\ngo: go.mod requires go >= 1.27.3 (running go 1.27.2; GOTOOLCHAIN=local)';
let home = '';
let runs = '';

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-record-'));
  runs = path.join(home, 'runs');
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const deps = (dir = HELLO) => ({ cfg: loadConfig({ paths: { runs: runs.split('\\').join('/') }, projects: [{ dir }] }), home, isAlive: () => false });
const context = async (dir?: string) => (await buildChatContext(deps(dir), 'hello-app'))!;
const started = (runId: string): FixtureEvent => ({ type: 'RUN_STARTED', data: { runId, specId: 'hello-001', projectId: 'hello-app' } });
const finished = (result: string, reason: string | null = null): FixtureEvent => ({ type: 'RUN_FINISHED', data: { result, reason, merged: [], blocked: [] } });
/** One task that planned, then blocked for the given reason. */
const blockedTask = (id: string, reason: string, title = `Tarefa ${id}`): FixtureEvent[] => [
  { type: 'TASK_PLANNED', data: { task: makePlanTask({ id, title }) } },
  { type: 'TASK_STATE_CHANGED', data: { taskId: id, to: 'blocked' } },
  { type: 'TASK_BLOCKED', data: { taskId: id, reason } },
];

describe('the failure record, in detail', () => {
  it('counts the tasks that wait on a cause through the tasks between them', async () => {
    const waiting = Array.from({ length: 12 }, (_, i) => makePlanTask({ id: `T${i + 2}-wait`, title: `Espera ${i}`, dependsOn: ['T1-root'] }));
    await writeRun(runs, 'hello-001-r1', [
      started('hello-001-r1'),
      ...blockedTask('T1-root', GO_MOD, 'Raiz'),
      ...waiting.flatMap((task) => [
        { type: 'TASK_PLANNED', data: { task } },
        { type: 'TASK_STATE_CHANGED', data: { taskId: task.id, to: 'blocked' } },
        { type: 'TASK_BLOCKED', data: { taskId: task.id, reason: 'a dependency is blocked' } },
      ]),
      finished('blocked'),
    ]);
    const { text } = await context();
    expect(text).toContain('12 esperam por ela');
    expect(text).not.toContain('a dependency is blocked');
  });

  it('names the tasks that wait on a task the plan replaced, apart from the causes', async () => {
    await writeRun(runs, 'hello-001-r1', [
      started('hello-001-r1'),
      { type: 'TASK_PLANNED', data: { task: makePlanTask({ id: 'T1-old', title: 'Antiga' }) } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-old', to: 'ready' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-old', to: 'implementing' } },
      { type: 'TASK_REPLANNED', data: { taskId: 'T1-old', replacements: [makePlanTask({ id: 'T1-old-r1', title: 'Nova' })] } },
      { type: 'TASK_PLANNED', data: { task: makePlanTask({ id: 'T2-doomed', title: 'Dependente', dependsOn: ['T1-old'] }) } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T2-doomed', to: 'blocked' } },
      { type: 'TASK_BLOCKED', data: { taskId: 'T2-doomed', reason: 'a dependency is blocked' } },
      finished('blocked'),
    ]);
    const { text } = await context();
    expect(text).toContain('Tarefas que dependem de uma tarefa substituída: 1.');
  });

  it('shows the three causes that hold most tasks, and points to the record for the rest', async () => {
    const events: FixtureEvent[] = [started('hello-001-r1')];
    for (let i = 0; i < 40; i++) events.push(...blockedTask(`T${i + 1}-cause`, `Falha distinta número ${i}: motivo ${i}`, `Tarefa ${i}`));
    await writeRun(runs, 'hello-001-r1', [...events, finished('blocked')]);
    const { text } = await context();
    expect(text).toContain('Mais 37 causa(s): veja falhas/hello-001.md.');
    expect(text).toContain('\n3. ');
    expect(text).not.toContain('\n4. ');
  });

  it('states since when a cause holds its tasks, and how many attempts they spent', async () => {
    await writeRun(runs, 'hello-001-r1', [
      started('hello-001-r1'),
      ...blockedTask('T1-since', 'Falha desde cedo', 'Desde').map((e) => (e.type === 'TASK_BLOCKED' ? { ...e, at: '2026-09-25T08:30:00.000Z' } : e)),
      finished('blocked'),
    ]);
    const { text } = await context();
    expect(text).toContain('Desde 2026-09-25 08:30 UTC; 0 tentativa(s).');
  });

  it('reads the phase that failed in its plain words', async () => {
    await writeRun(runs, 'hello-001-r1', [
      started('hello-001-r1'),
      { type: 'PHASE_FAILED', data: { phase: 1, reason: 'Phase 1 exhausted: the tech spec left criteria out' } },
      finished('phase-failed', 'Phase 1 exhausted: the tech spec left criteria out'),
    ]);
    const { text, details } = await context();
    expect(details.get('hello-001')).toContain('A execução parou na fase 1 · Especificação técnica.');
    expect(text).toContain('A especificação técnica não cobriu todos os critérios de aceitação');
  });

  it('names the gate that failed beside a failed verification, in plain words', async () => {
    await writeRun(runs, 'hello-001-r1', [
      started('hello-001-r1'),
      finished('verification-failed', 'verification failed in round 2: 0 failing tests, 2 uncovered criteria; gate install failed'),
    ]);
    const { text } = await context();
    expect(text).toContain('Gate que também falhou na verificação: install (A instalação das dependências falhou na verificação).');
  });

  it('keeps the reason an earlier run stopped for in the detail file', async () => {
    await writeRun(runs, 'hello-001-r1', [
      started('hello-001-r1'),
      finished('verification-failed', 'verification failed in round 2: 0 failing tests, 2 uncovered criteria; gate install failed'),
    ]);
    await writeRun(runs, 'hello-001-r2', [started('hello-001-r2'), finished('blocked')]);
    const { details } = await context();
    expect(details.get('hello-001')).toContain('Motivo registrado da execução anterior número 1');
    expect(details.get('hello-001')).toContain('gate install failed');
  });

  it('says a question waiting for the owner came from an agent', async () => {
    await writeRun(runs, 'hello-001-r1', [
      started('hello-001-r1'),
      ...blockedTask('T1-q', GO_MOD, 'Pergunta'),
      { type: 'DECISION_REQUESTED', data: { taskId: 'T1-q', specHash: 'x', reason: GO_MOD, question: 'Aceitar Go 1.27.2?', options: [] } },
      finished('blocked'),
    ]);
    const { text, details } = await context();
    expect(text).toContain('Pergunta pendente de você: Aceitar Go 1.27.2? (tarefa: Pergunta; feita por um agente).');
    expect(details.get('hello-001')).toContain('Feita por um agente');
  });

  it('counts the times the owner reopened the run', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), finished('blocked'), { type: 'RUN_REOPENED', data: {} }, { type: 'RUN_REOPENED', data: {} }]);
    const { text } = await context();
    expect(text).toContain('Reaberta pelo dono 2 vez(es).');
  });

  it('bounds a spec record, and keeps the facts when the spec itself is too big for the context', async () => {
    const big = path.join(home, 'big');
    await fs.cp(HELLO, big, { recursive: true });
    const features = Array.from({ length: 200 }, (_, i) => `Funcionalidade ${i}: ${'texto longo '.repeat(25)}`);
    await fs.mkdir(path.join(big, 'docs', 'specs', 'big-001'), { recursive: true });
    await fs.writeFile(path.join(big, 'docs', 'specs', 'big-001', 'spec.json'), JSON.stringify(makeSpec({ specId: 'big-001', status: 'running', features })));
    await writeRun(runs, 'big-001-r1', [
      { type: 'RUN_STARTED', data: { runId: 'big-001-r1', specId: 'big-001', projectId: 'hello-app' } },
      ...blockedTask('T1-big', GO_MOD, 'Grande'),
      finished('blocked'),
    ]);
    const out = await context(big);
    expect(out.text).toContain('## Problemas registrados');
    expect(out.text).toContain('sem detalhes por causa do tamanho');
    expect(out.text).toContain('go.mod requires go >= 1.27.3');
    expect(out.text.length).toBeLessThanOrEqual(61_000);
  });

  it('keeps the digests of all the specs within the total budget, and the record of each one', async () => {
    const many = path.join(home, 'many');
    await fs.cp(HELLO, many, { recursive: true });
    for (let s = 0; s < 10; s++) {
      const specId = `many-${String(s).padStart(2, '0')}`;
      await fs.mkdir(path.join(many, 'docs', 'specs', specId), { recursive: true });
      await fs.writeFile(path.join(many, 'docs', 'specs', specId, 'spec.json'), JSON.stringify(makeSpec({ specId, status: 'running', objectives: [`Entrega ${s}`] })));
      const events: FixtureEvent[] = [{ type: 'RUN_STARTED', data: { runId: `${specId}-r1`, specId, projectId: 'hello-app' } }];
      for (let t = 0; t < 3; t++) events.push(...blockedTask(`T${t + 1}-s${s}`, `Motivo ${s}-${t}: ${'x'.repeat(400)}`, `Tarefa ${t} da entrega ${s}`));
      await writeRun(runs, `${specId}-r1`, [...events, finished('blocked')]);
    }
    const out = await context(many);
    const section = out.text.slice(out.text.indexOf('## Problemas registrados'));
    expect(section.length).toBeLessThanOrEqual(12_000);
    expect(out.details.size).toBe(10);
  });

  it('redacts a credential written into a recorded text, in the context and in the record', async () => {
    await writeRun(runs, 'hello-001-r1', [
      started('hello-001-r1'),
      ...blockedTask('T1-key', 'A autenticação recusou sk-ant-api03-abcdefghijklmnop1234 ao publicar', 'Chave'),
      finished('blocked'),
    ]);
    const { text, details } = await context();
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('sk-ant-api03');
    expect(details.get('hello-001')).not.toContain('sk-ant-api03');
  });

  it('gives the digest of a huge recorded text a short quote', async () => {
    await writeRun(runs, 'hello-001-r1', [
      started('hello-001-r1'),
      ...blockedTask('T1-scope', `Scope violation:\n${'arquivo/teste.txt\n'.repeat(15_000)}`, 'Escopo'),
      finished('blocked'),
    ]);
    const { text } = await context();
    const cause = text.split('\n').find((line) => /^1\. /.test(line))!;
    expect(cause.length).toBeLessThan(900);
  });
});

describe('the verification failures of earlier runs', () => {
  it('names them in the digest, so the answer needs no search of the detail file', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), ...blockedTask('T1-gate', GO_MOD, 'Gate'), finished('blocked')]);
    await writeRun(runs, 'hello-001-r2', [started('hello-001-r2'), finished('blocked')]);
    const { text } = await context();
    expect(text).toContain('Falhas de verificação em execuções anteriores: número 1:');
    expect(text).toContain('go.mod requires go >= 1.27.3');
  });
});

describe('the causes of a run that were replanned afterwards', () => {
  it('still names a gate failure of an earlier run whose task was replanned later', async () => {
    await writeRun(runs, 'hello-001-r1', [
      started('hello-001-r1'),
      { type: 'TASK_PLANNED', data: { task: makePlanTask({ id: 'T1-install', title: 'Instalar' }) } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-install', to: 'ready' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-install', to: 'implementing' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-install', to: 'blocked' } },
      { type: 'TASK_BLOCKED', data: { taskId: 'T1-install', reason: GO_MOD } },
      { type: 'TASKS_UNBLOCKED', data: { taskIds: ['T1-install'] } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-install', to: 'implementing' } },
      { type: 'TASK_REPLANNED', data: { taskId: 'T1-install', replacements: [makePlanTask({ id: 'T1-install-r1', title: 'Nova' })] } },
    ]);
    await writeRun(runs, 'hello-001-r2', [started('hello-001-r2'), finished('blocked')]);
    const { text } = await context();
    expect(text).toContain('Falhas de verificação em execuções anteriores: número 1:');
    expect(text).toContain('go.mod requires go >= 1.27.3');
  });

  it('says in the context where each kind of record is kept, so an answer can name it', async () => {
    await writeRun(runs, 'hello-001-r1', [started('hello-001-r1'), finished('blocked')]);
    const { text } = await context();
    expect(text).toContain('falhas/<spec>.md');
    expect(text).toContain('histórico de cada execução');
  });
});
