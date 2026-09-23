import { Plan, PlanTask } from '../../server/contracts/plan.js';
import { Project } from '../../server/contracts/project.js';
import { Spec, freezeSpec } from '../../server/contracts/spec.js';

export function makeProject(overrides: Partial<Project> = {}): Project {
  return Project.parse({
    projectId: 'todo-api',
    name: 'Todo API',
    vision: 'A minimal todo service',
    personas: [{ name: 'Developer', description: 'Integrates the API' }],
    constraints: [],
    principles: ['Every acceptance test name carries its [AC-xxx] tag'],
    deploy: { target: 'docker-local' },
    ...overrides,
  });
}

export function makeSpec(overrides: Partial<Spec> = {}): Spec {
  return Spec.parse({
    specId: 'spec-001',
    specVersion: 0,
    specHash: null,
    objectives: ['Users can manage todo items'],
    features: ['Create a todo', 'List todos'],
    acceptanceCriteria: [
      {
        id: 'AC-001',
        given: 'no todos exist',
        when: 'a client POSTs /todos with a title',
        then: 'the API returns 201 with the created todo',
        smoke: true,
      },
      {
        id: 'AC-002',
        given: 'two todos exist',
        when: 'a client GETs /todos',
        then: 'the API returns both todos',
        smoke: false,
      },
    ],
    outOfScope: ['Authentication'],
    externalDependencies: [],
    status: 'refining',
    ...overrides,
  });
}

export function makeFrozenSpec(overrides: Partial<Spec> = {}): Spec {
  return freezeSpec(makeSpec(overrides));
}

export function makePlanTask(overrides: Partial<PlanTask> & { id: string }): PlanTask {
  return PlanTask.parse({
    title: `Task ${overrides.id}`,
    description: 'Fixture task',
    criteriaRefs: [],
    dependsOn: [],
    affectedPaths: [`src/${overrides.id.toLowerCase()}/**`],
    owner: 'dev',
    ...overrides,
  });
}

/** The gate set every POC plan must carry (spec §4.3). */
export const REQUIRED_GATES = [
  { name: 'format', command: 'npm run format:check', blocking: true },
  { name: 'lint', command: 'npm run lint', blocking: true },
  { name: 'typecheck', command: 'npm run typecheck', blocking: true },
  { name: 'unit-test', command: 'npm test', blocking: true },
  { name: 'build', command: 'npm run build', blocking: true },
  { name: 'secret-scan', command: 'gitleaks detect --no-git -s .', blocking: true },
  { name: 'dependency-scan', command: 'osv-scanner .', blocking: false },
];

export function makePlan(spec: Spec, overrides: Partial<Plan> = {}): Plan {
  if (spec.specHash === null) throw new Error('makePlan requires a frozen spec');
  return Plan.parse({
    specId: spec.specId,
    specHash: spec.specHash,
    stack: 'node-typescript',
    adrRefs: ['ADR-001'],
    commands: {
      install: 'npm ci',
      format: 'npm run format:check',
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      test: 'npm test',
      build: 'npm run build',
      run: 'npm start',
      healthcheck: 'curl -fsS http://localhost:3000/health',
    },
    junitPath: 'reports/junit.xml',
    gates: REQUIRED_GATES,
    frozenPaths: ['package.json', 'package-lock.json', 'vitest.config.ts'],
    tasks: [
      makePlanTask({
        id: 'T0-scaffold',
        affectedPaths: ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'src/index.ts'],
      }),
      makePlanTask({
        id: 'T1-create',
        criteriaRefs: ['AC-001'],
        dependsOn: ['T0-scaffold'],
        affectedPaths: ['src/todos/create/**'],
      }),
      makePlanTask({
        id: 'T2-list',
        criteriaRefs: ['AC-002'],
        dependsOn: ['T0-scaffold'],
        affectedPaths: ['src/todos/list/**'],
      }),
      makePlanTask({
        id: 'T3-deploy',
        dependsOn: ['T0-scaffold'],
        affectedPaths: ['Dockerfile', 'deploy/**'],
        owner: 'devops',
      }),
    ],
    deploy: { image: 'todo-api', port: 3000, healthcheckPath: '/health', manifests: ['deploy/k8s.yaml'] },
    ...overrides,
  });
}
