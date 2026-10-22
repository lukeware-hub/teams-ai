import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StageSteps } from './StageSteps.js';
import { stageViews } from './stage-view.js';

describe('StageSteps', () => {
  it('shows the five documents in order, marks the one shown, and shows each score and outdated mark', () => {
    const views = stageViews({ doneStages: ['flow.md'], readiness: { docs: { 'project.md': { score: 0.44 } } }, outdatedDocs: ['project.md'] });
    render(<StageSteps views={views} shown="project.md" onSelect={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(5);
    expect(screen.getByTestId('stage-project.md').getAttribute('aria-current')).toBe('step');
    expect(screen.getByTestId('stage-project.md').textContent).toContain('44%');
    expect(screen.getByTestId('stage-project.md').textContent).toContain('desatualizado');
    expect(screen.getByTestId('stage-flow.md').getAttribute('data-state')).toBe('done');
    expect(screen.getByTestId('stage-stack.md').getAttribute('aria-current')).toBeNull();
  });

  it('selects a document when its step is pressed', () => {
    const onSelect = vi.fn();
    render(<StageSteps views={stageViews({})} shown="flow.md" onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('stage-stack.md'));
    expect(onSelect).toHaveBeenCalledWith('stack.md');
  });
});
