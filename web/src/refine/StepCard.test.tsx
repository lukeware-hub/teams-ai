import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StepCard } from './StepCard.js';

describe('StepCard', () => {
  it('shows the title, who fills it, the state chip and the content', () => {
    render(<StepCard id="plans" icon="clipboard" title="Planos" info="O plano de cada item." owner="Feito pelo Dev" chip={{ label: 'Atual', tone: 'ok' }}><p>conteúdo</p></StepCard>);
    expect(screen.getByTestId('step-card-title-plans').textContent).toContain('Planos');
    expect(screen.getByTestId('step-card-owner-plans').textContent).toBe('Feito pelo Dev');
    expect(screen.getByTestId('step-card-chip-plans').textContent).toBe('Atual');
    expect(screen.getByText('conteúdo')).toBeTruthy();
  });

  it('explains itself with a help tip named after the card', () => {
    render(<StepCard id="backlog" icon="list" title="Backlog" info="As specs por épico."><span /></StepCard>);
    expect(screen.getByTestId('info-tip-button').getAttribute('aria-label')).toBe('As specs por épico.');
    expect(screen.getByTestId('step-card-backlog').getAttribute('aria-labelledby')).toBe('step-card-title-backlog');
  });

  it('leaves out the owner line and the chip when none is given', () => {
    render(<StepCard id="x" icon="file" title="X" info="i"><span /></StepCard>);
    expect(screen.queryByTestId('step-card-owner-x')).toBeNull();
    expect(screen.queryByTestId('step-card-chip-x')).toBeNull();
  });
});
