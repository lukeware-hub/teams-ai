import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { buildChatContext } from '../../server/chat/context.js';
import { recordOwnerDecisions } from '../../server/orchestrator/owner-decisions.js';
import { makePlanTask } from '../fixtures/contracts.js';
import { writeRun, type FixtureEvent } from '../fixtures/runs/write-run.js';
import { RUN_STATUS } from '../../server/chat/status.js';
import type { RunListStatus } from '../../server/api/run-index.js';

const HELLO = path.resolve('test/fixtures/hello-app');
const HASH = `sha256:${'b'.repeat(64)}`;
const GO_MOD = 'Gate install failed (code, exit 1)\n\nstderr (tail):\ngo: go.mod requires go >= 1.27.3 (running go 1.27.2; GOTOOLCHAIN=local)';
/** Agent prose: the scrum master's wrong guess about the cause. The chat must not repeat it as fact. */
const WRONG_CAUSE = 'Substitui a T1-setup, que falhou na instalação das ferramentas.';

let home = '';
let runs = '';
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-failures-'));
  runs = path.join(home, 'runs');
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const deps = (dir = HELLO) => ({ cfg: loadConfig({ paths: { runs: runs.replace(/\\/g, '/') }, projects: [{ dir }] }), home, isAlive: () => false });
const context = async (dir?: string) => (await buildChatContext(deps(dir), 'hello-app'))!;

