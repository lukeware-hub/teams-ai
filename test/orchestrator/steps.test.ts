import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgents } from '../../server/agents/registry.js';
import { Accounting } from '../../server/budget/accounting.js';
import { Governor } from '../../server/budget/governor.js';
import { QuotaBreaker } from '../../server/budget/quota-breaker.js';
import { buildContextPack } from '../../server/knowledge/context-pack.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { devPack, devResumePrompt, fixTasksPack, outputContract, planPack, planRules, readmePack, replanPack, reportPack, reviewPack, runAgentStep, securityPack, servicesPlanRules, specGapPack, techSpecPack, type AgentStepDeps, type PackBase } from '../../server/orchestrator/steps.js';
import { servicePlans } from '../../server/contracts/plan.js';
import { saveSession } from '../../server/runner/session-store.js';
import type { StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makePlanTask, makeProject, makeFrozenSpec, makeServicesPlan } from '../fixtures/contracts.js';

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

  it("gives every pack of a service task its settings, the other services' addresses and the start rule, since its repository holds no docs", () => {
    const view = servicePlans(makeServicesPlan(spec)).find((v) => v.service === 'inventory')!;
    const own = view.plan.tasks[0]!;
    const withService: PackBase = { ...base, service: { name: 'inventory', plan: view.plan, addresses: { orders: 'http://orders:20011' }, design: '# Design tokens' } };
    const opts = { code: { source: 'none' as const }, handoffs: [], feedback: null };
    const ruleOf = (p: { principles: readonly string[] }) => p.principles.find((x) => x.startsWith('This task changes the service inventory'));
    const rule = ruleOf(devPack(withService, own, opts))!;
    expect(rule).toContain(`"port":${view.plan.deploy.port}`);
    expect(rule).toContain('"junitPath"');
    expect(rule).not.toContain('"tasks"');
    expect(rule).toContain('orders at http://orders:20011');
    expect(rule).toContain('starts and passes its healthcheck without them');
    expect(rule).not.toContain('# Design tokens');
    // Review, security, spec-gap and replan run in the same repository, so they carry the same rule.
    const change = { diffStat: '', changedFiles: [], diff: '', code: { source: 'none' as const } };
    expect(ruleOf(reviewPack(withService, own, { ...change, junit: [], profile: 'standard' }))).toBe(rule);
    expect(ruleOf(securityPack(withService, own, change))).toBe(rule);
    expect(ruleOf(specGapPack(withService, own, { question: 'which status code?' }))).toBe(rule);
    expect(ruleOf(replanPack(withService, own, { history: [], boundaries: [] }))).toBe(rule);
    expect(ruleOf(devPack(base, own, opts))).toBeUndefined();
  });

  it('gives a front task of a service the project design doc its repository lacks', () => {
    const view = servicePlans(makeServicesPlan(spec)).find((v) => v.service === 'inventory')!;
    const withService: PackBase = { ...base, service: { name: 'inventory', plan: view.plan, addresses: {}, design: '# Design tokens' } };
    const front = devPack(withService, view.plan.tasks[0]!, { code: { source: 'none' }, handoffs: [], feedback: null }, 'front');
    expect(front.principles.find((x) => x.startsWith('This task changes the service inventory'))).toContain("The project's docs/design.md is not in this repository");
    expect(front.principles.join('\n')).toContain('# Design tokens');
  });

  it('fix-tasks pack names the service of each existing task', () => {
    const plan = makeServicesPlan(spec);
    const p = fixTasksPack(base, { failedTests: [], tails: '', uncoveredAcs: [], blocked: [], plan: { tasks: plan.tasks, gates: [] }, services: ['orders', 'inventory'], boundaries: [], feedback: null });
    expect(p.feedback).toContain('- T1-publish-order (orders):');
    const blocked = fixTasksPack(base, { failedTests: [], tails: '', uncoveredAcs: [], blocked: [{ taskId: 'T2', reason: 'stuck', service: 'inventory' }], plan: { tasks: plan.tasks, gates: [] }, services: ['orders', 'inventory'], boundaries: [], feedback: null });
    expect(blocked.feedback).toContain('- T2 (inventory): stuck');
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

  // R11.7.6: the Dev and the Test engineer read the owner's answers the frozen spec carries.
  it("dev, tech-spec and review packs carry the spec's decisions, and a spec without them adds none", () => {
    const decided: PackBase = { ...base, spec: { ...spec, decisions: [{ question: 'O total inclui frete?', answer: 'Sim.' }] } };
    const review = { diffStat: '', changedFiles: [], diff: '', junit: [], code: { source: 'none' as const }, profile: 'standard' as const };
    for (const p of [devPack(decided, task, { code: { source: 'none' }, handoffs: [], feedback: null }), techSpecPack(decided, { feedback: null }), reviewPack(decided, task, review), specGapPack(decided, task, { question: 'Frete conta?' })]) {
      expect(p.decisions).toEqual([{ question: 'O total inclui frete?', answer: 'Sim.' }]);
    }
    expect(devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }).decisions).toBeUndefined();
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

  it('asks for every endpoint as METHOD /path, the form the API check reads', () => {
    const f = reportPack(base, { delivered: ['T1'], blocked: [], evidence: '[]', assumptions: [], deploy: '{}', hostUrl: null, tokens: '{}', security: '' }).feedback;
    expect(f).toContain('each endpoint as `METHOD /path` (for example `### GET /orders/{id}`)');
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
    expect(readmePack(base, { tasks: [], readmeSections: ['Run', 'Monitoring'] }).feedback).toContain(line);
    expect(reportPack(base, opts).feedback).not.toContain('also needs a heading');
  });

  it('report and readme packs carry the current docs with the rule to keep what earlier specs wrote', () => {
    const current = { readme: '# Loja\n\n- AC-001: o estoque cadastra um sku.', runbook: '', apiDocs: '### POST /stock' };
    const opts = { delivered: ['T1'], blocked: [], evidence: '[]', assumptions: [], deploy: '{}', hostUrl: null, tokens: '{}', security: '' };
    for (const p of [reportPack(base, { ...opts, current }), readmePack(base, { tasks: [], current })]) {
      expect(p.feedback).toContain('Keep every section, acceptance criterion and endpoint they hold that is still true');
      expect(p.currentDocs).toContain('Current docs/README.md:\n# Loja\n\n- AC-001: o estoque cadastra um sku.');
      expect(p.currentDocs).toContain('There is no docs/RUNBOOK.md yet.');
      expect(p.currentDocs).toContain('Current docs/API.md:\n### POST /stock');
    }
    // The README keeps what the current docs hold, which the step may read beyond the pack.
    expect(reportPack(base, { ...opts, current }).feedback).toContain('an overview of the project (what it is, how to run and test it, the endpoints or commands it exposes, the acceptance criteria it satisfies). Use only facts from the context pack and the current docs.');
  });

  it('cuts a long current doc and sends the step to the whole file', () => {
    const p = readmePack(base, { tasks: [], current: { readme: `# Big\n${'x'.repeat(20_000)}`, runbook: '', apiDocs: '' } });
    expect(p.currentDocs).toContain('Current docs/README.md (cut at 8000 characters; read the whole file before you rewrite it):\n# Big');
  });

  it('keeps the step instructions when the current docs are large, since the docs leave the pack first', () => {
    const big = (title: string) => `# ${title}\n${'x'.repeat(20_000)}`;
    // Eight blocked tasks whose reasons carry a gate output tail, as a hard run leaves them.
    const blocked = Array.from({ length: 8 }, (_, i) => ({ taskId: `T${i + 1}`, reason: 'gate unit-test failed: '.padEnd(2_500, 'y') }));
    const opts = { delivered: ['T9'], blocked, evidence: '[]', assumptions: [], deploy: '{}', hostUrl: null, tokens: '{}', security: '' };
    const pack = buildContextPack(reportPack({ ...base, budgetTokens: 4_000 }, { ...opts, current: { readme: big('Readme'), runbook: big('Runbook'), apiDocs: big('Api') } }));
    expect(pack.dropped).toContain('current-docs');
    expect(pack.dropped).not.toContain('feedback');
    expect(pack.text).toContain('Write the final report for the human validator.');
  });

  it("readme pack of a project of services points at the docs, since the code lives in each service's repository", () => {
    const shop: PackBase = { ...base, project: { ...base.project, projectId: 'shop', services: ['orders', 'inventory'] } };
    const text = readmePack(shop, { tasks: [] }).feedback!;
    expect(text).toContain("keeps each service's code in its own repository (shop-orders, shop-inventory)");
    expect(text).not.toContain('package.json, go.mod');
    expect(readmePack(base, { tasks: [] }).feedback).toContain('package.json, go.mod');
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
    expect(rules).toContain('20000-20099');
  });

  it('plan rules never ask a task for an image digest the docs do not give (live: kayron-hub Dockerfile tasks blocked)', () => {
    for (const delivery of [true, false]) expect(planRules(true, delivery)).toContain('no step can look up an image digest');
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

  it("services plan rules keep a service's own datastore off the host, where two services' databases would collide", () => {
    const rules = planRules('services');
    expect(rules).toContain("a datastore only one service uses publishes no host port: it stays on that service's private compose network");
    expect(rules).toContain('a datastore several services share is a platform container');
    expect(rules).not.toMatch(/publish(es)? its (own )?port/i);
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
    // Haiku always runs at low effort.
    expect(seen[0]).toMatchObject({ model: 'haiku', effort: 'low', profile: { model: 'sonnet' } });
  });

  async function seeing(model: string | undefined, effort: 'low' | 'max' | undefined, fake?: (model: string) => Promise<StepOutcome<unknown>>) {
    const ok = { ok: true as const, value: { specHash: HASH, status: 'done', summary: 's', changedFiles: [], commitMessage: 'm' }, summary: summary() };
    const d = await deps(async () => ok);
    const seen: Array<{ model: string; effort?: string }> = [];
    d.runStep = (async (req: { model: string; effort?: string }) => { seen.push(req); return fake ? fake(req.model) : ok; }) as unknown as AgentStepDeps['runStep'];
    const out = await runAgentStep({ kind: 'dev', role: 'dev', pack: devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }), cwd: dir, phase: 'phase3', taskId: 'T1', attempt: 1, ...(model ? { model } : {}), effort }, d);
    return { d, seen, out };
  }
  const quota = (): StepOutcome<unknown> => ({ ok: false, failure: 'quota', errors: ['rate limited'], summary: summary({ isError: true }), sandboxDisabled: false });

  it('keeps Sonnet effort at high or below and Opus at low', async () => {
    expect((await seeing('sonnet', undefined)).seen[0]!.effort).toBe('low');
    expect((await seeing('sonnet', 'max')).seen[0]!.effort).toBe('high');
    expect((await seeing('opus', 'max')).seen[0]!.effort).toBe('low');
  });

  it('runs an Opus step on Sonnet when Opus is out of quota, without pausing the run', async () => {
    const { d, seen, out } = await seeing('opus', undefined, async (m) => (m === 'opus' ? quota() : { ok: true, value: { specHash: HASH, status: 'done', summary: 's', changedFiles: [], commitMessage: 'm' }, summary: summary() }));
    expect(seen.map((s) => s.model)).toEqual(['opus', 'sonnet']);
    expect(out.ok).toBe(true);
    expect(d.breaker.canStart()).toBe(true);
    expect(d.breaker.modelPaused('opus')).toBe(true);
    const finished = d.journal.events.find((e) => e.type === OrchEvent.StepFinished)!;
    expect(finished.data).toMatchObject({ model: 'sonnet', fellBackFrom: 'opus' });
  });

  it('starts the next Opus step on Sonnet while Opus is paused', async () => {
    const first = await seeing('opus', undefined, async (m) => (m === 'opus' ? quota() : { ok: true, value: { specHash: HASH, status: 'done', summary: 's', changedFiles: [], commitMessage: 'm' }, summary: summary() }));
    const ok = { ok: true as const, value: { specHash: HASH, status: 'done', summary: 's', changedFiles: [], commitMessage: 'm' }, summary: summary() };
    const seen: string[] = [];
    first.d.runStep = (async (req: { model: string }) => { seen.push(req.model); return ok; }) as unknown as AgentStepDeps['runStep'];
    await runAgentStep({ kind: 'dev', role: 'dev', pack: devPack(base, task, { code: { source: 'none' }, handoffs: [], feedback: null }), cwd: dir, phase: 'phase3', taskId: 'T1', attempt: 1, model: 'opus' }, first.d);
    expect(seen).toEqual(['sonnet']);
  });

  it('pauses the whole run when the lower model is out of quota too', async () => {
    const { d, seen } = await seeing('opus', undefined, async () => quota());
    expect(seen.map((s) => s.model)).toEqual(['opus', 'sonnet']);
    expect(d.breaker.canStart()).toBe(false);
  });

  it('does not move a Sonnet step to a lower model on quota failure', async () => {
    const { d, seen } = await seeing('sonnet', undefined, async () => quota());
    expect(seen).toHaveLength(1);
    expect(d.breaker.canStart()).toBe(false);
  });
});

