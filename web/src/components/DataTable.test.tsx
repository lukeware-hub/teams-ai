import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SortHeader, TableFilters, useTableView } from './DataTable.js';

const ROWS = [
  { id: 'T10', cost: 3, status: 'done' },
  { id: 'T2', cost: null, status: 'failed' },
  { id: 'T1', cost: 1, status: 'done' },
];

function Demo() {
  const view = useTableView(ROWS, {
    sorts: { id: (r) => r.id, cost: (r) => r.cost },
    text: (r) => [r.id],
    facet: (r) => r.status,
    facetLabel: (s) => (s === 'done' ? 'Concluída' : 'Falhou'),
  });
  return (
    <>
      <TableFilters view={view} subject="linhas" placeholder="Filtrar" facetName="Status" />
      <table>
        <thead>
          <tr>
            <SortHeader view={view} column="id">Id</SortHeader>
            <SortHeader view={view} column="cost">Custo</SortHeader>
          </tr>
        </thead>
        <tbody>{view.rows.map((r) => <tr key={r.id}><td>{r.id}</td></tr>)}</tbody>
      </table>
    </>
  );
}

const ids = () => screen.getAllByRole('row').slice(1).map((r) => r.textContent);

describe('table sorting and filtering', () => {
  it('cycles ascending, descending, original order; numbers collate naturally and empty values stay last', () => {
    render(<Demo />);
    expect(ids()).toEqual(['T10', 'T2', 'T1']);
    fireEvent.click(screen.getByRole('button', { name: 'Id' }));
    expect(ids()).toEqual(['T1', 'T2', 'T10']);
    expect(screen.getByRole('columnheader', { name: 'Id' }).getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(screen.getByRole('button', { name: 'Id' }));
    expect(ids()).toEqual(['T10', 'T2', 'T1']);
    expect(screen.getByRole('columnheader', { name: 'Id' }).getAttribute('aria-sort')).toBe('descending');
    fireEvent.click(screen.getByRole('button', { name: 'Id' }));
    expect(screen.getByRole('columnheader', { name: 'Id' }).getAttribute('aria-sort')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Custo' }));
    expect(ids()).toEqual(['T1', 'T10', 'T2']);
    fireEvent.click(screen.getByRole('button', { name: 'Custo' }));
    expect(ids()).toEqual(['T10', 'T1', 'T2']);
  });
  it('filters by text and by the dropdown, counts the matches and clears both', () => {
    render(<Demo />);
    fireEvent.change(screen.getByLabelText('Filtrar linhas'), { target: { value: 't1' } });
    expect(ids()).toEqual(['T10', 'T1']);
    expect(screen.getByText('2 de 3')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });
    expect(ids()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(ids()).toEqual(['T10', 'T2', 'T1']);
  });
});