/** One run of the example spec: its first task failed an attempt and was replanned; the replacement is blocked by the install gate and two tasks wait on it. */
function blockedRun(runId: string): FixtureEvent[] {
  const setup = makePlanTask({ id: 'T1-setup', title: 'Preparar o ambiente', description: 'Instala as ferramentas' });
  const endpoint = makePlanTask({ id: 'T2-endpoint', title: 'Criar o endpoint', description: 'Cria a rota', dependsOn: ['T1-setup'] });
  const tests = makePlanTask({ id: 'T3-tests', title: 'Escrever os testes', description: 'Testa a rota', dependsOn: ['T2-endpoint'] });
  const replacement = makePlanTask({ id: 'T1-setup-r1', title: 'Esqueleto do projeto', description: WRONG_CAUSE });
  return [
    { type: 'RUN_STARTED', data: { runId, specId: 'hello-001', projectId: 'hello-app' } },
    { type: 'TASK_PLANNED', data: { task: setup } },
    { type: 'TASK_PLANNED', data: { task: endpoint } },
    { type: 'TASK_PLANNED', data: { task: tests } },
    { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-setup', to: 'ready' } },
    { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-setup', to: 'implementing' } },
    { type: 'FEEDBACK', data: { taskId: 'T1-setup', text: "Orchestrator step failed: git worktree add --no-track origin/main failed (128): fatal: 'worktrees/setup' already exists", attempt: true } },
    { type: 'ATTEMPT_CONSUMED', data: { taskId: 'T1-setup' } },
    { type: 'TASK_REPLANNED', data: { taskId: 'T1-setup', replacements: [replacement] } },
    { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-setup-r1', to: 'ready' } },
    { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-setup-r1', to: 'implementing' } },
    { type: 'GATE_FAILED', data: { taskId: 'T1-setup-r1', gate: 'install', failure: 'code', exitCode: 1, durationMs: 10, junit: [] } },
    { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-setup-r1', to: 'blocked' } },
    { type: 'TASK_BLOCKED', data: { taskId: 'T1-setup-r1', reason: GO_MOD } },
    { type: 'TASK_STATE_CHANGED', data: { taskId: 'T2-endpoint', to: 'blocked' } },
    { type: 'TASK_BLOCKED', data: { taskId: 'T2-endpoint', reason: 'a dependency is blocked' } },
    { type: 'TASK_STATE_CHANGED', data: { taskId: 'T3-tests', to: 'blocked' } },
    { type: 'TASK_BLOCKED', data: { taskId: 'T3-tests', reason: 'a dependency is blocked' } },
    { type: 'RUN_FINISHED', data: { result: 'blocked', reason: null, merged: [], blocked: [] } },
  ];
}

describe('the failures of the runs in the chat context', () => {
  it('gives the recorded cause in plain words, the tasks it holds and the ones waiting, with no codes', async () => {
    await writeRun(runs, 'hello-001-r1', blockedRun('hello-001-r1'));
    const { text } = await context();
    expect(text).toContain('Problemas registrados');
    expect(text).toContain('go.mod requires go >= 1.27.3');
    expect(text).toContain('2 esperam por ela');
    expect(text).toContain('Quem resolve: o sistema');
    expect(text).not.toMatch(/AC-\d|T\d+-/);
    expect(text).not.toMatch(/^go: go\.mod/m);
  });

  it('keeps the agent wording of a replanned task out of the context, and puts it in the detail file under its own label', async () => {
    await writeRun(runs, 'hello-001-r1', blockedRun('hello-001-r1'));
    const { text, details } = await context();
    expect(text).not.toContain('falhou na instalação das ferramentas');
    expect(text).toContain('Esqueleto do projeto (bloqueada, criada ao refazer o plano)');
    expect(details.get('hello-001')).toContain('Texto de agente (não é causa registrada)');
    expect(details.get('hello-001')).toContain('falhou na instalação das ferramentas');
    expect(details.get('hello-001')).toContain('already exists');
  });

  it('leads with the latest run and says when the run holding the spec cannot resume', async () => {
    await writeRun(runs, 'hello-001-r1', [
      { type: 'RUN_STARTED', data: { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app' } },
      { type: 'TASK_PLANNED', data: { task: makePlanTask({ id: 'T1-only', title: 'Única tarefa' }) } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-only', to: 'ready' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-only', to: 'implementing' } },
    ], { runId: 'hello-001-r1', at: '2026-09-24T10:01:00.000Z', status: 'running', tasks: [], tokens: {} }, 999999);
    await writeRun(runs, 'hello-001-r2', [
      { type: 'RUN_STARTED', data: { runId: 'hello-001-r2', specId: 'hello-001', projectId: 'hello-app' } },
      { type: 'RUN_FINISHED', data: { result: 'verification-failed', reason: 'verification failed in round 2: 0 failing tests, 2 uncovered criteria', merged: [], blocked: [], tokens: {} } },
    ]);
    const { text } = await context();
    expect(text).toContain('só a mais recente (número 2) pode ser retomada');
    expect(text).toContain('verificação falhou');
  });

  it('names the run status in plain words and never reads a stopped run as finished', async () => {
    await writeRun(runs, 'hello-001-r1', [
      { type: 'RUN_STARTED', data: { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app' } },
      { type: 'RUN_FINISHED', data: { result: 'deadlocked', reason: 'no task can start', merged: [], blocked: [] } },
    ]);
    const { text } = await context();
    expect(text).toContain('travada');
    expect(text).not.toContain('encerrada');
  });

  it('shows the owner the question that waits for an answer, and drops it once answered', async () => {
    await writeRun(runs, 'hello-001-r1', blockedRun('hello-001-r1'));
    const dir = path.join(home, 'proj');
    await fs.cp(HELLO, dir, { recursive: true });
    const question = 'Aceitar a versão 1.27.2 do Go ou trocar a imagem?';
    await writeRun(runs, 'hello-001-r1', [
      ...blockedRun('hello-001-r1'),
      { type: 'DECISION_REQUESTED', data: { taskId: 'T1-setup-r1', specHash: HASH, reason: GO_MOD, question, options: [{ label: 'Trocar a imagem', detail: 'Usar uma imagem com Go 1.27.3' }] } },
    ]);
    expect((await context(dir)).text).toContain(`Pergunta pendente de você: ${question}`);
    await recordOwnerDecisions(dir, 'hello-001', [{ runId: 'hello-001-r1', taskId: 'T1-setup-r1', specHash: HASH, question, answer: 'Trocar a imagem' }]);
    const answered = await context(dir);
    expect(answered.text).not.toContain('Pergunta pendente de você');
    expect(answered.details.get('hello-001')).toContain('Trocar a imagem');
  });

  it('keeps a secret of the secrets folder out of every recorded text', async () => {
    await fs.mkdir(path.join(home, '.teams-ai', 'secrets'), { recursive: true });
    await fs.writeFile(path.join(home, '.teams-ai', 'secrets', 'API_TOKEN'), 'tok-SECRET-value-42');
    await writeRun(runs, 'hello-001-r1', [
      { type: 'RUN_STARTED', data: { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app' } },
      { type: 'TASK_PLANNED', data: { task: makePlanTask({ id: 'T1-publish', title: 'Publicar' }) } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-publish', to: 'ready' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-publish', to: 'implementing' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-publish', to: 'blocked' } },
      { type: 'TASK_BLOCKED', data: { taskId: 'T1-publish', reason: 'Falha ao publicar: o token tok-SECRET-value-42 foi recusado' } },
      { type: 'RUN_FINISHED', data: { result: 'blocked', reason: null, merged: [], blocked: [] } },
    ]);
    const { text, details } = await context();
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('tok-SECRET-value-42');
    expect(details.get('hello-001')).not.toContain('tok-SECRET-value-42');
  });

  it('bounds a huge recorded text and marks what it left out', async () => {
    await writeRun(runs, 'hello-001-r1', [
      { type: 'RUN_STARTED', data: { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app' } },
      { type: 'TASK_PLANNED', data: { task: makePlanTask({ id: 'T1-scope', title: 'Escopo' }) } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-scope', to: 'ready' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-scope', to: 'implementing' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-scope', to: 'blocked' } },
      { type: 'TASK_BLOCKED', data: { taskId: 'T1-scope', reason: `Scope violation:\n${'arquivo/teste.txt\n'.repeat(15_000)}` } },
      { type: 'RUN_FINISHED', data: { result: 'blocked', reason: null, merged: [], blocked: [] } },
    ]);
    const out = await context();
    expect(out.text.length).toBeLessThanOrEqual(60_000);
    expect(out.details.get('hello-001')!.length).toBeLessThanOrEqual(20_000);
    expect(out.details.get('hello-001')).toContain('caracteres omitidos');
  });

  it('says a run that recorded nothing so, without failing', async () => {
    await writeRun(runs, 'hello-001-r1', [], { runId: 'hello-001-r1', at: '2026-09-24T10:01:00.000Z', status: 'running', tasks: [], tokens: {} });
    const { text } = await context();
    expect(text).toContain('não registrou nenhum fato');
  });

  it('gives the same text for the same records, so the prompt prefix stays cached', async () => {
    await writeRun(runs, 'hello-001-r1', blockedRun('hello-001-r1'));
    expect((await context()).text).toBe((await context()).text);
  });

  it('keeps the five earlier runs in the detail file, and the three latest in the digest', async () => {
    for (let n = 1; n <= 6; n++) {
      await writeRun(runs, `hello-001-r${n}`, [
        { type: 'RUN_STARTED', data: { runId: `hello-001-r${n}`, specId: 'hello-001', projectId: 'hello-app' } },
        { type: 'RUN_FINISHED', data: { result: 'verification-failed', reason: 'verification failed in round 2: 0 failing tests, 2 uncovered criteria', merged: [], blocked: [] } },
      ]);
    }
    const { text, details } = await context();
    expect(details.get('hello-001')).toContain('número 1,');
    expect(details.get('hello-001')).toContain('número 5,');
    expect(text).toContain('número 3,');
    expect(text).not.toContain('número 1,');
  });

  it('says where a cause comes from: a finding of a reviewer is an opinion of an agent, a gate failure is the record of the system', async () => {
    await writeRun(runs, 'hello-001-r1', [
      { type: 'RUN_STARTED', data: { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app' } },
      { type: 'TASK_PLANNED', data: { task: makePlanTask({ id: 'T1-review', title: 'Revisar o endpoint' }) } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-review', to: 'ready' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-review', to: 'implementing' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-review', to: 'blocked' } },
      { type: 'TASK_BLOCKED', data: { taskId: 'T1-review', reason: 'Review requested changes:\n- src/a.ts:3 [important] A função não trata entrada vazia (fix: validar antes)' } },
      { type: 'RUN_FINISHED', data: { result: 'blocked', reason: null, merged: [], blocked: [] } },
    ]);
    const { text, details } = await context();
    expect(text).toContain('Origem: agente revisor');
    expect(details.get('hello-001')).toContain('opinião de um agente');
  });

  it('names the causes of an earlier run in the detail file, so a question about it finds its record', async () => {
    await writeRun(runs, 'hello-001-r1', [
      { type: 'RUN_STARTED', data: { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app' } },
      { type: 'TASK_PLANNED', data: { task: makePlanTask({ id: 'T1-install', title: 'Instalar' }) } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-install', to: 'ready' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-install', to: 'implementing' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-install', to: 'blocked' } },
      { type: 'TASK_BLOCKED', data: { taskId: 'T1-install', reason: GO_MOD } },
      { type: 'RUN_FINISHED', data: { result: 'blocked', reason: null, merged: [], blocked: [] } },
    ]);
    await writeRun(runs, 'hello-001-r2', [
      { type: 'RUN_STARTED', data: { runId: 'hello-001-r2', specId: 'hello-001', projectId: 'hello-app' } },
      { type: 'RUN_FINISHED', data: { result: 'verification-failed', reason: 'verification failed in round 2: 0 failing tests, 2 uncovered criteria', merged: [], blocked: [] } },
    ]);
    const { details } = await context();
    expect(details.get('hello-001')).toContain('Causas da execução anterior número 1');
    expect(details.get('hello-001')).toContain('go.mod requires go >= 1.27.3');
  });

  it('counts every run of the spec by its status, so a question about how many failed has the whole number', async () => {
    const runs3 = [['hello-001-r1', 'verification-failed'], ['hello-001-r2', 'verification-failed'], ['hello-001-r3', 'deadlocked']] as const;
    for (const [runId, result] of runs3) await writeRun(runs, runId, [
      { type: 'RUN_STARTED', data: { runId, specId: 'hello-001', projectId: 'hello-app' } },
      { type: 'RUN_FINISHED', data: { result, reason: null, merged: [], blocked: [] } },
    ]);
    const { text } = await context();
    expect(text).toContain('Execuções desta spec: 3 no total (1 travada, 2 verificação falhou).');
  });

  const RESULT_ONLY: ReadonlySet<string> = new Set(['complete', 'done', 'drained', 'blocked', 'deadlocked', 'phase-failed', 'verification-failed', 'deploy-failed', 'launch-failed', 'unknown']);
  it.each(Object.keys(RUN_STATUS) as RunListStatus[])('names the status %s in its plain words, and says encerrada only for a drained run', async (status) => {
    const runId = 'hello-001-r1';
    const started = [{ type: 'RUN_STARTED', data: { runId, specId: 'hello-001', projectId: 'hello-app' } }];
    if (RESULT_ONLY.has(status)) await writeRun(runs, runId, [...started, { type: 'RUN_FINISHED', data: { result: status, reason: null, merged: [], blocked: [] } }]);
    else await writeRun(runs, runId, started, { runId, at: '2026-09-24T10:01:00.000Z', status, tasks: [], tokens: {} });
    const { text } = await context();
    expect(text).toContain(`Execução: número 1 (${RUN_STATUS[status]})`);
    if (status !== 'drained') expect(text).not.toContain('encerrada');
  });

  it('reads a reopened run as running again, and states only the cause it has now', async () => {
    const events = blockedRun('hello-001-r1').filter((e) => e.type !== 'RUN_FINISHED');
    await writeRun(runs, 'hello-001-r1', [
      ...events,
      { type: 'RUN_FINISHED', data: { result: 'blocked', reason: null, merged: [], blocked: [] } },
      { type: 'RUN_REOPENED', data: {} },
      { type: 'TASK_BLOCKED', data: { taskId: 'T1-setup-r1', reason: 'Scope violation:\nsrc/x.ts' } },
    ], { runId: 'hello-001-r1', at: '2026-09-24T10:01:00.000Z', status: 'running', tasks: [], tokens: {} });
    const { text } = await context();
    expect(text).toContain('O Dev mexeu em arquivos fora do escopo da tarefa');
    expect(text).not.toContain('go.mod requires');
  });

  it('says the record of a run cannot be read when its journal is corrupt, without failing', async () => {
    await writeRun(runs, 'hello-001-r1', [{ type: 'RUN_STARTED', data: { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app' } }]);
    await fs.appendFile(path.join(runs, 'hello-001-r1', 'events.ndjson'), '{"seq":2}\n');
    const { text, details } = await context();
    expect(text).toContain('não pôde ser lido');
    expect(details.get('hello-001')).toContain('não pôde ser lido');
  });

  it('says a run the person stopped was stopped by the person', async () => {
    await writeRun(runs, 'hello-001-r1', [
      { type: 'RUN_STARTED', data: { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app' } },
      { type: 'TASK_PLANNED', data: { task: makePlanTask({ id: 'T1-stop', title: 'Tarefa parada' }) } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-stop', to: 'ready' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-stop', to: 'implementing' } },
    ], { runId: 'hello-001-r1', at: '2026-09-24T10:01:00.000Z', status: 'running', tasks: [], tokens: {} }, 999999);
    await fs.writeFile(path.join(runs, 'hello-001-r1', 'stop-requested'), '');
    const { text } = await context();
    expect(text).toContain('Execução: número 1 (interrompida, parada por você)');
  });

  it('keeps every unanswered question of a task, when the same task is asked twice', async () => {
    await writeRun(runs, 'hello-001-r1', [
      ...blockedRun('hello-001-r1'),
      { type: 'DECISION_REQUESTED', data: { taskId: 'T1-setup-r1', specHash: HASH, reason: GO_MOD, question: 'Pergunta antiga?', options: [] } },
      { type: 'DECISION_REQUESTED', data: { taskId: 'T1-setup-r1', specHash: HASH, reason: GO_MOD, question: 'Pergunta nova?', options: [] } },
    ]);
    const { text } = await context();
    expect(text).toContain('Pergunta pendente de você: Pergunta antiga?');
    expect(text).toContain('Pergunta pendente de você: Pergunta nova?');
  });
});
