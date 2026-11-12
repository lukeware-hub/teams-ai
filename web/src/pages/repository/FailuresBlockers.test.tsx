import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runApi, type DashboardItem } from '../../api.js';
import { queryPage } from '@server/api/paging.js';
import { FailuresBlockers } from './FailuresBlockers.js';

const secret = (name: string, extra: Partial<NonNullable<DashboardItem['secret']>> = {}): DashboardItem => ({ kind: 'secret', specId: null, runId: null, taskId: null, text: `Segredo ${name} não está no cofre`, secret: { name, what: null, purpose: null, usage: null, mentions: [], ...extra } });
const ROWS: DashboardItem[] = [
  secret('A_KEY', { what: 'Chave de API', purpose: 'Cobrar clientes', usage: 'Serviço de cobrança' }),
  secret('B_KEY'),
  { kind: 'question', specId: null, runId: null, taskId: null, text: 'Quem paga?' },
];
const serve = vi.fn((_p: string, _r: string, _t: string, req: Parameters<typeof queryPage>[2]) => Promise.resolve(queryPage(ROWS, {}, req)));

afterEach(() => vi.restoreAllMocks());

const open = async () => {
  vi.spyOn(runApi, 'repositoryDashboardTable').mockImplementation(serve as never);
  render(<MemoryRouter><FailuresBlockers projectId="kayron" repo="shop" failures={0} blockers={3} /></MemoryRouter>);
  await waitFor(() => screen.getByTestId('repo-blockers-secret-A_KEY'));
};

describe('FailuresBlockers secrets', () => {
  it('shows what a secret is, what it is for and where it is used, and only what is known', async () => {
    await open();
    const facts = screen.getByTestId('repo-blockers-secret-A_KEY-facts');
    expect(facts.textContent).toContain('Chave de API');
    expect(facts.textContent).toContain('Cobrar clientes');
    expect(facts.textContent).toContain('Serviço de cobrança');
    expect(screen.queryByTestId('repo-blockers-secret-B_KEY-facts')).toBeNull();
    expect(screen.getByTestId('repo-blockers-item-question--')).toBeTruthy();
  });

  it('saves the value, clears the field and asks for the list again', async () => {
    const save = vi.spyOn(runApi, 'saveSecret').mockResolvedValue({ present: true });
    await open();
    const input = screen.getByTestId('repo-blockers-secret-A_KEY-input') as HTMLInputElement;
    expect((screen.getByTestId('repo-blockers-secret-A_KEY-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'valor-bem-longo-123' } });
    fireEvent.click(screen.getByTestId('repo-blockers-secret-A_KEY-save'));
    await waitFor(() => expect(save).toHaveBeenCalledWith('kayron', 'A_KEY', 'valor-bem-longo-123'));
    await waitFor(() => expect(input.value).toBe(''));
    await waitFor(() => expect(serve.mock.calls.length).toBeGreaterThan(1));
  });

  it('keeps the typed value and shows the error when the save fails', async () => {
    vi.spyOn(runApi, 'saveSecret').mockRejectedValue(new Error('não foi possível salvar'));
    await open();
    const input = screen.getByTestId('repo-blockers-secret-A_KEY-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'valor-bem-longo-123' } });
    fireEvent.click(screen.getByTestId('repo-blockers-secret-A_KEY-save'));
    await waitFor(() => expect(screen.getByTestId('repo-blockers-secret-A_KEY-error').textContent).toBe('não foi possível salvar'));
    expect(input.value).toBe('valor-bem-longo-123');
  });
});
