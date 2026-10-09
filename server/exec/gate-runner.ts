import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Gate } from '../contracts/plan.js';
import { redactSecrets } from '../core/redact.js';
import { COVERAGE_GATE, coveragePasses, parseCoverageSummary } from './coverage.js';
import { parseJUnit, parseTap, type TestResult } from '../evidence/junit.js';
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
  /** Config `docker.bindRewrite`: the worktree path as the Docker daemon sees it, when the orchestrator runs in a container. */
  bindRewrite?: { from: string; to: string };
  /** Docker network an egress gate joins instead of the default bridge (the compose project network). */
  network?: string;
  /** Host directory shared by the security gates (scanner downloads, trivy DB, pip cache), mounted at /gate-cache; see CACHED_GATES. */
  cacheDir?: string;
  /** Where the `coverage` gate's command writes `{"linesPct": N}` (roadmap R10.2); undefined when coverage is not required. */
  coveragePath?: string;
}

/** Rewrites a bind source for a daemon that sees the orchestrator's filesystem under another root. */
export function rewriteBindSource(source: string, rewrite: { from: string; to: string } | undefined): string {
  if (!rewrite) return source;
  const from = rewrite.from.replace(/\\/g, '/').replace(/\/+$/, '');
  const to = rewrite.to.replace(/\\/g, '/').replace(/\/+$/, '');
  if (source === from) return to;
  return source.startsWith(`${from}/`) ? `${to}${source.slice(from.length)}` : source;
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

/**
 * Only the gates whose command the orchestrator prescribes and validates verbatim (validators/security-tooling.ts) see the
 * shared cache: a gate command the agent wrote could otherwise poison what later tasks' scanners read. The installer
 * re-verifies every cached download against its pinned sha256 before use.
 */
export const CACHED_GATES: ReadonlySet<string> = new Set(['security-tools', 'image-scan']);
export const GATE_CACHE_TARGET = '/gate-cache';

export function dockerArgs(gate: Gate, ctx: GateContext): DockerInvocation {
  const workdir = ctx.containerWorkdir ?? '/work';
  const source = rewriteBindSource(ctx.worktree.replace(/\\/g, '/'), ctx.bindRewrite);
  const args = [
    'run',
    '--rm',
    '--init',
    '--name',
    `${ctx.containerName}-${gate.name}`,
    '--network',
    gate.network === 'egress' ? ctx.network ?? 'bridge' : 'none',
    '--cpus',
    String(ctx.cpus),
    '--memory',
    ctx.memory,
    // Gate commands come from the plan (agent-written): no capabilities, no privilege gain, bounded process count.
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '512',
  ];
  // The container's own 127.0.0.1 is not the host: egress gates (smoke) reach the service the daemon published through this name.
  if (gate.network === 'egress') args.push('--add-host', 'host.docker.internal:host-gateway');
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
  if (ctx.cacheDir && CACHED_GATES.has(gate.name)) {
    args.push(
      '--mount',
      `type=bind,source=${rewriteBindSource(ctx.cacheDir.replace(/\\/g, '/'), ctx.bindRewrite)},target=${GATE_CACHE_TARGET}`,
      '-e',
      `TEAMS_AI_GATE_CACHE=${GATE_CACHE_TARGET}`,
      '-e',
      `TRIVY_CACHE_DIR=${GATE_CACHE_TARGET}/trivy`,
      '-e',
      `PIP_CACHE_DIR=${GATE_CACHE_TARGET}/pip`,
    );
  }
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
  // A gate that ran into its timeout hung on its own command; repeating it as an infra retry only multiplies the wait.
  if (r.timedOut) return 'code';
  if (r.exitCode === 137 || r.exitCode === 125) return 'infra';
  if (INFRA_PATTERNS.some((p) => p.test(r.stderrTail))) return 'infra';
  return 'code';
}

const tail = (s: string) => (s.length > TAIL_CHARS ? s.slice(-TAIL_CHARS) : s);

/** What a gate run produced; JUnit, redaction, tails and classification stay in `runGate`. */
export interface GateRunOutcome {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

/** Runs one gate command in the toolchain image against the worktree. A rejection is an infrastructure failure. */
export interface GateExecutor {
  readonly kind: 'docker';
  run(gate: Gate, ctx: GateContext): Promise<GateRunOutcome>;
}

export function dockerGateExecutor(exec: Exec): GateExecutor {
  return {
    kind: 'docker',
    async run(gate, ctx) {
      const invocation = dockerArgs(gate, ctx);
      const r = await exec({ bin: 'docker', args: invocation.args, env: invocation.env, timeoutMs: ctx.timeoutMs });
      if (r.timedOut) {
        // SIGTERM reaches the docker CLI, not PID 1 in the container; make sure nothing keeps running.
        await exec({ bin: 'docker', args: ['rm', '-f', `${ctx.containerName}-${gate.name}`], timeoutMs: 60_000 }).catch(() => undefined);
      }
      return { exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

export interface GateDeps {
  exec: Exec;
  /** Where gates run; defaults to docker over xec. */
  executor?: GateExecutor;
  readFile: (absolutePath: string) => Promise<string | null>;
  removeFile: (absolutePath: string) => Promise<void>;
  /** Restores the last JUnit report after the run; defaults to the filesystem. */
  writeFile?: (absolutePath: string, text: string) => Promise<void>;
}

function junitFile(ctx: GateContext): string {
  const root = ctx.worktree.replace(/\\/g, '/');
  const file = path.posix.normalize(path.posix.join(root, ctx.junitPath.replace(/\\/g, '/')));
  if (!file.startsWith(`${root}/`)) throw new Error(`junitPath escapes the worktree: ${ctx.junitPath}`);
  return file;
}

/** Null when coveragePath was never set (coverage not required this run); the `coverage` gate then always fails closed. */
function coverageFile(ctx: GateContext): string | null {
  if (!ctx.coveragePath) return null;
  const root = ctx.worktree.replace(/\\/g, '/');
  const file = path.posix.normalize(path.posix.join(root, ctx.coveragePath.replace(/\\/g, '/')));
  if (!file.startsWith(`${root}/`)) throw new Error(`coveragePath escapes the worktree: ${ctx.coveragePath}`);
  return file;
}

export async function runGate(gate: Gate, ctx: GateContext, deps: GateDeps): Promise<GateResult> {
  const started = Date.now();
  const report = junitFile(ctx);
  // A stale report from a previous attempt must never be mistaken for this gate's evidence.
  await deps.removeFile(report);

  let base: Omit<GateResult, 'name' | 'blocking' | 'passed' | 'junit' | 'failure'>;
  let stdout = '';
  // Tails reach the event store and UI; secret values injected into the container never do.
  const secretValues = Object.values(ctx.secrets);
  const clean = (s: string) => redactSecrets(tail(s), secretValues);
  const executor = deps.executor ?? dockerGateExecutor(deps.exec);
  try {
    const r = await executor.run(gate, ctx);
    stdout = r.stdout;
    base = { exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, stdoutTail: clean(r.stdout), stderrTail: clean(r.stderr) };
  } catch (err) {
    base = { exitCode: null, timedOut: false, durationMs: Date.now() - started, stderrTail: clean((err as Error).message), stdoutTail: '' };
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
  if (junit === null && passed) {
    const tap = parseTap(stdout);
    if (tap.length > 0) junit = tap;
  }
  // The coverage gate's exit code alone proves nothing: a stack-agnostic command could exit 0 without ever
  // writing the summary, or below the floor. Read the normalized signal and fail closed on anything unverifiable.
  let finalPassed = passed;
  let failure: GateResult['failure'] = passed ? null : classifyGate(base);
  if (passed && gate.name === COVERAGE_GATE) {
    const file = coverageFile(ctx);
    const raw = file !== null ? await deps.readFile(file) : null;
    const summary = raw !== null ? parseCoverageSummary(raw) : null;
    if (!coveragePasses(summary)) {
      finalPassed = false;
      failure = 'code';
    }
  }
  return { name: gate.name, blocking: gate.blocking, passed: finalPassed, junit, failure, ...base };
}

export async function runGates(
  gates: readonly Gate[],
  ctx: GateContext,
  deps: GateDeps,
): Promise<{ results: GateResult[]; blockingFailure: GateResult | null }> {
  const results: GateResult[] = [];
  const report = junitFile(ctx);
  let lastXml: string | null = null;
  let outcome: { results: GateResult[]; blockingFailure: GateResult | null } = { results, blockingFailure: null };
  for (const gate of gates) {
    const r = await runGate(gate, ctx, deps);
    results.push(r);
    // Each gate removes the report before running (no stale evidence); keep the last one produced.
    const xml = await deps.readFile(report);
    if (xml !== null) lastXml = xml;
    if (!r.passed && r.blocking) {
      outcome = { results, blockingFailure: r };
      break;
    }
  }
  // Reviewers read the report from the worktree; a gate after the test gate would have wiped it.
  if (lastXml !== null && (await deps.readFile(report)) === null) {
    const write = deps.writeFile ?? ((p: string, text: string) => fs.writeFile(p, text));
    await write(report, lastXml).catch(() => undefined);
  }
  return outcome;
}
