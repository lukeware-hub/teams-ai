import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ProjectCosts } from '@server/usage/cost-report.js';
import type { CostFact, CostMoney, CostShare } from '@server/usage/cost-types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, costsApi } from '../api.js';
import { CostsProjectPage } from './CostsProject.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Text matching normalizes the no-break space of the currency to a plain one, so the matcher uses a plain one too.
const usd = (value: string) => `US$ ${value}`;
const money = (costUsd: number, steps = 1): CostMoney => ({ costUsd, tokens: 0, steps, semCusto: 0 });
const share = (key: string, costUsd: number, fraction: number): CostShare => ({ key, costUsd, tokens: 0, steps: 1, share: fraction });

const project: ProjectCosts = {
  projectId: 'kayron-hub',
  name: 'Kayron Hub',
  period: 'tudo',
  refinement: {
    total: money(3.1, 18),
    byAgent: [share('po', 3.1, 1)],
    byModel: [share('opus', 3.1, 1)],
    byKind: [share('avaliacao-jev', 3.1, 1)],
    byPhase: [],
    byRepository: [],
  },
  development: {
    total: money(20.1, 212),
    byAgent: [share('dev', 20.1, 1)],
    byModel: [share('sonnet', 20.1, 1)],
    byKind: [share('desconhecido', 20.1, 1)],
    byPhase: [share('tarefas', 20.1, 1)],
    byRepository: [share('api', 20.1, 1)],
  },
  chat: money(0.12, 14),
  specs: [{ key: 'kayron-hub-001', label: 'kayron-hub-001', refinement: 3.1, development: 20.1, total: 23.2, runs: 31 }],
  unreadJournals: 0,
};

const step: CostFact = {
  stage: 'development',
  projectId: 'kayron-hub',
  specId: 'kayron-hub-001',
  runId: 'run-1',
  repository: 'api',
  taskId: 'T1',
  attempt: 1,
  phase: 'tarefas',
  kind: 'desconhecido',
  role: 'dev',
  provider: 'claude',
  model: 'sonnet',
  at: '2026-11-01T10:00:00.000Z',
  costUsd: 0.5,
  tokens: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
};

function renderAt(path = '/costs/kayron-hub') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/costs/:projectId" element={<CostsProjectPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CostsProjectPage', () => {
  it('keeps refinement and development as two separate totals', async () => {
    vi.spyOn(costsApi, 'project').mockResolvedValue(project);
    vi.spyOn(costsApi, 'steps').mockResolvedValue({ total: 0, matched: 0, page: 1, size: 10, pages: 1, facets: [], list: [] });
    renderAt();
    const refinement = await screen.findByTestId('costs-stage-refinement');
    expect(within(refinement).getAllByText(usd('3,10')).length).toBeGreaterThan(0);
    expect(within(refinement).queryByText(usd('20,10'))).toBeNull();
    const development = screen.getByTestId('costs-stage-development');
    expect(within(development).getAllByText(usd('20,10')).length).toBeGreaterThan(0);
    expect(within(development).queryByText(usd('3,10'))).toBeNull();
  });

  it('shows the spec table with a refinement and a development column', async () => {
    vi.spyOn(costsApi, 'project').mockResolvedValue(project);
    vi.spyOn(costsApi, 'steps').mockResolvedValue({ total: 0, matched: 0, page: 1, size: 10, pages: 1, facets: [], list: [] });
    renderAt();
    const specs = await screen.findByTestId('costs-specs');
    expect(within(specs).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Spec', 'Refinamento', 'Desenvolvimento', 'Total', 'Runs']);
  });

  it('shows the not-found state for an unknown project', async () => {
    vi.spyOn(costsApi, 'project').mockRejectedValue(new ApiError('unknown project nope', 404));
    renderAt('/costs/nope');
    expect(await screen.findByTestId('costs-project-not-found-state')).toBeTruthy();
    expect(screen.queryByTestId('costs-breadcrumb')).toBeNull();
  });

  it('sends the chosen agent to the steps table', async () => {
    vi.spyOn(costsApi, 'project').mockResolvedValue(project);
    const steps = vi.spyOn(costsApi, 'steps').mockResolvedValue({ total: 1, matched: 1, page: 1, size: 10, pages: 1, facets: ['development'], list: [step] });
    renderAt();
    const panel = await screen.findByTestId('costs-steps');
    expect(await within(panel).findByText('Product Owner', { exact: false, selector: 'option' })).toBeTruthy();
    fireEvent.change(within(panel).getByRole('combobox', { name: /^Agente/ }), { target: { value: 'po' } });
    await waitFor(() => expect(steps.mock.calls.at(-1)?.[2]).toEqual({ agente: 'po', spec: '' }));
    expect(steps.mock.calls.at(-1)?.[0]).toBe('kayron-hub');
  });
});
