import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runApi, type TimelineEntry } from '../../api.js';
import { queryPage } from '@server/api/paging.js';
import { Timeline } from './Timeline.js';

const entry = (n: number): TimelineEntry => ({ at: '2026-11-01T10:00:00.000Z', runId: `shop-run-${n}`, specId: 'cart', text: `Evento ${n}`, tone: '', role: 'dev', taskId: null });
const ROWS = Array.from({ length: 25 }, (_, i) => entry(i + 1));

afterEach(() => vi.restoreAllMocks());

describe('Timeline', () => {
  it('asks the server for one page of events and moves to the next page', async () => {
    const spy = vi.spyOn(runApi, 'repositoryDashboardTable').mockImplementation((_p, _r, _t, req) => Promise.resolve(queryPage(ROWS, { text: (e) => [e.text] }, req)));
    render(<MemoryRouter><Timeline projectId="kayron" repo="shop" /></MemoryRouter>);
    const panel = within(screen.getByTestId('repo-timeline'));
    await waitFor(() => expect(panel.getAllByRole('row')).toHaveLength(11));
    expect(spy).toHaveBeenLastCalledWith('kayron', 'shop', 'timeline', expect.objectContaining({ page: 1, size: 10 }));
    expect(panel.getByText('Evento 1')).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(panel.getByText('Evento 11')).toBeTruthy());
    expect(panel.getAllByRole('row')).toHaveLength(11);
    expect(panel.getByText('11–20 de 25')).toBeTruthy();
  });

  it('reads "sem dados" when the repository has no event', async () => {
    vi.spyOn(runApi, 'repositoryDashboardTable').mockImplementation((_p, _r, _t, req) => Promise.resolve(queryPage([], {}, req)));
    render(<MemoryRouter><Timeline projectId="kayron" repo="shop" /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('sem dados: nenhum evento registrado.')).toBeTruthy());
  });
});
