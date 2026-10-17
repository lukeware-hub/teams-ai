import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, runApi, settingsApi, type Item, type ProjectRow, type Status } from '../api.js';
import { SettingsPage } from './Settings.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const project = { projectId: 'demo', name: 'Demo' } as ProjectRow;
const agents = ['sm', 'po', 'front', 'dev', 'test', 'sec', 'devops', 'env'].map((role) => ({ role, setting: null }));
const item = (ok: boolean, detail: string): Item => ({ ok, detail });
const envStatus = (over: Partial<Status['items']> = {}): Status => ({
  items: {
    ghLogin: item(true, 'diego'),
    githubToken: item(false, 'GITHUB_TOKEN not set'),
    githubOwner: item(true, 'acme (Organization)'),
    claude: item(false, 'not logged in'),
    openrouterKey: item(false, 'OPENROUTER_API_KEY not set'),
    ...over,
  },
  allOk: false,
});

function mockEnv() {
  vi.spyOn(api, 'status').mockResolvedValue(envStatus());
  vi.spyOn(api, 'organizations').mockResolvedValue({ organizations: ['acme'], owner: 'acme' });
}

async function openModelsCollapse() {
  expect(await screen.findByText('Modelos e esforço', { selector: '.settings-collapse-title' })).toBeTruthy();
  expect(screen.queryByLabelText('Modo de Desenvolvedor')).toBeNull();
  fireEvent.click(screen.getByText('Modelos e esforço', { selector: '.settings-collapse-title' }));
  return screen.findByLabelText('Modo de Desenvolvedor');
}

describe('SettingsPage', () => {
  it('shows the global environment collapses separate from project agents', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Ambiente' })).toBeTruthy();
    for (const title of ['Login do GitHub CLI', 'Token do GitHub', 'Organização do GitHub', 'Login do Claude', 'Chave do OpenRouter (Jev)']) {
      expect(screen.getByText(title, { selector: '.settings-collapse-title' })).toBeTruthy();
    }
    expect(screen.queryByTestId('card-Token do GitHub')).toBeNull();

    fireEvent.click(screen.getByText('Token do GitHub', { selector: '.settings-collapse-title' }));
    expect(await screen.findByTestId('card-Token do GitHub')).toBeTruthy();
    expect(within(screen.getByTestId('card-Token do GitHub')).getByRole('button', { name: 'Salvar e continuar' })).toBeTruthy();

    expect(await screen.findByRole('heading', { name: 'Projeto' })).toBeTruthy();
    expect(screen.getByText('9 agentes')).toBeTruthy();
    await openModelsCollapse();
  });

  it('shows every agent on automatic and saves a manual pick with the default model and effort', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents });
    const setAgent = vi.spyOn(settingsApi, 'setAgent').mockResolvedValue({ setting: null });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    const mode = await openModelsCollapse();
    expect((mode as HTMLSelectElement).value).toBe('auto');
    expect(screen.queryByLabelText('Modelo de Desenvolvedor')).toBeNull();

    fireEvent.change(mode, { target: { value: 'manual' } });
    await waitFor(() => expect(setAgent).toHaveBeenCalledWith('demo', 'dev', { mode: 'manual', model: 'claude-sonnet-5-5', effort: 'medium' }));
    expect(await screen.findByLabelText('Modelo de Desenvolvedor')).toBeTruthy();
  });

  it('saves each change of model or effort for a manual agent', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents: agents.map((a) => (a.role === 'sec' ? { role: 'sec', setting: { model: 'claude-opus-5-5', effort: 'max' } } : a)) });
    const setAgent = vi.spyOn(settingsApi, 'setAgent').mockResolvedValue({ setting: null });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    await openModelsCollapse();
    expect(await screen.findByLabelText('Modelo de Segurança')).toBeTruthy();
    expect((screen.getByLabelText('Modelo de Segurança') as HTMLSelectElement).value).toBe('claude-opus-5-5');
    fireEvent.change(screen.getByLabelText('Esforço de Segurança'), { target: { value: 'high' } });
    await waitFor(() => expect(setAgent).toHaveBeenLastCalledWith('demo', 'sec', { mode: 'manual', model: 'claude-opus-5-5', effort: 'high' }));
  });

  it('shows the save error and reads the agents again from the server when a save fails', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    const list = vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents });
    vi.spyOn(settingsApi, 'setAgent').mockRejectedValue(new Error('offline'));
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    fireEvent.change(await openModelsCollapse(), { target: { value: 'manual' } });
    expect(await screen.findByText('Não foi possível salvar. Tente novamente.')).toBeTruthy();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});
