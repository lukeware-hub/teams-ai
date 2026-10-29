import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, refineApi, runApi, settingsApi, usageApi, type Item, type ProjectRow, type Status } from '../api.js';
import { SettingsPage } from './Settings.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const project = { projectId: 'demo', name: 'Demo' } as ProjectRow;
const sonnetLow = { model: 'claude-sonnet-5-5', effort: 'low' } as const;
const agents = ['sm', 'po', 'front', 'dev', 'test', 'sec', 'devops', 'env'].map((role) => ({ role, setting: null, inUse: sonnetLow }));
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
  vi.spyOn(settingsApi, 'planAgents').mockResolvedValue({ agents: 5 });
  vi.spyOn(api, 'status').mockResolvedValue(envStatus());
  vi.spyOn(api, 'organizations').mockResolvedValue({ organizations: ['acme'], owner: 'acme' });
  vi.spyOn(usageApi, 'claude').mockResolvedValue({ available: false, reason: 'not-logged-in' });
}

async function openModelsCollapse() {
  expect(await screen.findByText('Modelos e esforço', { selector: '.settings-collapse-title' })).toBeTruthy();
  expect(screen.queryByLabelText('Modo de Desenvolvedor')).toBeNull();
  fireEvent.click(screen.getByText('Modelos e esforço', { selector: '.settings-collapse-title' }));
  return screen.findByLabelText('Modo de Desenvolvedor');
}

