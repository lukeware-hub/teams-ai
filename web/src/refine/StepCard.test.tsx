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

  it('explains itself with a help tip', () => {
    render(<StepCard id="backlog" icon="list" title="Backlog" info="As specs por épico."><span /></StepCard>);
    expect(screen.getByTestId('info-tip-button').getAttribute('aria-label')).toBe('As specs por épico.');
  });

  it('starts closed unless told to open, and marks the card in focus', () => {
    render(<><StepCard id="a" icon="file" title="A" info="i"><span /></StepCard><StepCard id="b" icon="file" title="B" info="i" open focus><span /></StepCard></>);
    expect((screen.getByTestId('step-card-a') as HTMLDetailsElement).open).toBe(false);
    expect((screen.getByTestId('step-card-b') as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByTestId('step-card-a').getAttribute('data-focus')).toBeNull();
    expect(screen.getByTestId('step-card-b').getAttribute('data-focus')).toBe('true');
  });

  it('leaves out the owner line and the chip when none is given', () => {
    render(<StepCard id="x" icon="file" title="X" info="i"><span /></StepCard>);
    expect(screen.queryByTestId('step-card-owner-x')).toBeNull();
    expect(screen.queryByTestId('step-card-chip-x')).toBeNull();
  });
});
