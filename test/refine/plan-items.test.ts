import { describe, expect, it } from 'vitest';
import { planItems, type PlanSource } from '../../server/refine/plan-items.js';

const item = (key: string, rank: number) => ({ key, title: key, epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [], size: 'S', rank });
const specRow = (status: string) => ({ inputHash: 'h', specId: 'x', rev: 'r', spec: { status }, issues: [], cycle: 1 });

const source = (statuses: Record<string, string>): PlanSource => ({
  backlog: { enabled: true, detail: true, epics: [], items: Object.keys(statuses).map((key, i) => item(key, i + 1)), specs: Object.fromEntries(Object.entries(statuses).map(([key, status]) => [key, specRow(status)])), preplans: {}, flowHeadings: [] },
  derived: null,
  featureKey: undefined,
  repositories: false,
  architecture: undefined,
} as never);

describe('planItems', () => {
  it('plans only the items still to start: a spec main already started was planned by its own run', () => {
    const items = planItems('pedido-1', source({ delivered: 'done', running: 'running', waiting: 'awaiting-validation', fresh: 'refining', planned: 'planned' }));
    expect(items.map((i) => i.key)).toEqual(['fresh', 'planned']);
  });

  it('plans nothing when every item already started', () => {
    expect(planItems('pedido-1', source({ a: 'done', b: 'done' }))).toEqual([]);
  });

  it('plans every item of a backlog with no started spec', () => {
    expect(planItems('pedido-1', source({ a: 'refining', b: 'planned' })).map((i) => i.key)).toEqual(['a', 'b']);
  });
});
