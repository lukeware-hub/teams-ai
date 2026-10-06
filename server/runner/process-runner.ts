import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Invocation } from './invocation.js';
import { parseStreamJson, summarizeStream, type ParsedStream, type ResultSummary } from './stream-events.js';

export interface RunnerBinary {
  bin: string;
  prefixArgs: readonly string[];
  /** Extra environment for the binary itself (test scenarios for the fake claude); never secrets. */
  env: Record<string, string>;
  /** Fail before spawning when bubblewrap/socat are missing (always true on the WSL host). */
  requireSandboxTools: boolean;
}

export interface ProcessCaps {
  timeoutMs: number;
  /** Assistant turns (distinct message ids) allowed before the process is killed; CLI 2.1.281 has no --max-turns. */
  maxTurns: number;
  killGraceMs?: number;
}

export type KillReason = 'timeout' | 'turns' | 'environment' | 'aborted' | null;

export interface RawStepResult {
  parsed: ParsedStream;
  summary: ResultSummary;
  stderr: string;
  exitCode: number | null;
  killedBy: KillReason;
  sandboxDisabled: boolean;
  durationMs: number;
  turns: number;
}

/** Findings row 5: the CLI runs unsandboxed when bubblewrap/socat are missing and only warns on stderr. */
export const SANDBOX_DISABLED_PATTERN = /Sandbox disabled/;
export const SANDBOX_TOOLS = ['bwrap', 'socat'] as const;

const STDERR_LIMIT = 64 * 1024;
const DRAIN_MS = 1_000;

/** Returns the sandbox tools missing from PATH. */
export async function preflightSandbox(env: NodeJS.ProcessEnv): Promise<string[]> {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const missing: string[] = [];
  for (const tool of SANDBOX_TOOLS) {
    let found = false;
    for (const dir of dirs) {
      try {
        await fs.access(path.join(dir, tool));
        found = true;
        break;
      } catch {
        /* keep looking */
      }
    }
    if (!found) missing.push(tool);
  }
  return missing;
}

function messageId(line: string): string | null {
  if (!line.includes('"type":"assistant"')) return null;
  try {
    const event = JSON.parse(line) as { type?: string; message?: { id?: string } };
    return event.type === 'assistant' ? (event.message?.id ?? `line:${line.length}:${Math.random()}`) : null;
  } catch {
    return null;
  }
}

export function runProcess(
  binary: RunnerBinary,
  invocation: Invocation,
  caps: ProcessCaps,
  onEvent?: (line: string) => void,
  abortSignal?: AbortSignal,
): Promise<RawStepResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const posix = process.platform !== 'win32';
    const child = spawn(binary.bin, [...binary.prefixArgs, ...invocation.args], {
      cwd: invocation.cwd,
      env: { ...invocation.env, ...binary.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // A process group lets the kill reach grandchildren (npm test, dev servers) too.
      detached: posix,
    });

    const lines: string[] = [];
    const turnIds = new Set<string>();
    let stderr = '';
    let killedBy: KillReason = null;
    let settled = false;
    let graceTimer: NodeJS.Timeout | null = null;
    let drainTimer: NodeJS.Timeout | null = null;

    const signal = (sig: NodeJS.Signals) => {
      try {
        if (posix && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* already gone */
      }
    };

    const kill = (reason: Exclude<KillReason, null>) => {
      if (killedBy) return;
      killedBy = reason;
      signal('SIGTERM');
      graceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signal('SIGKILL');
      }, caps.killGraceMs ?? 2_000);
      graceTimer.unref();
    };

    const timer = setTimeout(() => kill('timeout'), caps.timeoutMs);
    const onAbort = () => kill('aborted');
    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (drainTimer) clearTimeout(drainTimer);
      const parsed = parseStreamJson(lines.join('\n'));
      resolve({
        parsed,
        summary: summarizeStream(parsed),
        stderr,
        exitCode: code,
        killedBy,
        sandboxDisabled: SANDBOX_DISABLED_PATTERN.test(stderr),
        durationMs: Date.now() - started,
        turns: turnIds.size,
      });
    };

    const stdout = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    stdout.on('line', (line) => {
      lines.push(line);
      onEvent?.(line);
      const id = messageId(line);
      if (id) {
        turnIds.add(id);
        if (turnIds.size > caps.maxTurns) kill('turns');
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8');
      // Fail closed the moment the CLI admits it is running unsandboxed.
      if (SANDBOX_DISABLED_PATTERN.test(stderr)) kill('environment');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      reject(err);
    });

    // `exit` fires when the child is gone even if a grandchild still holds stdout; give the
    // pipes a bounded time to drain, then settle on whatever arrived.
    child.on('exit', (code) => {
      drainTimer = setTimeout(() => finish(code), DRAIN_MS);
      drainTimer.unref();
    });
    child.on('close', (code) => finish(code));

    child.stdin!.on('error', () => {
      /* the child may exit before reading its prompt */
    });
    child.stdin!.end(invocation.stdin);
  });
}
