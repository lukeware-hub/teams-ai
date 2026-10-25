import { describe, expect, it } from 'vitest';
import { renderSpecsMd } from '../../server/refine/specs-md.js';
import type { BacklogState } from '../../server/refine/state.js';
import { makeSpec } from '../fixtures/contracts.js';

const item = (key: string, rank: number, over: Record<string, unknown> = {}) => ({ key, title: `Título ${key}`, epic: 'core', priority: 'P0', rank, size: 'S', scope: `escopo ${key}`, rationale: `motivo ${key}`, dependsOn: [], sources: [{ doc: 'flow.md', heading: '1. Entrar' }], ...over });
const backlog = (items: unknown[], over: Partial<BacklogState> = {}) => ({ epics: [{ key: 'core', title: 'Núcleo' }], items, keyIds: true, ...over }) as never;

describe('renderSpecsMd', () => {
  it('is empty without items', () => {
    expect(renderSpecsMd('shop', backlog([]))).toBe('');
  });

  it('renders every item in rank order with its meta line, scope, rationale and sources', () => {
    const md = renderSpecsMd('shop', backlog([item('cart', 2, { dependsOn: ['login'], priority: 'P1', size: 'M' }), item('login', 1)]));
    expect(md.startsWith('# Specs\n')).toBe(true);
    expect(md.indexOf('## login: Título login')).toBeLessThan(md.indexOf('## cart: Título cart'));
    expect(md).toContain('- Épico: Núcleo · Prioridade: P1 · Tamanho: M · Depende de: login');
    expect(md).toContain('- Épico: Núcleo · Prioridade: P0 · Tamanho: S · Depende de: -');
    expect(md).toContain('- Escopo: escopo login\n- Por quê: motivo login\n- Origem: flow.md › 1. Entrar');
    expect(md).not.toContain('### Critérios de aceite');
  });

  it('adds the spec criteria and the preplan tasks of an item that has them', () => {
    const spec = { ...makeSpec({ specId: 'login' }), acceptanceCriteria: [{ id: 'AC-001', given: 'um usuário', when: 'entra', then: 'vê o painel', smoke: true }] };
    const preplan = { tasks: [{ id: 'P1', title: 'Tela de login', module: 'auth', owner: 'front', criteriaRefs: ['AC-001'], dependsOn: [] }], modules: [], risks: [] };
    const md = renderSpecsMd('shop', backlog([item('login', 1), item('cart', 2)], {
      specs: { login: { inputHash: 'i', specId: 'login', rev: 'r', spec: spec as never, issues: [], cycle: 1 } },
      preplans: { login: { inputHash: 'i', specRev: 'r', preplan: preplan as never, issues: [], cycle: 1 } },
    }));
    const login = md.slice(md.indexOf('## login'), md.indexOf('## cart'));
    expect(login).toContain('### Critérios de aceite\n\n- AC-001: Dado um usuário, quando entra, então vê o painel');
    expect(login).toContain('### Pré-plano\n\n- P1 [auth, front] Tela de login (AC-001)');
    expect(md.slice(md.indexOf('## cart'))).not.toContain('### Critérios de aceite');
  });
});
