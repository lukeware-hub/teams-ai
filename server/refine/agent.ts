import path from 'node:path';
import type { StepKind } from '../agents/outputs.js';
import { loadAgents } from '../agents/registry.js';
import { Accounting } from '../budget/accounting.js';
import { Governor } from '../budget/governor.js';
import { DEFAULT_BREAKER, QuotaBreaker } from '../budget/quota-breaker.js';
import { manualAgentSettings, type AgentSetting, type Config, type Role } from '../config/config.js';
import { loadSecrets } from '../core/secrets.js';
import { runAgentStep } from '../orchestrator/steps.js';
import { expandHome } from '../orchestrator/workspace.js';
import { agentPluginsRoot } from '../skills/plugins.js';
import { runStep as runStepFn } from '../runner/step.js';
import type { RunAgent } from './cycle.js';
import { abortableSleep, withQuotaWait } from './quota-wait.js';

export interface AgentWiring {
  cfg: Config;
  agentsDir: string;
  hostEnv: NodeJS.ProcessEnv;
  secretsDir: string;
  workspacesRoot: string;
  claudeJsonPath?: string;
  runStep?: typeof runStepFn;
  /** The agent settings of one project, read per step so a change applies to the next step. */
  agentSettings?: (projectId: string) => Promise<Partial<Record<Role, AgentSetting | null>>>;
  /** The step budget of one project, read per step so a time limit changed in Settings applies to the next step. */
  stepBudget?: (projectId: string) => Promise<Config['budgets']['step']>;
  /** The agents that prepare the plan items at once; the governor admits that many steps, read per step. */
  speckitAgents?: () => Promise<number>;
}

/** From the second cycle on, `laterCycleModels` wins over `stepModels`. */
export function refineStepModel(routing: Config['routing'], kind: StepKind, cycle: number): string | undefined {
  return (cycle > 1 ? routing.laterCycleModels[kind] : undefined) ?? routing.stepModels[kind];
}

/** Where a step's settings go: a plan step works in the folder that is published, so its settings sit beside it. */
export const refineSettingsDir = (req: { kind: StepKind; cwd: string }): string => (req.kind === 'speckit' ? `${req.cwd}-settings` : path.posix.join(req.cwd, 'settings'));

/** One governor, breaker and ledger for every refinement session of the UI process (spec §2). */
export async function makeRunAgent(w: AgentWiring): Promise<RunAgent & { resetQuota(): void }> {
  const agents = await loadAgents(w.agentsDir);
  const governor = new Governor(w.cfg.concurrency.maxClaudeProcesses);
  const breaker = new QuotaBreaker(DEFAULT_BREAKER, () => new Date());
  const accounting = new Accounting();
  const binary = { bin: w.hostEnv.CLAUDE_BIN ?? 'claude', prefixArgs: [], env: {}, requireSandboxTools: process.platform === 'linux' };
  const run: RunAgent = async (req, ctx) => {
    if (w.speckitAgents) governor.setLimit(Math.max(w.cfg.concurrency.maxClaudeProcesses, await w.speckitAgents()));
    const { ANTHROPIC_API_KEY: apiKey, ...secrets } = await loadSecrets(w.secretsDir);
    if (w.cfg.claude.auth === 'api-key' && !apiKey) throw new Error('claude.auth is "api-key" but the secret ANTHROPIC_API_KEY is not set');
    const settings = ctx.projectId && w.agentSettings ? await w.agentSettings(ctx.projectId) : {};
    const manual = manualAgentSettings(settings);
    const caps = ctx.projectId && w.stepBudget ? await w.stepBudget(ctx.projectId) : w.cfg.budgets.step;
    return runAgentStep(req, {
      agentSetting: (role) => manual[role],
      runStep: w.runStep ?? runStepFn,
      stepDeps: {
        binary,
        caps,
        accounting,
        claudeJsonPath: w.claudeJsonPath ?? expandHome('~/.claude.json'),
        settingsDir: refineSettingsDir(req),
        workspacesRoot: w.workspacesRoot,
        agentPluginsRoot: agentPluginsRoot(),
        skillsRoot: expandHome('~/.teams-ai/skills'),
        skillScope: ctx.projectId,
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
  return Object.assign(withQuotaWait(run, breaker, { sleep: abortableSleep, now: () => new Date(), log: (l) => process.stderr.write(`${l}\n`) }), { resetQuota: () => breaker.reset() });
}
