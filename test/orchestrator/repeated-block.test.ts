import { describe, expect, it } from 'vitest';
import { OrchEvent } from '../../server/orchestrator/events.js';
import { repeatedBlock } from '../../server/orchestrator/run.js';

const finished = (result: string, blocked: Array<{ taskId: string; reason: string }> = []) => ({ type: OrchEvent.RunFinished, data: { result, blocked } });
const stalled = 'Dev reported done but produced no changes against origin/main. Implement the task or return spec-gap.';

describe('repeatedBlock', () => {
  it('is true when the last two finishes are blocked on the same task for the same reason', () => {
    const events = [finished('blocked', [{ taskId: 'T1', reason: stalled }]), { type: 'RUN_REOPENED', data: { auto: true } }, finished('blocked', [{ taskId: 'T1', reason: `${stalled}\n\nAttempt progress judged stalled (rule)` }])];
    expect(repeatedBlock(events)).toBe(true);
  });

  it('is false when the reason changes between the finishes', () => {
    const events = [finished('blocked', [{ taskId: 'T1', reason: stalled }]), finished('blocked', [{ taskId: 'T1', reason: 'spec-gap rounds exhausted (3)' }])];
    expect(repeatedBlock(events)).toBe(false);
  });

  it('is false with a single finish, and when the last finish is not blocked', () => {
    expect(repeatedBlock([finished('blocked', [{ taskId: 'T1', reason: stalled }])])).toBe(false);
    expect(repeatedBlock([finished('blocked', [{ taskId: 'T1', reason: stalled }]), finished('awaiting-validation')])).toBe(false);
  });
});
