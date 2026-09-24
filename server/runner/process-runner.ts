import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Invocation } from './invocation.js';
import { parseStreamJson, summarizeStream, type ParsedStream, type ResultSummary } from './stream-events.js';

export interface RunnerBinary {
  bin: string;
  prefixArgs: readonly string[];
}

export interface ProcessCaps {
  timeoutMs: number;
  /** Assistant turns allowed before the process is killed (CLI 2.1.281 has no --max-turns). */
  maxTurns: number;
  killGraceMs?: number;
}

export type KillReason = 'timeout' | 'turns' | null;

export interface RawStepResult {
  parsed: ParsedStream;
  summary: ResultSummary;
  stderr: string;
  exitCode: number | null;
  killedBy: KillReason;
  sandboxDisabled: boolean;
  durationMs: number;
}

/** Findings row 5: the CLI runs unsandboxed when bubblewrap/socat are missing and only warns on stderr. */
export const SANDBOX_DISABLED_PATTERN = /Sandbox disabled/;

const STDERR_LIMIT = 64 * 1024;

export function runProcess(
  binary: RunnerBinary,
  invocation: Invocation,
  caps: ProcessCaps,
  onEvent?: (line: string) => void,
): Promise<RawStepResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(binary.bin, [...binary.prefixArgs, ...invocation.args], {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const lines: string[] = [];
    let stderr = '';
    let turns = 0;
    let killedBy: KillReason = null;
    let settled = false;

    const kill = (reason: KillReason) => {
      if (killedBy) return;
      killedBy = reason;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
        else if (child.exitCode === null) child.kill('SIGKILL');
      }, caps.killGraceMs ?? 2_000).unref();
    };

    const timer = setTimeout(() => kill('timeout'), caps.timeoutMs);

    const stdout = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    stdout.on('line', (line) => {
      lines.push(line);
      onEvent?.(line);
      if (/"type":"assistant"/.test(line)) {
        turns += 1;
        if (turns > caps.maxTurns) kill('turns');
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = parseStreamJson(lines.join('\n'));
      resolve({
        parsed,
        summary: summarizeStream(parsed),
        stderr,
        exitCode: code,
        killedBy,
        sandboxDisabled: SANDBOX_DISABLED_PATTERN.test(stderr),
        durationMs: Date.now() - started,
      });
    });
  });
}
