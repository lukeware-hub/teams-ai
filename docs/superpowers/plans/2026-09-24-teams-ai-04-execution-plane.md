# teams-ai Plan 4 — Execution Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the orchestrator the deterministic, non-LLM half of the task loop: run gates in disposable containers, drive git and GitHub idempotently through a serialized merge queue, and deploy to `docker-local` and `kind` with verification and rollback.

**Architecture:** One tiny impure primitive — `execCommand` — runs every external tool (`docker`, `git`, `gh`, `kubectl`, `kind`). Everything above it takes an `Exec` function as a dependency, so the gate runner, GitHub wrapper, merge queue and deploy adapters are tested with a scripted fake, while the git controller is tested against a real local bare repository (git is fast and available everywhere). Nothing here calls an LLM; agents only produce the intents these modules execute (spec §1.2, §3.2).

**Tech Stack:** Node 22 (ESM), TypeScript 5.9.3, Vitest 5, zod 4, Node `child_process`, global `fetch`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-teams-ai-poc-design.md` — §3.2 (exec, git, deploy units), §4.3 (gates), §4.5 (evidence), §6 (Phase 3 steps 1–6, Phase 5), §7.4 (idempotency), §12, §14.

## Global Constraints

- Everything from Plan 1's Global Constraints (pins, ESM, `.js` import suffix, English, commit trailer).
- `npm test` never touches Docker, GitHub, kind or the network; it spawns only `git` and `node`. Real-tool integration is Task 7 (manual, WSL).
- Every external command goes through `execCommand`; no module imports `child_process` except `server/exec/command.ts` (and Plan 3's process runner).
- Idempotency (spec §7.4): repo, branch, PR and merge operations check existing state before acting; deterministic names come from Plan 1's `ids.ts`.
- Secrets reach a gate container only through `-e NAME=value` for the names the gate declares, never through files in the worktree or the command line of a non-gate step.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

## Review Focus

1. **Gate exits 137 (OOM kill) or the Docker daemon is unreachable** — must be `infra`, never charged to the Dev as a code failure (test in Task 2).
2. **Rebase conflict** — the worktree must be left clean (rebase aborted) with the conflicting files listed, so the Dev step can resolve them (test in Task 3).
3. **`gh pr create` succeeds but the process dies before the PR number is recorded** — a retry must find the existing PR by head branch, not open a second one (test in Task 4).
4. **`main` moves between the gate re-run and the merge** — `--match-head-commit` makes GitHub refuse; the queue must report `merge` stage failure and let the caller re-queue, never force (test in Task 4).
5. **Healthcheck passes but the smoke suite fails** — rollback to the previous image must run and `verify` must confirm the old version is back before the failure is reported (test in Task 5).

---

## File structure

```
server/exec/command.ts            execCommand(spec) → CommandResult; Exec type
server/exec/gate-runner.ts        docker run args, runGate/runGates, JUnit pickup, infra classification
server/git/git.ts                 worktrees, commit, rebase, push, changed files
server/git/github.ts              gh wrapper: ensureRepo, ensurePr, mergePr (idempotent)
server/git/merge-queue.ts         serialized rebase → gates → push → PR → merge
server/deploy/target.ts           DeployTarget interface, DeploymentIntent, runDeployment()
server/deploy/docker-local.ts     docker build/run adapter
server/deploy/kind.ts             kind load + kubectl apply adapter
server/contracts/plan.ts          + gateImage, Gate.network, Gate.secrets (full replacement)
test/fixtures/contracts.ts        fixture updated for the new fields (full replacement)
test/fixtures/fake-exec.ts        scripted Exec for tests
test/fixtures/hello-app/          tiny HTTP app + Dockerfile + k8s manifest for Task 7
scripts/integration/exec-plane.ts manual integration against real docker/kind (Task 7)
```

---

### Task 1: Command executor

**Files:**
- Create: `server/exec/command.ts`, `test/fixtures/fake-exec.ts`
- Test: `test/exec/command.test.ts`

**Interfaces:**
- Produces:
  - `interface CommandSpec { bin: string; args: readonly string[]; cwd?: string; env?: Record<string, string>; timeoutMs: number; stdin?: string; outputLimit?: number }`
  - `interface CommandResult { exitCode: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number; truncated: boolean }`
  - `type Exec = (spec: CommandSpec) => Promise<CommandResult>`
  - `execCommand: Exec` — spawns with `env` merged over a minimal base (`PATH`, `HOME`, `TEMP/TMP`, `SystemRoot` on Windows), kills the process tree on timeout, caps captured output at `outputLimit` (default 1 MiB per stream)
  - `class CommandError extends Error` — thrown only when the binary cannot be spawned
  - Fixture: `class FakeExec { calls: CommandSpec[]; on(match: (spec) => boolean, respond: (spec) => Partial<CommandResult> | Promise<Partial<CommandResult>>): this; exec: Exec }` — unmatched calls resolve `exitCode 0` with empty output and are recorded

- [ ] **Step 1: Write the failing test**

`test/exec/command.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CommandError, execCommand } from '../../server/exec/command.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const node = (code: string, over: Partial<Parameters<typeof execCommand>[0]> = {}) =>
  execCommand({ bin: process.execPath, args: ['-e', code], timeoutMs: 5_000, ...over });

describe('execCommand', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const r = await node('process.stdout.write("out"); process.stderr.write("err"); process.exit(3)');
    expect(r).toMatchObject({ exitCode: 3, stdout: 'out', stderr: 'err', timedOut: false, truncated: false });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('feeds stdin and passes only the given environment on top of the base', async () => {
    const r = await node('let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(s+"|"+(process.env.X??"")+"|"+(process.env.LEAK??"none"))})', {
      stdin: 'hi',
      env: { X: '1' },
    });
    expect(r.stdout).toBe('hi|1|none');
  });

  it('kills a process that exceeds the timeout', async () => {
    const started = Date.now();
    const r = await node('setInterval(()=>{},1000)', { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('keeps the tail of the output when truncating, so the decisive last lines survive', async () => {
    const r = await node('process.stdout.write("x".repeat(5000) + "no space left on device")', { outputLimit: 1000 });
    expect(r.stdout.length).toBe(1000);
    expect(r.stdout.endsWith('no space left on device')).toBe(true);
    expect(r.truncated).toBe(true);
  });

  it('kills the whole process group on timeout even when a grandchild ignores SIGTERM', async () => {
    const started = Date.now();
    const r = await node(
      'const {spawn}=require("child_process"); spawn(process.execPath,["-e","process.on(\\"SIGTERM\\",()=>{}); setInterval(()=>{},1000)"],{stdio:"inherit"}); setInterval(()=>{},1000)',
      { timeoutMs: 300 },
    );
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('throws CommandError when the binary does not exist', async () => {
    await expect(execCommand({ bin: 'definitely-not-a-binary-xyz', args: [], timeoutMs: 1000 })).rejects.toThrow(CommandError);
  });

  it('uses cwd', async () => {
    const r = await node('process.stdout.write(process.cwd())', { cwd: process.cwd() });
    expect(r.stdout.toLowerCase()).toBe(process.cwd().toLowerCase());
  });
});

describe('FakeExec', () => {
  it('records calls and answers matched ones', async () => {
    const fake = new FakeExec().on((s) => s.bin === 'gh', () => ({ stdout: '[]' }));
    const r = await fake.exec({ bin: 'gh', args: ['pr', 'list'], timeoutMs: 1 });
    expect(r).toMatchObject({ exitCode: 0, stdout: '[]' });
    const other = await fake.exec({ bin: 'git', args: ['status'], timeoutMs: 1 });
    expect(other.exitCode).toBe(0);
    expect(fake.calls.map((c) => c.bin)).toEqual(['gh', 'git']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/exec/command.test.ts`
Expected: FAIL — cannot resolve `../../server/exec/command.js`.

- [ ] **Step 3: Write the executor and the fake**

`server/exec/command.ts`:
```ts
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface CommandSpec {
  bin: string;
  args: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  stdin?: string;
  outputLimit?: number;
}

export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
}

export type Exec = (spec: CommandSpec) => Promise<CommandResult>;

export class CommandError extends Error {}

const DEFAULT_LIMIT = 1024 * 1024;

/**
 * Variables every tool needs to start; nothing else from the host leaks into a command (spec §14).
 * This executor runs orchestrator tools (git, gh, docker, kubectl) — never agents — so the
 * credential locations under HOME are reachable by design.
 */
export const BASE_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'TEMP',
  'TMP',
  'TMPDIR',
  'SystemRoot',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'TERM',
  'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'KUBECONFIG',
  'DBUS_SESSION_BUS_ADDRESS',
];

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of BASE_ENV_KEYS) if (typeof process.env[k] === 'string') env[k] = process.env[k]!;
  return env;
}

/** Keeps the *tail* of a stream: the decisive line ("no space left on device", the failing test) is at the end. */
class TailBuffer {
  private text = '';
  truncated = false;
  private readonly decoder = new StringDecoder('utf8');
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    const next = this.text + this.decoder.write(chunk);
    if (next.length > this.limit) {
      this.truncated = true;
      this.text = next.slice(-this.limit);
    } else {
      this.text = next;
    }
  }
  end(): string {
    const rest = this.decoder.end();
    if (rest) this.push(Buffer.alloc(0)), (this.text = (this.text + rest).slice(-this.limit));
    return this.text;
  }
}

export const execCommand: Exec = (spec) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const limit = spec.outputLimit ?? DEFAULT_LIMIT;
    const posix = process.platform !== 'win32';
    const child = spawn(spec.bin, [...spec.args], {
      cwd: spec.cwd,
      env: { ...baseEnv(), ...(spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: posix,
    });

    const out = new TailBuffer(limit);
    const err = new TailBuffer(limit);
    let timedOut = false;
    let settled = false;

    child.stdout!.on('data', (c: Buffer) => out.push(c));
    child.stderr!.on('data', (c: Buffer) => err.push(c));

    // Signals go to the whole process group so grandchildren (npm → node, docker CLI → nothing) die too.
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (posix && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* ESRCH: already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      setTimeout(() => signal('SIGKILL'), 1_000).unref();
    }, spec.timeoutMs);

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CommandError(`cannot run ${spec.bin}: ${e.message}`));
    });
    child.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal: sig,
        stdout: out.end(),
        stderr: err.end(),
        timedOut,
        durationMs: Date.now() - started,
        truncated: out.truncated || err.truncated,
      });
    });

    child.stdin!.on('error', () => {
      /* child may exit before reading */
    });
    child.stdin!.end(spec.stdin ?? '');
  });
```

`test/fixtures/fake-exec.ts`:
```ts
import type { CommandResult, CommandSpec, Exec } from '../../server/exec/command.js';

type Responder = (spec: CommandSpec) => Partial<CommandResult> | Promise<Partial<CommandResult>>;

/** Scripted Exec: `on(match, respond)` rules are tried in order; unmatched calls succeed with empty output. */
export class FakeExec {
  readonly calls: CommandSpec[] = [];
  private readonly rules: Array<{ match: (spec: CommandSpec) => boolean; respond: Responder }> = [];

  on(match: (spec: CommandSpec) => boolean, respond: Responder): this {
    this.rules.push({ match, respond });
    return this;
  }

  /** Convenience: match by binary and a leading argument prefix, e.g. `onArgs('gh', ['pr', 'list'], ...)`. */
  onArgs(bin: string, prefix: readonly string[], respond: Responder): this {
    return this.on((s) => s.bin === bin && prefix.every((a, i) => s.args[i] === a), respond);
  }

