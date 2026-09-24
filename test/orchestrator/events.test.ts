import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Intent, Journal, OrchEvent, intentId } from '../../server/orchestrator/events.js';
import { RunEvent } from '../../server/pipeline/run-state.js';
import { makePlanTask } from '../fixtures/contracts.js';

const HASH = 'sha256:' + 'c'.repeat(64);
let dir = '';
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});
async function open() {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-journal-'));
  return Journal.open({ file: path.join(dir, 'events.ndjson'), runId: 'spec-r1', specHash: HASH, clock: () => new Date('2026-09-24T10:00:00Z') });
}

describe('Journal', () => {
  it('reduces run-state events on append and on reopen', async () => {
    const j = await open();
    await j.fact(RunEvent.TaskPlanned, { task: makePlanTask({ id: 'T1' }) });
    await j.fact(RunEvent.TaskStateChanged, { taskId: 'T1', to: 'ready' });
    expect(j.state.tasks.get('T1')!.state).toBe('ready');
    await j.close();
    const again = await Journal.open({ file: path.join(dir, 'events.ndjson'), runId: 'spec-r1', specHash: HASH });
    expect(again.state.tasks.get('T1')!.state).toBe('ready');
    expect(again.events).toHaveLength(2);
    await again.close();
  });

  it('pairs intents and confirms by a deterministic id', async () => {
    const j = await open();
    await j.intent(Intent.Commit, 'T1', { worktree: '/w' });
    expect(j.unconfirmed().map((e) => e.intentId)).toEqual([intentId(Intent.Commit, 'T1')]);
    expect(j.isConfirmed(Intent.Commit, 'T1')).toBe(false);
    await j.confirm(Intent.Commit, 'T1', { sha: 'abc' });
    expect(j.unconfirmed()).toEqual([]);
    expect(j.isConfirmed(Intent.Commit, 'T1')).toBe(true);
    await j.close();
  });

  it('numbers steps, returns the last feedback per task and collects assumptions', async () => {
    const j = await open();
    expect(j.nextStepSeq()).toBe(1);
    await j.fact(OrchEvent.StepStarted, { stepId: 's00001', kind: 'dev' });
    expect(j.nextStepSeq()).toBe(2);
    expect(j.lastFeedback('T1')).toBeNull();
    await j.fact(OrchEvent.Feedback, { taskId: 'T1', text: 'gate unit-test failed' });
    await j.fact(OrchEvent.Feedback, { taskId: 'T2', text: 'other' });
    await j.fact(OrchEvent.Feedback, { taskId: 'T1', text: 'review: findings' });
    expect(j.lastFeedback('T1')).toBe('review: findings');
    await j.fact(OrchEvent.SpecGapAnswered, { taskId: 'T1', question: 'q', answer: 'a', assumption: 'T1: q → a' });
    expect(j.assumptions()).toEqual(['T1: q → a']);
    await j.close();
  });
});
