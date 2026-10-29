import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownerDecisionLines, readOwnerDecisions, recordOwnerDecisions } from '../../server/orchestrator/owner-decisions.js';

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
    await recordOwnerDecisions(root, 'spec-a', [{ runId: 'spec-a--run-1', taskId: 'T1', question: 'Which Go?', answer: 'Go 1.26.9' }]);
    await recordOwnerDecisions(root, 'spec-a', [
      { runId: 'spec-a--run-1', taskId: 'T1', question: 'Which Go?', answer: 'Go 1.27.2' },
      { runId: 'spec-a--run-1', taskId: 'T2', question: 'Which DB?', answer: 'SQLite' },
    ]);
    expect(await readOwnerDecisions(root, 'spec-a')).toEqual([
      { runId: 'spec-a--run-1', taskId: 'T1', question: 'Which Go?', answer: 'Go 1.27.2' },
      { runId: 'spec-a--run-1', taskId: 'T2', question: 'Which DB?', answer: 'SQLite' },
    ]);
  });

  it('states each answer as a binding assumption for the spec', () => {
    expect(ownerDecisionLines([{ runId: 'r', taskId: 'T1', question: 'Which Go?', answer: 'Go 1.26.9' }])).toEqual(['Owner decision (binding) for T1: Which Go? → Go 1.26.9']);
  });
});
