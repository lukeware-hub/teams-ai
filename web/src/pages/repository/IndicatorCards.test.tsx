import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RepoDashboard } from '../../api.js';
import { IndicatorCards } from './IndicatorCards.js';

const dashboard = (cost: number, runs = 40): RepoDashboard =>
  ({
    counts: { tasks: 12, delivered: 6, pending: 0, running: 0, blocked: 1, failed: 5, runs, runsActive: 0, failures: 11, blockers: 1, specsDelivered: 1, specsAwaiting: 0, progress: 50, cost },
  }) as unknown as RepoDashboard;

describe('IndicatorCards', () => {
  it('shows seven cards, the cost last, with the cost of the repository runs', () => {
    render(<IndicatorCards dashboard={dashboard(0.7416)} />);
    const row = within(screen.getByTestId('repo-cards'));
    expect(row.getAllByTestId(/^card-/)).toHaveLength(7);
    expect(row.getAllByTestId(/^card-/).at(-1)!.getAttribute('data-testid')).toBe('card-cost');
    expect(within(screen.getByTestId('card-cost')).getByText('US$ 0.74')).toBeTruthy();
    expect(within(screen.getByTestId('card-cost')).getByText('40 runs deste repositório')).toBeTruthy();
  });

  it('reads the cost of a repository with no run as zero, and a single run in the singular', () => {
    render(<IndicatorCards dashboard={dashboard(0, 1)} />);
    expect(within(screen.getByTestId('card-cost')).getByText('US$ 0.00')).toBeTruthy();
    expect(within(screen.getByTestId('card-cost')).getByText('1 run deste repositório')).toBeTruthy();
  });

  it('draws the progress of the repository as a bar, and writes the counts of specs in the singular for one', () => {
    render(<IndicatorCards dashboard={dashboard(0.5)} />);
    const bar = within(screen.getByTestId('card-progress')).getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(within(screen.getByTestId('card-delivered')).getByText('1 spec entregue · 0 specs aguardam validação')).toBeTruthy();
  });

  it('lays the cards out in two columns on a phone, four from 768 px and seven from 1280 px, and gives the cost the whole phone row', () => {
    render(<IndicatorCards dashboard={dashboard(0.5)} />);
    const grid = screen.getByTestId('repo-cards');
    expect(grid.className).toContain('grid-cols-2');
    expect(grid.className).toContain('md:grid-cols-4');
    expect(grid.className).toContain('xl:grid-cols-7');
    expect(screen.getByTestId('card-cost').className).toContain('col-span-2');
    expect(screen.getByTestId('card-cost').className).toContain('md:col-span-1');
  });
});
