import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BacklogProgress } from './BacklogProgress.js';
import { backlogProgress } from './backlog-progress.js';

afterEach(cleanup);
const items = [{ key: 'a', title: 'A' }, { key: 'b', title: 'B' }];
const checks = (ok: boolean) => ['documents', 'architecture', 'dependencies', 'questions'].map((id) => ({ id, ok, detail: ok ? '' : 'falta' }));
const show = (over: Partial<Parameters<typeof backlogProgress>[0]> = {}, ready = false) => {
  const progress = backlogProgress({ items, detailed: ['a', 'b'], steps: [], running: [], repositories: true, checks: checks(false), architectureRunning: false, closed: ready, ...over });
  render(<BacklogProgress progress={progress} ready={ready} last={null} total="US$ 1,00" repeated={false} />);
};

describe('BacklogProgress', () => {
  it('names the percent done and what is missing', () => {
    show();
    expect(screen.getByTestId('progress-percent').textContent).toBe('20%');
    expect(screen.getByTestId('progress-missing').textContent).toBe('Faltam 80%');
  });

  it('lists what runs now with its elapsed time', () => {
    show({ running: [{ command: 'plan', itemKey: 'a', startedAt: new Date().toISOString() }] });
    expect(screen.getByTestId('progress-now').textContent).toContain('Plano de A');
    expect(screen.getByTestId('progress-plans').dataset.state).toBe('current');
  });

  it('says it is ready at 100%', () => {
    show({ checks: checks(true), steps: items.flatMap((i) => [{ command: 'plan', itemKey: i.key }, { command: 'tasks', itemKey: i.key }]) }, true);
    expect(screen.getByTestId('progress-percent').textContent).toBe('100%');
    expect(screen.getByTestId('progress-missing').textContent).toBe('Pronto para iniciar');
    expect(screen.queryByTestId('progress-now')).toBeNull();
  });
});
