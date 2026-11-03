import { describe, expect, it } from 'vitest';
import { buildDashboard, dashboardPage, type DashboardInput, type DashboardRun, type DashboardSpecInput } from '../../server/api/repository-dashboard.js';

const runsOf = (input: DashboardInput) => dashboardPage(input, 'runs', { page: 1, size: 100, q: '', facet: '', sort: null, dir: 'asc' }).list;

const spec = (specId: string): DashboardSpecInput => ({ specId, title: null, priority: null, status: 'running', tasks: 0, plan: false, blocked: false, activeRunId: null });
const run = (runId: string, specId: string, n: number, cost: number): DashboardRun => ({ runId, specId, kind: 'run', n, status: 'complete', at: '2026-11-01T10:00:00.000Z', cost, stopped: false, events: [] });

describe('the repository cost', () => {
  it('sums the cost of the runs of the repository, across its specs', () => {
    const inp: DashboardInput = { specs: [spec('cart'), spec('pay')], runs: [run('cart-run-1', 'cart', 1, 0.5), run('pay-run-1', 'pay', 1, 0.25)], questions: [], missingSecrets: [], programStops: [] };
    expect(buildDashboard(inp).counts.cost).toBe(0.75);
    expect(buildDashboard(inp).counts.cost).toBe(runsOf(inp).reduce((sum, r) => sum + r.cost, 0));
  });

  it('reads zero for a repository whose specs have no run yet', () => {
    const d = buildDashboard({ specs: [spec('cart')], runs: [], questions: [], missingSecrets: [], programStops: [] });
    expect(d.counts.cost).toBe(0);
  });
});
