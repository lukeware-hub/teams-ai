import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionButton } from './ActionButton.js';

describe('ActionButton', () => {
  it('locks with a spinner while the action runs, ignores more clicks, and unlocks when it ends', async () => {
    let finish: () => void = () => undefined;
    const onClick = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<ActionButton onClick={onClick}>Salvar</ActionButton>);
    const button = screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.querySelector('.button-spinner')).not.toBeNull();
    await act(async () => finish());
    expect(button.disabled).toBe(false);
    expect(button.querySelector('.button-spinner')).toBeNull();
  });

  it('unlocks when the action fails', async () => {
    render(<ActionButton onClick={() => Promise.reject(new Error('x'))}>Salvar</ActionButton>);
    const button = screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;
    await act(async () => { fireEvent.click(button); });
    expect(button.disabled).toBe(false);
  });

  it('stays locked while busy is true, whatever the click did', () => {
    const { rerender } = render(<ActionButton busy>Salvar</ActionButton>);
    const button = screen.getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    rerender(<ActionButton busy={false}>Salvar</ActionButton>);
    expect(button.disabled).toBe(false);
  });
});
