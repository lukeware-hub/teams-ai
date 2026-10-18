import { describe, expect, it } from 'vitest';
import { planIsStale, readDocs } from '../../server/orchestrator/phases/shared.js';
import { makeFrozenSpec, makeServicesPlan } from '../fixtures/contracts.js';
import { makeRemote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();

describe('readDocs', () => {
  it('reads a services plan from main and judges it stale by its spec hash', async () => {
    const remote = await makeRemote({ 'docs/specs/spec-001/plan.json': JSON.stringify(makeServicesPlan(spec)) });
    const docs = await readDocs(remote.repo, 'spec-001');
    expect(docs.plan !== null && 'services' in docs.plan && Object.keys(docs.plan.services)).toEqual(['orders-api', 'inventory-api']);
    expect(planIsStale(docs.plan, spec.specHash!)).toBe(false);
    expect(planIsStale(docs.plan, `sha256:${'0'.repeat(64)}`)).toBe(true);
    await remote.cleanup();
  });
});
