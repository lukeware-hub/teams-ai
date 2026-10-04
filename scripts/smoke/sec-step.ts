import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parseAgentFile } from '../../server/agents/registry.js';
import { Accounting } from '../../server/budget/accounting.js';
import { runStep } from '../../server/runner/step.js';

const agent = parseAgentFile(await fs.readFile(path.resolve('.claude/agents/sec.md'), 'utf8'), 'sec');
const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-sec-smoke-'));
await fs.writeFile(
  path.join(cwd, 'greet.js'),
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
    prompt: `Review task T1 (adds greet(name) in greet.js, which echoes a greeting for a user-supplied name). Read greet.js and report findings. specHash "${specHash}".`,
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
