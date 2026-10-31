import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Pagination, SortHeader, TableFilters, usePagination, useTableView } from './DataTable.js';

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

const PAGED = Array.from({ length: 12 }, (_, i) => ({ id: `T${i + 1}`, kind: i < 6 ? 'a' : 'b' }));

function Pager() {
  const view = useTableView(PAGED, {
    sorts: {},
    text: (r) => [r.id],
    facet: (r) => r.kind,
    facetLabel: (kind) => `Tipo ${kind}`,
  });
  const pages = usePagination(view.rows, `${view.query}|${view.facet}`);
  return (
    <>
      <TableFilters view={view} subject="linhas" placeholder="Filtrar" facetName="Tipo" />
      <ul>{pages.rows.map((r) => <li key={r.id}>{r.id}</li>)}</ul>
      <Pagination view={pages} />
    </>
  );
}

const pageIds = () => screen.queryAllByRole('listitem').map((li) => li.textContent);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `T${from + i}`);

describe('table paging', () => {
  it('shows ten rows a page, with the range and the previous and next buttons', () => {
    render(<Pager />);
    const previous = screen.getByRole('button', { name: 'Página anterior' }) as HTMLButtonElement;
    const next = screen.getByRole('button', { name: 'Próxima página' }) as HTMLButtonElement;
    expect(pageIds()).toEqual(range(1, 10));
    expect(screen.getByText('1–10 de 12')).toBeTruthy();
    expect(previous.disabled).toBe(true);
    fireEvent.click(next);
    expect(pageIds()).toEqual(range(11, 12));
    expect(screen.getByText('11–12 de 12')).toBeTruthy();
    expect(next.disabled).toBe(true);
    fireEvent.click(previous);
    expect(pageIds()).toEqual(range(1, 10));
  });
  it('offers 5, 10, 50 and 100 rows a page', () => {
    render(<Pager />);
    expect(Array.from(screen.getByLabelText('Itens por página').querySelectorAll('option'), (o) => o.textContent)).toEqual(['5', '10', '50', '100']);
  });
  it('picking a size shows that many rows and goes back to the first page', () => {
    render(<Pager />);
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    fireEvent.change(screen.getByLabelText('Itens por página'), { target: { value: '5' } });
    expect(pageIds()).toEqual(range(1, 5));
    expect(screen.getByText('1–5 de 12')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Itens por página'), { target: { value: '50' } });
    expect(pageIds()).toEqual(range(1, 12));
  });
  it('hides the pager when the rows fit the smallest page size', () => {
    render(<Pager />);
    fireEvent.change(screen.getByLabelText('Filtrar linhas'), { target: { value: 'T1' } });
    expect(pageIds()).toEqual(['T1', 'T10', 'T11', 'T12']);
    expect(screen.queryByLabelText('Itens por página')).toBeNull();
  });
  it('a filter change goes back to the first page', () => {
    render(<Pager />);
    fireEvent.change(screen.getByLabelText('Itens por página'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(pageIds()).toEqual(range(6, 10));
    fireEvent.change(screen.getByLabelText('Tipo'), { target: { value: 'b' } });
    expect(pageIds()).toEqual(range(7, 11));
    expect(screen.getByText('1–5 de 6')).toBeTruthy();
  });
});
