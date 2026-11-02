import { describe, expect, it } from 'vitest';
import { Backlog, type BacklogItem } from '../../server/contracts/backlog.js';
import { validateBacklog } from '../../server/validators/backlog.js';

const item = (key: string): BacklogItem => ({
  key,
  title: `Item ${key}`,
  epic: 'core',
  scope: `Entrega ${key}`,
  priority: 'P1',
  rationale: 'valor',
  dependsOn: [],
  sources: [{ doc: 'briefing.md', heading: 'Objectives' }],
  size: 'M',
});
const backlogOf = (key: string): Backlog => ({ epics: [{ key: 'core', title: 'Core' }], items: [item(key)] });
const LONG_KEY = 'a'.repeat(41);

describe('validateBacklog alias rules', () => {
  it('refuses a Windows device name and a key of 41 characters in the documentation repository', () => {
    expect(validateBacklog(backlogOf('con'), { flowHeadings: [], docs: {}, docsRepo: true })).toEqual([expect.stringContaining('chave con ')]);
    expect(validateBacklog(backlogOf(LONG_KEY), { flowHeadings: [], docs: {}, docsRepo: true })).toEqual([expect.stringContaining(`chave ${LONG_KEY} `)]);
  });

  it('accepts the same keys in the legacy layout', () => {
    expect(validateBacklog(backlogOf('con'), { flowHeadings: [], docs: {} })).toEqual([]);
    expect(validateBacklog(backlogOf(LONG_KEY), { flowHeadings: [], docs: {} })).toEqual([]);
  });

  it('accepts a slug of at most 40 characters in the documentation repository', () => {
    expect(validateBacklog(backlogOf('a'.repeat(40)), { flowHeadings: [], docs: {}, docsRepo: true })).toEqual([]);
  });
});
