import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { RepoCardView } from '../api.js';
import { RepositoriesPanel } from './RepositoriesPanel.js';

const card = (over: Partial<RepoCardView>): RepoCardView => ({ name: 'shop-api', kind: 'api', responsibility: 'Vende', status: 'done', specs: 2, plans: 2, tasks: 5, tasksDone: 3, blockers: 0, ...over });

describe('RepositoriesPanel', () => {
  it('gives one card per repository with its kind, counts, task progress and state', () => {
    render(<MemoryRouter><RepositoriesPanel projectId="shop" repositories={[card({}), card({ name: 'shop-web', kind: 'web', status: 'blocked', blockers: 1, tasks: 1, tasksDone: 0 })]} /></MemoryRouter>);
    expect(screen.getByText('Repositórios (2)')).toBeTruthy();
    const api = within(screen.getByTestId('repo-card-shop-api'));
    expect(api.getByText('2 specs · 2 planos · 5 tarefas')).toBeTruthy();
    expect(api.getByText('Tarefas: 3 de 5 concluídas')).toBeTruthy();
    expect(screen.getByTestId('repo-status-shop-web').textContent).toBe('Bloqueado · 1 bloqueio(s)');
  });

  it('links each card to its repository page', () => {
    render(<MemoryRouter><RepositoriesPanel projectId="shop" repositories={[card({})]} /></MemoryRouter>);
    expect(within(screen.getByTestId('repo-card-shop-api')).getByRole('link', { name: 'Abrir painel' }).getAttribute('href')).toBe('/projects/shop/shop-api');
  });
});
