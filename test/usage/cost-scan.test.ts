import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { createCostScanner } from '../../server/usage/cost-scan.js';
import { appendEvents, writeRun, type FixtureEvent } from '../fixtures/runs/write-run.js';

const usage = (inputTokens: number, outputTokens: number, costUsd: number | null) => ({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd });
const step = (stepId: string, role: string, taskId: string | null, phase: string, costUsd: number | null): FixtureEvent[] => [
  { type: 'STEP_STARTED', data: { stepId, kind: 'dev', role, model: 'sonnet', taskId, phase, attempt: 1 } },
  { type: 'STEP_FINISHED', data: { stepId, kind: 'dev', taskId, attempt: 1, ok: true, model: 'sonnet', usage: usage(10, 5, costUsd), costUsd } },
];

let root: string;
let runs: string;
let workspaces: string;
let chats: string;

async function registerProject(): Promise<string> {
  const dir = path.join(root, 'shop');
  const hello = path.resolve('test/fixtures/hello-app');
  const project = JSON.parse(await fs.readFile(path.join(hello, 'docs', 'project.json'), 'utf8'));
  const spec = JSON.parse(await fs.readFile(path.join(hello, 'docs', 'specs', 'hello-001', 'spec.json'), 'utf8'));
  await fs.mkdir(path.join(dir, 'docs', 'specs', 'checkout'), { recursive: true });
  await fs.writeFile(path.join(dir, 'docs', 'project.json'), JSON.stringify({ ...project, projectId: 'shop', name: 'Loja' }));
  await fs.writeFile(path.join(dir, 'docs', 'specs', 'checkout', 'spec.json'), JSON.stringify({ ...spec, specId: 'checkout', repository: 'shop-api' }));
  return dir;
}

function scanner(dir: string) {
  const cfg = loadConfig({ paths: { workspaces: workspaces, runs, secrets: path.join(root, 'secrets'), usage: path.join(root, 'usage') }, projects: [{ dir }] });
  return createCostScanner({ config: async () => cfg, chatsDir: chats });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cost-scan-'));
  runs = path.join(root, 'runs');
  workspaces = path.join(root, 'ws');
  chats = path.join(root, 'chats');
  await fs.mkdir(runs, { recursive: true });
  await fs.mkdir(chats, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('createCostScanner', () => {
  it('reads refinement, development and chat from disk, and names the repository of a phase step from its spec', async () => {
    const dir = await registerProject();
    await writeRun(path.join(workspaces, 'shop', 'refine'), 'checkout', [
      { type: 'STEP_STARTED', data: { stepId: 's1', kind: 'spec', role: 'po', model: 'opus', taskId: null, phase: 'refine', attempt: 0 } },
      { type: 'STEP_FINISHED', data: { stepId: 's1', kind: 'spec', taskId: null, attempt: 0, usage: usage(1, 1, 0.4), costUsd: 0.4 } },
      { type: 'REFINE_DOCS_SCORED', data: { model: 'jev-model', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 } } },
    ]);
    await writeRun(runs, 'shop--checkout--run-1', [
      { type: 'TASK_PLANNED', data: { task: { id: 'T1', service: 'shop-web' } } },
      ...step('s1', 'dev', 'T1', 'phase3', 0.3),
      ...step('s2', 'sm', null, 'phase6', 0.7),
    ]);
    await fs.writeFile(
      path.join(chats, 'shop.json'),
      JSON.stringify([
        { role: 'user', text: 'oi', at: '2026-11-05T10:00:00.000Z' },
        { role: 'assistant', text: 'olá', at: '2026-11-05T10:00:05.000Z', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.05, seconds: 1, turns: 1 } },
      ]),
    );

    const result = await scanner(dir).scan();
    const byStage = (stage: string) => result.facts.filter((f) => f.stage === stage);
    expect(result.projects).toEqual([{ projectId: 'shop', name: 'Loja' }]);
    expect(result.unreadJournals).toBe(0);
    expect(byStage('refinement').reduce((s, f) => s + (f.costUsd ?? 0), 0)).toBeCloseTo(0.5);
    expect(byStage('development').reduce((s, f) => s + (f.costUsd ?? 0), 0)).toBeCloseTo(1);
    expect(byStage('chat').map((f) => f.costUsd)).toEqual([0.05]);
    expect(byStage('development').map((f) => [f.taskId, f.repository])).toEqual([
      ['T1', 'shop-web'],
      [null, 'shop-api'],
    ]);
    expect(byStage('refinement').map((f) => f.repository)).toEqual(['shop-api', 'shop-api']);
  });

  it('counts a journal it cannot read and still reads the others', async () => {
    const dir = await registerProject();
    await writeRun(runs, 'shop--checkout--run-1', step('s1', 'dev', null, 'phase3', 0.2));
    await fs.mkdir(path.join(runs, 'shop--checkout--run-2'));
    await fs.writeFile(path.join(runs, 'shop--checkout--run-2', 'events.ndjson'), 'isto não é um journal\n');

    const result = await scanner(dir).scan();
    expect(result.unreadJournals).toBe(1);
    expect(result.facts.map((f) => f.costUsd)).toEqual([0.2]);
  });

  it('never writes to the run folder: a stale pid file stays as it is', async () => {
    const dir = await registerProject();
    await writeRun(runs, 'shop--checkout--run-3', step('s1', 'dev', null, 'phase3', 0.1), null, 999_999);
    const before = await fs.readFile(path.join(runs, 'shop--checkout--run-3', 'pid'), 'utf8');

    await scanner(dir).scan();
    expect(await fs.readFile(path.join(runs, 'shop--checkout--run-3', 'pid'), 'utf8')).toBe(before);
    await expect(fs.stat(path.join(runs, 'shop--checkout--run-3', 'pid.gone'))).rejects.toThrow();
  });

  it('attributes a legacy run to the project its start event names', async () => {
    const dir = await registerProject();
    await writeRun(runs, 'checkout-r1', [
      { type: 'RUN_STARTED', data: { runId: 'checkout-r1', specId: 'checkout', projectId: 'shop' } },
      ...step('s1', 'dev', null, 'phase3', 0.25),
    ]);

    const [fact] = (await scanner(dir).scan()).facts;
    expect(fact).toEqual(expect.objectContaining({ projectId: 'shop', specId: 'checkout', runId: 'checkout-r1', costUsd: 0.25 }));
  });

  it('reads again only the journal that grew between two scans', async () => {
    const dir = await registerProject();
    await writeRun(runs, 'shop--checkout--run-1', step('s1', 'dev', null, 'phase3', 0.2));
    const scan = scanner(dir);
    expect((await scan.scan()).facts).toHaveLength(1);

    await appendEvents(runs, 'shop--checkout--run-1', step('s2', 'test', null, 'phase4', 0.4), 3);
    const again = await scan.scan();
    expect(again.facts.map((f) => f.costUsd)).toEqual([0.2, 0.4]);
  });
});
