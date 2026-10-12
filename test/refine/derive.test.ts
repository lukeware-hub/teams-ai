import { describe, expect, it } from 'vitest';
import { derivePack, postProcessDerived } from '../../server/refine/derive.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';

const PROJECT = makeProject();
const ac = (id: string, then: string) => ({ id, given: 'g', when: 'w', then, smoke: false });
const prev = { ...makeSpec(), specVersion: 2, status: 'awaiting-validation' as const, specHash: `sha256:${'b'.repeat(64)}`, acceptanceCriteria: [ac('AC-001', 'one'), ac('AC-002', 'two')], validationReports: [{ at: '2026-09-24T10:00:00.000Z', text: 'r' }] };

describe('postProcessDerived', () => {
  it('keeps ids of unchanged criteria, renumbers a new one after the highest, and forces status/hash/version/reports', () => {
    const out = postProcessDerived(
      { project: PROJECT, spec: { ...prev, specId: 'wrong', status: 'running', specHash: `sha256:${'c'.repeat(64)}`, specVersion: 9, validationReports: [], acceptanceCriteria: [ac('AC-001', 'two'), ac('AC-001', 'three'), ac('AC-007', 'one')] } },
      prev,
      'hello-001',
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.spec.acceptanceCriteria.map((c) => [c.id, c.then])).toEqual([['AC-002', 'two'], ['AC-008', 'three'], ['AC-001', 'one']]);
    expect(out.value.spec).toMatchObject({ specId: 'hello-001', status: 'refining', specHash: null, specVersion: 2 });
    expect(out.value.spec.validationReports).toHaveLength(1);
  });
  it('numbers a brand-new spec above the floor of a sibling spec already on main (R11.8)', () => {
    const out = postProcessDerived(
      { project: PROJECT, spec: { ...prev, status: 'running', specHash: null, specVersion: 0, validationReports: [], acceptanceCriteria: [ac('AC-001', 'one'), ac('AC-002', 'two')] } },
      null,
      'hello-002',
      5,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.spec.acceptanceCriteria.map((c) => c.id)).toEqual(['AC-006', 'AC-007']);
  });
  it('drops a provenance the agent invents: only backlog detailing writes derivedFrom', () => {
    const derivedFrom = { backlogKey: 'x', inputHash: `sha256:${'d'.repeat(64)}`, docsHash: `sha256:${'e'.repeat(64)}`, sources: [{ doc: 'flow.md', heading: 'h', hash: null }] };
    const out = postProcessDerived({ project: PROJECT, spec: { ...prev, derivedFrom } }, prev, 'hello-001');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.spec.derivedFrom).toBeUndefined();
  });
  it('reports zod issues with paths', () => {
    const out = postProcessDerived({ project: { ...PROJECT, personas: [] }, spec: prev }, null, 'hello-001');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.issues.join('\n')).toMatch(/project\.personas/);
  });
  it('reports missing bug reproduction fields', () => {
    const out = postProcessDerived({ project: PROJECT, spec: { ...prev, type: 'bug', bug: undefined } }, null, 'hello-001');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.issues.join('\n')).toMatch(/spec\.bug/);
  });
  it('derivePack carries both Markdown files, the schemas and the spec id', () => {
    const pack = derivePack({ specHash: `sha256:${'d'.repeat(64)}`, principles: ['p'], projectMd: '# P', briefMd: '## O', previous: null, specId: 'hello-001' });
    expect(pack.kind).toBe('derive');
    expect(pack.role).toBe('po');
    expect(pack.feedback).toContain('# P');
    expect(pack.feedback).toContain('## O');
    expect(pack.feedback).toContain('specId must be hello-001');
    expect(pack.feedback).toContain('acceptanceCriteria');
  });
  it('derivePack asks for the services and the platform the docs give, and invents neither', () => {
    const pack = derivePack({ specHash: `sha256:${'d'.repeat(64)}`, principles: [], projectMd: '# P', briefMd: '## O', stackMd: '# Stack', previous: null, specId: 'hello-001' });
    expect(pack.feedback).toContain('`services` lists the services the docs split the system into');
    expect(pack.feedback).toContain('`platform` lists the shared containers stack.md declares');
    expect(pack.feedback).toContain('`platform` stays out too when `services` does');
  });

  it('requires the agent to classify the demand and preserve bug details', () => {
    const pack = derivePack({ specHash: `sha256:${'d'.repeat(64)}`, principles: [], projectMd: '# P', briefMd: '## Type\nbug', stackMd: '# Stack', flowMd: '# Flow', previous: null, specId: 'hello-001' });
    expect(pack.feedback).toContain('type');
    expect(pack.feedback).toContain('bug');
    expect(pack.feedback).toContain('reproduction');
  });
});
