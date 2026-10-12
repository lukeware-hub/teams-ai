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
    // Docs main brought in before a start reload too, so an open editor never writes over them.
    expect(applyToSnapshot(snap, ev(3, 'DOC_EDITED', { file: 'project.md', hash: 'y', source: 'main' })).docsDirty).toBe(true);
    expect(applyToSnapshot(snap, ev(4, 'DOC_EDITED', { file: 'project.md', hash: 'z', source: 'human' })).docsDirty).toBe(false);
    // R11.10 (plan 90): an answer the orchestrator wrote into the briefing reloads it too.
    expect(applyToSnapshot(snap, ev(5, 'DOC_EDITED', { file: 'brief.md', hash: 'w', source: 'decision' })).docsDirty).toBe(true);
  });

  it('turns the backlog on and keeps what a backlog cycle derived', () => {
    const on = applyToSnapshot(snap, ev(1, 'BACKLOG_ENABLED', {}));
    expect(on.state.backlog).toMatchObject({ enabled: true, items: [] });
    const derived = applyToSnapshot(on, ev(2, 'BACKLOG_DERIVED', { cycle: 1, project: {}, epics: [{ key: 'core', title: 'Core' }], items: [{ key: 'base', rank: 1 }] }));
    expect(derived.state.backlog?.items).toHaveLength(1);
    expect(snap.state.backlog).toBeUndefined();
  });
});
