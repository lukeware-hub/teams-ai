import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { failureLines, failureLinks, failureSignature, failuresOf, linkFailures, readRunJournals } from '../../server/knowledge/failure-memory.js';
import type { RunJournal } from '../../server/knowledge/brain-notes.js';
import type { StoredEvent } from '../../server/store/event-store.js';

const ev = (type: string, data: Record<string, unknown>, at = '2026-11-11T00:00:00Z'): StoredEvent => ({ seq: 1, at, runId: 'r', specHash: 'h', type, kind: 'fact', data }) as StoredEvent;
const run = (runId: string, specId: string, at: string, result: string, reason: string | null): RunJournal => ({
  runId,
  events: [ev('RUN_STARTED', { specId }, at), ...(reason ? [ev('PHASE_FAILED', { phase: 0, reason }, at)] : []), ev('RUN_FINISHED', { result, reason }, at)],
});
const MISSING = (spec: string) => `the document docs/svc-api/specify/${spec}/plan.md is not in the closing snapshot`;

describe('failureSignature', () => {
  it('reads the same cause the same, whatever path, id or number it names', () => {
    expect(failureSignature(MISSING('a'))).toBe('the document <path> is not in the closing snapshot');
    expect(failureSignature(MISSING('b'))).toBe(failureSignature(MISSING('a')));
    expect(failureSignature('gate failed after 3 tries at https://x.io/y commit 9f8e7d6c5b')).toBe('gate failed after <n> tries at <url> commit <id>');
  });
});

describe('failuresOf', () => {
  it('lists the runs that ended without delivering, and the later run that delivered the spec', () => {
    const failures = failuresOf([
      run('p--a--run-1', 'a', '2026-11-11T01:00:00Z', 'phase-failed', MISSING('a')),
      run('p--a--run-2', 'a', '2026-11-11T02:00:00Z', 'phase-failed', MISSING('a')),
      run('p--a--run-3', 'a', '2026-11-11T03:00:00Z', 'awaiting-validation', null),
      run('p--b--run-1', 'b', '2026-11-11T01:00:00Z', 'phase-failed', MISSING('b')),
    ]);
    expect(failures.map((f) => [f.specId, f.runNo, f.fixedInRun])).toEqual([['a', 1, 3], ['a', 2, 3], ['b', 1, undefined]]);
  });

  it('reads the cause of a blocked run from its blocked tasks, leaving out the ones that only waited', () => {
    const blocked = [
      { taskId: 'T3', reason: 'Review requested changes: the test checks nothing' },
      { taskId: 'T4', reason: 'a dependency is blocked' },
    ];
    const journal: RunJournal = { runId: 'p--a--run-1', events: [ev('RUN_STARTED', { specId: 'a' }), ev('RUN_FINISHED', { result: 'blocked', reason: null, blocked })] };
    expect(failuresOf([journal])[0]).toMatchObject({ specId: 'a', result: 'blocked', reason: 'T3: Review requested changes: the test checks nothing' });
    const onlyWaited: RunJournal = { runId: 'p--b--run-1', events: [ev('RUN_STARTED', { specId: 'b' }), ev('RUN_FINISHED', { result: 'blocked', reason: null, blocked: [blocked[1]] })] };
    expect(failuresOf([onlyWaited])).toEqual([]);
  });

  it('masks a secret the reason quotes, so it never reaches a brief', () => {
    const key = 'sk-ant-abcdefghij1234567890';
    const [failure] = failuresOf([run('p--a--run-1', 'a', '2026-11-11T01:00:00Z', 'blocked', `gate failed: ANTHROPIC_API_KEY=${key} rejected`)]);
    expect(failure!.reason).not.toContain(key);
    expect(failureLines([failure!], 'a').join('\n')).not.toContain(key);
  });

  it('leaves out a run that delivered, one that only drained, and a failure with no reason', () => {
    expect(failuresOf([run('p--a--run-1', 'a', '2026-11-11T01:00:00Z', 'done', null), run('p--a--run-2', 'a', '2026-11-11T02:00:00Z', 'drained', null), run('p--a--run-3', 'a', '2026-11-11T03:00:00Z', 'blocked', null)])).toEqual([]);
  });
});

