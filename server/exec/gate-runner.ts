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

export const INFRA_PATTERNS: readonly RegExp[] = [
  /Cannot connect to the Docker daemon/i,
  /docker: (command )?not found/i,
  /no space left on device/i,
  /ENOENT/,
  /error during connect/i,
  /OOMKilled|Out of memory/i,
];

export function dockerArgs(gate: Gate, ctx: GateContext): string[] {
  const workdir = ctx.containerWorkdir ?? '/work';
  const args = [
    'run',
    '--rm',
    '--network',
    gate.network === 'egress' ? 'bridge' : 'none',
    '--cpus',
    String(ctx.cpus),
    '--memory',
    ctx.memory,
    '-v',
    `${ctx.worktree}:${workdir}`,
    '-w',
    workdir,
  ];
  for (const name of gate.secrets) {
    const value = ctx.secrets[name];
    if (value === undefined) throw new Error(`gate ${gate.name} declares secret ${name} but it is not available`);
    args.push('-e', `${name}=${value}`);
  }
  args.push(ctx.image, 'sh', '-lc', gate.command);
  return args;
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
}

export async function runGate(gate: Gate, ctx: GateContext, deps: GateDeps): Promise<GateResult> {
  const started = Date.now();
  let base: Omit<GateResult, 'name' | 'blocking' | 'passed' | 'junit' | 'failure'>;
  try {
    const r = await deps.exec({ bin: 'docker', args: dockerArgs(gate, ctx), timeoutMs: ctx.timeoutMs });
    base = { exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, stdoutTail: tail(r.stdout), stderrTail: tail(r.stderr) };
  } catch (err) {
    base = { exitCode: null, timedOut: false, durationMs: Date.now() - started, stdoutTail: '', stderrTail: tail((err as Error).message) };
    return { name: gate.name, blocking: gate.blocking, passed: false, junit: null, failure: 'infra', ...base };
  }
  const passed = base.exitCode === 0 && !base.timedOut;
  let junit: TestResult[] | null = null;
  const report = await deps.readFile(path.posix.join(ctx.worktree.replace(/\\/g, '/'), ctx.junitPath));
  if (report) {
    try {
      junit = parseJUnit(report);
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
