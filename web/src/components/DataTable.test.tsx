import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { queryPage, type PageRequest, type TableSpec } from '@server/api/paging.js';
import { Pagination, SortHeader, TableFilters, usePagedTable } from './DataTable.js';

type Row = { id: string; cost: number | null; status: string; kind: string };

const ROWS: Row[] = [
  { id: 'T10', cost: 3, status: 'done', kind: 'a' },
  { id: 'T2', cost: null, status: 'failed', kind: 'a' },
  { id: 'T1', cost: 1, status: 'done', kind: 'a' },
];

const SPEC: TableSpec<Row> = {
  sorts: { id: (r) => r.id, cost: (r) => r.cost },
  text: (r) => [r.id],
  facet: (r) => r.status,
};

const LABEL: Record<string, string> = { done: 'Concluída', failed: 'Falhou' };

/** A server stand-in: it cuts pages with the same rules the API uses. */
const serve = <T,>(rows: T[], spec: TableSpec<T>) => (req: PageRequest) => Promise.resolve(queryPage(rows, spec, req));

function Demo() {
  const view = usePagedTable('demo', serve(ROWS, SPEC), (s) => LABEL[s] ?? s);
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

const ids = () => screen.queryAllByRole('row').slice(1).map((r) => r.textContent);

describe('table sorting and filtering on the server', () => {
  it('cycles ascending, descending, original order; numbers collate naturally and empty values stay last', async () => {
    render(<Demo />);
    await waitFor(() => expect(ids()).toEqual(['T10', 'T2', 'T1']));
    fireEvent.click(screen.getByRole('button', { name: 'Id' }));
    await waitFor(() => expect(ids()).toEqual(['T1', 'T2', 'T10']));
    expect(screen.getByRole('columnheader', { name: 'Id' }).getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(screen.getByRole('button', { name: 'Id' }));
    await waitFor(() => expect(ids()).toEqual(['T10', 'T2', 'T1']));
    expect(screen.getByRole('columnheader', { name: 'Id' }).getAttribute('aria-sort')).toBe('descending');
    fireEvent.click(screen.getByRole('button', { name: 'Id' }));
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Id' }).getAttribute('aria-sort')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Custo' }));
    await waitFor(() => expect(ids()).toEqual(['T1', 'T10', 'T2']));
    fireEvent.click(screen.getByRole('button', { name: 'Custo' }));
    await waitFor(() => expect(ids()).toEqual(['T10', 'T1', 'T2']));
  });

  it('filters by text and by the dropdown, counts the matches and clears both', async () => {
    render(<Demo />);
    fireEvent.change(screen.getByLabelText('Filtrar linhas'), { target: { value: 't1' } });
    await waitFor(() => expect(ids()).toEqual(['T10', 'T1']));
    expect(screen.getByText('2 de 3')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'failed' } });
    await waitFor(() => expect(ids()).toEqual([]));
    fireEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    await waitFor(() => expect(ids()).toEqual(['T10', 'T2', 'T1']));
  });
});

const PAGED: Row[] = Array.from({ length: 12 }, (_, i) => ({ id: `T${i + 1}`, cost: null, status: 'done', kind: i < 6 ? 'a' : 'b' }));
const PAGED_SPEC: TableSpec<Row> = { text: (r) => [r.id], facet: (r) => r.kind };

function Pager({ fetchPage = serve(PAGED, PAGED_SPEC) }: { fetchPage?: (req: PageRequest) => Promise<ReturnType<typeof queryPage<Row>>> }) {
  const view = usePagedTable('pager', fetchPage, (kind) => `Tipo ${kind}`);
  return (
    <>
      <TableFilters view={view} subject="linhas" placeholder="Filtrar" facetName="Tipo" />
      <ul>{view.rows.map((r) => <li key={r.id}>{r.id}</li>)}</ul>
      <Pagination view={view} />
    </>
  );
}

describe('table reloading on the server', () => {
  it('asks the server again when the reload key changes, and not for the same key', async () => {
    const fetchPage = vi.fn(serve(PAGED, PAGED_SPEC));
    function Reloads({ reloadKey }: { reloadKey: string }) {
      const view = usePagedTable('reload', fetchPage, undefined, reloadKey);
      return <ul>{view.rows.map((r) => <li key={r.id}>{r.id}</li>)}</ul>;
    }
    const { rerender } = render(<Reloads reloadKey="a" />);
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
    rerender(<Reloads reloadKey="a" />);
    expect(fetchPage).toHaveBeenCalledTimes(1);
    rerender(<Reloads reloadKey="b" />);
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
  });
});

const pageIds = () => screen.queryAllByRole('listitem').map((li) => li.textContent);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `T${from + i}`);

describe('table paging on the server', () => {
  it('asks the server for one page at a time: ten rows, the range and the previous and next buttons', async () => {
    const fetchPage = vi.fn(serve(PAGED, PAGED_SPEC));
    render(<Pager fetchPage={fetchPage} />);
    await waitFor(() => expect(pageIds()).toEqual(range(1, 10)));
    const previous = screen.getByRole('button', { name: 'Página anterior' }) as HTMLButtonElement;
    const next = screen.getByRole('button', { name: 'Próxima página' }) as HTMLButtonElement;
    expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, size: 10 }));
    expect(screen.getByText('1–10 de 12')).toBeTruthy();
    expect(previous.disabled).toBe(true);
    fireEvent.click(next);
    await waitFor(() => expect(pageIds()).toEqual(range(11, 12)));
    expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, size: 10 }));
    expect(screen.getByText('11–12 de 12')).toBeTruthy();
    expect(next.disabled).toBe(true);
    fireEvent.click(previous);
    await waitFor(() => expect(pageIds()).toEqual(range(1, 10)));
  });
  it('offers 5, 10, 50 and 100 rows a page', async () => {
    render(<Pager />);
    await waitFor(() => expect(pageIds()).toHaveLength(10));
    expect(Array.from(screen.getByLabelText('Itens por página').querySelectorAll('option'), (o) => o.textContent)).toEqual(['5', '10', '50', '100']);
  });
  it('picking a size shows that many rows and goes back to the first page', async () => {
    render(<Pager />);
    await waitFor(() => expect(pageIds()).toHaveLength(10));
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(pageIds()).toEqual(range(11, 12)));
    fireEvent.change(screen.getByLabelText('Itens por página'), { target: { value: '5' } });
    await waitFor(() => expect(pageIds()).toEqual(range(1, 5)));
    expect(screen.getByText('1–5 de 12')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Itens por página'), { target: { value: '50' } });
    await waitFor(() => expect(pageIds()).toEqual(range(1, 12)));
  });
  it('hides the pager when the matches fit the smallest page size', async () => {
    render(<Pager />);
    fireEvent.change(screen.getByLabelText('Filtrar linhas'), { target: { value: 'T1' } });
    await waitFor(() => expect(pageIds()).toEqual(['T1', 'T10', 'T11', 'T12']));
    expect(screen.queryByLabelText('Itens por página')).toBeNull();
  });
  it('a filter change goes back to the first page', async () => {
    render(<Pager />);
    await waitFor(() => expect(pageIds()).toHaveLength(10));
    fireEvent.change(screen.getByLabelText('Itens por página'), { target: { value: '5' } });
    await waitFor(() => expect(pageIds()).toEqual(range(1, 5)));
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(pageIds()).toEqual(range(6, 10)));
    fireEvent.change(screen.getByLabelText('Tipo'), { target: { value: 'b' } });
    await waitFor(() => expect(pageIds()).toEqual(range(7, 11)));
    expect(screen.getByText('1–5 de 6')).toBeTruthy();
  });
});
