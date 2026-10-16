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
  it('logs in first, saves the token, then validates the organization', async () => {
    let loggedIn = false;
    let tokenSaved = false;
    let ownerSaved = false;
    vi.spyOn(api, 'status').mockImplementation(() => Promise.resolve({
      items: {
        ...status(loggedIn, ownerSaved).items,
        githubToken: item(tokenSaved, tokenSaved ? 'diego · scopes: repo, workflow' : 'GITHUB_TOKEN not set'),
      },
      allOk: false,
    }));
    vi.spyOn(api, 'login').mockImplementation(async () => {
      loggedIn = true;
      return { state: { name: 'done', detail: 'diego' } };
    });
    vi.spyOn(api, 'secret').mockImplementation(async () => {
      tokenSaved = true;
      return { item: item(true, 'diego · scopes: repo, workflow') };
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

    const tokenCard = await screen.findByTestId('card-Token do GitHub');
    const tokenLink = within(tokenCard).getByRole('link', { name: /Criar o token/ });
    expect(tokenLink.getAttribute('href')).toContain('scopes=repo,workflow');
    fireEvent.change(within(tokenCard).getByLabelText('Cole o token de acesso'), { target: { value: 'ghp_test' } });
    fireEvent.click(within(tokenCard).getByRole('button', { name: 'Salvar e verificar' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Próximo' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Próximo' }));

    const ownerCard = await screen.findByTestId('card-Organização do GitHub');
    const select = within(ownerCard).getByRole('combobox', { name: 'Organização do GitHub' });
    await waitFor(() => expect(within(select).getByRole('option', { name: 'acme' })).toBeTruthy());
    fireEvent.change(select, { target: { value: 'acme' } });
    fireEvent.click(within(ownerCard).getByRole('button', { name: 'Salvar e verificar' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Próximo' }).hasAttribute('disabled')).toBe(false));
    expect(api.owner).toHaveBeenCalledWith('acme');
  });

  it('does not let the OpenRouter (Jev) step be skipped until the key is valid', async () => {
    const s: Status = { items: { ...status(true, true).items, githubToken: item(true, 'ok'), claude: item(true, 'ok'), openrouterKey: item(false, 'HTTP 402') }, allOk: false };
    vi.spyOn(api, 'status').mockResolvedValue(s);
    vi.spyOn(api, 'organizations').mockResolvedValue({ organizations: [], owner: 'acme' });
    render(<MemoryRouter><Onboarding /></MemoryRouter>);
    await screen.findByTestId('card-Login do GitHub CLI');
    for (let i = 0; i < 4; i++) {
      await waitFor(() => expect(screen.getByRole('button', { name: 'Próximo' }).hasAttribute('disabled')).toBe(false));
      fireEvent.click(screen.getByRole('button', { name: 'Próximo' }));
    }
    await screen.findByTestId('card-Chave do OpenRouter (Jev)');
    expect(screen.getByRole('button', { name: 'Próximo' }).hasAttribute('disabled')).toBe(true);
  });

  it('opens straight on the OpenRouter step from the refine page link, even when everything else is ready', async () => {
    const ready: Status = { items: { ...status(true, true).items, githubToken: item(true, 'ok'), claude: item(true, 'ok'), openrouterKey: item(true, 'ok') }, allOk: true };
    vi.spyOn(api, 'status').mockResolvedValue(ready);
    vi.spyOn(api, 'organizations').mockResolvedValue({ organizations: [], owner: 'acme' });
    render(<MemoryRouter initialEntries={['/onboarding?item=openrouter']}><Onboarding /></MemoryRouter>);
    await screen.findByTestId('card-Chave do OpenRouter (Jev)');
    await waitFor(() => expect(screen.queryByText('Tudo pronto para começar')).toBeNull());
  });

  it('plays the completion marks once when setup finishes during the visit', async () => {
    let loggedIn = false;
    vi.spyOn(api, 'status').mockImplementation(() => Promise.resolve({
      items: {
        ghLogin: item(loggedIn, loggedIn ? 'diego' : 'gh is not logged in'),
        githubOwner: item(true, 'acme (Organization)'),
        githubToken: item(true, 'ok'),
        claude: item(true, 'ok'),
        openrouterKey: item(true, 'ok'),
      },
      allOk: loggedIn,
    }));
    vi.spyOn(api, 'login').mockImplementation(async () => {
      loggedIn = true;
      return { state: { name: 'done', detail: 'diego' } };
    });
    vi.spyOn(api, 'organizations').mockResolvedValue({ organizations: [], owner: 'acme' });
    const { container } = render(<MemoryRouter><Onboarding /></MemoryRouter>);
    const githubCard = await screen.findByTestId('card-Login do GitHub CLI');
    fireEvent.click(within(githubCard).getByRole('button', { name: 'Entrar' }));
    await screen.findByText('Tudo pronto para começar');
    expect(container.querySelectorAll('.confetti i')).toHaveLength(5);
  });

  it('plays no completion marks when setup is already complete on load', async () => {
    const ready: Status = { items: { ...status(true, true).items, githubToken: item(true, 'ok'), claude: item(true, 'ok'), openrouterKey: item(true, 'ok') }, allOk: true };
    vi.spyOn(api, 'status').mockResolvedValue(ready);
    vi.spyOn(api, 'organizations').mockResolvedValue({ organizations: [], owner: 'acme' });
    const { container } = render(<MemoryRouter><Onboarding /></MemoryRouter>);
    await screen.findByText('Tudo pronto para começar');
    expect(container.querySelector('.confetti')).toBeNull();
  });
});
