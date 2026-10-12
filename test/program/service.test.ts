import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunControlDeps } from '../../server/api/run-control.js';
import { loadConfig } from '../../server/config/config.js';
import { ProgramService } from '../../server/program/service.js';
import { EventStore } from '../../server/store/event-store.js';
import { makeFrozenSpec } from '../fixtures/contracts.js';

let root = '';
let spawned: Array<{ args: string[] }>;
const runsDir = () => path.join(root, 'runs');

async function journal(runId: string, events: Array<{ type: string; data: Record<string, unknown> }>) {
  await fs.mkdir(path.join(runsDir(), runId), { recursive: true });
  const store = await EventStore.open({ file: path.join(runsDir(), runId, 'events.ndjson'), runId, specHash: 'h' });
  for (const e of events) await store.append(e);
  await store.close();
}
const started = (specId: string) => ({ type: 'RUN_STARTED', data: { runId: 'x', specId, projectId: 'shop' } });
const finished = (result: string, extra: Record<string, unknown> = {}) => ({ type: 'RUN_FINISHED', data: { result, reason: null, merged: [], blocked: [], tokens: { costUsd: null }, ...extra } });

function service() {
  const control: RunControlDeps = {
    spawn: (a) => {
      spawned.push({ args: a.args });
      const runId = a.args[a.args.indexOf('--run-id') + 1]!;
      // The journal exists before spawn returns: the launch waits for it with a sleep that never waits.
      mkdirSync(path.join(runsDir(), runId), { recursive: true });
      writeFileSync(path.join(runsDir(), runId, 'events.ndjson'), '');
      return { pid: 4242 };
    },
    kill: () => true,
    sleep: async () => {},
    cliEntry: () => ({ bin: 'node', prefix: ['cli'] }),
    repoRoot: '/repo',
  };
  return new ProgramService({
    cfg: async () => loadConfig({ paths: { workspaces: path.join(root, 'ws'), runs: runsDir(), secrets: path.join(root, 'secrets') } }),
    control,
    draftRoot: async () => path.join(root, 'draft'),
    freezeItem: async () => undefined,
    register: async () => undefined,
  });
}

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-program-'))).replace(/\\/g, '/');
  spawned = [];
});
afterEach(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe('program service outcomes', () => {
  it('a run that ended awaiting-validation with no blocked task is delivered; with blocked tasks it fails and says which', async () => {
    await journal('a-r1', [started('a'), finished('awaiting-validation')]);
    await journal('b-r1', [started('b'), finished('awaiting-validation', { blocked: [{ taskId: 'T3', reason: 'tests never passed' }] })]);
    const s = service();
    expect(await s.outcome('a-r1')).toEqual({ kind: 'delivered', costUsd: null });
    const b = await s.outcome('b-r1');
    expect(b).toMatchObject({ kind: 'failed' });
    expect(JSON.stringify(b)).toMatch(/T3.*tests never passed/);
  });

  it('delivers a run whose blocked tasks the repair covered: every criterion they own passed verification', async () => {
    const passed = (matrix: unknown[]) => ({ type: 'VERIFICATION_PASSED', data: { round: 2, matrix } });
    await journal('a-r1', [started('a'), passed([{ criterion: 'AC-001', tasks: ['T1'], tests: ['t1'], status: 'passed' }, { criterion: 'AC-002', tasks: ['T2', 'T900-fix-1'], tests: ['t2'], status: 'passed' }]), finished('awaiting-validation', { blocked: [{ taskId: 'T2', reason: 'the Dev found no way' }] })]);
    // T5 owns no criterion, so nothing measured its work; a run journaled before blocked criteria failed verification counts T4's as not passed.
    await journal('b-r1', [started('b'), passed([{ criterion: 'AC-001', tasks: ['T1'], tests: ['t1'], status: 'passed' }]), finished('awaiting-validation', { blocked: [{ taskId: 'T5', reason: 'no change' }] })]);
    await journal('c-r1', [started('c'), passed([{ criterion: 'AC-001', tasks: ['T4'], tests: [], status: 'blocked' }]), finished('awaiting-validation', { blocked: [{ taskId: 'T4', reason: 'stuck' }] })]);
    const s = service();
    expect(await s.outcome('a-r1')).toEqual({ kind: 'delivered', costUsd: null });
    expect(await s.outcome('b-r1')).toMatchObject({ kind: 'failed' });
    expect(await s.outcome('c-r1')).toMatchObject({ kind: 'failed' });
  });

  it('a completion run that ended done is done; every other end is a failure with its reason', async () => {
    await journal('a-complete-r1', [started('a'), finished('done')]);
    await journal('c-r1', [started('c'), finished('verification-failed', { reason: 'AC-004 missing' })]);
    await journal('d-r1', [started('d'), finished('deploy-failed', { reason: 'smoke 500' })]);
    const s = service();
    expect(await s.outcome('a-complete-r1')).toEqual({ kind: 'done', costUsd: null });
    expect(await s.outcome('c-r1')).toEqual({ kind: 'failed', reason: 'verification-failed: AC-004 missing', costUsd: null });
    expect(await s.outcome('d-r1')).toEqual({ kind: 'failed', reason: 'deploy-failed: smoke 500', costUsd: null });
    await journal('e-r1', [started('e'), finished('verification-failed', { reason: 'verification failed in round 2: 0 failing tests, 1 uncovered criteria', blocked: [{ taskId: 'T2', reason: 'the Dev found no way' }, { taskId: 'T3', reason: 'a dependency is blocked' }] })]);
    expect(await s.outcome('e-r1')).toEqual({ kind: 'failed', reason: 'verification-failed: verification failed in round 2: 0 failing tests, 1 uncovered criteria; blocked: T2 (the Dev found no way)', costUsd: null });
  });

  it('surfaces the run\'s cost from RUN_FINISHED on every terminal outcome', async () => {
    await journal('a-r1', [started('a'), finished('awaiting-validation', { tokens: { costUsd: 1.5 } })]);
    await journal('a-complete-r1', [started('a'), finished('done', { tokens: { costUsd: 0.25 } })]);
    await journal('c-r1', [started('c'), finished('verification-failed', { reason: 'boom', tokens: { costUsd: 2 } })]);
    const s = service();
    expect(await s.outcome('a-r1')).toEqual({ kind: 'delivered', costUsd: 1.5 });
    expect(await s.outcome('a-complete-r1')).toEqual({ kind: 'done', costUsd: 0.25 });
    expect(await s.outcome('c-r1')).toEqual({ kind: 'failed', reason: 'verification-failed: boom', costUsd: 2 });
  });

  it('a run that never got going or whose process died without finishing is interrupted, resumable', async () => {
    const s = service();
    expect(await s.outcome('never-r1')).toEqual({ kind: 'interrupted' });
    await journal('e-r1', [started('e')]);
    await fs.writeFile(path.join(runsDir(), 'e-r1', 'pid'), '999999');
    await fs.writeFile(path.join(runsDir(), 'e-r1', 'state.json'), JSON.stringify({ runId: 'e-r1', status: 'running', tasks: [], tokens: {} }));
    const svc = new ProgramService({ ...(s as unknown as { deps: ConstructorParameters<typeof ProgramService>[0] }).deps, control: { ...(s as unknown as { deps: { control: RunControlDeps } }).deps.control, kill: () => false } });
    expect(await svc.outcome('e-r1')).toEqual({ kind: 'interrupted' });
  });
});

describe('program service tick', () => {
  it('delivers a spec to completion: marks the draft spec awaiting-validation, then launches the complete run', async () => {
    const spec = makeFrozenSpec({ specId: 'd-a' });
    const specFile = path.join(root, 'draft', 'docs', 'specs', 'd-a', 'spec.json');
    await fs.mkdir(path.dirname(specFile), { recursive: true });
    await fs.writeFile(specFile, JSON.stringify(spec));
    await fs.writeFile(path.join(root, 'draft', 'program.json'), JSON.stringify({ version: 1, draftId: 'd', status: 'running', updatedAt: '', items: [{ specId: 'd-a', key: 'a', rank: 1, dependsOn: [], status: 'running', runId: 'd-a-r1', completeRunId: null, startedAt: null, finishedAt: null, reason: null, resumes: 0 }] }));
    await journal('d-a-r1', [started('d-a'), finished('awaiting-validation')]);
    const s = service();
    const program = await s.tick('shop', 'd');
    expect(program!.items[0]).toMatchObject({ status: 'completing', completeRunId: 'shop--d-a--complete-run-1' });
    expect(JSON.parse(await fs.readFile(specFile, 'utf8')).status).toBe('awaiting-validation');
    expect(spawned.map((x) => x.args.slice(1, 4))).toEqual([['spec', 'complete', '--project']]);
    expect(JSON.parse(await fs.readFile(path.join(root, 'draft', 'program.json'), 'utf8')).items[0].status).toBe('completing');
  });

  it('does nothing for a draft without a program or with a finished one', async () => {
    const s = service();
    expect(await s.tick('shop', 'd')).toBeNull();
    await fs.mkdir(path.join(root, 'draft'), { recursive: true });
    await fs.writeFile(path.join(root, 'draft', 'program.json'), JSON.stringify({ version: 1, draftId: 'd', status: 'finished', updatedAt: '', items: [] }));
    expect(await s.tick('shop', 'd')).toBeNull();
  });
});

describe('program service prioritize', () => {
  it('puts a pending item ahead of the queue and starts it at the next free slot', async () => {
    const item = (key: string, status: string) => ({ specId: `d-${key}`, key, rank: key.charCodeAt(0), dependsOn: [], status, runId: null, completeRunId: null, startedAt: null, finishedAt: null, reason: null, resumes: 0, costUsd: null, conflictsWith: [] });
    await fs.mkdir(path.join(root, 'draft'), { recursive: true });
    await fs.writeFile(path.join(root, 'draft', 'program.json'), JSON.stringify({ version: 1, draftId: 'd', status: 'running', updatedAt: '', items: [item('a', 'done'), item('b', 'pending'), item('c', 'pending'), item('d', 'pending')] }));
    const program = await service().prioritize('shop', 'd', 'd-d');
    expect(program.items.filter((i) => i.status === 'running').map((i) => i.key)).toEqual(['b', 'd']);
    expect(spawned.map((x) => x.args[x.args.indexOf('--spec') + 1])).toEqual(['d-d', 'd-b']);
  });

  it('refuses an item that is not pending', async () => {
    await fs.mkdir(path.join(root, 'draft'), { recursive: true });
    await fs.writeFile(path.join(root, 'draft', 'program.json'), JSON.stringify({ version: 1, draftId: 'd', status: 'running', updatedAt: '', items: [{ specId: 'd-a', key: 'a', rank: 1, dependsOn: [], status: 'done', runId: null, completeRunId: null, startedAt: null, finishedAt: null, reason: null, resumes: 0, costUsd: null }] }));
    await expect(service().prioritize('shop', 'd', 'd-a')).rejects.toThrow(/not pending/);
  });
});

describe('program service retry', () => {
  it('clears a failed item and launches it again', async () => {
    await fs.mkdir(path.join(root, 'draft', 'docs', 'specs', 'd-a'), { recursive: true });
    await fs.writeFile(path.join(root, 'draft', 'docs', 'specs', 'd-a', 'spec.json'), JSON.stringify(makeFrozenSpec({ specId: 'd-a' })));
    await fs.writeFile(path.join(root, 'draft', 'program.json'), JSON.stringify({
      version: 1, draftId: 'd', status: 'finished', updatedAt: '',
      items: [{ specId: 'd-a', key: 'a', rank: 1, dependsOn: [], status: 'failed', runId: 'd-a-r1', completeRunId: null, startedAt: '2026-10-07T00:00:00Z', finishedAt: '2026-10-07T01:00:00Z', reason: 'verification-failed', resumes: 0 }],
    }));
    const s = service();
    const program = await s.retry('shop', 'd', 'd-a');
    expect(program.status).toBe('running');
    expect(program.items[0]).toMatchObject({ status: 'running', reason: null });
    expect(program.items[0]!.runId).toMatch(/^shop--d-a--run-\d+$/);
  });

  it('refuses to retry on a draft with no program', async () => {
    const s = service();
    await expect(s.retry('shop', 'd', 'd-a')).rejects.toThrow(/no program/);
  });
});
