import { describe, expect, it } from 'vitest';
import { graphReport } from '../../scripts/graph-report.js';
import type { StoredEvent } from '../../server/store/event-store.js';

const finished = (kind: string, costUsd: number, profile: Record<string, unknown>, runId = 'r1'): StoredEvent =>
  ({ seq: 1, at: '2026-11-06T00:00:00Z', runId, specHash: 'h', type: 'STEP_FINISHED', kind: 'fact', data: { kind, costUsd, ok: true, profile } }) as StoredEvent;

describe('graphReport', () => {
  it('says how often the graph answered and what the steps that used it cost next to the ones that did not', () => {
    const report = graphReport([
      finished('speckit', 0.3, { toolCalls: { Read: 4 }, graphQueries: 4, graphEmpty: 1, graphTruncated: 2, graphResultChars: 10 }),
      finished('speckit', 0.2, { toolCalls: { Read: 8 }, graphQueries: 0 }),
    ]);
    expect(report).toMatchObject({ queries: 4, measuredQueries: 4, usefulShare: 0.75, truncatedShare: 0.5 });
    expect(report.byKind.speckit!.withGraph).toMatchObject({ steps: 1, costUsd: 0.3, reads: 4 });
    expect(report.byKind.speckit!.withoutGraph).toMatchObject({ steps: 1, costUsd: 0.2, reads: 8 });
    expect(report.byKind.speckit!.costChange).toBeCloseTo(0.5);
  });

  it('leaves out of the shares the steps recorded before the answer figures existed', () => {
    const report = graphReport([finished('speckit', 0.3, { toolCalls: {}, graphQueries: 6 })]);
    expect(report).toMatchObject({ queries: 6, measuredQueries: 0, usefulShare: null });
  });

  it('compares the specs that had the graph with the control specs, by step kind, from the arm each run journaled', () => {
    const start = (runId: string, arm?: string): StoredEvent => ({ seq: 1, at: '2026-11-06T00:00:00Z', runId, specHash: 'h', type: 'RUN_STARTED', kind: 'fact', data: { specId: runId, ...(arm ? { graphArm: arm } : {}) } }) as StoredEvent;
    const report = graphReport([
      start('a', 'graph'), finished('dev', 0.3, { toolCalls: { Read: 2 }, graphQueries: 0 }, 'a'),
      start('b', 'control'), finished('dev', 0.4, { toolCalls: { Read: 8 }, graphQueries: 0 }, 'b'),
      start('c'), finished('dev', 9, { toolCalls: { Read: 99 }, graphQueries: 0 }, 'c'),
    ]);
    expect(report.experiment.dev!.graph).toMatchObject({ steps: 1, costUsd: 0.3, reads: 2 });
    expect(report.experiment.dev!.control).toMatchObject({ steps: 1, costUsd: 0.4, reads: 8 });
    expect(report.experiment.dev!.costChange).toBeCloseTo(-0.25);
    // One spec in each arm is far from enough: the report says the difference is not a result.
    expect(report.experiment.dev).toMatchObject({ specs: { graph: 1, control: 1 }, conclusive: false });
  });

  it('gives no share and no cost change when nothing was queried or one group is empty', () => {
    const report = graphReport([finished('dev', 0.2, { toolCalls: {}, graphQueries: 0 })]);
    expect(report).toMatchObject({ queries: 0, usefulShare: null, truncatedShare: null });
    expect(report.byKind.dev!.costChange).toBeNull();
  });
});
