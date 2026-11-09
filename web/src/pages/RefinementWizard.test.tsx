import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot, StoredEvent } from '../api.js';
import { RefinementView, stageNow } from './Refinement.js';

const base = (over: Record<string, unknown> = {}): Snapshot => ({
  projectId: 'hello-app',
  specId: 'hello-001',
  docs: { 'project.md': '# Hello', 'briefing.md': '## Objectives', 'stack.md': '# Stack', 'flow.md': '# Flow', 'design.md': '# Design' },
  secrets: [],
  tokens: { inputTokens: 10, outputTokens: 5, costUsd: 0.02, steps: 3 },
  state: { status: 'answering', stale: false, cycle: 1, derived: null, checklist: [], questions: [], patches: [], discarded: [], moves: [], reshapes: [], error: null, runId: null, mode: 'new-project', stages: true, ...over } as Snapshot['state'],
});
const checks = (value: number) => ({ complete: value, concrete: value, consistent: value, scoped: value });
const scored = (docs: Record<string, number>) => ({ cycle: 1, available: true, model: 'jev', average: 0.5, usage: null, outdated: false, docs: Object.fromEntries(Object.entries(docs).map(([file, score]) => [file, { score, checks: { complete: 0.44, concrete: 0.72, consistent: 0.84, scoped: 0.6 } }])) });
const question = (questionId: string, over: Record<string, unknown> = {}) => ({ questionId, role: 'po', text: `Pergunta ${questionId}?`, blocking: false, relatedAcIds: [], cycle: 1, status: 'pending', answer: null, ...over });
const patch = (patchId: string, file: string) => ({ patchId, role: 'po', file, find: 'a', replace: 'b', reason: 'mais claro', diff: '--- x\n-a\n+b\n', cycle: 1, status: 'pending', decision: null });
const verdict = (specsHash: string, value: 'approved' | 'rejected', findings: string[] = []) => ({ specsHash, verdict: value, findings, reason: null, at: '2026-11-03T14:02:00.000Z' });
const on = () => ({ onSaveDoc: vi.fn(), onReadDoc: vi.fn(), onEvaluate: vi.fn(), onCheckSpecs: vi.fn(),onAnswer: vi.fn(), onSkip: vi.fn(), onAccept: vi.fn(), onReject: vi.fn(), onSecret: vi.fn(), onStart: vi.fn(), onContinueStage: vi.fn(() => true), onAddToGraph: vi.fn(() => true), onCloseReview: vi.fn(() => true), onEvaluateStage: vi.fn(), onReprocessStage: vi.fn(), onScoreDoc: vi.fn(), onScoreAll: vi.fn(), onConfidential: vi.fn(), onEnableBacklog: vi.fn(), onNotApplicable: vi.fn(() => true) });
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
    expect(editor('project.md').value).toBe('# Hello');
    expect(screen.queryByTestId('doc-flow.md')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Etapas dos documentos' })).queryByText(/%/)).toBeNull();
  });

  it('opens the step named in the address', () => {
    open('?etapa=stack.md');
    show(base({ doneStages: ['flow.md', 'project.md', 'briefing.md'] }));
    expect(editor('stack.md').value).toBe('# Stack');
  });

  it('opens the first open step when the address names a step after it', () => {
    open('?etapa=stack.md');
    show(base());
    expect(editor('flow.md').value).toBe('# Flow');
  });

  it('opens the step named in the address after the development started, read-only', () => {
    open('?etapa=stack.md');
    show(base({ status: 'started', doneStages: ['flow.md', 'project.md', 'briefing.md'] }));
    expect(editor('stack.md').value).toBe('# Stack');
    expect(editor('stack.md').readOnly).toBe(true);
  });

  it('opens the first open step after the development started when the address names a step after it', () => {
    open('?etapa=stack.md');
    show(base({ status: 'started', doneStages: ['flow.md'] }));
    expect(editor('project.md').value).toBe('# Hello');
  });

  it('opens the backlog after the development started when the address names no step', () => {
    show(base({ status: 'started' }));
    expect(screen.getByText('Preparar o desenvolvimento')).toBeTruthy();
  });

  it('opens the first document of a project that records no stages', () => {
    show(base({ stages: undefined }));
    expect(editor('flow.md').value).toBe('# Flow');
  });

  it('the stepper opens a step up to the first one not done, and no step after it', () => {
    show(base());
    fireEvent.click(screen.getByTestId('step-design.md'));
    expect(window.location.search).not.toContain('etapa=design.md');
  });

  it('shows the usage of the whole refinement as one line in the footer', () => {
    show(base());
    expect(screen.getByTestId('wizard-meta').textContent).toBe('3 chamadas · 15 tokens (0 do Graphify, pagos pelo plano) · US$ 0,0200 sem o Graphify');
  });

  it('counts the Graphify tokens inside the total, and leaves their cost out', () => {
    show({ ...base(), tokens: { inputTokens: 110, outputTokens: 55, costUsd: 0.02, steps: 3, graph: { inputTokens: 100, outputTokens: 50, extractions: 2 } } });
    expect(screen.getByTestId('wizard-meta').textContent).toBe('3 chamadas · 165 tokens (150 do Graphify, pagos pelo plano) · US$ 0,0200 sem o Graphify');
  });

  it('keeps the text the owner typed when moving to another screen', () => {
    const handlers = show(base({ doneStages: ['flow.md'] }));
    fireEvent.change(editor('project.md'), { target: { value: '# Editado' } });
    fireEvent.click(screen.getByTestId('wizard-back'));
    expect(handlers.onSaveDoc).toHaveBeenCalledWith('project.md', '# Editado', undefined);
  });
});

