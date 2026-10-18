import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { refineApi, type Snapshot, type StoredEvent } from '../api.js';
import { RefinementPage } from './Refinement.js';

const journal = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock('../useSse.js', () => ({ useJournal: (url: string | null) => ({ events: url ? journal.events : [], ended: false, error: null }) }));

const event = (seq: number, type: string, data: Record<string, unknown>): StoredEvent => ({ seq, at: '', runId: 'hello-app/hello-001', specHash: 'draft', type, kind: 'fact', data });
const patch = { patchId: 'sm-c1-0', role: 'sm' as const, file: 'brief.md' as const, find: 'a', replace: 'b', reason: 'clearer', diff: '--- brief.md\n-a\n+b\n', cycle: 1 };
const snapshot = (seq: number): Snapshot => ({
  projectId: 'hello-app',
  specId: 'hello-001',
  seq,
  docs: { 'project.md': '# Hello', 'brief.md': 'a', 'stack.md': '# Stack', 'flow.md': '# Flow', 'design.md': '# Design' },
  secrets: [],
  tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 },
  state: { status: 'error', stale: false, cycle: 1, derived: null, checklist: [], questions: [], patches: [{ ...patch, status: 'pending', decision: null }], discarded: [], moves: [], error: 'sm refine failed', runId: null },
});

describe('RefinementPage journal replay', () => {
  it('applies only the events after the snapshot, so a reload after a failed cycle shows each patch once', async () => {
    journal.events = [event(1, 'REFINE_CYCLE_STARTED', { cycle: 1, draftHash: 'h' }), event(2, 'PATCH_PROPOSED', patch), event(3, 'REFINE_CYCLE_FAILED', { cycle: 1, reason: 'sm refine failed' })];
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue(snapshot(3));
    render(<MemoryRouter initialEntries={['/refine/hello-app/hello-001']}><Routes><Route path="/refine/:projectId/:specId" element={<RefinementPage />} /></Routes></MemoryRouter>);
    await screen.findByTestId('accept-sm-c1-0');
    await new Promise((r) => setTimeout(r, 20));
    await waitFor(() => expect(screen.getAllByTestId('accept-sm-c1-0')).toHaveLength(1));
  });

  it('opens the execution screen when the backlog starts', async () => {
    const backlog = { enabled: true, detail: true, epics: [], items: [], specs: {}, preplans: {}, flowHeadings: [] };
    const ready = snapshot(1);
    journal.events = [event(2, 'REFINE_STARTED_RUN', { runId: 'hello-app--base--run-1' })];
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue({ ...ready, state: { ...ready.state, status: 'ready', error: null, patches: [], backlog } as never });
    render(
      <MemoryRouter initialEntries={['/refine/hello-app/hello-001']}>
        <Routes>
          <Route path="/refine/:projectId/:specId" element={<RefinementPage />} />
          <Route path="/refine/:projectId/:specId/program" element={<p>tela da execução</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('tela da execução')).toBeTruthy();
  });
});
