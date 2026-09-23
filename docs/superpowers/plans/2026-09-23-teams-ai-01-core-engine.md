# teams-ai Plan 1 — Core Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic, LLM-free core of the teams-ai orchestrator: data contracts, event store, task state machine, scheduler, retry policy, validators, evidence collection and diff guard.

**Architecture:** Pure TypeScript modules with no I/O except the event store's append-only NDJSON file. Every module is a small unit with a typed interface so later plans (runner, execution plane, pipeline wiring, UI, System 1) compose them without reaching into internals. Contracts are defined once with zod 4 and reused for runtime validation (and, in Plan 3, for JSON Schema generation passed to `claude --json-schema`).

**Tech Stack:** Node 22 (ESM), TypeScript 5.9.3, Vitest 5, zod 4, fast-xml-parser 5, picomatch 4.

**Spec:** `docs/superpowers/specs/2026-09-23-teams-ai-poc-design.md`

## Plan series

The spec covers several independent subsystems, so it is implemented as a series of plans. Each plan produces working, tested software and is written after the previous one lands, so it can build on real interfaces.

1. **Core engine** (this plan) — contracts, event store, state machine, scheduler, retry policy, validators, evidence, diff guard.
2. **Environment and CLI spike** — WSL2 Ubuntu setup script and checklist; spike verifying the open items in spec §16 (plugin/hook leakage with `--setting-sources project`, compaction and usage-limit events in stream-json, `--json-schema` behavior, turn caps). Output: findings document that Plan 3 depends on.
3. **Runner, agents and budget** — `claude -p` runner, fake `claude` binary, provider profiles (Claude / OmniRoute), `.claude/agents/*.md`, agent output contracts and JSON Schema generation, token accounting, budgets, concurrency governor, quota circuit breaker.
4. **Execution plane** — containerized gate runner, git controller and merge queue (idempotent), `docker-local` and `kind` deploy adapters with smoke and rollback.
5. **Knowledge** — context pack builder, graphify wrapper, SQLite FTS5 retrieval, dependency handoff summaries.
6. **Pipeline wiring** — phases 0–6 end to end on the fake runner, crash recovery and reconciliation, `state.json` snapshots, spec-gap routing and assumptions log, compaction handling.
7. **API, UI and Gate 1** — Fastify REST + SSE, React UI (Projects, Refinement, Execution, Validation), secrets handling.
8. **System 1 decision layer** — `choice/score/noul`, llama.cpp logprobs backend, escalation, calibration, the nine decisions, decision evals.
9. **Golden runs** — reference TODO spec, the three comparison runs and the results report.

## Global Constraints

- Node `>=22.12` (Vitest 5 engine floor); ESM only (`"type": "module"`).
- TypeScript pinned to `5.9.3` (not 7.x); `module`/`moduleResolution` `NodeNext`; relative imports use the `.js` suffix.
- zod `4.6.5`, fast-xml-parser `5.11.1`, picomatch `4.0.7`, Vitest `5.0.1`, `@types/node` `22.x`, `@types/picomatch` `4.0.3` — exact pins.
- No network, LLM or subprocess calls anywhere in this plan.
- All code, comments, commit messages and docs in English.
- IDs: slugs match `^[a-z0-9]+(?:-[a-z0-9]+)*$`; task IDs match `^T\d+(?:-[a-z0-9]+)*$`; AC IDs match `^AC-\d{3}$`; ADR IDs match `^ADR-\d{3}$`; hashes match `^sha256:[0-9a-f]{64}$`.
- Retry defaults from the spec: 3 attempts per task, 1 replan, 3 infra retries per gate, 2 schema retries per step, 1 flaky re-run per gate, `maxParallel` 3.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```

## Review Focus

1. **Crash mid-append** leaves a torn last line in `events.ndjson` — reopening must drop the partial tail and keep appending with contiguous `seq` (test in Task 3).
2. **Agent-reported paths** with backslashes, a `./` prefix, trailing slashes or bare directory names (`src/auth`) — must match globs the way a person expects: `src/auth` covers `src/auth/login.ts` (tests in Tasks 5 and 9).
3. **JUnit variants** — a single root `<testsuite>`, nested suites, `<skipped/>` cases and an empty report; skipped never counts as evidence and zero tests fails the gate (tests in Task 8).
4. **AC tag variants in test names** — `[ac-003]` counts as `AC-003`; `[AC-3]` does not count (tests in Task 8).
5. **Replan with dependents** — dependents of a superseded task must wait for its replacements, and a replacement that depends on the superseded task is rejected (tests in Task 4).

---

## File structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, .gitattributes
server/core/ids.ts                deterministic identifiers
server/core/paths.ts              path normalization, glob prefix overlap
server/contracts/hash.ts          canonical JSON + sha256
server/contracts/project.ts       Project schema
server/contracts/spec.ts          Spec schema, computeSpecHash, freezeSpec
server/contracts/plan.ts          Plan schema
server/store/event-store.ts       append-only NDJSON event log
server/pipeline/task-state.ts     task states and allowed transitions
server/pipeline/run-state.ts      event reducer producing RunState
server/scheduler/scheduler.ts     runnable selection, block propagation, run progress
server/scheduler/retry-policy.ts  failure → action decision
server/validators/result.ts       Validation<T> result type
server/validators/references.ts   reference resolution
server/validators/agent-output.ts schema → specHash → refs → semantic pipeline
server/validators/plan.ts         plan validation (DAG, coverage, scaffold rule)
server/validators/diff-guard.ts   frozen files + scope guard
server/evidence/junit.ts          JUnit XML parser
server/evidence/matrix.ts         AC evidence matrix and gates
test/fixtures/contracts.ts        shared contract builders
test/fixtures/run-state.ts        shared RunState builders
test/**/*.test.ts                 one test file per module
```

---

### Task 1: Project scaffold and deterministic IDs

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.gitattributes`
- Create: `server/core/ids.ts`
- Test: `test/core/ids.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ID_PATTERNS: { SLUG: RegExp; TASK_ID: RegExp }`
  - `class InvalidIdError extends Error`
  - `assertSlug(value: string, label: string): string`
  - `assertTaskId(value: string): string`
  - `repoName(projectId: string): string`
  - `taskBranch(specId: string, taskId: string): string`
  - `attemptId(runId: string, taskId: string, attempt: number): string`
  - `stepId(runId: string, seq: number): string`

- [ ] **Step 1: Create project files**

`package.json`:
```json
{
  "name": "teams-ai",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.12" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["server", "test", "vitest.config.ts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
```

`.gitignore`:
```
node_modules/
dist/
coverage/
*.log
```

`.gitattributes`:
```
* text=auto eol=lf
```

- [ ] **Step 2: Install pinned dependencies**

Run:
```bash
npm install --save-exact zod@4.6.5 fast-xml-parser@5.11.1 picomatch@4.0.7
npm install --save-exact --save-dev typescript@5.9.3 vitest@5.0.1 @types/node@22.20.4 @types/picomatch@4.0.3
```
Expected: `package-lock.json` created, no errors.

- [ ] **Step 3: Write the failing test**

`test/core/ids.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  InvalidIdError,
  assertSlug,
  attemptId,
  repoName,
  stepId,
  taskBranch,
} from '../../server/core/ids.js';

