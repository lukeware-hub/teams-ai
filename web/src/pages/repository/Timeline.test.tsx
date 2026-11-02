import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { TimelineEntry } from '../../api.js';
import { Timeline } from './Timeline.js';

const entry = (n: number): TimelineEntry => ({ at: '2026-11-01T10:00:00.000Z', runId: `shop-run-${n}`, specId: 'cart', text: `Evento ${n}`, tone: '', role: 'dev', taskId: null });
const list = (count: number, total = count) => ({ total, list: Array.from({ length: count }, (_, i) => entry(i + 1)) });

describe('Timeline', () => {
  it('pages the events, ten at a time, and moves to the next page', () => {
    render(<MemoryRouter><Timeline timeline={list(25)} /></MemoryRouter>);
    const panel = within(screen.getByTestId('repo-timeline'));
    expect(panel.getAllByRole('listitem')).toHaveLength(10);
    expect(panel.getByText('Evento 1')).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: 'Próxima página' }));
    expect(panel.getAllByRole('listitem')).toHaveLength(10);
    expect(panel.getByText('Evento 11')).toBeTruthy();
    expect(panel.getByText('11–20 de 25')).toBeTruthy();
  });

  it('says how many of the events the server sends are shown', () => {
    render(<MemoryRouter><Timeline timeline={list(3, 727)} /></MemoryRouter>);
    expect(screen.getByText('Mostrando os 3 eventos mais recentes de 727.')).toBeTruthy();
  });

  it('reads "sem dados" when the repository has no event', () => {
    render(<MemoryRouter><Timeline timeline={{ total: 0, list: [] }} /></MemoryRouter>);
    expect(screen.getByText('sem dados: nenhum evento registrado.')).toBeTruthy();
  });
});
