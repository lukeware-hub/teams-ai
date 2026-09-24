import { spawn } from 'node:child_process';
import { sanitizeEnv } from '../runner/invocation.js';

export interface PtySpec {
  bin: string;
  args: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface Pty {
  write(data: string): void;
  kill(): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
}

export type SpawnPty = (spec: PtySpec) => Pty;

/** POSIX single-quote quoting: safe for any byte except NUL. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The runner's allowlist plus HOME: CLIs need their config dirs; nothing else from the host (spec §7). */
export function childEnv(hostEnv: NodeJS.ProcessEnv = process.env, extra: Record<string, string> = {}): Record<string, string> {
  const env = sanitizeEnv(hostEnv);
  if (typeof hostEnv.HOME === 'string') env.HOME = hostEnv.HOME;
  return { ...env, ...extra };
}

export async function hasScript(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (process.platform === 'win32') return false;
  return new Promise((resolve) => {
    const p = spawn('script', ['--version'], { env: childEnv(env), stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

/**
 * Spec (onboarding) §3.3: util-linux `script` allocates a real pty so `claude` and `gh` behave as in a
 * terminal; we read its stdout and write its stdin. `-q` quiet, `-f` flush per write, `-e` return the
 * child's exit code, `-c` the command; the typescript file goes to /dev/null. The child runs in its own
 * process group so `kill` can end `script` and the CLI together: `script` treats SIGTERM as a normal end
 * and exits 0, so the group gets SIGKILL and the exit code is `null`.
 */
export const spawnScriptPty: SpawnPty = (spec) => {
  const command = [spec.bin, ...spec.args].map(shellQuote).join(' ');
  const child = spawn('script', ['-qfec', command, '/dev/null'], { cwd: spec.cwd, env: spec.env ?? childEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const dataCbs: Array<(chunk: string) => void> = [];
  const exitCbs: Array<(code: number | null) => void> = [];
  let exited = false;
  const emitData = (buf: Buffer) => {
    const text = buf.toString('utf8');
    for (const cb of dataCbs) cb(text);
  };
  child.stdout.on('data', emitData);
  child.stderr.on('data', emitData);
  child.on('error', () => {
    if (!exited) {
      exited = true;
      for (const cb of exitCbs) cb(null);
    }
  });
  child.on('exit', (code) => {
    if (!exited) {
      exited = true;
      for (const cb of exitCbs) cb(code);
    }
  });
  return {
    write: (data) => {
      if (!exited) child.stdin.write(data);
    },
    kill: () => {
      if (exited || child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    },
    onData: (cb) => void dataCbs.push(cb),
    onExit: (cb) => void exitCbs.push(cb),
  };
};
