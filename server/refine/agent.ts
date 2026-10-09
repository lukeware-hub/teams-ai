import path from 'node:path';
import type { StepKind } from '../agents/outputs.js';
import { loadAgents } from '../agents/registry.js';
import { Accounting } from '../budget/accounting.js';
import { Governor } from '../budget/governor.js';
import { DEFAULT_BREAKER, QuotaBreaker } from '../budget/quota-breaker.js';
import type { Config } from '../config/config.js';
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

/** From the second cycle on, `laterCycleModels` wins over `stepModels`. */
export function refineStepModel(routing: Config['routing'], kind: StepKind, cycle: number): string | undefined {
  return (cycle > 1 ? routing.laterCycleModels[kind] : undefined) ?? routing.stepModels[kind];
}

/** One governor, breaker and ledger for every refinement session of the UI process (spec §2). */
export async function makeRunAgent(w: AgentWiring): Promise<RunAgent> {
  const agents = await loadAgents(w.agentsDir);
  const governor = new Governor(w.cfg.concurrency.maxClaudeProcesses);
  const breaker = new QuotaBreaker(DEFAULT_BREAKER, () => new Date());
  const accounting = new Accounting();
  const binary = { bin: w.hostEnv.CLAUDE_BIN ?? 'claude', prefixArgs: [], env: {}, requireSandboxTools: process.platform === 'linux' };
  return async (req, ctx) => {
    const { ANTHROPIC_API_KEY: apiKey, ...secrets } = await loadSecrets(w.secretsDir);
    if (w.cfg.claude.auth === 'api-key' && !apiKey) throw new Error('claude.auth is "api-key" but the secret ANTHROPIC_API_KEY is not set');
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
        ...(w.cfg.claude.auth === 'api-key' && apiKey ? { apiKey } : {}),
        signal: ctx.signal,
      },
      agents,
      profile: (role) => w.cfg.roles[role],
      governor,
      breaker,
      journal: ctx.journal,
      stepDir: ctx.stepDir,
      secretValues: () => [...Object.values(secrets), ...(apiKey ? [apiKey] : [])],
      stepModel: (kind, cycle) => refineStepModel(w.cfg.routing, kind, cycle),
      specHash: ctx.specHash,
    });
  };
}
