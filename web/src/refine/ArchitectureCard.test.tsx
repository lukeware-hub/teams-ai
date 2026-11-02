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
    render(<ArchitectureCard architecture={null} error={null} stale={false} busy startedAt={started} onDecide={() => undefined} />);
    expect(screen.getByTestId('architecture-progress').textContent).toContain('Tempo: 01:0');
    expect((screen.getByTestId('architecture-decide') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers the one primary action while no architecture is decided', () => {
    const onDecide = vi.fn();
    render(<ArchitectureCard architecture={null} error={null} stale={false} busy={false} onDecide={onDecide} />);
    expect(screen.getByTestId('architecture-empty')).toBeTruthy();
    const button = screen.getByTestId('architecture-decide');
    expect(button.className).toContain('primary');
    fireEvent.click(button);
    expect(onDecide).toHaveBeenCalledOnce();
  });

  it('shows the style, each repository with its kind and quote, and each integration', () => {
    render(<ArchitectureCard architecture={{ docsHash: 'h', decision }} error={null} stale={false} busy={false} onDecide={() => {}} />);
    expect(screen.getByTestId('architecture-style').textContent).toBe('Microsserviços');
    expect(within(screen.getByTestId('architecture-repo-shop-web')).getByText('Web')).toBeTruthy();
    expect(screen.getByText('shop-web → shop-api · GET /cart')).toBeTruthy();
    expect(screen.getByTestId('architecture-decide').textContent).toBe('Redefinir');
  });

  it('lists each rule the last decision broke, so the owner sees what is not closed', () => {
    render(<ArchitectureCard architecture={null} error="A arquitetura não fechou com as regras." issues={['O repositório hello-api precisa terminar com um sufixo.', 'Dois serviços têm a mesma responsabilidade.']} stale={false} busy={false} onDecide={() => {}} />);
    const list = within(screen.getByTestId('architecture-issues'));
    expect(list.getByText('O repositório hello-api precisa terminar com um sufixo.')).toBeTruthy();
    expect(list.getByText('Dois serviços têm a mesma responsabilidade.')).toBeTruthy();
    expect(screen.getByTestId('architecture-decide').textContent).toBe('Decidir a arquitetura');
  });

  it('shows a running decision as the same process box the other stages use, under its title', () => {
    const started = new Date(Date.now() - 4_000).toISOString();
    render(<ArchitectureCard architecture={null} error={null} stale={false} busy startedAt={started} onDecide={() => undefined} />);
    const box = screen.getByTestId('architecture-progress');
    expect(box.textContent).toContain('Decidindo a arquitetura');
    expect(box.querySelector('.button-spinner')).toBeTruthy();
  });

  it('asks for a new decision when the documents changed since the last one', () => {
    render(<ArchitectureCard architecture={{ docsHash: 'h', decision }} error={null} stale busy={false} onDecide={() => {}} />);
    expect(screen.getByTestId('architecture-stale').textContent).toBe('Os documentos mudaram: decida a arquitetura de novo.');
  });

  it('names the kind of a monolith repository and of a service without suffix', () => {
    expect(kindLabel('acme', 'monolith')).toBe('Monólito');
    expect(kindLabel('acme', 'microservices')).toBe('sem tipo');
  });
});
