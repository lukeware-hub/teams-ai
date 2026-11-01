import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runApi, type RepoDetailView } from '../api.js';
import { RepositoryPage } from './RepositoryPage.js';

const detail = (over: Partial<RepoDetailView> = {}): RepoDetailView => ({
  name: 'shop-api',
  kind: 'api',
  responsibility: 'Vende',
  status: 'running',
  specs: 2,
  plans: 1,
  tasks: 5,
  tasksDone: 0,
  blockers: 1,
  integrations: ['shop-web → shop-api: GET /cart'],
  rows: [
    { specId: 'cart', status: 'done', activeRunId: null, repository: 'shop-api', title: 'Carrinho', priority: 'P1', dependsOn: [], plan: true, tasks: 3, blocked: false },
    { specId: 'pay', status: 'running', activeRunId: 'run-1', repository: 'shop-api', title: 'Pagamento', priority: 'P2', dependsOn: ['cart'], plan: false, tasks: 2, blocked: true },
  ],
  history: [],
  ...over,
});

const renderAt = () =>
  render(
    <MemoryRouter initialEntries={['/projects/shop/shop-api']}>
      <Routes>
        <Route path="/projects/:projectId/:repoId" element={<RepositoryPage />} />
      </Routes>
    </MemoryRouter>,
  );

afterEach(() => vi.restoreAllMocks());

describe('RepositoryPage', () => {
  it('shows the card, the integrations and each spec with its state and its tasks done', async () => {
    vi.spyOn(runApi, 'repository').mockResolvedValue(detail());
    renderAt();
    expect(await screen.findByText('Vende')).toBeTruthy();
    expect(screen.getByText('shop-web → shop-api: GET /cart')).toBeTruthy();
    const cart = within(screen.getByTestId('repo-spec-cart'));
    expect(cart.getByText('3 de 3')).toBeTruthy();
    const pay = within(screen.getByTestId('repo-spec-pay'));
    expect(pay.getByText('Bloqueada')).toBeTruthy();
    expect(pay.getByText('0 de 2')).toBeTruthy();
  });

  it('says "sem dados" for the history when the runs have none', async () => {
    vi.spyOn(runApi, 'repository').mockResolvedValue(detail());
    renderAt();
    await screen.findByTestId('repo-history');
    expect(screen.getByText('sem dados')).toBeTruthy();
  });

  it('says the repository is missing when the server does not give it', async () => {
    vi.spyOn(runApi, 'repository').mockRejectedValue(new Error('404'));
    renderAt();
    await waitFor(() => expect(screen.getByTestId('repo-missing')).toBeTruthy());
  });
});
