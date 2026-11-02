import { describe, expect, it } from 'vitest';
import type { BacklogItem } from '../../server/contracts/backlog.js';
import { postProcessBacklog } from '../../server/refine/backlog.js';
import { makeProject } from '../fixtures/contracts.js';

const item = (key: string): BacklogItem => ({
  key, title: `Item ${key}`, epic: 'core', scope: `Entrega ${key}`, priority: 'P1', rationale: 'valor', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'M',
});
const out = (key: string) => ({ project: makeProject(), backlog: { epics: [{ key: 'core', title: 'Core' }], items: [item(key)] } });

describe('postProcessBacklog alias rule in the production path', () => {
  it('refuses a docs-repository backlog whose key is a Windows device name', () => {
    const checked = postProcessBacklog(out('con'), null, {}, [], [], undefined, true);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issues).toEqual([expect.stringContaining('chave con ')]);
  });

  it('does not refuse the same backlog in a legacy session', () => {
    expect(postProcessBacklog(out('con'), null, {}, [], []).ok).toBe(true);
    expect(postProcessBacklog(out('con'), null, {}, [], [], undefined, false).ok).toBe(true);
  });
});
