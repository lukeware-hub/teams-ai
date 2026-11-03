import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Stepper, type StepperStep } from './Stepper.js';

const steps: StepperStep[] = [
  { key: 'a', label: 'flow.md', state: 'done' },
  { key: 'b', label: 'project.md', state: 'active', badge: '2 pendências' },
  { key: 'c', label: 'stack.md', state: 'todo', marker: 'briefing.md mudou' },
];

describe('Stepper', () => {
  it('names the position of the active step for a phone', () => {
    render(<Stepper steps={steps} ariaLabel="Etapas" />);
    expect(screen.getByTestId('stepper-position').textContent).toBe('Etapa 2 de 3 · project.md');
  });

  it('shows the marker and the badge, and names both for a screen reader on a step button', () => {
    render(<Stepper steps={steps} ariaLabel="Etapas" onSelect={() => undefined} />);
    expect(screen.getByTestId('stepper-badge-b').textContent).toBe('2 pendências');
    expect(screen.getByTestId('step-b').getAttribute('aria-label')).toBe('project.md, 2 pendências');
    expect(screen.getByTestId('step-c').getAttribute('aria-label')).toBe('stack.md, briefing.md mudou');
  });
});
