import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parseAgentFile } from '../../server/agents/registry.js';
import { Accounting } from '../../server/budget/accounting.js';
import { runStep } from '../../server/runner/step.js';
import { secSmokeProblems } from './sec-check.js';

/** Command injection on purpose: the run only counts if sec flags this file. */
const VULNERABLE_FILE = 'greet.js';
const agent = parseAgentFile(await fs.readFile(path.resolve('.claude/agents/sec.md'), 'utf8'), 'sec');
const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-sec-smoke-'));
await fs.writeFile(
  path.join(cwd, VULNERABLE_FILE),
  `const { execSync } = require('node:child_process');\nexports.greet = (name) => execSync('echo hello ' + name).toString();\n`,
);
const accounting = new Accounting();
const specHash = `sha256:${'a'.repeat(64)}`;
const model = process.env.SMOKE_MODEL ?? 'sonnet';

const outcome = await runStep(
  {
    kind: 'security',
    role: 'sec',
    agent,
    profile: { provider: 'claude', model },
    model,
    cwd,
    prompt: `Review task T1 (adds greet(name) in ${VULNERABLE_FILE}, which echoes a greeting for a user-supplied name). Read ${VULNERABLE_FILE} and report findings. specHash "${specHash}".`,
    expectedSpecHash: specHash,
    phase: 'smoke',
    taskId: 'T1',
    attempt: 1,
  },
  {
    binary: { bin: 'claude', prefixArgs: [], env: {}, requireSandboxTools: process.platform === 'linux' },
    caps: { timeoutMs: 120_000, maxTurns: 6 },
    accounting,
    claudeJsonPath: path.join(os.homedir(), '.claude.json'),
    settingsDir: path.join(os.homedir(), '.teams-ai', 'settings'),
    workspacesRoot: os.tmpdir(),
    network: { allowedDomains: [] },
  },
);
console.log(
  JSON.stringify(
    { ok: outcome.ok, failure: outcome.ok ? null : outcome.failure, errors: outcome.ok ? [] : outcome.errors.slice(0, 3), structuredOutput: outcome.summary.structuredOutput, numTurns: outcome.summary.numTurns, usage: accounting.total() },
    null,
    2,
  ),
);
await fs.rm(cwd, { recursive: true, force: true });

// A smoke run that only prints is a check nobody reads: exit non-zero unless the reply passed the schema and flagged the seeded file.
const problems = secSmokeProblems(outcome, VULNERABLE_FILE);
if (problems.length > 0) {
  console.error(`sec smoke FAILED:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`sec smoke OK: the reply passed the schema and flags ${VULNERABLE_FILE}`);
