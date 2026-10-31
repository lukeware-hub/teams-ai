import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownerDecisionLines, pairDecisions, readOwnerDecisions, recordOwnerDecisions } from '../../server/orchestrator/owner-decisions.js';

let root = '';
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-decisions-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('owner decisions', () => {
  it('keeps one answer per run and task, and reads back empty when none was given', async () => {
    expect(await readOwnerDecisions(root, 'spec-a')).toEqual([]);
    await recordOwnerDecisions(root, 'spec-a', [{ runId: 'spec-a--run-1', taskId: 'T1', specHash: 'h1', question: 'Which Go?', answer: 'Go 1.26.9' }]);
    await recordOwnerDecisions(root, 'spec-a', [
      { runId: 'spec-a--run-1', taskId: 'T1', specHash: 'h1', question: 'Which Go?', answer: 'Go 1.27.2' },
      { runId: 'spec-a--run-1', taskId: 'T2', specHash: 'h1', question: 'Which DB?', answer: 'SQLite' },
    ]);
    expect(await readOwnerDecisions(root, 'spec-a')).toEqual([
      { runId: 'spec-a--run-1', taskId: 'T1', specHash: 'h1', question: 'Which Go?', answer: 'Go 1.27.2' },
      { runId: 'spec-a--run-1', taskId: 'T2', specHash: 'h1', question: 'Which DB?', answer: 'SQLite' },
    ]);
  });

  it('states each answer as a binding assumption for its spec version only', () => {
    const decisions = [
      { runId: 'r', taskId: 'T1', specHash: 'h1', question: 'Which Go?', answer: 'Go 1.26.9' },
      { runId: 'r', taskId: 'T2', specHash: 'h0', question: 'Which DB?', answer: 'SQLite' },
    ];
    expect(ownerDecisionLines(decisions, 'h1')).toEqual(['Owner decision (binding) for T1: Which Go? → Go 1.26.9']);
  });
});

describe('pairDecisions', () => {
  it('gives each question the answer of its own run, task and wording, and null while it waits', () => {
    const asked = [
      { taskId: 'T1', runId: 'r1', question: 'Which Go?' },
      { taskId: 'T1', runId: 'r1', question: 'Which image?' },
      { taskId: 'T1', runId: 'r2', question: 'Which Go?' },
    ];
    const answers = [{ runId: 'r1', taskId: 'T1', specHash: 'h1', question: 'Which Go?', answer: 'Go 1.26.9' }];
    expect(pairDecisions(asked, answers)).toEqual([
      { taskId: 'T1', runId: 'r1', question: 'Which Go?', answer: 'Go 1.26.9' },
      { taskId: 'T1', runId: 'r1', question: 'Which image?', answer: null },
      { taskId: 'T1', runId: 'r2', question: 'Which Go?', answer: null },
    ]);
  });
});
