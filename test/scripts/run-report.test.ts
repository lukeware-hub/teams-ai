import { describe, expect, it } from 'vitest';
import { runReport, type JournalEvent } from '../../scripts/run-report.js';

const task = (id: string) => ({ id, title: id, description: id, criteriaRefs: [], dependsOn: [], affectedPaths: ['src'], owner: 'dev' });
const events: JournalEvent[] = [
  { type: 'TASK_PLANNED', data: { task: task('T001') } },
  { type: 'TASK_PLANNED', data: { task: task('T002') } },
  { type: 'ATTEMPT_CONSUMED', data: { taskId: 'T001' } },
  { type: 'STEP_FINISHED', data: { taskId: 'T001', costUsd: 0.5, profile: { sessionTotalsReset: true } } },
  { type: 'STEP_FINISHED', data: { taskId: 'T001', costUsd: 0.25 } },
  { type: 'STEP_FINISHED', data: { taskId: 'T002', costUsd: 1, failure: "fatal: '/w/t2' already exists (git worktree add)" } },
  { type: 'TASK_BLOCKED', data: { taskId: 'T002', reason: 'gate failed' } },
];

describe('runReport', () => {
  it('gives one row per task with its cost, resets, worktree failures and block reason', () => {
    const rows = runReport(events);
    expect(rows.find((r) => r.taskId === 'T001')).toMatchObject({ attempts: 1, costUsd: 0.75, sessionResets: 1, worktreeExists: 0, blockedReason: null });
    expect(rows.find((r) => r.taskId === 'T002')).toMatchObject({ costUsd: 1, worktreeExists: 1, blockedReason: 'gate failed' });
  });

  it('ignores events of unknown tasks', () => {
    expect(runReport([...events, { type: 'STEP_FINISHED', data: { taskId: 'X', costUsd: 9 } }])).toHaveLength(2);
  });
});