  exec: Exec = async (spec) => {
    this.calls.push(spec);
    const rule = this.rules.find((r) => r.match(spec));
    const partial = rule ? await rule.respond(spec) : {};
    return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 1, truncated: false, ...partial };
  };

  /** Args of every call to `bin`, joined, for assertions. */
  lines(bin: string): string[] {
    return this.calls.filter((c) => c.bin === bin).map((c) => c.args.join(' '));
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/exec/command.test.ts && npm run typecheck`
Expected: 8 tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/exec/command.ts test/fixtures/fake-exec.ts test/exec/command.test.ts
git commit -m "feat: add command executor and scripted fake" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Plan contract additions and the containerized gate runner

**Files:**
- Modify (full replacement): `server/contracts/plan.ts`, `test/fixtures/contracts.ts`
- Create: `server/exec/gate-runner.ts`
- Test: `test/exec/gate-runner.test.ts`

**Interfaces:**
- Contract additions: `Plan.gateImage: string` (toolchain image for gates, chosen by the Dev's ADR, e.g. `node:22-bookworm`); `Gate.network: 'none' | 'egress'` (default `none`; `install` and `dependency-scan` need `egress`); `Gate.secrets: string[]` (default `[]`, secret names injected as `-e`).
- Produces:
  - `interface GateContext { worktree: string; image: string; junitPath: string; cpus: number; memory: string; timeoutMs: number; secrets: Record<string, string>; containerWorkdir?: string }`
  - `dockerArgs(gate: Gate, ctx: GateContext): string[]` — pure
  - `interface GateResult { name: string; blocking: boolean; passed: boolean; exitCode: number | null; timedOut: boolean; durationMs: number; stdoutTail: string; stderrTail: string; junit: TestResult[] | null; failure: 'infra' | 'code' | null }`
  - `classifyGate(result: Pick<GateResult, 'exitCode' | 'timedOut' | 'stderrTail'>): 'infra' | 'code'` — 137/OOM, `Cannot connect to the Docker daemon`, `docker: not found`, `no space left`, timeout → `infra`
  - `runGate(gate, ctx, deps: { exec: Exec; readFile: (p: string) => Promise<string | null> }): Promise<GateResult>`
  - `runGates(gates, ctx, deps): Promise<{ results: GateResult[]; blockingFailure: GateResult | null }>` — stops at the first blocking failure; non-blocking gates never stop the run
  - `INFRA_PATTERNS: readonly RegExp[]`, `TAIL_CHARS = 4000`

- [ ] **Step 1: Replace the plan contract and fixture**

`server/contracts/plan.ts`:
```ts
import { z } from 'zod';
import { ID_PATTERNS } from '../core/ids.js';
import { HASH_PATTERN } from './hash.js';
import { AC_ID } from './spec.js';

export const ADR_ID = /^ADR-\d{3}$/;

/**
 * A path or glob relative to the repository root, as an agent may declare it. Rejected: absolute
 * paths and drive letters, `..` segments (escape the worktree), and picomatch extglob/negation
 * syntax (`!(...)`, `@(...)`, leading `!`) that would widen a scope guard match.
 */
export const RepoPath = z
  .string()
  .min(1)
  .refine((p) => !/^([/\\]|[A-Za-z]:)/.test(p), { message: 'must be relative to the repository root' })
  .refine((p) => !p.split(/[/\\]/).includes('..'), { message: 'must not contain ".." segments' })
  .refine((p) => !/^!|[!@+?*]\(/.test(p), { message: 'extglob and negation patterns are not allowed' })
  .refine((p) => !/[\0\r\n]/.test(p), { message: 'control characters are not allowed' });

export const Gate = z.object({
  name: z.string().regex(ID_PATTERNS.SLUG),
  command: z.string().min(1),
  blocking: z.boolean(),
  /** Gates run offline unless they must fetch (install, dependency scan). */
  network: z.enum(['none', 'egress']).default('none'),
  /** Secret names injected as environment variables into this gate's container only. */
  secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).default([]),
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
  affectedPaths: z.array(RepoPath).min(1),
  owner: z.enum(['dev', 'devops']),
});
export type PlanTask = z.infer<typeof PlanTask>;

export const Plan = z.object({
  specId: z.string().regex(ID_PATTERNS.SLUG),
  specHash: z.string().regex(HASH_PATTERN),
  stack: z.string().min(1),
  adrRefs: z.array(z.string().regex(ADR_ID)),
  commands: Commands,
  /** Toolchain image every gate runs in (from the stack ADR), e.g. node:22-bookworm. */
  gateImage: z.string().min(1),
  junitPath: RepoPath,
  gates: z.array(Gate).min(1),
  frozenPaths: z.array(RepoPath).min(1),
  tasks: z.array(PlanTask).min(1),
  deploy: z.object({
    image: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    healthcheckPath: z.string().startsWith('/'),
    manifests: z.array(RepoPath),
  }),
});
export type Plan = z.infer<typeof Plan>;
```

`test/fixtures/contracts.ts`:
```ts
import { Gate, Plan, PlanTask } from '../../server/contracts/plan.js';
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

/** The gate set every POC plan must carry (spec §4.3); parsed so defaults (network, secrets) are present. */
export const REQUIRED_GATES: Gate[] = [
  { name: 'install', command: 'npm ci', blocking: true, network: 'egress' as const },
  { name: 'format', command: 'npm run format:check', blocking: true },
  { name: 'lint', command: 'npm run lint', blocking: true },
  { name: 'typecheck', command: 'npm run typecheck', blocking: true },
  { name: 'unit-test', command: 'npm test', blocking: true },
  { name: 'build', command: 'npm run build', blocking: true },
  { name: 'secret-scan', command: 'gitleaks detect --no-git -s .', blocking: true },
  { name: 'dependency-scan', command: 'osv-scanner .', blocking: false, network: 'egress' as const },
].map((g) => Gate.parse(g));

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
    gateImage: 'node:22-bookworm',
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
```

Run: `npm test`
Expected: every existing test still PASSES (the plan validator's required-gate checks are unchanged; `install` is an extra gate, allowed).

- [ ] **Step 2: Write the failing gate-runner test**

`test/exec/gate-runner.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { Gate } from '../../server/contracts/plan.js';
import { Gate as GateSchema } from '../../server/contracts/plan.js';
import { classifyGate, dockerArgs, runGate, runGates, type GateContext, type GateDeps } from '../../server/exec/gate-runner.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const ctx: GateContext = {
  worktree: '/home/u/ws/worktrees/T1-create',
  image: 'node:22-bookworm',
  junitPath: 'reports/junit.xml',
  cpus: 2,
  memory: '2g',
  timeoutMs: 600_000,
  secrets: { NPM_TOKEN: 'npm_x', DATABASE_URL: 'postgres://x' },
  containerName: 'gate-T1-create-a1',
  user: '1000:1000',
};
const gate = (over: Partial<Gate> & { name: string; command: string }): Gate => GateSchema.parse({ blocking: true, ...over });
const JUNIT = '<testsuite name="s"><testcase classname="c" name="[AC-001] ok"/><testcase classname="c" name="[AC-002] bad"><failure/></testcase></testsuite>';

function files(map: Record<string, string>) {
  const store = new Map(Object.entries(map));
  const removed: string[] = [];
  const deps: Pick<GateDeps, 'readFile' | 'removeFile'> = {
    readFile: async (p) => store.get(p.replace(/\\/g, '/')) ?? null,
    removeFile: async (p) => {
      removed.push(p.replace(/\\/g, '/'));
      store.delete(p.replace(/\\/g, '/'));
    },
  };
  return { deps, store, removed };
}

describe('dockerArgs', () => {
  it('runs the command offline in a named, init-managed, non-root container with limits and read-only .git', () => {
    const { args, env } = dockerArgs(gate({ name: 'unit-test', command: 'npm test' }), ctx);
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '--init']);
    expect(args).toEqual(
      expect.arrayContaining([
        '--name', 'gate-T1-create-a1-unit-test',
        '--network', 'none',
        '--cpus', '2',
        '--memory', '2g',
        '--user', '1000:1000',
        '-e', 'HOME=/tmp',
        '--mount', `type=bind,source=${ctx.worktree},target=/work`,
        '--mount', `type=bind,source=${ctx.worktree}/.git,target=/work/.git,readonly`,
        '-w', '/work',
        'node:22-bookworm',
      ]),
    );
    expect(args.slice(-3)).toEqual(['sh', '-lc', 'npm test']);
    expect(args.join(' ')).not.toContain('npm_x');
    expect(env).toEqual({});
  });

  it('gives egress gates a bridge network and passes declared secrets by name, values through the environment', () => {
    const { args, env } = dockerArgs(gate({ name: 'install', command: 'npm ci', network: 'egress', secrets: ['NPM_TOKEN'] }), ctx);
    expect(args[args.indexOf('--network') + 1]).toBe('bridge');
    expect(args).toEqual(expect.arrayContaining(['-e', 'NPM_TOKEN']));
    expect(args.join(' ')).not.toContain('npm_x');
    expect(env).toEqual({ NPM_TOKEN: 'npm_x' });
    expect(env).not.toHaveProperty('DATABASE_URL');
  });

  it('fails loudly when a declared secret is missing', () => {
    expect(() => dockerArgs(gate({ name: 'x', command: 'y', secrets: ['MISSING'] }), ctx)).toThrow(/MISSING/);
  });

  it('omits --user when no user is configured', () => {
    const { args } = dockerArgs(gate({ name: 'x', command: 'y' }), { ...ctx, user: undefined });
    expect(args).not.toContain('--user');
  });
});

