import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Gate } from '../contracts/plan.js';
import { redactSecrets } from '../core/redact.js';
import { FLUTTER_IMAGE_TAG, androidCommand, androidImageSteps } from './android-toolchain.js';
import { COVERAGE_GATE, coveragePasses, parseCoverageSummary } from './coverage.js';
import { parseJUnit, parseTap, type TestResult } from '../evidence/junit.js';
import type { Exec } from './command.js';
import { stackEnv, type AndroidToolchain } from '../runner/stacks.js';
import { TEST_GATE } from './test-services.js';

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
  /** Private network of the test services; only the unit-test gate joins it (plan 111). */
  testNetwork?: string;
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

/** What `classifyGate` reads; `oomKilled` is true when the gate hit its own memory limit. */
type Classified = Pick<GateResult, 'exitCode' | 'timedOut' | 'stderrTail'> & { oomKilled?: boolean };

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

/** Gates are offline: a rust-toolchain.toml naming a Rust the image lacks would make rustup download it, so the image's own toolchain wins. */
const RUST_IMAGE_TOOLCHAIN = 'command -v rustup >/dev/null 2>&1 && export RUSTUP_TOOLCHAIN="$(rustup default | cut -d" " -f1)"; ';

/** A Docker image reference: registry/path, optional :tag and @sha256 digest, nothing else. */
export const IMAGE_REFERENCE = /^[a-z0-9][a-z0-9._\/-]*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(@sha256:[a-f0-9]{64})?$/;

const isRustImage = (image: string) => /(^|\/)rust[:@]|^teams-ai-gate:rust-/.test(image);

/**
 * Gates run offline, so every tool a gate command uses must already be in the image. The plan rules promise jq,
 * which no official toolchain image ships, the rust image also lacks rustfmt and clippy, and a front plan's e2e
 * drives Chromium; each gate image gets one derived image with what it misses, built once and reused. A failed build
 * keeps the original image so the gate reports its own error.
 */
export async function prepareGateImage(image: string, exec: Exec, opts: { browser?: boolean; android?: AndroidToolchain } = {}): Promise<string> {
  // The image comes from an agent-written plan and lands in a Dockerfile built with network: only a plain reference passes.
  if (!IMAGE_REFERENCE.test(image)) throw new Error(`gate image ${JSON.stringify(image)} is not a plain image reference`);
  // The hash keeps two different images, and each flavour of one, from sharing one derived tag.
  const flavour = [opts.browser && 'browser', opts.android].filter(Boolean).join('-');
  const tag = `teams-ai-gate:${image.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 100)}${flavour ? `-${flavour}` : ''}-${createHash('sha256').update(flavour ? `${image}+${flavour}` : image).digest('hex').slice(0, 12)}`;
  if ((await exec({ bin: 'docker', args: ['image', 'inspect', tag], timeoutMs: 60_000 })).exitCode === 0) return tag;
  const steps = ['RUN command -v jq >/dev/null || (apt-get update && apt-get install -y --no-install-recommends jq && rm -rf /var/lib/apt/lists/*)'];
  if (isRustImage(image)) steps.push('RUN rustup component add rustfmt clippy');
  if (opts.browser) steps.push('RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation && rm -rf /var/lib/apt/lists/*');
  if (opts.android) steps.push(...androidImageSteps(opts.android));
  const built = await exec({ bin: 'docker', args: ['build', '-t', tag, '-'], stdin: `FROM ${image}\n${steps.join('\n')}\n`, timeoutMs: 15 * 60_000 });
  return built.exitCode === 0 ? tag : image;
}

/** The third-party libraries and SDK caches the stacks keep under the worktree's .tools (see stackEnv): a format gate never scans them. */
export const THIRD_PARTY_CACHES: readonly string[] = ['go', 'go-build', 'cargo', 'pip-cache', 'npm-cache', 'm2', 'nuget', 'dotnet', 'buf-cache', 'cache', 'py', 'pub-cache'];

