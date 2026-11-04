import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BacklogView } from '../api.js';
import { SpecTree } from './SpecTree.js';

const REV = `sha256:${'2'.repeat(64)}`;
const ac = (id: string, given: string) => ({ id, given, when: 'abre o caso', then: 'o caso existe', smoke: id === 'AC-001' });
const backlog = {
  enabled: true, project: null, epics: [{ key: 'core', title: 'Núcleo' }], cycle: 2, detail: true, flowHeadings: ['1. Caso', '9. Faturamento'],
  items: [{ key: 'caso', title: 'Abertura de caso', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'flow.md', heading: '1. Caso' }], size: 'M', rank: 1 }],
  specs: { caso: { inputHash: 'h', specId: 'k-caso', rev: REV, issues: [], cycle: 2, spec: { specId: 'k-caso', type: 'feature', objectives: ['o'], features: [], acceptanceCriteria: [ac('AC-001', 'um paciente'), ac('AC-002', 'um médico')], outOfScope: [], externalDependencies: [] } } },
  preplans: { caso: { inputHash: 'h', specRev: REV, issues: [], cycle: 2, preplan: { specId: 'k-caso', specRev: REV, inputHash: 'h', modules: [{ name: 'casos', purpose: 'p' }], tasks: [{ id: 'P1', title: 'Cadastro do caso', module: 'casos', owner: 'dev', criteriaRefs: ['AC-001'], dependsOn: [] }], risks: [] } } },
} as unknown as BacklogView;

describe('SpecTree', () => {
  it('opens the backlog list from the items chip when the page gives it, and keeps the specs chip plain', () => {
    render(<SpecTree backlog={backlog} locked={false} />);
    expect(screen.queryByTestId('item-caso')).toBeNull();
    fireEvent.click(screen.getByTestId('spec-tree-chip-button-items'));
    expect(within(screen.getByTestId('coverage-list-items')).getByTestId('item-caso')).toBeTruthy();
    fireEvent.click(screen.getByTestId('spec-tree-chip-button-specs'));
    expect(screen.queryByTestId('coverage-list-items')).toBeNull();
    expect(within(screen.getByTestId('coverage-list-specs')).getByText('k-caso')).toBeTruthy();
    expect(screen.queryByTestId('item-caso')).toBeNull();
  });

  it('counts sections, specs, criteria and tasks, and lists the gaps', () => {
    render(<SpecTree backlog={backlog} />);
    expect(within(screen.getByLabelText('Resumo da cobertura')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['2 seções', '1 item', '1 spec', '2 critérios', '1 tarefa', '2 lacunas']);
    const gaps = within(screen.getByTestId('tree-gaps'));
    expect(gaps.getByText(/9\. Faturamento/)).toBeTruthy();
    expect(gaps.getByText(/AC-002 sem tarefa/)).toBeTruthy();
  });

  it('lists the tasks behind the tasks chip, and closes it on a second click', () => {
    render(<SpecTree backlog={backlog} />);
    const chip = screen.getByRole('button', { name: '1 tarefa' });
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(within(screen.getByTestId('coverage-list-tasks')).getByText('P1 Cadastro do caso')).toBeTruthy();
    fireEvent.click(chip);
    expect(screen.queryByTestId('coverage-list-tasks')).toBeNull();
  });

  it('lists the specs and the criteria with their tasks, or says when a criterion has none', () => {
    render(<SpecTree backlog={backlog} />);
    fireEvent.click(screen.getByRole('button', { name: '1 spec' }));
    expect(within(screen.getByTestId('coverage-list-specs')).getByText('k-caso')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '2 critérios' }));
    expect(screen.queryByTestId('coverage-list-specs')).toBeNull();
    const criteria = within(screen.getByTestId('coverage-list-criteria'));
    expect(criteria.getByText(/AC-001: dado um paciente/)).toBeTruthy();
    expect(criteria.getByText('P1')).toBeTruthy();
    expect(criteria.getByText('sem tarefa')).toBeTruthy();
  });

  it('hides the gaps while the detailing runs', () => {
    const pending = { ...backlog, items: [...backlog.items, { ...backlog.items[0], key: 'fatura', title: 'Faturamento', rank: 2 }] } as BacklogView;
    render(<SpecTree backlog={pending} evaluating />);
    expect(screen.queryByTestId('tree-gaps')).toBeNull();
    expect(within(screen.getByTestId('tree-fatura')).getByText('pendente').className).not.toContain('text-bad');
  });

  it('groups the specs under their épico, collapsed like the backlog', () => {
    render(<SpecTree backlog={backlog} />);
    const epic = screen.getByTestId('tree-epic-core');
    expect(epic.tagName).toBe('DETAILS');
    expect((epic as HTMLDetailsElement).open).toBe(false);
    expect(within(epic).getByText('Núcleo')).toBeTruthy();
    expect(within(epic).getByTestId('tree-caso')).toBeTruthy();
  });

  it('puts each doc section under its épico, and the sections with no item apart', () => {
    render(<SpecTree backlog={backlog} />);
    expect(within(screen.getByTestId('tree-section-epic-core')).getByTestId('tree-section-0')).toBeTruthy();
    expect(within(screen.getByTestId('tree-section-epic-none')).getByTestId('tree-section-1')).toBeTruthy();
  });

  it('goes from the doc section to the spec, its criteria and the pre-plan tasks that cover them', () => {
    render(<SpecTree backlog={backlog} />);
    expect(within(screen.getByTestId('tree-section-0')).getByText('Abertura de caso')).toBeTruthy();
    expect(screen.getByTestId('tree-section-1').className).toContain('text-warn');
    const caso = within(screen.getByTestId('tree-caso'));
    expect(caso.getByText('k-caso')).toBeTruthy();
    expect(caso.getByLabelText(/AC-001: dado um paciente, quando abre o caso, então o caso existe/)).toBeTruthy();
    expect(caso.getByText(/P1 Cadastro do caso/)).toBeTruthy();
    expect(caso.getByTestId('tree-ac-AC-002').className).toContain('text-warn');
  });
});
