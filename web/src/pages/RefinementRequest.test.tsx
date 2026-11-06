import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../api.js';
import { RefinementView } from './Refinement.js';

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => window.history.replaceState(null, '', '/'));

const check = (id: string, passed: boolean) => ({ id, role: (id.startsWith('po') ? 'po' : 'sm') as 'po' | 'sm', passed, detail: passed ? 'ok' : 'falhou' });
const backlogItem = { key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S', rank: 1 };
const backlog = { enabled: true, detail: true, epics: [], items: [backlogItem], specs: {}, preplans: { base: { preplan: { tasks: [] } } }, flowHeadings: [] };
const patch = { patchId: 'po-c1-0', role: 'po', file: 'briefing.md', find: 'a', replace: 'b', scopeChange: true, reason: 'r', diff: '', cycle: 1, status: 'pending' };

/** A follow-on request of a project in development, with the checks green unless the state says otherwise. */
const request = (over: Record<string, unknown> = {}): Snapshot => ({
  projectId: 'live-skill',
  specId: 'live-skill-pedido-1',
  docs: { 'project.md': '# Projeto', 'briefing.md': '## Objectives', 'stack.md': '# Stack', 'flow.md': '# Flow', 'design.md': '# Design' },
  secrets: [],
  tokens: { inputTokens: 10, outputTokens: 5, costUsd: 0.02, steps: 3 },
  state: {
    status: 'answering',
    stale: false,
    cycle: 1,
    mode: 'backlog',
    stages: true,
    derived: null,
    checklist: [check('po.no-contradictions', true), check('sm.tasks-feasible', true)],
    questions: [],
    patches: [],
    discarded: [],
    error: null,
    runId: null,
    backlog,
    extension: { requestId: 'pedido-1', title: 'Hello', text: 'fazer um serviço hello', at: '2026-11-05T00:00:00.000Z', before: [] },
    ...over,
  } as never,
});

const renderView = (snap: Snapshot) =>
  render(<MemoryRouter><RefinementView snap={snap} busy={false} events={[]} onSaveDoc={vi.fn()} onEvaluate={vi.fn()} onAnswer={vi.fn()} onSkip={vi.fn()} onAccept={vi.fn()} onReject={vi.fn()} onSecret={vi.fn()} onStart={vi.fn()} /></MemoryRouter>);

describe('the request screen keeps only what the owner needs in view', () => {
  it('shows the request and the start button, with the team details collapsed', () => {
    renderView(request());
    expect(screen.getByTestId('request-text').textContent).toBe('fazer um serviço hello');
    expect(screen.getByTestId('start')).toBeTruthy();
    const details = screen.getByTestId('request-details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    for (const id of ['impact', 'replan', 'backlog', 'plans', 'checks']) expect(details.contains(screen.getByTestId(`step-card-${id}`))).toBe(true);
  });

  it('keeps "Precisa de você" inside the details while nothing waits for the owner', () => {
    renderView(request());
    expect((screen.getByTestId('request-details') as HTMLDetailsElement).contains(screen.getByTestId('step-card-needs'))).toBe(true);
  });

  it('lifts "Precisa de você" out of the details, right under the status head, when something waits for the owner', () => {
    renderView(request({ patches: [patch] }));
    const needs = screen.getByTestId('step-card-needs');
    expect((screen.getByTestId('request-details') as HTMLDetailsElement).contains(needs)).toBe(false);
    expect(screen.getByTestId('request-ready').compareDocumentPosition(needs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps "Precisa de você" out of sight while the team works on its own, even with items open and the server idle', () => {
    renderView(request({ patches: [patch], autopilot: { status: 'running', reasons: [] } }));
    expect((screen.getByTestId('request-details') as HTMLDetailsElement).contains(screen.getByTestId('step-card-needs'))).toBe(true);
    expect(screen.getByTestId('request-ready').getAttribute('data-tone')).toBe('working');
  });

  it('shows "Precisa de você" in front, with the reason, only after the team stopped with something left', () => {
    renderView(request({ patches: [patch], autopilot: { status: 'stopped', reasons: ['1 sugestão muda o escopo e espera a sua decisão.'] } }));
    expect((screen.getByTestId('request-details') as HTMLDetailsElement).contains(screen.getByTestId('step-card-needs'))).toBe(false);
    expect(screen.getByTestId('request-status-text').textContent).toContain('O time não conseguiu decidir sozinho: 1 sugestão muda o escopo');
  });

  it('shows nothing in front when the team stopped with nothing left', () => {
    renderView(request({ autopilot: { status: 'stopped', reasons: [] } }));
    expect((screen.getByTestId('request-details') as HTMLDetailsElement).contains(screen.getByTestId('step-card-needs'))).toBe(true);
  });

  it('says why the team stopped with nothing to decide, and offers to run it again in place of the start button', () => {
    const onResolveAll = vi.fn();
    render(<MemoryRouter><RefinementView snap={request({ autopilot: { status: 'stopped', reasons: ['A sessão do Claude expirou.'] } })} busy={false} events={[]} onSaveDoc={vi.fn()} onEvaluate={vi.fn()} onAnswer={vi.fn()} onSkip={vi.fn()} onAccept={vi.fn()} onReject={vi.fn()} onSecret={vi.fn()} onStart={vi.fn()} onResolveAll={onResolveAll} /></MemoryRouter>);
    expect(screen.getByTestId('request-ready').getAttribute('data-tone')).toBe('needs');
    expect(screen.getByTestId('request-status-text').textContent).toContain('A sessão do Claude expirou.');
    expect(screen.queryByTestId('start')).toBeNull();
    fireEvent.click(screen.getByTestId('team-retry'));
    expect(onResolveAll).toHaveBeenCalled();
  });

  describe('the owner takes the suggestions one by one or all at once', () => {
    const stopped = { status: 'stopped', reasons: ['1 sugestão muda o escopo e espera a sua decisão.'] };
    const renderWith = (snap: Snapshot, onAcceptAll = vi.fn()) => {
      render(<MemoryRouter><RefinementView snap={snap} busy={false} events={[]} onSaveDoc={vi.fn()} onEvaluate={vi.fn()} onAnswer={vi.fn()} onSkip={vi.fn()} onAccept={vi.fn()} onReject={vi.fn()} onSecret={vi.fn()} onStart={vi.fn()} onAcceptAll={onAcceptAll} /></MemoryRouter>);
      return onAcceptAll;
    };

    it('offers to accept all, with how many, next to the way to decide one by one', () => {
      renderWith(request({ patches: [patch, { ...patch, patchId: 'po-c1-1' }], autopilot: stopped }));
      expect(screen.getByTestId('accept-all').textContent).toContain('Aceitar todas (2)');
      expect(screen.getByTestId('pending-toggle')).toBeTruthy();
    });

    it('asks the agents to run again once, when the owner accepts all', () => {
      const onAcceptAll = renderWith(request({ patches: [patch], autopilot: stopped }));
      fireEvent.click(screen.getByTestId('accept-all'));
      expect(onAcceptAll).toHaveBeenCalledTimes(1);
    });

    it('says what accepting all does, so the owner knows the agents review again', () => {
      renderWith(request({ patches: [patch], autopilot: stopped }));
      expect(screen.getByTestId('accept-all-note').textContent).toContain('os agentes revisam de novo');
    });

    it('offers nothing when no suggestion waits', () => {
      renderWith(request({ autopilot: stopped }));
      expect(screen.queryByTestId('accept-all')).toBeNull();
    });
  });

  it('says the request waits in the queue while the agents work on an earlier one', () => {
    renderView(request({ autopilot: { status: 'queued', reasons: ['Há agentes trabalhando no pedido anterior.'] } }));
    expect(screen.getByTestId('request-ready').getAttribute('data-tone')).toBe('working');
    expect(screen.getByTestId('request-status-text').textContent).toContain('Há agentes trabalhando no pedido anterior.');
  });

  it('says in the head what the owner should do: wait, decide, or start', () => {
    renderView(request({ patches: [patch] }));
    expect(screen.getByTestId('request-ready').getAttribute('data-tone')).toBe('needs');
    expect(screen.getByRole('heading', { name: /decisão espera você|decisões esperam você|sugest/ })).toBeTruthy();
  });

  it('opens the details before scrolling to a step of the stepper', () => {
    renderView(request());
    fireEvent.click(screen.getByTestId('stepper-label-impacto'));
    expect((screen.getByTestId('request-details') as HTMLDetailsElement).open).toBe(true);
  });

  it('says how many checks failed on the Verificação chip, not just "Pendente"', () => {
    renderView(request({ checklist: [check('po.no-contradictions', false), check('sm.tasks-feasible', false), check('sm.constraints-clear', true)] }));
    expect(screen.getByTestId('step-card-chip-checks').textContent).toBe('2 itens falharam');
  });
});

describe('an address with ?etapa= opens that document of the request', () => {
  it('opens briefing.md inside the request, with a way back', () => {
    window.history.replaceState(null, '', '/?etapa=briefing.md');
    renderView(request());
    expect(screen.getByTestId('request-document')).toBeTruthy();
    expect(screen.queryByTestId('request-screen')).toBeNull();
  });

  it('shows the pending suggestions of that document so the owner can accept one', () => {
    window.history.replaceState(null, '', '/?etapa=briefing.md');
    renderView(request({ patches: [patch] }));
    expect(screen.getByTestId('accept-po-c1-0')).toBeTruthy();
  });

  it('opens the request screen when the address names no step', () => {
    renderView(request());
    expect(screen.getByTestId('request-screen')).toBeTruthy();
    expect(screen.queryByTestId('request-document')).toBeNull();
  });
});
