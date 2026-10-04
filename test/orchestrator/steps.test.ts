import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../../server/agents/registry.js';
import { Accounting } from '../../server/budget/accounting.js';
import { Governor } from '../../server/budget/governor.js';
import { QuotaBreaker } from '../../server/budget/quota-breaker.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { devPack, outputContract, planPack, reportPack, reviewPack, runAgentStep, type AgentStepDeps, type PackBase } from '../../server/orchestrator/steps.js';
import type { StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makePlanTask, makeProject, makeFrozenSpec } from '../fixtures/contracts.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const base: PackBase = { spec, project: makeProject(), specHash: HASH, assumptions: ['T0: db → sqlite'], budgetTokens: 8000 };
const task = makePlanTask({ id: 'T1', criteriaRefs: [spec.acceptanceCriteria[0]!.id] });
const summary = (over: Partial<ResultSummary> = {}): ResultSummary => ({
  found: true,
  isError: false,
  subtype: 'success',
  numTurns: 2,
  durationMs: 900,
  costUsd: 0.02,
  usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
  sessionId: null,
  resultText: null,
  structuredOutput: null,
  structuredSource: null,
  terminalReason: null,
  apiErrorStatus: null,
  rateLimit: null,
  compactions: 0,
  ...over,
});

let dir = '';
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = '';
});

async function deps(fake: (req: { kind: string; prompt: string }) => Promise<StepOutcome<unknown>>): Promise<AgentStepDeps & { journal: Journal }> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-steps-'));
  const journal = await Journal.open({ file: path.join(dir, 'events.ndjson'), runId: 'r1', specHash: HASH });
  const agents = await loadAgents(path.resolve('.claude/agents'));
  return {
    runStep: (async (req) => fake({ kind: req.kind, prompt: req.prompt })) as AgentStepDeps['runStep'],
    stepDeps: {
      binary: { bin: 'node', prefixArgs: [], env: {}, requireSandboxTools: false },
      caps: { timeoutMs: 1000, maxTurns: 5 },
      accounting: new Accounting(),
      claudeJsonPath: path.join(dir, '.claude.json'),
      settingsDir: path.join(dir, 'settings'),
      workspacesRoot: dir,
      network: { allowedDomains: [] },
    },
    agents,
    profile: () => ({ provider: 'claude', model: 'sonnet' }),
    governor: new Governor(3),
    breaker: new QuotaBreaker(),
    journal,
    stepDir: (seq) => path.join(dir, 'steps', String(seq)),
    secretValues: () => ['s3cr3t-value'],
    specHash: HASH,
  };
}

describe('packs', () => {
  it('dev pack carries the task, its criteria only, assumptions, handoffs, code and feedback', () => {
    const p = devPack(base, task, {
      code: { source: 'none' },
      handoffs: [{ taskId: 'T0', title: 'scaffold', summary: 'done', changedFiles: ['package.json'], mergedAt: '2026-09-24T10:00:00Z' }],
      feedback: 'gate unit-test failed: a::adds',
    });
    expect(p.kind).toBe('dev');
    expect(p.role).toBe('dev');
    expect(p.task).toEqual(task);
    expect(p.criteria.map((c) => c.id)).toEqual(task.criteriaRefs);
    expect(p.assumptions).toEqual(['T0: db → sqlite']);
    expect(p.handoffs).toHaveLength(1);
    expect(p.feedback).toBe('gate unit-test failed: a::adds');
    expect(p.outputContract).toBe(outputContract('dev'));
    expect(p.specHash).toBe(HASH);
  });

  it('review pack puts the diff and impact radius in feedback and code', () => {
    const p = reviewPack(base, task, { diffStat: ' src/a.ts | 2 +-', changedFiles: ['src/a.ts'], code: { source: 'graph', affected: [] }, profile: 'standard' });
    expect(p.kind).toBe('review');
    expect(p.role).toBe('test');
    expect(p.feedback).toContain('src/a.ts');
    expect(p.code?.source).toBe('graph');
  });

  it('report pack lists the security findings for the SM summary', () => {
    const opts = { delivered: ['T1'], blocked: [], evidence: '[]', assumptions: [], deploy: '{}', tokens: '{}' };
    expect(reportPack(base, { ...opts, security: '- T1 src/a.ts:3 [low] logging: verbose log' }).feedback).toContain('[low] logging: verbose log');
    expect(reportPack(base, { ...opts, security: '' }).feedback).toContain('Security findings left by the sec review');
  });

  it('plan pack carries every criterion, the human tasks and god nodes', () => {
    const p = planPack(
      { ...base, spec: { ...spec, tasks: [{ title: 'Login', description: 'basic login' }] } },
      { techSpecText: '# Tech spec', godNodes: [{ label: 'server/app.ts', edges: 12 }], feedback: null },
    );
    expect(p.kind).toBe('plan');
    expect(p.criteria).toHaveLength(spec.acceptanceCriteria.length);
    expect(p.techSpecExcerpt).toBe('# Tech spec');
    expect(p.feedback).toContain('Login');
    expect(p.feedback).toContain('server/app.ts');
  });

  it('plan pack states the validator rules up front so the SM does not learn them by rejection', () => {
    const first = planPack(base, { techSpecText: '# t', godNodes: [], feedback: null, firstSpec: true });
    expect(first.feedback).toContain('T0-scaffold');
    expect(first.feedback).toContain('devops');
    for (const gate of ['format', 'lint', 'unit-test', 'build', 'secret-scan']) expect(first.feedback).toContain(gate);
    const later = planPack(base, { techSpecText: '# t', godNodes: [], feedback: null, firstSpec: false });
    expect(later.feedback).not.toContain('creates the project skeleton');
    expect(later.feedback).toContain('secret-scan');
  });

  it('output contract states the JSON schema of the kind', () => {
    expect(outputContract('dev')).toContain('"specHash"');
    expect(outputContract('dev')).toContain('commitMessage');
  });
});

