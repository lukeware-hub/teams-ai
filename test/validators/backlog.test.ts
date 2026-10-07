import { describe, expect, it } from 'vitest';
import { Backlog, type BacklogItem } from '../../server/contracts/backlog.js';
import { flowHeadings, MAX_ITEMS, rankItems, validateBacklog } from '../../server/validators/backlog.js';

const item = (key: string, over: Partial<BacklogItem> = {}): BacklogItem => ({
  key,
  title: `Item ${key}`,
  epic: 'core',
  scope: `Entrega ${key}`,
  priority: 'P1',
  rationale: 'valor',
  dependsOn: [],
  sources: [{ doc: 'briefing.md', heading: 'Objectives' }],
  size: 'M',
  ...over,
});
const backlog = (items: BacklogItem[], epics = [{ key: 'core', title: 'Core' }]): Backlog => ({ epics, items });
const check = (b: Backlog, headings: string[] = []) => validateBacklog(b, { flowHeadings: headings });

describe('validateBacklog', () => {
  it('accepts a well-formed backlog', () => {
    expect(check(backlog([item('base', { priority: 'P0' }), item('casos', { dependsOn: ['base'] })]))).toEqual([]);
  });

  it('rejects duplicate and reserved keys', () => {
    expect(check(backlog([item('a'), item('a')]))).toEqual(expect.arrayContaining([expect.stringMatching(/duplicada.*a/)]));
    for (const key of ['primary', 'plan', 'complete', 'report', 'v2', 'r1']) {
      expect(check(backlog([item(key)])), key).toEqual(expect.arrayContaining([expect.stringMatching(/reservada/)]));
    }
  });

  it('rejects an unknown epic, an unknown dependency and a self dependency', () => {
    const errors = check(backlog([item('a', { epic: 'nada', dependsOn: ['zzz', 'a'] })]));
    expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/épico desconhecido/), expect.stringMatching(/zzz/), expect.stringMatching(/depende dele mesmo/)]));
  });

  it('rejects a dependency cycle', () => {
    const errors = check(backlog([item('a', { dependsOn: ['b'] }), item('b', { dependsOn: ['a'] })]));
    expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/ciclo/)]));
  });

  it('rejects an item that depends on a lower-priority item', () => {
    const errors = check(backlog([item('a', { priority: 'P0', dependsOn: ['b'] }), item('b', { priority: 'P2' })]));
    expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/prioridade menor/)]));
    expect(check(backlog([item('a', { priority: 'P2', dependsOn: ['b'] }), item('b', { priority: 'P0' })]))).toEqual([]);
  });

  it('caps the number of items', () => {
    const items = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => item(`i${i}`));
    expect(check(backlog(items))).toEqual(expect.arrayContaining([expect.stringMatching(/máximo/)]));
  });

  it('requires every flow.md section to be cited, ignoring case, accents and numbering', () => {
    const b = backlog([item('opme', { sources: [{ doc: 'flow.md', heading: 'opme' }] })]);
    expect(check(b, ['7. OPME'])).toEqual([]);
    expect(check(b, ['7. OPME', '8. Logística'])).toEqual([expect.stringMatching(/Logística/)]);
    expect(check(backlog([item('l', { sources: [{ doc: 'flow.md', heading: '8. LOGISTICA OPME' }] })]), ['8. Logística'])).toEqual([]);
  });

  it('rejects a flow.md citation that names no section, listing the sections', () => {
    // A title comment of the diagram (`%% AGENDA CLÍNICA`) is not a section; kept verbatim, it failed every review.
    const b = backlog([item('base', { sources: [{ doc: 'flow.md', heading: 'AGENDA CLÍNICA' }, { doc: 'flow.md', heading: '1. Cadastro' }] })]);
    expect(check(b, ['1. Cadastro'])).toEqual([expect.stringMatching(/item base cita flow\.md › "AGENDA CLÍNICA".*"1\. Cadastro"/)]);
  });

  it('leaves flow.md citations alone when flow.md has no sections', () => {
    expect(check(backlog([item('a', { sources: [{ doc: 'flow.md', heading: 'Fluxo' }] })]))).toEqual([]);
  });
});

describe('Backlog schema', () => {
  it('requires at least one source and one epic', () => {
    expect(Backlog.safeParse(backlog([item('a', { sources: [] })])).success).toBe(false);
    expect(Backlog.safeParse({ epics: [], items: [item('a')] }).success).toBe(false);
    expect(Backlog.safeParse(backlog([item('a')])).success).toBe(true);
  });
});

describe('flowHeadings', () => {
  it('reads numbered mermaid section comments and level 2-3 markdown headings, not the title or separators', () => {
    const flow = ['# Fluxo', '', '```mermaid', '%% ====', '%% CLÍNICA — V4', '%% 0. GOVERNANÇA DA PLATAFORMA', '%% ====', 'flowchart TD', '%% 7. OPME', '```', '', '## Regras gerais', '### Detalhe'].join('\n');
    expect(flowHeadings(flow)).toEqual(['0. GOVERNANÇA DA PLATAFORMA', '7. OPME', 'Regras gerais', 'Detalhe']);
  });

  it('finds nothing in the blank template, so nothing is demanded', () => {
    expect(flowHeadings('# Application flow\n\n```mermaid\nflowchart TD\n  A[Start] --> B[Next]\n```\n')).toEqual([]);
  });
});

describe('rankItems', () => {
  it('orders by priority, keeps dependencies first and the agent order within a level', () => {
    const ranked = rankItems([item('a', { dependsOn: ['b'] }), item('b'), item('c', { priority: 'P0' }), item('d', { priority: 'P3' })]);
    expect(ranked.map((r) => [r.key, r.rank])).toEqual([['c', 1], ['b', 2], ['a', 3], ['d', 4]]);
  });
});
