import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppShell } from './AppShell.js';

const shell = (path: string) => render(<MemoryRouter initialEntries={[path]}><AppShell><p>Conteúdo</p></AppShell></MemoryRouter>);

describe('AppShell', () => {
  it('names each destination in full for assistive tech, since the rail shows icons only', () => {
    shell('/projects');
    for (const name of ['Projetos', 'Chat de dúvidas', 'Configurações']) expect(screen.getByRole('link', { name })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Status do ambiente' })).toBeNull();
  });

  it('marks the destination that holds the current screen', () => {
    shell('/refine/kayron-hub/kayron-hub-backlog');
    expect(screen.getByRole('link', { name: 'Projetos' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Chat de dúvidas' }).getAttribute('aria-current')).toBeNull();
  });

  it('puts the screen name in the document title', () => {
    shell('/settings');
    expect(document.title).toBe('Configurações · Teams AI');
  });

  it('uses the brand title when no rail item is active', () => {
    shell('/onboarding');
    expect(document.title).toBe('Teams AI');
  });

  it('offers a skip link to the content', () => {
    shell('/settings');
    expect(screen.getByRole('link', { name: 'Pular para o conteúdo' }).getAttribute('href')).toBe('#main');
    expect(document.getElementById('main')?.textContent).toContain('Conteúdo');
  });

  it('shows the Lukeware footer with contact and copyright', () => {
    shell('/projects');
    const footer = screen.getByRole('contentinfo');
    expect(within(footer).getByText('Lukeware', { exact: true })).toBeTruthy();
    expect(within(footer).getByRole('link', { name: 'lukewaresoftwarehouse@gmail.com' }).getAttribute('href')).toBe('mailto:lukewaresoftwarehouse@gmail.com');
    expect(within(footer).getByRole('link', { name: '(19) 99714-3026' }).getAttribute('href')).toBe('tel:+5519997143026');
    expect(within(footer).getByText(/Todos os direitos autorais reservados/)).toBeTruthy();
    expect(within(footer).getByText(/licença privada/)).toBeTruthy();
  });
});
