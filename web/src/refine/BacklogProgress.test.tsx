import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BacklogProgress } from './BacklogProgress.js';
import { backlogProgress } from './backlog-progress.js';

afterEach(cleanup);
const items = [{ key: 'a', title: 'A' }, { key: 'b', title: 'B' }];
const checks = (ok: boolean) => ['documents', 'architecture', 'dependencies', 'questions'].map((id) => ({ id, ok, detail: ok ? '' : 'falta' }));
const show = (over: Partial<Parameters<typeof backlogProgress>[0]> = {}, ready = false, waiting: { until: string } | null = null) => {
  const progress = backlogProgress({ items, detailed: ['a', 'b'], steps: [], running: [], repositories: true, checks: checks(false), architectureRunning: false, closed: ready, ...over });
  render(<BacklogProgress progress={progress} ready={ready} waiting={waiting} last={null} total="US$ 1,00" repeated={false} />);
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

  it('says the agents wait for the Claude quota and shows a clock, not a spinner, on what runs', () => {
    show({ running: [{ command: 'plan', itemKey: 'a', startedAt: new Date().toISOString() }] }, false, { until: '2026-11-11T19:30:00.000Z' });
    expect(screen.getByTestId('progress-waiting').textContent).toContain('Aguardando a cota do Claude até');
    expect(screen.getByTestId('progress-now').querySelector('.button-spinner')).toBeNull();
  });

  it('says it is ready at 100%', () => {
    show({ checks: checks(true), steps: items.flatMap((i) => [{ command: 'plan', itemKey: i.key }, { command: 'tasks', itemKey: i.key }]) }, true);
    expect(screen.getByTestId('progress-percent').textContent).toBe('100%');
    expect(screen.getByTestId('progress-missing').textContent).toBe('Pronto para iniciar');
    expect(screen.queryByTestId('progress-now')).toBeNull();
    expect(screen.queryByTestId('progress-waiting')).toBeNull();
  });
});
