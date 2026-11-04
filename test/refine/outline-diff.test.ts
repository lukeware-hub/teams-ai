import { describe, expect, it } from 'vitest';
import { outlineDiff } from '../../server/refine/outline-diff.js';

const row = (key: string, rank: number, dependsOn: string[] = []) => ({ key, rank, dependsOn });

describe('outlineDiff', () => {
  it('names what a new outline adds, moves and re-wires, and the started items it keeps', () => {
    const before = [row('login', 1), row('cart', 2, ['login'])];
    const after = [row('login', 1), row('export', 2), row('cart', 3, ['login', 'export'])];
    expect(outlineDiff(before, after, new Set(['login']))).toEqual({
      added: ['export'],
      moved: [{ key: 'cart', from: 2, to: 3 }],
      dependencies: [{ key: 'cart', from: ['login'], to: ['export', 'login'] }],
      locked: ['login'],
    });
  });

  it('reports nothing for an outline that did not change', () => {
    const outline = [row('login', 1)];
    expect(outlineDiff(outline, outline, new Set())).toEqual({ added: [], moved: [], dependencies: [], locked: [] });
  });
});
