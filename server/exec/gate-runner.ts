import path from 'node:path';
import type { Gate } from '../contracts/plan.js';
import { redactSecrets } from '../core/redact.js';
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
  // Tails reach the event store and UI; secret values injected into the container never do.
  const secretValues = Object.values(ctx.secrets);
  const clean = (s: string) => redactSecrets(tail(s), secretValues);
  const invocation = dockerArgs(gate, ctx);
  try {
    const r = await deps.exec({ bin: 'docker', args: invocation.args, env: invocation.env, timeoutMs: ctx.timeoutMs });
    base = { exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, stdoutTail: clean(r.stdout), stderrTail: clean(r.stderr) };
    if (r.timedOut) {
      // SIGTERM reaches the docker CLI, not PID 1 in the container; make sure nothing keeps running.
      await deps.exec({ bin: 'docker', args: ['rm', '-f', `${ctx.containerName}-${gate.name}`], timeoutMs: 60_000 }).catch(() => undefined);
    }
  } catch (err) {
    base = { exitCode: null, timedOut: false, durationMs: Date.now() - started, stdoutTail: '', stderrTail: clean((err as Error).message) };
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
