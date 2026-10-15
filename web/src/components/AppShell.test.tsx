import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppShell } from './AppShell.js';

const shell = (path: string) => render(<MemoryRouter initialEntries={[path]}><AppShell><p>Conteúdo</p></AppShell></MemoryRouter>);

describe('AppShell', () => {
  it('names each destination in full for assistive tech, since the rail shows icons only', () => {
    shell('/projects');
    for (const name of ['Projetos', 'Chat de dúvidas', 'Status do ambiente', 'Configurações']) expect(screen.getByRole('link', { name })).toBeTruthy();
  });

  it('marks the destination that holds the current screen', () => {
    shell('/refine/kayron-hub/kayron-hub-backlog');
    expect(screen.getByRole('link', { name: 'Projetos' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Chat de dúvidas' }).getAttribute('aria-current')).toBeNull();
  });

  it('puts the screen name in the document title', () => {
    shell('/status');
    expect(document.title).toBe('Status do ambiente · Teams AI');
  });

  it('offers a skip link to the content', () => {
    shell('/settings');
    expect(screen.getByRole('link', { name: 'Pular para o conteúdo' }).getAttribute('href')).toBe('#main');
    expect(document.getElementById('main')?.textContent).toContain('Conteúdo');
  });
});
