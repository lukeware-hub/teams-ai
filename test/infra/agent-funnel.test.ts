import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve('.');
/** The files that define the two functions which start a Claude process with a prompt. */
const DEFINING = ['server/runner/invocation.ts', 'server/runner/process-runner.ts'];
/** The only importers allowed: the step runner, and a probe that runs one invocation by hand. */
const ALLOWED = ['server/runner/step.ts', 'scripts/wsl/probes/p8-agent-reach.ts'];
const IMPORTS_SPAWNER = /import\s*\{[^}]*\b(buildInvocation|runProcess)\b[^}]*\}\s*from/;

/** Every TypeScript source under `dir`, tests and dependencies left out. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(file);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [file] : [];
  });
}

describe('the agent funnel', () => {
  // A new caller of these functions must be read against the global rules before it is listed here.
  it('lets only the step runner and the listed probe start a Claude process with a prompt', () => {
    const importers = [...sources(path.join(ROOT, 'server')), ...sources(path.join(ROOT, 'scripts'))]
      .map((file) => path.relative(ROOT, file).replace(/\\/g, '/'))
      .filter((file) => !DEFINING.includes(file) && IMPORTS_SPAWNER.test(readFileSync(path.join(ROOT, file), 'utf8')));
    expect(importers.sort()).toEqual([...ALLOWED].sort());
  });
});
