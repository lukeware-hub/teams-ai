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

const automatic = { tiers: { small: 'claude-haiku-5-5', medium: 'claude-sonnet-5-5', large: 'claude-sonnet-5-5' }, architecture: 'claude-opus-5-5', laterCycle: 'claude-sonnet-5-5' } as const;

function mockEnv() {
  vi.spyOn(settingsApi, 'planAgents').mockResolvedValue({ agents: 5 });
  vi.spyOn(settingsApi, 'automatic').mockResolvedValue(automatic);
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
  it('lists only registered projects, never one still in refinement', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    vi.spyOn(refineApi, 'list').mockResolvedValue([{ projectId: 'kayron-hub', specId: 'kayron-hub-001', state: 'drafting' }] as never);
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(await screen.findByRole('option', { name: 'Demo' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'kayron-hub' })).toBeNull();
    expect(refineApi.list).not.toHaveBeenCalled();
  });

  it('shows the global environment collapses separate from project agents', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    expect(await screen.findByRole('heading', { name: 'Configuração Global do Ambiente' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'Seu uso de tokens' })).toBeTruthy();
    for (const title of ['Login do GitHub CLI', 'Token do GitHub', 'Organização do GitHub', 'Login do Claude', 'Chave do OpenRouter (Jev)']) {
      expect(screen.getByText(title, { selector: '.settings-collapse-title' })).toBeTruthy();
    }
    expect(screen.queryByTestId('card-Token do GitHub')).toBeNull();

    fireEvent.click(screen.getByText('Token do GitHub', { selector: '.settings-collapse-title' }));
    expect(await screen.findByTestId('card-Token do GitHub')).toBeTruthy();
    expect(within(screen.getByTestId('card-Token do GitHub')).getByRole('button', { name: 'Salvar e continuar' })).toBeTruthy();

    expect(await screen.findByRole('heading', { name: 'Configurações por Projetos' })).toBeTruthy();
    expect(screen.getByText('8 agentes')).toBeTruthy();
    await openModelsCollapse();
  });

  it('orders the cards as usage, projects, then global environment', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    const usage = await screen.findByRole('heading', { name: 'Seu uso de tokens' });
    const projects = await screen.findByRole('heading', { name: 'Configurações por Projetos' });
    const environment = await screen.findByRole('heading', { name: 'Configuração Global do Ambiente' });
    expect(usage.compareDocumentPosition(projects) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(projects.compareDocumentPosition(environment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the automatic models once for every project and saves a change to the architecture model', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents });
    const save = vi.spyOn(settingsApi, 'setAutomatic').mockResolvedValue({ ...automatic, architecture: 'claude-sonnet-5-5' } as never);
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    const select = (await screen.findByLabelText('Arquitetura')) as HTMLSelectElement;
    expect(select.value).toBe('claude-opus-5-5');
    expect(screen.getByLabelText('Tarefa pequena')).toBeTruthy();
    expect(screen.getByLabelText('Refinamento, ciclos seguintes')).toBeTruthy();
    fireEvent.change(select, { target: { value: 'claude-sonnet-5-5' } });
    await waitFor(() => expect(save).toHaveBeenCalledWith({ ...automatic, architecture: 'claude-sonnet-5-5' }));
  });

  it('shows the chat and graphify settings beside the agents, on a fixed model and effort with no automatic choice', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    const slots = [
      { role: 'chat', setting: { model: 'claude-haiku-5-5', effort: 'low' }, inUse: { model: 'claude-haiku-5-5', effort: 'low' } },
      { role: 'graphify', setting: { model: 'claude-sonnet-5-5', effort: 'low' }, inUse: { model: 'claude-sonnet-5-5', effort: 'low' } },
    ];
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents: [...agents, ...slots] as never });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await openModelsCollapse();
    expect(await screen.findByLabelText('Modelo de Chat')).toBeTruthy();
    expect(screen.getByLabelText('Esforço de Chat')).toBeTruthy();
    expect(screen.getByLabelText('Modelo de Graphify')).toBeTruthy();
    expect(screen.getByLabelText('Esforço de Graphify')).toBeTruthy();
    expect(screen.queryByLabelText('Modo de Chat')).toBeNull();
    expect(screen.queryByLabelText('Modo de Graphify')).toBeNull();
    expect(screen.getByTestId('in-use-graphify').textContent).toBe('Em uso agora: Sonnet 5.5 · Baixo');
  });

  it('saves a new graphify effort with its model', async () => {
    mockEnv();
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    const graphify = { role: 'graphify', setting: { model: 'claude-sonnet-5-5', effort: 'low' }, inUse: { model: 'claude-sonnet-5-5', effort: 'low' } };
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents: [...agents, graphify] as never });
    const setAgent = vi.spyOn(settingsApi, 'setAgent').mockResolvedValue({ setting: null, inUse: { model: 'claude-sonnet-5-5', effort: 'high' } });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    await openModelsCollapse();
    fireEvent.change(await screen.findByLabelText('Esforço de Graphify'), { target: { value: 'high' } });
    await waitFor(() => expect(setAgent).toHaveBeenCalledWith('demo', 'graphify', { mode: 'manual', model: 'claude-sonnet-5-5', effort: 'high' }));
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

    fireEvent.click(await screen.findByText('Configura para Refinamento', { selector: '.settings-collapse-title' }));
    const agents = (await screen.findByLabelText('Quantidade de agentes')) as HTMLInputElement;
    await waitFor(() => expect(agents.value).toBe('5'));
    const save = within(agents.closest('form')!).getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;
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