describe('failureLines', () => {
  const gate = () => 'task T1 never passed review after 3 tries';
  const failures = failuresOf([
    run('p--a--run-1', 'a', '2026-11-11T01:00:00Z', 'blocked', gate()),
    run('p--a--run-2', 'a', '2026-11-11T02:00:00Z', 'phase-failed', MISSING('a')),
    run('p--b--run-1', 'b', '2026-11-11T01:00:00Z', 'blocked', gate()),
    run('p--c--run-1', 'c', '2026-11-11T01:00:00Z', 'deadlocked', 'two tasks wait for each other'),
  ]);

  it('tells a spec its own earlier failure and the other specs the same cause stopped', () => {
    expect(failureLines(failures, 'a')).toEqual([
      '- Earlier failure of this spec (run-1, blocked): task T1 never passed review after 3 tries — not delivered since',
      '- The same cause stopped: b',
    ]);
  });

  it('names the runs by their ids, and the later run that delivered the spec', () => {
    const lines = failureLines(failuresOf([run('p--a--run-5', 'a', '2026-11-11T01:00:00Z', 'blocked', gate()), run('p--a--run-7', 'a', '2026-11-11T02:00:00Z', 'done', null)]), 'a');
    expect(lines).toEqual(['- Earlier failure of this spec (run-5, blocked): task T1 never passed review after 3 tries — a later run delivered it (run-7)']);
  });

  it('leaves out a failure of the platform, says nothing for a spec that never failed, and names no other spec for a cause only it had', () => {
    expect(failureLines(failures, 'z')).toEqual([]);
    expect(failureLines(failures, 'c')).toHaveLength(1);
    expect(failureLines(failuresOf([run('p--a--run-1', 'a', '2026-11-11T01:00:00Z', 'phase-failed', MISSING('a'))]), 'a')).toEqual([]);
  });
});

describe('readRunJournals', () => {
  it('reads the journals of the runs of one project and leaves the others out', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runs-'));
    for (const id of ['p--a--run-1', 'q--a--run-1']) {
      await fs.mkdir(path.join(dir, id), { recursive: true });
      await fs.writeFile(path.join(dir, id, 'events.ndjson'), `${JSON.stringify(ev('RUN_STARTED', { specId: 'a' }))}\n`);
    }
    const journals = await readRunJournals(dir, 'p');
    expect(journals.map((j) => [j.runId, j.events.length])).toEqual([['p--a--run-1', 1]]);
    expect(await readRunJournals(path.join(dir, 'none'), 'p')).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('failureLinks and linkFailures', () => {
  const failures = failuresOf([
    run('p--a--run-1', 'a', '2026-11-11T01:00:00Z', 'phase-failed', MISSING('a')),
    run('p--a--run-2', 'a', '2026-11-11T02:00:00Z', 'phase-failed', MISSING('a')),
    run('p--b--run-1', 'b', '2026-11-11T01:00:00Z', 'phase-failed', MISSING('b')),
    run('p--c--run-1', 'c', '2026-11-11T01:00:00Z', 'phase-failed', MISSING('c')),
  ]);
  const heading = (spec: string, n: number, id: string) => ({ id, label: `Execução ${n} — phase-failed`, source_file: `brain/runs/${spec}.md` });

  it('chains each failure to the first one of another spec with the same cause, and never to the same spec', () => {
    expect(failureLinks(failures).map((l) => `${l.fromFile.slice(11, -3)}#${l.fromHeading.slice(9, 10)}>${l.toFile.slice(11, -3)}#${l.toHeading.slice(9, 10)}`)).toEqual(['b#1>a#1', 'c#1>a#1']);
  });

  it('adds a similar_failure edge between the headings the graph holds, and nothing for a heading it lacks or twice', () => {
    const graph = { nodes: [heading('a', 1, 'a1'), heading('b', 1, 'b1')], links: [] as Array<{ source: string; target: string; relation?: string }> };
    const once = linkFailures(graph, failureLinks(failures));
    expect(once.added).toBe(1);
    expect(once.graph.links[0]).toMatchObject({ source: 'b1', target: 'a1', relation: 'similar_failure', _origin: 'failures' });
    expect(linkFailures(once.graph, failureLinks(failures)).added).toBe(0);
  });
});
