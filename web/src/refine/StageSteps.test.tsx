import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StageSteps } from './StageSteps.js';
import { stageViews } from './stage-view.js';

describe('StageSteps', () => {
  it('shows the five documents in order, marks the one shown, and shows each score and outdated mark', () => {
    const views = stageViews({ doneStages: ['flow.md', 'project.md'], graphed: ['flow.md'], readiness: { docs: { 'project.md': { score: 0.44 } } } });
    render(<StageSteps views={views} shown="project.md" />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByTestId('stage-project.md').getAttribute('aria-current')).toBe('step');
    expect(screen.getByTestId('stage-project.md').textContent).toContain('44%');
    expect(screen.getByTestId('stage-project.md').textContent).toContain('desatualizado');
    expect(screen.getByTestId('stage-flow.md').getAttribute('data-state')).toBe('done');
    expect(screen.getByTestId('stage-stack.md').getAttribute('aria-current')).toBeNull();
  });

  it('does not open a document: the steps are not buttons, and only Continuar and Voltar move between them', () => {
    render(<StageSteps views={stageViews({})} shown="flow.md" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('stage-stack.md').tagName).toBe('DIV');
  });
});
