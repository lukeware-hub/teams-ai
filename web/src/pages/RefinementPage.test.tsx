import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { refineApi, type Snapshot, type StoredEvent } from '../api.js';
import { RefinementPage } from './Refinement.js';

const journal = vi.hoisted(() => ({ events: [] as unknown[], reopened: 0, listeners: new Set<() => void>() }));
// The stream hook re-renders the page when an event arrives, as the real one does.
vi.mock('../useSse.js', async () => {
  const React = await import('react');
  return {
    useJournal: (url: string | null) => {
      const [, force] = React.useReducer((n: number) => n + 1, 0);
      React.useEffect(() => {
        journal.listeners.add(force);
        return () => void journal.listeners.delete(force);
      }, []);
      return { events: url ? journal.events : [], ended: false, error: null, reopened: journal.reopened };
    },
  };
});
const arrive = (...events: unknown[]) => act(async () => {
  journal.events = [...journal.events, ...events];
  journal.listeners.forEach((l) => l());
});

const event = (seq: number, type: string, data: Record<string, unknown>): StoredEvent => ({ seq, at: '', runId: 'hello-app/hello-001', specHash: 'draft', type, kind: 'fact', data });
const patch = { patchId: 'sm-c1-0', role: 'sm' as const, file: 'briefing.md' as const, find: 'a', replace: 'b', reason: 'clearer', diff: '--- briefing.md\n-a\n+b\n', cycle: 1 };
const snapshot = (seq: number): Snapshot => ({
  projectId: 'hello-app',
  specId: 'hello-001',
  seq,
  docs: { 'project.md': '# Hello', 'briefing.md': 'a', 'stack.md': '# Stack', 'flow.md': '# Flow', 'design.md': '# Design' },
  secrets: [],
  tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 },
  state: { status: 'error', stale: false, cycle: 1, derived: null, checklist: [], questions: [], patches: [{ ...patch, status: 'pending', decision: null }], discarded: [], moves: [], reshapes: [], error: 'sm refine failed', runId: null },
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
    await waitFor(() => expect(cont).toHaveBeenCalledWith('hello-app', 'hello-001', 'flow.md', false));
  });

  it('saves a document with the hash of the text it was typed over, then with the hash the save returned', async () => {
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue({ ...stageState(), hashes: { 'flow.md': 'hash-of-flow' } });
    const save = vi.spyOn(refineApi, 'saveDoc').mockResolvedValue({ ok: true, hash: 'hash-after-save' });
    renderPage();
    const editor = await screen.findByTestId('doc-flow.md');
    fireEvent.change(editor, { target: { value: '# Flow\n\nEdited by the owner.\n' } });
    fireEvent.blur(editor);
    await waitFor(() => expect(save).toHaveBeenCalledWith('hello-app', 'hello-001', 'flow.md', '# Flow\n\nEdited by the owner.\n', 'hash-of-flow'));
    fireEvent.change(editor, { target: { value: '# Flow\n\nEdited again.\n' } });
    fireEvent.blur(editor);
    await waitFor(() => expect(save).toHaveBeenLastCalledWith('hello-app', 'hello-001', 'flow.md', '# Flow\n\nEdited again.\n', 'hash-after-save'));
  });

  it('sends the review of the stage document to the API', async () => {
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue(stageState());
    const review = vi.spyOn(refineApi, 'evaluateStage').mockResolvedValue({ ok: true });
    renderPage();
    fireEvent.click(await screen.findByTestId('wizard-process'));
    await waitFor(() => expect(review).toHaveBeenCalledWith('hello-app', 'hello-001', 'flow.md'));
  });

  it('shows a refused Continuar at the top of the page and scrolls to it', async () => {
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue(stageState());
    vi.spyOn(refineApi, 'continueStage').mockRejectedValue(new Error('Revise a etapa flow.md antes de continuar.'));
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as never;
    renderPage();
    fireEvent.click(await screen.findByTestId('wizard-continue'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Revise a etapa flow.md'));
    expect(scrollTo).toHaveBeenCalled();
  });

  it('shows the processing banner while an evaluation is open, even before a cycle started, and not once it ended', async () => {
    const open = { startedAt: new Date(Date.now() - 5_000).toISOString(), endedAt: null };
    const spy = vi.spyOn(refineApi, 'snapshot').mockResolvedValue(stageState({ evaluation: open }));
    const first = renderPage();
    expect(await screen.findByTestId('processing-banner')).toBeTruthy();
    first.unmount();
    spy.mockResolvedValue(stageState({ evaluation: { ...open, endedAt: new Date().toISOString() } }));
    renderPage();
    await screen.findByTestId('wizard-continue');
    expect(screen.queryByTestId('processing-banner')).toBeNull();
  });

  it('shows the graph extraction on its own while the owner keeps working', async () => {
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue(stageState({ graphing: 'flow.md' }));
    renderPage();
    expect((await screen.findByTestId('graphing-box')).textContent).toContain('flow.md');
    expect((screen.getByTestId('doc-flow.md') as HTMLTextAreaElement).readOnly).toBe(false);
  });

  it('reads the snapshot again every few seconds while work is open, as a safety net for the stream', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const spy = vi.spyOn(refineApi, 'snapshot').mockResolvedValue(stageState({ evaluation: { startedAt: new Date().toISOString(), endedAt: null } }));
      renderPage();
      await screen.findByTestId('processing-banner');
      const before = spy.mock.calls.length;
      // The timer is armed by an effect that may run a moment after the banner: advance a few times, at most, until it fires.
      for (let tries = 0; tries < 4 && spy.mock.calls.length <= before; tries++) await act(async () => { vi.advanceTimersByTime(5_100); });
      expect(spy.mock.calls.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('also reads the snapshot every fifteen seconds when nothing runs, so a page never waits for a reload to learn what changed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const spy = vi.spyOn(refineApi, 'snapshot').mockResolvedValue(stageState());
      renderPage();
      await screen.findByTestId('wizard-continue');
      const before = spy.mock.calls.length;
      await act(async () => { vi.advanceTimersByTime(5_100); });
      expect(spy.mock.calls.length).toBe(before);
      await act(async () => { vi.advanceTimersByTime(10_100); });
      expect(spy.mock.calls.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the reprocess of the stage document to the API', async () => {
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue(stageState({ passedStages: ['flow.md'] }));
    const again = vi.spyOn(refineApi, 'reprocessStage').mockResolvedValue({ ok: true });
    renderPage();
    fireEvent.click(await screen.findByTestId('wizard-process'));
    fireEvent.click(await screen.findByTestId('stage-confirm'));
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

describe('RefinementPage busy evaluation', () => {
  const page = () => <MemoryRouter initialEntries={['/refine/hello-app/hello-001']}><Routes><Route path="/refine/:projectId/:specId" element={<RefinementPage />} /></Routes></MemoryRouter>;
  it('shows a refused action during the evaluation as green progress, not as an alert', async () => {
    journal.events = [];
    journal.reopened = 0;
    const s = snapshot(1);
    // The undo stays enabled during an evaluation, so its refusal reaches the page with the evaluating status already on screen.
    const move = { moveId: 'move-1', status: 'applied', from: 'flow.md', to: 'briefing.md', reason: 'mesmo assunto', closed: false };
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue({ ...s, state: { ...s.state, status: 'evaluating', error: null, patches: [], moves: [move], evaluation: { startedAt: '2026-11-03T10:00:00Z', endedAt: null } } as never });
    vi.spyOn(refineApi, 'undoMove').mockRejectedValue(new Error('Já tem uma avaliação em andamento. Aguarde ela terminar e tente de novo.'));
    render(page());
    fireEvent.click(await screen.findByTestId('undo-move'));
    await waitFor(() => expect(screen.getByTestId('busy-notice').textContent).toContain('Processando'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('RefinementPage live', () => {
  const renderLive = () => render(<MemoryRouter initialEntries={['/refine/hello-app/hello-001']}><Routes><Route path="/refine/:projectId/:specId" element={<RefinementPage />} /></Routes></MemoryRouter>);

  it('shows the work of an evaluation that starts after the page opened, and hides it when it ends, with no reload', async () => {
    journal.events = [];
    const s = snapshot(5);
    // A snapshot read later holds every event up to its seq, as the server's does.
    vi.spyOn(refineApi, 'snapshot').mockImplementation(async () => ({ ...s, seq: (journal.events.at(-1) as { seq: number } | undefined)?.seq ?? 5, state: { ...s.state, status: 'answering', error: null, patches: [], mode: 'new-project', stages: true } as never }));
    renderLive();
    await screen.findByTestId('wizard-continue');
    expect(screen.queryByTestId('processing-banner')).toBeNull();
    await arrive(event(6, 'REFINE_EVALUATION_STARTED', {}), event(7, 'REFINE_CYCLE_STARTED', { cycle: 2, draftHash: 'h' }));
    expect(await screen.findByTestId('processing-banner')).toBeTruthy();
    await arrive(event(8, 'REFINE_EVALUATED', { cycle: 2, checklist: [], questions: [], discardedPatches: [] }), event(9, 'REFINE_EVALUATION_ENDED', {}));
    await waitFor(() => expect(screen.queryByTestId('processing-banner')).toBeNull());
  });

  it('shows a question the team asked after the page opened, with no reload', async () => {
    journal.events = [];
    const s = snapshot(5);
    const backlog = { enabled: true, detail: true, epics: [], items: [], specs: {}, preplans: {}, flowHeadings: [] };
    window.history.replaceState(null, '', '/?etapa=backlog');
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue({ ...s, state: { ...s.state, status: 'ready', error: null, patches: [], mode: 'new-project', stages: true, backlog, specsMd: { hash: 'h', bytes: 1 } } as never });
    renderLive();
    await screen.findByTestId('specs-check');
    const question = { questionId: 'specs-1-0', role: 'po', text: 'Qual seção justifica o item base?', blocking: true, relatedAcIds: [], cycle: 1, origin: 'specs', options: [{ label: 'Objetivos', detail: 'Usa os objetivos.', recommended: true }] };
    await arrive(event(6, 'REFINE_SPECS_QUESTIONS_ASKED', { specsHash: 'h', questions: [question] }));
    expect(await screen.findByText('Qual seção justifica o item base?')).toBeTruthy();
    window.history.replaceState(null, '', '/');
  });
  it('offers Reprocessar on the specs once the owner has answered their question, and sends it', async () => {
    journal.events = [];
    const s = snapshot(5);
    const backlog = { enabled: true, detail: true, epics: [], items: [], specs: {}, preplans: {}, flowHeadings: [] };
    const answered = { questionId: 'specs-1-0', role: 'po', text: 'Qual seção justifica o item base?', blocking: true, relatedAcIds: [], cycle: 1, origin: 'specs', status: 'answered', answer: 'Objetivos' };
    window.history.replaceState(null, '', '/?etapa=backlog');
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue({ ...s, specsApproved: false, state: { ...s.state, status: 'ready', error: null, patches: [], mode: 'new-project', stages: true, backlog, specsMd: { hash: 'h', bytes: 1 }, questions: [answered] } as never });
    const reprocess = vi.spyOn(refineApi, 'reprocessSpecs').mockResolvedValue({ ok: true });
    renderLive();
    fireEvent.click(await screen.findByTestId('specs-reprocess-button'));
    await waitFor(() => expect(reprocess).toHaveBeenCalledWith('hello-app', 'hello-001'));
    window.history.replaceState(null, '', '/');
  });
});

describe('RefinementPage while the server holds a process', () => {
  const stageWithPatch = (over: Record<string, unknown> = {}): Snapshot => {
    const s = snapshot(5);
    return { ...s, state: { ...s.state, status: 'answering', error: null, mode: 'new-project', stages: true, patches: [{ ...patch, file: 'flow.md', status: 'pending', decision: null }], ...over } as never };
  };
  const renderIt = () => render(<MemoryRouter initialEntries={['/refine/hello-app/hello-001']}><Routes><Route path="/refine/:projectId/:specId" element={<RefinementPage />} /></Routes></MemoryRouter>);

  it('shows the process in green at the top, blocks the accept button, and explains on a click without sending it', async () => {
    journal.events = [];
    const accept = vi.spyOn(refineApi, 'accept').mockResolvedValue({ ok: true });
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue({ ...stageWithPatch(), busy: true });
    renderIt();
    expect(await screen.findByTestId('busy-process')).toBeTruthy();
    const button = await screen.findByTestId('accept-sm-c1-0');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(await screen.findByTestId('busy-dialog-ok')).toBeTruthy();
    expect(accept).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('busy-dialog-ok'));
    await waitFor(() => expect(screen.queryByTestId('busy-dialog-ok')).toBeNull());
  });

  it('shows no banner and sends the accept when no process is open', async () => {
    journal.events = [];
    const accept = vi.spyOn(refineApi, 'accept').mockResolvedValue({ ok: true });
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue(stageWithPatch());
    renderIt();
    const button = await screen.findByTestId('accept-sm-c1-0');
    expect(screen.queryByTestId('busy-process')).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(accept).toHaveBeenCalledTimes(1));
  });

  it('turns a refusal from the server into the notice, with no jump to the top of the page', async () => {
    journal.events = [];
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as never;
    vi.spyOn(refineApi, 'accept').mockRejectedValue(new Error('Já tem uma avaliação em andamento. Aguarde ela terminar e tente de novo.'));
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue(stageWithPatch());
    renderIt();
    fireEvent.click(await screen.findByTestId('accept-sm-c1-0'));
    expect(await screen.findByTestId('busy-dialog-ok')).toBeTruthy();
    expect(scrollTo).not.toHaveBeenCalled();
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

  it('moves to the project when the execution starts', async () => {
    const backlog = { enabled: true, detail: true, epics: [], items: [], specs: {}, preplans: {}, flowHeadings: [] };
    const ready = snapshot(1);
    journal.events = [event(2, 'REFINE_STARTED_RUN', { runId: 'hello-app--base--run-1' })];
    vi.spyOn(refineApi, 'snapshot').mockResolvedValue({ ...ready, state: { ...ready.state, status: 'ready', error: null, patches: [], backlog } as never });
    render(
      <MemoryRouter initialEntries={['/refine/hello-app/hello-001']}>
        <Routes>
          <Route path="/refine/:projectId/:specId" element={<RefinementPage />} />
          <Route path="/projects/:projectId" element={<p>área do projeto</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('área do projeto')).toBeTruthy();
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

describe('RefinementPage keeps the documents and the status live', () => {
  const renderLive = () => (
    <MemoryRouter initialEntries={['/refine/hello-app/hello-001']}><Routes><Route path="/refine/:projectId/:specId" element={<RefinementPage />} /></Routes></MemoryRouter>
  );
  const edited = (seq: number, source: string) => event(seq, 'DOC_EDITED', { file: 'design.md', hash: `h${seq}`, source });
  const answering = (): Snapshot => {
    const s = snapshot(1);
    return { ...s, state: { ...s.state, status: 'answering', error: null, patches: [] } as never };
  };
  afterEach(() => {
    journal.events = [];
    journal.reopened = 0;
  });

  it('reads the snapshot once for a burst of document edits, and once more when edits arrive during that read', async () => {
    const read = vi.spyOn(refineApi, 'snapshot').mockResolvedValueOnce(answering());
    const pending: Array<(s: Snapshot) => void> = [];
    read.mockImplementation(() => new Promise<Snapshot>((resolve) => pending.push(resolve)));
    const { rerender } = render(renderLive());
    await screen.findByText(/hello-001 rascunho/);
    journal.events = [edited(2, 'reshape'), edited(3, 'move')];
    rerender(renderLive());
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    journal.events = [...journal.events, edited(4, 'undo')];
    rerender(renderLive());
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => pending[0]!(snapshot(4)));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  });

  it('shows a patch that arrives with a document edit even when reading the document fails', async () => {
    vi.spyOn(refineApi, 'snapshot').mockResolvedValueOnce(answering()).mockRejectedValueOnce(new Error('offline'));
    const { rerender } = render(renderLive());
    await screen.findByText(/hello-001 rascunho/);
    journal.events = [event(2, 'PATCH_PROPOSED', { ...patch, patchId: 'sm-c2-0' }), edited(3, 'reshape')];
    rerender(renderLive());
    expect(await screen.findByTestId('accept-sm-c2-0')).toBeTruthy();
  });

  it('reads the snapshot again when the event stream was reopened', async () => {
    const read = vi.spyOn(refineApi, 'snapshot').mockResolvedValue(answering());
    const { rerender } = render(renderLive());
    await screen.findByText(/hello-001 rascunho/);
    journal.reopened = 1;
    rerender(renderLive());
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });
});
