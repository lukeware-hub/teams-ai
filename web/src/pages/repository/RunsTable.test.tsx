import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { DashboardRunRow } from '../../api.js';
import { RunsTable } from './RunsTable.js';

const run = (n: number): DashboardRunRow => ({ runId: `shop-run-${n}`, specId: 'cart', kind: 'run', status: 'complete', at: '2026-11-01T10:00:00.000Z', merged: 0, cost: 0 });
const list = (count: number, total = count) => ({ total, list: Array.from({ length: count }, (_, i) => run(i + 1)) });

describe('RunsTable', () => {
  it('pages the runs, ten at a time, and moves to the next page', () => {
    render(<MemoryRouter><RunsTable runs={list(12)} /></MemoryRouter>);
    expect(screen.getAllByTestId(/^run-shop-run-/)).toHaveLength(10);
    expect(screen.getByText('1–10 de 12')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    expect(screen.getAllByTestId(/^run-shop-run-/)).toHaveLength(2);
    expect(within(screen.getByTestId('repo-runs')).getByText('11–12 de 12')).toBeTruthy();
  });

  it('says how many runs it leaves out when the server caps the list', () => {
    render(<MemoryRouter><RunsTable runs={list(3, 450)} /></MemoryRouter>);
    expect(screen.getByText('Mostrando as 3 runs mais recentes de 450.')).toBeTruthy();
  });
});
