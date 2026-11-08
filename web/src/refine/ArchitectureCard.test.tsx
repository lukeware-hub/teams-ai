import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ArchitectureView } from '../api.js';
import { ArchitectureCard, kindLabel } from './ArchitectureCard.js';

const decision: ArchitectureView = {
  style: 'microservices',
  rationale: 'O flow.md separa o servidor da tela.',
  repositories: [
    { name: 'shop-api', responsibility: 'Vende', evidence: { doc: 'project.md', quote: 'vende' } },
    { name: 'shop-web', responsibility: 'Mostra', evidence: { doc: 'design.md', quote: 'mostra' } },
  ],
  integrations: [{ consumer: 'shop-web', provider: 'shop-api', contract: 'GET /cart' }],
};

describe('ArchitectureCard', () => {
  it('shows the progress of a running decision, with the time it has run', () => {
    const started = new Date(Date.now() - 65_000).toISOString();
    render(<ArchitectureCard architecture={null} error={null} busy startedAt={started} onDecide={() => undefined} />);
    expect(screen.getByTestId('architecture-progress').textContent).toContain('Tempo: 01:0');
    expect((screen.getByTestId('architecture-decide') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers the one primary action while no architecture is decided', () => {
    const onDecide = vi.fn();
    render(<ArchitectureCard architecture={null} error={null} busy={false} onDecide={onDecide} />);
    expect(screen.getByTestId('architecture-empty')).toBeTruthy();
    const button = screen.getByTestId('architecture-decide');
    expect(button.className).toContain('primary');
    fireEvent.click(button);
    expect(onDecide).toHaveBeenCalledOnce();
  });

  it('shows the style, each repository with its kind and quote, and each integration', () => {
    render(<ArchitectureCard architecture={{ docsHash: 'h', decision }} error={null} busy={false} onDecide={() => {}} />);
    expect(screen.getByTestId('architecture-style').textContent).toBe('Microsserviços');
    expect(within(screen.getByTestId('architecture-repo-shop-web')).getByText('Web')).toBeTruthy();
    expect(screen.getByText('shop-web → shop-api · GET /cart')).toBeTruthy();
    expect(screen.getByTestId('architecture-decide').textContent).toBe('Redefinir');
  });

  it('lists each rule the last decision broke, so the owner sees what is not closed', () => {
    render(<ArchitectureCard architecture={null} error="A arquitetura não fechou com as regras." issues={['O repositório hello-api precisa terminar com um sufixo.', 'Dois serviços têm a mesma responsabilidade.']} busy={false} onDecide={() => {}} />);
    const list = within(screen.getByTestId('architecture-issues'));
    expect(list.getByText('O repositório hello-api precisa terminar com um sufixo.')).toBeTruthy();
    expect(list.getByText('Dois serviços têm a mesma responsabilidade.')).toBeTruthy();
    expect(screen.getByTestId('architecture-decide').textContent).toBe('Decidir a arquitetura');
  });

  it('shows a running decision as the same process box the other stages use, under its title', () => {
    const started = new Date(Date.now() - 4_000).toISOString();
    render(<ArchitectureCard architecture={null} error={null} busy startedAt={started} onDecide={() => undefined} />);
    const box = screen.getByTestId('architecture-progress');
    expect(box.textContent).toContain('Decidindo a arquitetura');
    expect(box.querySelector('.button-spinner')).toBeTruthy();
  });

  it('says the decision is out of date when the documents changed since it, and that the backlog decides again', () => {
    render(<ArchitectureCard architecture={{ docsHash: 'h', decision }} error={null} busy={false} stale onDecide={() => undefined} />);
    expect(screen.getByTestId('architecture-card-stale').textContent).toContain('A decisão está desatualizada');
    expect(screen.getByTestId('architecture-card-stale').textContent).toContain('o backlog decide a arquitetura de novo');
  });

  it('keeps the decision closed while a reason stands, and says the reason', () => {
    render(<ArchitectureCard architecture={null} error={null} busy={false} blocked="Espere a extração do Graphify terminar: os botões liberam sozinhos." onDecide={() => undefined} />);
    expect((screen.getByTestId('architecture-decide') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('architecture-card-blocked').textContent).toContain('Espere a extração do Graphify');
  });

  it('shows the decision without a lock, even when the documents changed since it', () => {
    render(<ArchitectureCard architecture={{ docsHash: 'h', decision }} error={null} busy={false} onDecide={() => {}} />);
    expect(screen.getByTestId('architecture-style').textContent).toBe('Microsserviços');
    expect(screen.queryByTestId('architecture-stale')).toBeNull();
    expect((screen.getByTestId('architecture-decide') as HTMLButtonElement).disabled).toBe(false);
  });

  it('locks the redefinition once the development has started', () => {
    render(<ArchitectureCard architecture={{ docsHash: 'h', decision }} error={null} busy={false} locked onDecide={() => {}} />);
    expect((screen.getByTestId('architecture-decide') as HTMLButtonElement).disabled).toBe(true);
  });

  it('heads the repositories and the integrations with their counts, each repository a closed row with its integration count', () => {
    render(<ArchitectureCard architecture={{ docsHash: 'h', decision }} error={null} busy={false} onDecide={() => {}} />);
    expect(screen.getByTestId('architecture-card-repos-heading').textContent).toBe('Repositórios (2)');
    expect(screen.getByTestId('architecture-card-integrations-heading').textContent).toBe('Integrações (1)');
    const row = screen.getByTestId('architecture-card-repo-details-shop-api') as HTMLDetailsElement;
    expect(row.tagName).toBe('DETAILS');
    expect(row.open).toBe(false);
    expect(screen.getByTestId('architecture-card-repo-links-shop-api').textContent).toBe('1 integração');
    expect(within(row).getByText('Evidência (project.md): "vende"')).toBeTruthy();
  });

  it('searches and pages the repositories only above twelve', async () => {
    const many: ArchitectureView = { ...decision, repositories: Array.from({ length: 13 }, (_, n) => ({ name: `shop${n}-api`, responsibility: `Parte ${n}`, evidence: { doc: 'project.md', quote: 'q' } })) };
    const { rerender } = render(<ArchitectureCard architecture={{ docsHash: 'h', decision }} error={null} busy={false} onDecide={() => {}} />);
    expect(screen.queryByTestId('table-filters')).toBeNull();
    rerender(<ArchitectureCard architecture={{ docsHash: 'h', decision: many }} error={null} busy={false} onDecide={() => {}} />);
    expect(await screen.findByTestId('table-filters')).toBeTruthy();
    expect(await screen.findByTestId('architecture-repo-shop0-api')).toBeTruthy();
    expect(screen.queryByTestId('architecture-repo-shop12-api')).toBeNull();
  });

  it('names the kind of a monolith repository and of a service without suffix', () => {
    expect(kindLabel('acme', 'monolith')).toBe('Monólito');
    expect(kindLabel('acme', 'microservices')).toBe('sem tipo');
  });
});
