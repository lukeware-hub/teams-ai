import { describe, expect, it } from 'vitest';
import { ConflictError, programEntries } from '../../server/refine/session.js';
import type { BacklogState } from '../../server/refine/state.js';

const item = (key: string, rank: number) => ({ key, title: key, epic: 'core', scope: 's', priority: 'P1' as const, rationale: 'r', dependsOn: [], sources: [], size: 'M' as const, rank });
const backlog = {
  enabled: true,
  project: null,
  epics: [{ key: 'core', title: 'Core' }],
  items: [item('login', 1), item('export', 2)],
  cycle: 1,
  idBase: 'shop-001',
  specs: { login: { spec: { status: 'planned' } }, export: { spec: { status: 'planned' } } },
} as never as BacklogState;

describe('programEntries of a follow-on request', () => {
  it("refuses a spec main delivered, unless the program that runs already owns it", () => {
    const onMain = { 'shop-001-login': 'awaiting-validation' };
    expect(() => programEntries('shop-pedido-1', backlog, onMain)).toThrow(ConflictError);
    const entries = programEntries('shop-pedido-1', backlog, onMain, new Set(['shop-001-login']));
    expect(entries.map((e) => e.specId)).toEqual(['shop-001-login', 'shop-001-export']);
  });
});
