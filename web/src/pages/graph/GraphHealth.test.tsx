import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GraphView } from '../../api.js';
import { GraphHealth } from './GraphHealth.js';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const spend = (steps: number, costUsd: number, reads: number) => ({ steps, costUsd, toolCalls: 0, reads, failed: 0 });
const view = (arms: NonNullable<GraphView['usage']['effect']>['arms'] = {}, over: Partial<GraphView> = {}): GraphView => ({
  available: true,
  nodes: 5002,
  links: 7510,
  communities: 366,
  top: [],
  status: { updatedAt: new Date(NOW - 12 * 60_000).toISOString(), failure: null },
  relations: { depends_on: 137, has_plan: 81, belongs_to: 81, derived_from: 136, similar_failure: 8 },
  specs: 81,
  usage: { graph: 0, grep: 0, none: 0, recent: [], queries: { total: 41, steps: 9, byKind: {}, refine: { total: 0, steps: 0 }, chat: { total: 0, steps: 0 } }, effect: { byKind: {}, arms, empty: 5, truncated: 0, resultChars: 0, measured: 41 } },
  ...over,
});

describe('GraphHealth', () => {
  it('says the verdict with its reason, and the four measures', () => {
    render(<GraphHealth view={view()} now={NOW} />);
    expect(screen.getByTestId('graph-health-verdict').textContent).toBe('Funcionando');
    expect(screen.getByTestId('graph-health-verdict').className).toContain('tone-good');
    expect(screen.getByTestId('graph-health-reason').textContent).toBe('Atualizado há 12 min. As consultas estão voltando com resposta.');
    expect(screen.getByTestId('graph-health-age').textContent).toBe('há 12 min');
    expect(screen.getByTestId('graph-health-communities').textContent).toBe('366');
    expect(screen.getByTestId('graph-health-useful').textContent).toBe('88% de 41 consultas');
    expect(screen.getByTestId('graph-health-relations').textContent).toBe('137 depende de · 81 plano · 81 serviço · 136 origem · 8 falhas parecidas');
  });

  it('shows the experiment with the group size, and says when the steps or the specs are too few to conclude', () => {
    const arm = (graph: ReturnType<typeof spend>, control: ReturnType<typeof spend>, specs = { graph: 6, control: 5 }) => ({ graph, control, specs });
    render(<GraphHealth view={view({ dev: arm(spend(12, 3.6, 108), spend(11, 4.18, 154)), review: arm(spend(3, 0.36, 12), spend(7, 0.91, 42)), security: arm(spend(40, 1, 10), spend(40, 2, 20), { graph: 2, control: 1 }) })} now={NOW} />);
    const few = 'Poucos passos ou poucas specs: ainda não conclui.';
    const dev = within(screen.getByTestId('graph-health-row-dev'));
    expect(dev.getByText('US$ 0,30 · US$ 0,38')).toBeTruthy();
    expect(dev.getByText('−21%')).toBeTruthy();
    expect(dev.getByText('12 · 11')).toBeTruthy();
    expect(dev.getByText('6 · 5 specs')).toBeTruthy();
    expect(dev.queryByText(few)).toBeNull();
    expect(within(screen.getByTestId('graph-health-row-review')).getByText(few)).toBeTruthy();
    // Plenty of steps from two specs against one spec still does not conclude: the arm follows the spec.
    const security = within(screen.getByTestId('graph-health-row-security'));
    expect(security.getByText('2 · 1 specs')).toBeTruthy();
    expect(security.getByText(few)).toBeTruthy();
    expect(screen.getByTestId('graph-health-experiment-list').textContent).toContain('desenvolvimento');
  });

  it('says the experiment gathers as runs finish while no step has been counted', () => {
    render(<GraphHealth view={view()} now={NOW} />);
    expect(screen.getByTestId('graph-health-experiment-empty').textContent).toBe('O experimento acumula conforme as rodadas terminam.');
    expect(screen.queryByTestId('graph-health-experiment')).toBeNull();
  });

  it('names the problem when the graph is degraded', () => {
    render(<GraphHealth view={view({}, { status: { updatedAt: new Date(NOW - 5 * 3_600_000).toISOString(), failure: null } })} now={NOW} />);
    expect(screen.getByTestId('graph-health-verdict').textContent).toBe('Degradado');
    expect(screen.getByTestId('graph-health-reason').textContent).toBe('O grafo foi atualizado há 5 h.');
  });
});
