import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { CostOverview } from '@server/usage/cost-report.js';
import type { CostMoney } from '@server/usage/cost-types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { costsApi } from '../api.js';
import { CostsPage } from './Costs.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Text matching normalizes the no-break space of the currency to a plain one, so the matcher uses a plain one too.
const usd = (value: string) => `US$ ${value}`;
const money = (costUsd: number, steps = 1): CostMoney => ({ costUsd, tokens: 0, steps, semCusto: 0 });
const byStage = (refinement: number, development: number, chat: number) => ({ refinement: money(refinement), development: money(development), chat: money(chat) });

function overview(over: Partial<CostOverview> = {}): CostOverview {
  return {
    period: 'tudo',
    total: { costUsd: 39.67, tokens: 5_700_000, steps: 42, semCusto: 0 },
    byStage: byStage(6.35, 33.2, 0.12),
    projects: [
      { projectId: 'kayron-hub', name: 'Kayron Hub', total: money(23.25, 30), byStage: byStage(3.1, 20.1, 0.05), runs: 31 },
      { projectId: 'shop', name: 'Shop', total: money(16.42, 12), byStage: byStage(3.25, 13.1, 0.07), runs: 4 },
    ],
    agents: [{ stage: 'refinement', key: 'po', costUsd: 2, tokens: 0, steps: 3, share: 0.05 }],
    models: [{ key: 'opus', costUsd: 30, tokens: 0, steps: 5, share: 0.76 }],
    jevUnassignedUsd: 0.4,
    unreadJournals: 0,
    escalationsWithoutCost: 0,
    ...over,
  };
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.search}</p>;
}

function renderAt(path = '/costs') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="/costs" element={<CostsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CostsPage', () => {
  it('renders the totals of the period, with the share of each stage', async () => {
    vi.spyOn(costsApi, 'overview').mockResolvedValue(overview());
    renderAt();
    const total = await screen.findByTestId('costs-indicator-total');
    expect(within(total).getByText(usd('39,6700'))).toBeTruthy();
    expect(within(total).getByText('5,7 mi tokens')).toBeTruthy();
    const refinement = screen.getByTestId('costs-indicator-refinement');
    expect(within(refinement).getByText(usd('6,3500'))).toBeTruthy();
    expect(within(refinement).getByText('16% do total')).toBeTruthy();
  });

  it('asks for the period a chip names, shows it pressed, and keeps it in the address', async () => {
    const read = vi.spyOn(costsApi, 'overview').mockResolvedValue(overview());
    renderAt();
    await screen.findByTestId('costs-indicator-total');
    expect(screen.getByRole('button', { name: 'Tudo' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '7 dias' }));
    await waitFor(() => expect(read.mock.calls.at(-1)).toEqual(['7d']));
    expect(screen.getByRole('button', { name: '7 dias' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('where').textContent).toContain('period=7d');
  });

  it('links each project row to its own cost page', async () => {
    vi.spyOn(costsApi, 'overview').mockResolvedValue(overview());
    renderAt();
    expect((await screen.findByRole('link', { name: 'Kayron Hub' })).getAttribute('href')).toBe('/costs/kayron-hub');
    expect(screen.getByRole('link', { name: 'Shop' }).getAttribute('href')).toBe('/costs/shop');
  });

  it('says so when nothing was spent in the period', async () => {
    vi.spyOn(costsApi, 'overview').mockResolvedValue(overview({ total: { costUsd: 0, tokens: 0, steps: 0, semCusto: 0 }, byStage: byStage(0, 0, 0), projects: [], agents: [], models: [] }));
    renderAt();
    expect(await screen.findByText('Nenhum custo registrado neste período.')).toBeTruthy();
  });

  it('shows an error with a retry, and keeps the last value on screen after a failed refresh', async () => {
    const read = vi.spyOn(costsApi, 'overview').mockResolvedValueOnce(overview()).mockRejectedValueOnce(new Error('falhou')).mockResolvedValueOnce(overview());
    renderAt();
    await screen.findByTestId('costs-indicator-total');
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    expect(await screen.findByText('Não foi possível ler os custos. Tente de novo.')).toBeTruthy();
    expect(screen.getByTestId('costs-indicator-total')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(screen.queryByText('Não foi possível ler os custos. Tente de novo.')).toBeNull());
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('warns that some journals could not be read', async () => {
    vi.spyOn(costsApi, 'overview').mockResolvedValue(overview({ unreadJournals: 2 }));
    renderAt();
    expect((await screen.findByTestId('costs-unread')).textContent).toContain('2 registros não lidos');
  });

  it('says how many escalations from older runs carry no cost, and says they are left out of the total', async () => {
    vi.spyOn(costsApi, 'overview').mockResolvedValue(overview({ escalationsWithoutCost: 2 }));
    renderAt();
    const note = await screen.findByTestId('costs-escalation-note');
    expect(note.textContent).toContain('2 chamadas de escalonamento para o Claude');
    expect(note.textContent).toContain('Elas não entram no total.');
  });

  it('shows the Jev money no project owns, and no warning when no journal is unread', async () => {
    vi.spyOn(costsApi, 'overview').mockResolvedValue(overview());
    renderAt();
    const footer = await screen.findByTestId('costs-footer');
    expect(within(footer).getByText(usd('0,4000'))).toBeTruthy();
    expect(screen.queryByTestId('costs-unread')).toBeNull();
  });
});