describe('servicesPlanRules', () => {
  it('states the services plan shape, a scaffold per new service, a port per service and the platform', () => {
    const text = servicesPlanRules({ names: ['orders', 'inventory'], newServices: new Set(['inventory']), ports: { orders: 20011, inventory: 20012 }, platform: [{ name: 'nats', image: 'nats:2.10.22-alpine' }] });
    expect(text).toContain('one repository each: orders, inventory');
    expect(text).toContain('new services (their main holds no code yet): inventory');
    expect(text).toContain('T0-scaffold-<service>');
    expect(text).toContain('existing services: orders');
    expect(text).toContain('services.inventory.deploy.port is exactly 20012');
    expect(text).toContain('SERVICE_URL_<SERVICE>');
    expect(text).toContain('nats (nats:2.10.22-alpine)');
    // The deploy follows the plan's own order, so the rule promises none: each service starts without the others.
    expect(text).not.toContain('name order');
    expect(text).toContain('in no fixed order');
    expect(planRules('services')).not.toContain('first spec of the project');
  });

  it("shows the SM each existing service's files on main and where its earlier settings are, capped for a large repository", () => {
    const many = Array.from({ length: 250 }, (_, i) => `src/m${String(i).padStart(3, '0')}.ts`);
    const text = servicesPlanRules({ names: ['orders', 'inventory'], newServices: new Set(['inventory']), ports: {}, platform: [], files: { orders: ['package.json', 'src/index.ts'] } });
    expect(text).toContain('- files on main of orders: package.json, src/index.ts');
    expect(text).toContain('services.<service> of an earlier docs/specs/*/plan.json');
    expect(text).not.toContain('files on main of inventory');
    const capped = servicesPlanRules({ names: ['orders'], newServices: new Set(), ports: {}, platform: [], files: { orders: many } });
    expect(capped).toContain('- files on main of orders (first 200 of 250): src/m000.ts');
    expect(capped).not.toContain('src/m200.ts');
  });
});
