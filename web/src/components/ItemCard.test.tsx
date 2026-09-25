import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ItemCard } from './ItemCard.js';

describe('ItemCard', () => {
  it('renders checking, green and red states from the status payload and shows only the hint of a secret', () => {
    const { rerender } = render(<ItemCard title="Claude login" item={null} />);
    expect(screen.getByText('Verificando…')).toBeTruthy();
    expect(screen.getByLabelText('checking')).toBeTruthy();
    rerender(<ItemCard title="Claude login" item={{ ok: true, detail: 'a@b.c (max)' }} />);
    expect(screen.getByLabelText('ok')).toBeTruthy();
    expect(screen.getByText('a@b.c (max)')).toBeTruthy();
    rerender(<ItemCard title="GitHub token" item={{ ok: false, detail: 'HTTP 401', secret: { set: true, hint: 'c9Zk' } }} />);
    expect(screen.getByLabelText('todo')).toBeTruthy();
    expect(screen.getByText('…c9Zk')).toBeTruthy();
    expect(document.body.textContent).not.toContain('ghp_');
  });
});
