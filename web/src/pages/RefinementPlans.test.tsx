import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../api.js';
import { RefinementView } from './Refinement.js';

// Outside the wizard, an imported backlog, a new spec and a continued spec prepare with the plan as stage 7 does.
const ALL = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions'];
const checklist = ALL.map((id) => ({ id, role: id.slice(0, 2), passed: true, detail: 'ok' }));
const spec = { specId: 'hello-001', type: 'feature', objectives: ['Listar os pedidos'], features: [], outOfScope: [], acceptanceCriteria: [], externalDependencies: [] };
const item = { key: 'base', title: 'Fundação', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S', rank: 1 };
const detailed = {
  enabled: true, project: null, epics: [], cycle: 1, detail: true, flowHeadings: [], items: [item],
  specs: { base: { inputHash: 'h', specId: 'base', rev: 'r', spec: { ...spec, specId: 'base' }, issues: [], cycle: 1 } },
  preplans: { base: { inputHash: 'h', specRev: 'r', preplan: { tasks: [] }, issues: [], cycle: 1 } },
};

/** A ready session of the shop project, a single spec unless the state says otherwise. */
const session = (over: Record<string, unknown>): Snapshot => ({
  projectId: 'shop',
  specId: 'hello-001',
  docs: { 'project.md': '# Loja', 'briefing.md': '## Objectives', 'stack.md': '# Stack', 'flow.md': '# Fluxo', 'design.md': '# Design' },
  secrets: [],
  tokens: { inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 },
  state: { status: 'ready', stale: false, cycle: 1, derived: { spec, project: {} }, checklist, questions: [], patches: [], moves: [], reshapes: [], discarded: [], error: null, runId: null, ...over } as never,
});
const handlers = () => ({ onSaveDoc: vi.fn(), onEvaluate: vi.fn(), onAnswer: vi.fn(), onSkip: vi.fn(), onAccept: vi.fn(), onReject: vi.fn(), onSecret: vi.fn(), onStart: vi.fn(), onPreparePlans: vi.fn() });
const renderView = (snap: Snapshot, h = handlers()) => {
  render(<MemoryRouter><RefinementView snap={snap} busy={false} events={[]} {...h} /></MemoryRouter>);
  return h;
};
const reviewPanel = () => screen.getByRole('heading', { name: 'Área de revisão' }).closest('section') as HTMLElement;
const follows = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('the plan box and its button outside the wizard', () => {
  it.each([
    ['an imported backlog', { mode: 'backlog', backlog: detailed, derived: null }],
    ['a new spec', { mode: 'new-spec' }],
    ['a continued spec', { mode: 'continue' }],
  ])('%s shows them in the review panel, between Reavaliar and the start, and the start waits for the preparation', (_name, over) => {
    const h = renderView(session(over));
    const panel = reviewPanel();
    const box = within(panel).getByTestId('speckit-idle');
    const prepare = within(panel).getByTestId('speckit-prepare') as HTMLButtonElement;
    const start = within(panel).getByTestId('start') as HTMLButtonElement;
    expect(follows(within(panel).getByTestId('evaluate'), box)).toBe(true);
    expect(follows(box, prepare)).toBe(true);
    expect(follows(prepare, start)).toBe(true);
    expect(prepare.textContent).toContain('Preparar os planos');
    expect(start.disabled).toBe(true);
    expect(within(panel).getByText(/Prepare os planos antes de iniciar\./)).toBeTruthy();
    fireEvent.click(prepare);
    expect(h.onPreparePlans).toHaveBeenCalledTimes(1);
  });

  it('offers to prepare again once the preparation is done, and opens the start', () => {
    renderView(session({ mode: 'new-spec', speckit: { status: 'done', steps: [], stale: false } }));
    expect(screen.getByTestId('speckit-done')).toBeTruthy();
    expect(screen.getByTestId('speckit-prepare').textContent).toContain('Preparar de novo');
    expect((screen.getByTestId('start') as HTMLButtonElement).disabled).toBe(false);
  });


  it('keeps the button off until the spec is derived, and says why', () => {
    renderView(session({ mode: 'new-spec', status: 'drafting', cycle: 0, derived: null }));
    const prepare = screen.getByTestId('speckit-prepare') as HTMLButtonElement;
    expect(prepare.disabled).toBe(true);
    expect(prepare.title).toBe('Avalie a spec antes de preparar');
  });
});
