import { describe, expect, it } from 'vitest';
import type { GraphView } from '../../api.js';
import { ageOf, armRows, graphHealth, relationsLine, usefulLine } from './health-rules.js';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const minutesAgo = (n: number): string => new Date(NOW - n * 60_000).toISOString();

type Effect = NonNullable<GraphView['usage']['effect']>;
const effect = (over: Partial<Effect> = {}): Effect => ({ byKind: {}, arms: {}, empty: 0, truncated: 0, resultChars: 0, measured: 0, ...over });
const view = (over: Partial<GraphView> = {}, usage: Partial<GraphView['usage']> = {}): GraphView => ({
  available: true,
  nodes: 10,
  links: 10,
  communities: 3,
  top: [],
  status: { updatedAt: minutesAgo(12), failure: null },
  usage: { graph: 0, grep: 0, none: 0, recent: [], queries: { total: 4, steps: 3, byKind: {}, refine: { total: 0, steps: 0 }, chat: { total: 0, steps: 0 } }, effect: effect(), ...usage },
  ...over,
});

describe('ageOf', () => {
  it('says minutes under an hour, hours under a day and days after that', () => {
    expect(ageOf(minutesAgo(0), NOW)).toBe('há 1 min');
    expect(ageOf(minutesAgo(12), NOW)).toBe('há 12 min');
    expect(ageOf(minutesAgo(180), NOW)).toBe('há 3 h');
    expect(ageOf(minutesAgo(24 * 60), NOW)).toBe('há 1 dia');
    expect(ageOf(minutesAgo(3 * 24 * 60), NOW)).toBe('há 3 dias');
  });
});

describe('graphHealth', () => {
  it('has no data for a graph that does not exist, and for one no step has queried', () => {
    expect(graphHealth(view({ available: false }), NOW)).toMatchObject({ verdict: 'nodata', reason: 'O grafo deste projeto ainda não foi construído.' });
    const unqueried = view({}, { queries: { total: 0, steps: 0, byKind: {}, refine: { total: 0, steps: 0 }, chat: { total: 0, steps: 0 } } });
    expect(graphHealth(unqueried, NOW).verdict).toBe('nodata');
  });

  it('works when the graph is recent and the queries answer', () => {
    expect(graphHealth(view({}, { effect: effect({ measured: 20, empty: 2 }) }), NOW)).toEqual({ verdict: 'ok', reason: 'Atualizado há 12 min. As consultas estão voltando com resposta.' });
    expect(graphHealth(view(), NOW).reason).toBe('Atualizado há 12 min. Os agentes já consultaram o grafo.');
  });

  it('is degraded when the last update failed, the graph is old, half the queries came back empty, or the specs have no relation', () => {
    expect(graphHealth(view({ status: { updatedAt: minutesAgo(12), failure: { at: minutesAgo(1), message: 'x' } } }), NOW)).toMatchObject({ verdict: 'degraded', reason: expect.stringContaining('falhou') });
    expect(graphHealth(view({ status: { updatedAt: minutesAgo(5 * 60), failure: null } }), NOW)).toEqual({ verdict: 'degraded', reason: 'O grafo foi atualizado há 5 h.' });
    expect(graphHealth(view({}, { effect: effect({ measured: 10, empty: 5 }) }), NOW).reason).toBe('Metade ou mais das consultas voltou vazia.');
    expect(graphHealth(view({ specs: 4 }), NOW).reason).toBe('O grafo tem as specs, mas nenhuma ligação entre elas.');
  });

  it('judges empty answers only from 10 measured queries, and a graph with specs and relations is not degraded for them', () => {
    expect(graphHealth(view({}, { effect: effect({ measured: 9, empty: 9 }) }), NOW).verdict).toBe('ok');
    expect(graphHealth(view({ specs: 4, relations: { depends_on: 3 } }), NOW).verdict).toBe('ok');
  });
});

describe('relationsLine and usefulLine', () => {
  it('lists the relations in a fixed order and says when there are none', () => {
    expect(relationsLine({ similar_failure: 8, depends_on: 137, belongs_to: 81 })).toBe('137 depende de · 81 serviço · 8 falhas parecidas');
    expect(relationsLine(undefined)).toBe('nenhuma ligação');
  });

  it('gives the share of measured queries that found something, or what is known when none was measured', () => {
    expect(usefulLine(view({}, { effect: effect({ measured: 40, empty: 4 }) }))).toBe('90% de 40 consultas');
    expect(usefulLine(view())).toBe('4 consultas, ainda sem medir a resposta');
    expect(usefulLine(view({}, { queries: { total: 0, steps: 0, byKind: {}, refine: { total: 0, steps: 0 }, chat: { total: 0, steps: 0 } } }))).toBe('nenhuma consulta medida');
  });
});

describe('armRows', () => {
  const spend = (steps: number, costUsd: number, reads: number) => ({ steps, costUsd, toolCalls: 0, reads, failed: 0 });

  const specs = { graph: 6, control: 5 };

  it('gives each arm the cost and reads per step, the change with the graph, and whether there are steps and specs enough', () => {
    const [row] = armRows({ dev: { graph: spend(12, 3.6, 108), control: spend(11, 4.18, 154), specs } });
    expect(row).toMatchObject({ kind: 'dev', conclusive: true, specs });
    expect(row!.graph).toMatchObject({ steps: 12, cost: 0.3, reads: 9 });
    expect(row!.control.steps).toBe(11);
    expect(row!.costChange).toBeCloseTo(-21, 0);
    expect(row!.readsChange).toBeCloseTo(-35.7, 0);
  });

  it('does not conclude with few steps or few specs, gives no change while the control spends nothing, and none without an experiment', () => {
    expect(armRows({ review: { graph: spend(3, 1, 4), control: spend(12, 2, 8), specs } })[0]!.conclusive).toBe(false);
    // Plenty of steps from two specs and one spec: the arm follows the spec, so it is not a result.
    expect(armRows({ review: { graph: spend(40, 1, 4), control: spend(40, 2, 8), specs: { graph: 2, control: 1 } } })[0]!.conclusive).toBe(false);
    expect(armRows({ review: { graph: spend(12, 1, 4), control: spend(12, 0, 0), specs } })[0]).toMatchObject({ costChange: null, readsChange: null });
    expect(armRows(undefined)).toEqual([]);
  });
});
