import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeUsage, UsageLimit } from '@server/usage/claude-usage';
import { usageApi } from '../api.js';
import { ClaudeUsagePanel } from './ClaudeUsage.js';

// Local time, so the expected clock and weekday texts hold in any time zone.
const NOW = new Date(2026, 9, 23, 18, 0);
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();

const session = (over: Partial<UsageLimit> = {}): UsageLimit => ({ kind: 'session', label: null, percent: 84, severity: 'warning', resetsAt: at(23, 20, 10), allowancePercent: null, ...over });
const weekly = (over: Partial<UsageLimit> = {}): UsageLimit => ({ kind: 'weekly_all', label: null, percent: 40, severity: 'normal', resetsAt: at(26, 9), allowancePercent: null, ...over });
const scoped = (over: Partial<UsageLimit> = {}): UsageLimit => ({ kind: 'weekly_scoped', label: 'Fable', percent: 0, severity: 'normal', resetsAt: at(26, 9), allowancePercent: 50, ...over });
const plan = (...limits: UsageLimit[]): ClaudeUsage => ({ available: true, plan: 'Max (5x)', limits });

beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(usageApi, 'jev').mockResolvedValue({ costUsd: 0.00714 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ClaudeUsagePanel', () => {
  it('shows the plan, each meter with its reset, percent and bar', async () => {
    vi.spyOn(usageApi, 'claude').mockResolvedValue(plan(session(), weekly({ percent: 62 }), scoped()));
    render(<ClaudeUsagePanel />);

    expect(await screen.findByText('Max (5x)')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Seu uso' })).toBeTruthy();
    expect(screen.getByText('Sessão atual')).toBeTruthy();
    expect(screen.getByText('Redefine às 20:10')).toBeTruthy();
    expect(screen.getByText('84% usado')).toBeTruthy();
    expect(screen.getByText('Fable')).toBeTruthy();
    expect(screen.getByText('Até 50% do seu limite semanal')).toBeTruthy();
    expect(screen.getAllByText('Reinicia segunda-feira, 09:00')).toHaveLength(2);
    expect(screen.getByRole('progressbar', { name: 'Sessão atual' }).getAttribute('aria-valuenow')).toBe('84');
    expect(screen.getByRole('progressbar', { name: 'Esta semana' }).getAttribute('aria-valuenow')).toBe('62');
    expect(screen.getByRole('progressbar', { name: 'Fable' }).getAttribute('aria-valuenow')).toBe('0');
  });

  it('colours each bar by the severity the server sent', async () => {
    vi.spyOn(usageApi, 'claude').mockResolvedValue(plan(session({ severity: 'critical', percent: 97 }), weekly({ severity: 'warning', percent: 70 })));
    render(<ClaudeUsagePanel />);

    await screen.findByText('97% usado');
    expect(screen.getByRole('progressbar', { name: 'Sessão atual' }).firstElementChild?.className).toContain('bg-bad');
    expect(screen.getByRole('progressbar', { name: 'Esta semana' }).firstElementChild?.className).toContain('bg-warn');
  });

  it('shows the Jev total cost across all projects under the limits', async () => {
    vi.spyOn(usageApi, 'claude').mockResolvedValue(plan(session(), weekly()));
    render(<ClaudeUsagePanel />);

    expect(await screen.findByText('Custo Jev')).toBeTruthy();
    expect(screen.getByText('US$ 0,0071')).toBeTruthy();
  });

  it('leaves the Jev total out when it cannot be read, and keeps the plan', async () => {
    vi.spyOn(usageApi, 'jev').mockRejectedValue(new Error('offline'));
    vi.spyOn(usageApi, 'claude').mockResolvedValue(plan(session(), weekly()));
    render(<ClaudeUsagePanel />);

    expect(await screen.findByText('84% usado')).toBeTruthy();
    expect(screen.queryByText('Custo Jev')).toBeNull();
  });

  it('says the week is on pace when the share used stays under the share of the week gone', async () => {
    vi.spyOn(usageApi, 'claude').mockResolvedValue(plan(session({ percent: 10 }), weekly({ percent: 40 })));
    render(<ClaudeUsagePanel />);

    expect(await screen.findByText('Dentro do previsto. Você deve chegar à redefinição de segunda-feira com folga.')).toBeTruthy();
  });

  it('says the week runs out before the reset when the share used is above the share of the week gone', async () => {
    vi.spyOn(usageApi, 'claude').mockResolvedValue(plan(session({ percent: 10 }), weekly({ percent: 80 })));
    render(<ClaudeUsagePanel />);

    expect(await screen.findByText('Acima do previsto. No ritmo atual, o limite semanal acaba antes da redefinição de segunda-feira.')).toBeTruthy();
  });

  it('says the limit is reached when a meter is full', async () => {
    vi.spyOn(usageApi, 'claude').mockResolvedValue(plan(session({ percent: 100 }), weekly()));
    render(<ClaudeUsagePanel />);

    expect(await screen.findByText('Limite atingido. As execuções ficam pausadas até a renovação.')).toBeTruthy();
  });

  it.each([
    ['not-logged-in', 'Entre no Claude pelo Login do Claude, acima, para ver o seu uso.'],
    ['renewing', 'O login do Claude está perto de vencer e é renovado na próxima execução de um agente.'],
    ['no-plan', 'Este login não tem um plano Claude com limites de uso.'],
    ['api-key', 'Os agentes usam uma chave de API, que não tem limite de sessão nem semanal.'],
    ['failed', 'Não foi possível ler o seu uso agora. Tente de novo em instantes.'],
  ] as const)('explains the %s state in plain words', async (reason, text) => {
    vi.spyOn(usageApi, 'claude').mockResolvedValue({ available: false, reason });
    render(<ClaudeUsagePanel />);

    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('shows a loading state until the first read answers', () => {
    vi.spyOn(usageApi, 'claude').mockReturnValue(new Promise(() => {}));
    render(<ClaudeUsagePanel />);

    expect(screen.getByRole('status').textContent).toContain('Carregando');
  });

  it('explains a first read that fails', async () => {
    vi.spyOn(usageApi, 'claude').mockRejectedValue(new Error('offline'));
    render(<ClaudeUsagePanel />);

    expect(await screen.findByText('Não foi possível ler o seu uso agora. Tente de novo em instantes.')).toBeTruthy();
  });

  it('reads again every minute and keeps the last numbers when a read fails', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    const claude = vi.spyOn(usageApi, 'claude').mockResolvedValueOnce(plan(session())).mockRejectedValueOnce(new Error('offline'));
    render(<ClaudeUsagePanel />);
    await act(async () => {});
    expect(screen.getByText('84% usado')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(claude).toHaveBeenCalledTimes(2);
    expect(screen.getByText('84% usado')).toBeTruthy();
  });

  it('shows the last reading at once after a reload, before the next read answers', async () => {
    const claude = vi.spyOn(usageApi, 'claude').mockResolvedValueOnce(plan(session())).mockReturnValueOnce(new Promise(() => {}));
    const before = render(<ClaudeUsagePanel />);
    await screen.findByText('84% usado');
    before.unmount();

    render(<ClaudeUsagePanel />);
    expect(screen.getByText('84% usado')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(claude).toHaveBeenCalledTimes(2);
  });
});
