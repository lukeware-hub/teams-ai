import { describe, expect, it } from 'vitest';
import type { Plan } from '../../server/contracts/plan.js';
import { findCycle, validatePlan } from '../../server/validators/plan.js';
import { REQUIRED_GATES, makeFrozenSpec, makePlan, makePlanTask } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const withTasks = (tasks: Plan['tasks']): Plan => ({ ...makePlan(spec), tasks });
const devops = makePlanTask({ id: 'T9-infra', owner: 'devops', dependsOn: ['T0-scaffold'], affectedPaths: ['Dockerfile'] });

describe('validatePlan', () => {
  it('accepts the fixture plan', () => {
    expect(validatePlan(makePlan(spec), spec, { firstSpec: true })).toEqual([]);
  });

  it('rejects a plan built for another spec version', () => {
    const plan = { ...makePlan(spec), specHash: `sha256:${'0'.repeat(64)}` };
    expect(validatePlan(plan, spec, { firstSpec: true })).toContain(
      `plan specHash ${plan.specHash} does not match spec ${spec.specHash}`,
    );
  });

  it('rejects a task that lists the JUnit report and a command that fetches a tool at a moving reference', () => {
    const base = makePlan(spec);
    const tasks = base.tasks.map((t, i) => (i === 0 ? { ...t, affectedPaths: [...t.affectedPaths, base.junitPath] } : t));
    const gates = [...base.gates, { name: 'license-scan', command: 'go run github.com/google/go-licenses/v2@master check ./...', blocking: true, network: 'egress' as const, secrets: [] }];
    const errors = validatePlan({ ...base, tasks, gates }, spec, { firstSpec: true });
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining(`lists ${base.junitPath}`), expect.stringContaining('github.com/google/go-licenses/v2@master')]));
  });

  it('rejects an unfrozen spec', () => {
    expect(validatePlan(makePlan(spec), { ...spec, specHash: null }, { firstSpec: true })).toContain('spec is not frozen');
  });

  it('reports duplicate ids, self dependencies and unknown dependencies', () => {
    const errors = validatePlan(
      withTasks([
        makePlanTask({ id: 'T0-scaffold' }),
        makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001', 'AC-002'], dependsOn: ['T0-scaffold', 'T1-a'] }),
        makePlanTask({ id: 'T1-a', dependsOn: ['T0-scaffold'] }),
        makePlanTask({ id: 'T2-b', dependsOn: ['T0-scaffold', 'T9-ghost'] }),
        devops,
      ]),
      spec,
      { firstSpec: true },
    );
    expect(errors).toEqual(
      expect.arrayContaining(['duplicate task id T1-a', 'task T1-a depends on itself', 'task T2-b depends on unknown task T9-ghost']),
    );
  });

  it('skips cycle detection when ids are duplicated', () => {
    const errors = validatePlan(
      withTasks([
        makePlanTask({ id: 'T0-scaffold' }),
        makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001', 'AC-002'], dependsOn: ['T0-scaffold', 'T2-b'] }),
        makePlanTask({ id: 'T2-b', dependsOn: ['T1-a'] }),
        makePlanTask({ id: 'T2-b', dependsOn: ['T0-scaffold'] }),
        devops,
      ]),
      spec,
      { firstSpec: true },
    );
    expect(errors).toContain('duplicate task id T2-b');
    expect(errors.some((e) => e.startsWith('dependency cycle'))).toBe(false);
  });

  it('reports uncovered and unknown acceptance criteria', () => {
    const errors = validatePlan(
      withTasks([makePlanTask({ id: 'T0-scaffold' }), makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001', 'AC-099'], dependsOn: ['T0-scaffold'] }), devops]),
      spec,
      { firstSpec: true },
    );
    expect(errors).toEqual(
      expect.arrayContaining(['task T1-a references unknown acceptance criterion AC-099', 'acceptance criterion AC-002 is not covered by any task']),
    );
  });

  it('reports a three-task cycle with its path', () => {
    const errors = validatePlan(
      withTasks([
        makePlanTask({ id: 'T0-scaffold' }),
        makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001', 'AC-002'], dependsOn: ['T0-scaffold', 'T3-c'] }),
        makePlanTask({ id: 'T2-b', dependsOn: ['T1-a'] }),
        makePlanTask({ id: 'T3-c', dependsOn: ['T2-b'] }),
        devops,
      ]),
      spec,
      { firstSpec: true },
    );
    expect(errors).toContain('dependency cycle: T1-a -> T3-c -> T2-b -> T1-a');
  });

  it('requires a scaffold task on the first spec that every task depends on', () => {
    const missing = validatePlan(withTasks([makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001', 'AC-002'] }), devops]), spec, { firstSpec: true });
    expect(missing).toContain('first spec requires task T0-scaffold');

    const detached = validatePlan(
      withTasks([
        makePlanTask({ id: 'T0-scaffold' }),
        makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001', 'AC-002'], dependsOn: ['T0-scaffold'] }),
        makePlanTask({ id: 'T2-b' }),
        devops,
      ]),
      spec,
      { firstSpec: true },
    );
    expect(detached).toContain('task T2-b must depend on T0-scaffold');
  });

  it('rejects a scaffold task with dependencies', () => {
    const errors = validatePlan(
      withTasks([
        makePlanTask({ id: 'T0-scaffold', dependsOn: ['T1-a'] }),
        makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001', 'AC-002'] }),
        devops,
      ]),
      spec,
      { firstSpec: true },
    );
    expect(errors).toContain('T0-scaffold must not depend on other tasks');
  });

  it('accepts a transitive dependency on the scaffold task', () => {
    const errors = validatePlan(
      withTasks([
        makePlanTask({ id: 'T0-scaffold' }),
        makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001'], dependsOn: ['T0-scaffold'] }),
        makePlanTask({ id: 'T2-b', criteriaRefs: ['AC-002'], dependsOn: ['T1-a'] }),
        devops,
      ]),
      spec,
      { firstSpec: true },
    );
    expect(errors).toEqual([]);
  });

  it('requires a devops-owned infrastructure task on the first spec', () => {
    const errors = validatePlan(
      withTasks([makePlanTask({ id: 'T0-scaffold' }), makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001', 'AC-002'], dependsOn: ['T0-scaffold'] })]),
      spec,
      { firstSpec: true },
    );
    expect(errors).toContain('first spec requires a deploy-infrastructure task owned by devops');
  });

  it('forbids the scaffold task after the first spec and needs no devops task', () => {
    expect(validatePlan(withTasks([makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001', 'AC-002'] })]), spec, { firstSpec: false })).toEqual([]);
    expect(
      validatePlan(withTasks([makePlanTask({ id: 'T0-scaffold' }), makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001', 'AC-002'] })]), spec, { firstSpec: false }),
    ).toContain('T0-scaffold is only allowed on the first spec');
  });

  it('requires every mandatory blocking gate', () => {
    const plan = { ...makePlan(spec), gates: REQUIRED_GATES.filter((g) => g.name !== 'secret-scan' && g.name !== 'build') };
    const errors = validatePlan(plan, spec, { firstSpec: true });
    expect(errors).toEqual(expect.arrayContaining(['missing blocking gate build', 'missing blocking gate secret-scan']));
  });

  it('treats a non-blocking mandatory gate as missing', () => {
    const plan = { ...makePlan(spec), gates: REQUIRED_GATES.map((g) => (g.name === 'lint' ? { ...g, blocking: false } : g)) };
    expect(validatePlan(plan, spec, { firstSpec: true })).toContain('missing blocking gate lint');
  });

  it('requires a typecheck gate only when the stack has a typecheck command', () => {
    const noTypecheckGate = { ...makePlan(spec), gates: REQUIRED_GATES.filter((g) => g.name !== 'typecheck') };
    expect(validatePlan(noTypecheckGate, spec, { firstSpec: true })).toContain('missing blocking gate typecheck (commands.typecheck is defined)');
    const { typecheck: _omit, ...commands } = noTypecheckGate.commands;
    expect(validatePlan({ ...noTypecheckGate, commands }, spec, { firstSpec: true })).toEqual([]);
  });
});

describe('findCycle', () => {
  it('returns null for an acyclic graph', () => {
    expect(findCycle([makePlanTask({ id: 'T1-a' }), makePlanTask({ id: 'T2-b', dependsOn: ['T1-a'] })])).toBeNull();
  });

  it('uses the first occurrence when ids repeat', () => {
    expect(
      findCycle([makePlanTask({ id: 'T1-a', dependsOn: ['T2-b'] }), makePlanTask({ id: 'T2-b', dependsOn: ['T1-a'] }), makePlanTask({ id: 'T2-b' })]),
    ).toEqual(['T1-a', 'T2-b', 'T1-a']);
  });
});

describe('validatePlan: gate image', () => {
  it('rejects an Alpine gate image, since the Dev installs dependencies on a glibc host', () => {
    for (const image of ['node:22-alpine', 'node:22.4-alpine3.20', 'alpine:3.20']) {
      expect(validatePlan(makePlan(spec, { gateImage: image }), spec, { firstSpec: true }).join('\n')).toMatch(/Alpine \(musl\)/);
    }
    expect(validatePlan(makePlan(spec, { gateImage: 'node:22-bookworm-slim' }), spec, { firstSpec: true })).toEqual([]);
  });

  it('rejects an image that docker run would read as a flag', () => {
    expect(validatePlan(makePlan(spec, { gateImage: '--privileged' }), spec, { firstSpec: true }).join(' ')).toMatch(/must not start with/);
  });
});

describe('validatePlan: a devops task only touches infra', () => {
  // Live finding (R11.2 program run, 2026-10-07): an SM-planned fix task owned by devops but writing a
  // TypeScript test file could not run prettier/tsc/vitest at all (ROLE_ALLOW.devops carries no Bash),
  // and it looped GATE_FAILED -> TASK_REPLANNED on the same mistake. planRules already promises the agent
  // "use devops only for Dockerfile, deploy manifests, CI/release workflows and docker-compose"; nothing enforced it.
  it('rejects a devops task whose affectedPaths are not infra', () => {
    const task = makePlanTask({ id: 'T900-fix-1', owner: 'devops', dependsOn: ['T0-scaffold'], affectedPaths: ['tests/unit/plataforma/persistencia-volume.test.ts'] });
    const errors = validatePlan(withTasks([...makePlan(spec).tasks, task]), spec, { firstSpec: true }).join('\n');
    expect(errors).toMatch(/T900-fix-1.*devops.*persistencia-volume\.test\.ts/);
  });
  it('accepts Dockerfile, deployment.json, docker-compose.yml, .dockerignore, a CI workflow and a path under a declared deploy manifest', () => {
    // Live finding (R11.3/4 program run, r4, 2026-10-07): a devops task touching the real .dockerignore
    // it had already shipped in an earlier merged task was rejected as "not infra".
    const paths = ['Dockerfile', 'Dockerfile.prod', 'deployment.json', 'docker-compose.yml', '.dockerignore', '.github/workflows/ci.yml', 'deploy/new-manifest.yaml'];
    for (const p of paths) {
      const task = makePlanTask({ id: 'T900-fix-1', owner: 'devops', dependsOn: ['T0-scaffold'], affectedPaths: [p] });
      expect(validatePlan(withTasks([...makePlan(spec).tasks, task]), spec, { firstSpec: true }).join('\n'), p).not.toMatch(/only touches infra|is not infra/);
    }
  });
  it('a dev task may touch anything', () => {
    const task = makePlanTask({ id: 'T900-fix-1', owner: 'dev', dependsOn: ['T0-scaffold'], affectedPaths: ['tests/unit/plataforma/persistencia-volume.test.ts'] });
    expect(validatePlan(withTasks([...makePlan(spec).tasks, task]), spec, { firstSpec: true })).toEqual([]);
  });
});

describe('validatePlan: devops-only criteria need a smoke flag', () => {
  it('rejects a criterion only covered by devops tasks when the spec does not mark it smoke', () => {
    const s = { ...spec, acceptanceCriteria: spec.acceptanceCriteria.map((ac, i) => (i === 0 ? { ...ac, smoke: false } : ac)) };
    const onlyDevops = makePlanTask({ id: 'T9-infra', owner: 'devops', dependsOn: ['T0-scaffold'], criteriaRefs: [s.acceptanceCriteria[0]!.id] });
    const errors = validatePlan(withTasks([...makePlan(s).tasks.filter((t) => t.id !== 'T9-infra' && t.id !== 'T1-create'), onlyDevops]), s, { firstSpec: true }).join('\n');
    expect(errors).toMatch(/only covered by devops task/);
  });
  it('accepts it when the spec marks the criterion smoke: true', () => {
    const s = { ...spec, acceptanceCriteria: spec.acceptanceCriteria.map((ac, i) => (i === 0 ? { ...ac, smoke: true } : ac)) };
    const onlyDevops = makePlanTask({ id: 'T9-infra', owner: 'devops', dependsOn: ['T0-scaffold'], criteriaRefs: [s.acceptanceCriteria[0]!.id] });
    const errors = validatePlan(withTasks([...makePlan(s).tasks.filter((t) => t.id !== 'T9-infra' && t.id !== 'T1-create'), onlyDevops]), s, { firstSpec: true }).join('\n');
    expect(errors).not.toMatch(/only covered by devops task/);
  });
});
