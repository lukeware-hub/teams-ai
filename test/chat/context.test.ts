import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { buildChatContext, withoutCodes } from '../../server/chat/context.js';
import { makePlanTask, makeSpec } from '../fixtures/contracts.js';
import { writeRun } from '../fixtures/runs/write-run.js';

const HELLO = path.resolve('test/fixtures/hello-app');
let home = '';
const deps = () => ({ cfg: loadConfig({ paths: { runs: path.join(home, 'runs').replace(/\\/g, '/') }, projects: [{ dir: HELLO }] }), home, isAlive: () => false });

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-chat-'));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('withoutCodes', () => {
  it('removes criterion and task codes and the leftovers', () => {
    expect(withoutCodes('Cria o endpoint (AC-001) e o teste [AC-002] depois de T1-create-endpoint')).toBe('Cria o endpoint e o teste depois de');
    expect(withoutCodes('Sem códigos aqui')).toBe('Sem códigos aqui');
  });
});

describe('buildChatContext', () => {
  it('describes the project, its specs and the tasks of the latest run in plain words, with no codes', async () => {
    const task = makePlanTask({ id: 'T1-create-endpoint', title: 'Criar o endpoint de saudação', description: 'Cobre AC-001 em src/hello' });
    await writeRun(path.join(home, 'runs'), 'hello-001-r1', [
      { type: 'RUN_STARTED', data: { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app' } },
      { type: 'TASK_PLANNED', data: { task } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: task.id, to: 'ready' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: task.id, to: 'implementing' } },
    ], { runId: 'hello-001-r1', at: '2026-09-24T10:01:00.000Z', status: 'running', tasks: [], tokens: {} });
    const out = (await buildChatContext(deps(), 'hello-app'))!;
    expect(out.name).toBe('Hello app');
    expect(out.text).toContain('Greet a caller by name over HTTP');
    expect(out.text).toContain('em desenvolvimento agora');
    expect(out.text).toContain('Criar o endpoint de saudação (sendo desenvolvida agora)');
    expect(out.text).toContain('Fora do escopo (não deve ser feito)');
    expect(out.text).not.toMatch(/AC-\d|T\d+-/);
  });

  it('names the spec, the run in progress (not a newer finished one) and how far its tasks have come', async () => {
    const tasks = [['T1-first', 'Primeira'], ['T2-second', 'Segunda'], ['T3-third', 'Terceira']].map(([id, title]) => makePlanTask({ id, title, description: `Descrição da ${title.toLowerCase()}` }));
    await writeRun(path.join(home, 'runs'), 'hello-001-r1', [
      { type: 'RUN_STARTED', data: { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app' } },
      ...tasks.map((task) => ({ type: 'TASK_PLANNED', data: { task } })),
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-first', to: 'merged' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T2-second', to: 'ready' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T2-second', to: 'implementing' } },
    ], { runId: 'hello-001-r1', at: '2026-09-24T10:01:00.000Z', status: 'running', tasks: [], tokens: {} });
    await writeRun(path.join(home, 'runs'), 'hello-001-r2', [{ type: 'RUN_STARTED', data: { runId: 'hello-001-r2', specId: 'hello-001', projectId: 'hello-app' } }], { runId: 'hello-001-r2', at: '2026-09-25T10:01:00.000Z', status: 'done', tasks: [], tokens: {} });
    const { text } = (await buildChatContext(deps(), 'hello-app'))!;
    expect(text).toContain('Nome da spec: hello-001');
    expect(text).toContain('Execução: número 1 (em andamento)');
    expect(text).toContain('Progresso: 1 de 3 tarefas concluídas, 1 em andamento');
    expect(text).toContain('- Primeira (concluída): Descrição da primeira');
    expect(text).toContain('- Segunda (sendo desenvolvida agora): Descrição da segunda');
    expect(text).not.toContain('- - ');
  });

  it('says a spec frozen for running with no run going is ready, not in development', async () => {
    const dir = path.join(home, 'proj');
    await fs.cp(HELLO, dir, { recursive: true });
    await fs.mkdir(path.join(dir, 'docs', 'specs', 'ready-one'), { recursive: true });
    await fs.writeFile(path.join(dir, 'docs', 'specs', 'ready-one', 'spec.json'), JSON.stringify(makeSpec({ specId: 'ready-one', status: 'running', objectives: ['Entrega pronta'], features: ['Funcionalidade pronta'], outOfScope: ['Fora pronta'] })));
    const cfg = loadConfig({ paths: { runs: path.join(home, 'runs').replace(/\\/g, '/') }, projects: [{ dir }] });
    const { text } = (await buildChatContext({ cfg, home, isAlive: () => false }, 'hello-app'))!;
    expect(text).toContain('### Entrega pronta');
    expect(text).toContain('Situação: pronta para executar, sem execução ativa');
    expect(text).not.toContain('em desenvolvimento agora');
  });

  it('gives specs in play everything and every other spec one line with its name and situation', async () => {
    const dir = path.join(home, 'proj');
    await fs.cp(HELLO, dir, { recursive: true });
    const write = (id: string, status: 'planned' | 'done', objective: string) => fs.mkdir(path.join(dir, 'docs', 'specs', id), { recursive: true }).then(() => fs.writeFile(path.join(dir, 'docs', 'specs', id, 'spec.json'), JSON.stringify(makeSpec({ specId: id, status, objectives: [objective], features: [`Funcionalidade de ${id}`], outOfScope: [`Fora de ${id}`] }))));
    await write('planned-one', 'planned', 'Entrega planejada');
    await write('done-one', 'done', 'Entrega antiga');
    const cfg = loadConfig({ paths: { runs: path.join(home, 'runs').replace(/\\/g, '/') }, projects: [{ dir }] });
    const { text } = (await buildChatContext({ cfg, home, isAlive: () => false }, 'hello-app'))!;
    expect(text).toContain('Funcionalidades:\n- GET /hello');
    expect(text).toContain('### Outras specs (só o nome e a situação)\n- Entrega planejada: planejada, ainda não iniciada\n- Entrega antiga: concluída');
    expect(text).not.toContain('Fora de planned-one');
    expect(text).not.toContain('Fora de done-one');
  });

  it('is null for an unknown project', async () => {
    expect(await buildChatContext(deps(), 'nope')).toBeNull();
  });
});
