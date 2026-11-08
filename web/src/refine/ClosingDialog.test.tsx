import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryPage, type PageRequest } from '@server/api/paging.js';
import { refineApi, type ClosingSummary } from '../api.js';
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

afterEach(() => vi.restoreAllMocks());

/** The server's page of the repositories; the dialog asks for it. */
const serveRepos = (req: PageRequest) => queryPage(summary(true).repositories, { text: (r) => [r.name] }, req);

describe('closing dialog', () => {
  it('marks each check with a drawn icon and gives a failing one the warning tone', () => {
    render(<ClosingDialog projectId="kayron" specId="kayron-001" summary={summary(false)} busy={false} onCancel={() => {}} onAuthorize={() => {}} />);
    expect(screen.getByTestId('closing-check-mark-documents').querySelector('svg')).toBeTruthy();
    expect(screen.getByTestId('close-plans').className).toContain('text-warn');
    expect(screen.getByTestId('close-documents').className).not.toContain('text-warn');
    expect(screen.getByTestId('closing-check-detail-documents').className).toContain('first-letter:uppercase');
  });

  it('keeps Cancelar before the primary in one footer, and opens as the large dialog that becomes a sheet on a phone', () => {
    render(<ClosingDialog projectId="kayron" specId="kayron-001" summary={summary(true)} busy={false} onCancel={() => {}} onAuthorize={() => {}} />);
    const buttons = [...screen.getByTestId('closing-actions').querySelectorAll('button')].map((b) => b.dataset.testid);
    expect(buttons).toEqual(['closing-cancel', 'closing-authorize']);
    expect(screen.getByTestId('closing-actions').className).toContain('sticky');
    expect(screen.getByTestId('dialog').className).toContain('dialog-large');
  });

  it('keeps the count headers on one line', async () => {
    vi.spyOn(refineApi, 'closingRepositories').mockImplementation((_p, _s, req) => Promise.resolve(serveRepos(req)));
    render(<ClosingDialog projectId="kayron" specId="kayron-001" summary={summary(true)} busy={false} onCancel={() => {}} onAuthorize={() => {}} />);
    for (const col of ['specs', 'plans', 'tasks']) expect((await screen.findByTestId(`closing-repos-col-${col}`)).className).toContain('whitespace-nowrap');
  });

  it('lets the owner authorize with the summary hash when every check passes', () => {
    const onAuthorize = vi.fn();
    render(<ClosingDialog projectId="kayron" specId="kayron-001" summary={summary(true)} busy={false} onCancel={() => {}} onAuthorize={onAuthorize} />);
    const button = screen.getByTestId('closing-authorize');
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(onAuthorize).toHaveBeenCalledWith('sha256:abc');
  });

  it('keeps the authorization open when a check fails, and lists the failing check with its detail', () => {
    const onAuthorize = vi.fn();
    render(<ClosingDialog projectId="kayron" specId="kayron-001" summary={summary(false)} busy={false} onCancel={() => {}} onAuthorize={onAuthorize} />);
    const button = screen.getByTestId('closing-authorize');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(screen.getByTestId('close-plans').textContent).toContain('sem plano: cart');
    expect(screen.getByTestId('closing-unapproved-note').textContent).toContain('Itens reprovados não travam o início');
    fireEvent.click(button);
    expect(onAuthorize).toHaveBeenCalledWith('sha256:abc');
  });

  it('counts the assumptions taken and lists each repository with its counts', async () => {
    vi.spyOn(refineApi, 'closingRepositories').mockImplementation((_p, _s, req) => Promise.resolve(serveRepos(req)));
    render(<ClosingDialog projectId="kayron" specId="kayron-001" summary={summary(true)} busy={false} onCancel={() => {}} onAuthorize={() => {}} />);
    expect(screen.getByText('Premissas assumidas (2)')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('closing-repositories').textContent).toContain('shop-api'));
  });

  it('cancels without authorizing', () => {
    const onCancel = vi.fn();
    const onAuthorize = vi.fn();
    render(<ClosingDialog projectId="kayron" specId="kayron-001" summary={summary(true)} busy={false} onCancel={onCancel} onAuthorize={onAuthorize} />);
    fireEvent.click(screen.getByTestId('closing-cancel'));
    expect(onCancel).toHaveBeenCalled();
    expect(onAuthorize).not.toHaveBeenCalled();
  });
});