describe('classifyGate', () => {
  it('treats OOM kills, daemon errors, disk full and timeouts as infra', () => {
    expect(classifyGate({ exitCode: 137, timedOut: false, stderrTail: '' })).toBe('infra');
    expect(classifyGate({ exitCode: 1, timedOut: false, stderrTail: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' })).toBe('infra');
    expect(classifyGate({ exitCode: 1, timedOut: false, stderrTail: 'write /work/x: no space left on device' })).toBe('infra');
    expect(classifyGate({ exitCode: null, timedOut: true, stderrTail: '' })).toBe('infra');
  });

  it('does not mistake a test\'s own ENOENT or heap message for infra', () => {
    expect(classifyGate({ exitCode: 1, timedOut: false, stderrTail: "Error: ENOENT: no such file or directory, open 'fixtures/x.json'" })).toBe('code');
    expect(classifyGate({ exitCode: 1, timedOut: false, stderrTail: 'FATAL ERROR: JavaScript heap out of memory' })).toBe('code');
    expect(classifyGate({ exitCode: 1, timedOut: false, stderrTail: '3 tests failed' })).toBe('code');
  });
});

describe('runGate', () => {
  it('passes on exit 0, removes a stale report first and picks up the fresh JUnit report', async () => {
    const report = '/home/u/ws/worktrees/T1-create/reports/junit.xml';
    const f = files({ [report]: '<testsuite name="stale"><testcase classname="c" name="[AC-009] stale"/></testsuite>' });
    const fake = new FakeExec().onArgs('docker', ['run'], () => {
      f.store.set(report, JUNIT); // the gate writes a fresh report
      return { stdout: 'ok' };
    });
    const r = await runGate(gate({ name: 'unit-test', command: 'npm test' }), ctx, { exec: fake.exec, ...f.deps });
    expect(f.removed).toEqual([report]);
    expect(r).toMatchObject({ name: 'unit-test', passed: true, exitCode: 0, failure: null });
    expect(r.junit).toHaveLength(2);
    expect(r.junit![1]!.status).toBe('failed');
    const run = fake.calls.find((c) => c.args[0] === 'run')!;
    expect(run.env).toEqual({});
  });

  it('reports a code failure with the tail of the output when the command exits non-zero', async () => {
    const f = files({});
    const fake = new FakeExec().onArgs('docker', ['run'], () => ({ exitCode: 1, stdout: 'x'.repeat(10_000) + 'THE END', stderr: 'FAIL src/a.test.ts' }));
    const r = await runGate(gate({ name: 'unit-test', command: 'npm test' }), ctx, { exec: fake.exec, ...f.deps });
    expect(r.passed).toBe(false);
    expect(r.failure).toBe('code');
    expect(r.stdoutTail.length).toBe(4000);
    expect(r.stdoutTail.endsWith('THE END')).toBe(true);
    expect(r.junit).toBeNull();
  });

  it('reports infra when the container is OOM-killed', async () => {
    const f = files({});
    const fake = new FakeExec().onArgs('docker', ['run'], () => ({ exitCode: 137 }));
    const r = await runGate(gate({ name: 'build', command: 'npm run build' }), ctx, { exec: fake.exec, ...f.deps });
    expect(r.failure).toBe('infra');
  });

  it('force-removes the named container after a timeout so nothing keeps running', async () => {
    const f = files({});
    const fake = new FakeExec().onArgs('docker', ['run'], () => ({ exitCode: null, timedOut: true }));
    const r = await runGate(gate({ name: 'unit-test', command: 'npm test' }), ctx, { exec: fake.exec, ...f.deps });
    expect(r.failure).toBe('infra');
    expect(fake.lines('docker')).toContain('rm -f gate-T1-create-a1-unit-test');
  });

  it('reports infra when docker itself cannot be spawned', async () => {
    const f = files({});
    const r = await runGate(gate({ name: 'build', command: 'npm run build' }), ctx, {
      exec: async () => {
        throw new Error('cannot run docker: spawn docker ENOENT');
      },
      ...f.deps,
    });
    expect(r).toMatchObject({ passed: false, failure: 'infra' });
    expect(r.stderrTail).toMatch(/ENOENT/);
  });

  it('rejects a junitPath that escapes the worktree', async () => {
    const f = files({});
    const fake = new FakeExec();
    await expect(runGate(gate({ name: 'unit-test', command: 'npm test' }), { ...ctx, junitPath: '../outside.xml' }, { exec: fake.exec, ...f.deps })).rejects.toThrow(/junitPath/);
  });
});

describe('runGates', () => {
  const gates = [
    gate({ name: 'lint', command: 'npm run lint' }),
    gate({ name: 'unit-test', command: 'npm test' }),
    gate({ name: 'dependency-scan', command: 'osv-scanner .', blocking: false, network: 'egress' }),
    gate({ name: 'build', command: 'npm run build' }),
  ];

  it('stops at the first blocking failure and skips the rest', async () => {
    const f = files({});
    const fake = new FakeExec().on((s) => s.args.includes('npm test'), () => ({ exitCode: 1, stderr: 'boom' }));
    const out = await runGates(gates, ctx, { exec: fake.exec, ...f.deps });
    expect(out.results.map((r) => r.name)).toEqual(['lint', 'unit-test']);
    expect(out.blockingFailure?.name).toBe('unit-test');
  });

  it('runs every gate when only a non-blocking one fails', async () => {
    const f = files({});
    const fake = new FakeExec().on((s) => s.args.includes('osv-scanner .'), () => ({ exitCode: 2, stdout: 'vuln' }));
    const out = await runGates(gates, ctx, { exec: fake.exec, ...f.deps });
    expect(out.results.map((r) => r.passed)).toEqual([true, true, false, true]);
    expect(out.blockingFailure).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/exec/gate-runner.test.ts`
Expected: FAIL — cannot resolve `../../server/exec/gate-runner.js`.

- [ ] **Step 4: Write the gate runner**

`server/exec/gate-runner.ts`:
```ts
import path from 'node:path';
import type { Gate } from '../contracts/plan.js';
import { parseJUnit, type TestResult } from '../evidence/junit.js';
import type { Exec } from './command.js';

export interface GateContext {
  worktree: string;
  image: string;
  junitPath: string;
  cpus: number;
  memory: string;
  timeoutMs: number;
  /** Secret values available to this run; a gate receives only the names it declares. */
  secrets: Record<string, string>;
  /** Prefix for the container name (deterministic per attempt) so a timed-out container can be removed. */
  containerName: string;
  /** `uid:gid` to run as, so files created in the bind-mounted worktree stay owned by the orchestrator user. */
  user?: string;
  containerWorkdir?: string;
}

export interface GateResult {
  name: string;
  blocking: boolean;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  junit: TestResult[] | null;
  failure: 'infra' | 'code' | null;
}

export const TAIL_CHARS = 4000;

/** Only messages the Docker CLI / daemon produce; a test's own ENOENT or heap message is the Dev's problem. */
export const INFRA_PATTERNS: readonly RegExp[] = [
  /Cannot connect to the Docker daemon/i,
  /docker: (command )?not found/i,
  /spawn docker ENOENT/,
  /no space left on device/i,
  /error during connect/i,
  /OOMKilled/,
];

export interface DockerInvocation {
  args: string[];
  /** Secret values, passed through the environment (`-e NAME` inherits), never on the command line. */
  env: Record<string, string>;
}

export function dockerArgs(gate: Gate, ctx: GateContext): DockerInvocation {
  const workdir = ctx.containerWorkdir ?? '/work';
  const source = ctx.worktree.replace(/\\/g, '/');
  const args = [
    'run',
    '--rm',
    '--init',
    '--name',
    `${ctx.containerName}-${gate.name}`,
    '--network',
    gate.network === 'egress' ? 'bridge' : 'none',
    '--cpus',
    String(ctx.cpus),
    '--memory',
    ctx.memory,
  ];
  if (ctx.user) args.push('--user', ctx.user, '-e', 'HOME=/tmp');
  args.push(
    '--mount',
    `type=bind,source=${source},target=${workdir}`,
    // The worktree's .git (a file pointing at the main repo) must never be writable from inside
    // the gate: a rewritten gitdir/hooks path would run on the host at the next git command.
    '--mount',
    `type=bind,source=${source}/.git,target=${workdir}/.git,readonly`,
    '-w',
    workdir,
  );
  const env: Record<string, string> = {};
  for (const name of gate.secrets) {
    const value = ctx.secrets[name];
    if (value === undefined) throw new Error(`gate ${gate.name} declares secret ${name} but it is not available`);
    args.push('-e', name);
    env[name] = value;
  }
  args.push(ctx.image, 'sh', '-lc', gate.command);
  return { args, env };
}

export function classifyGate(r: Pick<GateResult, 'exitCode' | 'timedOut' | 'stderrTail'>): 'infra' | 'code' {
  if (r.timedOut) return 'infra';
  if (r.exitCode === 137 || r.exitCode === 125) return 'infra';
  if (INFRA_PATTERNS.some((p) => p.test(r.stderrTail))) return 'infra';
  return 'code';
}

const tail = (s: string) => (s.length > TAIL_CHARS ? s.slice(-TAIL_CHARS) : s);

export interface GateDeps {
  exec: Exec;
  readFile: (absolutePath: string) => Promise<string | null>;
  removeFile: (absolutePath: string) => Promise<void>;
}

function junitFile(ctx: GateContext): string {
  const root = ctx.worktree.replace(/\\/g, '/');
  const file = path.posix.normalize(path.posix.join(root, ctx.junitPath.replace(/\\/g, '/')));
  if (!file.startsWith(`${root}/`)) throw new Error(`junitPath escapes the worktree: ${ctx.junitPath}`);
  return file;
}

export async function runGate(gate: Gate, ctx: GateContext, deps: GateDeps): Promise<GateResult> {
  const started = Date.now();
  const report = junitFile(ctx);
  // A stale report from a previous attempt must never be mistaken for this gate's evidence.
  await deps.removeFile(report);

  let base: Omit<GateResult, 'name' | 'blocking' | 'passed' | 'junit' | 'failure'>;
  const invocation = dockerArgs(gate, ctx);
  try {
    const r = await deps.exec({ bin: 'docker', args: invocation.args, env: invocation.env, timeoutMs: ctx.timeoutMs });
    base = { exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, stdoutTail: tail(r.stdout), stderrTail: tail(r.stderr) };
    if (r.timedOut) {
      // SIGTERM reaches the docker CLI, not PID 1 in the container; make sure nothing keeps running.
      await deps.exec({ bin: 'docker', args: ['rm', '-f', `${ctx.containerName}-${gate.name}`], timeoutMs: 60_000 }).catch(() => undefined);
    }
  } catch (err) {
    base = { exitCode: null, timedOut: false, durationMs: Date.now() - started, stdoutTail: '', stderrTail: tail((err as Error).message) };
    return { name: gate.name, blocking: gate.blocking, passed: false, junit: null, failure: 'infra', ...base };
  }
  const passed = base.exitCode === 0 && !base.timedOut;
  let junit: TestResult[] | null = null;
  const xml = await deps.readFile(report);
  if (xml) {
    try {
      junit = parseJUnit(xml);
    } catch {
      junit = null;
    }
  }
  return { name: gate.name, blocking: gate.blocking, passed, junit, failure: passed ? null : classifyGate(base), ...base };
}

export async function runGates(
  gates: readonly Gate[],
  ctx: GateContext,
  deps: GateDeps,
): Promise<{ results: GateResult[]; blockingFailure: GateResult | null }> {
  const results: GateResult[] = [];
  for (const gate of gates) {
    const r = await runGate(gate, ctx, deps);
    results.push(r);
    if (!r.passed && r.blocking) return { results, blockingFailure: r };
  }
  return { results, blockingFailure: null };
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/exec && npm run typecheck`
Expected: 22 tests PASS (command 8, gate-runner 14); typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add server/contracts/plan.ts test/fixtures/contracts.ts server/exec/gate-runner.ts test/exec/gate-runner.test.ts
git commit -m "feat: add containerized gate runner; plan carries gate image, network and secrets" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Git controller (real local repositories)

**Files:**
- Create: `server/git/git.ts`
- Test: `test/git/git.test.ts`

**Interfaces:**
- Produces (all take `exec: Exec` last, default `execCommand`):
  - `class GitError extends Error`
  - `git(cwd: string, args: readonly string[], exec?): Promise<string>` — trimmed stdout; throws `GitError` on non-zero exit
  - `headSha(cwd, exec?)`, `currentBranch(cwd, exec?)`
  - `createWorktree(repo: string, dir: string, branch: string, base: string, exec?): Promise<void>` — `git worktree add -B <branch> <dir> <base>`; idempotent when the worktree already exists on that branch
  - `removeWorktree(repo, dir, exec?)`: `git worktree remove --force`, then `git worktree prune`; no error if absent
  - `commitAll(dir, message, exec?): Promise<string | null>` — stages everything, returns the new sha or `null` when nothing changed; author/committer fixed to `teams-ai <teams-ai@localhost>`
  - `changedFiles(dir, base, exec?): Promise<string[]>` — `git diff --name-only <base>...HEAD`
  - `rebaseOnto(dir, base, exec?): Promise<{ ok: true } | { ok: false; conflicts: string[] }>` — on conflict lists unmerged files then `git rebase --abort`
  - `push(dir, branch, exec?): Promise<void>` — `git push --force-with-lease origin <branch>`
  - `fetch(repo, exec?)`
  - `GIT_IDENTITY: Record<string, string>` — the env used for commits

- [ ] **Step 1: Write the failing test**

`test/git/git.test.ts`:
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_COMMIT_EXCLUDES,
  GitError,
  changedFiles,
  commitAll,
  createWorktree,
  fetch,
  git,
  headSha,
  push,
  rebaseOnto,
  remoteMainSha,
  removeWorktree,
} from '../../server/git/git.js';

let root: string;
let origin: string;
let repo: string;

async function write(dir: string, file: string, text: string) {
  await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await fs.writeFile(path.join(dir, file), text);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-git-'));
  origin = path.join(root, 'origin.git');
  repo = path.join(root, 'repo');
  await git(root, ['init', '--bare', '-b', 'main', origin]);
  await git(root, ['clone', '-q', origin, repo]);
  await git(repo, ['checkout', '-q', '-b', 'main']);
  await write(repo, 'README.md', 'hello\n');
  await commitAll(repo, 'chore: init');
  await push(repo, 'main');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('commitAll', () => {
  it('commits with the fixed identity and returns the sha; returns null when clean', async () => {
    await write(repo, 'a.txt', 'a');
    const sha = await commitAll(repo, 'feat: a');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(repo, ['log', '-1', '--format=%an <%ae> %s'])).toBe('teams-ai <teams-ai@localhost> feat: a');
    expect(await commitAll(repo, 'nothing')).toBeNull();
  });

  it('never stages secrets, dependency trees or gate reports', async () => {
    await write(repo, '.env', 'SECRET=1');
    await write(repo, '.env.local', 'SECRET=2');
    await write(repo, 'node_modules/x/index.js', '');
    await write(repo, 'reports/junit.xml', '<testsuite/>');
    await write(repo, 'src/ok.ts', 'ok');
    const sha = await commitAll(repo, 'feat: ok', { exclude: [...DEFAULT_COMMIT_EXCLUDES, 'reports/junit.xml'] });
    expect(sha).not.toBeNull();
    expect((await git(repo, ['show', '--name-only', '--format=', 'HEAD'])).split('\n')).toEqual(['src/ok.ts']);
  });
});

describe('worktrees', () => {
  it('creates a worktree on a new branch from main and removes it', async () => {
    const wt = path.join(root, 'wt-T1');
    await createWorktree(repo, wt, 'task/spec-001-T1-a', 'main');
    expect(await git(wt, ['branch', '--show-current'])).toBe('task/spec-001-T1-a');
    expect(await headSha(wt)).toBe(await headSha(repo));
    await createWorktree(repo, wt, 'task/spec-001-T1-a', 'main'); // idempotent
    await removeWorktree(repo, wt);
    await removeWorktree(repo, wt); // no error when absent
    await expect(fs.access(wt)).rejects.toThrow();
  });

  it('recreates a worktree whose directory vanished (stale registration)', async () => {
    const wt = path.join(root, 'wt-gone');
    await createWorktree(repo, wt, 'task/gone', 'main');
    await fs.rm(wt, { recursive: true, force: true });
    await createWorktree(repo, wt, 'task/gone', 'main');
    expect(await git(wt, ['branch', '--show-current'])).toBe('task/gone');
  });
});

describe('changedFiles and rebase', () => {
  it('lists files changed since the base and rebases cleanly when main moved elsewhere', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    await write(wt, 'src/a.ts', 'a');
    await commitAll(wt, 'feat: a');
    expect(await changedFiles(wt, 'main')).toEqual(['src/a.ts']);
    await write(repo, 'src/b.ts', 'b');
    await commitAll(repo, 'feat: b');
    const result = await rebaseOnto(wt, 'main');
    expect(result).toEqual({ ok: true, baseSha: await headSha(repo) });
    expect(await changedFiles(wt, 'main')).toEqual(['src/a.ts']);
    expect(await git(wt, ['log', '--format=%s', 'main..HEAD'])).toBe('feat: a');
  });

  it('aborts on conflict, leaves the worktree clean and lists the conflicting files', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    await write(wt, 'README.md', 'from task\n');
    await commitAll(wt, 'docs: task');
    await write(repo, 'README.md', 'from main\n');
    await commitAll(repo, 'docs: main');
    const result = await rebaseOnto(wt, 'main');
    expect(result).toEqual({ ok: false, conflicts: ['README.md'] });
    expect(await git(wt, ['status', '--porcelain'])).toBe('');
    expect(await fs.readFile(path.join(wt, 'README.md'), 'utf8')).toBe('from task\n');
  });

  it('throws GitError (infra) when the rebase fails for a reason that is not a conflict', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/x', 'main');
    await write(wt, 'src/a.ts', 'a');
    await commitAll(wt, 'feat: a');
    await write(repo, 'reports/junit.xml', 'tracked-on-main');
    await commitAll(repo, 'chore: track report', { exclude: [] });
    await write(wt, 'reports/junit.xml', 'untracked-in-worktree'); // would be overwritten by the rebase
    await expect(rebaseOnto(wt, 'main')).rejects.toThrow(GitError);
  });
});

describe('push, fetch and remote main', () => {
  it('pushes a branch to origin with force-with-lease and fetch sees it', async () => {
    const wt = path.join(root, 'wt');
    await createWorktree(repo, wt, 'task/y', 'main');
    await write(wt, 'y.txt', 'y');
    const sha = await commitAll(wt, 'feat: y');
    await push(wt, 'task/y');
    expect(await git(origin, ['rev-parse', 'task/y'])).toBe(sha);
    await fetch(repo);
    expect(await git(repo, ['rev-parse', 'origin/task/y'])).toBe(sha);
  });

  it('reads the remote main sha', async () => {
    expect(await remoteMainSha(repo)).toBe(await headSha(repo));
    await write(repo, 'z.txt', 'z');
    const local = await commitAll(repo, 'feat: z');
    expect(await remoteMainSha(repo)).not.toBe(local);
    await push(repo, 'main');
    expect(await remoteMainSha(repo)).toBe(local);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/git/git.test.ts`
Expected: FAIL — cannot resolve `../../server/git/git.js`.

- [ ] **Step 3: Write the git controller**

`server/git/git.ts`:
```ts
import { realpathSync } from 'node:fs';
import { execCommand, type Exec } from '../exec/command.js';

export class GitError extends Error {}

/** Commits made by the orchestrator carry a fixed identity (agents never commit). */
export const GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'teams-ai',
  GIT_AUTHOR_EMAIL: 'teams-ai@localhost',
  GIT_COMMITTER_NAME: 'teams-ai',
  GIT_COMMITTER_EMAIL: 'teams-ai@localhost',
  GIT_TERMINAL_PROMPT: '0',
  // The orchestrator never rewrites line endings; agents own file content.
  GIT_CONFIG_PARAMETERS: "'core.autocrlf=false'",
};

/**
 * Repository content that must never reach a commit: secrets, dependency trees and gate artifacts.
 * The caller adds the plan's junitPath. Pathspecs use the exclude magic so `add -A` stays otherwise complete.
 */
export const DEFAULT_COMMIT_EXCLUDES: readonly string[] = ['.env', '.env.*', '**/.env', '**/.env.*', 'node_modules', '**/node_modules', 'reports/junit.xml'];

/** Hardening applied to every git command: hooks and fsmonitor from a (possibly agent-written) config never execute. */
const SAFE_CONFIG = ['-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false'];

const TIMEOUT = 120_000;

/** Canonical form for comparing paths git prints (long, forward slashes) with paths we were given. */
function canonical(p: string): string {
  let real = p;
  try {
    real = realpathSync.native(p); // expands Windows 8.3 short names too
  } catch {
    /* not created yet */
  }
  const s = real.replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

async function run(cwd: string, args: readonly string[], exec: Exec) {
  return exec({ bin: 'git', args: [...SAFE_CONFIG, ...args], cwd, env: GIT_IDENTITY, timeoutMs: TIMEOUT });
}

export async function git(cwd: string, args: readonly string[], exec: Exec = execCommand): Promise<string> {
  const r = await run(cwd, args, exec);
  if (r.exitCode !== 0) throw new GitError(`git ${args.join(' ')} failed (${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout.trim();
}

export const headSha = (cwd: string, exec: Exec = execCommand) => git(cwd, ['rev-parse', 'HEAD'], exec);
export const currentBranch = (cwd: string, exec: Exec = execCommand) => git(cwd, ['branch', '--show-current'], exec);

export async function createWorktree(repo: string, dir: string, branch: string, base: string, exec: Exec = execCommand): Promise<void> {
  // Drop registrations whose directory vanished (crash, manual cleanup) before deciding anything.
  await git(repo, ['worktree', 'prune'], exec);
  const list = await git(repo, ['worktree', 'list', '--porcelain'], exec);
  const wanted = canonical(dir);
  const listed = list.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => canonical(l.slice(9)));
  if (listed.includes(wanted)) {
    if ((await currentBranch(dir, exec)) === branch) return;
    throw new GitError(`worktree ${dir} exists on another branch`);
  }
  await git(repo, ['worktree', 'add', '-B', branch, dir, base], exec);
}

export async function removeWorktree(repo: string, dir: string, exec: Exec = execCommand): Promise<void> {
  const r = await run(repo, ['worktree', 'remove', '--force', dir], exec);
  if (r.exitCode !== 0 && !/is not a working tree|No such file|does not exist/i.test(r.stderr)) {
    throw new GitError(`git worktree remove failed: ${r.stderr.trim()}`);
  }
  await git(repo, ['worktree', 'prune'], exec);
}

export async function commitAll(
  dir: string,
  message: string,
  opts: { exclude?: readonly string[] } = {},
  exec: Exec = execCommand,
): Promise<string | null> {
  const exclude = opts.exclude ?? DEFAULT_COMMIT_EXCLUDES;
  await git(dir, ['add', '-A', '--', '.', ...exclude.map((p) => `:(exclude,glob)${p}`)], exec);
  const staged = await run(dir, ['diff', '--cached', '--quiet'], exec);
  if (staged.exitCode === 0) return null;
  await git(dir, ['commit', '-q', '-m', message], exec);
  return headSha(dir, exec);
}

export async function changedFiles(dir: string, base: string, exec: Exec = execCommand): Promise<string[]> {
  const out = await git(dir, ['diff', '--name-only', `${base}...HEAD`], exec);
  return out === '' ? [] : out.split('\n');
}

/**
 * Rebases the worktree onto `base`. Conflicts abort the rebase and are returned as `ok: false`
 * with the files; any other failure (untracked files in the way, a rebase already in progress,
 * a failed abort) is infrastructure and throws GitError, so the Dev is not charged an attempt.
 */
export async function rebaseOnto(
  dir: string,
  base: string,
  exec: Exec = execCommand,
): Promise<{ ok: true; baseSha: string } | { ok: false; conflicts: string[] }> {
  const baseSha = await git(dir, ['rev-parse', base], exec);
  const r = await run(dir, ['rebase', base], exec);
  if (r.exitCode === 0) return { ok: true, baseSha };
  const unmerged = await git(dir, ['diff', '--name-only', '--diff-filter=U'], exec).catch(() => '');
  const conflicts = unmerged === '' ? [] : unmerged.split('\n');
  const abort = await run(dir, ['rebase', '--abort'], exec);
  if (conflicts.length === 0) {
    throw new GitError(`git rebase ${base} failed without conflicts: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  if (abort.exitCode !== 0) throw new GitError(`git rebase --abort failed: ${abort.stderr.trim()}`);
  return { ok: false, conflicts };
}

export async function push(dir: string, branch: string, exec: Exec = execCommand): Promise<void> {
  await git(dir, ['push', '-q', '--force-with-lease', '-u', 'origin', branch], exec);
}

export async function fetch(repo: string, exec: Exec = execCommand): Promise<void> {
  await git(repo, ['fetch', '-q', '--prune', 'origin'], exec);
}

/** The sha of `main` on the remote right now — compared with the rebase base before merging. */
export async function remoteMainSha(repo: string, exec: Exec = execCommand, branch = 'main'): Promise<string> {
  const out = await git(repo, ['ls-remote', 'origin', `refs/heads/${branch}`], exec);
  const sha = out.split(/\s+/)[0];
  if (!sha) throw new GitError(`origin has no branch ${branch}`);
  return sha;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/git/git.test.ts && npm run typecheck`
Expected: 8 tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/git/git.ts test/git/git.test.ts
git commit -m "feat: add git controller with worktrees, rebase and push" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: GitHub wrapper and merge queue

**Files:**
- Create: `server/git/github.ts`, `server/git/merge-queue.ts`
- Test: `test/git/github.test.ts`, `test/git/merge-queue.test.ts`

**Interfaces:**
- `github.ts` (all take `exec`):
  - `class GitHubError extends Error`
  - `ensureRepo({ owner?: string; name: string; private: boolean; cwd: string }, exec): Promise<{ fullName: string; url: string; created: boolean }>` — `gh repo view` first, `gh repo create` only when missing
  - `ensurePr({ cwd; head; base; title; body }, exec): Promise<{ number: number; url: string; created: boolean }>` — `gh pr list --head <head> --base <base> --state open --json number,url` first
  - `prState({ cwd; number }, exec): Promise<{ state: 'OPEN' | 'MERGED' | 'CLOSED'; headSha: string }>`
  - `mergePr({ cwd; number; headSha }, exec): Promise<{ merged: boolean; already: boolean; reason?: string }>` — `--squash --match-head-commit <sha>`; a mismatch is reported, never forced
- `merge-queue.ts`:
  - `type MergeStage = 'rebase' | 'gates' | 'push' | 'pr' | 'merge'`
  - `interface MergeSteps { rebase(): Promise<{ ok: boolean; conflicts?: string[] }>; gates(): Promise<{ ok: boolean; detail?: string }>; push(): Promise<void>; ensurePr(): Promise<{ number: number }>; merge(number: number): Promise<{ merged: boolean; reason?: string }>; afterMerge?(): Promise<void> }`
  - `type MergeOutcome = { ok: true; pr: number } | { ok: false; stage: MergeStage; conflicts?: string[]; detail?: string }`
  - `class MergeQueue { enqueue(taskId: string, steps: MergeSteps): Promise<MergeOutcome>; get holder(): string | null; get waiting(): readonly string[] }` — one task at a time, FIFO; a thrown step error is reported as that stage's failure

- [ ] **Step 1: Write the failing github test**

`test/git/github.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { GitHubError, ensurePr, ensureRepo, findMergedPr, mergePr, prState } from '../../server/git/github.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const cwd = '/home/u/ws/repo';

describe('ensureRepo', () => {
  it('returns the existing repository and makes sure origin and main exist on it', async () => {
    const fake = new FakeExec()
      .onArgs('gh', ['repo', 'view'], () => ({ stdout: '{"nameWithOwner":"acme/todo-api","url":"https://github.com/acme/todo-api"}' }))
      .onArgs('git', ['remote', 'get-url'], () => ({ stdout: 'https://github.com/acme/todo-api.git' }))
      .onArgs('git', ['ls-remote'], () => ({ stdout: 'abc\trefs/heads/main' }));
    const r = await ensureRepo({ owner: 'acme', name: 'todo-api', private: true, cwd }, fake.exec);
    expect(r).toEqual({ fullName: 'acme/todo-api', url: 'https://github.com/acme/todo-api', created: false });
    expect(fake.lines('gh').some((l) => l.startsWith('repo create'))).toBe(false);
    expect(fake.lines('git').some((l) => l.startsWith('push'))).toBe(false);
  });

  it('reconciles a half-created repository: adds origin and pushes main when missing', async () => {
    const fake = new FakeExec()
      .onArgs('gh', ['repo', 'view'], () => ({ stdout: '{"nameWithOwner":"acme/todo-api","url":"https://github.com/acme/todo-api"}' }))
      .onArgs('git', ['remote', 'get-url'], () => ({ exitCode: 2, stderr: 'error: No such remote' }))
      .onArgs('git', ['ls-remote'], () => ({ stdout: '' }));
    await ensureRepo({ owner: 'acme', name: 'todo-api', private: true, cwd }, fake.exec);
    expect(fake.lines('git')).toEqual(expect.arrayContaining(['remote add origin https://github.com/acme/todo-api.git', 'push -u origin main']));
  });

  it('creates a private repository only when GitHub says it does not exist', async () => {
    const fake = new FakeExec()
      .onArgs('gh', ['repo', 'view'], () => ({ exitCode: 1, stderr: 'GraphQL: Could not resolve to a Repository with the name' }))
      .onArgs('gh', ['repo', 'create'], () => ({ stdout: 'https://github.com/acme/todo-api\n' }));
    const r = await ensureRepo({ owner: 'acme', name: 'todo-api', private: true, cwd }, fake.exec);
    expect(r).toEqual({ fullName: 'acme/todo-api', url: 'https://github.com/acme/todo-api', created: true });
    expect(fake.lines('gh')[1]).toBe('repo create acme/todo-api --private --source . --remote origin --push');
  });

  it('does not create when repo view fails for another reason', async () => {
    const fake = new FakeExec().onArgs('gh', ['repo', 'view'], () => ({ exitCode: 1, stderr: 'HTTP 401: Bad credentials' }));
    await expect(ensureRepo({ owner: 'acme', name: 'todo-api', private: true, cwd }, fake.exec)).rejects.toThrow(GitHubError);
    expect(fake.lines('gh').some((l) => l.startsWith('repo create'))).toBe(false);
  });

  it('uses the authenticated user when no owner is given', async () => {
    const fake = new FakeExec()
      .onArgs('gh', ['api', 'user'], () => ({ stdout: '{"login":"me"}' }))
      .onArgs('gh', ['repo', 'view'], () => ({ stdout: '{"nameWithOwner":"me/todo-api","url":"u"}' }))
      .onArgs('git', ['remote', 'get-url'], () => ({ stdout: 'u.git' }))
      .onArgs('git', ['ls-remote'], () => ({ stdout: 'abc\trefs/heads/main' }));
    const r = await ensureRepo({ name: 'todo-api', private: true, cwd }, fake.exec);
    expect(r.fullName).toBe('me/todo-api');
  });
});

describe('ensurePr and findMergedPr', () => {
  const input = { cwd, head: 'task/spec-001-T1-a', base: 'main', title: 'T1', body: 'body' };

  it('reuses an open PR for the head branch', async () => {
    const fake = new FakeExec().onArgs('gh', ['pr', 'list'], () => ({ stdout: '[{"number":45,"url":"https://github.com/acme/todo-api/pull/45"}]' }));
    expect(await ensurePr(input, fake.exec)).toEqual({ number: 45, url: 'https://github.com/acme/todo-api/pull/45', created: false });
    expect(fake.lines('gh')).toHaveLength(1);
  });

  it('creates the PR with the body on stdin when none is open', async () => {
    const fake = new FakeExec()
      .onArgs('gh', ['pr', 'list'], () => ({ stdout: '[]' }))
      .onArgs('gh', ['pr', 'create'], () => ({ stdout: 'https://github.com/acme/todo-api/pull/46\n' }));
    const r = await ensurePr(input, fake.exec);
    expect(r).toEqual({ number: 46, url: 'https://github.com/acme/todo-api/pull/46', created: true });
    const create = fake.calls.find((c) => c.args[1] === 'create')!;
    expect(create.args).toEqual(['pr', 'create', '--head', input.head, '--base', 'main', '--title', 'T1', '--body-file', '-']);
    expect(create.stdin).toBe('body');
  });

  it('rejects an unparseable PR url instead of returning NaN', async () => {
    const fake = new FakeExec().onArgs('gh', ['pr', 'list'], () => ({ stdout: '[]' })).onArgs('gh', ['pr', 'create'], () => ({ stdout: 'Warning: something\n' }));
    await expect(ensurePr(input, fake.exec)).rejects.toThrow(/PR number/);
  });

  it('throws when gh fails', async () => {
    const fake = new FakeExec().onArgs('gh', ['pr', 'list'], () => ({ exitCode: 1, stderr: 'not logged in' }));
    await expect(ensurePr(input, fake.exec)).rejects.toThrow(GitHubError);
  });

  it('finds a merged PR for the head branch', async () => {
    const fake = new FakeExec().onArgs('gh', ['pr', 'list'], () => ({ stdout: '[{"number":44,"state":"MERGED"},{"number":45,"state":"CLOSED"}]' }));
    expect(await findMergedPr({ cwd, head: input.head, base: 'main' }, fake.exec)).toBe(44);
    expect(fake.lines('gh')[0]).toContain('--state all');
    const none = new FakeExec().onArgs('gh', ['pr', 'list'], () => ({ stdout: '[{"number":45,"state":"CLOSED"}]' }));
    expect(await findMergedPr({ cwd, head: input.head, base: 'main' }, none.exec)).toBeNull();
  });
});

describe('prState and mergePr', () => {
  it('reads the PR state and head sha', async () => {
    const fake = new FakeExec().onArgs('gh', ['pr', 'view'], () => ({ stdout: '{"state":"OPEN","headRefOid":"abc"}' }));
    expect(await prState({ cwd, number: 45 }, fake.exec)).toEqual({ state: 'OPEN', headSha: 'abc' });
  });

  it('merges with squash and the head commit guard', async () => {
    const fake = new FakeExec()
      .onArgs('gh', ['pr', 'view'], () => ({ stdout: '{"state":"OPEN","headRefOid":"abc"}' }))
      .onArgs('gh', ['pr', 'merge'], () => ({ stdout: '' }));
    expect(await mergePr({ cwd, number: 45, headSha: 'abc' }, fake.exec)).toEqual({ merged: true, already: false });
    expect(fake.lines('gh')[1]).toBe('pr merge 45 --squash --match-head-commit abc');
  });

  it('reports an already merged PR without calling merge', async () => {
    const fake = new FakeExec().onArgs('gh', ['pr', 'view'], () => ({ stdout: '{"state":"MERGED","headRefOid":"abc"}' }));
    expect(await mergePr({ cwd, number: 45, headSha: 'abc' }, fake.exec)).toEqual({ merged: true, already: true });
    expect(fake.lines('gh')).toHaveLength(1);
  });

  it('refuses when the head moved and reports the reason', async () => {
    const fake = new FakeExec()
      .onArgs('gh', ['pr', 'view'], () => ({ stdout: '{"state":"OPEN","headRefOid":"def"}' }))
      .onArgs('gh', ['pr', 'merge'], () => ({ exitCode: 1, stderr: 'head commit mismatch' }));
    const r = await mergePr({ cwd, number: 45, headSha: 'abc' }, fake.exec);
    expect(r.merged).toBe(false);
    expect(r.reason).toMatch(/head/);
    expect(fake.lines('gh')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/git/github.test.ts`
Expected: FAIL — cannot resolve `../../server/git/github.js`.

- [ ] **Step 3: Write the GitHub wrapper**

`server/git/github.ts`:
```ts
import type { Exec } from '../exec/command.js';

export class GitHubError extends Error {}

const TIMEOUT = 120_000;

async function gh(cwd: string, args: readonly string[], exec: Exec, stdin?: string) {
  return exec({ bin: 'gh', args, cwd, timeoutMs: TIMEOUT, stdin, env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } });
}

async function ghJson<T>(cwd: string, args: readonly string[], exec: Exec): Promise<T> {
  const r = await gh(cwd, args, exec);
  if (r.exitCode !== 0) throw new GitHubError(`gh ${args.join(' ')} failed (${r.exitCode}): ${r.stderr.trim()}`);
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new GitHubError(`gh ${args.join(' ')} returned invalid JSON`);
  }
}

function prNumber(url: string): number {
  const n = Number(url.trim().match(/\/pull\/(\d+)/)?.[1]);
  if (!Number.isInteger(n) || n < 1) throw new GitHubError(`could not read the PR number from gh output: ${url.trim().slice(0, 200)}`);
  return n;
}

const NOT_FOUND = /Could not resolve to a Repository|HTTP 404/i;

/**
 * Idempotent repository bootstrap (spec §7.4). A half-finished `gh repo create --push` (remote
 * created, origin missing or main never pushed) is reconciled instead of reported as "exists".
 */
export async function ensureRepo(
  input: { owner?: string; name: string; private: boolean; cwd: string },
  exec: Exec,
): Promise<{ fullName: string; url: string; created: boolean }> {
  const owner = input.owner ?? (await ghJson<{ login: string }>(input.cwd, ['api', 'user'], exec)).login;
  const fullName = `${owner}/${input.name}`;
  const view = await gh(input.cwd, ['repo', 'view', fullName, '--json', 'nameWithOwner,url'], exec);
  if (view.exitCode === 0) {
    const json = JSON.parse(view.stdout) as { nameWithOwner: string; url: string };
    await reconcileRemote(input.cwd, json.url, exec);
    return { fullName: json.nameWithOwner, url: json.url, created: false };
  }
  if (!NOT_FOUND.test(view.stderr)) throw new GitHubError(`gh repo view failed: ${view.stderr.trim()}`);
  const create = await gh(input.cwd, ['repo', 'create', fullName, input.private ? '--private' : '--public', '--source', '.', '--remote', 'origin', '--push'], exec);
  if (create.exitCode !== 0) throw new GitHubError(`gh repo create failed: ${create.stderr.trim()}`);
  return { fullName, url: create.stdout.trim(), created: true };
}

async function reconcileRemote(cwd: string, url: string, exec: Exec): Promise<void> {
  const git = (args: string[]) => exec({ bin: 'git', args, cwd, timeoutMs: TIMEOUT, env: { GIT_TERMINAL_PROMPT: '0' } });
  const remote = await git(['remote', 'get-url', 'origin']);
  if (remote.exitCode !== 0) {
    const add = await git(['remote', 'add', 'origin', `${url}.git`]);
    if (add.exitCode !== 0) throw new GitHubError(`git remote add origin failed: ${add.stderr.trim()}`);
  }
  const main = await git(['ls-remote', 'origin', 'refs/heads/main']);
  if (main.exitCode !== 0) throw new GitHubError(`git ls-remote failed: ${main.stderr.trim()}`);
  if (main.stdout.trim() === '') {
    const push = await git(['push', '-u', 'origin', 'main']);
    if (push.exitCode !== 0) throw new GitHubError(`git push main failed: ${push.stderr.trim()}`);
  }
}

export async function ensurePr(
  input: { cwd: string; head: string; base: string; title: string; body: string },
  exec: Exec,
): Promise<{ number: number; url: string; created: boolean }> {
  const open = await ghJson<Array<{ number: number; url: string }>>(
    input.cwd,
    ['pr', 'list', '--head', input.head, '--base', input.base, '--state', 'open', '--json', 'number,url'],
    exec,
  );
  if (open[0]) return { number: open[0].number, url: open[0].url, created: false };
  const create = await gh(input.cwd, ['pr', 'create', '--head', input.head, '--base', input.base, '--title', input.title, '--body-file', '-'], exec, input.body);
  if (create.exitCode !== 0) throw new GitHubError(`gh pr create failed: ${create.stderr.trim()}`);
  const url = create.stdout.trim().split('\n').pop() ?? '';
  return { number: prNumber(url), url, created: true };
}

/** A PR for this head branch that already merged — the merge queue short-circuits on it (crash between merge and confirm). */
export async function findMergedPr(input: { cwd: string; head: string; base: string }, exec: Exec): Promise<number | null> {
  const all = await ghJson<Array<{ number: number; state: string }>>(
    input.cwd,
    ['pr', 'list', '--head', input.head, '--base', input.base, '--state', 'all', '--json', 'number,state'],
    exec,
  );
  return all.find((p) => p.state === 'MERGED')?.number ?? null;
}

export async function prState(input: { cwd: string; number: number }, exec: Exec): Promise<{ state: 'OPEN' | 'MERGED' | 'CLOSED'; headSha: string }> {
  const json = await ghJson<{ state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefOid: string }>(input.cwd, ['pr', 'view', String(input.number), '--json', 'state,headRefOid'], exec);
  return { state: json.state, headSha: json.headRefOid };
}

/** Squash-merge guarded by the head commit the gates ran on; never forces (spec §6 step 5, §7.4). */
export async function mergePr(input: { cwd: string; number: number; headSha: string }, exec: Exec): Promise<{ merged: boolean; already: boolean; reason?: string }> {
  const state = await prState(input, exec);
  if (state.state === 'MERGED') return { merged: true, already: true };
  if (state.state === 'CLOSED') return { merged: false, already: false, reason: 'PR is closed' };
  if (state.headSha !== input.headSha) return { merged: false, already: false, reason: `head moved: expected ${input.headSha}, found ${state.headSha}` };
  const r = await gh(input.cwd, ['pr', 'merge', String(input.number), '--squash', '--match-head-commit', input.headSha], exec);
  if (r.exitCode !== 0) return { merged: false, already: false, reason: r.stderr.trim() || 'merge failed' };
  return { merged: true, already: false };
}
```

- [ ] **Step 4: Run the github test**

Run: `npx vitest run test/git/github.test.ts`
Expected: 14 tests PASS.

- [ ] **Step 5: Write the failing merge-queue test**

`test/git/merge-queue.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { MergeQueue, type MergeSteps } from '../../server/git/merge-queue.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function steps(over: Partial<MergeSteps> = {}, log: string[] = [], tag = ''): MergeSteps {
  return {
    alreadyMerged: async () => (log.push(`${tag}check`), null),
    rebase: async () => (log.push(`${tag}rebase`), { ok: true, baseSha: 'main1' }),
    gates: async () => (log.push(`${tag}gates`), { ok: true }),
    push: async () => void log.push(`${tag}push`),
    ensurePr: async () => (log.push(`${tag}pr`), { number: 7 }),
    remoteMainSha: async () => (log.push(`${tag}main`), 'main1'),
    merge: async () => (log.push(`${tag}merge`), { merged: true }),
    afterMerge: async () => void log.push(`${tag}after`),
    ...over,
  };
}

describe('MergeQueue', () => {
  it('runs the stages in order and returns the PR number', async () => {
    const log: string[] = [];
    const q = new MergeQueue();
    expect(await q.enqueue('T1', steps({}, log))).toEqual({ ok: true, pr: 7 });
    expect(log).toEqual(['check', 'rebase', 'gates', 'push', 'pr', 'main', 'merge', 'after']);
    expect(q.holder).toBeNull();
  });

  it('short-circuits when the PR was already merged (crash between merge and confirm)', async () => {
    const log: string[] = [];
    const q = new MergeQueue();
    expect(await q.enqueue('T1', steps({ alreadyMerged: async () => 12 }, log))).toEqual({ ok: true, pr: 12, already: true });
    expect(log).toEqual([]);
  });

  it('serializes tasks: the second waits for the first to finish', async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const q = new MergeQueue();
    const first = q.enqueue('T1', steps({ gates: async () => (await gate, log.push('a:gates'), { ok: true }) }, log, 'a:'));
    await flush();
    const second = q.enqueue('T2', steps({}, log, 'b:'));
    await flush();
    expect(q.holder).toBe('T1');
    expect(q.waiting).toEqual(['T2']);
    expect(log.some((l) => l.startsWith('b:'))).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(log.indexOf('b:rebase')).toBeGreaterThan(log.indexOf('a:after'));
  });

  it('returns the same promise when a task is enqueued twice', async () => {
    const q = new MergeQueue();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const log: string[] = [];
    const a = q.enqueue('T1', steps({ gates: async () => (await gate, { ok: true }) }, log));
    const b = q.enqueue('T1', steps({}, log));
    expect(b).toBe(a);
    release();
    await a;
    expect(log.filter((l) => l === 'merge')).toHaveLength(1);
  });

  it('stops at a rebase conflict and reports the files', async () => {
    const log: string[] = [];
    const q = new MergeQueue();
    const r = await q.enqueue('T1', steps({ rebase: async () => ({ ok: false, conflicts: ['src/a.ts'] }) }, log));
    expect(r).toEqual({ ok: false, stage: 'rebase', conflicts: ['src/a.ts'] });
    expect(log).toEqual(['check']);
  });

  it('stops when the gates fail after the rebase', async () => {
    const q = new MergeQueue();
    const r = await q.enqueue('T1', steps({ gates: async () => ({ ok: false, detail: 'unit-test failed' }) }));
    expect(r).toEqual({ ok: false, stage: 'gates', detail: 'unit-test failed' });
  });

  it('refuses to merge when main moved after the rebase, without calling merge', async () => {
    const log: string[] = [];
    const q = new MergeQueue();
    const r = await q.enqueue('T1', steps({ remoteMainSha: async () => 'main2' }, log));
    expect(r).toEqual({ ok: false, stage: 'merge', detail: 'main moved: rebased on main1, remote is main2' });
    expect(log).not.toContain('merge');
  });

  it('reports a refused merge (head moved) without forcing and releases the lock', async () => {
    const q = new MergeQueue();
    const r = await q.enqueue('T1', steps({ merge: async () => ({ merged: false, reason: 'head moved' }) }));
    expect(r).toEqual({ ok: false, stage: 'merge', detail: 'head moved' });
    expect(q.holder).toBeNull();
  });

  it('keeps a merged PR as success when afterMerge fails, carrying a warning', async () => {
    const q = new MergeQueue();
    const r = await q.enqueue('T1', steps({ afterMerge: async () => { throw new Error('graphify failed'); } }));
    expect(r).toEqual({ ok: true, pr: 7, warning: 'afterMerge: graphify failed' });
  });

  it('turns a thrown step into that stage failure and keeps serving the queue', async () => {
    const q = new MergeQueue();
    const r = await q.enqueue('T1', steps({ push: async () => { throw new Error('remote hung up'); } }));
    expect(r).toEqual({ ok: false, stage: 'push', detail: 'remote hung up' });
    expect(await q.enqueue('T2', steps())).toEqual({ ok: true, pr: 7 });
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/git/merge-queue.test.ts`
Expected: FAIL — cannot resolve `../../server/git/merge-queue.js`.

- [ ] **Step 7: Write the merge queue**

`server/git/merge-queue.ts`:
```ts
export type MergeStage = 'rebase' | 'gates' | 'push' | 'pr' | 'merge';

export interface MergeSteps {
  /** PR number if this branch already merged (crash between merge and confirm); the queue then does nothing. */
  alreadyMerged(): Promise<number | null>;
  /** Rebase onto the current main; `baseSha` is the main commit the branch now sits on. */
  rebase(): Promise<{ ok: boolean; conflicts?: string[]; baseSha?: string }>;
  gates(): Promise<{ ok: boolean; detail?: string }>;
  push(): Promise<void>;
  ensurePr(): Promise<{ number: number }>;
  /** Sha of main on the remote right before merging; must equal `baseSha` or the merge is refused. */
  remoteMainSha(): Promise<string>;
  merge(number: number): Promise<{ merged: boolean; reason?: string }>;
  afterMerge?(): Promise<void>;
}

export type MergeOutcome =
  | { ok: true; pr: number; already?: true; warning?: string }
  | { ok: false; stage: MergeStage; conflicts?: string[]; detail?: string };

/**
 * Only the orchestrator writes `main`, one task at a time (spec §6 step 5): rebase on the current
 * main, re-run the gates, push, ensure the PR, check main did not move, merge guarded by the head
 * commit. `--match-head-commit` only pins the PR head, so the main check is what guarantees that
 * the combination that merges is the one the gates ran on.
 */
export class MergeQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private current: string | null = null;
  private readonly pending: string[] = [];
  private readonly inflight = new Map<string, Promise<MergeOutcome>>();

  get holder(): string | null {
    return this.current;
  }

  get waiting(): readonly string[] {
    return [...this.pending];
  }

  enqueue(taskId: string, steps: MergeSteps): Promise<MergeOutcome> {
    const existing = this.inflight.get(taskId);
    if (existing) return existing;
    this.pending.push(taskId);
    const run = async () => {
      this.pending.splice(this.pending.indexOf(taskId), 1);
      this.current = taskId;
      try {
        return await this.execute(steps);
      } finally {
        this.current = null;
        this.inflight.delete(taskId);
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    this.inflight.set(taskId, result);
    return result;
  }

  private async execute(steps: MergeSteps): Promise<MergeOutcome> {
    let stage: MergeStage = 'rebase';
    try {
      const merged = await steps.alreadyMerged();
      if (merged !== null) return { ok: true, pr: merged, already: true };
      const rebase = await steps.rebase();
      if (!rebase.ok) return { ok: false, stage, conflicts: rebase.conflicts ?? [] };
      stage = 'gates';
      const gates = await steps.gates();
      if (!gates.ok) return { ok: false, stage, detail: gates.detail };
      stage = 'push';
      await steps.push();
      stage = 'pr';
      const pr = await steps.ensurePr();
      stage = 'merge';
      const remote = await steps.remoteMainSha();
      if (rebase.baseSha !== undefined && remote !== rebase.baseSha) {
        return { ok: false, stage, detail: `main moved: rebased on ${rebase.baseSha}, remote is ${remote}` };
      }
      const merge = await steps.merge(pr.number);
      if (!merge.merged) return { ok: false, stage, detail: merge.reason };
      // The PR is in main now; a failing follow-up (graph update, cleanup) must not look like a failed merge.
      try {
        await steps.afterMerge?.();
      } catch (err) {
        return { ok: true, pr: pr.number, warning: `afterMerge: ${(err as Error).message}` };
      }
      return { ok: true, pr: pr.number };
    } catch (err) {
      return { ok: false, stage, detail: (err as Error).message };
    }
  }
}
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npx vitest run test/git && npm run typecheck`
Expected: 32 tests PASS (git 8, github 14, merge-queue 10); typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add server/git/github.ts server/git/merge-queue.ts test/git/github.test.ts test/git/merge-queue.test.ts
git commit -m "feat: add idempotent GitHub wrapper and serialized merge queue" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Deploy targets with verification and rollback

**Files:**
- Create: `server/deploy/target.ts`, `server/deploy/docker-local.ts`, `server/deploy/kind.ts`
- Test: `test/deploy/deploy.test.ts`

**Interfaces:**
- `target.ts`:
  - `interface DeploymentIntent { projectId: string; image: string; tag: string; port: number; healthcheckPath: string; manifests: string[]; secretNames: string[]; contextDir: string }`
  - `interface DeployTarget { readonly name: 'docker-local' | 'kind'; validate(intent): Promise<string[]>; build(intent): Promise<void>; apply(intent): Promise<{ previous: string | null }>; verify(intent): Promise<{ healthy: boolean; detail: string }>; rollback(intent, previous: string): Promise<void>; destroy(intent): Promise<void> }`
  - `type DeployResult = { ok: true; previous: string | null } | { ok: false; stage: 'validate' | 'build' | 'apply' | 'verify' | 'smoke'; detail: string; rolledBack: boolean; rollbackHealthy: boolean | null }`
  - `runDeployment(target, intent, deps: { smoke: (baseUrl: string) => Promise<{ ok: boolean; detail: string }> }): Promise<DeployResult>` — validate → build → apply → verify → smoke; any failure after `apply` rolls back to `previous` (when there is one) and re-verifies
  - `type HttpGet = (url: string, timeoutMs: number) => Promise<{ status: number } | null>`, `httpGet: HttpGet` (global fetch), `waitHealthy(url, get, { timeoutMs, intervalMs })`
- `docker-local.ts`: `class DockerLocalTarget implements DeployTarget { constructor(deps: { exec: Exec; get: HttpGet; secrets: Record<string, string>; clock?: () => number }) }` — container name `teams-ai-<projectId>`, `previous` = image of the running container (`docker inspect --format {{.Config.Image}}`), `baseUrl(intent) = http://127.0.0.1:<port>`
- `kind.ts`: `class KindTarget implements DeployTarget { constructor(deps: { exec: Exec; secrets: Record<string, string>; cluster: string; readFile; writeFile }) }` — `kind load docker-image`, manifests rendered with `{{IMAGE}}` → `image:tag` and applied with `kubectl apply -f -` on stdin, `previous` = current deployment image (`kubectl get deploy <projectId> -o jsonpath={.spec.template.spec.containers[0].image}`), verify via `kubectl rollout status` + an in-cluster `curl` job, rollback via `kubectl rollout undo`

- [ ] **Step 1: Write the failing test**

`test/deploy/deploy.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DockerLocalTarget } from '../../server/deploy/docker-local.js';
import { KindTarget } from '../../server/deploy/kind.js';
import { runDeployment, waitHealthy, type DeploymentIntent, type DeployTarget, type HttpGet } from '../../server/deploy/target.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const intent: DeploymentIntent = {
  projectId: 'todo-api',
  image: 'todo-api',
  tag: 'spec-001-abc1234',
  port: 3000,
  healthcheckPath: '/health',
  manifests: ['deploy/k8s.yaml'],
  secretNames: ['DATABASE_URL'],
  contextDir: '/home/u/ws/repo',
};
const secrets = { DATABASE_URL: 'postgres://x' };
const okGet: HttpGet = async () => ({ status: 200 });
const downGet: HttpGet = async () => null;

describe('waitHealthy', () => {
  it('polls until a 2xx arrives within the deadline', async () => {
    let calls = 0;
    const get: HttpGet = async () => (++calls < 3 ? null : { status: 200 });
    const r = await waitHealthy('http://x/health', get, { timeoutMs: 1_000, intervalMs: 1 });
    expect(r).toEqual({ healthy: true, detail: 'HTTP 200 after 3 attempts' });
  });

  it('gives up at the deadline', async () => {
    const r = await waitHealthy('http://x/health', downGet, { timeoutMs: 20, intervalMs: 5 });
    expect(r.healthy).toBe(false);
  });
});

describe('DockerLocalTarget', () => {
  it('builds, parks the old container, runs the new one bound to localhost with secrets in the environment, verifies', async () => {
    const fake = new FakeExec().onArgs('docker', ['inspect'], () => ({ stdout: 'todo-api:spec-001-old0000\n' }));
    const t = new DockerLocalTarget({ exec: fake.exec, get: okGet, secrets });
    expect(await t.validate(intent)).toEqual([]);
    await t.build(intent);
    const { previous } = await t.apply(intent);
    expect(previous).toBe('todo-api:spec-001-old0000');
    const lines = fake.lines('docker');
    expect(lines[0]).toBe('build -t todo-api:spec-001-abc1234 /home/u/ws/repo');
    expect(lines).toContain('rename teams-ai-todo-api teams-ai-todo-api-prev');
    const run = fake.calls.find((c) => c.args[0] === 'run')!;
    expect(run.args).toEqual(expect.arrayContaining(['-d', '--name', 'teams-ai-todo-api', '-p', '127.0.0.1:3000:3000', '-e', 'DATABASE_URL', 'todo-api:spec-001-abc1234']));
    expect(run.args.join(' ')).not.toContain('postgres://x');
    expect(run.env).toEqual({ DATABASE_URL: 'postgres://x' });
    expect(lines).toContain('rm -f teams-ai-todo-api-prev');
    expect(await t.verify(intent)).toMatchObject({ healthy: true });
    expect(await t.currentImage(intent)).toBe('todo-api:spec-001-old0000');
  });

  it('restores the parked container when docker run fails, then rethrows', async () => {
    const fake = new FakeExec()
      .onArgs('docker', ['inspect'], () => ({ stdout: 'todo-api:old\n' }))
      .onArgs('docker', ['run'], () => ({ exitCode: 125, stderr: 'port is already allocated' }));
    const t = new DockerLocalTarget({ exec: fake.exec, get: okGet, secrets });
    await expect(t.apply(intent)).rejects.toThrow(/port is already allocated/);
    const lines = fake.lines('docker');
    const runAt = fake.calls.findIndex((c) => c.args[0] === 'run');
    const after = fake.calls.slice(runAt + 1).map((c) => c.args.join(' '));
    expect(after).toEqual(expect.arrayContaining(['rename teams-ai-todo-api-prev teams-ai-todo-api', 'start teams-ai-todo-api']));
    expect(after).not.toContain('rm -f teams-ai-todo-api-prev');
    expect(lines).toContain('rename teams-ai-todo-api teams-ai-todo-api-prev');
  });

  it('reports no previous image when nothing was running', async () => {
    const fake = new FakeExec().onArgs('docker', ['inspect'], () => ({ exitCode: 1, stderr: 'No such object' }));
    const t = new DockerLocalTarget({ exec: fake.exec, get: okGet, secrets });
    expect((await t.apply(intent)).previous).toBeNull();
    expect(fake.lines('docker')).not.toContain('rename teams-ai-todo-api teams-ai-todo-api-prev');
  });

  it('rolls back by running the previous image and validates missing secrets', async () => {
    const fake = new FakeExec();
    const t = new DockerLocalTarget({ exec: fake.exec, get: okGet, secrets: {} });
    expect(await t.validate(intent)).toEqual(['missing secret DATABASE_URL']);
    await new DockerLocalTarget({ exec: fake.exec, get: okGet, secrets }).rollback(intent, 'todo-api:spec-001-old0000');
    const run = fake.calls.filter((c) => c.args[0] === 'run').pop()!;
    expect(run.args.at(-1)).toBe('todo-api:spec-001-old0000');
  });
});

describe('KindTarget', () => {
  const manifest = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: todo-api\nspec:\n  template:\n    spec:\n      containers:\n      - name: app\n        image: {{IMAGE}}\n';
  const mk = (fake: FakeExec, over: Partial<ConstructorParameters<typeof KindTarget>[0]> = {}) =>
    new KindTarget({ exec: fake.exec, secrets, cluster: 'teams-ai', readFile: async () => manifest, sleep: async () => undefined, ...over });

  it('loads the image, renders and applies manifests in the kind context, remembers the previous image', async () => {
    const fake = new FakeExec().onArgs('kubectl', ['--context', 'kind-teams-ai', 'get', 'deploy'], () => ({ stdout: 'todo-api:spec-001-old0000' }));
    const t = mk(fake);
    await t.build(intent);
    const { previous } = await t.apply(intent);
    expect(previous).toBe('todo-api:spec-001-old0000');
    expect(fake.lines('kind')).toEqual(['load docker-image todo-api:spec-001-abc1234 --name teams-ai']);
    for (const call of fake.calls.filter((c) => c.bin === 'kubectl')) expect(call.args.slice(0, 2)).toEqual(['--context', 'kind-teams-ai']);
    const apply = fake.calls.filter((c) => c.bin === 'kubectl' && c.args[2] === 'apply').pop()!;
    expect(apply.args.slice(2)).toEqual(['apply', '-f', '-']);
    expect(apply.stdin).toContain('image: todo-api:spec-001-abc1234');
    expect(apply.stdin).not.toContain('{{IMAGE}}');
    const secret = fake.calls.find((c) => c.bin === 'kubectl' && c.args[2] === 'create')!;
    expect(secret.args.join(' ')).toContain('secret generic todo-api-secrets');
    expect(secret.args.join(' ')).not.toContain('postgres://x');
    expect(secret.stdin).toContain('postgres://x');
    expect(await t.currentImage(intent)).toBe('todo-api:spec-001-old0000');
  });

  it('verifies with rollout status and an in-cluster probe, and rolls back with rollout undo', async () => {
    const fake = new FakeExec().onArgs('kubectl', ['--context', 'kind-teams-ai', 'run'], () => ({ stdout: '200pod "probe-x" deleted' }));
    const t = mk(fake);
    expect(await t.verify(intent)).toMatchObject({ healthy: true });
    expect(fake.lines('kubectl')[0]).toBe('--context kind-teams-ai rollout status deployment/todo-api --timeout=120s');
    await t.rollback(intent, 'todo-api:spec-001-old0000');
    expect(fake.lines('kubectl')).toContain('--context kind-teams-ai rollout undo deployment/todo-api');
  });

  it('reads the status code even when kubectl appends pod deletion and warning text', async () => {
    const fake = new FakeExec().onArgs('kubectl', ['--context', 'kind-teams-ai', 'run'], () => ({
      stdout: '200pod "probe-1790247850989" deleted from default namespace\n',
      stderr: "warning: couldn't attach to pod/probe-1790247850989, falling back to streaming logs",
    }));
    expect(await mk(fake, { secrets: {} }).verify({ ...intent, secretNames: [] })).toEqual({ healthy: true, detail: 'HTTP 200 in-cluster after 1 attempts' });
  });

  it('retries the in-cluster probe while kube-proxy has not programmed the Service yet', async () => {
    let n = 0;
    const fake = new FakeExec().onArgs('kubectl', ['--context', 'kind-teams-ai', 'run'], () => ({ stdout: `${++n < 3 ? '000' : '200'}pod "probe-x" deleted` }));
    const t = mk(fake, { secrets: {} });
    expect(await t.verify({ ...intent, secretNames: [] })).toEqual({ healthy: true, detail: 'HTTP 200 in-cluster after 3 attempts' });
    expect(fake.calls.filter((c) => c.bin === 'kubectl' && c.args[2] === 'run')).toHaveLength(3);
  });

  it('gives up after the configured attempts and treats 503 as unhealthy', async () => {
    const fake = new FakeExec().onArgs('kubectl', ['--context', 'kind-teams-ai', 'run'], () => ({ stdout: '503pod deleted' }));
    const r = await mk(fake, { secrets: {}, probeAttempts: 4 }).verify({ ...intent, secretNames: [] });
    expect(r.healthy).toBe(false);
    expect(fake.calls.filter((c) => c.bin === 'kubectl' && c.args[2] === 'run')).toHaveLength(4);
  });

  it('validates a manifest that requires the Secret when no secret names are given', async () => {
    const fake = new FakeExec();
    const strict = manifest + '        envFrom:\n        - secretRef:\n            name: todo-api-secrets\n';
    const t = new KindTarget({ exec: fake.exec, secrets: {}, cluster: 'teams-ai', readFile: async () => strict, sleep: async () => undefined });
    expect(await t.validate({ ...intent, secretNames: [] })).toEqual(['manifest references Secret todo-api-secrets but the intent declares no secrets']);
  });
});

describe('runDeployment', () => {
  function target(over: Partial<DeployTarget> = {}, log: string[] = []): DeployTarget {
    return {
      name: 'docker-local',
      validate: async () => (log.push('validate'), []),
      build: async () => void log.push('build'),
      apply: async () => (log.push('apply'), { previous: 'img:old' }),
      verify: async () => (log.push('verify'), { healthy: true, detail: 'ok' }),
      currentImage: async () => (log.push('image'), 'img:old'),
      rollback: async () => void log.push('rollback'),
      destroy: async () => void log.push('destroy'),
      ...over,
    };
  }
  const smokeOk = async () => ({ ok: true, detail: 'ok' });

  it('runs validate → build → apply → verify → smoke', async () => {
    const log: string[] = [];
    const r = await runDeployment(target({}, log), intent, { smoke: smokeOk, baseUrl: 'http://127.0.0.1:3000' });
    expect(r).toEqual({ ok: true, previous: 'img:old' });
    expect(log).toEqual(['validate', 'build', 'apply', 'verify']);
  });

  it('stops on validation errors without building', async () => {
    const log: string[] = [];
    const r = await runDeployment(target({ validate: async () => ['missing secret X'] }, log), intent, { smoke: smokeOk, baseUrl: 'u' });
    expect(r).toMatchObject({ ok: false, stage: 'validate', detail: 'missing secret X', rolledBack: false });
    expect(log).toEqual([]);
  });

  it('rolls back when the smoke suite fails and confirms the old image is healthy and running', async () => {
    const log: string[] = [];
    const r = await runDeployment(target({}, log), intent, { smoke: async () => ({ ok: false, detail: '[AC-001] failed' }), baseUrl: 'u' });
    expect(r).toEqual({ ok: false, stage: 'smoke', detail: '[AC-001] failed', rolledBack: true, rollbackHealthy: true });
    expect(log).toEqual(['validate', 'build', 'apply', 'verify', 'rollback', 'verify', 'image']);
  });

  it('reports rollbackHealthy=false when a different image is running after the rollback', async () => {
    const r = await runDeployment(target({ currentImage: async () => 'img:other' }), intent, { smoke: async () => ({ ok: false, detail: 'x' }), baseUrl: 'u' });
    expect(r).toMatchObject({ ok: false, stage: 'smoke', rolledBack: true, rollbackHealthy: false });
    if (!r.ok) expect(r.detail).toContain('img:other');
  });

  it('reports an unhealthy deploy with no rollback when there was no previous version', async () => {
    const r = await runDeployment(
      target({ apply: async () => ({ previous: null }), verify: async () => ({ healthy: false, detail: 'timeout' }) }),
      intent,
      { smoke: smokeOk, baseUrl: 'u' },
    );
    expect(r).toEqual({ ok: false, stage: 'verify', detail: 'timeout', rolledBack: false, rollbackHealthy: null });
  });

  it('turns a throwing rollback into a result instead of a rejection', async () => {
    const r = await runDeployment(
      target({ verify: async () => ({ healthy: false, detail: 'down' }), rollback: async () => { throw new Error('docker run failed'); } }),
      intent,
      { smoke: smokeOk, baseUrl: 'u' },
    );
    expect(r).toEqual({ ok: false, stage: 'verify', detail: 'down; rollback failed: docker run failed', rolledBack: false, rollbackHealthy: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/deploy/deploy.test.ts`
Expected: FAIL — cannot resolve `../../server/deploy/target.js`.

- [ ] **Step 3: Write the target interface and runner**

`server/deploy/target.ts`:
```ts
export interface DeploymentIntent {
  projectId: string;
  image: string;
  tag: string;
  port: number;
  healthcheckPath: string;
  manifests: string[];
  secretNames: string[];
  /** Directory with the Dockerfile and manifests (the merged main checkout). */
  contextDir: string;
}

export interface DeployTarget {
  readonly name: 'docker-local' | 'kind';
  validate(intent: DeploymentIntent): Promise<string[]>;
  build(intent: DeploymentIntent): Promise<void>;
  apply(intent: DeploymentIntent): Promise<{ previous: string | null }>;
  verify(intent: DeploymentIntent): Promise<{ healthy: boolean; detail: string }>;
  /** Image reference currently serving the project, or null when nothing runs. */
  currentImage(intent: DeploymentIntent): Promise<string | null>;
  rollback(intent: DeploymentIntent, previous: string): Promise<void>;
  destroy(intent: DeploymentIntent): Promise<void>;
}

export type DeployStage = 'validate' | 'build' | 'apply' | 'verify' | 'smoke';

export type DeployResult =
  | { ok: true; previous: string | null }
  | { ok: false; stage: DeployStage; detail: string; rolledBack: boolean; rollbackHealthy: boolean | null };

export type HttpGet = (url: string, timeoutMs: number) => Promise<{ status: number } | null>;

export const httpGet: HttpGet = async (url, timeoutMs) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return { status: res.status };
  } catch {
    return null;
  }
};

export async function waitHealthy(
  url: string,
  get: HttpGet,
  opts: { timeoutMs: number; intervalMs: number },
): Promise<{ healthy: boolean; detail: string }> {
  const deadline = Date.now() + opts.timeoutMs;
  let attempts = 0;
  let last = 'no response';
  do {
    attempts += 1;
    const r = await get(url, Math.min(opts.intervalMs * 5, 5_000));
    if (r && r.status >= 200 && r.status < 300) return { healthy: true, detail: `HTTP ${r.status} after ${attempts} attempts` };
    last = r ? `HTTP ${r.status}` : 'no response';
    await new Promise((res) => setTimeout(res, opts.intervalMs));
  } while (Date.now() < deadline);
  return { healthy: false, detail: `${last} after ${attempts} attempts (${opts.timeoutMs} ms)` };
}

export const imageRef = (intent: DeploymentIntent) => `${intent.image}:${intent.tag}`;

/**
 * Spec Phase 5: validate → build → apply → verify → smoke. Any failure after apply rolls back to the
 * previous version (when one exists), re-verifies health and confirms the previous image is the one
 * running, so the environment is known-good before the failure is reported and the fix goes through a PR.
 * Nothing here rejects: every path ends in a DeployResult.
 */
export async function runDeployment(
  target: DeployTarget,
  intent: DeploymentIntent,
  deps: { smoke: (baseUrl: string) => Promise<{ ok: boolean; detail: string }>; baseUrl: string },
): Promise<DeployResult> {
  const errors = await target.validate(intent);
  if (errors.length > 0) return { ok: false, stage: 'validate', detail: errors.join('; '), rolledBack: false, rollbackHealthy: null };
  try {
    await target.build(intent);
  } catch (err) {
    return { ok: false, stage: 'build', detail: (err as Error).message, rolledBack: false, rollbackHealthy: null };
  }
  let previous: string | null = null;
  try {
    previous = (await target.apply(intent)).previous;
  } catch (err) {
    return { ok: false, stage: 'apply', detail: (err as Error).message, rolledBack: false, rollbackHealthy: null };
  }
  const fail = async (stage: DeployStage, detail: string): Promise<DeployResult> => {
    if (!previous) return { ok: false, stage, detail, rolledBack: false, rollbackHealthy: null };
    try {
      await target.rollback(intent, previous);
    } catch (err) {
      return { ok: false, stage, detail: `${detail}; rollback failed: ${(err as Error).message}`, rolledBack: false, rollbackHealthy: false };
    }
    try {
      const back = await target.verify(intent);
      const running = await target.currentImage(intent);
      if (running !== previous) {
        return { ok: false, stage, detail: `${detail}; after rollback ${running ?? 'nothing'} is running instead of ${previous}`, rolledBack: true, rollbackHealthy: false };
      }
      return { ok: false, stage, detail, rolledBack: true, rollbackHealthy: back.healthy };
    } catch (err) {
      return { ok: false, stage, detail: `${detail}; rollback verify failed: ${(err as Error).message}`, rolledBack: true, rollbackHealthy: false };
    }
  };
  let health: { healthy: boolean; detail: string };
  try {
    health = await target.verify(intent);
  } catch (err) {
    return fail('verify', (err as Error).message);
  }
  if (!health.healthy) return fail('verify', health.detail);
  const smoke = await deps.smoke(deps.baseUrl);
  if (!smoke.ok) return fail('smoke', smoke.detail);
  return { ok: true, previous };
}
```

- [ ] **Step 4: Write the docker-local adapter**

`server/deploy/docker-local.ts`:
```ts
import type { Exec } from '../exec/command.js';
import { imageRef, waitHealthy, type DeploymentIntent, type DeployTarget, type HttpGet } from './target.js';

const TIMEOUT = 600_000;

export class DockerLocalTarget implements DeployTarget {
  readonly name = 'docker-local' as const;

  constructor(private readonly deps: { exec: Exec; get: HttpGet; secrets: Record<string, string> }) {}

  private container(intent: DeploymentIntent) {
    return `teams-ai-${intent.projectId}`;
  }

  baseUrl(intent: DeploymentIntent) {
    return `http://127.0.0.1:${intent.port}`;
  }

  private docker(args: string[], env?: Record<string, string>, timeoutMs = 120_000) {
    return this.deps.exec({ bin: 'docker', args, env, timeoutMs });
  }

  async validate(intent: DeploymentIntent): Promise<string[]> {
    return intent.secretNames.filter((n) => this.deps.secrets[n] === undefined).map((n) => `missing secret ${n}`);
  }

  async build(intent: DeploymentIntent): Promise<void> {
    const r = await this.docker(['build', '-t', imageRef(intent), intent.contextDir], undefined, TIMEOUT);
    if (r.exitCode !== 0) throw new Error(`docker build failed: ${r.stderr.slice(-2000)}`);
  }

  async currentImage(intent: DeploymentIntent): Promise<string | null> {
    const r = await this.docker(['inspect', '--format', '{{.Config.Image}}', this.container(intent)], undefined, 60_000);
    return r.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
  }

  /**
   * Starts `image` as the project container. The running container is parked under a `-prev` name
   * first and only removed once the new one is up; if `docker run` fails the parked one is put back,
   * so a failed apply never leaves the environment empty.
   */
  private async run(intent: DeploymentIntent, image: string): Promise<void> {
    const name = this.container(intent);
    const prev = `${name}-prev`;
    const exists = (await this.docker(['inspect', '--format', '{{.Id}}', name], undefined, 60_000)).exitCode === 0;
    let parked = false;
    if (exists) {
      await this.docker(['rm', '-f', prev], undefined, 60_000); // a stale park from an interrupted apply
      parked = (await this.docker(['rename', name, prev], undefined, 60_000)).exitCode === 0;
    }
    const args = ['run', '-d', '--name', name, '--restart', 'unless-stopped', '-p', `127.0.0.1:${intent.port}:${intent.port}`];
    const env: Record<string, string> = {};
    for (const n of intent.secretNames) {
      args.push('-e', n);
      env[n] = this.deps.secrets[n]!;
    }
    args.push(image);
    const r = await this.docker(args, env);
    if (r.exitCode !== 0) {
      await this.docker(['rm', '-f', name], undefined, 60_000);
      if (parked) {
        await this.docker(['rename', prev, name], undefined, 60_000);
        await this.docker(['start', name], undefined, 60_000);
      }
      throw new Error(`docker run failed: ${r.stderr.slice(-2000)}`);
    }
    if (parked) await this.docker(['rm', '-f', prev], undefined, 60_000);
  }

  async apply(intent: DeploymentIntent): Promise<{ previous: string | null }> {
    const previous = await this.currentImage(intent);
    await this.run(intent, imageRef(intent));
    return { previous: previous === imageRef(intent) ? null : previous };
  }

  verify(intent: DeploymentIntent) {
    return waitHealthy(`${this.baseUrl(intent)}${intent.healthcheckPath}`, this.deps.get, { timeoutMs: 120_000, intervalMs: 2_000 });
  }

  rollback(intent: DeploymentIntent, previous: string): Promise<void> {
    return this.run(intent, previous);
  }

  async destroy(intent: DeploymentIntent): Promise<void> {
    await this.docker(['rm', '-f', this.container(intent), `${this.container(intent)}-prev`], undefined, 60_000);
  }
}
```

- [ ] **Step 5: Write the kind adapter**

`server/deploy/kind.ts`:
```ts
import path from 'node:path';
import type { Exec } from '../exec/command.js';
import { imageRef, type DeploymentIntent, type DeployTarget } from './target.js';

const TIMEOUT = 600_000;

export interface KindDeps {
  exec: Exec;
  secrets: Record<string, string>;
  cluster: string;
  readFile: (absolutePath: string) => Promise<string>;
  /** Injected for tests; the probe waits between attempts while kube-proxy programs the Service. */
  sleep?: (ms: number) => Promise<void>;
  probeAttempts?: number;
  probeIntervalMs?: number;
}

/**
 * kind adapter: every kubectl call is pinned to the kind context, the image is loaded into the
 * cluster node, manifests are rendered ({{IMAGE}}) and applied on stdin, secrets become one
 * Kubernetes Secret created from stdin (never on argv), and health is probed from inside the
 * cluster (retrying: right after `apply`, kube-proxy may not have programmed the Service yet).
 */
export class KindTarget implements DeployTarget {
  readonly name = 'kind' as const;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly attempts: number;
  private readonly interval: number;

  constructor(private readonly deps: KindDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.attempts = deps.probeAttempts ?? 12;
    this.interval = deps.probeIntervalMs ?? 5_000;
  }

  private secretName(intent: DeploymentIntent) {
    return `${intent.projectId}-secrets`;
  }

  private async kubectl(args: readonly string[], stdin?: string) {
    return this.deps.exec({ bin: 'kubectl', args: ['--context', `kind-${this.deps.cluster}`, ...args], timeoutMs: TIMEOUT, stdin });
  }

  async validate(intent: DeploymentIntent): Promise<string[]> {
    const errors = intent.secretNames.filter((n) => this.deps.secrets[n] === undefined).map((n) => `missing secret ${n}`);
    if (intent.manifests.length === 0) errors.push('kind target requires at least one manifest');
    if (intent.secretNames.length === 0) {
      const rendered = await this.render(intent, imageRef(intent)).catch(() => '');
      const ref = new RegExp(`name:\\s*${this.secretName(intent)}\\b(?![\\s\\S]{0,80}optional:\\s*true)`);
      if (ref.test(rendered)) errors.push(`manifest references Secret ${this.secretName(intent)} but the intent declares no secrets`);
    }
    return errors;
  }

  async build(intent: DeploymentIntent): Promise<void> {
    const build = await this.deps.exec({ bin: 'docker', args: ['build', '-t', imageRef(intent), intent.contextDir], timeoutMs: TIMEOUT });
    if (build.exitCode !== 0) throw new Error(`docker build failed: ${build.stderr.slice(-2000)}`);
    const load = await this.deps.exec({ bin: 'kind', args: ['load', 'docker-image', imageRef(intent), '--name', this.deps.cluster], timeoutMs: TIMEOUT });
    if (load.exitCode !== 0) throw new Error(`kind load failed: ${load.stderr.slice(-2000)}`);
  }

  private async render(intent: DeploymentIntent, image: string): Promise<string> {
    const docs: string[] = [];
    for (const m of intent.manifests) docs.push((await this.deps.readFile(path.join(intent.contextDir, m))).replaceAll('{{IMAGE}}', image));
    return docs.join('\n---\n');
  }

  private async applySecret(intent: DeploymentIntent): Promise<void> {
    if (intent.secretNames.length === 0) return;
    for (const n of intent.secretNames) {
      if (/[\r\n]/.test(this.deps.secrets[n] ?? '')) throw new Error(`secret ${n} contains a line break, which the env-file format cannot carry`);
    }
    const env = intent.secretNames.map((n) => `${n}=${this.deps.secrets[n]}`).join('\n');
    // `--from-env-file=/dev/stdin` keeps values off the command line; --dry-run + apply makes it idempotent.
    const dry = await this.kubectl(['create', 'secret', 'generic', this.secretName(intent), '--from-env-file=/dev/stdin', '--dry-run=client', '-o', 'yaml'], env);
    if (dry.exitCode !== 0) throw new Error(`kubectl create secret failed: ${dry.stderr.slice(-2000)}`);
    const apply = await this.kubectl(['apply', '-f', '-'], dry.stdout);
    if (apply.exitCode !== 0) throw new Error(`kubectl apply secret failed: ${apply.stderr.slice(-2000)}`);
  }

  async currentImage(intent: DeploymentIntent): Promise<string | null> {
    const r = await this.kubectl(['get', 'deploy', intent.projectId, '-o', 'jsonpath={.spec.template.spec.containers[0].image}']);
    return r.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null;
  }

  async apply(intent: DeploymentIntent): Promise<{ previous: string | null }> {
    const previous = await this.currentImage(intent);
    await this.applySecret(intent);
    const r = await this.kubectl(['apply', '-f', '-'], await this.render(intent, imageRef(intent)));
    if (r.exitCode !== 0) throw new Error(`kubectl apply failed: ${r.stderr.slice(-2000)}`);
    return { previous: previous === imageRef(intent) ? null : previous };
  }

  async verify(intent: DeploymentIntent): Promise<{ healthy: boolean; detail: string }> {
    const rollout = await this.kubectl(['rollout', 'status', `deployment/${intent.projectId}`, '--timeout=120s']);
    if (rollout.exitCode !== 0) return { healthy: false, detail: `rollout: ${rollout.stderr.trim() || rollout.stdout.trim()}` };
    let last = '';
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const probe = await this.kubectl([
        'run',
        `probe-${intent.projectId}-${Date.now()}-${attempt}`,
        '--rm',
        '-i',
        '--restart=Never',
        '--image=curlimages/curl:8.10.1',
        '--',
        'curl',
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        `http://${intent.projectId}:${intent.port}${intent.healthcheckPath}`,
      ]);
      // `kubectl run --rm -i` prints the curl output first, then "pod ... deleted"; the code is the leading 3 digits.
      const code = Number(probe.stdout.trim().match(/^(\d{3})/)?.[1]);
      if (code >= 200 && code < 300) return { healthy: true, detail: `HTTP ${code} in-cluster after ${attempt} attempts` };
      last = `probe: ${probe.stdout.trim()} ${probe.stderr.trim()}`.trim().slice(0, 300);
      if (attempt < this.attempts) await this.sleep(this.interval);
    }
    return { healthy: false, detail: `${last} (${this.attempts} attempts)` };
  }

  async rollback(intent: DeploymentIntent, _previous: string): Promise<void> {
    const r = await this.kubectl(['rollout', 'undo', `deployment/${intent.projectId}`]);
    if (r.exitCode !== 0) throw new Error(`rollout undo failed: ${r.stderr.slice(-2000)}`);
    const wait = await this.kubectl(['rollout', 'status', `deployment/${intent.projectId}`, '--timeout=120s']);
    if (wait.exitCode !== 0) throw new Error(`rollback did not become ready: ${wait.stderr.slice(-2000)}`);
  }

  async destroy(intent: DeploymentIntent): Promise<void> {
    await this.kubectl(['delete', '-f', '-', '--ignore-not-found'], await this.render(intent, imageRef(intent)));
    await this.kubectl(['delete', 'secret', this.secretName(intent), '--ignore-not-found']);
  }
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/deploy && npm run typecheck`
Expected: 17 tests PASS; typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add server/deploy test/deploy
git commit -m "feat: add deploy targets (docker-local, kind) with verification and rollback" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Spec update for the contract additions

**Files:**
- Modify: `docs/superpowers/specs/2026-09-23-teams-ai-poc-design.md` §4.3 and §15A

- [ ] **Step 1: Document the new plan fields**

In §4.3, after the `gates[]` bullet, add:

```markdown
- `gateImage` — toolchain image every gate runs in (from the stack ADR, e.g. `node:22-bookworm`); each gate also declares `network` (`none` by default; `egress` only for `install` and `dependency-scan`) and `secrets` (names injected into that gate's container only)
```

In §15A add a bullet:

```markdown
- **Execution plane:** gates run as `docker run --rm --network none|bridge --cpus N --memory M -v <worktree>:/work -w /work <gateImage> sh -lc <command>`; exit 137/125, daemon errors, disk full and timeouts are `infra`. The merge queue is `rebase → gates → push → ensurePr → merge --squash --match-head-commit`; a refused merge is reported, never forced. Deploy is `validate → build → apply → verify → smoke`, rolling back to the previous image (docker) or `rollout undo` (kind) and re-verifying on any failure after `apply`; kind manifests reference `{{IMAGE}}`, secrets become one Kubernetes Secret created from stdin.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs
git commit -m "docs: spec carries gate image, gate network/secrets and execution-plane conventions" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Integration against real Docker and kind (manual, WSL)

**Files:**
- Create: `test/fixtures/hello-app/server.mjs`, `test/fixtures/hello-app/package.json`, `test/fixtures/hello-app/Dockerfile`, `test/fixtures/hello-app/deploy/k8s.yaml`, `test/fixtures/hello-app/test/hello.test.mjs`
- Create: `scripts/integration/exec-plane.ts`

- [ ] **Step 1: Write the hello app fixture**

`test/fixtures/hello-app/server.mjs`:
```js
import http from 'node:http';
const port = Number(process.env.PORT ?? 3000);
http
  .createServer((req, res) => {
    if (req.url === '/health') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    res.writeHead(200, { 'content-type': 'text/plain' }).end(`hello from ${process.env.APP_GREETING ?? 'teams-ai'}\n`);
  })
  .listen(port, () => console.log(`listening on ${port}`));
```

`test/fixtures/hello-app/package.json`:
```json
{
  "name": "hello-app",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.mjs",
    "test": "node --test --test-reporter=junit --test-reporter-destination=reports/junit.xml"
  }
}
```

`test/fixtures/hello-app/test/hello.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

// Runs the same handler the server uses, on an ephemeral port, so the test never binds 3000.
const handler = (req, res) => {
  if (req.url === '/health') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  res.writeHead(200, { 'content-type': 'text/plain' }).end('hello\n');
};

test('[AC-001] health endpoint answers 200', async () => {
  const srv = http.createServer(handler).listen(0);
  await once(srv, 'listening');
  const { port } = srv.address();
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  srv.close();
  await once(srv, 'close');
});
```

`test/fixtures/hello-app/Dockerfile`:
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.mjs"]
```

`test/fixtures/hello-app/deploy/k8s.yaml`:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello-app
spec:
  replicas: 1
  selector:
    matchLabels: { app: hello-app }
  template:
    metadata:
      labels: { app: hello-app }
    spec:
      containers:
        - name: app
          image: {{IMAGE}}
          imagePullPolicy: IfNotPresent
          ports: [{ containerPort: 3000 }]
          envFrom: [{ secretRef: { name: hello-app-secrets, optional: true } }]
          readinessProbe: { httpGet: { path: /health, port: 3000 }, periodSeconds: 2 }
---
apiVersion: v1
kind: Service
metadata:
  name: hello-app
spec:
  selector: { app: hello-app }
  ports: [{ port: 3000, targetPort: 3000 }]
```

- [ ] **Step 2: Write the integration script**

`scripts/integration/exec-plane.ts` (run with `npx tsx`; never part of `npm test`):
```ts
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gate } from '../../server/contracts/plan.js';
import { DockerLocalTarget } from '../../server/deploy/docker-local.js';
import { KindTarget } from '../../server/deploy/kind.js';
import { httpGet, runDeployment, type DeploymentIntent } from '../../server/deploy/target.js';
import { execCommand } from '../../server/exec/command.js';
import { runGates } from '../../server/exec/gate-runner.js';

const app = path.resolve('test/fixtures/hello-app');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-exec-plane-'));
await fs.cp(app, work, { recursive: true });
await fs.mkdir(path.join(work, 'reports'), { recursive: true });

console.log('== gates in docker');
const gates = [
  Gate.parse({ name: 'install', command: 'npm install --no-audit --no-fund', blocking: true, network: 'egress' }),
  Gate.parse({ name: 'unit-test', command: 'npm test', blocking: true }),
];
const g = await runGates(
  gates,
  {
    worktree: work,
    image: 'node:22-bookworm',
    junitPath: 'reports/junit.xml',
    cpus: 2,
    memory: '1g',
    timeoutMs: 600_000,
    secrets: {},
    containerName: `gate-it-${Date.now()}`,
    user: process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : undefined,
  },
  { exec: execCommand, readFile: async (p) => fs.readFile(p, 'utf8').catch(() => null), removeFile: async (p) => fs.rm(p, { force: true }) },
);
for (const r of g.results) console.log(`  ${r.name}: passed=${r.passed} exit=${r.exitCode} failure=${r.failure} junit=${r.junit?.length ?? 'none'}`);

const intent: DeploymentIntent = {
  projectId: 'hello-app',
  image: 'hello-app',
  tag: `it-${Date.now()}`,
  port: 3000,
  healthcheckPath: '/health',
  manifests: ['deploy/k8s.yaml'],
  secretNames: [],
  contextDir: work,
};
const smoke = async (baseUrl: string) => {
  const r = await httpGet(`${baseUrl}/`, 5_000);
  return r && r.status === 200 ? { ok: true, detail: 'GET / 200' } : { ok: false, detail: `GET / ${r?.status ?? 'no response'}` };
};

console.log('== docker-local deploy');
const local = new DockerLocalTarget({ exec: execCommand, get: httpGet, secrets: {} });
console.log('  ', JSON.stringify(await runDeployment(local, intent, { smoke, baseUrl: local.baseUrl(intent) })));
await local.destroy(intent);
await execCommand({ bin: 'docker', args: ['rmi', '-f', `${intent.image}:${intent.tag}`], timeoutMs: 60_000 }); // no image left behind

if (process.env.KIND_CLUSTER) {
  console.log(`== kind deploy (${process.env.KIND_CLUSTER})`);
  const kind = new KindTarget({ exec: execCommand, secrets: {}, cluster: process.env.KIND_CLUSTER, readFile: (p) => fs.readFile(p, 'utf8') });
  console.log('  ', JSON.stringify(await runDeployment(kind, intent, { smoke: async () => ({ ok: true, detail: 'in-cluster probe is the smoke' }), baseUrl: '' })));
  await kind.destroy(intent);
}
await execCommand({ bin: 'docker', args: ['rmi', '-f', `${intent.image}:${intent.tag}`], timeoutMs: 60_000 }).catch(() => undefined);
await fs.rm(work, { recursive: true, force: true });
```

Run: `npx tsc --noEmit -p tsconfig.json` (add `"scripts/integration"` to `tsconfig.json` `include`).
Expected: exit 0.

- [ ] **Step 3: Run inside WSL**

```bash
cd ~/workspace/teams-ai && git pull && npm ci
npx tsx scripts/integration/exec-plane.ts                       # gates + docker-local
kind create cluster --name teams-ai                            # once
KIND_CLUSTER=teams-ai npx tsx scripts/integration/exec-plane.ts # + kind
```
Expected: `install` and `unit-test` gates `passed=true` with `junit=1`; docker-local `{"ok":true,...}` then the container removed; kind `{"ok":true,...}`. Record the output in `docs/superpowers/spikes/2026-09-23-cli-findings.md` under "Execution plane integration".

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/hello-app scripts/integration tsconfig.json docs/superpowers/spikes
git commit -m "test: add hello-app fixture and execution-plane integration script" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
