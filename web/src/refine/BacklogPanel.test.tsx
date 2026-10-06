import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BacklogView } from '../api.js';
import { BacklogPanel } from './BacklogPanel.js';

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
    expect(screen.getByText(/Montando o backlog/)).toBeTruthy();
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