describe('Voltar and Continuar', () => {
  it('adds a done document to Graphify on Continuar when it is not in the graph yet', async () => {
    const handlers = show(base({ doneStages: ['flow.md', 'project.md'], graphed: ['flow.md'] }));
    fireEvent.click(screen.getByTestId('wizard-back'));
    fireEvent.click(screen.getByTestId('wizard-continue'));
    await waitFor(() => expect(handlers.onContinueStage).toHaveBeenCalledWith('project.md', false));
  });

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
    expect(handlers.onContinueStage).toHaveBeenCalledWith('project.md', false);
  });

  it('keeps the owner on a repository session stage while its document goes into Graphify in the background', async () => {
    const done = ['flow.md', 'project.md', 'briefing.md'];
    const handlers = show(base({ doneStages: done, graphed: done, repositories: true, reviewedStages: ['stack.md'] }));
    expect(editor('stack.md').value).toBe('# Stack');
    fireEvent.click(screen.getByTestId('wizard-continue'));
    await waitFor(() => expect(handlers.onContinueStage).toHaveBeenCalledWith('stack.md', false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(editor('stack.md').value).toBe('# Stack');
    expect(screen.queryByTestId('doc-design.md')).toBeNull();
  });

  it('only moves the view with Continuar on a stage that is already done', async () => {
    const handlers = show(base({ doneStages: ['flow.md', 'project.md'], graphed: ['flow.md', 'project.md'] }));
    fireEvent.click(screen.getByTestId('wizard-back'));
    fireEvent.click(screen.getByTestId('wizard-continue'));
    await waitFor(() => expect(editor('briefing.md').value).toBe('## Objectives'));
    expect(handlers.onContinueStage).not.toHaveBeenCalled();
  });

  it('a reprocessed stage says its mandatory question can be skipped, and Continuar moves on without the answer', async () => {
    const handlers = show(base({ questions: [question('po-s1-0', { blocking: true, file: 'flow.md' })], passedStages: ['flow.md'], reprocessedStages: ['flow.md'] }));
    expect(screen.getByText('Pode pular: Continuar avança sem resposta.')).toBeTruthy();
    expect(screen.queryByText('Bloqueia o avanço até você responder.')).toBeNull();
    fireEvent.click(screen.getByTestId('wizard-continue'));
    await waitFor(() => expect(handlers.onContinueStage).toHaveBeenCalledWith('flow.md', false));
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
    fireEvent.click(screen.getByTestId('stage-confirm'));
    expect(again.onReprocessStage).toHaveBeenCalledWith('project.md');
    expect(again.onEvaluateStage).not.toHaveBeenCalled();
    expect(screen.queryByTestId('stage-confirm')).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('offers Avaliar esta etapa beside Reprocessar after a hand edit of a passed stage, and holds Continuar until the review', async () => {
    const handlers = on();
    const passed = (reviewed: string[]) => base({ doneStages: ['flow.md'], passedStages: ['project.md'], reviewedStages: reviewed, repositories: true });
    const { rerender } = render(<MemoryRouter><RefinementView snap={passed(['flow.md'])} busy={false} {...handlers} /></MemoryRouter>);
    fireEvent.change(editor('project.md'), { target: { value: '# Projeto editado à mão' } });
    expect(screen.getByTestId('wizard-process').textContent).toContain('Reprocessar');
    expect((screen.getByTestId('wizard-continue') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('wizard-continue-reason').textContent).toContain('Avalie esta etapa de novo.');
    fireEvent.click(screen.getByTestId('wizard-evaluate'));
    await waitFor(() => expect(handlers.onEvaluateStage).toHaveBeenCalledWith('project.md'));
    expect(handlers.onReprocessStage).not.toHaveBeenCalled();
    rerender(<MemoryRouter><RefinementView snap={passed(['flow.md', 'project.md'])} busy={false} {...handlers} /></MemoryRouter>);
    expect((screen.getByTestId('wizard-continue') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('wizard-evaluate')).toBeNull();
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
    show(base({ doneStages: ['flow.md'], staleBy: { 'project.md': 'flow.md' } }));
    expect(screen.getByTestId('doc-stale').textContent).toContain('flow.md');
  });
});

describe('the Jev score of the document', () => {
  it('shows the percent and the four checks, with no minimum and no verdict', () => {
    show(base({ doneStages: ['flow.md'], confidential: false, readiness: scored({ 'project.md': 0.65 }) }));
    const inset = screen.getByTestId('doc-score');
    expect(inset.textContent).toContain('Nota do Jev · project.md');
    expect(screen.getByTestId('doc-score-percent').textContent).toBe('65%');
    const rows = ['complete', 'concrete', 'consistent', 'scoped'].map((id) => screen.getByTestId(`doc-score-question-${id}`).textContent);
    expect(rows).toEqual(['Tem tudo o que deveria ter?44%em dúvida', 'Dá para conferir o que diz?72%', 'Está livre de contradições?84%', 'Tem só o que é deste documento?60%']);
    expect(document.body.textContent).not.toMatch(/Mínimo|Pronto para|Ainda não está pronto/);
  });

  it('lists where the Jev doubts each question, and one line when it doubts every part', () => {
    const readiness = scored({ 'project.md': 0.65 });
    const doubts = [
      { check: 'consistent', value: 0.53, part: { index: 4, of: 6, from: '### 17.5 Médico auditor', to: '## 20. Formatos' } },
      { check: 'consistent', value: 0.45, part: { index: 6, of: 6, from: '### 31.3 Governança', to: null } },
      ...[1, 2].map((index) => ({ check: 'scoped' as const, value: index / 100, part: { index, of: 2, from: null, to: null } })),
    ];
    show(base({ doneStages: ['flow.md'], confidential: false, readiness: { ...readiness, docs: { 'project.md': { ...readiness.docs['project.md']!, doubts } } } }));
    expect(screen.getByTestId('doc-score-question-consistent').textContent).toContain('parte 4 de 6 · de 17.5 Médico auditor até 20. Formatos — 53%parte 6 de 6 · de 31.3 Governança até o fim — 45%');
    expect(screen.getByTestId('doc-score-question-scoped').textContent).toContain('Em todas as 2 partes (a pior: 1%)');
    expect(screen.getByTestId('doc-score-how').textContent).toContain('Como a nota é calculada');
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
  // A stage named in the address opens only after the documents before it are done.
  const beforeDesign = ['flow.md', 'project.md', 'briefing.md', 'stack.md'];
  it('attaches a text file to the document on screen, and saves it', async () => {
    const handlers = show(base({ doneStages: ['flow.md'] }));
    fireEvent.change(screen.getByTestId('attach-doc'), { target: { files: [new File(['# Projeto novo'], 'projeto.md', { type: 'text/markdown' })] } });
    const dialog = await screen.findByTestId('stage-confirm');
    expect(dialog.className).toContain('primary');
    expect(dialog.className).not.toContain('confirm-danger');
    expect(dialog.textContent).toContain('Anexar');
    expect(document.querySelector('.confirm-icon')!.className).toContain('is-accent');
    fireEvent.click(dialog);
    await waitFor(() => expect(editor('project.md').value).toBe('# Projeto novo'));
    expect(handlers.onSaveDoc).toHaveBeenCalledWith('project.md', '# Projeto novo', undefined);
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

  it('a stage lists the questions the guard dropped on its own document, and the owner can ask one again', () => {
    open('?etapa=design.md');
    const dropped = (questionId: string, file: string) => ({ questionId, role: 'po', text: 'Até quando o link vale?', cycle: 2, blocking: false, relatedAcIds: [], file, matchedQuestionId: 'po-s1-0', matchedText: 'Qual o prazo do link?', matchedAnswer: '90 dias' });
    const handlers = { ...on(), onReask: vi.fn() };
    show(base({ doneStages: beforeDesign, droppedQuestions: [dropped('po-s2-0', 'design.md'), dropped('po-s2-1', 'project.md')] }), handlers);
    const list = screen.getByTestId('dropped-repeats');
    expect(list.textContent).toContain('Perguntas repetidas que não foram feitas de novo (1)');
    expect(list.textContent).toContain('Antes: Qual o prazo do link?');
    expect(list.textContent).toContain('Você respondeu: 90 dias');
    fireEvent.click(screen.getByTestId('reask-po-s2-0'));
    expect(handlers.onReask).toHaveBeenCalledWith('po-s2-0');
  });

  it('marks the design as not applicable after the owner confirms, and leaves it when they do not', () => {
    open('?etapa=design.md');
    const handlers = show(base({ doneStages: beforeDesign }));
    fireEvent.click(screen.getByRole('button', { name: 'Não se aplica' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(handlers.onNotApplicable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Não se aplica' }));
    expect(screen.getByTestId('stage-confirm').className).not.toContain('confirm-danger');
    fireEvent.click(screen.getByTestId('stage-confirm'));
    expect(handlers.onNotApplicable).toHaveBeenCalledTimes(1);
    expect(handlers.onSaveDoc).not.toHaveBeenCalled();
  });

  it('marks an empty design as not applicable without asking', () => {
    open('?etapa=design.md');
    const snap = base({ doneStages: beforeDesign });
    const handlers = show({ ...snap, docs: { ...snap.docs, 'design.md': '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Não se aplica' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(handlers.onNotApplicable).toHaveBeenCalledTimes(1);
  });

  it('offers Sugerir from the second document on, not on flow.md', () => {
    const suggest = vi.fn(async () => null);
    const first = render(<MemoryRouter><RefinementView snap={base()} busy={false} {...on()} onSuggestDoc={suggest} /></MemoryRouter>);
    expect(screen.queryByTestId('suggest')).toBeNull();
    first.unmount();
    render(<MemoryRouter><RefinementView snap={base({ doneStages: ['flow.md'] })} busy={false} {...on()} onSuggestDoc={suggest} /></MemoryRouter>);
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

  it('keeps the pendências off the summary and shows them all in the backlog step, opened, with a link to each document', () => {
    open('?etapa=revisao');
    show(reviewSnap());
    // The summary no longer carries the pendências or the questions: both live in the backlog step.
    expect(screen.queryByTestId('final-pending')).toBeNull();
    expect(screen.queryByTestId('pending-toggle')).toBeNull();
    expect(screen.queryByTestId('answer-po-c1-0')).toBeNull();
    cleanup();
    open('?etapa=backlog');
    show(reviewSnap());
    expect(screen.getByTestId('pending-toggle').textContent).toBe('Ocultar pendências');
    expect(screen.getByTestId('final-pending').textContent).toContain('project.md: 2 pendências');
    expect(screen.getByTestId('answer-po-c1-0')).toBeTruthy();
    fireEvent.click(screen.getByTestId('pending-toggle'));
    expect(screen.queryByTestId('pending-project.md')).toBeNull();
    fireEvent.click(screen.getByTestId('pending-toggle'));
    fireEvent.click(screen.getByTestId('pending-project.md'));
    expect(window.location.search).toContain('etapa=project.md');
    expect(screen.getByTestId('doc-project.md')).toBeTruthy();
  });

  it('shows the general questions of the PO and the SM on the backlog step, and sends the answer', () => {
    open('?etapa=backlog');
    const handlers = show(reviewSnap());
    expect(screen.getByTestId('round-questions-intro')).toBeTruthy();
    fireEvent.change(screen.getByTestId('answer'), { target: { value: '8080' } });
    fireEvent.click(screen.getByTestId('answer-po-c1-0'));
    expect(handlers.onAnswer).toHaveBeenCalledWith('po-c1-0', '8080', false);
  });

  it('the backlog step lists the questions of the whole round the guard dropped, and the owner can ask one again', () => {
    open('?etapa=backlog');
    const handlers = { ...on(), onReask: vi.fn() };
    show(reviewSnap({ droppedQuestions: [{ questionId: 'po-c1-5', role: 'po', text: 'Quem aprova a conta?', cycle: 1, blocking: false, relatedAcIds: [], matchedQuestionId: 'po-c0-0', matchedText: 'Quem aprova?', matchedAnswer: 'O gerente' }] }), handlers);
    expect(screen.getByTestId('dropped-repeats').textContent).toContain('Resolvida com "O gerente"');
    fireEvent.click(screen.getByTestId('reask-po-c1-5'));
    expect(handlers.onReask).toHaveBeenCalledWith('po-c1-5');
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

  it('shows the backlog and its coverage on stage 7 only', () => {
    const backlog = { enabled: true, detail: true, items: [], epics: [], specs: {}, preplans: {} };
    open('?etapa=revisao');
    show(reviewSnap({ backlog }));
    expect(screen.queryByTestId('spec-tree')).toBeNull();
    cleanup();
    open('?etapa=backlog');
    show(reviewSnap({ backlog }));
    expect(screen.getByTestId('spec-tree')).toBeTruthy();
  });

  it('calls no agent when the backlog stage opens: the specs.md is checked only on the click of the owner', () => {
    const backlog = { enabled: true, detail: true, items: [], epics: [], specs: {}, preplans: {} };
    open('?etapa=backlog');
    const handlers = show({ ...reviewSnap({ backlog, status: 'ready' }), specsApproved: false });
    expect(handlers.onCheckSpecs).not.toHaveBeenCalled();
    expect(screen.queryByTestId('specs-check-retry')).toBeNull();
    expect(screen.getByTestId('prepare-backlog')).toBeTruthy();
  });

  it('Continuar on the summary stays open while the specs.md is not approved, and the backlog step shows what it waits for', () => {
    const backlog = { enabled: true, detail: true, items: [], epics: [], specs: {}, preplans: {} };
    const snap = { ...reviewSnap({ backlog, status: 'ready', specsMd: { hash: 'h1', bytes: 10 }, specsReview: { po: verdict('h1', 'approved'), sm: verdict('h1', 'rejected', ['AC-003 não cobre o objetivo']) } }), specsApproved: false };
    open('?etapa=revisao');
    show(snap);
    // The summary never waits for the specs.md: it is made and checked in the backlog step.
    expect((screen.getByTestId('open-backlog') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('start-missing')).toBeNull();
    cleanup();
    open('?etapa=backlog');
    show(snap);
    expect(screen.getByTestId('refinement-checklist-po-status').textContent).toBe('Aprovado');
    expect(screen.getByTestId('refinement-checklist-sm-status').textContent).toBe('Reprovado');
    expect(screen.queryByTestId('specs-check-po-label')).toBeNull();
    expect(screen.getByTestId('specs-check-sm-finding').textContent).toBe('SM: AC-003 não cobre o objetivo');
  });

  it('Continuar is enabled once specs.md is approved by both, with no reason shown', () => {
    const backlog = { enabled: true, detail: true, items: [], epics: [], specs: {}, preplans: {} };
    open('?etapa=revisao');
    show({
      ...reviewSnap({ backlog, status: 'ready', specsMd: { hash: 'h1', bytes: 10 }, specsReview: { po: verdict('h1', 'approved'), sm: verdict('h1', 'approved') } }),
      specsApproved: true,
    });
    expect((screen.getByTestId('open-backlog') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('start-missing')).toBeNull();
  });

  it('asks the Jev for the scores of all five documents when some have none', () => {
    open('?etapa=revisao');
    const handlers = show(reviewSnap({ confidential: false }));
    fireEvent.click(screen.getByTestId('score-all'));
    expect(handlers.onScoreAll).toHaveBeenCalledTimes(1);
  });

  it('is the summary: it has no evaluate action, the owner refines in the stage', () => {
    open('?etapa=revisao');
    show(reviewSnap());
    expect(screen.getByRole('heading', { name: 'Resumo' })).toBeTruthy();
    expect(screen.queryByTestId('evaluate')).toBeNull();
  });

  it('breaks the backlog from the last screen', () => {
    open('?etapa=revisao');
    const handlers = show(reviewSnap());
    fireEvent.click(screen.getByTestId('enable-backlog'));
    expect(handlers.onEnableBacklog).toHaveBeenCalledTimes(1);
  });

  it('continues from the review to the architecture step in a repository session, not to the backlog', async () => {
    open('?etapa=revisao');
    const handlers = show(reviewSnap({ repositories: true, doneStages: ['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md'] }));
    expect(screen.queryByTestId('enable-backlog')).toBeNull();
    fireEvent.click(screen.getByTestId('open-backlog'));
    await waitFor(() => expect(window.location.search).toContain('etapa=arquitetura'));
    expect(handlers.onEnableBacklog).not.toHaveBeenCalled();
  });

  it('does not continue from the review while a document is still to be written, and names the documents', () => {
    open('?etapa=revisao');
    show(reviewSnap({ repositories: true }));
    expect((screen.getByTestId('open-backlog') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('wizard-action-reason').textContent).toBe('Conclua as etapas dos documentos antes: falta briefing.md, stack.md, design.md.');
  });

  it('opens stage 7 when the backlog exists, and comes back to the review from it', async () => {
    open('?etapa=revisao');
    show({ ...reviewSnap({ backlog: { enabled: true, detail: true, items: [], epics: [], specs: {}, preplans: {} } }), specsApproved: true });
    fireEvent.click(screen.getByTestId('open-backlog'));
    await waitFor(() => expect(screen.getByTestId('backlog-stage')).toBeTruthy());
    expect(screen.getByTestId('stage-wizard')).toBeTruthy();
    expect(window.location.search).toContain('etapa=backlog');
    fireEvent.click(screen.getByTestId('wizard-back'));
    expect(screen.queryByTestId('backlog-stage')).toBeNull();
    expect(window.location.search).toContain('etapa=revisao');
  });

  it('closes the review on the server when the owner opens the backlog', async () => {
    open('?etapa=revisao');
    const handlers = show({ ...reviewSnap({ backlog: { enabled: true, detail: true, items: [], epics: [], specs: {}, preplans: {} } }), specsApproved: true });
    fireEvent.click(screen.getByTestId('open-backlog'));
    await waitFor(() => expect(screen.getByTestId('backlog-stage')).toBeTruthy());
    expect(handlers.onCloseReview).toHaveBeenCalledTimes(1);
  });

  it('shows which documents are in Graphify, and adds a missing one on demand', () => {
    open('?etapa=revisao');
    const handlers = show(reviewSnap({ graphed: ['flow.md', 'project.md'] }));
    expect(screen.getByTestId('graph-row-flow.md').textContent).toContain('no Graphify');
    expect(screen.getByTestId('graph-row-stack.md').textContent).toContain('fora do Graphify');
    fireEvent.click(screen.getByTestId('graph-add-stack.md'));
    expect(handlers.onAddToGraph).toHaveBeenCalledWith('stack.md');
    expect(handlers.onContinueStage).not.toHaveBeenCalled();
  });

  it('shows the review done once closed, and does not close it again', () => {
    open('?etapa=revisao');
    const handlers = show({ ...reviewSnap({ reviewClosed: true, backlog: { enabled: true, detail: true, items: [], epics: [], specs: {}, preplans: {} } }), specsApproved: true });
    fireEvent.click(screen.getByTestId('open-backlog'));
    expect(screen.getByTestId('backlog-stage')).toBeTruthy();
    expect(handlers.onCloseReview).not.toHaveBeenCalled();
  });

  it('offers to break the backlog on stage 7 when it does not exist yet', () => {
    open('?etapa=backlog');
    const handlers = show(reviewSnap());
    fireEvent.click(screen.getByTestId('enable-backlog'));
    expect(handlers.onEnableBacklog).toHaveBeenCalledTimes(1);
  });
});

describe('saving what the owner typed', () => {
  it('saves the text on its own a moment after typing stops', async () => {
    vi.useFakeTimers();
    try {
      const handlers = show(base());
      fireEvent.change(screen.getByTestId('doc-flow.md'), { target: { value: '# Fluxo novo' } });
      expect(handlers.onSaveDoc).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1600);
      expect(handlers.onSaveDoc).toHaveBeenCalledWith('flow.md', '# Fluxo novo', undefined);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the status of the verification list on the summary', () => {
  const all = ['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md'];
  const reviewSnap = (over: Record<string, unknown> = {}) => base({ readiness: scored({ 'flow.md': 0.53 }), questions: [], patches: [], ...over });

  it('counts only the five documents: a session whose stages are all current is not outdated, even when the specs changed', () => {
    open('?etapa=revisao');
    show(reviewSnap({ stale: true, cycle: 3, doneStages: all, graphed: all, staleBy: {} }));
    expect(screen.queryByText('Desatualizada')).toBeNull();
    expect(screen.getByText('Atual')).toBeTruthy();
  });

  it('says outdated when a finished stage was outdated by an edit', () => {
    open('?etapa=revisao');
    show(reviewSnap({ stale: true, cycle: 3, doneStages: all, graphed: all, staleBy: { 'stack.md': 'briefing.md' } }));
    expect(screen.getByText('Desatualizada')).toBeTruthy();
  });
});

describe('saving the text the owner typed, and what a save leaves on screen', () => {
  // A server that lays out the document while it refuses the first save: a save over the hash from before the layout is a conflict.
  const layoutServer = (handlers: ReturnType<typeof on>) => {
    let hash = 'hash-before-layout';
    handlers.onSaveDoc
      .mockImplementationOnce(async () => {
        hash = 'hash-after-layout';
        throw new Error('Já tem o documento sendo organizado. Tente salvar de novo em instantes.');
      })
      .mockImplementation(async (_file: string, _text: string, baseHash?: string) => {
        if (baseHash !== hash) throw new Error('O documento mudou desde que você o abriu, então seu texto não foi salvo. Copie o seu texto antes de atualizar a página.');
        hash = 'hash-after-save';
        return hash;
      });
    handlers.onReadDoc.mockImplementation(async () => ({ text: '# Projeto com layout', hash }));
  };

  it('keeps the text typed after a save when the page reads the saved text back', async () => {
    const handlers = on();
    const snap = base();
    const { rerender } = render(<MemoryRouter><RefinementView snap={snap} busy={false} {...handlers} /></MemoryRouter>);
    fireEvent.change(screen.getByTestId('doc-flow.md'), { target: { value: '# Fluxo salvo' } });
    await waitFor(() => expect(handlers.onSaveDoc).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('doc-flow.md'), { target: { value: '# Fluxo salvo\n\nMais texto.' } });
    rerender(<MemoryRouter><RefinementView snap={{ ...snap, docs: { ...snap.docs, 'flow.md': '# Fluxo salvo' } }} busy={false} {...handlers} /></MemoryRouter>);
    expect(editor('flow.md').value).toBe('# Fluxo salvo\n\nMais texto.');
  });

  it('stays on the stage when saving the typed text fails', async () => {
    const handlers = on();
    handlers.onSaveDoc.mockResolvedValue(null);
    show(base({ doneStages: ['flow.md'] }), handlers);
    fireEvent.change(screen.getByTestId('doc-project.md'), { target: { value: '# Projeto editado' } });
    fireEvent.click(screen.getByTestId('wizard-continue'));
    await waitFor(() => expect(handlers.onSaveDoc).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handlers.onContinueStage).not.toHaveBeenCalled();
    expect(editor('project.md').value).toBe('# Projeto editado');
  });

  it('saves again by itself when the server refuses the save while it organizes the document, and keeps the text', async () => {
    vi.useFakeTimers();
    try {
      const handlers = on();
      layoutServer(handlers);
      show(base({ doneStages: ['flow.md'] }), handlers);
      fireEvent.change(editor('project.md'), { target: { value: '# Projeto organizado' } });
      fireEvent.blur(editor('project.md'));
      // The retry comes before the autosave timer, which would send the text too.
      await vi.advanceTimersByTimeAsync(600);
      expect(handlers.onSaveDoc).toHaveBeenCalledTimes(2);
      expect(handlers.onSaveDoc).toHaveBeenLastCalledWith('project.md', '# Projeto organizado', 'hash-after-layout');
      expect(editor('project.md').value).toBe('# Projeto organizado');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the document once before the retry, and a later save goes over the hash the retry returned, with no conflict', async () => {
    vi.useFakeTimers();
    try {
      const handlers = on();
      layoutServer(handlers);
      show(base({ doneStages: ['flow.md'] }), handlers);
      fireEvent.change(editor('project.md'), { target: { value: '# Projeto organizado' } });
      fireEvent.blur(editor('project.md'));
      await vi.advanceTimersByTimeAsync(600);
      expect(handlers.onReadDoc).toHaveBeenCalledTimes(1);
      expect(handlers.onSaveDoc).toHaveBeenCalledTimes(2);
      fireEvent.change(editor('project.md'), { target: { value: '# Projeto organizado\n\nDepois do layout.' } });
      fireEvent.blur(editor('project.md'));
      await vi.advanceTimersByTimeAsync(600);
      expect(handlers.onSaveDoc).toHaveBeenCalledTimes(3);
      expect(handlers.onSaveDoc).toHaveBeenLastCalledWith('project.md', '# Projeto organizado\n\nDepois do layout.', 'hash-after-save');
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves the text typed in the last moment when the browser hides the page, and asks the browser to keep the request', () => {
    const handlers = on();
    render(<MemoryRouter><RefinementView snap={base()} busy={false} {...handlers} /></MemoryRouter>);
    fireEvent.change(screen.getByTestId('doc-flow.md'), { target: { value: '# Fluxo oculto' } });
    window.dispatchEvent(new Event('pagehide'));
    expect(handlers.onSaveDoc).toHaveBeenCalledWith('flow.md', '# Fluxo oculto', undefined, true);
  });

  it('sends the text at once when the page hides, even while an earlier save is still in flight', () => {
    const handlers = on();
    handlers.onSaveDoc.mockReturnValueOnce(new Promise(() => undefined));
    show(base(), handlers);
    fireEvent.change(editor('flow.md'), { target: { value: '# Fluxo um' } });
    fireEvent.blur(editor('flow.md'));
    fireEvent.change(editor('flow.md'), { target: { value: '# Fluxo dois' } });
    window.dispatchEvent(new Event('pagehide'));
    expect(handlers.onSaveDoc).toHaveBeenLastCalledWith('flow.md', '# Fluxo dois', undefined, true);
  });

  it('saves the text when the browser hides the tab, as it does when the page closes', () => {
    const handlers = on();
    show(base(), handlers);
    fireEvent.change(editor('flow.md'), { target: { value: '# Fluxo aba' } });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      expect(handlers.onSaveDoc).toHaveBeenCalledWith('flow.md', '# Fluxo aba', undefined, true);
    } finally {
      Reflect.deleteProperty(document, 'hidden');
    }
  });

  it('saves the text typed in the last moment when the page closes, before the autosave timer', () => {
    const handlers = on();
    const { unmount } = render(<MemoryRouter><RefinementView snap={base()} busy={false} {...handlers} /></MemoryRouter>);
    fireEvent.change(screen.getByTestId('doc-flow.md'), { target: { value: '# Fluxo digitado' } });
    unmount();
    expect(handlers.onSaveDoc).toHaveBeenCalledWith('flow.md', '# Fluxo digitado', undefined);
  });

  it('goes back to the step before with the browser Back, not out of the wizard', async () => {
    window.history.pushState(null, '', '/?etapa=project.md');
    show(base({ doneStages: ['flow.md'] }));
    fireEvent.click(screen.getByTestId('wizard-back'));
    expect(editor('flow.md').value).toBe('# Flow');
    window.history.back();
    await waitFor(() => expect(editor('project.md').value).toBe('# Hello'));
  });

  it('browser Back and forward open a named step only when it is open', async () => {
    window.history.replaceState(null, '', '/?etapa=flow.md');
    window.history.pushState(null, '', '/?etapa=design.md');
    show(base({ doneStages: ['flow.md'] }));
    expect(editor('project.md').value).toBe('# Hello');
    window.history.back();
    await waitFor(() => expect(editor('flow.md').value).toBe('# Flow'));
    window.history.forward();
    await waitFor(() => expect(editor('project.md').value).toBe('# Hello'));
  });
});

describe('Sugerir and Anexar imagem replace a document only after the owner confirms', () => {
  const withDocs = (docs: Partial<Snapshot['docs']>, over: Record<string, unknown> = {}) => ({ ...base(over), docs: { ...base().docs, ...docs } });

  it('keeps the text typed while the suggestion is written, and asks before it replaces the text', async () => {
    let answer!: (text: string | null) => void;
    const suggest = vi.fn(() => new Promise<string | null>((resolve) => { answer = resolve; }));
    render(<MemoryRouter><RefinementView snap={base({ doneStages: ['flow.md'] })} busy={false} {...on()} onSuggestDoc={suggest} /></MemoryRouter>);
    fireEvent.click(screen.getByTestId('suggest'));
    fireEvent.change(editor('project.md'), { target: { value: '# Digitado enquanto sugere' } });
    await act(async () => answer('# Sugerido'));
    expect(editor('project.md').value).toBe('# Digitado enquanto sugere');
    fireEvent.click(await screen.findByTestId('stage-confirm'));
    expect(editor('project.md').value).toBe('# Sugerido');
  });

  it('replaces an empty document at once, without asking', async () => {
    const suggest = vi.fn(async () => '# Sugerido');
    render(<MemoryRouter><RefinementView snap={withDocs({ 'project.md': '' }, { doneStages: ['flow.md'] })} busy={false} {...on()} onSuggestDoc={suggest} /></MemoryRouter>);
    fireEvent.click(screen.getByTestId('suggest'));
    await waitFor(() => expect(editor('project.md').value).toBe('# Sugerido'));
    expect(screen.queryByTestId('stage-confirm')).toBeNull();
  });

  it('asks before Anexar imagem replaces the design that has text', async () => {
    open('?etapa=design.md');
    const images = vi.fn(async () => '# Design de imagens');
    render(<MemoryRouter><RefinementView snap={base({ doneStages: ['flow.md', 'project.md', 'briefing.md', 'stack.md'] })} busy={false} {...on()} onDesignFromImages={images} /></MemoryRouter>);
    fireEvent.change(screen.getByTestId('attach-images'), { target: { files: [new File(['x'], 'exemplo.png', { type: 'image/png' })] } });
    await waitFor(() => expect(images).toHaveBeenCalled());
    expect(editor('design.md').value).toBe('# Design');
    fireEvent.click(await screen.findByTestId('stage-confirm'));
    expect(editor('design.md').value).toBe('# Design de imagens');
  });

  it('does not offer Sugerir while flow.md is empty, and says why', () => {
    render(<MemoryRouter><RefinementView snap={withDocs({ 'flow.md': '' }, { doneStages: ['flow.md'] })} busy={false} {...on()} onSuggestDoc={vi.fn(async () => null)} /></MemoryRouter>);
    const suggest = screen.getByTestId('suggest') as HTMLButtonElement;
    expect(suggest.disabled).toBe(true);
    expect(suggest.title).toBe('Preencha o flow.md antes de pedir uma sugestão.');
  });
});

describe('the buttons that run the agents wait while a document is in Graphify', () => {
  const ALL_DOCS = ['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md'];

  it('disables the stage actions, with the reason, and leaves the editor open', () => {
    open('?etapa=design.md');
    show(base({ doneStages: ['flow.md', 'project.md', 'briefing.md', 'stack.md'], graphing: 'design.md' }));
    expect((screen.getByTestId('refinement-stage-not-applicable') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('wizard-process') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('wizard-continue') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('wizard-graph-reason').textContent).toContain('Espere a extração do Graphify terminar');
    expect(editor('design.md').readOnly).toBe(false);
  });

  it('sends one Adicionar ao Graphify, and locks the button while the request is pending', () => {
    open('?etapa=revisao');
    const handlers = { ...on(), onAddToGraph: vi.fn(() => new Promise<boolean>(() => undefined)) as never };
    show(base({ doneStages: ALL_DOCS, graphed: ['flow.md'] }), handlers);
    fireEvent.click(screen.getByTestId('graph-add-project.md'));
    fireEvent.click(screen.getByTestId('graph-add-project.md'));
    expect(handlers.onAddToGraph).toHaveBeenCalledTimes(1);
  });

  it('sends one Perguntar de novo, and locks the button while the request is pending', () => {
    open('?etapa=design.md');
    const dropped = { questionId: 'po-s2-0', role: 'po', text: 'Até quando o link vale?', cycle: 2, blocking: false, relatedAcIds: [], file: 'design.md', matchedQuestionId: 'po-s1-0', matchedText: 'Qual o prazo do link?', matchedAnswer: '90 dias' };
    const handlers = { ...on(), onReask: vi.fn(() => new Promise<boolean>(() => undefined)) };
    show(base({ doneStages: ['flow.md', 'project.md', 'briefing.md', 'stack.md'], droppedQuestions: [dropped] }), handlers);
    fireEvent.click(screen.getByTestId('reask-po-s2-0'));
    fireEvent.click(screen.getByTestId('reask-po-s2-0'));
    expect(handlers.onReask).toHaveBeenCalledTimes(1);
  });

  it('sends one decision of the architecture, and locks the button while the request is pending', () => {
    open('?etapa=arquitetura');
    const handlers = { ...on(), onDecideArchitecture: vi.fn(() => new Promise<boolean>(() => undefined)) };
    show(base({ doneStages: ALL_DOCS, repositories: true, reviewClosed: true, architecture: null }), handlers);
    fireEvent.click(screen.getByTestId('architecture-decide'));
    fireEvent.click(screen.getByTestId('architecture-decide'));
    expect(handlers.onDecideArchitecture).toHaveBeenCalledTimes(1);
  });

  it('keeps the typed answer in its field until the server accepts it', async () => {
    const handlers = on();
    handlers.onAnswer.mockResolvedValue(false);
    show(base({ doneStages: ['flow.md'], questions: [question('po-s1-0', { file: 'project.md' })] }), handlers);
    fireEvent.change(screen.getByTestId('answer'), { target: { value: 'Clientes ativos' } });
    fireEvent.click(screen.getByTestId('answer-po-s1-0'));
    await waitFor(() => expect(handlers.onAnswer).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((screen.getByTestId('answer') as HTMLTextAreaElement).value).toBe('Clientes ativos');
  });

  it('keeps the typed secret in its field until the server saves it', async () => {
    open('?etapa=revisao');
    const handlers = on();
    handlers.onSecret.mockResolvedValue(false);
    const snap = base({ doneStages: ALL_DOCS, graphed: ALL_DOCS });
    show({ ...snap, secrets: [{ name: 'API_KEY', present: false, hint: null, uses: [], mentions: [] }] }, handlers);
    fireEvent.change(screen.getByTestId('secret-API_KEY'), { target: { value: 'segredo' } });
    fireEvent.click(screen.getByTestId('save-secret-API_KEY'));
    await waitFor(() => expect(handlers.onSecret).toHaveBeenCalledWith('API_KEY', 'segredo'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((screen.getByTestId('secret-API_KEY') as HTMLInputElement).value).toBe('segredo');
  });
});


describe('the steps the owner can open, and the guards of the stage actions', () => {
  it('does not open a step after the one in progress, and shows it as unavailable', () => {
    open('?etapa=design.md');
    show(base({ doneStages: ['flow.md', 'project.md', 'briefing.md', 'stack.md'] }));
    const review = screen.getByTestId('step-review') as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    fireEvent.click(review);
    expect(window.location.search).not.toContain('etapa=revisao');
  });

  it('does not continue from a finished stage that was outdated by an edit, and says to process it again', () => {
    open('?etapa=project.md');
    show(base({ doneStages: ['flow.md', 'project.md'], graphed: ['flow.md', 'project.md'], staleBy: { 'project.md': 'flow.md' } }));
    expect((screen.getByTestId('wizard-continue') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('wizard-continue-reason').textContent).toBe('Processe a etapa project.md de novo antes de continuar.');
  });

  it('does not hold Continuar for a document edited after its score, only for a stage outdated by an earlier one', () => {
    open('?etapa=project.md');
    show(base({ doneStages: ['flow.md'], readiness: scored({ 'project.md': 0.8 }), outdatedDocs: ['project.md'] }));
    expect((screen.getByTestId('wizard-continue') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('wizard-continue-reason')).toBeNull();
  });

  it('does not continue from an empty flow.md, and says what to write first', () => {
    open('?etapa=flow.md');
    show({ ...base(), docs: { ...base().docs, 'flow.md': '' } });
    expect((screen.getByTestId('wizard-continue') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('wizard-continue-reason').textContent).toBe('Escreva o flow.md antes de continuar: a etapa está vazia.');
  });

  it('does not break the backlog down while a document is still outside Graphify, and names it', () => {
    open('?etapa=backlog');
    show(base({ doneStages: ['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md'], reviewClosed: true, repositories: true, graphed: ['flow.md', 'project.md'] }));
    expect((screen.getByTestId('enable-backlog') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('wizard-action-reason').textContent).toBe('Adicione os cinco documentos ao Graphify antes: falta briefing.md, stack.md, design.md.');
  });

  it('does not open the backlog while a finished stage is outdated, and names the stage', () => {
    open('?etapa=revisao');
    show(base({ doneStages: ['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md'], staleBy: { 'stack.md': 'briefing.md' } }));
    expect((screen.getByTestId('enable-backlog') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('wizard-action-reason').textContent).toBe('Revise de novo as etapas desatualizadas antes: stack.md.');
  });
});

describe('the copy and the figures the stage screen shows', () => {
  const ALL5 = ['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md'];
  const reviewed = (over: Record<string, unknown>) => base({ doneStages: ALL5, graphed: ALL5, ...over });

  it('says in the reprocess dialog that accepted suggestions stay, except those built on a text edited after the pass', () => {
    show(base({ passedStages: ['flow.md'] }));
    fireEvent.click(screen.getByTestId('wizard-process'));
    expect(screen.getByRole('alertdialog').textContent).toContain('As sugestões aceitas continuam, exceto as que dependem de um texto editado depois da entrega.');
  });

  it('counts only the suggestions the agents applied and kept, not those a Reprocessar reverted', () => {
    open('?etapa=revisao');
    const reverted = { ...patch('auto-1', 'flow.md'), status: 'dropped', auto: true, decision: 'Voltou ao texto entregue com o Reprocessar.' };
    show(reviewed({ patches: [reverted] }));
    expect(screen.queryByTestId('final-auto-applied')).toBeNull();
  });

  it('flags a score as below the pass line only when the percent on screen is below it', () => {
    open('?etapa=project.md');
    show(base({ doneStages: ['flow.md'], readiness: scored({ 'project.md': 0.4957 }) }));
    expect(screen.queryByTestId('wizard-low-score')).toBeNull();
    expect(screen.getByTestId('wizard-continue').textContent).toBe('Continuar');
  });

  it('shows 49.6% as 50%, and does not flag it as below the pass line', () => {
    open('?etapa=project.md');
    show(base({ doneStages: ['flow.md'], readiness: scored({ 'project.md': 0.496 }) }));
    expect(screen.getByTestId('doc-score-percent').textContent).toBe('50%');
    expect(screen.queryByTestId('wizard-low-score')).toBeNull();
    expect(screen.getByTestId('wizard-continue').textContent).toBe('Continuar');
  });

  it('does not show a score the owner has edited since as low, and does not hold Continuar for it', () => {
    open('?etapa=project.md');
    show(base({ doneStages: ['flow.md'], readiness: scored({ 'project.md': 0.4 }), outdatedDocs: ['project.md'] }));
    expect(screen.queryByTestId('wizard-low-score')).toBeNull();
    expect((screen.getByTestId('wizard-continue') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('wizard-continue').textContent).toBe('Continuar');
  });

  it('says the Jev outage on a full round as the server runs it: the evaluation goes on without it', () => {
    const outage = { seq: 1, at: '', runId: 'hello-app/hello-001', specHash: 'draft', type: 'REFINE_DOCS_VALIDATED', kind: 'fact', data: { cycle: 1, available: false } } as unknown as StoredEvent;
    expect(stageNow([outage], 1).stage).toBe('O Jev não respondeu. A avaliação segue sem as notas dele.');
  });

  it('shows on the architecture step that the decision is out of date when the documents changed after it', () => {
    open('?etapa=arquitetura');
    const decision = { style: 'monolith', rationale: 'Um só serviço.', repositories: [], integrations: [] };
    show({ ...reviewed({ repositories: true, architecture: { docsHash: 'h', decision } }), architectureStale: true } as Snapshot);
    expect(screen.getByTestId('architecture-card-stale').textContent).toContain('A decisão está desatualizada');
  });
});
