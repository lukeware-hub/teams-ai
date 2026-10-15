import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runApi, settingsApi, type ProjectRow } from '../api.js';
import { SettingsPage } from './Settings.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const project = { projectId: 'demo', name: 'Demo' } as ProjectRow;
const agents = ['sm', 'po', 'front', 'dev', 'test', 'sec', 'devops', 'env'].map((role) => ({ role, setting: null }));

describe('SettingsPage', () => {
  it('shows every agent on automatic and saves a manual pick with the default model and effort', async () => {
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents });
    const setAgent = vi.spyOn(settingsApi, 'setAgent').mockResolvedValue({ setting: null });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    const mode = await screen.findByLabelText('Modo de Desenvolvedor');
    expect((mode as HTMLSelectElement).value).toBe('auto');
    expect(screen.queryByLabelText('Modelo de Desenvolvedor')).toBeNull();

    fireEvent.change(mode, { target: { value: 'manual' } });
    await waitFor(() => expect(setAgent).toHaveBeenCalledWith('demo', 'dev', { mode: 'manual', model: 'claude-sonnet-5-5', effort: 'medium' }));
    expect(await screen.findByLabelText('Modelo de Desenvolvedor')).toBeTruthy();
  });

  it('saves each change of model or effort for a manual agent', async () => {
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents: agents.map((a) => (a.role === 'sec' ? { role: 'sec', setting: { model: 'claude-opus-5-5', effort: 'max' } } : a)) });
    const setAgent = vi.spyOn(settingsApi, 'setAgent').mockResolvedValue({ setting: null });
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    expect(await screen.findByLabelText('Modelo de Segurança')).toBeTruthy();
    expect((screen.getByLabelText('Modelo de Segurança') as HTMLSelectElement).value).toBe('claude-opus-5-5');
    fireEvent.change(screen.getByLabelText('Esforço de Segurança'), { target: { value: 'high' } });
    await waitFor(() => expect(setAgent).toHaveBeenLastCalledWith('demo', 'sec', { mode: 'manual', model: 'claude-opus-5-5', effort: 'high' }));
  });

  it('shows the save error and reads the agents again from the server when a save fails', async () => {
    vi.spyOn(runApi, 'projects').mockResolvedValue([project]);
    const list = vi.spyOn(settingsApi, 'agents').mockResolvedValue({ agents });
    vi.spyOn(settingsApi, 'setAgent').mockRejectedValue(new Error('offline'));
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    fireEvent.change(await screen.findByLabelText('Modo de Desenvolvedor'), { target: { value: 'manual' } });
    expect(await screen.findByText('Não foi possível salvar. Tente novamente.')).toBeTruthy();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});
