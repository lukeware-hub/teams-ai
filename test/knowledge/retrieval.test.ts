import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunkMarkdown } from '../../server/knowledge/chunker.js';
import { KnowledgeIndex, sanitizeQuery, type KnowledgeDoc } from '../../server/knowledge/retrieval.js';

const SPEC1 = `# Spec 1: discounts
## Objectives
Customers with the VIP tier receive a discount.
## Decisions
The maximum discount is 5 percent, decided by the PO on 2026-09-10.
`;
const ADR2 = `# ADR-002: Authentication
We use JWT bearer tokens. Sessions are stateless.
`;

describe('chunkMarkdown', () => {
  it('splits at headings with stable ids and keeps the heading text', () => {
    const chunks = chunkMarkdown('spec-001', SPEC1);
    // The title heading has no body of its own and is skipped.
    expect(chunks.map((c) => c.id)).toEqual(['spec-001#0', 'spec-001#1']);
    expect(chunks[0]).toMatchObject({ heading: 'Objectives', ordinal: 0 });
    expect(chunks[1]!.text).toContain('5 percent');
  });

  it('splits long sections at blank lines and drops empty pieces', () => {
    const long = `# T\n\n${'para one '.repeat(50)}\n\n${'para two '.repeat(50)}\n\n\n`;
    const chunks = chunkMarkdown('d', long, { maxChars: 300 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.text.trim().length).toBeGreaterThan(0);
  });
});

describe('sanitizeQuery', () => {
  it('strips FTS5 operators and punctuation, keeps terms', () => {
    expect(sanitizeQuery('discount "VIP" NEAR(x) -5% (max*)')).toBe('discount VIP NEAR x 5 max');
    expect(sanitizeQuery('"""')).toBe('');
    expect(sanitizeQuery('não-conformidade ação')).toBe('não-conformidade ação');
  });
});

describe('KnowledgeIndex', () => {
  let idx: KnowledgeIndex;
  const spec: KnowledgeDoc = { id: 'spec-001', kind: 'spec', title: 'Spec 1', text: SPEC1, specId: 'spec-001' };
  const adr: KnowledgeDoc = { id: 'ADR-002', kind: 'adr', title: 'ADR-002', text: ADR2 };

  beforeEach(() => {
    idx = KnowledgeIndex.open(':memory:');
    idx.index(spec);
    idx.index(adr);
  });
  afterEach(() => idx.close());

  it('ranks the chunk about the topic first and returns a snippet', () => {
    const hits = idx.search('maximum discount percent decided');
    expect(hits[0]).toMatchObject({ docId: 'spec-001', kind: 'spec', heading: 'Decisions' });
    expect(hits[0]!.snippet).toMatch(/discount/i);
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it('filters by kind and by specId', () => {
    expect(idx.search('tokens sessions', { kinds: ['adr'] })[0]!.docId).toBe('ADR-002');
    expect(idx.search('tokens sessions', { kinds: ['spec'] })).toEqual([]);
    expect(idx.search('discount', { specId: 'spec-001' })).not.toEqual([]);
    expect(idx.search('discount', { specId: 'spec-999' })).toEqual([]);
  });

  it('never throws on FTS5 syntax in the query and returns nothing for an empty bag', () => {
    expect(() => idx.search('"unterminated NEAR( -x')).not.toThrow();
    expect(idx.search('"""')).toEqual([]);
  });

  it('replaces a re-indexed document instead of duplicating it', () => {
    idx.index({ ...spec, text: '# Spec 1\n## Decisions\nThe maximum discount is 10 percent now.\n' });
    const hits = idx.search('maximum discount percent');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toContain('10 percent');
    expect(idx.count()).toBe(2); // spec chunk + adr chunk
  });

  it('removes a document', () => {
    idx.removeDocument('ADR-002');
    expect(idx.search('JWT')).toEqual([]);
  });

  it('respects k', () => {
    for (let i = 0; i < 5; i++) idx.index({ id: `qa-${i}`, kind: 'qa', title: `Q${i}`, text: `Question ${i}: what discount applies? Answer: discount ${i}.` });
    expect(idx.search('discount', { k: 3 })).toHaveLength(3);
  });

  it('finds a word inside a hyphenated token when FTS5 is missing, as FTS5 does', () => {
    (idx as unknown as { fts5: boolean }).fts5 = false;
    idx.index({ id: 'marker', kind: 'other', title: 'Marker', text: 'The quota uses marker zebracorn-7741.' });
    expect(idx.search('zebracorn').map((h) => h.docId)).toEqual(['marker']);
  });
});
