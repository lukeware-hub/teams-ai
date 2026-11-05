import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ImpactCard, ReadyBar, ReplanCard, RequestCard } from './RequestCards.js';

describe('the cards of a request', () => {
  it("shows the owner's words whole, under the section they sit in", () => {
    render(<RequestCard text={'Exportar o relatório.\n\nEm PDF.'} heading="Pedido pedido-1" interpreted />);
    expect(screen.getByTestId('request-text').textContent).toBe('Exportar o relatório.\n\nEm PDF.');
    expect(screen.getByText('salvo em briefing.md › Pedido pedido-1')).toBeTruthy();
  });

  it('shows the request as concluded once the agents are done, not as still in analysis', () => {
    const { rerender } = render(<RequestCard text="Exportar." heading="Pedido pedido-1" interpreted={false} />);
    expect(screen.getByTestId('step-card-chip-request').textContent).toBe('Em análise');
    rerender(<RequestCard text="Exportar." heading="Pedido pedido-1" interpreted={true} concluded />);
    expect(screen.getByTestId('step-card-chip-request').textContent).toBe('Concluído');
  });

  it('says what the request understood, in the singular or the plural its numbers need', () => {
    const { rerender } = render(<RequestCard text="Exportar." heading="Pedido pedido-1" interpreted understood={{ requirements: 1, rules: 1 }} />);
    expect(screen.getByTestId('request-understood').textContent).toBe('Entendido: 1 requisito · 1 regra de negócio');
    rerender(<RequestCard text="Exportar." heading="Pedido pedido-1" interpreted understood={{ requirements: 3, rules: 2 }} />);
    expect(screen.getByTestId('request-understood').textContent).toBe('Entendido: 3 requisitos · 2 regras de negócio');
  });

  it('says why an impact that did not close is not shown, and counts the one that did', () => {
    const { rerender } = render(<ImpactCard impact={null} issues={['o impacto cita a spec x']} addedKeys={[]} />);
    expect(screen.getByTestId('impact-issues').textContent).toContain('o impacto cita a spec x');
    rerender(<ImpactCard impact={{ summary: 'Acrescenta a exportação.', affected: [{ kind: 'spec', ref: 'login', effect: 'ajuste', action: 'adjust' }], conflicts: [], duplicates: [], dependencies: [], risks: [] }} issues={[]} addedKeys={['export']} />);
    expect(screen.getByText('1 spec nova')).toBeTruthy();
    expect(screen.getByText('1 afetada')).toBeTruthy();
  });

  it('lists each spec with what changed for it, and the rows that stay as they were', () => {
    render(<ReplanCard rows={[{ key: 'login', title: 'Entrar', state: 'em execução', oldRank: 1, newRank: 1, change: 'mantida' }, { key: 'export', title: 'Exportar', state: 'nova', oldRank: null, newRank: 2, change: 'nova' }]} />);
    expect(screen.getByTestId('replan-row-export').textContent).toContain('nova');
    expect(screen.getByTestId('replan-row-login').textContent).toContain('mantida');
  });

  it('names the checks still open, and keeps the one action of the bar', () => {
    render(<ReadyBar checks={[{ id: 'impacto', label: 'impacto', ok: true }, { id: 'planos', label: 'planos', ok: false }]} trail="Pedido → 2 specs" action={<button type="button">Iniciar desenvolvimento</button>} />);
    expect(screen.getByTestId('request-check-planos').textContent).toBe('falta: planos');
    expect(screen.getByTestId('request-trail').textContent).toBe('Trilha: Pedido → 2 specs');
    expect(screen.getByRole('button', { name: 'Iniciar desenvolvimento' })).toBeTruthy();
  });
});
