import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { RepoCardView } from '../api.js';
import { RepositoriesPanel } from './RepositoriesPanel.js';

const card = (over: Partial<RepoCardView>): RepoCardView => ({ name: 'shop-api', kind: 'api', responsibility: 'Vende', status: 'done', specs: 2, plans: 2, tasks: 5, tasksDone: 3, blockers: 0, ...over });
const renderPanel = (repositories: RepoCardView[]) => render(<MemoryRouter><RepositoriesPanel projectId="shop" repositories={repositories} /></MemoryRouter>);

describe('RepositoriesPanel', () => {
  it('gives one card per repository with its kind, counts, task progress and state', async () => {
    renderPanel([card({}), card({ name: 'shop-web', kind: 'web', status: 'blocked', blockers: 1, tasks: 1, tasksDone: 0 })]);
    expect(screen.getByText('Repositórios (2)')).toBeTruthy();
    const api = within(await screen.findByTestId('repo-card-shop-api'));
    expect(api.getByText('2 specs · 2 planos · 5 tarefas')).toBeTruthy();
    expect(api.getByText('Tarefas: 3 de 5 concluídas')).toBeTruthy();
    expect(screen.getByTestId('repo-status-shop-web').textContent).toBe('Bloqueado · 1 bloqueio');
  });

  it('links the name and the open action of each card to its repository page', async () => {
    renderPanel([card({})]);
    const api = within(await screen.findByTestId('repo-card-shop-api'));
    expect(api.getByRole('link', { name: 'Abrir painel' }).getAttribute('href')).toBe('/projects/shop/shop-api');
    expect(api.getByRole('link', { name: 'shop-api' }).getAttribute('href')).toBe('/projects/shop/shop-api');
  });

  it('shows the task share as a determinate bar, and none for a repository without tasks', async () => {
    renderPanel([card({}), card({ name: 'shop-web', kind: 'web', status: 'empty', tasks: 0, tasksDone: 0 })]);
    expect((await screen.findByTestId('repositories-panel-card-tasks-shop-api-meter')).getAttribute('aria-valuenow')).toBe('60');
    expect(screen.queryByTestId('repositories-panel-card-tasks-shop-web-meter')).toBeNull();
  });

  it('marks the state chip with its tone, so the state is not only a word', async () => {
    renderPanel([card({ status: 'blocked', blockers: 2 })]);
    expect((await screen.findByTestId('repo-status-shop-api')).className).toBe('status-pill tone-bad');
  });

  it('filters the cards by kind', async () => {
    renderPanel([card({}), card({ name: 'shop-web', kind: 'web' })]);
    await screen.findByTestId('repo-card-shop-web');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'API' } });
    expect(await screen.findByText('1 de 2')).toBeTruthy();
    expect(screen.queryByTestId('repo-card-shop-web')).toBeNull();
  });
});
