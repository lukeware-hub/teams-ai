import { describe, expect, it } from 'vitest';
import type { Architecture } from '../../server/contracts/architecture.js';
import { repositoryCards, type RepoSource } from '../../server/api/repositories.js';
import { buildDashboard, specViews, type DashboardRun, type DashboardSpecInput } from '../../server/api/repository-dashboard.js';
import type { StoredEvent } from '../../server/store/event-store.js';

const ARCH: Architecture = {
  style: 'microservices',
  rationale: 'One part.',
  repositories: [{ name: 'shop-api', responsibility: 'Sells', evidence: { doc: 'project.md', quote: 'sells' } }],
  integrations: [],
};
const AT = '2026-11-01T10:00:00.000Z';
const ev = (runId: string, type: string, data: Record<string, unknown>, seq: number): StoredEvent => ({ seq, at: AT, runId, specHash: 'h', type, kind: 'fact', data });
const task = (id: string) => ({ id, title: `Tarefa ${id}`, description: 'faz', criteriaRefs: [], dependsOn: [], affectedPaths: ['src/app.ts'], owner: 'dev', origin: 'plan' });

/** The repository card of the project page must read the same task counts the dashboard shows. */
function cardAndDashboard(specs: DashboardSpecInput[], runs: DashboardRun[]) {
  const board = specViews(specs, runs);
  const dashboard = buildDashboard({ specs, runs, questions: [], missingSecrets: [], programStops: [] });
  const src: RepoSource = {
    architecture: ARCH,
    specs: board.specs.map((v) => ({ specId: v.specId, key: null, status: v.status, activeRunId: null, repository: 'shop-api', title: null, priority: null, dependsOn: [], plan: true, tasks: v.total, delivered: v.delivered, blocked: false })),
  };
  return { card: repositoryCards(src)[0]!, dashboard };
}

describe('the project card and the repository dashboard read the same tasks', () => {
  it('counts a merged task once and reports the same totals on both screens', () => {
    const events = [
      ev('cart-run-1', 'TASK_PLANNED', { task: task('T1-route') }, 1),
      ev('cart-run-1', 'TASK_PLANNED', { task: task('T2-pay') }, 2),
      ev('cart-run-1', 'TASK_STATE_CHANGED', { taskId: 'T1-route', to: 'merged' }, 3),
    ];
    const spec: DashboardSpecInput = { specId: 'cart', title: null, priority: null, status: 'running', tasks: 2, plan: true, blocked: false, activeRunId: null };
    const run: DashboardRun = { runId: 'cart-run-1', specId: 'cart', kind: 'run', n: 1, status: 'running', at: AT, cost: 0, stopped: false, events };
    const { card, dashboard } = cardAndDashboard([spec], [run]);
    expect(card).toMatchObject({ tasks: dashboard.counts.tasks, tasksDone: dashboard.counts.delivered });
    expect(card.tasks).toBe(2);
    expect(card.tasksDone).toBe(1);
  });

  it('gives the same totals for a spec delivered before journals existed', () => {
    const spec: DashboardSpecInput = { specId: 'old', title: null, priority: null, status: 'done', tasks: 3, plan: true, blocked: false, activeRunId: null };
    const { card, dashboard } = cardAndDashboard([spec], []);
    expect(card).toMatchObject({ tasks: dashboard.counts.tasks, tasksDone: dashboard.counts.delivered });
    expect(card.tasksDone).toBe(3);
  });
});
