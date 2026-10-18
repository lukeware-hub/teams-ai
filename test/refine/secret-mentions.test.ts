import { describe, expect, it } from 'vitest';
import { sectionsMentioning } from '../../server/refine/session.js';

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
    expect(sectionsMentioning({ 'brief.md': '## A\nDB_URL\nDB_URL' }, 'DB_URL')).toEqual([{ doc: 'brief.md', heading: 'A' }]);
  });
});
