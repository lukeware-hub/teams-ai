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
