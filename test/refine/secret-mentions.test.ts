import { describe, expect, it } from 'vitest';
import { declaredDependencies, sectionsMentioning } from '../../server/refine/session.js';
import type { RefineState } from '../../server/refine/state.js';

const dep = { name: 'db', purpose: 'p', secretNames: ['DB_URL'] };
const state = (over: Partial<RefineState>) => ({ derived: { spec: { externalDependencies: [dep] } }, ...over }) as unknown as RefineState;

describe('declaredDependencies', () => {
  it('uses the derived spec while the backlog has no specs yet', () => {
    expect(declaredDependencies(state({ backlog: { enabled: true, specs: {} } as RefineState['backlog'] }))).toEqual([dep]);
  });

  it('uses only the backlog specs once the backlog has them', () => {
    const other = { name: 'mq', purpose: 'q', secretNames: ['NATS_URL'] };
    const backlog = { enabled: true, specs: { a: { spec: { externalDependencies: [other] } } } } as unknown as RefineState['backlog'];
    expect(declaredDependencies(state({ backlog }))).toEqual([other]);
  });

  it('uses the derived spec when the backlog is off', () => {
    expect(declaredDependencies(state({ backlog: undefined }))).toEqual([dep]);
  });
});

describe('sectionsMentioning', () => {
  it('lists each heading section that names the secret, in document order', () => {
    const docs = {
      'stack.md': '# Stack\nUse NATS_URL here.\n## Mensagens\nNATS_URL again.',
      'flow.md': '# Fluxo\nNo secret here.',
    };
    expect(sectionsMentioning(docs, 'NATS_URL')).toEqual([
      { doc: 'stack.md', heading: 'Stack' },
      { doc: 'stack.md', heading: 'Mensagens' },
    ]);
  });

  it('returns nothing when no document names the secret', () => {
    expect(sectionsMentioning({ 'project.md': '# Projeto\ntexto' }, 'DB_URL')).toEqual([]);
  });

  it('counts a section once even when the name repeats in it', () => {
    expect(sectionsMentioning({ 'briefing.md': '## A\nDB_URL\nDB_URL' }, 'DB_URL')).toEqual([{ doc: 'briefing.md', heading: 'A' }]);
  });
});
