import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refineApi, type Snapshot, type StoredEvent } from '../api.js';
import { RefinementPage } from './Refinement.js';

const journal = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock('../useSse.js', () => ({ useJournal: (url: string | null) => ({ events: url ? journal.events : [], ended: false, error: null }) }));

const event = (seq: number, type: string, data: Record<string, unknown>): StoredEvent => ({ seq, at: '', runId: 'hello-app/hello-001', specHash: 'draft', type, kind: 'fact', data });
const patch = { patchId: 'sm-c1-0', role: 'sm' as const, file: 'briefing.md' as const, find: 'a', replace: 'b', reason: 'clearer', diff: '--- briefing.md\n-a\n+b\n', cycle: 1 };
const snapshot = (seq: number): Snapshot => ({
  projectId: 'hello-app',
  specId: 'hello-001',
  seq,
  docs: { 'project.md': '# Hello', 'briefing.md': 'a', 'stack.md': '# Stack', 'flow.md': '# Flow', 'design.md': '# Design' },
  secrets: [],
  tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 },
  state: { status: 'error', stale: false, cycle: 1, derived: null, checklist: [], questions: [], patches: [{ ...patch, status: 'pending', decision: null }], discarded: [], moves: [], error: 'sm refine failed', runId: null },
});

describe('RefinementPage of a new project', () => {
  const stageState = (over: Record<string, unknown> = {}): Snapshot => {
    const s = snapshot(1);
    return { ...s, state: { ...s.state, status: 'answering', error: null, patches: [], mode: 'new-project', stages: true, ...over } as never };
  };
  const renderPage = () => render(<MemoryRouter initialEntries={['/refine/hello-app/hello-001']}><Routes><Route path="/refine/:projectId/:specId" element={<RefinementPage />} /></Routes></MemoryRouter>);
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('sends the confidentiality answer, and the owner step to the next stage, to the API', async () => {
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue(stageState());
    const conf = vi.spyOn(refineApi, 'confidential').mockResolvedValue({ ok: true });
    const cont = vi.spyOn(refineApi, 'continueStage').mockResolvedValue({ ok: true });
    renderPage();
    fireEvent.click(await screen.findByTestId('confidential-yes'));
    await waitFor(() => expect(conf).toHaveBeenCalledWith('hello-app', 'hello-001', true));
    fireEvent.click(await screen.findByTestId('wizard-continue'));
    await waitFor(() => expect(cont).toHaveBeenCalledWith('hello-app', 'hello-001', 'flow.md'));
  });

  it('sends the review of the stage document to the API', async () => {
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue(stageState());
    const review = vi.spyOn(refineApi, 'evaluateStage').mockResolvedValue({ ok: true });
    renderPage();
    fireEvent.click(await screen.findByTestId('wizard-process'));
    await waitFor(() => expect(review).toHaveBeenCalledWith('hello-app', 'hello-001', 'flow.md'));
  });

  it('sends the reprocess of the stage document to the API', async () => {
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue(stageState({ passedStages: ['flow.md'] }));
    const again = vi.spyOn(refineApi, 'reprocessStage').mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    fireEvent.click(await screen.findByTestId('wizard-process'));
    await waitFor(() => expect(again).toHaveBeenCalledWith('hello-app', 'hello-001', 'flow.md'));
  });

  it('asks the Jev for the score of the document on screen', async () => {
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue(stageState({ confidential: false }));
    const score = vi.spyOn(refineApi, 'scoreDoc').mockResolvedValue({ ok: true });
    renderPage();
    fireEvent.click(await screen.findByTestId('score-doc'));
    await waitFor(() => expect(score).toHaveBeenCalledWith('hello-app', 'hello-001', 'flow.md'));
  });

  it('asks the Jev for the scores of all five documents from the final review', async () => {
    window.history.replaceState(null, '', '/?etapa=revisao');
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue(stageState({ confidential: false }));
    const score = vi.spyOn(refineApi, 'score').mockResolvedValue(undefined as never);
    renderPage();
    fireEvent.click(await screen.findByTestId('score-all'));
    await waitFor(() => expect(score).toHaveBeenCalledWith('hello-app', 'hello-001'));
  });

  it('keeps the start in the review panel of the backlog screen, where no score banner stands', async () => {
    window.history.replaceState(null, '', '/?vista=backlog');
    journal.events = [];
    const backlog = { enabled: true, detail: true, items: [], epics: [], specs: {}, preplans: {}, flowHeadings: [] };
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue(stageState({ status: 'ready', backlog, readiness: { cycle: 1, available: true, model: 'jev-1.13.0', average: 0.9, docs: null, usage: null, outdated: false } }));
    renderPage();
    await screen.findByTestId('start');
    expect(screen.queryByTestId('readiness-start')).toBeNull();
  });
});

describe('RefinementPage errors', () => {
  it('tells the owner to sign in to Claude again when the Claude session expired', async () => {
    journal.events = [];
    const s = snapshot(1);
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue({ ...s, state: { ...s.state, status: 'error', error: 'stage review failed: auth: Failed to authenticate: OAuth session expired and could not be refreshed' } as never });
    render(<MemoryRouter initialEntries={['/refine/hello-app/hello-001']}><Routes><Route path="/refine/:projectId/:specId" element={<RefinementPage />} /></Routes></MemoryRouter>);
    expect((await screen.findByRole('alert')).textContent).toBe('A sessão do Claude expirou. Entre de novo no Claude em Configurações e processe de novo.');
  });
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

  it('counts the running evaluation from the start the journal recorded', async () => {
    journal.events = [];
    const running = snapshot(1);
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue({ ...running, state: { ...running.state, mode: 'new-project', status: 'evaluating', error: null, patches: [], evaluation: { startedAt: new Date().toISOString(), endedAt: null } } as never });
    render(<MemoryRouter initialEntries={['/refine/hello-app/hello-001']}><Routes><Route path="/refine/:projectId/:specId" element={<RefinementPage />} /></Routes></MemoryRouter>);
    expect(await screen.findByTestId('evaluation-timer')).toBeTruthy();
    expect(screen.getByText(/Avaliando os documentos/)).toBeTruthy();
  });

  it('counts a single spec evaluation too, with no stage title', async () => {
    journal.events = [];
    const running = snapshot(1);
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue({ ...running, state: { ...running.state, mode: 'new-spec', status: 'evaluating', error: null, patches: [], evaluation: { startedAt: new Date().toISOString(), endedAt: null } } as never });
    render(<MemoryRouter initialEntries={['/refine/hello-app/hello-001']}><Routes><Route path="/refine/:projectId/:specId" element={<RefinementPage />} /></Routes></MemoryRouter>);
    expect(await screen.findByTestId('evaluation-timer')).toBeTruthy();
    expect(screen.queryByText(/Avaliando os documentos/)).toBeNull();
  });
});
