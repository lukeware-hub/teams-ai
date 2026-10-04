import { describe, expect, it } from 'vitest';
import { OrchEvent } from '../../server/orchestrator/events.js';
import { blockReason } from '../../server/orchestrator/phases/report.js';

describe('report blocked reasons', () => {
  it('uses the latest journaled TaskBlocked reason, not a placeholder', () => {
    const events = [
      { type: OrchEvent.TaskBlocked, data: { taskId: 'T1', reason: 'first' } },
      { type: OrchEvent.TaskBlocked, data: { taskId: 'T2', reason: 'other task' } },
      { type: OrchEvent.TaskBlocked, data: { taskId: 'T1', reason: 'Dev reported done but produced no changes against origin/main.' } },
    ];
    expect(blockReason(events, 'T1')).toBe('Dev reported done but produced no changes against origin/main.');
    expect(blockReason(events, 'T3')).toBe('blocked');
  });
});
