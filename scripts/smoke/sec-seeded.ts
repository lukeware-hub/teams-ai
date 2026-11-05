import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parseAgentFile } from '../../server/agents/registry.js';
import { Accounting } from '../../server/budget/accounting.js';
import { runStep } from '../../server/runner/step.js';
import { secSeededProblems } from './sec-check.js';
import { SEC_CASES } from './sec-cases.js';

/** Live (costs real tokens): runs the sec review on each seeded case and exits non-zero when one is missed or falsely flagged. */
const agent = parseAgentFile(await fs.readFile(path.resolve('.claude/agents/sec.md'), 'utf8'), 'sec');
const accounting = new Accounting();
const specHash = `sha256:${'a'.repeat(64)}`;
const model = process.env.SMOKE_MODEL ?? 'sonnet';
const failures: string[] = [];
// A small root of its own: the sandbox denies reading every sibling of the workspaces root, and the shared temp folder has thousands.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-sec-seeded-'));

for (const c of SEC_CASES) {
  const cwd = await fs.mkdtemp(path.join(root, `${c.name}-`));
  await fs.writeFile(path.join(cwd, c.file), c.code);
  const outcome = await runStep(
    {
      kind: 'security',
      role: 'sec',
      agent,
      profile: { model },
      model,
      cwd,
      prompt: `Review task T1 (${c.task}). Read ${c.file} and report findings. specHash "${specHash}".`,
      expectedSpecHash: specHash,
      phase: 'smoke',
      taskId: `T1-${c.name}`,
      attempt: 1,
    },
    {
      binary: { bin: 'claude', prefixArgs: [], env: {}, requireSandboxTools: process.platform === 'linux' },
      caps: { timeoutMs: 180_000, maxTurns: 8 },
      accounting,
      claudeJsonPath: path.join(os.homedir(), '.claude.json'),
      settingsDir: path.join(os.homedir(), '.teams-ai', 'settings'),
      workspacesRoot: root,
      network: { allowedDomains: [] },
    },
  );
  const problems = secSeededProblems(outcome, c.file, c.flawed);
  console.log(`${c.name}: ${problems.length === 0 ? 'OK' : `FAILED - ${problems.join('; ')}`}`);
  if (problems.length > 0) failures.push(`${c.name}: ${problems.join('; ')}`);
  await fs.rm(cwd, { recursive: true, force: true });
}
await fs.rm(root, { recursive: true, force: true });
console.log(`usage: ${JSON.stringify(accounting.total())}`);
if (failures.length > 0) {
  console.error(`sec seeded FAILED:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`sec seeded OK: ${SEC_CASES.length} cases`);
