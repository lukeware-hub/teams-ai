import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../../server/agents/registry.js';
import { Accounting } from '../../server/budget/accounting.js';
import { Governor } from '../../server/budget/governor.js';
import { QuotaBreaker } from '../../server/budget/quota-breaker.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { devPack, devResumePrompt, outputContract, planPack, planRules, readmePack, reportPack, reviewPack, runAgentStep, type AgentStepDeps, type PackBase } from '../../server/orchestrator/steps.js';
import { saveSession } from '../../server/runner/session-store.js';
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

async function fakeHome(): Promise<string> {
  const home = path.join(dir, 'home');
  await fs.mkdir(path.join(home, '.claude', 'projects', '-x'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'projects', '-x', 'sess-1.jsonl'), '{}\n');
  return home;
}

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
    profile: () => ({ model: 'sonnet' }),
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

  it('a task that writes the e2e suite gets its rules, whatever role owns it; other tasks do not', () => {
    const opts = { code: { source: 'none' as const }, handoffs: [], feedback: null, e2eSuite: 'test/e2e/api.test.mjs' };
    const suiteTask = { ...task, affectedPaths: ['test/e2e/api.test.mjs', 'test/e2e/helpers.mjs'] };
    const rules = devPack(base, suiteTask, opts).principles.join('\n');
    expect(rules).toContain('keeps the data of earlier runs');
    expect(rules).toContain('Never skip a test');
    expect(devPack(base, { ...task, affectedPaths: ['test/e2e/**'] }, opts).principles.join('\n')).toContain('Never skip a test');
    expect(devPack(base, { ...task, affectedPaths: ['src/app.mjs'] }, opts).principles).toEqual(base.project.principles);
    expect(devPack(base, suiteTask, { ...opts, e2eSuite: undefined }).principles).toEqual(base.project.principles);
  });

  it('review pack puts the diff and impact radius in feedback and code', () => {
    const junit = [{ id: 'test::[AC-001] adds', name: '[AC-001] adds', classname: 'test', status: 'passed' as const, acIds: ['AC-001'] }];
    const p = reviewPack(base, task, { diffStat: ' src/a.ts | 2 +-', changedFiles: ['src/a.ts'], diff: '+const a = 1;', junit, code: { source: 'graph', affected: [] }, profile: 'standard' });
    expect(p.kind).toBe('review');
    expect(p.role).toBe('test');
    expect(p.feedback).toContain('standard');
    expect(p.changeSet).toContain('src/a.ts | 2 +-');
    expect(p.changeSet).toContain('+const a = 1;');
    expect(p.changeSet).toContain('- test::[AC-001] adds [passed] AC-001');
    expect(p.changeSet).toContain('do not re-run it');
    expect(p.code?.source).toBe('graph');
  });

  it('report pack lists the security findings for the SM summary', () => {
    const opts = { delivered: ['T1'], blocked: [], evidence: '[]', assumptions: [], deploy: '{}', hostUrl: null, tokens: '{}' };
    expect(reportPack(base, { ...opts, security: '- T1 src/a.ts:3 [low] logging: verbose log' }).feedback).toContain('[low] logging: verbose log');
    expect(reportPack(base, { ...opts, security: '' }).feedback).toContain('Security findings left by the sec review');
  });

  it('report pack asks for the human-facing report fields in Brazilian Portuguese, with steps as action plus expected result', () => {
    const f = reportPack(base, { delivered: ['T1'], blocked: [], evidence: '[]', assumptions: [], deploy: '{}', hostUrl: null, tokens: '{}', security: '' }).feedback;
    expect(f).toContain('Brazilian Portuguese (pt-BR)');
    expect(f).toContain('`summary`, `assumptions`, `blocked[].reason` and `exploratoryScript`');
    expect(f).toContain('what to do and what should happen');
  });

  it('report and readme packs name the README sections the plan requires, so the first answer already carries them', () => {
    const opts = { delivered: ['T1'], blocked: [], evidence: '[]', assumptions: [], deploy: '{}', hostUrl: null, tokens: '{}', security: '' };
    const line = 'docs/README.md also needs a heading naming each section the plan lists: Run, Monitoring.';
    expect(reportPack(base, { ...opts, readmeSections: ['Run', 'Monitoring'] }).feedback).toContain(line);
    expect(readmePack(base, { tasks: [], existing: null, readmeSections: ['Run', 'Monitoring'] }).feedback).toContain(line);
    expect(reportPack(base, opts).feedback).not.toContain('also needs a heading');
  });

  it('report pack hands the agent the browser url and keeps the internal deploy url out of the text', () => {
    const opts = { delivered: ['T1'], blocked: [], evidence: '[]', assumptions: [], deploy: '{"url":"http://dind:3000"}', tokens: '{}', security: '' };
    expect(reportPack(base, { ...opts, hostUrl: 'http://localhost:3000' }).feedback).toContain('The human opens the service at http://localhost:3000; the deploy url is internal');
    expect(reportPack(base, { ...opts, hostUrl: null }).feedback).toContain('The human cannot open the service from a browser');
  });

  it('plan rules tell the SM to name the deploy kind and docs path and to keep the port in the published range', () => {
    const rules = planRules(true);
    expect(rules).toContain('deploy.kind');
    expect(rules).toContain('deploy.docsPath');
    expect(rules).toContain('3000-3019');
  });

  it('plan rules ask for dependsOn only on a real dependency, so independent tasks run in parallel', () => {
    expect(planRules(true)).toMatch(/dependsOn names only a real dependency/);
  });

  it('plan rules tell the SM to publish any datastore service port, not just the app port', () => {
    // A Postgres/MySQL/Redis compose service the app depends on must be reachable the same way the app itself is
    // (serviceHost:port), or integration tests against a real database have no route to it at all.
    const rules = planRules(true);
    expect(rules).toMatch(/datastore|database service/i);
    expect(rules).toMatch(/publish(es)? its (own )?port/i);
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

  it('plan pack prescribes the security tooling commands only when required', () => {
    const on = planPack(base, { techSpecText: '# t', godNodes: [], feedback: null, requireSecurityTooling: true });
    for (const s of ['security-tools', 'gitleaks detect', 'semgrep scan', 'osv-scanner', 'trivy config', 'trivy fs']) expect(on.feedback).toContain(s);
    const off = planPack(base, { techSpecText: '# t', godNodes: [], feedback: null });
    expect(off.feedback).not.toContain('semgrep');
  });

  it('output contract states the JSON schema of the kind', () => {
    expect(outputContract('dev')).toContain('"specHash"');
    expect(outputContract('dev')).toContain('commitMessage');
  });
});

