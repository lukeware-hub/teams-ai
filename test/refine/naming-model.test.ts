import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunControlDeps } from '../../server/api/run-control.js';
import { readUserConfig } from '../../server/onboarding/config-store.js';
import type { RunAgent } from '../../server/refine/cycle.js';
import { SessionRegistry } from '../../server/refine/registry.js';

let home = '';

afterEach(async () => {
  if (home) await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  home = '';
});

/** A registry on a config holding the given routing, whose name agent records the model and effort of each step it runs. */
async function registryWith(routing: Record<string, unknown>) {
  home = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-naming-'))).replace(/\\/g, '/');
  await fs.mkdir(`${home}/.teams-ai`, { recursive: true });
  await fs.writeFile(`${home}/.teams-ai/config.json`, JSON.stringify({ paths: { workspaces: `${home}/ws`, runs: `${home}/runs`, secrets: `${home}/secrets` }, routing }));
  const asked: Array<{ model?: string; effort?: string }> = [];
  const runAgent = (async (req: { model?: string; effort?: string }, ctx: { specHash: string }) => {
    asked.push({ model: req.model, effort: req.effort });
    return { ok: true, value: { specHash: ctx.specHash, id: 'login-flow' }, summary: {} };
  }) as unknown as RunAgent;
  const registry = new SessionRegistry({
    cfg: async () => (await readUserConfig(home)).cfg,
    home,
    runAgent,
    secretsDir: `${home}/secrets`,
    exec: (async () => { throw new Error('no exec'); }) as never,
    projectDir: async () => null,
    control: {} as RunControlDeps,
    runsDir: async () => `${home}/runs`,
    register: async () => undefined,
  });
  return { registry, asked };
}

describe('suggestName', () => {
  it('asks the naming model and the naming effort the config sets, not the automatic effort', async () => {
    const { registry, asked } = await registryWith({ namingModel: 'claude-sonnet-5-5', namingEffort: 'medium', efforts: { automatic: 'high' } });
    expect(await registry.suggestName('spec', { projectId: 'hello-app', name: '', description: 'login' })).toEqual({ id: 'login-flow' });
    expect(asked).toEqual([{ model: 'claude-sonnet-5-5', effort: 'medium' }]);
  });
});
