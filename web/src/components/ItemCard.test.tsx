import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ItemCard } from './ItemCard.js';

describe('ItemCard', () => {
  it('renders checking, green and red states from the status payload and shows only the hint of a secret', () => {
    const { rerender } = render(<ItemCard title="Claude login" item={null} />);
    expect(screen.getByText('Verificando…')).toBeTruthy();
    expect(screen.getByLabelText('verificando')).toBeTruthy();
    rerender(<ItemCard title="Claude login" item={{ ok: true, detail: 'a@b.c (max)' }} />);
    expect(screen.getByLabelText('concluído')).toBeTruthy();
    expect(screen.getByText('a@b.c (max)')).toBeTruthy();
    rerender(<ItemCard title="GitHub token" item={{ ok: false, detail: 'HTTP 401', secret: { set: true, hint: 'c9Zk' } }} />);
    expect(screen.getByLabelText('pendente')).toBeTruthy();
    expect(screen.getByText('…c9Zk')).toBeTruthy();
    expect(document.body.textContent).not.toContain('ghp_');
  });

  it('explains the step beside its title and translates the owner and token details', () => {
    const { rerender } = render(<ItemCard title="Organização do GitHub" info="Onde ficam os repositórios." item={{ ok: true, detail: 'acme (Organization)' }} />);
    expect(screen.getByRole('button', { name: 'Onde ficam os repositórios.' })).toBeTruthy();
    expect(screen.getByText('acme (organização)')).toBeTruthy();
    rerender(<ItemCard title="Token do GitHub" item={{ ok: true, detail: 'diego · scopes: repo, workflow' }} />);
    expect(screen.getByText('diego · permissões: repo, workflow')).toBeTruthy();
    expect(screen.queryAllByRole('button').filter((b) => !b.classList.contains('info-tip'))).toHaveLength(0);
  });

  it('explains the status flag of the card', () => {
    render(<ItemCard title="Token do GitHub" item={{ ok: false, detail: 'sem token' }} />);
    expect(screen.getByRole('button', { name: 'Falta configurar esta conexão.' })).toBeTruthy();
  });
});
