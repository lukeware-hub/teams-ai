import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../api.js';
import { RefinementView } from './Refinement.js';

// These tests are about stage 7 of a new project, the screen that prepares the development.
beforeEach(() => window.history.replaceState(null, '', '/?etapa=backlog'));
afterEach(() => window.history.replaceState(null, '', '/'));

const green = (ids: string[]) => ids.map((id) => ({ id, role: (id.startsWith('po') ? 'po' : 'sm') as 'po' | 'sm', passed: true, detail: 'ok' }));
const ALL = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'];

/** A project in its refinement, with the documents ready unless the state says otherwise. */
const project = (over: Partial<Snapshot['state']>): Snapshot => ({
  projectId: 'hello-app',
  specId: 'hello-app-001',
  docs: { 'project.md': '# Hello', 'briefing.md': '## Objectives', 'stack.md': '# Stack', 'flow.md': '# Flow', 'design.md': '# Design' },
  secrets: [],
  tokens: { inputTokens: 10, outputTokens: 5, costUsd: 0.02, steps: 3 },
  state: {
    status: 'ready',
    stale: false,
    cycle: 1,
    mode: 'new-project',
    derived: null,
    checklist: green(ALL),
    questions: [],
    patches: [],
    discarded: [],
    error: null,
    runId: null,
    backlog: null,
    ...over,
  } as never,
});

