/**
 * Manual, live: three Jev calls through OpenRouter (well under a cent in total). Run from WSL or Windows:
 *   npx tsx scripts/integration/jev-smoke.ts
 * Reads OPENROUTER_API_KEY from ~/.teams-ai/secrets (override the directory with TEAMS_AI_SECRETS_DIR).
 * Never part of `npm test`.
 */
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../../server/config/config.js';
import { Gate } from '../../server/contracts/plan.js';
import { loadSecrets } from '../../server/core/secrets.js';
import { gateTriageQuestions, gateTriageState } from '../../server/decide/decisions/gate-triage.js';
import { JevOpenRouterBackend } from '../../server/decide/jev-openrouter.js';
import type { GateResult } from '../../server/exec/gate-runner.js';

const secretsDir = process.env.TEAMS_AI_SECRETS_DIR ?? path.join(os.homedir(), '.teams-ai', 'secrets');
const secrets = await loadSecrets(secretsDir);
const key = secrets.OPENROUTER_API_KEY;
if (!key) {
  console.error(`OPENROUTER_API_KEY not found in ${secretsDir}`);
  process.exit(2);
}

const o = DEFAULT_CONFIG.decisions.openrouter;
const jev = new JevOpenRouterBackend({
  fetch: globalThis.fetch,
  apiKey: key,
  baseUrl: o.baseUrl,
  model: o.model,
  timeoutMs: o.timeoutMs,
  maxTries: o.maxTries,
  backoffMs: o.backoffMs,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

const gate = Gate.parse({ name: 'unit-test', command: 'npm test', blocking: true });
const base: Omit<GateResult, 'stdoutTail' | 'stderrTail' | 'junit' | 'durationMs'> = {
  name: 'unit-test',
  blocking: true,
  passed: false,
  exitCode: 1,
  timedOut: false,
  failure: 'code',
};
const cases: Array<{ label: string; result: GateResult }> = [
  {
    label: 'expect code',
    result: {
      ...base,
      durationMs: 3100,
      junit: [{ id: 'sum::adds', name: 'adds', classname: 'sum', status: 'failed', acIds: [] }],
      stdoutTail: 'FAIL test/sum.test.ts > adds\nAssertionError: expected 3 to be 4',
      stderrTail: '',
    },
  },
  {
    label: 'expect dependency',
    result: {
      ...base,
      durationMs: 12000,
      junit: null,
      stdoutTail: '',
      stderrTail: 'npm ERR! code ETARGET\nnpm ERR! notarget No matching version found for left-pad@9.9.9',
    },
  },
  {
    label: 'expect flaky-test',
    result: {
      ...base,
      durationMs: 9000,
      junit: [{ id: 'server::listens', name: 'listens', classname: 'server', status: 'failed', acIds: [] }],
      stdoutTail: 'FAIL test/server.test.ts > listens\nError: listen EADDRINUSE: address already in use :::3000',
      stderrTail: '',
    },
  },
];

for (const c of cases) {
  const started = Date.now();
  const r = await jev.evaluate({ state: gateTriageState(gate, c.result), questions: gateTriageQuestions(), escalateTo: 'test' });
  console.log(`== ${c.label} (${Date.now() - started} ms)`);
  console.log(JSON.stringify(r, null, 2));
}
