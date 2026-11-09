import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessingBanner, stageCostText } from './ProcessingBanner.js';
import { stageTitle } from './stages.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('stageTitle of a stage review', () => {
  it('names the document under review when there is one', () => {
    expect(stageTitle({ status: 'evaluating', stale: false, backlog: null }, 'project.md')).toBe('Avaliando project.md');
  });
});

describe('the stage review banner', () => {
  const since = '2026-11-06T22:00:00Z';
  const cost = { rounds: 2, steps: 9, durationMs: 1_020_000, costUsd: 2.6115 };

  it('names the document, its cost and the quota it waits for', () => {
    render(<ProcessingBanner backlog={null} cycle={3} stage="PO está revisando só project.md." jevDown={false} since={since} file="project.md" cost={cost} waiting={{ until: '2026-11-06T23:00:00Z' }} onStop={() => undefined} />);
    expect(screen.getByTestId('processing-banner-cost').textContent).toBe('Etapa project.md · 2 rodadas · 17 min 0 s · US$ 2,61 · 9 chamadas');
    expect(screen.getByTestId('processing-banner-waiting').textContent).toContain('Aguardando a cota do Claude até');
    expect(screen.getByTestId('processing-banner-stop').textContent).toBe('Parar');
  });

  it('calls onStop when the owner stops the evaluation', () => {
    const onStop = vi.fn();
    render(<ProcessingBanner backlog={null} cycle={3} stage="x" jevDown={false} since={since} file="project.md" onStop={onStop} />);
    act(() => screen.getByTestId('processing-banner-stop').click());
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('says a step has run past a minute, and names its part', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(Date.parse('2026-11-06T22:02:00Z'));
    render(<ProcessingBanner backlog={null} cycle={3} stage="x" jevDown={false} since={since} running={[{ stepId: 's1', kind: 'refine', role: 'po', model: 'claude-haiku-5-5', effort: 'max', part: { index: 3, total: 4 }, limitMs: 120_000, startedAt: '2026-11-06T22:00:00Z' }]} />);
    expect(screen.getByTestId('processing-banner-slow').textContent).toBe('Este passo está demorando mais que o normal.');
    expect(screen.getByTestId('running-models').textContent).toContain('parte 3 de 4');
  });

  it('formats the cost line in the singular for one round and one call', () => {
    expect(stageCostText('flow.md', { rounds: 1, steps: 1, durationMs: 5_000, costUsd: 0.5 })).toBe('Etapa flow.md · 1 rodada · 5 s · US$ 0,50 · 1 chamada');
  });
});
