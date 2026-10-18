import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BacklogView } from '../api.js';
import { BacklogPanel, DetailSpecsButton } from './BacklogPanel.js';

const item = (key: string, over: Partial<BacklogView['items'][number]> = {}) => ({
  key, title: `Spec ${key}`, epic: 'core', scope: `Escopo de ${key}`, priority: 'P1' as const, rationale: `Por que ${key}`, dependsOn: [], sources: [{ doc: 'flow.md', heading: '7. OPME' }], size: 'M' as const, rank: 1, ...over,
});
const view = (items: BacklogView['items'], epics = [{ key: 'core', title: 'Núcleo' }, { key: 'fin', title: 'Financeiro' }]): BacklogView => ({ enabled: true, project: null, epics, items, cycle: 1 });

describe('BacklogPanel', () => {
  it('offers to break the docs into a backlog while it is off, and holds the button while locked', () => {
    const onEnable = vi.fn();
    const { rerender } = render(<BacklogPanel backlog={null} evaluating={false} locked={false} onEnable={onEnable} />);
    fireEvent.click(screen.getByTestId('enable-backlog'));
    expect(onEnable).toHaveBeenCalledOnce();
    rerender(<BacklogPanel backlog={null} evaluating={false} locked onEnable={onEnable} />);
    expect((screen.getByTestId('enable-backlog') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders nothing when it is off and there is no way to turn it on', () => {
    const { container } = render(<BacklogPanel backlog={undefined} evaluating={false} locked={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('says when the backlog will appear', () => {
    const { rerender } = render(<BacklogPanel backlog={view([])} evaluating={false} locked={false} />);
    expect(screen.getByText(/depois da próxima avaliação/)).toBeTruthy();
    rerender(<BacklogPanel backlog={view([])} evaluating locked />);
    expect(screen.getByTestId('backlog-processing').textContent).toContain('Processando o backlog. Montando a lista de specs');
  });

  it('says it is the backlog that is processing, and how far the detail is', () => {
    const items = [item('base'), item('casos', { rank: 2 })];
    const { rerender } = render(<BacklogPanel backlog={view(items)} evaluating={false} locked={false} />);
    expect(screen.queryByTestId('backlog-processing')).toBeNull();
    rerender(<BacklogPanel backlog={view(items)} evaluating locked />);
    expect(screen.getByTestId('backlog-processing').textContent).toContain('Atualizando a lista de specs');
    rerender(<BacklogPanel backlog={{ ...view(items), detail: true }} evaluating locked />);
    expect(screen.getByTestId('backlog-processing').textContent).toContain('0 de 2 prontos');
  });


  it('groups the items by epic in rank order with priority, size, dependencies and sources', () => {
    const items = [
      item('casos', { rank: 2, dependsOn: ['base'], priority: 'P1', size: 'L' }),
      item('base', { rank: 1, priority: 'P0', size: 'S' }),
      item('cobranca', { epic: 'fin', rank: 3, priority: 'P2' }),
    ];
    render(<BacklogPanel backlog={view(items)} evaluating={false} locked={false} />);
    expect(screen.getByText(/3 specs/)).toBeTruthy();
    const core = within(screen.getByTestId('epic-core'));
    expect(core.getAllByTestId(/^item-/).map((li) => li.getAttribute('data-testid'))).toEqual(['item-base', 'item-casos']);
    expect(within(screen.getByTestId('item-base')).getByText('P0')).toBeTruthy();
    expect(within(screen.getByTestId('item-casos')).getByText(/Depende de: Spec base/)).toBeTruthy();
    expect(within(screen.getByTestId('item-casos')).getByText(/flow\.md › 7\. OPME/)).toBeTruthy();
    expect(within(screen.getByTestId('epic-fin')).getByText('Spec cobranca')).toBeTruthy();
  });

  it('skips an epic that has no item', () => {
    render(<BacklogPanel backlog={view([item('base')])} evaluating={false} locked={false} />);
    expect(screen.queryByTestId('epic-fin')).toBeNull();
  });
});

describe('BacklogPanel detailing', () => {
  const REV = `sha256:${'2'.repeat(64)}`;
  const items = [item('base', { rank: 1 }), item('casos', { rank: 2 }), item('cobranca', { epic: 'fin', rank: 3 })];

  it('offers Detalhar specs once the outline is ready, with the expected number of agent calls', () => {
    const onDetail = vi.fn();
    const { rerender } = render(<DetailSpecsButton backlog={view(items)} locked={false} ready={false} onDetail={onDetail} />);
    expect((screen.getByTestId('detail-specs') as HTMLButtonElement).disabled).toBe(true);
    rerender(<DetailSpecsButton backlog={view(items)} locked={false} ready onDetail={onDetail} />);
    const button = screen.getByTestId('detail-specs') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    // Two epics: one call each for the specs and for the pre-plans, then the Front, PO and SM reviews.
    expect(button.textContent).toMatch(/~7 chamadas/);
    fireEvent.click(button);
    expect(onDetail).toHaveBeenCalledOnce();
  });

  it('marks each item planned, in refinement or failed once detailed, and no longer offers the button', () => {
    const spec = { specId: 'p-base', type: 'feature', objectives: ['o'], features: [], acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w', then: 't', smoke: true }], outOfScope: [], externalDependencies: [] };
    const preplan = { specId: 'p-base', specRev: REV, inputHash: 'h', modules: [{ name: 'm', purpose: 'p' }], tasks: [{ id: 'P1', title: 't', module: 'm', owner: 'dev', criteriaRefs: ['AC-001'], dependsOn: [] }], risks: [] };
    const detailed = {
      ...view(items), detail: true,
      specs: { base: { inputHash: 'h', specId: 'p-base', rev: REV, spec, issues: [], cycle: 2 }, casos: { inputHash: 'h', specId: 'p-casos', rev: null, spec: null, issues: ['schema'], cycle: 2 } },
      preplans: { base: { inputHash: 'h', specRev: REV, preplan, issues: [], cycle: 2 } },
    } as BacklogView;
    render(<BacklogPanel backlog={detailed} evaluating={false} locked={false} />);
    expect(screen.queryByTestId('detail-specs')).toBeNull();
    expect(within(screen.getByTestId('item-base')).getByText('planejada')).toBeTruthy();
    expect(within(screen.getByTestId('item-casos')).getByText('erro')).toBeTruthy();
    expect(within(screen.getByTestId('item-cobranca')).getByText('em refinamento')).toBeTruthy();
  });

  // Plan 77 review: a delivered item is kept as main has it, so the panel says so instead of "em refinamento".
  it('marks an item whose spec was delivered or is running', () => {
    const spec = (status: string) => ({ specId: 'p', type: 'feature', objectives: ['o'], features: [], acceptanceCriteria: [], outOfScope: [], externalDependencies: [], status });
    const detailed = {
      ...view(items), detail: true,
      specs: { base: { inputHash: 'h', specId: 'p-base', rev: REV, spec: spec('done'), issues: [], cycle: 2 }, casos: { inputHash: 'h', specId: 'p-casos', rev: REV, spec: spec('running'), issues: [], cycle: 2 } },
    } as BacklogView;
    render(<BacklogPanel backlog={detailed} evaluating={false} locked={false} />);
    expect(within(screen.getByTestId('item-base')).getByText('entregue')).toBeTruthy();
    expect(within(screen.getByTestId('item-casos')).getByText('em execução')).toBeTruthy();
  });

  it('renders no Detalhar specs once the specs are detailed', () => {
    render(<DetailSpecsButton backlog={{ ...view(items), detail: true }} locked={false} ready onDetail={vi.fn()} />);
    expect(screen.queryByTestId('detail-specs')).toBeNull();
  });

  it('leaves Detalhar specs to the review panel, so the backlog list never renders it', () => {
    render(<BacklogPanel backlog={view(items)} evaluating={false} locked={false} />);
    expect(screen.queryByTestId('detail-specs')).toBeNull();
  });
});