export function dockerArgs(gate: Gate, ctx: GateContext): DockerInvocation {
  const workdir = ctx.containerWorkdir ?? '/work';
  const source = rewriteBindSource(ctx.worktree.replace(/\\/g, '/'), ctx.bindRewrite);
  const args = [
    // No --rm: the executor inspects an exit 137 for OOMKilled and removes the container itself.
    'run',
    '--init',
    '--name',
    `${ctx.containerName}-${gate.name}`,
    '--network',
    gate.network === 'egress' ? ctx.network ?? 'bridge' : gate.name === TEST_GATE && ctx.testNetwork ? ctx.testNetwork : 'none',
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
  for (const [key, value] of Object.entries(stackEnv(workdir))) args.push('-e', `${key}=${value}`);
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
  // A format gate checks the project's own code only: each third-party cache under .tools is hidden behind an empty tmpfs.
  if (gate.name === 'format') for (const cache of THIRD_PARTY_CACHES) args.push('--mount', `type=tmpfs,destination=${workdir}/.tools/${cache}`);
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
  // Not a login shell: Debian's /etc/profile resets PATH and drops /usr/local/go/bin and /usr/local/cargo/bin of the golang and rust images.
  // The install step writes the project's packages into .tools; the gates read them through the image's pub cache (see androidCommand).
  const command = isRustImage(ctx.image) ? `${RUST_IMAGE_TOOLCHAIN}${gate.command}` : FLUTTER_IMAGE_TAG.test(ctx.image) && gate.name !== 'install' ? androidCommand(gate.command) : gate.command;
  args.push(ctx.image, 'sh', '-c', command);
  return { args, env };
}

export function classifyGate(r: Classified): 'infra' | 'code' {
  // A gate that ran into its timeout hung on its own command; repeating it as an infra retry only multiplies the wait.
  if (r.timedOut) return 'code';
  // A test that outgrows the gate's memory limit fails the same way on every retry.
  if (r.exitCode === 137) return r.oomKilled ? 'code' : 'infra';
  if (r.exitCode === 125) return 'infra';
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
  oomKilled?: boolean;
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
      const name = `${ctx.containerName}-${gate.name}`;
      // Also stops a timed-out gate: SIGTERM reaches the docker CLI, not PID 1 in the container.
      const remove = () => exec({ bin: 'docker', args: ['rm', '-f', name], timeoutMs: 60_000 }).catch(() => undefined);
      await remove(); // a container left by a crashed orchestrator would hold the name
      try {
        const r = await exec({ bin: 'docker', args: invocation.args, env: invocation.env, timeoutMs: ctx.timeoutMs });
        const oomKilled = r.exitCode === 137 && !r.timedOut && (await exec({ bin: 'docker', args: ['inspect', '--format', '{{.State.OOMKilled}}', name], timeoutMs: 60_000 }).catch(() => null))?.stdout.trim() === 'true';
        return { exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, stdout: r.stdout, stderr: r.stderr, oomKilled };
      } finally {
        await remove();
      }
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
  let oomKilled = false;
  // Tails reach the event store and UI; secret values injected into the container never do.
  const secretValues = Object.values(ctx.secrets);
  // Redact before the cut, or a secret split by it would leave its suffix visible.
  const clean = (s: string) => tail(redactSecrets(s, secretValues));
  const executor = deps.executor ?? dockerGateExecutor(deps.exec);
  try {
    const r = await executor.run(gate, ctx);
    stdout = `${r.stdout}\n${r.stderr}`; // python unittest and cargo print their result lines on stderr
    base = { exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, stdoutTail: clean(r.stdout), stderrTail: clean(r.stderr) };
    oomKilled = r.oomKilled === true;
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
  if (junit === null) {
    const tap = parseTap(stdout);
    if (tap.length > 0) junit = tap;
  }
  // The coverage gate's exit code alone proves nothing: a stack-agnostic command could exit 0 without ever
  // writing the summary, or below the floor. Read the normalized signal and fail closed on anything unverifiable.
  let finalPassed = passed;
  let failure: GateResult['failure'] = passed ? null : classifyGate({ ...base, oomKilled });
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