describe('runAgentStep', () => {
  it('journals STEP_STARTED/FINISHED, writes prompt and output files, and books through the runner', async () => {
    const d = await deps(async () => ({
      ok: true,
      value: { specHash: HASH, status: 'done', summary: 'ok', changedFiles: [], commitMessage: 'feat: x' },
      summary: summary(),
    }));
    const out = await runAgentStep(
      { kind: 'dev', role: 'dev', pack: devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }), cwd: dir, phase: 'phase3', taskId: 'T1', attempt: 1 },
      d,
    );
    expect(out.ok).toBe(true);
    const types = d.journal.events.map((e) => e.type);
    expect(types).toEqual([OrchEvent.StepStarted, OrchEvent.StepFinished]);
    expect(d.journal.events[0]!.data).toMatchObject({ stepId: 's00001', kind: 'dev', role: 'dev', taskId: 'T1', attempt: 1 });
    expect(d.journal.events[1]!.data).toMatchObject({ stepId: 's00001', ok: true, usage: { inputTokens: 1200, outputTokens: 80 } });
    expect(await fs.readFile(path.join(dir, 'steps', '1', 'prompt.md'), 'utf8')).toContain('T1');
    expect(JSON.parse(await fs.readFile(path.join(dir, 'steps', '1', 'output.json'), 'utf8'))).toMatchObject({ ok: true, value: { commitMessage: 'feat: x' } });
  });

  it('redacts secret values from the step output before journaling', async () => {
    const d = await deps(async () => ({
      ok: false,
      failure: 'code',
      errors: ['token s3cr3t-value rejected'],
      summary: summary({ isError: true }),
      sandboxDisabled: false,
    }));
    const out = await runAgentStep(
      { kind: 'dev', role: 'dev', pack: devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }), cwd: dir, phase: 'phase3', taskId: 'T1', attempt: 1 },
      d,
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors).toEqual(['token [REDACTED] rejected']);
    expect(JSON.stringify(d.journal.events)).not.toContain('s3cr3t-value');
    expect(await fs.readFile(path.join(dir, 'steps', '1', 'output.json'), 'utf8')).not.toContain('s3cr3t-value');
  });

  it('feeds the breaker on quota failures and holds the governor while the step runs', async () => {
    let active = 0;
    let peak = 0;
    const d = await deps(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return {
        ok: false,
        failure: 'quota',
        errors: ['usage limit'],
        summary: summary({
          isError: true,
          rateLimit: { status: 'rejected', resetsAt: 4102444800, fiveHourUtilization: 1, fiveHourResetsAt: 4102444800, sevenDayUtilization: 0.5, sevenDayResetsAt: 4102444800 },
        }),
        sandboxDisabled: false,
      };
    });
    d.governor.setLimit(1);
    const req = {
      kind: 'dev' as const,
      role: 'dev' as const,
      pack: devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }),
      cwd: dir,
      phase: 'phase3',
      taskId: 'T1',
      attempt: 1,
    };
    await Promise.all([runAgentStep(req, d), runAgentStep(req, d)]);
    expect(peak).toBe(1);
    expect(d.breaker.canStart()).toBe(false);
  });
  it('gives concurrent steps distinct step ids and directories', async () => {
    const d = await deps(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { ok: true, value: { specHash: HASH, status: 'done', summary: 'ok', changedFiles: [], commitMessage: 'feat: x' }, summary: summary() };
    });
    const req = { kind: 'dev' as const, role: 'dev' as const, pack: devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }), cwd: dir, phase: 'phase3', taskId: 'T1', attempt: 1 };
    await Promise.all([runAgentStep(req, d), runAgentStep({ ...req, taskId: 'T2' }, d)]);
    const started = d.journal.events.filter((e) => e.type === OrchEvent.StepStarted).map((e) => e.data.stepId);
    expect(new Set(started).size).toBe(2);
  });

  it('redacts secret values inside the returned value, not only in the files', async () => {
    const d = await deps(async () => ({ ok: true, value: { specHash: HASH, status: 'done', summary: 'token s3cr3t-value leaked', changedFiles: [], commitMessage: 'feat: s3cr3t-value' }, summary: summary() }));
    const out = await runAgentStep({ kind: 'dev', role: 'dev', pack: devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }), cwd: dir, phase: 'phase3', taskId: 'T1', attempt: 1 }, d);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(JSON.stringify(out.value)).not.toContain('s3cr3t-value');
    expect((out.value as unknown as { commitMessage: string }).commitMessage).toBe('feat: [REDACTED]');
  });

  it('a request model and effort override the role profile for that step only', async () => {
    const d = await deps(async () => ({ ok: true, value: { specHash: HASH, status: 'done', summary: 's', changedFiles: [], commitMessage: 'm' }, summary: summary() }));
    // The harness fake sees only {kind, prompt}; wrap runStep to capture the full StepRequest.
    const seen: unknown[] = [];
    const inner = d.runStep;
    d.runStep = (async (req, sd) => { seen.push(req); return inner(req, sd); }) as AgentStepDeps['runStep'];
    await runAgentStep({ kind: 'dev', role: 'dev', pack: devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }), cwd: dir, phase: 'phase3', taskId: 'T1', attempt: 1, model: 'haiku', effort: 'low' }, d);
    expect(seen[0]).toMatchObject({ model: 'haiku', effort: 'low', profile: { provider: 'claude', model: 'sonnet' } });
  });
});
