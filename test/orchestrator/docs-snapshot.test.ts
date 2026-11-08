import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../../server/agents/registry.js';
import { Accounting } from '../../server/budget/accounting.js';
import { Governor } from '../../server/budget/governor.js';
import { QuotaBreaker } from '../../server/budget/quota-breaker.js';
import { Journal } from '../../server/orchestrator/events.js';
import { devPack, runAgentStep, snapshotGrant, sourceFiles, type AgentStepDeps, type PackBase } from '../../server/orchestrator/steps.js';
import { absoluteRule } from '../../server/runner/role-settings.js';
import type { StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makeFrozenSpec, makePlanTask, makeProject } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const SNAPSHOT_DOCS = ['docs/project.md', 'docs/stack.md', 'docs/flow.md', 'docs/design.md', 'docs/briefing.md'];
const PLAN = 'docs/specify/orders-001/plan.md';
const TASK = 'docs/specify/orders-001/task.md';
const task = makePlanTask({ id: 'T1', criteriaRefs: [spec.acceptanceCriteria[0]!.id], affectedPaths: ['src'] });
const summary = (): ResultSummary => ({
  found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0,
});
const DONE = { specHash: HASH, status: 'done', summary: 'ok', changedFiles: [], commitMessage: 'feat: x' };

let dir: string;
let snapshot: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-docs-snapshot-'));
  snapshot = path.join(dir, 'docs-at', 'draft-1');
  for (const file of [...SNAPSHOT_DOCS, PLAN, TASK]) {
    await fs.mkdir(path.dirname(path.join(snapshot, file)), { recursive: true });
    await fs.writeFile(path.join(snapshot, file), `# ${file}\n`);
  }
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const base = (over: Partial<PackBase> = {}): PackBase => ({ spec, project: makeProject(), specHash: HASH, assumptions: [], budgetTokens: 8000, ...over });

describe('documents of a snapshot (plan 119, I8 item 1)', () => {
  it('names the source files store-relative and finds them under the snapshot root', async () => {
    const files = await sourceFiles(snapshot, PLAN, 'orders-001', TASK);
    expect(files).toEqual([PLAN, TASK, ...SNAPSHOT_DOCS]);
  });

  it('grants a read of the snapshot root and its folders, and no write', () => {
    const grant = snapshotGrant(snapshot);
    expect(grant).toEqual([`Read(${absoluteRule(snapshot)})`, `Read(${absoluteRule(snapshot)}/**)`]);
    expect(grant.some((rule) => !rule.startsWith('Read('))).toBe(false);
    expect(snapshotGrant(undefined)).toEqual([]);
  });

  it('gives every agent step the snapshot grant, next to its own extraAllow', async () => {
    const seen: string[][] = [];
    const deps = await stepDeps(seen);
    deps.docsRoot = snapshot;
    const pack = devPack(base({ docsRoot: snapshot }), task, { code: { source: 'none' }, handoffs: [], feedback: null });
    await runAgentStep({ kind: 'dev', role: 'dev', pack, cwd: dir, phase: 'phase3', taskId: 'T1', attempt: 1, extraAllow: ['Bash(npm test:*)'] }, deps);
    expect(seen[0]).toEqual(['Bash(npm test:*)', ...snapshotGrant(snapshot)]);
  });

  it('prints the snapshot paths of the plan and of the five documents in the pack', () => {
    const pack = devPack(base({ docsRoot: snapshot, planFile: PLAN, taskFile: TASK }), task, { code: { source: 'none' }, handoffs: [], feedback: null, plan: { file: PLAN, ids: ['T1'] } });
    const text = pack.principles.join('\n');
    expect(text).toContain(`${snapshot}/${PLAN}`);
    expect(text).toContain(`${snapshot}/docs/project.md`);
    expect(text).not.toContain('docs/specs/');
  });
});

async function stepDeps(seen: string[][]): Promise<AgentStepDeps & { journal: Journal }> {
  const journal = await Journal.open({ file: path.join(dir, 'events.ndjson'), runId: 'r1', specHash: HASH });
  return {
    runStep: (async (req: { extraAllow?: readonly string[] }) => {
      seen.push([...(req.extraAllow ?? [])]);
      return { ok: true, value: DONE, summary: summary() } as StepOutcome<unknown>;
    }) as AgentStepDeps['runStep'],
    stepDeps: {
      binary: { bin: 'node', prefixArgs: [], env: {}, requireSandboxTools: false },
      caps: { timeoutMs: 1000, maxTurns: 5 },
      accounting: new Accounting(),
      claudeJsonPath: path.join(dir, '.claude.json'),
      settingsDir: path.join(dir, 'settings'),
      workspacesRoot: dir,
      network: { allowedDomains: [] },
    } as AgentStepDeps['stepDeps'],
    agents: await loadAgents(path.resolve('.claude/agents')),
    profile: () => ({ model: 'sonnet' }) as never,
    governor: new Governor(3),
    breaker: new QuotaBreaker(),
    journal,
    stepDir: (seq) => path.join(dir, 'steps', String(seq)),
    secretValues: () => [],
    defaultEffort: 'low',
    specHash: HASH,
  } as AgentStepDeps & { journal: Journal };
}

describe('a required document missing from the snapshot (plan 119, I8 item 2)', () => {
  it('fails naming the missing document', async () => {
    await fs.rm(path.join(snapshot, 'docs/stack.md'));
    await expect(sourceFiles(snapshot, PLAN, 'orders-001', TASK, true)).rejects.toThrow('docs/stack.md');
  });

  it('fails naming the missing plan of the spec', async () => {
    await fs.rm(path.join(snapshot, PLAN));
    await expect(sourceFiles(snapshot, PLAN, 'orders-001', TASK, true)).rejects.toThrow(PLAN);
  });

  it('keeps the legacy silent skip of a missing plan', async () => {
    const legacy = path.join(dir, 'legacy');
    await fs.mkdir(path.join(legacy, 'docs'), { recursive: true });
    await fs.writeFile(path.join(legacy, 'docs', 'project.md'), 'p');
    expect(await sourceFiles(legacy, 'docs/specs/orders-001/implementation-plan.md', 'orders-001')).toEqual(['docs/project.md']);
  });
});
