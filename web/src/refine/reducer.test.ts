import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../api.js';
import { applyToSnapshot } from './reducer.js';

const snap: Snapshot = {
  projectId: 'p',
  specId: 's',
  docs: { 'project.md': '', 'brief.md': '', 'stack.md': '', 'flow.md': '', 'design.md': '' },
  secrets: [],
  tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 },
  state: { status: 'drafting', stale: false, cycle: 0, derived: null, checklist: [], questions: [], patches: [], discarded: [], error: null, runId: null },
};
const ev = (seq: number, type: string, data: Record<string, unknown>) => ({ seq, at: '', runId: 'p/s', specHash: 'draft', type, kind: 'fact' as const, data });

describe('applyToSnapshot', () => {
  it('reduces journal events into the state and flags a patch edit for refetch', () => {
    const s1 = applyToSnapshot(snap, ev(1, 'REFINE_CYCLE_STARTED', { cycle: 1, draftHash: 'h' }));
    expect(s1.state.status).toBe('evaluating');
    expect(snap.state.status).toBe('drafting');
    const s2 = applyToSnapshot(s1, ev(2, 'DOC_EDITED', { file: 'brief.md', hash: 'x', source: 'patch' }));
    expect(s2.docsDirty).toBe(true);
  });
});
