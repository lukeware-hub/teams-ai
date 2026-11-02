import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ClosingSummary } from '../api.js';
import { ClosingDialog } from './ClosingDialog.js';

const summary = (ok: boolean): ClosingSummary => ({
  ok,
  checks: [
    { id: 'documents', ok: true, detail: 'os cinco documentos estão concluídos e no grafo' },
    { id: 'plans', ok, detail: ok ? 'cada item tem o seu plano' : 'sem plano: cart' },
  ],
  repositories: [{ name: 'shop-api', specs: 2, plans: 2, tasks: 5 }],
  assumptions: ['cart: o carrinho guarda por sessão', 'catalog: sem paginação'],
  summaryHash: 'sha256:abc',
});

describe('closing dialog', () => {
  it('lets the owner authorize with the summary hash when every check passes', () => {
    const onAuthorize = vi.fn();
    render(<ClosingDialog summary={summary(true)} busy={false} onCancel={() => {}} onAuthorize={onAuthorize} />);
    const button = screen.getByTestId('closing-authorize');
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(onAuthorize).toHaveBeenCalledWith('sha256:abc');
  });

  it('keeps the authorization open when a check fails, and lists the failing check with its detail', () => {
    const onAuthorize = vi.fn();
    render(<ClosingDialog summary={summary(false)} busy={false} onCancel={() => {}} onAuthorize={onAuthorize} />);
    const button = screen.getByTestId('closing-authorize');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('close-plans').textContent).toContain('sem plano: cart');
    expect(screen.getByRole('status').textContent).toContain('Itens reprovados não travam o início');
    fireEvent.click(button);
    expect(onAuthorize).toHaveBeenCalledWith('sha256:abc');
  });

  it('counts the assumptions taken and lists each repository with its counts', () => {
    render(<ClosingDialog summary={summary(true)} busy={false} onCancel={() => {}} onAuthorize={() => {}} />);
    expect(screen.getByText('Premissas assumidas (2)')).toBeTruthy();
    expect(screen.getByTestId('closing-repositories').textContent).toContain('shop-api');
  });

  it('cancels without authorizing', () => {
    const onCancel = vi.fn();
    const onAuthorize = vi.fn();
    render(<ClosingDialog summary={summary(true)} busy={false} onCancel={onCancel} onAuthorize={onAuthorize} />);
    fireEvent.click(screen.getByTestId('closing-cancel'));
    expect(onCancel).toHaveBeenCalled();
    expect(onAuthorize).not.toHaveBeenCalled();
  });
});
