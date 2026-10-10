import { spawn as nodeSpawn } from 'node:child_process';
import { openSync, promises as fs } from 'node:fs';
import path from 'node:path';

export interface SpawnArgs {
  bin: string;
  args: string[];
  cwd: string;
  logFile: string;
}

export interface RunControlDeps {
  spawn: (a: SpawnArgs) => { pid: number };
  /** `process.kill` semantics: false when the process does not exist. Negative pid = process group. */
  kill: (pid: number, signal: NodeJS.Signals | 0) => boolean;
  sleep: (ms: number) => Promise<void>;
  cliEntry: () => { bin: string; prefix: string[] };
  repoRoot: string;
}

export interface RunTarget {
  projectDir: string;
  specId: string;
  runId: string;
  mode: 'run' | 'resume' | 'complete' | 'readme' | 'deploy';
  /** Where ui.log goes; the caller passes the run directory once it exists. */
  logFile?: string;
  /** Spec (refinement) §4: the project directory is a draft root; `run` bootstraps Phase 0. */
  draft?: boolean;
}

const POLL_MS = 250;

export function runCommand(deps: RunControlDeps, o: RunTarget): SpawnArgs {
  const { bin, prefix } = deps.cliEntry();
  const args =
    o.mode === 'run'
      ? ['run', '--project', o.projectDir, '--spec', o.specId, '--run-id', o.runId, ...(o.draft ? ['--draft'] : [])]
      : o.mode === 'complete' || o.mode === 'readme' || o.mode === 'deploy'
        ? ['spec', o.mode, '--project', o.projectDir, '--spec', o.specId, '--run-id', o.runId]
        : ['resume', '--project', o.projectDir, '--run', o.runId];
  return { bin, args: [...prefix, ...args], cwd: deps.repoRoot, logFile: o.logFile ?? 'ui.log' };
}

export function spawnRun(deps: RunControlDeps, o: RunTarget): { pid: number } {
  return deps.spawn(runCommand(deps, o));
}

export function isAlive(deps: RunControlDeps, pid: number): boolean {
  return deps.kill(pid, 0);
}

/**
 * Spec (run API) §5: SIGTERM to the group, poll, then SIGKILL. The graceful window (timeoutMs, 15 s) is when the orchestrator
 * drains: it lets only the step already in flight finish and starts no other (plan 38). An agent step that outlasts the window
 * is killed with the group; the run is then `interrupted` and a resume re-runs that step.
 * The pid must come from `readPid`, which refuses a number that now belongs to another process: `isAlive` only says that some
 * process has it, and its group would get the signal.
 */
export async function stop(deps: RunControlDeps, pid: number, timeoutMs = 15_000): Promise<'terminated' | 'killed' | 'gone'> {
  if (!deps.kill(-pid, 'SIGTERM')) return 'gone';
  for (let waited = 0; waited < timeoutMs; waited += POLL_MS) {
    await deps.sleep(POLL_MS);
    if (!isAlive(deps, pid)) return 'terminated';
  }
  deps.kill(-pid, 'SIGKILL');
  return 'killed';
}

/** Waits for the spawned process to write its journal, so a spawn that dies on preconditions (e.g. `docker version`
 * unreachable) surfaces its `ui.log` tail instead of leaving the caller to poll a run that will never exist.
 * A busy host (parallel Rust builds, a full test suite) takes well over 10 seconds to start node, so the wait is generous. */
export async function waitForRunJournal(deps: RunControlDeps, runs: string, runId: string, pid: number, timeoutMs = 30_000): Promise<void> {
  const file = path.join(runs, runId, 'events.ndjson');
  for (let waited = 0; waited < timeoutMs; waited += POLL_MS) {
    if (
      await fs.access(file).then(
        () => true,
        () => false,
      )
    )
      return;
    if (!isAlive(deps, pid)) break;
    await deps.sleep(POLL_MS);
  }
  const log = await fs.readFile(path.join(runs, runId, 'ui.log'), 'utf8').catch(() => '');
  throw new Error(`run ${runId} did not start: ${log.slice(-500) || 'no output'}`);
}

/** A new launch that did not start leaves nothing behind: its process group is stopped and its run directory removed. */
export async function abandonLaunch(deps: RunControlDeps, runs: string, runId: string, pid: number): Promise<void> {
  if (isAlive(deps, pid)) await stop(deps, pid);
  await fs.rm(path.join(runs, runId), { recursive: true, force: true });
}

export function defaultRunControl(repoRoot: string): RunControlDeps {
  return {
    spawn: (a) => {
      const log = openSync(a.logFile, 'a');
      // The SQLite warning would be the only line of ui.log and hide why a launch failed.
      const env = { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' ') };
      const child = nodeSpawn(a.bin, a.args, { cwd: a.cwd, env, detached: true, stdio: ['ignore', log, log] });
      child.unref();
      if (child.pid === undefined) throw new Error('spawn returned no pid');
      return { pid: child.pid };
    },
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw err;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    cliEntry: () => ({ bin: process.execPath, prefix: [path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(repoRoot, 'server', 'cli.ts')] }),
    repoRoot,
  };
}