describe('ids', () => {
  it('accepts lowercase slugs', () => {
    expect(assertSlug('todo-api', 'projectId')).toBe('todo-api');
  });

  it('rejects slugs with spaces or uppercase', () => {
    expect(() => assertSlug('Todo API', 'projectId')).toThrow(InvalidIdError);
  });

  it('derives the repository name from the project id', () => {
    expect(repoName('todo-api')).toBe('todo-api');
  });

  it('builds a deterministic lowercase task branch', () => {
    expect(taskBranch('spec-001', 'T3-auth')).toBe('task/spec-001-t3-auth');
  });

  it('rejects malformed task ids', () => {
    expect(() => taskBranch('spec-001', 'task3')).toThrow(InvalidIdError);
  });

  it('builds attempt ids and rejects non-positive attempts', () => {
    expect(attemptId('run-1', 'T1-create', 2)).toBe('run-1/T1-create/a2');
    expect(() => attemptId('run-1', 'T1-create', 0)).toThrow(InvalidIdError);
  });

  it('zero-pads step ids', () => {
    expect(stepId('run-1', 7)).toBe('run-1/s00007');
    expect(() => stepId('run-1', 0)).toThrow(InvalidIdError);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/core/ids.test.ts`
Expected: FAIL — cannot resolve `../../server/core/ids.js`.

- [ ] **Step 5: Write minimal implementation**

`server/core/ids.ts`:
```ts
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID = /^T\d+(?:-[a-z0-9]+)*$/;

export const ID_PATTERNS = { SLUG, TASK_ID } as const;

export class InvalidIdError extends Error {}

export function assertSlug(value: string, label: string): string {
  if (!SLUG.test(value)) {
    throw new InvalidIdError(`${label} must be a lowercase slug, got "${value}"`);
  }
  return value;
}

export function assertTaskId(value: string): string {
  if (!TASK_ID.test(value)) {
    throw new InvalidIdError(`taskId must match T<number>[-slug], got "${value}"`);
  }
  return value;
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new InvalidIdError(`${label} must be a positive integer, got ${value}`);
  }
  return value;
}

export function repoName(projectId: string): string {
  return assertSlug(projectId, 'projectId');
}

export function taskBranch(specId: string, taskId: string): string {
  return `task/${assertSlug(specId, 'specId')}-${assertTaskId(taskId).toLowerCase()}`;
}

export function attemptId(runId: string, taskId: string, attempt: number): string {
  assertPositiveInteger(attempt, 'attempt');
  return `${assertSlug(runId, 'runId')}/${assertTaskId(taskId)}/a${attempt}`;
}

export function stepId(runId: string, seq: number): string {
  assertPositiveInteger(seq, 'seq');
  return `${assertSlug(runId, 'runId')}/s${String(seq).padStart(5, '0')}`;
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/core/ids.test.ts && npm run typecheck`
Expected: 7 tests PASS; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .gitattributes server/core/ids.ts test/core/ids.test.ts
git commit -m "feat: scaffold project and add deterministic ids" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Data contracts and spec hashing

**Files:**
- Create: `server/contracts/hash.ts`, `server/contracts/project.ts`, `server/contracts/spec.ts`, `server/contracts/plan.ts`
- Create: `test/fixtures/contracts.ts`
- Test: `test/contracts/contracts.test.ts`

**Interfaces:**
- Consumes: `ID_PATTERNS` from Task 1.
- Produces:
  - `HASH_PATTERN: RegExp`, `canonicalJson(value: unknown): string`, `sha256(text: string): string` (returns `sha256:<hex>`)
  - `Project` (zod schema and type), `DeployTarget`
  - `AC_ID: RegExp`, `AcceptanceCriterion`, `Spec` (zod schema and type), `SpecStatus`, `computeSpecHash(spec: Spec): string`, `freezeSpec(spec: Spec): Spec`, `class SpecFrozenError extends Error`
  - `ADR_ID: RegExp`, `Gate`, `PlanTask`, `Plan` (zod schemas and types)
  - Fixtures: `makeProject(overrides?)`, `makeSpec(overrides?)`, `makeFrozenSpec(overrides?)`, `makePlanTask(overrides & { id })`, `makePlan(spec, overrides?)`

- [ ] **Step 1: Write the contract modules needed by the fixtures**

`server/contracts/hash.ts`:
```ts
import { createHash } from 'node:crypto';

export const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = source[key];
      if (child !== undefined) out[key] = sortKeys(child);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}
```

`server/contracts/project.ts`:
```ts
import { z } from 'zod';
import { ID_PATTERNS } from '../core/ids.js';

export const DeployTarget = z.enum(['docker-local', 'kind']);
export type DeployTarget = z.infer<typeof DeployTarget>;

export const Persona = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

export const Project = z.object({
  projectId: z.string().regex(ID_PATTERNS.SLUG),
  name: z.string().min(1),
  vision: z.string().min(1),
  personas: z.array(Persona).min(1),
  constraints: z.array(z.string().min(1)),
  stack: z.string().min(1).optional(),
  principles: z.array(z.string().min(1)),
  deploy: z.object({ target: DeployTarget }),
  github: z.object({ owner: z.string().min(1).optional() }).default({}),
  confidential: z.boolean().default(false),
});
export type Project = z.infer<typeof Project>;
```

`server/contracts/spec.ts`:
```ts
import { z } from 'zod';
import { ID_PATTERNS } from '../core/ids.js';
import { HASH_PATTERN, canonicalJson, sha256 } from './hash.js';

export const AC_ID = /^AC-\d{3}$/;

export const AcceptanceCriterion = z.object({
  id: z.string().regex(AC_ID),
  given: z.string().min(1),
  when: z.string().min(1),
  then: z.string().min(1),
  smoke: z.boolean().default(false),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const ExternalDependency = z.object({
  name: z.string().min(1),
  purpose: z.string().min(1),
  secretNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
});

export const HumanTask = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
});

export const SpecStatus = z.enum([
  'refining',
  'running',
  'paused:quota',
  'paused:auth',
  'awaiting-validation',
  'done',
]);
export type SpecStatus = z.infer<typeof SpecStatus>;

export const ValidationReport = z.object({
  at: z.iso.datetime(),
  text: z.string().min(1),
});

export const Spec = z
  .object({
    specId: z.string().regex(ID_PATTERNS.SLUG),
    specVersion: z.number().int().nonnegative(),
    specHash: z.string().regex(HASH_PATTERN).nullable(),
    objectives: z.array(z.string().min(1)).min(1),
    features: z.array(z.string().min(1)),
    acceptanceCriteria: z.array(AcceptanceCriterion).min(1),
    outOfScope: z.array(z.string().min(1)),
    externalDependencies: z.array(ExternalDependency),
    tasks: z.array(HumanTask).optional(),
    status: SpecStatus,
    validationReports: z.array(ValidationReport).default([]),
  })
  .superRefine((spec, ctx) => {
    const seen = new Set<string>();
    for (const ac of spec.acceptanceCriteria) {
      if (seen.has(ac.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate acceptance criterion id ${ac.id}`,
          path: ['acceptanceCriteria'],
        });
      }
      seen.add(ac.id);
    }
  });
export type Spec = z.infer<typeof Spec>;

const HASHED_FIELDS = [
  'specId',
  'specVersion',
  'objectives',
  'features',
  'acceptanceCriteria',
  'outOfScope',
  'externalDependencies',
  'tasks',
] as const;

export function computeSpecHash(spec: Spec): string {
  const content: Record<string, unknown> = {};
  for (const field of HASHED_FIELDS) content[field] = spec[field];
  return sha256(canonicalJson(content));
}

export class SpecFrozenError extends Error {}

export function freezeSpec(spec: Spec): Spec {
  if (spec.status !== 'refining') {
    throw new SpecFrozenError(
      `spec ${spec.specId} is ${spec.status}; only refining specs can be frozen`,
    );
  }
  const next: Spec = { ...spec, specVersion: spec.specVersion + 1, status: 'running' };
  return { ...next, specHash: computeSpecHash(next) };
}
```

`server/contracts/plan.ts`:
```ts
import { z } from 'zod';
import { ID_PATTERNS } from '../core/ids.js';
import { HASH_PATTERN } from './hash.js';
import { AC_ID } from './spec.js';

export const ADR_ID = /^ADR-\d{3}$/;

export const Gate = z.object({
  name: z.string().regex(ID_PATTERNS.SLUG),
  command: z.string().min(1),
  blocking: z.boolean(),
});
export type Gate = z.infer<typeof Gate>;

export const Commands = z.object({
  install: z.string().min(1),
  format: z.string().min(1),
  lint: z.string().min(1),
  typecheck: z.string().min(1).optional(),
  test: z.string().min(1),
  build: z.string().min(1),
  run: z.string().min(1),
  healthcheck: z.string().min(1),
});

export const PlanTask = z.object({
  id: z.string().regex(ID_PATTERNS.TASK_ID),
  title: z.string().min(1),
  description: z.string().min(1),
  criteriaRefs: z.array(z.string().regex(AC_ID)),
  dependsOn: z.array(z.string().regex(ID_PATTERNS.TASK_ID)),
  affectedPaths: z.array(z.string().min(1)).min(1),
  owner: z.enum(['dev', 'devops']),
});
export type PlanTask = z.infer<typeof PlanTask>;

export const Plan = z.object({
  specId: z.string().regex(ID_PATTERNS.SLUG),
  specHash: z.string().regex(HASH_PATTERN),
  stack: z.string().min(1),
  adrRefs: z.array(z.string().regex(ADR_ID)),
  commands: Commands,
  junitPath: z.string().min(1),
  gates: z.array(Gate).min(1),
  frozenPaths: z.array(z.string().min(1)).min(1),
  tasks: z.array(PlanTask).min(1),
  deploy: z.object({
    image: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    healthcheckPath: z.string().startsWith('/'),
    manifests: z.array(z.string().min(1)),
  }),
});
export type Plan = z.infer<typeof Plan>;
```

- [ ] **Step 2: Write the shared fixtures**

`test/fixtures/contracts.ts`:
```ts
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
    gates: [
      { name: 'lint', command: 'npm run lint', blocking: true },
      { name: 'unit-test', command: 'npm test', blocking: true },
      { name: 'dependency-scan', command: 'osv-scanner .', blocking: false },
    ],
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
```

- [ ] **Step 3: Write the failing test**

`test/contracts/contracts.test.ts`:
```ts
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
```

- [ ] **Step 4: Run the contract tests**

The modules from Step 1 already exist (the fixtures need them), so run the suite to confirm the contracts behave as specified:

Run: `npx vitest run test/contracts/contracts.test.ts`
Expected: 14 tests PASS. If any fail, fix the contract module (not the test) until they pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/contracts test/fixtures/contracts.ts test/contracts
git commit -m "feat: add project, spec and plan contracts with spec hashing" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Append-only event store

**Files:**
- Create: `server/store/event-store.ts`
- Test: `test/store/event-store.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type EventKind = 'fact' | 'intent' | 'confirm'`
  - `interface EventInput { type: string; kind?: EventKind; intentId?: string; data?: Record<string, unknown> }`
  - `interface StoredEvent { seq: number; at: string; runId: string; specHash: string; type: string; kind: EventKind; intentId?: string; data: Record<string, unknown> }`
  - `class EventLogCorruptError extends Error`
  - `class EventStore { static open(opts: { file: string; runId: string; specHash: string; clock?: () => Date }): Promise<EventStore>; append(input: EventInput): Promise<StoredEvent>; readAll(): Promise<StoredEvent[]> }`
  - `loadEvents(file: string): Promise<StoredEvent[]>` (truncates a torn tail)
  - `unconfirmedIntents(events: readonly StoredEvent[]): StoredEvent[]`

- [ ] **Step 1: Write the failing test**

`test/store/event-store.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EventLogCorruptError,
  EventStore,
  loadEvents,
  unconfirmedIntents,
} from '../../server/store/event-store.js';

const HASH = `sha256:${'a'.repeat(64)}`;
const fixedClock = () => new Date('2026-09-23T12:00:00.000Z');

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-events-'));
  file = path.join(dir, 'runs', 'run-1', 'events.ndjson');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function open() {
  return EventStore.open({ file, runId: 'run-1', specHash: HASH, clock: fixedClock });
}

describe('EventStore', () => {
  it('assigns sequential seq numbers and persists events', async () => {
    const store = await open();
    const first = await store.append({ type: 'RUN_STARTED' });
    const second = await store.append({ type: 'TASK_READY', data: { taskId: 'T1-create' } });
    expect(first).toMatchObject({ seq: 1, type: 'RUN_STARTED', kind: 'fact', runId: 'run-1', specHash: HASH });
    expect(second.seq).toBe(2);
    expect(first.at).toBe('2026-09-23T12:00:00.000Z');
    expect((await loadEvents(file)).map((e) => e.type)).toEqual(['RUN_STARTED', 'TASK_READY']);
  });

  it('continues numbering after reopening', async () => {
    await (await open()).append({ type: 'A' });
    const reopened = await open();
    expect((await reopened.append({ type: 'B' })).seq).toBe(2);
  });

  it('serializes concurrent appends without gaps', async () => {
    const store = await open();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.append({ type: `E${i}` })));
    const seqs = (await store.readAll()).map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('drops a torn tail left by a crash and keeps appending', async () => {
    await (await open()).append({ type: 'A' });
    await fs.appendFile(file, '{"seq":2,"type":"PARTI');
    const reopened = await open();
    const next = await reopened.append({ type: 'B' });
    expect(next.seq).toBe(2);
    expect((await loadEvents(file)).map((e) => e.type)).toEqual(['A', 'B']);
  });

  it('rejects a corrupt line in the middle of the log', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'not json\n{"seq":1}\n');
    await expect(loadEvents(file)).rejects.toThrow(EventLogCorruptError);
  });

  it('rejects non-contiguous seq numbers', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const event = { at: 'x', runId: 'run-1', specHash: HASH, type: 'A', kind: 'fact', data: {} };
    await fs.writeFile(file, `${JSON.stringify({ ...event, seq: 1 })}\n${JSON.stringify({ ...event, seq: 3 })}\n`);
    await expect(loadEvents(file)).rejects.toThrow(EventLogCorruptError);
  });

  it('returns an empty list for a missing log', async () => {
    expect(await loadEvents(path.join(dir, 'missing.ndjson'))).toEqual([]);
  });

  it('requires an intentId for intent and confirm events', async () => {
    const store = await open();
    await expect(store.append({ type: 'PR_CREATE', kind: 'intent' })).rejects.toThrow(/intentId/);
    expect((await store.append({ type: 'AFTER' })).seq).toBe(1);
  });
});

describe('unconfirmedIntents', () => {
  it('returns intents that have no matching confirm', async () => {
    const store = await open();
    await store.append({ type: 'PR_CREATE', kind: 'intent', intentId: 'pr-t1' });
    await store.append({ type: 'PR_CREATE', kind: 'confirm', intentId: 'pr-t1' });
    await store.append({ type: 'MERGE', kind: 'intent', intentId: 'merge-t1' });
    const pending = unconfirmedIntents(await store.readAll());
    expect(pending.map((e) => e.intentId)).toEqual(['merge-t1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/store/event-store.test.ts`
Expected: FAIL — cannot resolve `../../server/store/event-store.js`.

- [ ] **Step 3: Write minimal implementation**

`server/store/event-store.ts`:
```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';

export type EventKind = 'fact' | 'intent' | 'confirm';

export interface EventInput {
  type: string;
  kind?: EventKind;
  intentId?: string;
  data?: Record<string, unknown>;
}

export interface StoredEvent {
  seq: number;
  at: string;
  runId: string;
  specHash: string;
  type: string;
  kind: EventKind;
  intentId?: string;
  data: Record<string, unknown>;
}

export class EventLogCorruptError extends Error {}

function parseEventLog(text: string): StoredEvent[] {
  const events: StoredEvent[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line) as StoredEvent);
    } catch {
      throw new EventLogCorruptError(`corrupt event at line ${i + 1}`);
    }
  }
  events.forEach((event, index) => {
    if (event.seq !== index + 1) {
      throw new EventLogCorruptError(`expected seq ${index + 1}, found ${event.seq}`);
    }
  });
  return events;
}

export async function loadEvents(file: string): Promise<StoredEvent[]> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  if (text.length > 0 && !text.endsWith('\n')) {
    // A crash during append leaves a partial last line; every complete event ends with '\n'.
    const complete = text.slice(0, text.lastIndexOf('\n') + 1);
    await fs.truncate(file, Buffer.byteLength(complete));
    text = complete;
  }
  return parseEventLog(text);
}

export function unconfirmedIntents(events: readonly StoredEvent[]): StoredEvent[] {
  const confirmed = new Set(events.filter((e) => e.kind === 'confirm').map((e) => e.intentId));
  return events.filter((e) => e.kind === 'intent' && !confirmed.has(e.intentId));
}

export class EventStore {
  private seq: number;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly runId: string,
    private readonly specHash: string,
    private readonly clock: () => Date,
    lastSeq: number,
  ) {
    this.seq = lastSeq;
  }

  static async open(opts: {
    file: string;
    runId: string;
    specHash: string;
    clock?: () => Date;
  }): Promise<EventStore> {
    await fs.mkdir(path.dirname(opts.file), { recursive: true });
    const events = await loadEvents(opts.file);
    return new EventStore(
      opts.file,
      opts.runId,
      opts.specHash,
      opts.clock ?? (() => new Date()),
      events.at(-1)?.seq ?? 0,
    );
  }

  append(input: EventInput): Promise<StoredEvent> {
    return this.enqueue(async () => {
      const kind = input.kind ?? 'fact';
      if (kind !== 'fact' && !input.intentId) {
        throw new Error(`${kind} events require an intentId`);
      }
      const event: StoredEvent = {
        seq: this.seq + 1,
        at: this.clock().toISOString(),
        runId: this.runId,
        specHash: this.specHash,
        type: input.type,
        kind,
        ...(input.intentId ? { intentId: input.intentId } : {}),
        data: input.data ?? {},
      };
      const handle = await fs.open(this.file, 'a');
      try {
        await handle.write(`${JSON.stringify(event)}\n`);
        await handle.datasync();
      } finally {
        await handle.close();
      }
      this.seq = event.seq;
      return event;
    });
  }

  readAll(): Promise<StoredEvent[]> {
    return this.enqueue(() => loadEvents(this.file));
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => undefined);
    return result;
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/store/event-store.test.ts && npm run typecheck`
Expected: 9 tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/store test/store
git commit -m "feat: add append-only event store with torn-tail recovery" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Task state machine and run-state reducer

**Files:**
- Create: `server/pipeline/task-state.ts`, `server/pipeline/run-state.ts`
- Create: `test/fixtures/run-state.ts`
- Test: `test/pipeline/task-state.test.ts`, `test/pipeline/run-state.test.ts`

**Interfaces:**
- Consumes: `PlanTask` (Task 2); `makePlanTask` fixture (Task 2).
- Produces:
  - `TASK_STATES`, `type TaskState`, `TERMINAL_STATES: ReadonlySet<TaskState>`, `ACTIVE_STATES: ReadonlySet<TaskState>`
  - `canTransition(from: TaskState, to: TaskState): boolean`, `assertTransition(from, to): void`, `class InvalidTransitionError extends Error`
  - `interface TaskRuntime { def: PlanTask; state: TaskState; attempts: number; replanned: boolean; infraRetries: Record<string, number>; flakyRetries: Record<string, number>; replacedBy: string[] }`
  - `interface RunState { tasks: Map<string, TaskRuntime>; order: string[] }`
  - `RunEvent` constants: `TaskPlanned`, `TaskStateChanged`, `AttemptConsumed`, `InfraRetry`, `FlakyRetry`, `TaskReplanned`
  - `interface ReducibleEvent { type: string; data: Record<string, unknown> }`
  - `reduceEvents(events: Iterable<ReducibleEvent>): RunState`, `applyEvent(state: RunState, event: ReducibleEvent): void`
  - `class UnknownTaskError extends Error`, `class DuplicateTaskError extends Error`, `class ReplanError extends Error`
  - Fixtures: `runtime(def: Partial<PlanTask> & { id: string }, state?: TaskState, extra?: Partial<TaskRuntime>): TaskRuntime`, `runState(...tasks: TaskRuntime[]): RunState`

The spec's state list gains `superseded`: a task replaced by a replan is terminal and its dependents are rewired to the replacements.

- [ ] **Step 1: Write the failing state-machine test**

`test/pipeline/task-state.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATES,
  InvalidTransitionError,
  TERMINAL_STATES,
  assertTransition,
  canTransition,
} from '../../server/pipeline/task-state.js';

describe('task state machine', () => {
  it('allows the happy path', () => {
    const path = ['planned', 'ready', 'implementing', 'validating', 'reviewing', 'rebasing', 'merging', 'merged'] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it('allows returning to implementing after a failed gate, review or rebase', () => {
    expect(canTransition('validating', 'implementing')).toBe(true);
    expect(canTransition('reviewing', 'implementing')).toBe(true);
    expect(canTransition('rebasing', 'implementing')).toBe(true);
  });

  it('allows merging to return to rebasing when main moved', () => {
    expect(canTransition('merging', 'rebasing')).toBe(true);
  });

  it('forbids skipping review', () => {
    expect(canTransition('validating', 'merging')).toBe(false);
    expect(() => assertTransition('validating', 'merging')).toThrow(InvalidTransitionError);
  });

  it('treats merged, blocked and superseded as terminal', () => {
    for (const state of ['merged', 'blocked', 'superseded'] as const) {
      expect(TERMINAL_STATES.has(state)).toBe(true);
      expect(canTransition(state, 'ready')).toBe(false);
    }
  });

  it('does not allow superseding a task that is merging', () => {
    expect(canTransition('merging', 'superseded')).toBe(false);
  });

  it('marks in-flight states as active', () => {
    expect([...ACTIVE_STATES].sort()).toEqual(['implementing', 'merging', 'rebasing', 'reviewing', 'validating']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pipeline/task-state.test.ts`
Expected: FAIL — cannot resolve `../../server/pipeline/task-state.js`.

- [ ] **Step 3: Implement the state machine**

`server/pipeline/task-state.ts`:
```ts
export const TASK_STATES = [
  'planned',
  'ready',
  'implementing',
  'validating',
  'reviewing',
  'rebasing',
  'merging',
  'merged',
  'blocked',
  'superseded',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['merged', 'blocked', 'superseded']);
export const ACTIVE_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'implementing',
  'validating',
  'reviewing',
  'rebasing',
  'merging',
]);

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  planned: ['ready', 'blocked', 'superseded'],
  ready: ['implementing', 'blocked', 'superseded'],
  implementing: ['validating', 'blocked', 'superseded'],
  validating: ['reviewing', 'implementing', 'blocked', 'superseded'],
  reviewing: ['rebasing', 'implementing', 'blocked', 'superseded'],
  rebasing: ['merging', 'implementing', 'blocked', 'superseded'],
  merging: ['merged', 'rebasing', 'blocked'],
  merged: [],
  blocked: [],
  superseded: [],
};

export class InvalidTransitionError extends Error {}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(`invalid task transition ${from} -> ${to}`);
  }
}
```

- [ ] **Step 4: Run the state-machine test**

Run: `npx vitest run test/pipeline/task-state.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Write the run-state fixtures and failing reducer test**

`test/fixtures/run-state.ts`:
```ts
import type { PlanTask } from '../../server/contracts/plan.js';
import type { RunState, TaskRuntime } from '../../server/pipeline/run-state.js';
import type { TaskState } from '../../server/pipeline/task-state.js';
import { makePlanTask } from './contracts.js';

export function runtime(
  def: Partial<PlanTask> & { id: string },
  state: TaskState = 'planned',
  extra: Partial<TaskRuntime> = {},
): TaskRuntime {
  return {
    def: makePlanTask(def),
    state,
    attempts: 0,
    replanned: false,
    infraRetries: {},
    flakyRetries: {},
    replacedBy: [],
    ...extra,
  };
}

export function runState(...tasks: TaskRuntime[]): RunState {
  return {
    tasks: new Map(tasks.map((t) => [t.def.id, t])),
    order: tasks.map((t) => t.def.id),
  };
}
```

`test/pipeline/run-state.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  DuplicateTaskError,
  ReplanError,
  RunEvent,
  UnknownTaskError,
  reduceEvents,
  type ReducibleEvent,
} from '../../server/pipeline/run-state.js';
import { InvalidTransitionError } from '../../server/pipeline/task-state.js';
import { makePlanTask } from '../fixtures/contracts.js';

const planned = (id: string, dependsOn: string[] = []): ReducibleEvent => ({
  type: RunEvent.TaskPlanned,
  data: { task: makePlanTask({ id, dependsOn }) },
});
const moved = (taskId: string, to: string): ReducibleEvent => ({
  type: RunEvent.TaskStateChanged,
  data: { taskId, to },
});

describe('reduceEvents', () => {
  it('builds tasks in plan order with initial counters', () => {
    const state = reduceEvents([planned('T1-a'), planned('T2-b')]);
    expect(state.order).toEqual(['T1-a', 'T2-b']);
    expect(state.tasks.get('T1-a')).toMatchObject({ state: 'planned', attempts: 0, replanned: false });
  });

  it('applies valid transitions and rejects invalid ones', () => {
    const state = reduceEvents([planned('T1-a'), moved('T1-a', 'ready'), moved('T1-a', 'implementing')]);
    expect(state.tasks.get('T1-a')!.state).toBe('implementing');
    expect(() => reduceEvents([planned('T1-a'), moved('T1-a', 'merged')])).toThrow(InvalidTransitionError);
  });

  it('counts attempts and per-gate retries', () => {
    const state = reduceEvents([
      planned('T1-a'),
      { type: RunEvent.AttemptConsumed, data: { taskId: 'T1-a' } },
      { type: RunEvent.AttemptConsumed, data: { taskId: 'T1-a' } },
      { type: RunEvent.InfraRetry, data: { taskId: 'T1-a', gate: 'unit-test' } },
      { type: RunEvent.FlakyRetry, data: { taskId: 'T1-a', gate: 'unit-test' } },
    ]);
    const task = state.tasks.get('T1-a')!;
    expect(task.attempts).toBe(2);
    expect(task.infraRetries).toEqual({ 'unit-test': 1 });
    expect(task.flakyRetries).toEqual({ 'unit-test': 1 });
  });

  it('rejects events for unknown tasks and duplicate plans', () => {
    expect(() => reduceEvents([moved('T9-x', 'ready')])).toThrow(UnknownTaskError);
    expect(() => reduceEvents([planned('T1-a'), planned('T1-a')])).toThrow(DuplicateTaskError);
  });

  it('ignores event types it does not own', () => {
    const state = reduceEvents([planned('T1-a'), { type: 'PR_CREATED', data: { url: 'x' } }]);
    expect(state.tasks.size).toBe(1);
  });

  it('supersedes a replanned task and rewires its dependents', () => {
    const state = reduceEvents([
      planned('T1-a'),
      planned('T2-b', ['T1-a']),
      {
        type: RunEvent.TaskReplanned,
        data: {
          taskId: 'T1-a',
          replacements: [makePlanTask({ id: 'T4-a1' }), makePlanTask({ id: 'T5-a2', dependsOn: ['T4-a1'] })],
        },
      },
    ]);
    expect(state.tasks.get('T1-a')).toMatchObject({ state: 'superseded', replacedBy: ['T4-a1', 'T5-a2'] });
    expect(state.tasks.get('T4-a1')!.replanned).toBe(true);
    expect(state.tasks.get('T2-b')!.def.dependsOn).toEqual(['T4-a1', 'T5-a2']);
    expect(state.order).toEqual(['T1-a', 'T2-b', 'T4-a1', 'T5-a2']);
  });

  it('rejects a replacement that depends on the task it replaces', () => {
    expect(() =>
      reduceEvents([
        planned('T1-a'),
        {
          type: RunEvent.TaskReplanned,
          data: { taskId: 'T1-a', replacements: [makePlanTask({ id: 'T4-a1', dependsOn: ['T1-a'] })] },
        },
      ]),
    ).toThrow(ReplanError);
  });

  it('rejects replanning a task that came from a replan', () => {
    const replan = (taskId: string, id: string): ReducibleEvent => ({
      type: RunEvent.TaskReplanned,
      data: { taskId, replacements: [makePlanTask({ id })] },
    });
    expect(() => reduceEvents([planned('T1-a'), replan('T1-a', 'T4-a1'), replan('T4-a1', 'T5-a2')])).toThrow(ReplanError);
  });

  it('rejects replanning a terminal task', () => {
    expect(() =>
      reduceEvents([
        planned('T1-a'),
        moved('T1-a', 'blocked'),
        { type: RunEvent.TaskReplanned, data: { taskId: 'T1-a', replacements: [makePlanTask({ id: 'T4-a1' })] } },
      ]),
    ).toThrow(ReplanError);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/pipeline/run-state.test.ts`
Expected: FAIL — cannot resolve `../../server/pipeline/run-state.js`.

- [ ] **Step 7: Implement the reducer**

`server/pipeline/run-state.ts`:
```ts
import { z } from 'zod';
import { PlanTask } from '../contracts/plan.js';
import { TASK_STATES, TERMINAL_STATES, assertTransition, type TaskState } from './task-state.js';

export interface TaskRuntime {
  def: PlanTask;
  state: TaskState;
  attempts: number;
  replanned: boolean;
  infraRetries: Record<string, number>;
  flakyRetries: Record<string, number>;
  replacedBy: string[];
}

export interface RunState {
  tasks: Map<string, TaskRuntime>;
  order: string[];
}

export interface ReducibleEvent {
  type: string;
  data: Record<string, unknown>;
}

export const RunEvent = {
  TaskPlanned: 'TASK_PLANNED',
  TaskStateChanged: 'TASK_STATE_CHANGED',
  AttemptConsumed: 'ATTEMPT_CONSUMED',
  InfraRetry: 'INFRA_RETRY',
  FlakyRetry: 'FLAKY_RETRY',
  TaskReplanned: 'TASK_REPLANNED',
} as const;

export class UnknownTaskError extends Error {}
export class DuplicateTaskError extends Error {}
export class ReplanError extends Error {}

const TaskPlannedData = z.object({ task: PlanTask });
const StateChangedData = z.object({ taskId: z.string(), to: z.enum(TASK_STATES) });
const TaskRefData = z.object({ taskId: z.string() });
const GateRetryData = z.object({ taskId: z.string(), gate: z.string().min(1) });
const ReplannedData = z.object({ taskId: z.string(), replacements: z.array(PlanTask).min(1) });

export function reduceEvents(events: Iterable<ReducibleEvent>): RunState {
  const state: RunState = { tasks: new Map(), order: [] };
  for (const event of events) applyEvent(state, event);
  return state;
}

export function applyEvent(state: RunState, event: ReducibleEvent): void {
  switch (event.type) {
    case RunEvent.TaskPlanned: {
      addTask(state, TaskPlannedData.parse(event.data).task, false);
      return;
    }
    case RunEvent.TaskStateChanged: {
      const { taskId, to } = StateChangedData.parse(event.data);
      const task = getTask(state, taskId);
      assertTransition(task.state, to);
      task.state = to;
      return;
    }
    case RunEvent.AttemptConsumed: {
      getTask(state, TaskRefData.parse(event.data).taskId).attempts += 1;
      return;
    }
    case RunEvent.InfraRetry: {
      const { taskId, gate } = GateRetryData.parse(event.data);
      bump(getTask(state, taskId).infraRetries, gate);
      return;
    }
    case RunEvent.FlakyRetry: {
      const { taskId, gate } = GateRetryData.parse(event.data);
      bump(getTask(state, taskId).flakyRetries, gate);
      return;
    }
    case RunEvent.TaskReplanned: {
      replan(state, ReplannedData.parse(event.data));
      return;
    }
    default:
      return;
  }
}

function addTask(state: RunState, def: PlanTask, replanned: boolean): void {
  if (state.tasks.has(def.id)) throw new DuplicateTaskError(`task ${def.id} already exists`);
  state.tasks.set(def.id, {
    def,
    state: 'planned',
    attempts: 0,
    replanned,
    infraRetries: {},
    flakyRetries: {},
    replacedBy: [],
  });
  state.order.push(def.id);
}

function getTask(state: RunState, taskId: string): TaskRuntime {
  const task = state.tasks.get(taskId);
  if (!task) throw new UnknownTaskError(`unknown task ${taskId}`);
  return task;
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

function replan(state: RunState, { taskId, replacements }: { taskId: string; replacements: PlanTask[] }): void {
  const original = getTask(state, taskId);
  if (original.replanned) throw new ReplanError(`task ${taskId} was produced by a replan and cannot be replanned`);
  if (TERMINAL_STATES.has(original.state)) throw new ReplanError(`task ${taskId} is ${original.state}`);
  assertTransition(original.state, 'superseded');
  for (const replacement of replacements) {
    if (replacement.dependsOn.includes(taskId)) {
      throw new ReplanError(`replacement ${replacement.id} depends on the task it replaces`);
    }
  }
  const ids = replacements.map((r) => r.id);
  for (const replacement of replacements) addTask(state, replacement, true);
  original.state = 'superseded';
  original.replacedBy = ids;
  for (const task of state.tasks.values()) {
    if (ids.includes(task.def.id) || !task.def.dependsOn.includes(taskId)) continue;
    task.def = { ...task.def, dependsOn: [...task.def.dependsOn.filter((d) => d !== taskId), ...ids] };
  }
}
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npx vitest run test/pipeline && npm run typecheck`
Expected: 16 tests PASS; typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add server/pipeline test/pipeline test/fixtures/run-state.ts
git commit -m "feat: add task state machine and run-state reducer with replan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Path utilities and scheduler

**Files:**
- Create: `server/core/paths.ts`, `server/scheduler/scheduler.ts`
- Test: `test/core/paths.test.ts`, `test/scheduler/scheduler.test.ts`

**Interfaces:**
- Consumes: `RunState`, `TaskRuntime` (Task 4); `ACTIVE_STATES`, `TERMINAL_STATES` (Task 4); fixtures `runtime`, `runState` (Task 4).
- Produces:
  - `normalizePath(p: string): string`, `hasGlobChars(p: string): boolean`, `staticPrefix(glob: string): string`, `pathsOverlap(a: readonly string[], b: readonly string[]): boolean`
  - `nextRunnable(state: RunState, maxParallel: number): string[]`
  - `tasksToBlock(state: RunState): string[]`
  - `type RunProgress = 'running' | 'complete' | 'deadlocked'`, `runProgress(state: RunState, maxParallel: number): RunProgress`

Overlap is conservative: two path lists overlap when the static (non-glob) prefix of one entry is an ancestor-or-equal of the other's. Over-reporting only reduces parallelism; it never lets overlapping tasks run together.

- [ ] **Step 1: Write the failing paths test**

`test/core/paths.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { hasGlobChars, normalizePath, pathsOverlap, staticPrefix } from '../../server/core/paths.js';

describe('normalizePath', () => {
  it('converts backslashes, strips ./ and trailing slashes, collapses repeats', () => {
    expect(normalizePath('.\\src\\auth\\')).toBe('src/auth');
    expect(normalizePath('./src//user/')).toBe('src/user');
    expect(normalizePath('package.json')).toBe('package.json');
  });
});

describe('hasGlobChars', () => {
  it('detects glob syntax', () => {
    expect(hasGlobChars('src/**')).toBe(true);
    expect(hasGlobChars('src/{a,b}.ts')).toBe(true);
    expect(hasGlobChars('src/auth')).toBe(false);
  });
});

describe('staticPrefix', () => {
  it('returns the path before the first glob segment', () => {
    expect(staticPrefix('src/auth/**')).toBe('src/auth');
    expect(staticPrefix('src/*.ts')).toBe('src');
    expect(staticPrefix('**/*.md')).toBe('');
    expect(staticPrefix('Dockerfile')).toBe('Dockerfile');
  });
});

describe('pathsOverlap', () => {
  it('detects ancestor and equal paths', () => {
    expect(pathsOverlap(['src/auth/**'], ['src/auth/login.ts'])).toBe(true);
    expect(pathsOverlap(['src/auth'], ['src/auth/login.ts'])).toBe(true);
    expect(pathsOverlap(['Dockerfile'], ['Dockerfile'])).toBe(true);
  });

  it('does not confuse sibling names sharing a prefix', () => {
    expect(pathsOverlap(['src/auth/**'], ['src/authz/**'])).toBe(false);
    expect(pathsOverlap(['src/a.ts'], ['src/a.ts.bak'])).toBe(false);
  });

  it('treats root-level globs as overlapping everything', () => {
    expect(pathsOverlap(['**/*.md'], ['src/user/**'])).toBe(true);
  });

  it('normalizes agent-style paths before comparing', () => {
    expect(pathsOverlap(['.\\src\\auth\\'], ['src/auth/**'])).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/paths.test.ts`
Expected: FAIL — cannot resolve `../../server/core/paths.js`.

- [ ] **Step 3: Implement path utilities**

`server/core/paths.ts`:
```ts
const GLOB_CHARS = /[*?[\]{}()!+@]/;

export function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

export function hasGlobChars(p: string): boolean {
  return GLOB_CHARS.test(p);
}

export function staticPrefix(glob: string): string {
  const fixed: string[] = [];
  for (const segment of normalizePath(glob).split('/')) {
    if (hasGlobChars(segment)) break;
    fixed.push(segment);
  }
  return fixed.join('/');
}

function isAncestorOrEqual(ancestor: string, candidate: string): boolean {
  if (ancestor === '') return true;
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

export function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const x of a) {
    const px = staticPrefix(x);
    for (const y of b) {
      const py = staticPrefix(y);
      if (isAncestorOrEqual(px, py) || isAncestorOrEqual(py, px)) return true;
    }
  }
  return false;
}
```

- [ ] **Step 4: Run the paths test**

Run: `npx vitest run test/core/paths.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Write the failing scheduler test**

`test/scheduler/scheduler.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { nextRunnable, runProgress, tasksToBlock } from '../../server/scheduler/scheduler.js';
import { runState, runtime } from '../fixtures/run-state.js';

describe('nextRunnable', () => {
  it('starts independent tasks up to maxParallel', () => {
    const state = runState(runtime({ id: 'T1-a' }), runtime({ id: 'T2-b' }), runtime({ id: 'T3-c' }), runtime({ id: 'T4-d' }));
    expect(nextRunnable(state, 3)).toEqual(['T1-a', 'T2-b', 'T3-c']);
  });

  it('waits until every dependency is merged', () => {
    const waiting = runState(runtime({ id: 'T1-a' }, 'reviewing'), runtime({ id: 'T2-b', dependsOn: ['T1-a'] }));
    expect(nextRunnable(waiting, 3)).toEqual([]);
    const done = runState(runtime({ id: 'T1-a' }, 'merged'), runtime({ id: 'T2-b', dependsOn: ['T1-a'] }));
    expect(nextRunnable(done, 3)).toEqual(['T2-b']);
  });

  it('serializes tasks whose affected paths overlap', () => {
    const state = runState(
      runtime({ id: 'T1-a', affectedPaths: ['src/user/**'] }),
      runtime({ id: 'T2-b', affectedPaths: ['src/user/service.ts'] }),
      runtime({ id: 'T3-c', affectedPaths: ['src/order/**'] }),
    );
    expect(nextRunnable(state, 3)).toEqual(['T1-a', 'T3-c']);
  });

  it('counts active tasks against slots and their paths as claimed', () => {
    const state = runState(
      runtime({ id: 'T1-a', affectedPaths: ['src/user/**'] }, 'implementing'),
      runtime({ id: 'T2-b', affectedPaths: ['src/order/**'] }, 'merging'),
      runtime({ id: 'T3-c', affectedPaths: ['src/user/model.ts'] }),
      runtime({ id: 'T4-d', affectedPaths: ['src/billing/**'] }),
      runtime({ id: 'T5-e', affectedPaths: ['src/report/**'] }),
    );
    expect(nextRunnable(state, 3)).toEqual(['T4-d']);
  });

  it('never picks terminal tasks', () => {
    const state = runState(runtime({ id: 'T1-a' }, 'blocked'), runtime({ id: 'T2-b' }, 'superseded'), runtime({ id: 'T3-c' }, 'merged'));
    expect(nextRunnable(state, 3)).toEqual([]);
  });

  it('rejects a non-positive maxParallel', () => {
    expect(() => nextRunnable(runState(runtime({ id: 'T1-a' })), 0)).toThrow(RangeError);
  });
});

describe('tasksToBlock', () => {
  it('propagates blocked dependencies transitively', () => {
    const state = runState(
      runtime({ id: 'T1-a' }, 'blocked'),
      runtime({ id: 'T2-b', dependsOn: ['T1-a'] }),
      runtime({ id: 'T3-c', dependsOn: ['T2-b'] }),
      runtime({ id: 'T4-d' }),
    );
    expect(tasksToBlock(state).sort()).toEqual(['T2-b', 'T3-c']);
  });

  it('blocks tasks that depend on unknown tasks', () => {
    expect(tasksToBlock(runState(runtime({ id: 'T2-b', dependsOn: ['T9-missing'] })))).toEqual(['T2-b']);
  });
});

describe('runProgress', () => {
  it('is complete when every task is terminal', () => {
    const state = runState(runtime({ id: 'T1-a' }, 'merged'), runtime({ id: 'T2-b' }, 'blocked'));
    expect(runProgress(state, 3)).toBe('complete');
  });

  it('is running while work is active or startable', () => {
    expect(runProgress(runState(runtime({ id: 'T1-a' }, 'implementing')), 3)).toBe('running');
    expect(runProgress(runState(runtime({ id: 'T1-a' })), 3)).toBe('running');
  });

  it('is deadlocked when nothing can ever start', () => {
    const cycle = runState(runtime({ id: 'T1-a', dependsOn: ['T2-b'] }), runtime({ id: 'T2-b', dependsOn: ['T1-a'] }));
    expect(runProgress(cycle, 3)).toBe('deadlocked');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/scheduler/scheduler.test.ts`
Expected: FAIL — cannot resolve `../../server/scheduler/scheduler.js`.

- [ ] **Step 7: Implement the scheduler**

`server/scheduler/scheduler.ts`:
```ts
import { pathsOverlap } from '../core/paths.js';
import type { RunState, TaskRuntime } from '../pipeline/run-state.js';
import { ACTIVE_STATES, TERMINAL_STATES } from '../pipeline/task-state.js';

export type RunProgress = 'running' | 'complete' | 'deadlocked';

function ordered(state: RunState): TaskRuntime[] {
  return state.order.map((id) => state.tasks.get(id)).filter((t): t is TaskRuntime => t !== undefined);
}

function isWaiting(task: TaskRuntime): boolean {
  return task.state === 'planned' || task.state === 'ready';
}

export function nextRunnable(state: RunState, maxParallel: number): string[] {
  if (!Number.isInteger(maxParallel) || maxParallel < 1) {
    throw new RangeError(`maxParallel must be a positive integer, got ${maxParallel}`);
  }
  const tasks = ordered(state);
  const active = tasks.filter((t) => ACTIVE_STATES.has(t.state));
  const claimed = active.map((t) => t.def.affectedPaths);
  let slots = maxParallel - active.length;
  const picked: string[] = [];
  for (const task of tasks) {
    if (slots <= 0) break;
    if (!isWaiting(task)) continue;
    const depsMerged = task.def.dependsOn.every((d) => state.tasks.get(d)?.state === 'merged');
    if (!depsMerged) continue;
    if (claimed.some((paths) => pathsOverlap(paths, task.def.affectedPaths))) continue;
    picked.push(task.def.id);
    claimed.push(task.def.affectedPaths);
    slots -= 1;
  }
  return picked;
}

export function tasksToBlock(state: RunState): string[] {
  const blocked = new Set(ordered(state).filter((t) => t.state === 'blocked').map((t) => t.def.id));
  const added: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of ordered(state)) {
      if (!isWaiting(task) || blocked.has(task.def.id)) continue;
      const doomed = task.def.dependsOn.some((d) => blocked.has(d) || !state.tasks.has(d));
      if (doomed) {
        blocked.add(task.def.id);
        added.push(task.def.id);
        changed = true;
      }
    }
  }
  return added;
}

export function runProgress(state: RunState, maxParallel: number): RunProgress {
  const tasks = ordered(state);
  if (tasks.every((t) => TERMINAL_STATES.has(t.state))) return 'complete';
  if (tasks.some((t) => ACTIVE_STATES.has(t.state))) return 'running';
  if (tasksToBlock(state).length > 0) return 'running';
  return nextRunnable(state, maxParallel).length > 0 ? 'running' : 'deadlocked';
}
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npx vitest run test/core test/scheduler && npm run typecheck`
Expected: all tests PASS (ids, paths, scheduler); typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add server/core/paths.ts server/scheduler/scheduler.ts test/core/paths.test.ts test/scheduler/scheduler.test.ts
git commit -m "feat: add dependency and path-aware task scheduler" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Retry policy

**Files:**
- Create: `server/scheduler/retry-policy.ts`
- Test: `test/scheduler/retry-policy.test.ts`

**Interfaces:**
- Consumes: `TaskRuntime` (Task 4); fixture `runtime` (Task 4).
- Produces:
  - `type FailureKind = 'code' | 'dependency' | 'timeout' | 'review-changes' | 'rebase-conflict' | 'schema' | 'infra' | 'environment' | 'flaky-test' | 'compaction' | 'spec-gap' | 'quota' | 'auth'`
  - `interface Failure { kind: FailureKind; gate?: string; schemaRetriesUsed?: number }`
  - `interface PolicyConfig { maxAttempts: number; maxInfraRetriesPerGate: number; maxFlakyRetriesPerGate: number; maxSchemaRetriesPerStep: number }`, `DEFAULT_POLICY: PolicyConfig`
  - `type PolicyAction = 'retry-dev' | 'rerun-gate' | 'rerun-step' | 'replan' | 'block' | 'pause-quota' | 'pause-auth' | 'route-spec-gap'`
  - `interface PolicyDecision { action: PolicyAction; consumeAttempt: boolean }`
  - `decideOnFailure(failure: Failure, task: TaskRuntime, cfg?: PolicyConfig): PolicyDecision`

The caller turns the decision into events (`ATTEMPT_CONSUMED`, `INFRA_RETRY`, `FLAKY_RETRY`, `TASK_REPLANNED`, state changes). The policy itself is pure.

- [ ] **Step 1: Write the failing test**

`test/scheduler/retry-policy.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, decideOnFailure } from '../../server/scheduler/retry-policy.js';
import { runtime } from '../fixtures/run-state.js';

const task = (extra = {}) => runtime({ id: 'T1-a' }, 'validating', extra);

describe('decideOnFailure', () => {
  it('uses the spec defaults', () => {
    expect(DEFAULT_POLICY).toEqual({
      maxAttempts: 3,
      maxInfraRetriesPerGate: 3,
      maxFlakyRetriesPerGate: 1,
      maxSchemaRetriesPerStep: 2,
    });
  });

  it('retries the dev on the first two code failures, then replans, then blocks', () => {
    expect(decideOnFailure({ kind: 'code' }, task({ attempts: 0 }))).toEqual({ action: 'retry-dev', consumeAttempt: true });
    expect(decideOnFailure({ kind: 'code' }, task({ attempts: 1 }))).toEqual({ action: 'retry-dev', consumeAttempt: true });
    expect(decideOnFailure({ kind: 'code' }, task({ attempts: 2 }))).toEqual({ action: 'replan', consumeAttempt: true });
    expect(decideOnFailure({ kind: 'code' }, task({ attempts: 2, replanned: true }))).toEqual({ action: 'block', consumeAttempt: true });
  });

  it('treats review changes, rebase conflicts, timeouts and dependency errors as attempts', () => {
    for (const kind of ['review-changes', 'rebase-conflict', 'timeout', 'dependency'] as const) {
      expect(decideOnFailure({ kind }, task()).consumeAttempt).toBe(true);
    }
  });

  it('re-runs infra and environment failures without consuming attempts until the per-gate cap', () => {
    expect(decideOnFailure({ kind: 'infra', gate: 'unit-test' }, task())).toEqual({ action: 'rerun-gate', consumeAttempt: false });
    expect(decideOnFailure({ kind: 'environment', gate: 'unit-test' }, task({ infraRetries: { 'unit-test': 2 } }))).toEqual({
      action: 'rerun-gate',
      consumeAttempt: false,
    });
    expect(decideOnFailure({ kind: 'infra', gate: 'unit-test' }, task({ infraRetries: { 'unit-test': 3 } }))).toEqual({
      action: 'retry-dev',
      consumeAttempt: true,
    });
  });

  it('counts infra retries per gate', () => {
    const t = task({ infraRetries: { lint: 3 } });
    expect(decideOnFailure({ kind: 'infra', gate: 'unit-test' }, t).action).toBe('rerun-gate');
  });

  it('re-runs a flaky test once, then treats it as code', () => {
    expect(decideOnFailure({ kind: 'flaky-test', gate: 'unit-test' }, task())).toEqual({ action: 'rerun-gate', consumeAttempt: false });
    expect(decideOnFailure({ kind: 'flaky-test', gate: 'unit-test' }, task({ flakyRetries: { 'unit-test': 1 } })).action).toBe('retry-dev');
  });

  it('requires a gate for gate-scoped failures', () => {
    expect(() => decideOnFailure({ kind: 'infra' }, task())).toThrow(/gate/);
  });

  it('re-runs the step on schema failures up to the limit, then consumes an attempt', () => {
    expect(decideOnFailure({ kind: 'schema', schemaRetriesUsed: 0 }, task())).toEqual({ action: 'rerun-step', consumeAttempt: false });
    expect(decideOnFailure({ kind: 'schema', schemaRetriesUsed: 1 }, task()).action).toBe('rerun-step');
    expect(decideOnFailure({ kind: 'schema', schemaRetriesUsed: 2 }, task())).toEqual({ action: 'retry-dev', consumeAttempt: true });
  });

  it('replans on compaction without consuming an attempt, and blocks if already replanned', () => {
    expect(decideOnFailure({ kind: 'compaction' }, task())).toEqual({ action: 'replan', consumeAttempt: false });
    expect(decideOnFailure({ kind: 'compaction' }, task({ replanned: true }))).toEqual({ action: 'block', consumeAttempt: false });
  });

  it('pauses on quota and auth, and routes spec gaps, without consuming attempts', () => {
    expect(decideOnFailure({ kind: 'quota' }, task())).toEqual({ action: 'pause-quota', consumeAttempt: false });
    expect(decideOnFailure({ kind: 'auth' }, task())).toEqual({ action: 'pause-auth', consumeAttempt: false });
    expect(decideOnFailure({ kind: 'spec-gap' }, task())).toEqual({ action: 'route-spec-gap', consumeAttempt: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/scheduler/retry-policy.test.ts`
Expected: FAIL — cannot resolve `../../server/scheduler/retry-policy.js`.

- [ ] **Step 3: Implement the policy**

`server/scheduler/retry-policy.ts`:
```ts
import type { TaskRuntime } from '../pipeline/run-state.js';

export type FailureKind =
  | 'code'
  | 'dependency'
  | 'timeout'
  | 'review-changes'
  | 'rebase-conflict'
  | 'schema'
  | 'infra'
  | 'environment'
  | 'flaky-test'
  | 'compaction'
  | 'spec-gap'
  | 'quota'
  | 'auth';

export interface Failure {
  kind: FailureKind;
  gate?: string;
  schemaRetriesUsed?: number;
}

export interface PolicyConfig {
  maxAttempts: number;
  maxInfraRetriesPerGate: number;
  maxFlakyRetriesPerGate: number;
  maxSchemaRetriesPerStep: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  maxAttempts: 3,
  maxInfraRetriesPerGate: 3,
  maxFlakyRetriesPerGate: 1,
  maxSchemaRetriesPerStep: 2,
};

export type PolicyAction =
  | 'retry-dev'
  | 'rerun-gate'
  | 'rerun-step'
  | 'replan'
  | 'block'
  | 'pause-quota'
  | 'pause-auth'
  | 'route-spec-gap';

export interface PolicyDecision {
  action: PolicyAction;
  consumeAttempt: boolean;
}

export function decideOnFailure(
  failure: Failure,
  task: TaskRuntime,
  cfg: PolicyConfig = DEFAULT_POLICY,
): PolicyDecision {
  switch (failure.kind) {
    case 'quota':
      return { action: 'pause-quota', consumeAttempt: false };
    case 'auth':
      return { action: 'pause-auth', consumeAttempt: false };
    case 'spec-gap':
      return { action: 'route-spec-gap', consumeAttempt: false };
    case 'compaction':
      return { action: task.replanned ? 'block' : 'replan', consumeAttempt: false };
    case 'schema':
      if ((failure.schemaRetriesUsed ?? 0) < cfg.maxSchemaRetriesPerStep) {
        return { action: 'rerun-step', consumeAttempt: false };
      }
      return attemptFailure(task, cfg);
    case 'infra':
    case 'environment':
      if (gateRetries(task.infraRetries, failure) < cfg.maxInfraRetriesPerGate) {
        return { action: 'rerun-gate', consumeAttempt: false };
      }
      return attemptFailure(task, cfg);
    case 'flaky-test':
      if (gateRetries(task.flakyRetries, failure) < cfg.maxFlakyRetriesPerGate) {
        return { action: 'rerun-gate', consumeAttempt: false };
      }
      return attemptFailure(task, cfg);
    case 'code':
    case 'dependency':
    case 'timeout':
    case 'review-changes':
    case 'rebase-conflict':
      return attemptFailure(task, cfg);
    default: {
      const unreachable: never = failure.kind;
      throw new Error(`unhandled failure kind ${String(unreachable)}`);
    }
  }
}

function gateRetries(counter: Record<string, number>, failure: Failure): number {
  if (!failure.gate) throw new Error(`${failure.kind} failures require a gate name`);
  return counter[failure.gate] ?? 0;
}

function attemptFailure(task: TaskRuntime, cfg: PolicyConfig): PolicyDecision {
  const attemptsAfter = task.attempts + 1;
  if (attemptsAfter < cfg.maxAttempts) return { action: 'retry-dev', consumeAttempt: true };
  return { action: task.replanned ? 'block' : 'replan', consumeAttempt: true };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/scheduler/retry-policy.test.ts && npm run typecheck`
Expected: 10 tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/scheduler/retry-policy.ts test/scheduler/retry-policy.test.ts
git commit -m "feat: add failure retry policy" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Validators — references, agent output and plan

**Files:**
- Create: `server/validators/result.ts`, `server/validators/references.ts`, `server/validators/agent-output.ts`, `server/validators/plan.ts`
- Test: `test/validators/references.test.ts`, `test/validators/agent-output.test.ts`, `test/validators/plan.test.ts`

**Interfaces:**
- Consumes: `normalizePath` (Task 5); `Plan`, `PlanTask`, `Spec` (Task 2); fixtures `makeFrozenSpec`, `makePlan`, `makePlanTask` (Task 2).
- Produces:
  - `type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] }`
  - `interface RefContext { acIds: ReadonlySet<string>; taskIds: ReadonlySet<string>; files: ReadonlySet<string>; tests: ReadonlySet<string>; adrIds: ReadonlySet<string> }` (`files` holds normalized paths)
  - `interface References { acIds?: readonly string[]; taskIds?: readonly string[]; files?: readonly string[]; tests?: readonly string[]; adrIds?: readonly string[] }`
  - `unresolvedReferences(refs: References, ctx: RefContext): string[]`
  - `interface OutputCheckOptions<T> { expectedSpecHash: string; refs?: (value: T) => References; refContext?: RefContext; semantic?: ReadonlyArray<(value: T) => string[]> }`
  - `validateAgentOutput<T extends { specHash: string }>(schema: z.ZodType<T>, raw: unknown, opts: OutputCheckOptions<T>): Validation<T>`
  - `interface PlanCheckOptions { firstSpec: boolean }`, `validatePlan(plan: Plan, spec: Spec, opts: PlanCheckOptions): string[]`, `findCycle(tasks: readonly PlanTask[]): string[] | null`, `SCAFFOLD_TASK_ID = 'T0-scaffold'`

- [ ] **Step 1: Write the result type and failing references test**

`server/validators/result.ts`:
```ts
export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };
```

`test/validators/references.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { unresolvedReferences, type RefContext } from '../../server/validators/references.js';

const ctx: RefContext = {
  acIds: new Set(['AC-001']),
  taskIds: new Set(['T1-create']),
  files: new Set(['src/todos/create.ts']),
  tests: new Set(['test/todos.test.ts::[AC-001] creates a todo']),
  adrIds: new Set(['ADR-001']),
};

describe('unresolvedReferences', () => {
  it('accepts references that exist', () => {
    expect(
      unresolvedReferences(
        {
          acIds: ['AC-001'],
          taskIds: ['T1-create'],
          files: ['src/todos/create.ts'],
          tests: ['test/todos.test.ts::[AC-001] creates a todo'],
          adrIds: ['ADR-001'],
        },
        ctx,
      ),
    ).toEqual([]);
  });

  it('reports each unknown reference', () => {
    expect(
      unresolvedReferences({ acIds: ['AC-009'], taskIds: ['T7-x'], tests: ['ghost'], adrIds: ['ADR-404'] }, ctx),
    ).toEqual(['unknown acceptance criterion: AC-009', 'unknown task: T7-x', 'unknown test: ghost', 'unknown ADR: ADR-404']);
  });

  it('normalizes file paths before lookup', () => {
    expect(unresolvedReferences({ files: ['.\\src\\todos\\create.ts'] }, ctx)).toEqual([]);
    expect(unresolvedReferences({ files: ['src/todos/delete.ts'] }, ctx)).toEqual(['unknown file: src/todos/delete.ts']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/validators/references.test.ts`
Expected: FAIL — cannot resolve `../../server/validators/references.js`.

- [ ] **Step 3: Implement references**

`server/validators/references.ts`:
```ts
import { normalizePath } from '../core/paths.js';

export interface RefContext {
  acIds: ReadonlySet<string>;
  taskIds: ReadonlySet<string>;
  /** Normalized repository-relative paths (see normalizePath). */
  files: ReadonlySet<string>;
  tests: ReadonlySet<string>;
  adrIds: ReadonlySet<string>;
}

export interface References {
  acIds?: readonly string[];
  taskIds?: readonly string[];
  files?: readonly string[];
  tests?: readonly string[];
  adrIds?: readonly string[];
}

export function unresolvedReferences(refs: References, ctx: RefContext): string[] {
  const errors: string[] = [];
  const check = (
    label: string,
    values: readonly string[] | undefined,
    known: ReadonlySet<string>,
    normalize: (v: string) => string = (v) => v,
  ) => {
    for (const value of values ?? []) {
      if (!known.has(normalize(value))) errors.push(`unknown ${label}: ${value}`);
    }
  };
  check('acceptance criterion', refs.acIds, ctx.acIds);
  check('task', refs.taskIds, ctx.taskIds);
  check('file', refs.files, ctx.files, normalizePath);
  check('test', refs.tests, ctx.tests);
  check('ADR', refs.adrIds, ctx.adrIds);
  return errors;
}
```

- [ ] **Step 4: Run the references test**

Run: `npx vitest run test/validators/references.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Write the failing agent-output test**

`test/validators/agent-output.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateAgentOutput } from '../../server/validators/agent-output.js';
import type { RefContext } from '../../server/validators/references.js';

const HASH = `sha256:${'b'.repeat(64)}`;
const Output = z.object({
  specHash: z.string(),
  status: z.enum(['done', 'spec-gap']),
  files: z.array(z.string()),
  question: z.string().optional(),
});

const refContext: RefContext = {
  acIds: new Set(),
  taskIds: new Set(),
  files: new Set(['src/a.ts']),
  tests: new Set(),
  adrIds: new Set(),
};

const opts = {
  expectedSpecHash: HASH,
  refContext,
  refs: (v: z.infer<typeof Output>) => ({ files: v.files }),
  semantic: [(v: z.infer<typeof Output>) => (v.status === 'spec-gap' && !v.question ? ['spec-gap requires a question'] : [])],
};

describe('validateAgentOutput', () => {
  it('returns the parsed value when every check passes', () => {
    const result = validateAgentOutput(Output, { specHash: HASH, status: 'done', files: ['src/a.ts'] }, opts);
    expect(result).toEqual({ ok: true, value: { specHash: HASH, status: 'done', files: ['src/a.ts'] } });
  });

  it('reports schema errors with their path and stops there', () => {
    const result = validateAgentOutput(Output, { specHash: HASH, status: 'finished', files: [] }, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/^status: /);
  });

  it('rejects a specHash mismatch', () => {
    const result = validateAgentOutput(Output, { specHash: `sha256:${'c'.repeat(64)}`, status: 'done', files: [] }, opts);
    expect(result).toEqual({ ok: false, errors: [expect.stringContaining('specHash mismatch')] });
  });

  it('collects reference and semantic errors together', () => {
    const result = validateAgentOutput(Output, { specHash: HASH, status: 'spec-gap', files: ['src/ghost.ts'] }, opts);
    expect(result).toEqual({ ok: false, errors: ['unknown file: src/ghost.ts', 'spec-gap requires a question'] });
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/validators/agent-output.test.ts`
Expected: FAIL — cannot resolve `../../server/validators/agent-output.js`.

- [ ] **Step 7: Implement the agent-output pipeline**

`server/validators/agent-output.ts`:
```ts
import type { z } from 'zod';
import { unresolvedReferences, type RefContext, type References } from './references.js';
import type { Validation } from './result.js';

export interface OutputCheckOptions<T> {
  expectedSpecHash: string;
  refs?: (value: T) => References;
  refContext?: RefContext;
  semantic?: ReadonlyArray<(value: T) => string[]>;
}

export function validateAgentOutput<T extends { specHash: string }>(
  schema: z.ZodType<T>,
  raw: unknown,
  opts: OutputCheckOptions<T>,
): Validation<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    };
  }
  const value = parsed.data;
  const errors: string[] = [];
  if (value.specHash !== opts.expectedSpecHash) {
    errors.push(`specHash mismatch: expected ${opts.expectedSpecHash}, got ${value.specHash}`);
  }
  if (opts.refs && opts.refContext) {
    errors.push(...unresolvedReferences(opts.refs(value), opts.refContext));
  }
  for (const check of opts.semantic ?? []) errors.push(...check(value));
  return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
}
```

- [ ] **Step 8: Run the agent-output test**

Run: `npx vitest run test/validators/agent-output.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 9: Write the failing plan-validator test**

`test/validators/plan.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Plan } from '../../server/contracts/plan.js';
import { findCycle, validatePlan } from '../../server/validators/plan.js';
import { makeFrozenSpec, makePlan, makePlanTask } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const withTasks = (tasks: Plan['tasks']): Plan => ({ ...makePlan(spec), tasks });

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
      ]),
      spec,
      { firstSpec: true },
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        'duplicate task id T1-a',
        'task T1-a depends on itself',
        'task T2-b depends on unknown task T9-ghost',
      ]),
    );
  });

  it('reports uncovered and unknown acceptance criteria', () => {
    const errors = validatePlan(
      withTasks([
        makePlanTask({ id: 'T0-scaffold' }),
        makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001', 'AC-099'], dependsOn: ['T0-scaffold'] }),
      ]),
      spec,
      { firstSpec: true },
    );
    expect(errors).toEqual(
      expect.arrayContaining([
        'task T1-a references unknown acceptance criterion AC-099',
        'acceptance criterion AC-002 is not covered by any task',
      ]),
    );
  });

  it('reports a three-task cycle with its path', () => {
    const errors = validatePlan(
      withTasks([
        makePlanTask({ id: 'T0-scaffold' }),
        makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001', 'AC-002'], dependsOn: ['T0-scaffold', 'T3-c'] }),
        makePlanTask({ id: 'T2-b', dependsOn: ['T1-a'] }),
        makePlanTask({ id: 'T3-c', dependsOn: ['T2-b'] }),
      ]),
      spec,
      { firstSpec: true },
    );
    expect(errors).toContain('dependency cycle: T1-a -> T3-c -> T2-b -> T1-a');
  });

  it('requires a scaffold task on the first spec that every task depends on', () => {
    const missing = validatePlan(
      withTasks([makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001', 'AC-002'] })]),
      spec,
      { firstSpec: true },
    );
    expect(missing).toContain('first spec requires task T0-scaffold');

    const detached = validatePlan(
      withTasks([
        makePlanTask({ id: 'T0-scaffold' }),
        makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001', 'AC-002'], dependsOn: ['T0-scaffold'] }),
        makePlanTask({ id: 'T2-b' }),
      ]),
      spec,
      { firstSpec: true },
    );
    expect(detached).toContain('task T2-b must depend on T0-scaffold');
  });

  it('accepts a transitive dependency on the scaffold task', () => {
    const errors = validatePlan(
      withTasks([
        makePlanTask({ id: 'T0-scaffold' }),
        makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001'], dependsOn: ['T0-scaffold'] }),
        makePlanTask({ id: 'T2-b', criteriaRefs: ['AC-002'], dependsOn: ['T1-a'] }),
      ]),
      spec,
      { firstSpec: true },
    );
    expect(errors).toEqual([]);
  });

  it('does not require a scaffold task after the first spec', () => {
    const errors = validatePlan(
      withTasks([makePlanTask({ id: 'T1-a', criteriaRefs: ['AC-001', 'AC-002'] })]),
      spec,
      { firstSpec: false },
    );
    expect(errors).toEqual([]);
  });

  it('requires at least one blocking gate', () => {
    const plan = { ...makePlan(spec), gates: [{ name: 'dependency-scan', command: 'osv-scanner .', blocking: false }] };
    expect(validatePlan(plan, spec, { firstSpec: true })).toContain('plan must define at least one blocking gate');
  });
});

describe('findCycle', () => {
  it('returns null for an acyclic graph', () => {
    expect(findCycle([makePlanTask({ id: 'T1-a' }), makePlanTask({ id: 'T2-b', dependsOn: ['T1-a'] })])).toBeNull();
  });
});
```

- [ ] **Step 10: Run test to verify it fails**

Run: `npx vitest run test/validators/plan.test.ts`
Expected: FAIL — cannot resolve `../../server/validators/plan.js`.

- [ ] **Step 11: Implement the plan validator**

`server/validators/plan.ts`:
```ts
import type { Plan, PlanTask } from '../contracts/plan.js';
import type { Spec } from '../contracts/spec.js';

export const SCAFFOLD_TASK_ID = 'T0-scaffold';

export interface PlanCheckOptions {
  firstSpec: boolean;
}

export function validatePlan(plan: Plan, spec: Spec, opts: PlanCheckOptions): string[] {
  const errors: string[] = [];

  if (spec.specHash === null) errors.push('spec is not frozen');
  else if (plan.specHash !== spec.specHash) {
    errors.push(`plan specHash ${plan.specHash} does not match spec ${spec.specHash}`);
  }
  if (plan.specId !== spec.specId) errors.push(`plan specId ${plan.specId} does not match spec ${spec.specId}`);

  const ids = new Set<string>();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) errors.push(`duplicate task id ${task.id}`);
    ids.add(task.id);
  }

  const acIds = new Set(spec.acceptanceCriteria.map((ac) => ac.id));
  const covered = new Set<string>();
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) errors.push(`task ${task.id} depends on itself`);
      else if (!ids.has(dep)) errors.push(`task ${task.id} depends on unknown task ${dep}`);
    }
    for (const ref of task.criteriaRefs) {
      if (!acIds.has(ref)) errors.push(`task ${task.id} references unknown acceptance criterion ${ref}`);
      covered.add(ref);
    }
  }
  for (const ac of acIds) {
    if (!covered.has(ac)) errors.push(`acceptance criterion ${ac} is not covered by any task`);
  }

  const cycle = findCycle(plan.tasks);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);

  if (opts.firstSpec) {
    if (!ids.has(SCAFFOLD_TASK_ID)) errors.push(`first spec requires task ${SCAFFOLD_TASK_ID}`);
    else {
      const byId = new Map(plan.tasks.map((t) => [t.id, t]));
      for (const task of plan.tasks) {
        if (task.id === SCAFFOLD_TASK_ID) continue;
        if (!reaches(task.id, SCAFFOLD_TASK_ID, byId)) {
          errors.push(`task ${task.id} must depend on ${SCAFFOLD_TASK_ID}`);
        }
      }
    }
  }

  if (!plan.gates.some((g) => g.blocking)) errors.push('plan must define at least one blocking gate');

  return errors;
}

export function findCycle(tasks: readonly PlanTask[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const color = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    color.set(id, 'visiting');
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep) || dep === id) continue;
      if (color.get(dep) === 'visiting') return [...stack.slice(stack.indexOf(dep)), dep];
      if (!color.has(dep)) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, 'done');
    return null;
  };

  for (const task of tasks) {
    if (!color.has(task.id)) {
      const found = visit(task.id);
      if (found) return found;
    }
  }
  return null;
}

function reaches(from: string, target: string, byId: ReadonlyMap<string, PlanTask>): boolean {
  const seen = new Set<string>();
  const pending = [...(byId.get(from)?.dependsOn ?? [])];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return false;
}
```

- [ ] **Step 12: Run tests and typecheck**

Run: `npx vitest run test/validators && npm run typecheck`
Expected: 18 tests PASS; typecheck exits 0.

- [ ] **Step 13: Commit**

```bash
git add server/validators test/validators
git commit -m "feat: add reference, agent output and plan validators" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Evidence — JUnit parsing and AC matrix

**Files:**
- Create: `server/evidence/junit.ts`, `server/evidence/matrix.ts`
- Test: `test/evidence/junit.test.ts`, `test/evidence/matrix.test.ts`

**Interfaces:**
- Consumes: `Spec` (Task 2), `PlanTask` (Task 2), `TaskState` (Task 4); fixtures `makeFrozenSpec`, `makePlanTask` (Task 2).
- Produces:
  - `type TestStatus = 'passed' | 'failed' | 'skipped'`
  - `interface TestResult { id: string; name: string; classname: string; status: TestStatus; acIds: string[] }` (`id` is `<classname>::<name>`)
  - `class JUnitParseError extends Error`
  - `extractAcIds(text: string): string[]`, `parseJUnit(xml: string): TestResult[]`
  - `type EvidenceStatus = 'passed' | 'failed' | 'missing' | 'blocked'`
  - `interface EvidenceRow { criterion: string; tasks: string[]; tests: string[]; status: EvidenceStatus }`
  - `interface EvidenceTask { def: PlanTask; state: TaskState }`
  - `buildEvidenceMatrix(spec: Spec, tasks: Iterable<EvidenceTask>, results: readonly TestResult[]): EvidenceRow[]`
  - `evidenceGate(results: readonly TestResult[]): string[]`
  - `readyForValidation(rows: readonly EvidenceRow[]): boolean`

- [ ] **Step 1: Write the failing JUnit test**

`test/evidence/junit.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { JUnitParseError, extractAcIds, parseJUnit } from '../../server/evidence/junit.js';

const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="todos" tests="4">
    <testcase classname="test/todos.test.ts" name="[AC-001] creates a todo"/>
    <testcase classname="test/todos.test.ts" name="[ac-002] lists todos"><failure message="expected 2, got 1"/></testcase>
    <testcase classname="test/todos.test.ts" name="[AC-2] loose tag is ignored"/>
    <testcase classname="test/todos.test.ts" name="skipped case"><skipped/></testcase>
  </testsuite>
</testsuites>`;

describe('extractAcIds', () => {
  it('accepts any case but requires three digits', () => {
    expect(extractAcIds('[ac-003] and [AC-001] and [AC-3] and [AC-001]')).toEqual(['AC-003', 'AC-001']);
  });
});

describe('parseJUnit', () => {
  it('parses statuses and AC tags', () => {
    expect(parseJUnit(REPORT)).toEqual([
      { id: 'test/todos.test.ts::[AC-001] creates a todo', name: '[AC-001] creates a todo', classname: 'test/todos.test.ts', status: 'passed', acIds: ['AC-001'] },
      { id: 'test/todos.test.ts::[ac-002] lists todos', name: '[ac-002] lists todos', classname: 'test/todos.test.ts', status: 'failed', acIds: ['AC-002'] },
      { id: 'test/todos.test.ts::[AC-2] loose tag is ignored', name: '[AC-2] loose tag is ignored', classname: 'test/todos.test.ts', status: 'passed', acIds: [] },
      { id: 'test/todos.test.ts::skipped case', name: 'skipped case', classname: 'test/todos.test.ts', status: 'skipped', acIds: [] },
    ]);
  });

  it('treats <error> as a failure', () => {
    const xml = '<testsuite name="s"><testcase classname="c" name="[AC-001] boom"><error message="x"/></testcase></testsuite>';
    expect(parseJUnit(xml)[0]!.status).toBe('failed');
  });

  it('accepts a single root testsuite with one testcase', () => {
    const results = parseJUnit('<testsuite name="one"><testcase classname="a" name="[AC-001] only"/></testsuite>');
    expect(results).toHaveLength(1);
    expect(results[0]!.acIds).toEqual(['AC-001']);
  });

  it('collects testcases from nested suites', () => {
    const xml = '<testsuites><testsuite name="outer"><testsuite name="inner"><testcase classname="b" name="[AC-003] nested"/></testsuite></testsuite></testsuites>';
    expect(parseJUnit(xml).map((r) => r.acIds)).toEqual([['AC-003']]);
  });

  it('reads AC tags from the classname too', () => {
    const xml = '<testsuite name="s"><testcase classname="[AC-004] suite" name="case"/></testsuite>';
    expect(parseJUnit(xml)[0]!.acIds).toEqual(['AC-004']);
  });

  it('returns no results for an empty report', () => {
    expect(parseJUnit('<testsuites></testsuites>')).toEqual([]);
  });

  it('throws on malformed XML', () => {
    expect(() => parseJUnit('<testsuites><testsuite>')).toThrow(JUnitParseError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/evidence/junit.test.ts`
Expected: FAIL — cannot resolve `../../server/evidence/junit.js`.

- [ ] **Step 3: Implement the JUnit parser**

`server/evidence/junit.ts`:
```ts
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface TestResult {
  id: string;
  name: string;
  classname: string;
  status: TestStatus;
  acIds: string[];
}

export class JUnitParseError extends Error {}

type XmlNode = Record<string, unknown>;

const AC_TAG = /\[ac-(\d{3})\]/gi;

export function extractAcIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(AC_TAG)) ids.add(`AC-${match[1]}`);
  return [...ids];
}

function asNode(value: unknown): XmlNode {
  return value !== null && typeof value === 'object' ? (value as XmlNode) : {};
}

function asNodes(value: unknown): XmlNode[] {
  if (value === undefined || value === null || value === '') return [];
  return (Array.isArray(value) ? value : [value]).map(asNode);
}

function collectCases(suite: XmlNode, out: XmlNode[]): void {
  out.push(...asNodes(suite.testcase));
  for (const child of asNodes(suite.testsuite)) collectCases(child, out);
}

export function parseJUnit(xml: string): TestResult[] {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new JUnitParseError(`invalid JUnit XML: ${validation.err.msg} (line ${validation.err.line})`);
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (name) => name === 'testsuite' || name === 'testcase',
  });
  const root = asNode(parser.parse(xml));
  const cases: XmlNode[] = [];
  for (const suite of asNodes(asNode(root.testsuites).testsuite)) collectCases(suite, cases);
  for (const suite of asNodes(root.testsuite)) collectCases(suite, cases);

  return cases.map((testcase) => {
    const name = String(testcase.name ?? '');
    const classname = String(testcase.classname ?? '');
    const status: TestStatus =
      'failure' in testcase || 'error' in testcase ? 'failed' : 'skipped' in testcase ? 'skipped' : 'passed';
    const acIds = status === 'skipped' ? [] : extractAcIds(`${classname} ${name}`);
    return { id: `${classname}::${name}`, name, classname, status, acIds };
  });
}
```

- [ ] **Step 4: Run the JUnit test**

Run: `npx vitest run test/evidence/junit.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Write the failing matrix test**

`test/evidence/matrix.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { TestResult } from '../../server/evidence/junit.js';
import { buildEvidenceMatrix, evidenceGate, readyForValidation } from '../../server/evidence/matrix.js';
import type { TaskState } from '../../server/pipeline/task-state.js';
import { makeFrozenSpec, makePlanTask } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const result = (name: string, status: TestResult['status'], acIds: string[]): TestResult => ({
  id: `t::${name}`,
  name,
  classname: 't',
  status,
  acIds,
});
const task = (id: string, criteriaRefs: string[], state: TaskState) => ({ def: makePlanTask({ id, criteriaRefs }), state });

describe('buildEvidenceMatrix', () => {
  it('marks criteria passed, failed or missing from test results', () => {
    const rows = buildEvidenceMatrix(
      spec,
      [task('T1-create', ['AC-001'], 'merged'), task('T2-list', ['AC-002'], 'merged')],
      [result('[AC-001] a', 'passed', ['AC-001'])],
    );
    expect(rows).toEqual([
      { criterion: 'AC-001', tasks: ['T1-create'], tests: ['t::[AC-001] a'], status: 'passed' },
      { criterion: 'AC-002', tasks: ['T2-list'], tests: [], status: 'missing' },
    ]);
  });

  it('lets any failing test fail the criterion', () => {
    const rows = buildEvidenceMatrix(
      spec,
      [task('T1-create', ['AC-001'], 'merged')],
      [result('[AC-001] a', 'passed', ['AC-001']), result('[AC-001] b', 'failed', ['AC-001'])],
    );
    expect(rows[0]!.status).toBe('failed');
  });

  it('marks a criterion blocked when all of its tasks are blocked and it has no tests', () => {
    const rows = buildEvidenceMatrix(spec, [task('T1-create', ['AC-001'], 'merged'), task('T2-list', ['AC-002'], 'blocked')], [
      result('[AC-001] a', 'passed', ['AC-001']),
    ]);
    expect(rows[1]!.status).toBe('blocked');
  });

  it('ignores superseded tasks when attributing criteria', () => {
    const rows = buildEvidenceMatrix(
      spec,
      [task('T1-create', ['AC-001'], 'superseded'), task('T4-create2', ['AC-001'], 'merged'), task('T2-list', ['AC-002'], 'merged')],
      [],
    );
    expect(rows[0]!.tasks).toEqual(['T4-create2']);
  });
});

describe('evidenceGate', () => {
  it('fails when the report has no test cases', () => {
    expect(evidenceGate([])).toEqual(['JUnit report contains no test cases']);
  });

  it('fails when every test was skipped', () => {
    expect(evidenceGate([result('x', 'skipped', [])])).toEqual(['JUnit report contains no executed tests']);
  });

  it('passes when at least one test executed', () => {
    expect(evidenceGate([result('x', 'failed', [])])).toEqual([]);
  });
});

describe('readyForValidation', () => {
  it('requires every criterion to be passed or blocked', () => {
    expect(readyForValidation([{ criterion: 'AC-001', tasks: [], tests: [], status: 'passed' }, { criterion: 'AC-002', tasks: [], tests: [], status: 'blocked' }])).toBe(true);
    expect(readyForValidation([{ criterion: 'AC-001', tasks: [], tests: [], status: 'missing' }])).toBe(false);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/evidence/matrix.test.ts`
Expected: FAIL — cannot resolve `../../server/evidence/matrix.js`.

- [ ] **Step 7: Implement the matrix**

`server/evidence/matrix.ts`:
```ts
import type { PlanTask } from '../contracts/plan.js';
import type { Spec } from '../contracts/spec.js';
import type { TaskState } from '../pipeline/task-state.js';
import type { TestResult } from './junit.js';

export type EvidenceStatus = 'passed' | 'failed' | 'missing' | 'blocked';

export interface EvidenceRow {
  criterion: string;
  tasks: string[];
  tests: string[];
  status: EvidenceStatus;
}

export interface EvidenceTask {
  def: PlanTask;
  state: TaskState;
}

export function buildEvidenceMatrix(
  spec: Spec,
  tasks: Iterable<EvidenceTask>,
  results: readonly TestResult[],
): EvidenceRow[] {
  const live = [...tasks].filter((t) => t.state !== 'superseded');
  return spec.acceptanceCriteria.map((ac) => {
    const owners = live.filter((t) => t.def.criteriaRefs.includes(ac.id));
    const tests = results.filter((r) => r.status !== 'skipped' && r.acIds.includes(ac.id));
    let status: EvidenceStatus;
    if (tests.some((r) => r.status === 'failed')) status = 'failed';
    else if (tests.length > 0) status = 'passed';
    else if (owners.length > 0 && owners.every((t) => t.state === 'blocked')) status = 'blocked';
    else status = 'missing';
    return { criterion: ac.id, tasks: owners.map((t) => t.def.id), tests: tests.map((r) => r.id), status };
  });
}

export function evidenceGate(results: readonly TestResult[]): string[] {
  if (results.length === 0) return ['JUnit report contains no test cases'];
  if (results.every((r) => r.status === 'skipped')) return ['JUnit report contains no executed tests'];
  return [];
}

export function readyForValidation(rows: readonly EvidenceRow[]): boolean {
  return rows.every((r) => r.status === 'passed' || r.status === 'blocked');
}
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npx vitest run test/evidence && npm run typecheck`
Expected: 16 tests PASS; typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add server/evidence test/evidence
git commit -m "feat: add JUnit evidence parser and acceptance criteria matrix" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Diff guard — frozen files and scope

**Files:**
- Create: `server/validators/diff-guard.ts`
- Test: `test/validators/diff-guard.test.ts`

**Interfaces:**
- Consumes: `normalizePath`, `hasGlobChars` (Task 5).
- Produces:
  - `interface ScopeInput { changedFiles: readonly string[]; affectedPaths: readonly string[]; frozenPaths: readonly string[]; scopeJustification?: string; allowFrozen?: boolean }`
  - `interface ScopeResult { ok: boolean; errors: string[]; frozenTouched: string[]; outOfScope: string[] }`
  - `checkScope(input: ScopeInput): ScopeResult`

`allowFrozen` is set by the caller only for `T0-scaffold` on the first spec (spec §4.4). A bare path without glob characters matches both the exact file and everything below it.

- [ ] **Step 1: Write the failing test**

`test/validators/diff-guard.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { checkScope } from '../../server/validators/diff-guard.js';

const base = {
  affectedPaths: ['src/todos/create/**'],
  frozenPaths: ['package.json', 'vitest.config.ts', '.github/**'],
};

describe('checkScope', () => {
  it('accepts changes inside affected paths', () => {
    expect(checkScope({ ...base, changedFiles: ['src/todos/create/handler.ts'] })).toEqual({
      ok: true,
      errors: [],
      frozenTouched: [],
      outOfScope: [],
    });
  });

  it('rejects frozen files even with a justification', () => {
    const result = checkScope({ ...base, changedFiles: ['package.json'], scopeJustification: 'needed a dependency' });
    expect(result.ok).toBe(false);
    expect(result.frozenTouched).toEqual(['package.json']);
    expect(result.errors).toEqual(['frozen files modified: package.json']);
  });

  it('matches dotfile directories in frozen globs', () => {
    expect(checkScope({ ...base, changedFiles: ['.github/workflows/ci.yml'] }).frozenTouched).toEqual(['.github/workflows/ci.yml']);
  });

  it('allows frozen files for the scaffold task', () => {
    const result = checkScope({ ...base, affectedPaths: ['package.json'], changedFiles: ['package.json'], allowFrozen: true });
    expect(result.ok).toBe(true);
    expect(result.frozenTouched).toEqual([]);
  });

  it('rejects out-of-scope files without a justification', () => {
    const result = checkScope({ ...base, changedFiles: ['src/todos/list/handler.ts'] });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['files outside affectedPaths without scopeJustification: src/todos/list/handler.ts']);
  });

  it('accepts out-of-scope files with a justification and reports them for review', () => {
    const result = checkScope({ ...base, changedFiles: ['src/shared/id.ts'], scopeJustification: 'shared id helper' });
    expect(result.ok).toBe(true);
    expect(result.outOfScope).toEqual(['src/shared/id.ts']);
  });

  it('treats a whitespace-only justification as missing', () => {
    expect(checkScope({ ...base, changedFiles: ['src/shared/id.ts'], scopeJustification: '   ' }).ok).toBe(false);
  });

  it('normalizes agent-style paths and removes duplicates', () => {
    const result = checkScope({ ...base, changedFiles: ['.\\src\\todos\\create\\handler.ts', 'src/todos/create/handler.ts'] });
    expect(result.ok).toBe(true);
  });

  it('treats a bare directory in affectedPaths as covering its children', () => {
    expect(checkScope({ ...base, affectedPaths: ['src/todos/create'], changedFiles: ['src/todos/create/deep/x.ts'] }).ok).toBe(true);
    expect(checkScope({ ...base, affectedPaths: ['src/todos/create/'], changedFiles: ['src/todos/create/x.ts'] }).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/validators/diff-guard.test.ts`
Expected: FAIL — cannot resolve `../../server/validators/diff-guard.js`.

- [ ] **Step 3: Implement the guard**

`server/validators/diff-guard.ts`:
```ts
import picomatch from 'picomatch';
import { hasGlobChars, normalizePath } from '../core/paths.js';

export interface ScopeInput {
  changedFiles: readonly string[];
  affectedPaths: readonly string[];
  frozenPaths: readonly string[];
  scopeJustification?: string;
  /** Only for T0-scaffold on the first spec, which creates the frozen files. */
  allowFrozen?: boolean;
}

export interface ScopeResult {
  ok: boolean;
  errors: string[];
  frozenTouched: string[];
  outOfScope: string[];
}

function matcher(globs: readonly string[]): (file: string) => boolean {
  const patterns = globs.flatMap((raw) => {
    const glob = normalizePath(raw);
    return hasGlobChars(glob) ? [glob] : [glob, `${glob}/**`];
  });
  if (patterns.length === 0) return () => false;
  return picomatch(patterns, { dot: true });
}

export function checkScope(input: ScopeInput): ScopeResult {
  const isFrozen = input.allowFrozen ? () => false : matcher(input.frozenPaths);
  const inScope = matcher(input.affectedPaths);
  const files = [...new Set(input.changedFiles.map(normalizePath))];

  const frozenTouched = files.filter((f) => isFrozen(f));
  const outOfScope = files.filter((f) => !isFrozen(f) && !inScope(f));

  const errors: string[] = [];
  if (frozenTouched.length > 0) errors.push(`frozen files modified: ${frozenTouched.join(', ')}`);
  if (outOfScope.length > 0 && !input.scopeJustification?.trim()) {
    errors.push(`files outside affectedPaths without scopeJustification: ${outOfScope.join(', ')}`);
  }
  return { ok: errors.length === 0, errors, frozenTouched, outOfScope };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/validators/diff-guard.test.ts && npm run typecheck`
Expected: 9 tests PASS; typecheck exits 0.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: 14 test files, 117 tests PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add server/validators/diff-guard.ts test/validators/diff-guard.test.ts
git commit -m "feat: add frozen-file and scope diff guard" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
