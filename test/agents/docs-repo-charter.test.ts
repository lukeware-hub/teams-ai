import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { charterRulesFor, DOCS_REPO_CHARTER, DOCUMENT_CHARTER } from '../../server/agents/document-charter.js';
import { devPack, type PackBase } from '../../server/orchestrator/steps.js';
import { makeFrozenSpec, makePlanTask, makeProject } from '../fixtures/contracts.js';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

const spec = makeFrozenSpec();
const legacy: PackBase = { spec, project: makeProject(), specHash: spec.specHash!, assumptions: [], budgetTokens: 8000 };
const docsRepo: PackBase = { ...legacy, docsRoot: 'C:/docs-at/draft-1' };
const task = makePlanTask({ id: 'T1', criteriaRefs: [spec.acceptanceCriteria[0]!.id], affectedPaths: ['src'] });
const opts = { code: { source: 'none' as const }, handoffs: [], feedback: null };

describe('document charter per layout (plan 119, I8 item 4)', () => {
  it('the legacy charter stays byte-identical', () => {
    expect(sha(DOCUMENT_CHARTER)).toBe('e9c91dd2cbe1f90806bfc49b2598f7e78a9de354ddc6efe3df067e2ad99090ba');
  });

  it('a source repository adds no charter rule', () => {
    expect(charterRulesFor(false)).toEqual([]);
  });

  it('a documentation repository adds the read-only and no-other-files variant', () => {
    expect(charterRulesFor(true)).toEqual([DOCS_REPO_CHARTER]);
    expect(DOCS_REPO_CHARTER).toContain('the five documents and docs/briefing.md are read-only in the snapshot');
    expect(DOCS_REPO_CHARTER).toContain('Write only the files of the spec folder');
    expect(DOCS_REPO_CHARTER).toContain('never create other document files');
    expect(DOCS_REPO_CHARTER).toContain('relative links between spec documents');
  });

  it('a documentation repository step gets the variant, a source repository step does not', () => {
    expect(devPack(docsRepo, task, opts).principles).toContain(DOCS_REPO_CHARTER);
    expect(devPack(legacy, task, opts).principles).not.toContain(DOCS_REPO_CHARTER);
  });
});
