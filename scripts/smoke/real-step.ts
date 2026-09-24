import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parseAgentFile } from '../../server/agents/registry.js';
import { Accounting } from '../../server/budget/accounting.js';
import { QuotaBreaker } from '../../server/budget/quota-breaker.js';
import { runStep } from '../../server/runner/step.js';

const agent = parseAgentFile(await fs.readFile(path.resolve('.claude/agents/dev.md'), 'utf8'), 'dev');
const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-smoke-'));
const accounting = new Accounting();
const breaker = new QuotaBreaker();
const specHash = `sha256:${'a'.repeat(64)}`;

const provider = process.env.SMOKE_PROVIDER === 'omniroute' ? 'omniroute' : 'claude';
if (provider === 'omniroute' && !process.env.OMNIROUTE_TOKEN) {
  console.error('OMNIROUTE_TOKEN is required for the omniroute provider (an empty token could fall back to the subscription login)');
  process.exit(2);
}
const model = process.env.SMOKE_MODEL ?? (provider === 'omniroute' ? 'kimi/k2' : 'sonnet');

const outcome = await runStep(
  {
    kind: 'dev',
    role: 'dev',
    agent,
    profile: { provider, model },
    model,
    cwd,
    prompt: `Do not touch any file. Return status "done", summary "smoke", commitMessage "chore: smoke", changedFiles [] and specHash "${specHash}".`,
    expectedSpecHash: specHash,
    phase: 'smoke',
    taskId: null,
    attempt: 1,
    omniroute: provider === 'omniroute' ? { baseUrl: 'http://localhost:20128', token: process.env.OMNIROUTE_TOKEN!, compactWindow: 120000 } : undefined,
  },
  {
    binary: { bin: 'claude', prefixArgs: [], env: {}, requireSandboxTools: process.platform === 'linux' },
    caps: { timeoutMs: 120_000, maxTurns: 6 },
    accounting,
    claudeJsonPath: path.join(os.homedir(), '.claude.json'),
    settingsDir: path.join(os.homedir(), '.teams-ai', 'settings'),
    workspacesRoot: os.tmpdir(),
    network: { allowedDomains: ['registry.npmjs.org'] },
    onEvent: (line) => {
      if (line.includes('"type":"result"') || line.includes('rate_limit_event')) console.error(line);
    },
  },
);
breaker.observe(outcome.summary.rateLimit);
console.log(
  JSON.stringify(
    {
      provider,
      model,
      ok: outcome.ok,
      failure: outcome.ok ? null : outcome.failure,
      errors: outcome.ok ? [] : outcome.errors.slice(0, 3),
      resultText: outcome.summary.resultText?.slice(0, 800) ?? null,
      structuredOutput: outcome.summary.structuredOutput,
      numTurns: outcome.summary.numTurns,
      usage: accounting.total(),
      breaker: breaker.state(),
    },
    null,
    2,
  ),
);
await fs.rm(cwd, { recursive: true, force: true });
