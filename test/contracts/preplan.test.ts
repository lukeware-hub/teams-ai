import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Preplan } from '../../server/contracts/preplan.js';

const hash = (c: string) => `sha256:${c.repeat(64)}`;
const preplan = (over: Record<string, unknown> = {}) => ({
  specId: 'kayron-001-opme',
  specRev: hash('a'),
  inputHash: hash('b'),
  modules: [{ name: 'opme', purpose: 'Cadastro e consumo de OPME' }],
  tasks: [
    { id: 'P1', title: 'Cadastro de OPME', module: 'opme', owner: 'dev', criteriaRefs: ['AC-047'], dependsOn: [] },
    { id: 'P2', title: 'Tela de consumo', module: 'opme', owner: 'front', criteriaRefs: ['AC-048'], dependsOn: ['P1'] },
  ],
  risks: [{ risk: 'Tabela de preços externa', mitigation: 'Importar por arquivo no primeiro corte' }],
  ...over,
});

describe('Preplan', () => {
  it('parses the pre-plan the SM makes for one spec', () => {
    expect(Preplan.parse(preplan()).tasks.map((t) => t.id)).toEqual(['P1', 'P2']);
  });

  it('rejects a task that cites no acceptance criterion', () => {
    const tasks = [{ id: 'P1', title: 'Esqueleto', module: 'opme', owner: 'devops', criteriaRefs: [], dependsOn: [] }];
    expect(Preplan.safeParse(preplan({ tasks })).success).toBe(false);
  });

  it('rejects run-plan task ids, unknown owners, and more than 12 tasks or 8 modules', () => {
    const task = { id: 'P1', title: 't', module: 'opme', owner: 'dev', criteriaRefs: ['AC-001'], dependsOn: [] };
    expect(Preplan.safeParse(preplan({ tasks: [{ ...task, id: 'T1-create' }] })).success).toBe(false);
    expect(Preplan.safeParse(preplan({ tasks: [{ ...task, owner: 'sm' }] })).success).toBe(false);
    expect(Preplan.safeParse(preplan({ tasks: Array.from({ length: 13 }, (_, i) => ({ ...task, id: `P${i + 1}` })) })).success).toBe(false);
    expect(Preplan.safeParse(preplan({ modules: Array.from({ length: 9 }, (_, i) => ({ name: `m${i}`, purpose: 'p' })) })).success).toBe(false);
  });

  it('loads in the browser: nothing from node: or the hashing contracts', async () => {
    const src = await fs.readFile('server/contracts/preplan.ts', 'utf8');
    expect(src).not.toMatch(/from 'node:/);
    expect(src).not.toContain("from './hash.js'");
    expect(src).not.toContain("from './spec.js'");
  });
});
