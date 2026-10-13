import { describe, expect, it } from 'vitest';
import { canonicalJson, HASH_PATTERN, sha256 } from '../../server/contracts/hash.js';
import { Plan } from '../../server/contracts/plan.js';
import { Spec, SpecFrozenError, computeSpecHash, freezeSpec, generatedSecretNames, providedSecretNames } from '../../server/contracts/spec.js';
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
    expect(makeSpec()).toMatchObject({ type: 'feature' });
    expect(makeSpec().acceptanceCriteria).toHaveLength(2);
  });

  it('requires reproduction details for bug specs', () => {
    const result = Spec.safeParse({ ...makeSpec(), type: 'bug' });
    expect(result.success).toBe(false);

    const complete = Spec.safeParse({
      ...makeSpec(),
      type: 'bug',
      bug: { actual: '500', expected: '200', reproduction: 'GET /todos' },
    });
    expect(complete.success).toBe(true);
  });

  it('changes the hash when the work item type changes', () => {
    const spec = makeSpec();
    expect(computeSpecHash({ ...spec, type: 'maintenance' })).not.toBe(computeSpecHash(spec));
  });

  // R11.7.1: decisions are part of the frozen contract, while every spec written before them keeps its hash.
  it('hashes the decisions, and a spec without them keeps the hash it had before decisions existed', () => {
    const spec = Spec.parse(makeSpec());
    const { specId, specVersion, type, bug, objectives, features, acceptanceCriteria, outOfScope, externalDependencies, tasks } = spec;
    const before = sha256(canonicalJson({ specId, specVersion, type, bug, objectives, features, acceptanceCriteria, outOfScope, externalDependencies, tasks }));
    expect(computeSpecHash(spec)).toBe(before);
    expect(computeSpecHash({ ...spec, decisions: [{ question: 'Port?', answer: '8080' }] })).not.toBe(before);
  });

  it('splits the secrets a person provides from the ones the platform generates, and a spec without the flag keeps its hash', () => {
    const spec = Spec.parse({ ...makeSpec(), externalDependencies: [{ name: 'db', purpose: 'dados', secretNames: ['DATABASE_URL'] }, { name: 'identity', purpose: 'admin', secretNames: ['PLATFORM_ADMIN_TOKEN'], generated: true }] });
    expect(providedSecretNames(spec.externalDependencies)).toEqual(['DATABASE_URL']);
    expect(generatedSecretNames(spec.externalDependencies)).toEqual(['PLATFORM_ADMIN_TOKEN']);
    const plain = Spec.parse({ ...makeSpec(), externalDependencies: [{ name: 'db', purpose: 'dados', secretNames: ['DATABASE_URL'] }] });
    expect(plain.externalDependencies[0]).not.toHaveProperty('generated');
  });

  it('rejects malformed acceptance criterion ids', () => {
    const result = Spec.safeParse({
      ...makeSpec(),
      acceptanceCriteria: [{ id: 'AC-1', given: 'g', when: 'w', then: 't' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts ids of four digits and more, but one way to write each number', () => {
    const ok = (id: string) => Spec.safeParse({ ...makeSpec(), acceptanceCriteria: [{ id, given: 'g', when: 'w', then: 't' }] }).success;
    expect([ok('AC-999'), ok('AC-1000'), ok('AC-12345')]).toEqual([true, true, true]);
    expect([ok('AC-0034'), ok('AC-01000'), ok('AC-99')]).toEqual([false, false, false]);
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

  it('parses a planned spec and keeps its provenance out of the hash', () => {
    const spec = makeSpec();
    const derivedFrom = { backlogKey: 'opme', inputHash: `sha256:${'b'.repeat(64)}`, docsHash: `sha256:${'c'.repeat(64)}`, sources: [{ doc: 'flow.md' as const, heading: '7. OPME', hash: `sha256:${'d'.repeat(64)}` }, { doc: 'briefing.md' as const, heading: 'Fora do mapa', hash: null }] };
    const planned = Spec.parse({ ...spec, status: 'planned', derivedFrom });
    expect(planned.status).toBe('planned');
    expect(planned.derivedFrom).toEqual(derivedFrom);
    expect(computeSpecHash(planned)).toBe(computeSpecHash(spec));
    expect(Spec.safeParse({ ...spec, derivedFrom: { ...derivedFrom, sources: [{ doc: 'brief.md', heading: 'x', hash: null }] } }).success).toBe(false);
  });

  it('freezes a refining spec', () => {
    const frozen = freezeSpec(makeSpec());
    expect(frozen.status).toBe('running');
    expect(frozen.specVersion).toBe(1);
    expect(frozen.specHash).toMatch(HASH_PATTERN);
    expect(frozen.specHash).toBe(computeSpecHash(frozen));
  });

  it('freezes a planned spec at its turn, keeping its provenance', () => {
    const planned = makeSpec({ status: 'planned' });
    const frozen = freezeSpec(planned);
    expect(frozen.status).toBe('running');
    expect(frozen.specVersion).toBe(planned.specVersion + 1);
    expect(frozen.specHash).toBe(computeSpecHash(frozen));
  });

  it('refuses to freeze a spec that is neither refining nor planned', () => {
    expect(() => freezeSpec(makeSpec({ status: 'running' }))).toThrow(SpecFrozenError);
    expect(() => freezeSpec(makeSpec({ status: 'done' }))).toThrow(SpecFrozenError);
  });

  it('parses a spec retired from the backlog, which can never be frozen (R11.7.5)', () => {
    const retired = makeSpec({ status: 'retired' });
    expect(retired.status).toBe('retired');
    expect(() => freezeSpec(retired)).toThrow(SpecFrozenError);
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

  it('accepts the optional deploy kind and docs path, and rejects bad ones', () => {
    const plan = makePlan(freezeSpec(makeSpec()));
    expect(Plan.safeParse({ ...plan, deploy: { ...plan.deploy, kind: 'api', docsPath: '/docs' } }).success).toBe(true);
    expect(Plan.safeParse({ ...plan, deploy: { ...plan.deploy, kind: 'front' } }).success).toBe(true);
    expect(Plan.safeParse({ ...plan, deploy: { ...plan.deploy, kind: 'mobile' } }).success).toBe(false);
    expect(Plan.safeParse({ ...plan, deploy: { ...plan.deploy, docsPath: 'docs' } }).success).toBe(false);
  });

  it('rejects malformed task ids', () => {
    const plan = makePlan(freezeSpec(makeSpec()));
    const bad = { ...plan, tasks: [{ ...plan.tasks[0], id: 'scaffold' }] };
    expect(Plan.safeParse(bad).success).toBe(false);
  });

  it('rejects paths that escape the repository or widen a glob match', () => {
    const plan = makePlan(freezeSpec(makeSpec()));
    const withPath = (p: string) => ({ ...plan, tasks: [{ ...plan.tasks[1]!, affectedPaths: [p] }, ...plan.tasks.slice(2)] });
    for (const bad of ['../other/**', 'src/../../x', '/etc/passwd', 'C:/work/x', '\\\\server\\share', '!src/**', 'src/!(gates)/**', 'src/@(a|b).ts']) {
      expect(Plan.safeParse(withPath(bad)).success, bad).toBe(false);
    }
    for (const ok of ['src/**', 'src/todos/create/**', 'package.json', 'deploy/k8s.yaml', 'a (copy).ts', '**/*.md']) {
      expect(Plan.safeParse(withPath(ok)).success, ok).toBe(true);
    }
    expect(Plan.safeParse({ ...plan, frozenPaths: ['../package.json'] }).success).toBe(false);
    expect(Plan.safeParse({ ...plan, junitPath: '/tmp/junit.xml' }).success).toBe(false);
    expect(Plan.safeParse({ ...plan, deploy: { ...plan.deploy, manifests: ['../../secrets.yaml'] } }).success).toBe(false);
  });

  it('run-state and plan contracts import nothing from node: (browser reducer)', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const out = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', "import('./server/pipeline/run-state.ts').then(() => console.log('ok'))"], { env: { ...process.env, NODE_OPTIONS: '--import tsx' } });
    expect(out.stdout.trim()).toBe('ok');
    const src = await (await import('node:fs/promises')).readFile('server/contracts/plan.ts', 'utf8');
    expect(src).not.toContain("from './hash.js'");
    expect(src).not.toContain("from './spec.js'");
  });
});
