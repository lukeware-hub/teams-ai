import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { api, type Item, type Status } from '../api.js';
import { Onboarding } from './Onboarding.js';

const item = (ok: boolean, detail: string): Item => ({ ok, detail });
const status = (ghLogin: boolean, owner: boolean): Status => ({
  items: {
    claude: item(false, 'not logged in'),
    githubOwner: item(owner, owner ? 'acme (Organization)' : 'GitHub owner not set'),
    ghLogin: item(ghLogin, ghLogin ? 'diego' : 'gh is not logged in'),
    githubToken: item(false, 'GITHUB_TOKEN not set'),
    openrouterKey: item(false, 'OPENROUTER_API_KEY not set'),
  },
  allOk: false,
});

describe('Onboarding GitHub flow', () => {
  it('logs in first, loads organizations, validates the selection, then reveals the token', async () => {
    let loggedIn = false;
    let ownerSaved = false;
    vi.spyOn(api, 'status').mockImplementation(() => Promise.resolve(status(loggedIn, ownerSaved)));
    vi.spyOn(api, 'login').mockImplementation(async () => {
      loggedIn = true;
      return { state: { name: 'done', detail: 'diego' } };
    });
    vi.spyOn(api, 'organizations').mockResolvedValue({ organizations: ['acme', 'platform'], owner: null });
    vi.spyOn(api, 'owner').mockImplementation(async (owner) => {
      ownerSaved = owner === 'acme';
      return { item: item(ownerSaved, 'acme (Organization)') };
    });

    render(<MemoryRouter><Onboarding /></MemoryRouter>);
    const githubCard = await screen.findByTestId('card-Login do GitHub CLI');
    fireEvent.click(within(githubCard).getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Próximo' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Próximo' }));

    const ownerCard = await screen.findByTestId('card-Organização do GitHub');
    const select = within(ownerCard).getByRole('combobox', { name: 'Organização do GitHub' });
    await waitFor(() => expect(within(select).getByRole('option', { name: 'acme' })).toBeTruthy());
    fireEvent.change(select, { target: { value: 'acme' } });
    fireEvent.click(within(ownerCard).getByRole('button', { name: 'Salvar e verificar' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Próximo' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Próximo' }));
    await waitFor(() => expect(screen.getByTestId('card-Token do GitHub')).toBeTruthy());
    const tokenLink = screen.getByRole('link', { name: /Criar o token/ });
    expect(tokenLink.getAttribute('href')).toContain('scopes=repo,workflow');
    expect(api.owner).toHaveBeenCalledWith('acme');
  });

  it('lets the optional OpenRouter (Jev) step be skipped', async () => {
    const s: Status = { items: { ...status(true, true).items, githubToken: item(true, 'ok'), claude: item(true, 'ok'), openrouterKey: item(false, 'HTTP 402') }, allOk: false };
    vi.spyOn(api, 'status').mockResolvedValue(s);
    vi.spyOn(api, 'organizations').mockResolvedValue({ organizations: [], owner: 'acme' });
    render(<MemoryRouter><Onboarding /></MemoryRouter>);
    await screen.findByTestId('card-Login do GitHub CLI');
    for (let i = 0; i < 4; i++) {
      await waitFor(() => expect(screen.getByRole('button', { name: 'Próximo' }).hasAttribute('disabled')).toBe(false));
      fireEvent.click(screen.getByRole('button', { name: 'Próximo' }));
    }
    await screen.findByTestId('card-Chave do OpenRouter (Jev, opcional)');
    expect(screen.getByRole('button', { name: 'Próximo' }).hasAttribute('disabled')).toBe(false);
  });

  it('opens straight on the OpenRouter step from the refine page link, even when everything else is ready', async () => {
    const ready: Status = { items: { ...status(true, true).items, githubToken: item(true, 'ok'), claude: item(true, 'ok'), openrouterKey: item(false, 'HTTP 401') }, allOk: true };
    vi.spyOn(api, 'status').mockResolvedValue(ready);
    vi.spyOn(api, 'organizations').mockResolvedValue({ organizations: [], owner: 'acme' });
    render(<MemoryRouter initialEntries={['/onboarding?item=openrouter']}><Onboarding /></MemoryRouter>);
    await screen.findByTestId('card-Chave do OpenRouter (Jev, opcional)');
    await waitFor(() => expect(screen.queryByText('Tudo pronto para começar')).toBeNull());
  });
});