const backlogOutline = { enabled: true, detail: false, epics: [], items: [], specs: {}, preplans: {}, flowHeadings: [] };
const backlogItem = { key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S', rank: 1 };
const backlogDetailed = { enabled: true, detail: true, epics: [], items: [backlogItem], specs: {}, preplans: { base: { preplan: { tasks: [] } } }, flowHeadings: [] };
const question = (blocking: boolean, status = 'pending') => ({ questionId: 'outline-c2-0', role: 'po', text: 'O backlog ainda não fecha: x. Como deve ser tratado?', blocking, relatedAcIds: [], cycle: 2, status, answer: null });

const handlers = () => ({ onSaveDoc: vi.fn(), onEvaluate: vi.fn(), onAnswer: vi.fn(), onSkip: vi.fn(), onAccept: vi.fn(), onReject: vi.fn(), onSecret: vi.fn(), onStart: vi.fn() });
const renderView = (snap: Snapshot, h = handlers()) => {
  render(<MemoryRouter><RefinementView snap={snap} busy={false} events={[]} {...h} /></MemoryRouter>);
  return h;
};

describe('stage 7 of a new project prepares the development', () => {
  const speckit = (over: Record<string, unknown> = {}) => ({ status: 'done', steps: [], stale: false, ...over });
  const wizard = (over: Partial<Snapshot['state']>) => project({ stages: true, backlog: backlogDetailed as never, ...over });
  const handlersWithSpeckit = () => ({ ...handlers(), onEnableBacklog: vi.fn(), onPreparePlans: vi.fn(), onResolveAll: vi.fn() });

  it('offers to break the backlog until it exists, with no start', () => {
    const h = renderView(project({ stages: true }), handlersWithSpeckit());
    expect(screen.getByTestId('backlog-stage')).toBeTruthy();
    fireEvent.click(screen.getByTestId('enable-backlog'));
    expect((h as ReturnType<typeof handlersWithSpeckit>).onEnableBacklog).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('start')).toBeNull();
    expect(screen.queryByTestId('evaluate')).toBeNull();
  });

  it('splits the step into four cards, each naming who fills it and explaining itself', () => {
    renderView(wizard({}), handlersWithSpeckit());
    for (const id of ['needs', 'backlog', 'plans', 'checks']) {
      const card = screen.getByTestId(`step-card-${id}`);
      expect(card.querySelector('[data-testid="info-tip-button"]')).toBeTruthy();
      expect(screen.getByTestId(`step-card-owner-${id}`).textContent).toBeTruthy();
    }
    expect(screen.getByTestId('step-card-plans').contains(screen.getByTestId('speckit-idle'))).toBe(true);
    expect(screen.getByTestId('step-card-needs').contains(screen.getByTestId('start-missing'))).toBe(true);
    expect(screen.getByTestId('step-card-chip-plans').textContent).toBe('Não preparados');
  });

  it('opens only the card that still needs something, and rings it', () => {
    renderView(wizard({}), handlersWithSpeckit());
    const open = ['needs', 'backlog', 'plans', 'checks'].filter((id) => (screen.getByTestId(`step-card-${id}`) as HTMLDetailsElement).open);
    expect(open).toEqual(['needs']);
    expect(screen.getByTestId('step-card-needs').getAttribute('data-focus')).toBe('true');
    expect(screen.getByTestId('step-card-backlog').getAttribute('data-focus')).toBeNull();
  });

  it('moves the focus to the plans once nothing waits for the owner', () => {
    renderView(wizard({ status: 'ready', checklist: [] as never }), handlersWithSpeckit());
    const focused = ['needs', 'backlog', 'plans', 'checks'].filter((id) => screen.getByTestId(`step-card-${id}`).getAttribute('data-focus') === 'true');
    expect(focused.length).toBe(1);
  });

  it('puts the spec count in the backlog card chip and repeats no title inside it', () => {
    renderView(wizard({}), handlersWithSpeckit());
    expect(screen.getByTestId('step-card-chip-backlog').textContent).toContain('1 spec');
    expect(screen.queryByTestId('backlog-on-title')).toBeNull();
    expect(screen.queryByTestId('refinement-final-pending-title')).toBeNull();
  });

  it('says the plans are current once they are prepared', () => {
    renderView(wizard({ speckit: speckit() as never }), handlersWithSpeckit());
    expect(screen.getByTestId('step-card-chip-plans').textContent).toBe('Atuais');
  });

  it('keeps the plan preparation off until the backlog is detailed', () => {
    renderView(project({ stages: true, backlog: backlogOutline as never }), handlersWithSpeckit());
    expect(screen.queryByTestId('speckit-prepare')).toBeNull();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the plan box and its button to a project from before the document stages too', () => {
    renderView(project({ backlog: backlogDetailed as never }), handlersWithSpeckit());
    expect(screen.getByTestId('speckit-idle')).toBeTruthy();
    expect(screen.queryByTestId('speckit-prepare')).toBeNull();
    expect(screen.getByTestId('start-missing').textContent).toContain('Prepare os planos antes de iniciar.');
  });

  it('asks for the preparation first, and keeps the start locked until it is done', () => {
    const h = handlersWithSpeckit();
    renderView(wizard({}), h);
    expect(screen.getByTestId('speckit-idle')).toBeTruthy();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('prepare-backlog'));
    fireEvent.click(screen.getByTestId('stage-confirm'));
    expect(h.onResolveAll).toHaveBeenCalledTimes(1);
  });

  it('shows the progress while the plan prepares', () => {
    renderView(wizard({ speckit: speckit({ status: 'running', total: 4, steps: [{ command: 'constitution' }, { command: 'specify', itemKey: 'base' }] }) as never }), handlersWithSpeckit());
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
    expect(screen.getByTestId('speckit-running').textContent).toContain('2 de 4 etapas concluídas · 0 em andamento');
    expect(screen.queryByTestId('speckit-prepare')).toBeNull();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });



  it('says why a failed preparation stopped, and lets the owner try again', () => {
    renderView(wizard({ speckit: speckit({ status: 'failed', error: 'O plan não está instalado neste ambiente.' }) as never }), handlersWithSpeckit());
    expect(screen.getByRole('alert').textContent).toContain('não está instalado');
    expect(screen.queryByTestId('speckit-prepare')).toBeNull();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the technical detail of a failed preparation under its reason', () => {
    renderView(wizard({ speckit: speckit({ status: 'failed', error: 'O plan parou.', detail: 'specs/001-base/plan.md: AC-002' }) as never }), handlersWithSpeckit());
    expect(screen.getByTestId('speckit-failed-detail').textContent).toContain('specs/001-base/plan.md: AC-002');
  });

  it('marks the steps a resumed preparation reused from the run that failed', () => {
    const reused = { command: 'constitution', startedAt: '2026-10-25T10:00:00Z', endedAt: '2026-10-25T10:01:05Z', reused: true };
    renderView(wizard({ speckit: speckit({ status: 'running', total: 5, steps: [reused, { command: 'specify', itemKey: 'base' }] }) as never }), handlersWithSpeckit());
    const rows = [...screen.getByTestId('speckit-steps').querySelectorAll('li')];
    expect(rows[0]!.textContent).toContain('Reaproveitada');
    expect(rows[1]!.textContent).not.toContain('Reaproveitada');
  });


  it('shows the technical detail of a failed preparation under its reason, such as the stderr of a failed init', () => {
    const stderr = '╭─ Error ─╮\n│ No such option: --integration │\n╰─────────╯';
    renderView(wizard({ speckit: speckit({ status: 'failed', error: 'O plan não conseguiu preparar a pasta do projeto. Tente de novo.', detail: stderr }) as never }), handlersWithSpeckit());
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Detalhe técnico')).toBeTruthy();
    expect(alert.querySelector('pre')!.textContent).toBe(stderr);
  });

  it('keeps the start locked for an out-of-date preparation, and says why under the coverage, with no warning at the top', () => {
    renderView(wizard({ speckit: speckit({ stale: true }) as never }), handlersWithSpeckit());
    expect(screen.queryByTestId('speckit-stale')).toBeNull();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('start-missing').textContent).toContain('Os documentos mudaram: prepare os planos de novo.');
  });

  it('opens "Iniciar desenvolvimento" once the preparation is done and current', () => {
    const h = handlersWithSpeckit();
    renderView({ ...wizard({ speckit: speckit() as never }), specsApproved: true } as never, h);
    expect(screen.getByTestId('speckit-done')).toBeTruthy();
    const start = screen.getByTestId('start') as HTMLButtonElement;
    expect(start.textContent).toContain('Iniciar desenvolvimento');
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    expect(h.onStart).toHaveBeenCalledTimes(1);
  });

  it('keeps the start closed, with the reason beside it, until PO and SM approve the specs.md', () => {
    renderView(wizard({ speckit: speckit() as never, status: 'ready' }), handlersWithSpeckit());
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('start-missing').textContent).toContain('Preparando o specs.md');
  });

  it('keeps the start open while a closing check fails, with no alert, and asks the agents to resolve the failing checks only on the click', () => {
    const closing = { ok: false, summaryHash: 'h', repositories: [], assumptions: [], checks: [{ id: 'questions', ok: false, detail: 'o checklist do documento não está verde: po.scope-explicit' }] };
    const checklist = green(ALL).map((c) => (c.id === 'po.scope-explicit' ? { ...c, passed: false, detail: 'o plano traz tarefa fora dos documentos' } : c));
    const h = { ...handlersWithSpeckit(), onResolveClosing: vi.fn() };
    renderView({ ...wizard({ repositories: true, speckit: speckit() as never, checklist: checklist as never }), closing, specsApproved: true } as never, h);
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('closing-alert')).toBeNull();
    expect(h.onResolveClosing).not.toHaveBeenCalled();
    expect(screen.queryByTestId('final-resolve-run')).toBeNull();
  });

  it('shows the questions the plan asked, for the owner to answer, and keeps the start locked while one blocks', () => {
    const asked = { ...question(true), questionId: 'speckit-abc', origin: 'speckit', itemKey: 'base', text: 'Qual banco de dados?' };
    renderView(wizard({ status: 'answering', speckit: speckit() as never, questions: [asked as never] }), handlersWithSpeckit());
    expect(screen.getByText('Qual banco de dados?')).toBeTruthy();
    expect(screen.getByTestId('answer')).toBeTruthy();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a plan question that repeats a decided one shows what the owner decided, and the difference', () => {
    const decided = { ...question(true, 'answered'), questionId: 'speckit-old', origin: 'speckit', itemKey: 'base', text: 'Qual o prazo do link?', answer: '90 dias', answeredBy: null };
    const asked = { ...question(true), questionId: 'speckit-abc', origin: 'speckit', itemKey: 'base', text: 'Até quando o link vale?', distinctFrom: [{ questionId: 'speckit-old', difference: 'Vale até o fim do prazo de envio, não por noventa dias corridos.' }] };
    renderView(wizard({ speckit: speckit() as never, questions: [decided as never, asked as never] }), handlersWithSpeckit());
    const block = screen.getByTestId('distinct-from');
    expect(block.textContent).toContain('Por que não é a mesma pergunta');
    expect(block.textContent).toContain('Antes: Qual o prazo do link?');
    expect(block.textContent).toContain('Você respondeu: 90 dias');
    expect(block.textContent).toContain('Diferença: Vale até o fim do prazo de envio, não por noventa dias corridos.');
  });

  it('the dropped repeats are listed, and the owner can ask for one again', () => {
    const dropped = { questionId: 'speckit-b', role: 'po', text: 'Até quando o link vale?', cycle: 2, blocking: false, relatedAcIds: [], origin: 'speckit', command: 'specify', itemKey: 'base', matchedQuestionId: 'speckit-old', matchedText: 'Qual o prazo do link?', matchedAnswer: '90 dias' };
    const h = { ...handlersWithSpeckit(), onReask: vi.fn() };
    renderView(wizard({ speckit: speckit() as never, droppedQuestions: [dropped] as never }), h);
    expect((screen.getByTestId('dropped-repeats') as HTMLDetailsElement).textContent).toContain('Perguntas repetidas que não foram feitas de novo (1)');
    fireEvent.click(screen.getByTestId('reask-speckit-b'));
    expect(h.onReask).toHaveBeenCalledWith('speckit-b');
  });

  it('a plan question shows its item and its context, and drops the document checkbox', () => {
    const asked = { ...question(true), questionId: 'speckit-abc', origin: 'speckit', itemKey: 'base', context: 'Sem prazo, o link fica aberto.', text: 'Por quanto tempo vale o link?' };
    renderView(wizard({ speckit: speckit() as never, questions: [asked as never] }), handlersWithSpeckit());
    expect(screen.getByText('Sobre o item Base')).toBeTruthy();
    expect(screen.getByText('Sem prazo, o link fica aberto.')).toBeTruthy();
    expect(screen.getByText('Bloqueia o início do desenvolvimento até você responder.')).toBeTruthy();
    expect(screen.queryByTestId('docs-answered')).toBeNull();
  });


  it('Iniciar is primary only once the preparation is ready, and says what it waits for', () => {
    renderView(wizard({ speckit: undefined as never }), handlersWithSpeckit());
    expect((screen.getByTestId('start') as HTMLButtonElement).className).not.toContain('primary');
    expect(screen.getByTestId('start-missing').textContent).toContain('Prepare os planos antes de iniciar.');
  });

  it('the steps of a running preparation sit behind a closed list, and a finished step says Feito', () => {
    renderView(wizard({ speckit: speckit({ status: 'running', total: 3, steps: [{ command: 'constitution' }], running: [{ command: 'specify', itemKey: 'base' }] }) as never }), handlersWithSpeckit());
    expect((screen.getByTestId('speckit-log') as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByTestId('speckit-steps').textContent).toContain('Feito');
    expect(screen.getByTestId('start-missing').textContent).toContain('em andamento');
  });




  it('says the start waits for a blocking plan question, even when the preparation is done', () => {
    const asked = { ...question(true), questionId: 'speckit-xyz', origin: 'speckit', text: 'Qual banco de dados?' };
    renderView(wizard({ speckit: speckit() as never, questions: [asked as never] }), handlersWithSpeckit());
    expect(screen.getByTestId('speckit-waiting')).toBeTruthy();
    expect(screen.queryByTestId('speckit-done')).toBeNull();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('hides the plan question while the preparation runs, since the server refuses the answer then', () => {
    const asked = { ...question(false), questionId: 'speckit-xyz', origin: 'speckit', text: 'Qual banco de dados?' };
    renderView(wizard({ speckit: speckit({ status: 'running', steps: [], total: 3 }) as never, questions: [asked as never] }), handlersWithSpeckit());
    expect(screen.queryByText('Qual banco de dados?')).toBeNull();
  });

  it('shows only the locked start once the program has started', () => {
    renderView(wizard({ status: 'started', speckit: speckit() as never }), handlersWithSpeckit());
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps a new spec on the single-stage screen: no stage bar and no stage 2 button', () => {
    renderView(project({ mode: 'new-spec' }));
    expect(screen.queryByLabelText('Etapas do refinamento')).toBeNull();
    expect(screen.queryByTestId('plan-backlog')).toBeNull();
  });
});

describe('a question offers its choices as buttons', () => {
  const options = [
    { label: 'Citar as subseções', detail: 'O item cita 2.1, 2.2 e 2.3.' },
    { label: 'Citar a seção inteira', detail: 'O item cita 2 por inteiro.', recommended: true },
  ];

  it('fills the answer with the chosen option, and marks the recommended one', () => {
    renderView(project({ mode: 'new-spec', status: 'answering', questions: [{ ...question(false), options } as never] }));
    const second = screen.getByRole('radio', { name: /Citar a seção inteira/ });
    fireEvent.click(second);
    expect((screen.getByTestId('answer') as HTMLTextAreaElement).value).toBe('Citar a seção inteira');
    expect(second.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Recomendada')).toBeTruthy();
  });

  it('shows no choices for an open question', () => {
    renderView(project({ mode: 'new-spec', status: 'answering', questions: [question(false) as never] }));
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });
});

describe('the summary resolves the stage pending items with the agents', () => {
  const allDone = ['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md'];
  const summary = (over: Partial<Snapshot['state']>) => project({ stages: true, doneStages: allDone, graphed: allDone, ...over } as never);
  beforeEach(() => window.history.replaceState(null, '', '/?etapa=revisao'));

  it('asks the agents to review the outdated stages only when the owner clicks', () => {
    const h = { ...handlers(), onResolveClosing: vi.fn() };
    renderView(summary({ staleBy: { 'stack.md': 'briefing.md' } } as never), h);
    expect(h.onResolveClosing).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('final-resolve-run'));
    expect(h.onResolveClosing).toHaveBeenCalledTimes(1);
  });

  it('asks nothing when no stage has a pending item', () => {
    const h = { ...handlers(), onResolveClosing: vi.fn() };
    renderView(summary({}), h);
    expect(screen.queryByTestId('final-resolve')).toBeNull();
    expect(h.onResolveClosing).not.toHaveBeenCalled();
  });
});

describe('the stepper opens the steps', () => {
  const stageSteps = ['flow.md', 'project.md'];
  beforeEach(() => window.history.replaceState(null, '', '/?etapa=briefing.md'));

  it('opens a finished step with one click, and not a step after the first unfinished one', () => {
    renderView(project({ stages: true, doneStages: stageSteps } as never));
    fireEvent.click(screen.getByTestId('step-flow.md'));
    expect(window.location.search).toContain('etapa=flow.md');
    fireEvent.click(screen.getByTestId('step-design.md'));
    expect(window.location.search).toContain('etapa=flow.md');
  });
});

describe('the wizard Continuar names why it is closed', () => {
  beforeEach(() => window.history.replaceState(null, '', '/?etapa=flow.md'));

  it('is disabled with the reason beside it while a suggestion is open, in a repository session', () => {
    const patch = { patchId: 'p1', role: 'po', file: 'flow.md', find: 'a', replace: 'b', reason: 'r', diff: '', cycle: 1, status: 'pending', decision: null };
    renderView(project({ stages: true, repositories: true, doneStages: [], reviewedStages: ['flow.md'], patches: [patch] } as never));
    expect((screen.getByTestId('wizard-continue') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('wizard-continue-reason').textContent).toContain('sugestões');
  });

  it('stays open in a session with no repository flow', () => {
    renderView(project({ stages: true, doneStages: [] } as never));
    expect((screen.getByTestId('wizard-continue') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('wizard-continue-reason')).toBeNull();
  });
});

describe('a stage question during the review', () => {
  const asked = { ...question(true), questionId: 'po-s1-0', file: 'flow.md', text: 'Quem usa o fluxo?' };
  beforeEach(() => window.history.replaceState(null, '', '/?etapa=flow.md'));

  it('stays on screen and can be answered while the agents review the stage', () => {
    const evaluation = { startedAt: '2026-11-03T10:00:00Z', endedAt: null };
    const h = renderView(project({ stages: true, status: 'evaluating', evaluation, questions: [asked as never] } as never));
    expect(screen.getByText('Quem usa o fluxo?')).toBeTruthy();
    fireEvent.change(screen.getByTestId('answer'), { target: { value: 'Clientes' } });
    fireEvent.click(screen.getByTestId('answer-po-s1-0'));
    expect(h.onAnswer).toHaveBeenCalledWith('po-s1-0', 'Clientes', false);
  });
});

describe('the summary says what the agents did on their own', () => {
  const done = ['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md'];
  const patch = (id: string, auto: boolean) => ({ patchId: id, role: 'po', file: 'flow.md', find: 'a', replace: 'b', reason: 'r', diff: '', cycle: 1, status: 'accepted', decision: null, ...(auto ? { auto: true } : {}) });
  beforeEach(() => window.history.replaceState(null, '', '/?etapa=revisao'));

  it('counts the suggestions the agents accepted alone, and not the ones the owner accepted', () => {
    renderView(project({ stages: true, doneStages: done, graphed: done, patches: [patch('a', true), patch('b', true), patch('c', false)] } as never));
    expect(screen.getByTestId('final-auto-applied').textContent).toContain('2 sugestões');
  });

  it('says nothing when the agents applied none', () => {
    renderView(project({ stages: true, doneStages: done, graphed: done, patches: [patch('c', false)] } as never));
    expect(screen.queryByTestId('final-auto-applied')).toBeNull();
  });
});

describe('the stage review panel while the agents work', () => {
  beforeEach(() => window.history.replaceState(null, '', '/?etapa=flow.md'));

  it('counts the time of the running review next to its notice', () => {
    const startedAt = new Date(Date.now() - 65_000).toISOString();
    renderView(project({ stages: true, status: 'evaluating', evaluation: { startedAt, endedAt: null } } as never));
    expect(screen.getByTestId('refinement-stage-locked').textContent).toMatch(/Avaliação em andamento · 01:0\d/);
  });
});

describe('a document scored below the pass line', () => {
  const score = (value: number) => ({ score: value, checks: { complete: value, concrete: value, consistent: value, scoped: value }, doubts: [] });
  beforeEach(() => window.history.replaceState(null, '', '/?etapa=flow.md'));

  it('says the score and asks the owner to continue anyway, and sends the confirmation', () => {
    const h = { ...handlers(), onContinueStage: vi.fn() };
    renderView(project({ stages: true, readiness: { docs: { 'flow.md': score(0.42) } } } as never), h);
    expect(screen.getByTestId('wizard-low-score').textContent).toContain('42%');
    const button = screen.getByTestId('wizard-continue');
    expect(button.textContent).toContain('Continuar mesmo assim');
    fireEvent.click(button);
    expect(h.onContinueStage).toHaveBeenCalledWith('flow.md', true);
  });

  it('shows nothing special for a good score', () => {
    renderView(project({ stages: true, readiness: { docs: { 'flow.md': score(0.9) } } } as never));
    expect(screen.queryByTestId('wizard-low-score')).toBeNull();
    expect(screen.getByTestId('wizard-continue').textContent).toBe('Continuar');
  });
});

describe('several questions of a stage on screen', () => {
  const first = { ...question(false), questionId: 'po-s1-0', file: 'flow.md', text: 'Quem usa o fluxo?' };
  const second = { ...question(false), questionId: 'po-s1-1', file: 'flow.md', text: 'Qual o prazo?' };
  beforeEach(() => window.history.replaceState(null, '', '/?etapa=flow.md'));

  it('lists them all, and each keeps its own answer', () => {
    const h = renderView(project({ stages: true, questions: [first as never, second as never] } as never));
    expect(screen.getByText('Quem usa o fluxo?')).toBeTruthy();
    expect(screen.getByText('Qual o prazo?')).toBeTruthy();
    const boxes = screen.getAllByTestId('answer') as HTMLTextAreaElement[];
    expect(boxes).toHaveLength(2);
    fireEvent.change(boxes[1]!, { target: { value: '30 dias' } });
    expect(boxes[0]!.value).toBe('');
    fireEvent.click(screen.getByTestId('answer-po-s1-1'));
    expect(h.onAnswer).toHaveBeenCalledWith('po-s1-1', '30 dias', false);
    expect((screen.getByTestId('answer-po-s1-0') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('specs.md starts only when the owner clicks', () => {
  beforeEach(() => window.history.replaceState(null, '', '/?etapa=backlog'));
  const detailed = { enabled: true, detail: true, epics: [], items: [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S', rank: 1 }], specs: {}, preplans: { base: { preplan: { tasks: [] } } }, flowHeadings: [] };
  const snapOf = (over: Record<string, unknown>) => project({ stages: true, backlog: detailed as never, status: 'ready', ...over } as never);

  it('calls no agent when the step opens, and only Preparar backlog starts the work', () => {
    const h = { ...handlers(), onCheckSpecs: vi.fn() };
    renderView(snapOf({}), h);
    expect(h.onCheckSpecs).not.toHaveBeenCalled();
    expect(screen.queryByTestId('specs-check-retry')).toBeNull();
    expect(screen.getByTestId('prepare-backlog').textContent).toContain('Preparar backlog');
  });

  it('calls no agent for a text a reviewer rejected either', () => {
    const h = { ...handlers(), onCheckSpecs: vi.fn() };
    const rejected = { specsHash: 'h', verdict: 'rejected', findings: ['x'], reason: null, at: null };
    renderView(snapOf({ specsMd: { hash: 'h', bytes: 1 }, specsReview: { po: rejected } }), h);
    expect(h.onCheckSpecs).not.toHaveBeenCalled();
    expect(screen.queryByTestId('specs-check-retry')).toBeNull();
  });
});
describe('the questions the team asked about specs.md', () => {
  beforeEach(() => window.history.replaceState(null, '', '/?etapa=backlog'));
  const detailed = { enabled: true, detail: true, epics: [], items: [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S', rank: 1 }], specs: {}, preplans: { base: { preplan: { tasks: [] } } }, flowHeadings: [] };
  const asked = { ...question(true), questionId: 'specs-1-0', origin: 'specs', text: 'Qual seção justifica o item base?', options: [{ label: 'Objetivos', detail: 'Usa os objetivos do briefing.', recommended: true }, { label: 'Requisitos', detail: 'Usa os requisitos do projeto.' }] };
  const rejected = { specsHash: 'h', verdict: 'rejected', findings: ['x'], reason: null, at: null };
  const snap = () => project({ stages: true, status: 'answering', backlog: detailed as never, specsMd: { hash: 'h', bytes: 1 }, specsReview: { po: rejected }, specsRepairs: 2, specsAsked: 'h', questions: [asked as never] } as never);

  it('shows the question on the backlog step, with the recommended choice already marked, and sends it with one click', () => {
    const h = { ...handlers(), onCheckSpecs: vi.fn() };
    renderView(snap(), h);
    expect(screen.getByTestId('specs-questions-intro')).toBeTruthy();
    expect(screen.getByText('Qual seção justifica o item base?')).toBeTruthy();
    expect(screen.getByTestId('option-group-option-objetivos').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('answer-specs-1-0'));
    expect(h.onAnswer).toHaveBeenCalledWith('specs-1-0', 'Objetivos', false);
  });

  it('keeps the start closed with the reason beside it, and shows the question nowhere else', () => {
    renderView(snap());
    expect(screen.getByTestId('start-missing').textContent).toContain('Responda a pergunta obrigatória em aberto');
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('a question the owner cannot answer yet', () => {
  beforeEach(() => window.history.replaceState(null, '', '/?etapa=backlog'));
  const detailed = { enabled: true, detail: true, epics: [], items: [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S', rank: 1 }], specs: {}, preplans: { base: { preplan: { tasks: [] } } }, flowHeadings: [] };
  const asked = { ...question(true), questionId: 'specs-1-0', origin: 'specs', text: 'Qual seção justifica o item base?', options: [{ label: 'Objetivos', detail: 'Usa os objetivos.', recommended: true }, { label: 'Requisitos', detail: 'Usa os requisitos.' }] };
  const snap = (over: Record<string, unknown>) => project({ stages: true, backlog: detailed as never, specsMd: { hash: 'h', bytes: 1 }, questions: [asked as never], ...over } as never);

  it('says why while the team works, locks the choices and the button, and shows no note when free', () => {
    const first = render(<MemoryRouter><RefinementView snap={snap({ status: 'evaluating' })} busy events={[]} {...handlers()} /></MemoryRouter>);
    expect(screen.getByTestId('question-waiting').textContent).toContain('libera sozinha');
    expect((screen.getByTestId('answer-specs-1-0') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('option-group-option-objetivos') as HTMLButtonElement).disabled).toBe(true);
    first.unmount();
    render(<MemoryRouter><RefinementView snap={snap({ status: 'answering' })} busy={false} events={[]} {...handlers()} /></MemoryRouter>);
    expect(screen.queryByTestId('question-waiting')).toBeNull();
    expect((screen.getByTestId('answer-specs-1-0') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('what the start waits for', () => {
  beforeEach(() => window.history.replaceState(null, '', '/?etapa=backlog'));
  const detailed = { enabled: true, detail: true, epics: [], items: [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S', rank: 1 }], specs: {}, preplans: { base: { preplan: { tasks: [] } } }, flowHeadings: [] };

  it('lists every missing thing in yellow, in plain words, beside the closed button', () => {
    const failing = [{ id: 'sm.no-open-questions', role: 'sm', passed: false, detail: '1 pergunta obrigatória em aberto' }];
    const open = { ...question(true), questionId: 'po-c1-0' };
    renderView(project({ stages: true, backlog: detailed as never, status: 'answering', checklist: failing as never, questions: [open as never] } as never));
    const text = screen.getByTestId('start-missing').textContent ?? '';
    expect(text).toContain('Falta para iniciar o desenvolvimento');
    expect(text).toContain('Responda a pergunta obrigatória em aberto.');
    expect(text).toContain('Prepare os planos antes de iniciar.');
    expect(screen.getByTestId('start-missing').className).toContain('text-warn');
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('names what the backlog lacks when it is not ready and nothing else blocks it', () => {
    const failing = [{ id: 'po.scope-explicit', role: 'po', passed: false, detail: 'o escopo não está explícito' }];
    renderView(project({ stages: true, backlog: detailed as never, status: 'drafting', checklist: failing as never } as never));
    expect(screen.getByTestId('start-missing').textContent).toContain('O backlog ainda não está pronto: o escopo não está explícito.');
  });

  it('says nothing once everything is ready and the button is open', () => {
    renderView({ ...project({ stages: true, backlog: detailed as never, status: 'ready', speckit: { status: 'done', steps: [], stale: false } as never } as never), specsApproved: true } as never);
    expect(screen.queryByTestId('start-missing')).toBeNull();
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('the button that lets the team resolve everything', () => {
  beforeEach(() => window.history.replaceState(null, '', '/?etapa=backlog'));
  const detailed = { enabled: true, detail: true, epics: [], items: [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S', rank: 1 }], specs: {}, preplans: { base: { preplan: { tasks: [] } } }, flowHeadings: [] };

  it('sits beside the yellow list, asks for one confirmation, and then calls the team', () => {
    const h = { ...handlers(), onResolveAll: vi.fn() };
    renderView(project({ stages: true, backlog: detailed as never, status: 'drafting' } as never), h);
    fireEvent.click(screen.getByTestId('prepare-backlog'));
    expect(h.onResolveAll).not.toHaveBeenCalled();
    expect(screen.getByText(/O time revisa os documentos/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('stage-confirm'));
    expect(h.onResolveAll).toHaveBeenCalledTimes(1);
  });

  it('shows the spinner from the click, and the yellow list sits at the top of the step in the notice pattern', async () => {
    const h = { ...handlers(), onResolveAll: vi.fn() };
    renderView(project({ stages: true, backlog: detailed as never, status: 'drafting' } as never), h);
    const missing = screen.getByTestId('start-missing');
    expect(missing.className).toContain('bg-warn-soft');
    expect(screen.getByTestId('refinement-backlog-heading').nextElementSibling).toBe(screen.getByTestId('step-card-needs'));
    expect(screen.getByTestId('step-card-needs').querySelector('summary + div')?.firstElementChild).toBe(missing);
    fireEvent.click(screen.getByTestId('prepare-backlog'));
    fireEvent.click(screen.getByTestId('stage-confirm'));
    const button = screen.getByTestId('prepare-backlog') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Preparando');
  });

  it('is not offered when nothing keeps the start closed', () => {
    const h = { ...handlers(), onResolveAll: vi.fn() };
    renderView({ ...project({ stages: true, backlog: detailed as never, status: 'ready', speckit: { status: 'done', steps: [], stale: false } as never } as never), specsApproved: true } as never, h);
    expect(screen.queryByTestId('start-missing')).toBeNull();
  });
});

