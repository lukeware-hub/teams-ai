import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, DEFAULT_EFFORT_CAPS, loadConfig, type AgentSetting, type EffortCaps, type Role } from '../../server/config/config.js';
import { makeRunAgent } from '../../server/refine/agent.js';

const HASH = `sha256:${'a'.repeat(64)}`;
let dir = '';

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  dir = '';
});

/** A finished step's summary, with the fields the runner reads. */
const summary = { found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0 };

/** The refinement runner, with a fake step runner that records the model and effort of each step it runs. */
async function runnerWith(opts: { agentSettings?: (projectId: string) => Promise<Partial<Record<Role, AgentSetting | null>>>; caps?: EffortCaps; routing?: Record<string, unknown> } = {}) {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-wiring-'));
  const seen: Array<{ model: string; effort?: string }> = [];
  const runStep = async (req: { model: string; effort?: string }) => {
    seen.push({ model: req.model, effort: req.effort });
    return { ok: true, value: { specHash: HASH, id: 'login-flow' }, summary };
  };
  const run = await makeRunAgent({
    cfg: loadConfig({ routing: opts.routing ?? {} }),
    agentsDir: path.resolve('.claude/agents'),
    hostEnv: {},
    secretsDir: path.join(dir, 'secrets'),
    workspacesRoot: dir,
    runStep: runStep as never,
    agentSettings: opts.agentSettings ?? (async () => ({})),
    stepBudget: async () => DEFAULT_CONFIG.budgets.step,
    effortCaps: async () => opts.caps ?? DEFAULT_EFFORT_CAPS,
  });
  return { run, seen };
}

/** A step of the Dev role on no fixed model, so it takes the automatic choice unless a setting fixes it. */
const request = (effort?: 'max') => ({ kind: 'speckit', role: 'dev', pack: { kind: 'speckit', role: 'dev', specHash: HASH, principles: [], outputContract: '', criteria: [], feedback: 'Write the plan.', budgetTokens: 8000 }, cwd: dir, phase: 'refine', taskId: null, attempt: 1, ...(effort ? { effort } : {}) }) as never;

/** The per-step context a refinement step receives: its project, its journal and its step folder. */
const context = (projectId?: string) => ({ journal: { allocStepSeq: () => 1, fact: async () => undefined } as never, stepDir: (n: number) => path.join(dir, 'steps', String(n)), specHash: HASH, ...(projectId ? { projectId } : {}) });

/** A review step of the Test role with no effort asked and no line of its own in the routing, so it takes the automatic default. */
const review = () => ({ kind: 'review', role: 'test', pack: { kind: 'review', role: 'test', specHash: HASH, principles: [], outputContract: '', criteria: [], feedback: 'Review it.', budgetTokens: 4000 }, cwd: dir, phase: 'phase3', taskId: null, attempt: 1 }) as never;

describe('makeRunAgent effort', () => {
  it('holds an automatic step asked for max to the effort cap of its model family', async () => {
    const { run, seen } = await runnerWith({ agentSettings: async () => ({ dev: null }), caps: { haiku: 'low', sonnet: 'medium', opus: 'low' } });
    await run(request('max'), context('demo'));
    expect(seen).toEqual([{ model: 'claude-sonnet-5-5', effort: 'medium' }]);
  });

  it('runs a manual setting at its own effort, above the cap', async () => {
    const { run, seen } = await runnerWith({ agentSettings: async () => ({ dev: { model: 'claude-sonnet-5-5', effort: 'max' } }), caps: { haiku: 'low', sonnet: 'medium', opus: 'low' } });
    await run(request('max'), context('demo'));
    expect(seen).toEqual([{ model: 'claude-sonnet-5-5', effort: 'max' }]);
  });

  /** A name suggestion on the given model and effort, as the naming setting hands them over. */
  const naming = (model: string, effort: string) => ({ kind: 'name', role: 'po', pack: { kind: 'name', role: 'po', specHash: HASH, principles: [], outputContract: '', criteria: [], feedback: 'Name it.', budgetTokens: 4000 }, cwd: dir, phase: 'refine', taskId: null, attempt: 1, model, effort }) as never;

  it('runs a name suggestion on the naming model, not on the Product Owner default', async () => {
    const { run, seen } = await runnerWith();
    await run(naming('claude-haiku-5-5', 'low'), context());
    expect(seen).toEqual([{ model: 'claude-haiku-5-5', effort: 'low' }]);
  });

  it.each([
    { model: 'claude-haiku-5-5', asked: 'medium', effort: 'low' },
    { model: 'claude-sonnet-5-5', asked: 'max', effort: 'high' },
    { model: 'claude-sonnet-5-5', asked: 'medium', effort: 'medium' },
  ] as const)('runs a name suggestion on $model asked for $asked at $effort, held to the cap of its family', async ({ model, asked, effort }) => {
    const { run, seen } = await runnerWith();
    await run(naming(model, asked), context());
    expect(seen).toEqual([{ model, effort }]);
  });

  it.each(['medium', 'high'] as const)('runs an automatic review step with no line of its own at the default effort the config sets: %s', async (automatic) => {
    const { run, seen } = await runnerWith({ routing: { efforts: { automatic } }, agentSettings: async () => ({ test: null }) });
    await run(review(), context('demo'));
    expect(seen).toEqual([{ model: 'claude-sonnet-5-5', effort: automatic }]);
  });
});
