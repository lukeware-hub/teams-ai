import { spawn } from 'node:child_process';

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

/** Variables every tool needs to start; nothing else from the host leaks into a command (spec §14). */
function baseEnv(): Record<string, string> {
  const keep = ['PATH', 'HOME', 'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'USERPROFILE', 'LANG', 'LC_ALL', 'TERM'];
  const env: Record<string, string> = {};
  for (const k of keep) if (typeof process.env[k] === 'string') env[k] = process.env[k]!;
  return env;
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

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (current: string, chunk: Buffer) => {
      if (current.length >= limit) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString('utf8');
      if (next.length > limit) {
        truncated = true;
        return next.slice(0, limit);
      }
      return next;
    };
    child.stdout!.on('data', (c: Buffer) => (stdout = collect(stdout, c)));
    child.stderr!.on('data', (c: Buffer) => (stderr = collect(stderr, c)));

    const signal = (sig: NodeJS.Signals) => {
      try {
        if (posix && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signal('SIGKILL');
      }, 1_000).unref();
    }, spec.timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CommandError(`cannot run ${spec.bin}: ${err.message}`));
    });
    child.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, signal: sig, stdout, stderr, timedOut, durationMs: Date.now() - started, truncated });
    });

    child.stdin!.on('error', () => {
      /* child may exit before reading */
    });
    child.stdin!.end(spec.stdin ?? '');
  });
