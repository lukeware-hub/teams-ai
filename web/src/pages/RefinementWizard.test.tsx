import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../api.js';
import { RefinementView } from './Refinement.js';

const base = (over: Record<string, unknown> = {}): Snapshot => ({
  projectId: 'hello-app',
  specId: 'hello-001',
  docs: { 'project.md': '# Hello', 'briefing.md': '## Objectives', 'stack.md': '# Stack', 'flow.md': '# Flow', 'design.md': '# Design' },
  secrets: [],
  tokens: { inputTokens: 10, outputTokens: 5, costUsd: 0.02, steps: 3 },
  state: { status: 'answering', stale: false, cycle: 1, derived: null, checklist: [], questions: [], patches: [], discarded: [], moves: [], error: null, runId: null, mode: 'new-project', stages: true, ...over } as Snapshot['state'],
});
const checks = (value: number) => ({ complete: value, concrete: value, consistent: value, scoped: value });
const scored = (docs: Record<string, number>) => ({ cycle: 1, available: true, model: 'jev', average: 0.5, usage: null, outdated: false, docs: Object.fromEntries(Object.entries(docs).map(([file, score]) => [file, { score, checks: { complete: 0.44, concrete: 0.72, consistent: 0.84, scoped: 0.6 } }])) });
const question = (questionId: string, over: Record<string, unknown> = {}) => ({ questionId, role: 'po', text: `Pergunta ${questionId}?`, blocking: false, relatedAcIds: [], cycle: 1, status: 'pending', answer: null, ...over });
const patch = (patchId: string, file: string) => ({ patchId, role: 'po', file, find: 'a', replace: 'b', reason: 'mais claro', diff: '--- x\n-a\n+b\n', cycle: 1, status: 'pending', decision: null });
const on = () => ({ onSaveDoc: vi.fn(), onEvaluate: vi.fn(), onAnswer: vi.fn(), onSkip: vi.fn(), onAccept: vi.fn(), onReject: vi.fn(), onSecret: vi.fn(), onStart: vi.fn(), onContinueStage: vi.fn(() => true), onEvaluateStage: vi.fn(), onReprocessStage: vi.fn(), onScoreDoc: vi.fn(), onScoreAll: vi.fn(), onConfidential: vi.fn(), onEnableBacklog: vi.fn() });
const show = (snap: Snapshot, handlers = on(), busy = false) => {
  render(<MemoryRouter><RefinementView snap={snap} busy={busy} {...handlers} /></MemoryRouter>);
  return handlers;
};
const open = (search: string) => window.history.replaceState(null, '', `/${search}`);
const editor = (file: string) => screen.getByTestId(`doc-${file}`) as HTMLTextAreaElement;

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('one stage per screen', () => {
  it('opens the first document not done, with the editor of that document only and no score on any step', () => {
    show(base({ doneStages: ['flow.md'], readiness: scored({ 'project.md': 0.65 }) }));
    expect(screen.getByTestId('step-project.md').closest('li')!.getAttribute('aria-current')).toBe('step');
    expect(editor('project.md').value).toBe('# Hello');
    expect(screen.queryByTestId('doc-flow.md')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Etapas dos documentos' })).queryByText(/%/)).toBeNull();
  });

  it('opens the step named in the address', () => {
    open('?etapa=stack.md');
    show(base());
    expect(editor('stack.md').value).toBe('# Stack');
  });

  it('opens the first document of a project that records no stages', () => {
    show(base({ stages: undefined }));
    expect(editor('flow.md').value).toBe('# Flow');
  });

  it('opens any step from the stepper, without a lock', () => {
    show(base());
    fireEvent.click(screen.getByTestId('step-design.md'));
    expect(editor('design.md').value).toBe('# Design');
    expect(window.location.search).toBe('?etapa=design.md');
  });

  it('shows the usage of the whole refinement as one line in the footer', () => {
    show(base());
    expect(screen.getByTestId('wizard-meta').textContent).toBe('3 chamadas · 15 tokens · US$ 0.02');
  });

  it('keeps the text the owner typed when moving to another screen', () => {
    const handlers = show(base({ doneStages: ['flow.md'] }));
    fireEvent.change(editor('project.md'), { target: { value: '# Editado' } });
    fireEvent.click(screen.getByTestId('step-stack.md'));
    expect(handlers.onSaveDoc).toHaveBeenCalledWith('project.md', '# Editado');
  });
});

describe('Voltar and Continuar', () => {
  it('disables Voltar on the first stage, with the reason, and goes back from the others', () => {
    show(base({ doneStages: ['flow.md'] }));
    fireEvent.click(screen.getByTestId('wizard-back'));
    expect(editor('flow.md').value).toBe('# Flow');
    const back = screen.getByTestId('wizard-back') as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    expect(back.title).toBe('Esta é a primeira etapa');
  });

  it('marks the stage done on the server with Continuar, and shows the next screen', async () => {
    const handlers = show(base({ doneStages: ['flow.md'] }));
    fireEvent.click(screen.getByTestId('wizard-continue'));
    await waitFor(() => expect(editor('briefing.md').value).toBe('## Objectives'));
    expect(handlers.onContinueStage).toHaveBeenCalledWith('project.md');
  });

  it('only moves the view with Continuar on a stage that is already done', async () => {
    const handlers = show(base({ doneStages: ['flow.md', 'project.md'] }));
    fireEvent.click(screen.getByTestId('step-project.md'));
    fireEvent.click(screen.getByTestId('wizard-continue'));
    await waitFor(() => expect(editor('briefing.md').value).toBe('## Objectives'));
    expect(handlers.onContinueStage).not.toHaveBeenCalled();
  });

  it('stays on the screen when the server refuses to continue', async () => {
    const handlers = on();
    handlers.onContinueStage.mockReturnValue(false);
    show(base({ doneStages: ['flow.md'] }), handlers);
    fireEvent.click(screen.getByTestId('wizard-continue'));
    await waitFor(() => expect(handlers.onContinueStage).toHaveBeenCalled());
    expect(editor('project.md').value).toBe('# Hello');
  });

  it('moves the view without calling the server in a project that records no stages', async () => {
    const handlers = show(base({ stages: undefined }));
    fireEvent.click(screen.getByTestId('wizard-continue'));
    await waitFor(() => expect(editor('project.md').value).toBe('# Hello'));
    expect(handlers.onContinueStage).not.toHaveBeenCalled();
  });

  it('goes from the last document to the final review', async () => {
    open('?etapa=design.md');
    show(base({ doneStages: ['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md'] }));
    fireEvent.click(screen.getByTestId('wizard-continue'));
    await waitFor(() => expect(screen.getByTestId('final-scores')).toBeTruthy());
  });
});

describe('processing a stage', () => {
  it('processes the document on screen with the agents of its stage', () => {
    const handlers = show(base({ doneStages: ['flow.md'] }));
    fireEvent.click(screen.getByTestId('wizard-process'));
    expect(handlers.onEvaluateStage).toHaveBeenCalledWith('project.md');
  });

  it('runs the full round in a project that records no stages', () => {
    const handlers = show(base({ stages: undefined }));
    fireEvent.click(screen.getByTestId('wizard-process'));
    expect(handlers.onEvaluate).toHaveBeenCalledTimes(1);
  });

  it('has one button that processes the first time and reprocesses once the passed text is kept', () => {
    const first = show(base({ doneStages: ['flow.md'] }));
    expect(screen.getByTestId('wizard-process').textContent).toContain('Processar com agentes');
    expect(screen.queryByText('Reprocessar')).toBeNull();
    fireEvent.click(screen.getByTestId('wizard-process'));
    expect(first.onEvaluateStage).toHaveBeenCalledWith('project.md');
    cleanup();
    const confirm = vi.spyOn(window, 'confirm');
    const again = show(base({ doneStages: ['flow.md'], passedStages: ['project.md'] }));
    expect(screen.getByTestId('wizard-process').textContent).toContain('Reprocessar');
    fireEvent.click(screen.getByTestId('wizard-process'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(again.onReprocessStage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('wizard-process'));
    fireEvent.click(screen.getByTestId('delete-confirm'));
    expect(again.onReprocessStage).toHaveBeenCalledWith('project.md');
    expect(again.onEvaluateStage).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('waits while a run is on, and says why when the rounds of the stage are used up', () => {
    show(base({ doneStages: ['flow.md'] }), on(), true);
    expect((screen.getByTestId('wizard-process') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    show({ ...base({ doneStages: ['flow.md'], cycle: 2 }), limits: { max: 2 } });
    const process = screen.getByTestId('wizard-process') as HTMLButtonElement;
    expect(process.disabled).toBe(true);
    expect(process.title).toContain('Limite de 2 rodadas');
  });
});

describe('the review of the stage shows only its own document', () => {
  const pending = base({
    doneStages: ['flow.md'],
    questions: [question('po-s1-0', { file: 'project.md', blocking: true }), question('po-s1-1', { file: 'flow.md' }), question('po-c1-0')],
    patches: [patch('p-project', 'project.md'), patch('p-briefing', 'briefing.md')],
  });

  it('shows the questions and the suggestions of the document, and none of the others', () => {
    show(pending);
    expect(screen.getByTestId('answer-po-s1-0')).toBeTruthy();
    expect(screen.queryByTestId('answer-po-s1-1')).toBeNull();
    expect(screen.queryByTestId('answer-po-c1-0')).toBeNull();
    expect(screen.getByTestId('accept-p-project')).toBeTruthy();
    expect(screen.queryByTestId('accept-p-briefing')).toBeNull();
  });

  it('says there is nothing pending when the document has nothing', () => {
    show(base({ doneStages: ['flow.md'] }));
    expect(screen.getByText('Nenhuma pendência neste documento.')).toBeTruthy();
  });

  it('says whether the document agrees with the documents before it, from its own stage review', () => {
    show(base({ doneStages: ['flow.md'], stageAlignment: { 'project.md': ['o prazo diverge do fluxo'] } }));
    expect(screen.getByTestId('aligned').textContent).toBe('Não alinhado com os documentos anteriores: o prazo diverge do fluxo');
    cleanup();
    show(base({ doneStages: ['flow.md'], stageAlignment: { 'project.md': [] } }));
    expect(screen.getByTestId('aligned').textContent).toBe('Alinhado com os documentos anteriores.');
    cleanup();
    show(base({ doneStages: ['flow.md'] }));
    expect(screen.getByTestId('aligned').textContent).toBe('Ainda não revisado pelos agentes.');
  });

  it('says the first stage has no document before it', () => {
    show(base());
    expect(screen.getByTestId('aligned').textContent).toBe('Primeira etapa: não há documento anterior.');
  });

  it('tells which earlier document changed after the stage was reviewed', () => {
    show(base({ doneStages: ['flow.md', 'project.md'], staleBy: { 'project.md': 'flow.md' } }));
    fireEvent.click(screen.getByTestId('step-project.md'));
    expect(screen.getByTestId('doc-stale').textContent).toContain('flow.md');
  });
});

describe('the Jev score of the document', () => {
  it('shows the percent and the four checks, with no minimum and no verdict', () => {
    show(base({ doneStages: ['flow.md'], confidential: false, readiness: scored({ 'project.md': 0.65 }) }));
    const inset = screen.getByTestId('doc-score');
    expect(inset.textContent).toContain('Nota do Jev · project.md');
    expect(screen.getByTestId('doc-score-percent').textContent).toBe('65%');
    expect(inset.textContent).toContain('completo 44% · concreto 72% · consistente 84% · escopo 60%');
    expect(document.body.textContent).not.toMatch(/Mínimo|Pronto para|Ainda não está pronto/);
  });

  it('asks the Jev for the score of this document when it has none', () => {
    const handlers = show(base({ doneStages: ['flow.md'], confidential: false }));
    fireEvent.click(screen.getByTestId('score-doc'));
    expect(handlers.onScoreDoc).toHaveBeenCalledWith('project.md');
  });

  it('waits for the answer on confidentiality, and says so', () => {
    show(base({ doneStages: ['flow.md'] }));
    expect((screen.getByTestId('score-doc') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Responda se o projeto é confidencial para usar o Jev.')).toBeTruthy();
  });

  it('offers no score in a confidential project', () => {
    show(base({ doneStages: ['flow.md'], confidential: true }));
    expect(screen.queryByTestId('score-doc')).toBeNull();
    expect(screen.getByText('Projeto confidencial: o Jev não lê os documentos.')).toBeTruthy();
  });

  it('keeps a current score as it is, and allows a new one once the document changed after it', () => {
    show(base({ doneStages: ['flow.md'], confidential: false, readiness: scored({ 'project.md': 0.65 }) }));
    expect((screen.getByTestId('score-doc') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    show(base({ doneStages: ['flow.md'], confidential: false, outdatedDocs: ['project.md'], readiness: scored({ 'project.md': 0.65 }) }));
    expect((screen.getByTestId('score-doc') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('Nota anterior à última edição.')).toBeTruthy();
  });
});

describe('the confidentiality question', () => {
  it('is asked on the stage screen until it is answered', () => {
    const handlers = show(base());
    fireEvent.click(screen.getByTestId('confidential-no'));
    expect(handlers.onConfidential).toHaveBeenCalledWith(false);
    cleanup();
    show(base({ confidential: false }));
    expect(screen.queryByTestId('confidential-ask')).toBeNull();
  });
});

describe('the actions of the editor', () => {
  it('attaches a text file to the document on screen, and saves it', async () => {
    const handlers = show(base({ doneStages: ['flow.md'] }));
    fireEvent.change(screen.getByTestId('attach-doc'), { target: { files: [new File(['# Projeto novo'], 'projeto.md', { type: 'text/markdown' })] } });
    fireEvent.click(await screen.findByTestId('delete-confirm'));
    await waitFor(() => expect(editor('project.md').value).toBe('# Projeto novo'));
    expect(handlers.onSaveDoc).toHaveBeenCalledWith('project.md', '# Projeto novo');
  });

  it('keeps the document when the owner does not confirm that a file replaces its text', async () => {
    const handlers = show(base({ doneStages: ['flow.md'] }));
    fireEvent.change(screen.getByTestId('attach-doc'), { target: { files: [new File(['# Novo'], 'novo.md', { type: 'text/markdown' })] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));
    expect(handlers.onSaveDoc).not.toHaveBeenCalled();
    expect(editor('project.md').value).toBe('# Hello');
  });

  it('ignores a change without a file, and keeps the document when the file cannot be read', async () => {
    const handlers = show(base({ doneStages: ['flow.md'] }));
    fireEvent.change(screen.getByTestId('attach-doc'), { target: { files: [] } });
    const read = vi.spyOn(FileReader.prototype, 'readAsText').mockImplementation(function (this: FileReader) {
      this.onerror?.(new ProgressEvent('error') as ProgressEvent<FileReader>);
    });
    fireEvent.change(screen.getByTestId('attach-doc'), { target: { files: [new File(['x'], 'x.md')] } });
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(handlers.onSaveDoc).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it('marks the design as not applicable after the owner confirms, and leaves it when they do not', () => {
    open('?etapa=design.md');
    const handlers = show(base());
    fireEvent.click(screen.getByRole('button', { name: 'Não se aplica' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(handlers.onSaveDoc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Não se aplica' }));
    fireEvent.click(screen.getByTestId('delete-confirm'));
    expect(handlers.onSaveDoc).toHaveBeenCalledWith('design.md', expect.stringContaining('Não se aplica'));
  });

  it('marks an empty design as not applicable without asking', () => {
    open('?etapa=design.md');
    const snap = base();
    const handlers = show({ ...snap, docs: { ...snap.docs, 'design.md': '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Não se aplica' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(handlers.onSaveDoc).toHaveBeenCalledWith('design.md', expect.stringContaining('Não se aplica'));
  });

  it('offers Sugerir from the second document on, not on flow.md', () => {
    const suggest = vi.fn(async () => null);
    render(<MemoryRouter><RefinementView snap={base()} busy={false} {...on()} onSuggestDoc={suggest} /></MemoryRouter>);
    expect(screen.queryByTestId('suggest')).toBeNull();
    fireEvent.click(screen.getByTestId('step-project.md'));
    fireEvent.click(screen.getByTestId('suggest'));
    expect(suggest).toHaveBeenCalledWith('project.md');
  });
});

describe('the final review', () => {
  const reviewSnap = (over: Record<string, unknown> = {}) => base({
    doneStages: ['flow.md', 'project.md'],
    readiness: scored({ 'flow.md': 0.53, 'project.md': 0.65 }),
    questions: [question('po-s1-0', { file: 'project.md' }), question('po-c1-0')],
    patches: [patch('p-project', 'project.md')],
    ...over,
  });

  it('shows the five scores in one place, with what is missing', () => {
    open('?etapa=revisao');
    show(reviewSnap());
    const scores = screen.getByTestId('final-scores').textContent!;
    expect(scores).toContain('flow.md53%');
    expect(scores).toContain('project.md65%');
    expect(scores).toContain('briefing.mdsem nota');
  });

  it('lists the pending items by document, opens the stage from there, and shows the general questions in place', () => {
    open('?etapa=revisao');
    show(reviewSnap());
    expect(screen.getByTestId('final-pending').textContent).toContain('project.md: 2 pendências');
    expect(screen.getByTestId('answer-po-c1-0')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir etapa' }));
    expect(editor('project.md').value).toBe('# Hello');
  });

  it('shows the verification blocks, and no other screen does', () => {
    open('?etapa=revisao');
    show(reviewSnap());
    expect(screen.getByText('Lista de verificação')).toBeTruthy();
    expect(screen.getByText('Consumo de IA no refinamento')).toBeTruthy();
    cleanup();
    open('?etapa=project.md');
    show(reviewSnap());
    expect(screen.queryByText('Lista de verificação')).toBeNull();
    expect(screen.queryByText('Consumo de IA no refinamento')).toBeNull();
  });

  it('asks the Jev for the scores of all five documents when some have none', () => {
    open('?etapa=revisao');
    const handlers = show(reviewSnap({ confidential: false }));
    fireEvent.click(screen.getByTestId('score-all'));
    expect(handlers.onScoreAll).toHaveBeenCalledTimes(1);
  });

  it('evaluates everything with the agents, and asks first when nothing changed', async () => {
    open('?etapa=revisao');
    const handlers = show(reviewSnap({ cycle: 0 }));
    fireEvent.click(screen.getByTestId('evaluate'));
    expect(handlers.onEvaluate).toHaveBeenCalledTimes(1);
    cleanup();
    open('?etapa=revisao');
    const asked = show(reviewSnap());
    fireEvent.click(screen.getByTestId('evaluate'));
    expect(asked.onEvaluate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reavaliar mesmo assim' }));
    expect(asked.onEvaluate).toHaveBeenCalledTimes(1);
  });

  it('breaks the backlog from the last screen', () => {
    open('?etapa=revisao');
    const handlers = show(reviewSnap());
    fireEvent.click(screen.getByTestId('enable-backlog'));
    expect(handlers.onEnableBacklog).toHaveBeenCalledTimes(1);
  });

  it('opens the backlog screen when the backlog exists, and comes back to the documents from it', () => {
    open('?etapa=revisao');
    show(reviewSnap({ backlog: { enabled: true, detail: true, items: [], epics: [], specs: {}, preplans: {} } }));
    fireEvent.click(screen.getByTestId('open-backlog'));
    expect(screen.queryByTestId('stage-wizard')).toBeNull();
    expect(window.location.search).toContain('vista=backlog');
    fireEvent.click(screen.getByTestId('open-wizard'));
    expect(screen.getByTestId('stage-wizard')).toBeTruthy();
  });
});
