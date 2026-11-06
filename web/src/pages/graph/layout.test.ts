import { describe, expect, it } from 'vitest';
import { createLayout, settle } from './layout.js';

const node = (id: string, community = 'c1') => ({ id, community });

describe('createLayout', () => {
  const nodes = [node('a'), node('b'), node('c', 'c2'), node('d', 'c2')];
  const links = [{ source: 'a', target: 'b' }, { source: 'c', target: 'd' }];

  it('gives every node a finite position', () => {
    const layout = createLayout(nodes, links);
    settle(layout);
    expect([...layout.x, ...layout.y].every(Number.isFinite)).toBe(true);
  });

  it('lands the same graph in the same picture', () => {
    const first = createLayout(nodes, links);
    const second = createLayout(nodes, links);
    settle(first);
    settle(second);
    expect([...first.x]).toEqual([...second.x]);
    expect([...first.y]).toEqual([...second.y]);
  });

  it('keeps linked nodes closer than nodes of another community', () => {
    const layout = createLayout(nodes, links);
    settle(layout);
    const gap = (i: number, j: number) => Math.hypot(layout.x[i]! - layout.x[j]!, layout.y[i]! - layout.y[j]!);
    expect(gap(0, 1)).toBeLessThan(gap(0, 2));
  });

  it('keeps linked nodes that start in the same place apart', () => {
    const layout = createLayout([node('a'), node('b')], [{ source: 'a', target: 'b' }]);
    layout.x.fill(0);
    layout.y.fill(0);
    settle(layout);
    expect(Math.hypot(layout.x[0]! - layout.x[1]!, layout.y[0]! - layout.y[1]!)).toBeGreaterThan(1);
  });

  it('leaves the nodes without links in a disc away from the linked ones', () => {
    const layout = createLayout([node('a'), node('b'), node('lone1'), node('lone2'), node('lone3')], [{ source: 'a', target: 'b' }]);
    settle(layout);
    const centre = { x: (layout.x[0]! + layout.x[1]!) / 2, y: (layout.y[0]! + layout.y[1]!) / 2 };
    for (const i of [2, 3, 4]) expect(Math.hypot(layout.x[i]! - centre.x, layout.y[i]! - centre.y)).toBeGreaterThan(100);
  });

  it('reports it has settled and handles an empty graph', () => {
    const layout = createLayout([], []);
    expect(layout.step()).toBe(false);
  });
});