describe('runAgentStep', () => {
  it('resumes a kept Dev session with only the retry prompt, and starts one when none was kept', async () => {
    const prompts: Array<{ prompt: string; sessionId?: string; resume?: boolean; sessionStore?: string }> = [];
    const d = await deps(async () => ({ ok: true, value: { specHash: HASH, status: 'done', summary: 'ok', changedFiles: [], commitMessage: 'feat: x' }, summary: summary() }));
    d.runStep = (async (req) => {
      prompts.push({ prompt: req.prompt, sessionId: req.sessionId, resume: req.resume, sessionStore: req.sessionStore });
      return { ok: true, value: { specHash: HASH, status: 'done', summary: 'ok', changedFiles: [], commitMessage: 'feat: x' }, summary: summary() };
    }) as AgentStepDeps['runStep'];
    d.sessionDir = (taskId) => path.join(dir, 'sessions', taskId);
    const req = { kind: 'dev' as const, role: 'dev' as const, pack: devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }), cwd: dir, phase: 'phase3', taskId: 'T1', attempt: 1, session: { id: 'sess-1', resumePrompt: devResumePrompt('gate failed') } };
    await runAgentStep(req, d);
    expect(prompts[0]).toMatchObject({ sessionId: 'sess-1', resume: false, sessionStore: path.join(dir, 'sessions', 'T1') });
    expect(prompts[0]!.prompt).toContain('## Output contract');
    // The runner would have saved the transcript; simulate it.
    await saveSession(await fakeHome(), path.join(dir, 'sessions', 'T1'), dir);
    await runAgentStep({ ...req, attempt: 2 }, d);
    expect(prompts[1]).toMatchObject({ sessionId: 'sess-1', resume: true });
    expect(prompts[1]!.prompt).toBe(devResumePrompt('gate failed'));
    expect(prompts[1]!.prompt).not.toContain('## Output contract');
    expect(await fs.readFile(path.join(dir, 'steps', '2', 'prompt.md'), 'utf8')).toBe(devResumePrompt('gate failed'));
  });

  it('runs a step kind on the model routing.stepModels names, ahead of the role profile and behind an explicit model', async () => {
    const models: string[] = [];
    const d = await deps(async () => ({ ok: true, value: {}, summary: summary() }));
    d.runStep = (async (req) => {
      models.push(req.model);
      return { ok: true, value: { specHash: HASH, status: 'done', summary: 'ok', changedFiles: [], commitMessage: 'feat: x' }, summary: summary() };
    }) as AgentStepDeps['runStep'];
    d.stepModel = (kind) => (kind === 'dev' ? 'haiku' : undefined);
    const req = { kind: 'dev' as const, role: 'dev' as const, pack: devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }), cwd: dir, phase: 'phase3', taskId: 'T1', attempt: 1 };
    await runAgentStep(req, d);
    await runAgentStep({ ...req, model: 'opus' }, d);
    d.stepModel = () => undefined;
    await runAgentStep(req, d);
    // The fake role profile is `{ model: 'sonnet' }`.
    expect(models).toEqual(['haiku', 'opus', 'sonnet']);
  });

  it('tells the step model chooser the attempt, so refinement can route by cycle', async () => {
    const seen: number[] = [];
    const d = await deps(async () => ({ ok: true, value: {}, summary: summary() }));
    d.runStep = (async () => ({ ok: true, value: { specHash: HASH, status: 'done', summary: 'ok', changedFiles: [], commitMessage: 'feat: x' }, summary: summary() })) as AgentStepDeps['runStep'];
    d.stepModel = (_kind, attempt) => (seen.push(attempt), undefined);
    await runAgentStep({ kind: 'dev', role: 'dev', pack: devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }), cwd: dir, phase: 'phase3', taskId: 'T1', attempt: 3 }, d);
    expect(seen).toEqual([3]);
  });

  it('ignores the session when the runner has nowhere to keep it', async () => {
    const seen: Array<{ sessionId?: string; sessionStore?: string }> = [];
    const d = await deps(async () => ({ ok: true, value: {}, summary: summary() }));
    d.runStep = (async (req) => {
      seen.push({ sessionId: req.sessionId, sessionStore: req.sessionStore });
      return { ok: true, value: { specHash: HASH, status: 'done', summary: 'ok', changedFiles: [], commitMessage: 'feat: x' }, summary: summary() };
    }) as AgentStepDeps['runStep'];
    await runAgentStep({ kind: 'dev', role: 'dev', pack: devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }), cwd: dir, phase: 'phase3', taskId: 'T1', attempt: 1, session: { id: 's', resumePrompt: 'x' } }, d);
    expect(seen[0]).toEqual({ sessionId: undefined, sessionStore: undefined });
  });

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
    expect(d.journal.events[0]!.data).toMatchObject({ stepId: 's00001', kind: 'dev', role: 'dev', taskId: 'T1', phase: 'phase3', attempt: 1 });
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
    expect(seen[0]).toMatchObject({ model: 'haiku', effort: 'low', profile: { model: 'sonnet' } });
  });
});
