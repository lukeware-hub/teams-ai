import { describe, expect, it } from 'vitest';
import { canonicalJson, HASH_PATTERN } from '../../server/contracts/hash.js';
import { Plan } from '../../server/contracts/plan.js';
import { Spec, SpecFrozenError, computeSpecHash, freezeSpec } from '../../server/contracts/spec.js';
import { makePlan, makeProject, makeSpec } from '../fixtures/contracts.js';

describe('canonicalJson', () => {
  it('sorts keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: true } })).toBe('{"a":{"c":true,"d":[2,1]},"b":1}');
  });

  it('drops undefined values', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe('Project', () => {
  it('applies defaults for github and confidential', () => {
    const project = makeProject();
    expect(project.github).toEqual({});
    expect(project.confidential).toBe(false);
  });
});

describe('Spec', () => {
  it('parses a valid spec', () => {
    expect(makeSpec().acceptanceCriteria).toHaveLength(2);
  });

  it('rejects malformed acceptance criterion ids', () => {
    const result = Spec.safeParse({
      ...makeSpec(),
      acceptanceCriteria: [{ id: 'AC-1', given: 'g', when: 'w', then: 't' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate acceptance criterion ids', () => {
    const spec = makeSpec();
    const result = Spec.safeParse({
      ...spec,
      acceptanceCriteria: [spec.acceptanceCriteria[0], spec.acceptanceCriteria[0]],
    });
    expect(result.success).toBe(false);
  });

  it('computes the same hash regardless of key order', () => {
    const spec = makeSpec();
    const reordered = Object.fromEntries(Object.entries(spec).reverse()) as Spec;
    reordered.acceptanceCriteria = spec.acceptanceCriteria.map(
      (ac) => Object.fromEntries(Object.entries(ac).reverse()) as typeof ac,
    );
    expect(computeSpecHash(reordered)).toBe(computeSpecHash(spec));
  });

  it('changes the hash when an acceptance criterion changes', () => {
    const spec = makeSpec();
    const changed: Spec = {
      ...spec,
      acceptanceCriteria: [{ ...spec.acceptanceCriteria[0], then: 'the API returns 200' }, spec.acceptanceCriteria[1]],
    };
    expect(computeSpecHash(changed)).not.toBe(computeSpecHash(spec));
  });

  it('ignores status and validation reports in the hash', () => {
    const spec = makeSpec();
    const moved: Spec = { ...spec, status: 'done', validationReports: [{ at: '2026-09-23T10:00:00Z', text: 'ok' }] };
    expect(computeSpecHash(moved)).toBe(computeSpecHash(spec));
  });

  it('freezes a refining spec', () => {
    const frozen = freezeSpec(makeSpec());
    expect(frozen.status).toBe('running');
    expect(frozen.specVersion).toBe(1);
    expect(frozen.specHash).toMatch(HASH_PATTERN);
    expect(frozen.specHash).toBe(computeSpecHash(frozen));
  });

  it('refuses to freeze a spec that is not refining', () => {
    expect(() => freezeSpec(makeSpec({ status: 'running' }))).toThrow(SpecFrozenError);
  });
});

describe('Plan', () => {
  it('parses a valid plan', () => {
    const plan = makePlan(freezeSpec(makeSpec()));
    expect(plan.tasks.map((t) => t.id)).toEqual(['T0-scaffold', 'T1-create', 'T2-list', 'T3-deploy']);
  });

  it('rejects an out-of-range port', () => {
    const plan = makePlan(freezeSpec(makeSpec()));
    expect(Plan.safeParse({ ...plan, deploy: { ...plan.deploy, port: 0 } }).success).toBe(false);
  });

  it('rejects malformed task ids', () => {
    const plan = makePlan(freezeSpec(makeSpec()));
    const bad = { ...plan, tasks: [{ ...plan.tasks[0], id: 'scaffold' }] };
    expect(Plan.safeParse(bad).success).toBe(false);
  });
});
