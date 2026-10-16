import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type Item, type Status } from '../api.js';
import { AppShell } from '../components/AppShell.js';
import { LicenseGuard } from './LicenseGuard.js';

const item = (ok: boolean, detail: string): Item => ({ ok, detail });
const status = (): Status => ({
  items: {
    claude: item(false, 'not logged in'),
    githubOwner: item(false, 'GitHub owner not set'),
    ghLogin: item(false, 'gh is not logged in'),
    githubToken: item(false, 'GITHUB_TOKEN not set'),
    openrouterKey: item(false, 'OPENROUTER_API_KEY not set'),
  },
  allOk: false,
});

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderGuard() {
  return render(
    <MemoryRouter>
      <LicenseGuard>
        <p>app aberto</p>
      </LicenseGuard>
    </MemoryRouter>,
  );
}

describe('license gate', () => {
  it('asks for the license key before the rest of onboarding', async () => {
    vi.spyOn(api, 'license').mockResolvedValue({ state: 'missing' });
    vi.spyOn(api, 'status').mockResolvedValue(status());
    const activate = vi.spyOn(api, 'activateLicense').mockResolvedValue({ state: 'authorized' });
    renderGuard();
    const card = await screen.findByTestId('card-Licença do Teams AI');
    expect(screen.queryByText('app aberto')).toBeNull();
    fireEvent.change(within(card).getByLabelText('Cole a chave de licença'), { target: { value: 'secret-key' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Ativar' }));
    await waitFor(() => expect(activate).toHaveBeenCalledWith('secret-key'));
    expect(screen.queryByDisplayValue('secret-key')).toBeNull();
    await screen.findByTestId('card-Login do GitHub CLI');
  });

  it('shows the Lukeware contacts when access is turned off', async () => {
    vi.spyOn(api, 'license').mockResolvedValue({ state: 'revoked', contactEmail: 'admin@lukeware.com', contactPhone: '+55 11 0000-0000' });
    renderGuard();
    expect(await screen.findByRole('heading', { name: 'Acesso desativado' })).toBeTruthy();
    expect(screen.getByText('Seu acesso foi desativado. Entre em contato com a administração da Lukeware por e-mail ou telefone para solicitar a reativação.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'admin@lukeware.com' }).getAttribute('href')).toBe('mailto:admin@lukeware.com');
    expect(screen.getByRole('link', { name: '+55 11 0000-0000' }).getAttribute('href')).toBe('tel:+55110000-0000');
    expect(screen.queryByText('app aberto')).toBeNull();
  });

  it('hides the rail when access is turned off and keeps the footer outside the content', async () => {
    vi.spyOn(api, 'license').mockResolvedValue({ state: 'revoked', contactEmail: 'admin@lukeware.com', contactPhone: '+55 11 0000-0000' });
    render(
      <MemoryRouter>
        <AppShell>
          <LicenseGuard>
            <p>app aberto</p>
          </LicenseGuard>
        </AppShell>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Acesso desativado' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Navegação principal' })).toBeNull();
    expect(document.getElementById('main')?.contains(screen.getByRole('contentinfo'))).toBe(false);
  });

  it('hides the rail when the license service does not answer', async () => {
    vi.spyOn(api, 'license').mockResolvedValue({ state: 'unavailable' });
    render(
      <MemoryRouter>
        <AppShell>
          <LicenseGuard>
            <p>app aberto</p>
          </LicenseGuard>
        </AppShell>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Licença indisponível' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Navegação principal' })).toBeNull();
  });

  it('blocks the app while the license service does not answer and retries', async () => {
    const license = vi.spyOn(api, 'license').mockResolvedValue({ state: 'unavailable' });
    const activate = vi.spyOn(api, 'activateLicense').mockResolvedValue({ state: 'authorized' });
    renderGuard();
    const message = 'Não foi possível confirmar sua licença. O Teams AI volta a funcionar quando o serviço de licenças responder.';
    expect(await screen.findByText(message)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(license).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('app aberto')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Registrar licença' }));
    fireEvent.change(screen.getByLabelText('Cole a chave de licença'), { target: { value: 'secret-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ativar' }));
    await waitFor(() => expect(activate).toHaveBeenCalledWith('secret-key'));
    expect(await screen.findByText('app aberto')).toBeTruthy();
    expect(screen.queryByText(message)).toBeNull();
  });

  it('asks the license service again while a screen stays open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const license = vi.spyOn(api, 'license')
      .mockResolvedValueOnce({ state: 'authorized' })
      .mockResolvedValueOnce({ state: 'revoked', contactEmail: 'admin@lukeware.com', contactPhone: '+55 11 0000-0000' });
    renderGuard();
    expect(await screen.findByText('app aberto')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(await screen.findByRole('heading', { name: 'Acesso desativado' })).toBeTruthy();
    expect(license).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('blocks a license bound to another computer', async () => {
    vi.spyOn(api, 'license').mockResolvedValue({ state: 'other-machine' });
    renderGuard();
    expect(await screen.findByRole('heading', { name: 'Licença de outro computador' })).toBeTruthy();
    expect(screen.queryByText('app aberto')).toBeNull();
    expect(screen.queryByLabelText('Cole a chave de licença')).toBeNull();
  });

  it('opens the app when the license is authorized', async () => {
    vi.spyOn(api, 'license').mockResolvedValue({ state: 'authorized' });
    renderGuard();
    expect(await screen.findByText('app aberto')).toBeTruthy();
  });

  it('asks for a new key on the open screen when the license no longer exists', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const license = vi.spyOn(api, 'license')
      .mockResolvedValueOnce({ state: 'authorized' })
      .mockResolvedValue({ state: 'missing' });
    vi.spyOn(api, 'status').mockResolvedValue(status());
    renderGuard();
    expect(await screen.findByText('app aberto')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(license).toHaveBeenCalledTimes(2);
    expect(await screen.findByLabelText('Cole a chave de licença')).toBeTruthy();
    expect(screen.queryByText('app aberto')).toBeNull();
    vi.useRealTimers();
  });

  it('asks again when the open screen becomes visible', async () => {
    const license = vi.spyOn(api, 'license')
      .mockResolvedValueOnce({ state: 'authorized' })
      .mockResolvedValue({ state: 'missing' });
    vi.spyOn(api, 'status').mockResolvedValue(status());
    renderGuard();
    expect(await screen.findByText('app aberto')).toBeTruthy();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await screen.findByLabelText('Cole a chave de licença')).toBeTruthy();
    expect(license.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('app aberto')).toBeNull();
  });
});
