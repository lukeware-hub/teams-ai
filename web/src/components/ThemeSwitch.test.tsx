import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ThemeSwitch } from './ThemeSwitch.js';

const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed');

describe('ThemeSwitch', () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('starts on the light theme when nothing was chosen', () => {
    render(<ThemeSwitch />);
    expect(pressed('Tema claro')).toBe('true');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('applies and remembers the theme the user picks', () => {
    render(<ThemeSwitch />);
    fireEvent.click(screen.getByRole('button', { name: 'Tema escuro' }));
    expect(pressed('Tema escuro')).toBe('true');
    expect(pressed('Tema claro')).toBe('false');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('teams-ai.theme')).toBe('dark');
  });

  it('restores a saved preference', () => {
    localStorage.setItem('teams-ai.theme', 'dark');
    render(<ThemeSwitch />);
    expect(pressed('Tema escuro')).toBe('true');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('follows the system preference, falling back to light without matchMedia', () => {
    render(<ThemeSwitch />);
    fireEvent.click(screen.getByRole('button', { name: 'Usar o tema do sistema' }));
    expect(pressed('Usar o tema do sistema')).toBe('true');
    expect(localStorage.getItem('teams-ai.theme')).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
