import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { buildChatContext, withoutCodes } from '../../server/chat/context.js';
import { makePlanTask } from '../fixtures/contracts.js';
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

  it('is null for an unknown project', async () => {
    expect(await buildChatContext(deps(), 'nope')).toBeNull();
  });
});
