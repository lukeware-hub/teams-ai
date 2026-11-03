import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runApi, type DashboardRunRow } from '../../api.js';
import { queryPage } from '@server/api/paging.js';
import { RunsTable } from './RunsTable.js';

const run = (n: number): DashboardRunRow => ({ runId: `shop-run-${n}`, specId: 'cart', kind: 'run', status: 'complete', at: '2026-11-01T10:00:00.000Z', merged: 0, cost: 0 });
const ROWS = Array.from({ length: 12 }, (_, i) => run(i + 1));

/** The server's page for the request; the component never sees the other rows. */
const serve = vi.fn((_p: string, _r: string, _t: string, req: Parameters<typeof queryPage>[2]) => Promise.resolve(queryPage(ROWS, {}, req)));

afterEach(() => vi.restoreAllMocks());

describe('RunsTable', () => {
  it('asks the server for one page of runs and moves to the next page', async () => {
    vi.spyOn(runApi, 'repositoryDashboardTable').mockImplementation(serve as never);
    render(<MemoryRouter><RunsTable projectId="kayron" repo="shop" /></MemoryRouter>);
    await waitFor(() => expect(screen.getAllByTestId(/^run-shop-run-/)).toHaveLength(10));
    expect(serve).toHaveBeenLastCalledWith('kayron', 'shop', 'runs', expect.objectContaining({ page: 1, size: 10 }));
    expect(screen.getByText('1–10 de 12')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(screen.getAllByTestId(/^run-shop-run-/)).toHaveLength(2));
    expect(within(screen.getByTestId('repo-runs')).getByText('11–12 de 12')).toBeTruthy();
  });
});
