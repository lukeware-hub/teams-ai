import path from 'node:path';
import { loadAgents } from '../agents/registry.js';
import { Accounting } from '../budget/accounting.js';
import { Governor } from '../budget/governor.js';
import { DEFAULT_BREAKER, QuotaBreaker } from '../budget/quota-breaker.js';
import { resolveProfile, type Config } from '../config/config.js';
import { loadSecrets } from '../core/secrets.js';
import { runAgentStep } from '../orchestrator/steps.js';
import { expandHome } from '../orchestrator/workspace.js';
import { runStep as runStepFn } from '../runner/step.js';
import type { RunAgent } from './cycle.js';

export interface AgentWiring {
  cfg: Config;
  agentsDir: string;
  hostEnv: NodeJS.ProcessEnv;
  secretsDir: string;
  workspacesRoot: string;
  claudeJsonPath?: string;
  runStep?: typeof runStepFn;
}

/** One governor, breaker and ledger for every refinement session of the UI process (spec §2). */
export async function makeRunAgent(w: AgentWiring): Promise<RunAgent> {
  const agents = await loadAgents(w.agentsDir);
  const governor = new Governor(w.cfg.concurrency.maxClaudeProcesses);
  const breaker = new QuotaBreaker(DEFAULT_BREAKER, () => new Date());
  const accounting = new Accounting();
  const binary = { bin: w.hostEnv.CLAUDE_BIN ?? 'claude', prefixArgs: [], env: {}, requireSandboxTools: process.platform === 'linux' };
  return async (req, ctx) => {
    const secrets = await loadSecrets(w.secretsDir);
    return runAgentStep(req, {
      runStep: w.runStep ?? runStepFn,
      stepDeps: {
        binary,
        caps: w.cfg.budgets.step,
        accounting,
        claudeJsonPath: w.claudeJsonPath ?? expandHome('~/.claude.json'),
        settingsDir: path.posix.join(req.cwd, 'settings'),
        workspacesRoot: w.workspacesRoot,
        network: { allowedDomains: [] },
        hostEnv: w.hostEnv,
      },
      agents,
      profile: (role) => resolveProfile(w.cfg, role, { confidential: false }),
      governor,
      breaker,
      journal: ctx.journal,
      stepDir: ctx.stepDir,
      secretValues: () => Object.values(secrets),
      specHash: ctx.specHash,
    });
  };
}
