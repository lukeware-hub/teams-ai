import { promises as fs, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunControlDeps } from '../../server/api/run-control.js';
import { loadConfig } from '../../server/config/config.js';
import { ProgramService, type ProgramServiceDeps } from '../../server/program/service.js';
import { EventStore } from '../../server/store/event-store.js';
import { readRepairNotes, writeRepairNotes } from '../../server/program/repair-notes.js';
import { makeFrozenSpec, makeProject } from '../fixtures/contracts.js';

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

function service(decider?: ProgramServiceDeps['decider']) {
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
    decider,
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

  it('delivers a run that ended delivered with only a fix task of an earlier deploy attempt blocked', async () => {
    const planned = { type: 'FIX_TASKS_PLANNED', data: { tasks: [{ id: 'T950-deploy-fix-1', origin: 'deploy-fix' }, { id: 'T900-fix-1', origin: 'fix' }] } };
    await journal('a-r1', [started('a'), planned, finished('awaiting-validation', { blocked: [{ taskId: 'T950-deploy-fix-1', reason: 'the environment lacks X' }] })]);
    await journal('b-r1', [started('b'), planned, finished('awaiting-validation', { blocked: [{ taskId: 'T950-deploy-fix-1', reason: 'x' }, { taskId: 'T5', reason: 'no change' }] })]);
    const s = service();
    expect(await s.outcome('a-r1')).toEqual({ kind: 'delivered', costUsd: null });
    expect(await s.outcome('b-r1')).toMatchObject({ kind: 'failed', reason: expect.stringMatching(/^finished with 1 blocked task\(s\): T5 /) });
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
    const svc = new ProgramService({ ...(s as unknown as { deps: ConstructorParameters<typeof ProgramService>[0] }).deps, control: { ...(s as unknown as { deps: { control: RunControlDeps } }).deps.control, kill: () => false } });
    // Launched after this server booted, so the process died on its own.
    await new Promise((r) => setTimeout(r, 5));
    await journal('e-r1', [started('e')]);
    await fs.writeFile(path.join(runsDir(), 'e-r1', 'pid'), '999999');
    await fs.writeFile(path.join(runsDir(), 'e-r1', 'state.json'), JSON.stringify({ runId: 'e-r1', status: 'running', tasks: [], tokens: {} }));
    expect(await svc.outcome('e-r1')).toEqual({ kind: 'interrupted' });
  });

  it('a run the user stopped is stopped, never interrupted or failed, so the program neither resumes nor repairs it', async () => {
    await journal('s-r1', [started('s')]);
    await fs.writeFile(path.join(runsDir(), 's-r1', 'state.json'), JSON.stringify({ runId: 's-r1', status: 'running', tasks: [], tokens: {} }));
    await fs.writeFile(path.join(runsDir(), 's-r1', 'pid.gone'), '999999');
    await fs.writeFile(path.join(runsDir(), 's-r1', 'stop-requested'), '');
    await journal('t-r1', [started('t'), finished('drained', { tokens: { costUsd: 0.5 } })]);
    await fs.writeFile(path.join(runsDir(), 't-r1', 'stop-requested'), '');
    await journal('u-r1', [started('u'), finished('drained')]);
    const s = service();
    expect(await s.outcome('s-r1')).toEqual({ kind: 'stopped' });
    expect(await s.outcome('t-r1')).toEqual({ kind: 'stopped', finished: true, costUsd: 0.5 });
    // A drain with no stop marker (an exhausted budget) is still a failure.
    expect(await s.outcome('u-r1')).toMatchObject({ kind: 'failed' });
  });

  it('says a run whose process was launched before this server booted died in the restart', async () => {
    await journal('r-r1', [started('r')]);
    await fs.writeFile(path.join(runsDir(), 'r-r1', 'state.json'), JSON.stringify({ runId: 'r-r1', status: 'running', tasks: [], tokens: {} }));
    const gone = path.join(runsDir(), 'r-r1', 'pid.gone');
    await fs.writeFile(gone, '999999');
    const launched = new Date(Date.now() - 3_600_000);
    await fs.utimes(gone, launched, launched);
    expect(await service().outcome('r-r1')).toEqual({ kind: 'interrupted', restart: true });
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

  it('redacts a secret in the log tail of a launch that failed (audit M3)', async () => {
    const spec = makeFrozenSpec({ specId: 'd-a' });
    const specFile = path.join(root, 'draft', 'docs', 'specs', 'd-a', 'spec.json');
    await fs.mkdir(path.dirname(specFile), { recursive: true });
    await fs.writeFile(specFile, JSON.stringify(spec));
    await fs.writeFile(path.join(root, 'draft', 'program.json'), JSON.stringify({ version: 1, draftId: 'd', status: 'running', updatedAt: '', items: [{ specId: 'd-a', key: 'a', rank: 1, dependsOn: [], status: 'running', runId: 'd-a-r1', completeRunId: null, startedAt: null, finishedAt: null, reason: null, resumes: 0 }] }));
    await journal('d-a-r1', [started('d-a'), finished('awaiting-validation')]);
    await fs.mkdir(path.join(root, 'secrets'), { recursive: true });
    await fs.writeFile(path.join(root, 'secrets', 'DB_PASSWORD'), 'p@ss w0rd!');
    const deps = (service() as unknown as { deps: ConstructorParameters<typeof ProgramService>[0] }).deps;
    const spawn = (a: { args: string[]; logFile: string }) => {
      mkdirSync(path.dirname(a.logFile), { recursive: true });
      // The secret starts 5 characters before the 500 character cut, so the cut must not come before the redaction.
      writeFileSync(a.logFile, `p@ss w0rd!${'y'.repeat(495)}`);
      return { pid: 4242 };
    };
    const svc = new ProgramService({ ...deps, control: { ...deps.control, spawn, kill: () => false } });
    const failure = await svc.tick('shop', 'd').then(() => '', (err: unknown) => String(err));
    const saved = await fs.readFile(path.join(root, 'draft', 'program.json'), 'utf8');
    expect(failure + saved).not.toContain('p@ss');
    expect(failure + saved).not.toContain('w0rd');
  });

  it('does nothing for a draft without a program or with a finished one', async () => {
    const s = service();
    expect(await s.tick('shop', 'd')).toBeNull();
    await fs.mkdir(path.join(root, 'draft'), { recursive: true });
    await fs.writeFile(path.join(root, 'draft', 'program.json'), JSON.stringify({ version: 1, draftId: 'd', status: 'finished', updatedAt: '', items: [] }));
    expect(await s.tick('shop', 'd')).toBeNull();
  });

  // R11.14: a failed run is classified, and the next run reads the failures.
  it('runs a failed spec again with its failure in a note, and leaves a spec problem to the owner', async () => {
    await fs.mkdir(path.join(root, 'draft', 'docs'), { recursive: true });
    await fs.writeFile(path.join(root, 'draft', 'docs', 'project.json'), JSON.stringify(makeProject()));
    const item = { specId: 'd-a', key: 'a', rank: 1, dependsOn: [], status: 'running', runId: 'd-a-r1', completeRunId: null, startedAt: null, finishedAt: null, reason: null, resumes: 0 };
    const ledger = path.join(root, 'draft', 'program.json');
    await fs.writeFile(ledger, JSON.stringify({ version: 1, draftId: 'd', status: 'running', updatedAt: '', items: [item] }));
    await journal('d-a-r1', [started('d-a'), finished('verification-failed', { reason: 'AC-004 missing' })]);
    const cause = (value: string) => ({ decide: async () => ({ answered: true as const, backend: 'jev' as const, escalated: false, answers: { cause: { type: 'choice' as const, value, probabilities: { [value]: 1 }, confidence: 1 } } }) });
    const again = await service(cause('code-defect')).tick('shop', 'd');
    expect(again!.items[0]).toMatchObject({ repairs: 1, failures: ['verification-failed: AC-004 missing'] });
    expect(await fs.readFile(path.join(root, 'draft', 'repair', 'd-a.md'), 'utf8')).toContain('verification-failed: AC-004 missing');
    await fs.writeFile(ledger, JSON.stringify({ version: 1, draftId: 'd', status: 'running', updatedAt: '', items: [item] }));
    const final = await service(cause('spec-problem')).tick('shop', 'd');
    expect(final!.items[0]).toMatchObject({ status: 'failed', reason: 'verification-failed: AC-004 missing' });
  });
});

describe('a spec already delivered', () => {
  it('is never frozen again: the repair reads the run that delivered it and ends with its real reason', async () => {
    await fs.mkdir(path.join(root, 'draft', 'docs', 'specs', 'd-a'), { recursive: true });
    await fs.writeFile(path.join(root, 'draft', 'docs', 'project.json'), JSON.stringify(makeProject()));
    await fs.writeFile(path.join(root, 'draft', 'docs', 'specs', 'd-a', 'spec.json'), JSON.stringify({ ...makeFrozenSpec({ specId: 'd-a' }), status: 'awaiting-validation' }));
    const item = { specId: 'd-a', key: 'a', rank: 1, dependsOn: [], status: 'running', runId: 'd-a-r1', completeRunId: null, startedAt: null, finishedAt: null, reason: null, resumes: 0 };
    await fs.writeFile(path.join(root, 'draft', 'program.json'), JSON.stringify({ version: 1, draftId: 'd', status: 'running', updatedAt: '', items: [item] }));
    await journal('d-a-r1', [started('d-a'), finished('awaiting-validation', { blocked: [{ taskId: 'T5', reason: 'no change' }] })]);
    const cause = { decide: async () => ({ answered: true as const, backend: 'jev' as const, escalated: false, answers: { cause: { type: 'choice' as const, value: 'code-defect', probabilities: { 'code-defect': 1 }, confidence: 1 } } }) };
    let p = await service(cause).tick('shop', 'd');
    expect(p!.items[0]).toMatchObject({ repairs: 1 });
    for (let i = 0; i < 3 && p!.items[0]!.status !== 'failed'; i++) p = await service(cause).tick('shop', 'd');
    expect(p!.items[0]).toMatchObject({ status: 'failed' });
    expect(p!.items[0]!.reason).toMatch(/^finished with 1 blocked task\(s\): T5 /);
    expect(p!.items[0]!.reason).not.toContain('only refining or planned specs can be frozen');
  });
});

describe('repair notes', () => {
  it('reads back what was written, and nothing when there is no note', async () => {
    expect(await readRepairNotes(path.join(root, 'draft'), 'd-a')).toBeNull();
    await writeRepairNotes(path.join(root, 'draft'), 'd-a', ['one', 'two']);
    const text = (await readRepairNotes(path.join(root, 'draft'), 'd-a'))!;
    expect(text).toContain('attempt 1 failed: one');
    expect(text).toContain('attempt 2 failed: two');
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
    await expect(service().prioritize('shop', 'd', 'd-a')).rejects.toThrow(/d-a is done/);
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

describe('program service view', () => {
  const item = (key: string, status: string, runId: string | null) => ({ specId: `d-${key}`, key, rank: key.charCodeAt(0), dependsOn: [], status, runId, completeRunId: null, startedAt: null, finishedAt: null, reason: null, resumes: 0, costUsd: null });
  const write = async (items: unknown[]) => {
    await fs.mkdir(path.join(root, 'draft'), { recursive: true });
    await fs.writeFile(path.join(root, 'draft', 'program.json'), JSON.stringify({ version: 1, draftId: 'd', status: 'running', updatedAt: '', items }));
  };
  const pr = (number: number) => ({ type: 'PR_CREATED', data: { branch: `b${number}`, number, url: `https://github.com/o/r/pull/${number}`, created: true } });

  it('lists the pull requests of an item\'s runs once each, by number, and none for an item that never ran', async () => {
    await write([item('a', 'running', 'a-r1'), item('b', 'pending', null)]);
    await journal('a-r1', [started('d-a'), pr(7), pr(3), pr(7)]);
    const view = await service().view('shop', 'd');
    expect(view!.items[0]!.prs).toEqual([{ number: 3, url: 'https://github.com/o/r/pull/3' }, { number: 7, url: 'https://github.com/o/r/pull/7' }]);
    expect(view!.items[1]!.prs).toEqual([]);
  });

  it('says why and until when a run waits, and stops saying it once the run goes on or its process was restarted', async () => {
    await write([item('a', 'running', 'a-r1'), item('b', 'running', 'b-r1'), item('c', 'running', 'c-r1')]);
    await journal('a-r1', [started('d-a'), { type: 'RUN_PAUSED', data: { reason: 'quota', until: '2026-10-13T18:30:00.000Z' } }]);
    await journal('b-r1', [started('d-b'), { type: 'RUN_PAUSED', data: { reason: 'quota', until: 'x' } }, { type: 'RUN_RESUMED', data: {} }]);
    await journal('c-r1', [started('d-c'), { type: 'RUN_PAUSED', data: { reason: 'quota', until: 'old' } }]);
    for (const [id, status] of [['a-r1', 'paused:quota'], ['b-r1', 'running'], ['c-r1', 'running']]) await fs.writeFile(path.join(runsDir(), id, 'state.json'), JSON.stringify({ status }));
    const view = await service().view('shop', 'd');
    expect(view!.items[0]!.pause).toEqual({ reason: 'quota', until: '2026-10-13T18:30:00.000Z' });
    expect(view!.items[1]!.pause).toBeUndefined();
    // A restart journals no resume: the old pause stays the last event, and the run's own state says it goes on.
    expect(view!.items[2]!.pause).toBeUndefined();
  });

  it('lists the decisions of the runs, the newest first, with what each question came to', async () => {
    await write([item('a', 'running', 'a-r1'), item('b', 'running', 'b-r1')]);
    const decision = (decisionId: string, at: string, answers: unknown, backend: string | null = 'jev') => ({ type: 'DECISION_MADE', data: { record: { decisionId, backend, model: 'm', escalated: false, answers, attempts: [], usage: {}, at } } });
    await journal('a-r1', [started('d-a'), decision('model-tier', '2026-10-13T10:00:00.000Z', { tier: { type: 'choice', value: 'large', probabilities: {}, confidence: 0.9 } })]);
    await journal('b-r1', [started('d-b'), decision('pr-risk', '2026-10-13T11:00:00.000Z', null), decision('scope-drift', '2026-10-13T11:30:00.000Z', null, null), decision('failure-cause', '2026-10-13T09:00:00.000Z', { cause: { type: 'noul', value: 0.7, probabilities: { yes: 0.7, no: 0.3 }, confidence: 0.7 } })]);
    const { decisions: list, unanswered } = await service().decisions('shop', 'd');
    expect(list.map((x) => `${x.key}:${x.decisionId}`)).toEqual(['b:pr-risk', 'a:model-tier', 'b:failure-cause']);
    expect(list[1]!.answers).toEqual([{ question: 'tier', value: 'large', confidence: 0.9 }]);
    expect(unanswered).toBe(1);
    expect((await service().decisions('shop', 'd', 2)).decisions).toHaveLength(2);
  });

  it('is null without a program, and keeps the pull requests of a finished item without reading its journal again', async () => {
    const s = service();
    expect(await s.view('shop', 'd')).toBeNull();
    await write([item('a', 'done', 'a-r1')]);
    await journal('a-r1', [started('d-a'), pr(4)]);
    expect((await s.view('shop', 'd'))!.items[0]!.prs).toHaveLength(1);
    await fs.rm(path.join(runsDir(), 'a-r1'), { recursive: true });
    expect((await s.view('shop', 'd'))!.items[0]!.prs).toHaveLength(1);
  });
});