describe('SettingsPage', () => {
  it('lists a project in refinement, so its agents can be configured before it is registered', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([]);
    vi.spyOn(refineApi, 'list').mockResolvedValue([{ projectId: 'kayron-hub', specId: 'kayron-hub-001', state: 'drafting' }] as never);
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(await screen.findByRole('option', { name: 'kayron-hub' })).toBeTruthy();
    await waitFor(() => expect(settingsApi.agents).toHaveBeenCalledWith('kayron-hub'));
  });

  it('shows the global environment collapses separate from project agents', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Ambiente' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Seu uso' })).toBeTruthy();
    for (const title of ['Login do GitHub CLI', 'Token do GitHub', 'Organização do GitHub', 'Login do Claude', 'Chave do OpenRouter (Jev)']) {
      expect(screen.getByText(title, { selector: '.settings-collapse-title' })).toBeTruthy();
    }
    expect(screen.queryByTestId('card-Token do GitHub')).toBeNull();

    fireEvent.click(screen.getByText('Token do GitHub', { selector: '.settings-collapse-title' }));
    expect(await screen.findByTestId('card-Token do GitHub')).toBeTruthy();
    expect(within(screen.getByTestId('card-Token do GitHub')).getByRole('button', { name: 'Salvar e continuar' })).toBeTruthy();

    expect(await screen.findByRole('heading', { name: 'Projeto' })).toBeTruthy();
    expect(screen.getByText('8 agentes')).toBeTruthy();
    await openModelsCollapse();
  });

  it('shows every agent on automatic and saves a manual pick with the default model and effort', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents });
    const setAgent = vi.spyOn(settingsApi, 'setAgent').mockResolvedValue({ setting: null, inUse: sonnetLow });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    const mode = await openModelsCollapse();
    expect((mode as HTMLSelectElement).value).toBe('auto');
    expect(screen.queryByLabelText('Modelo de Desenvolvedor')).toBeNull();

    fireEvent.change(mode, { target: { value: 'manual' } });
    await waitFor(() => expect(setAgent).toHaveBeenCalledWith('demo', 'dev', { mode: 'manual', model: 'claude-haiku-5-5', effort: 'low' }));
    expect(await screen.findByLabelText('Modelo de Desenvolvedor')).toBeTruthy();
  });

  it('shows the model and effort in use for a manual agent and for an automatic one', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({
      agents: agents.map((a) => (a.role === 'sec' ? { role: 'sec', setting: { model: 'claude-opus-5-5', effort: 'max' }, inUse: { model: 'claude-opus-5-5', effort: 'max' } } : a)),
    });
    const setAgent = vi.spyOn(settingsApi, 'setAgent').mockResolvedValue({ setting: null, inUse: sonnetLow });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    await openModelsCollapse();
    expect(screen.getByTestId('in-use-sec').textContent).toBe('Em uso agora: Opus 5.5 · Máximo');
    expect(screen.getByTestId('in-use-dev').textContent).toBe('Em uso agora: Sonnet 5.5 · Baixo');
    expect(screen.getByLabelText('Modo de Desenvolvedor').closest('li')!.textContent).toContain('Orquestrador escolhe');

    fireEvent.change(screen.getByLabelText('Modo de Segurança'), { target: { value: 'auto' } });
    await waitFor(() => expect(setAgent).toHaveBeenCalledWith('demo', 'sec', { mode: 'auto' }));
    await waitFor(() => expect(screen.getByTestId('in-use-sec').textContent).toBe('Em uso agora: Sonnet 5.5 · Baixo'));
  });

  it('saves each change of model or effort for a manual agent', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents: agents.map((a) => (a.role === 'sec' ? { role: 'sec', setting: { model: 'claude-opus-5-5', effort: 'max' }, inUse: { model: 'claude-opus-5-5', effort: 'max' } } : a)) });
    const setAgent = vi.spyOn(settingsApi, 'setAgent').mockResolvedValue({ setting: null, inUse: sonnetLow });
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

  it('shows the time limit of a project in minutes and saves a new one', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents });
    vi.spyOn(settingsApi, 'stepTimeout').mockResolvedValue({ timeoutMinutes: 20 });
    const setStepTimeout = vi.spyOn(settingsApi, 'setStepTimeout').mockResolvedValue({ timeoutMinutes: 45 });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    fireEvent.click(await screen.findByText('Tempo limite', { selector: '.settings-collapse-title' }));
    const minutes = (await screen.findByLabelText('Minutos por passo')) as HTMLInputElement;
    await waitFor(() => expect(minutes.value).toBe('20'));
    const save = within(minutes.closest('form')!).getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(minutes, { target: { value: '45' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(setStepTimeout).toHaveBeenCalledWith('demo', 45));
  });

  it('saves whether the agents of a project decide its blocks', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents });
    vi.spyOn(settingsApi, 'agentsDecide').mockResolvedValue({ agentsDecide: false });
    const setAgentsDecide = vi.spyOn(settingsApi, 'setAgentsDecide').mockResolvedValue({ agentsDecide: true });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    fireEvent.click(await screen.findByText('Autonomia dos agentes', { selector: '.settings-collapse-title' }));
    const decide = (await screen.findByLabelText('Autorizo os agentes a tomar decisões?')) as HTMLSelectElement;
    await waitFor(() => expect(decide.value).toBe('no'));
    fireEvent.change(decide, { target: { value: 'yes' } });
    await waitFor(() => expect(setAgentsDecide).toHaveBeenCalledWith('demo', true));
    await waitFor(() => expect(decide.value).toBe('yes'));
  });

  it('shows how many agents prepare the plan and saves a count from 1 to 5', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([]);
    const setPlanAgents = vi.spyOn(settingsApi, 'setPlanAgents').mockResolvedValue({ agents: 2 });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    const card = await screen.findByRole('region', { name: 'Preparação dos planos' });
    const agents = within(card).getByLabelText('Agentes em paralelo') as HTMLInputElement;
    await waitFor(() => expect(agents.value).toBe('5'));
    const save = within(card).getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;
    fireEvent.change(agents, { target: { value: '6' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(agents, { target: { value: '2' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(setPlanAgents).toHaveBeenCalledWith(2));
  });

  it('does not save a time limit that is not a whole number of minutes', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents });
    vi.spyOn(settingsApi, 'stepTimeout').mockResolvedValue({ timeoutMinutes: 20 });
    const setStepTimeout = vi.spyOn(settingsApi, 'setStepTimeout').mockResolvedValue({ timeoutMinutes: 20 });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    fireEvent.click(await screen.findByText('Tempo limite', { selector: '.settings-collapse-title' }));
    const minutes = (await screen.findByLabelText('Minutos por passo')) as HTMLInputElement;
    await waitFor(() => expect(minutes.value).toBe('20'));
    fireEvent.change(minutes, { target: { value: '1.5' } });
    expect((within(minutes.closest('form')!).getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(true);
    expect(setStepTimeout).not.toHaveBeenCalled();
  });
});
