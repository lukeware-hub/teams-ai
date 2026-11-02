import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_CHARTER, DOCUMENT_PURPOSE } from '../../server/agents/document-charter.js';
import { convergePack, devPack, reviewPack, securityPack, uiCheckPack, type PackBase } from '../../server/orchestrator/steps.js';
import { makeFrozenSpec, makePlanTask, makeProject } from '../fixtures/contracts.js';

const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const spec = makeFrozenSpec();
const legacy: PackBase = { spec, project: makeProject(), specHash: spec.specHash!, assumptions: [], budgetTokens: 8000 };
const withFiles: PackBase = { ...legacy, planFile: 'docs/specs/orders-001/implementation-plan.md', taskFile: 'docs/specs/orders-001/task.md' };
const task = makePlanTask({ id: 'T1', criteriaRefs: [spec.acceptanceCriteria[0]!.id], affectedPaths: ['src'] });
const code = { source: 'none' as const };

// Golden hashes taken on the legacy layout before the documentation repository changed any pack or charter.
describe('legacy packs and charters stay byte-identical (plan 119, I8 item 5)', () => {
  it('the charters', () => {
    expect(sha([DOCUMENT_CHARTER, DOCUMENT_PURPOSE])).toBe('596ebad486c26b28396ea1ad0c0f5e339d4b004c26225f215f558934f2596539');
  });

  it('the Dev pack, with and without plan and task files', () => {
    expect(sha(devPack(legacy, task, { code, handoffs: [], feedback: null }).principles)).toBe('ca12090c1bb36ae49da76cc2e3465e295fe69a6a4f09bf10569a7fa98b126dd4');
    expect(sha(devPack(withFiles, task, { code, handoffs: [], feedback: null, plan: { file: withFiles.planFile!, ids: ['T1'] } }).principles)).toBe('edf4781594799af2dbe2be5e885c3013b90c9ad387da41f608c45bc193f7f0c9');
  });

  it('the review, security, ui-check and converge packs', () => {
    const diff = { diffStat: '', changedFiles: [], diff: '', junit: [], code, profile: 'quick' as const };
    expect(sha(reviewPack(withFiles, task, diff).principles)).toBe('5ffad0425fcba418bdff5c82d1bcf39f1ea0843ee86bd7fc425ce1c11f40d318');
    expect(sha(securityPack(withFiles, task, { diffStat: '', changedFiles: [], diff: '', code }).principles)).toBe('5ffad0425fcba418bdff5c82d1bcf39f1ea0843ee86bd7fc425ce1c11f40d318');
    expect(sha(uiCheckPack(withFiles, [task], { serviceUrl: 'http://x' }).principles)).toBe('5ffad0425fcba418bdff5c82d1bcf39f1ea0843ee86bd7fc425ce1c11f40d318');
    expect(sha(convergePack(withFiles, { plan: withFiles.planFile! }).principles)).toBe('5ffad0425fcba418bdff5c82d1bcf39f1ea0843ee86bd7fc425ce1c11f40d318');
  });
});
