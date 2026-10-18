import { describe, expect, it } from 'vitest';
import { Plan } from '../../server/contracts/plan.js';
import { makeFrozenSpec, makePlan, makePlanTask, makeServicesPlan } from '../fixtures/contracts.js';
import { DevOutput, EnvironmentVariable, OUTPUT_SCHEMAS, PlanOutput, RefineOutput, ReviewOutput, SecurityOutput, ServicesPlanOutput, STEP_KINDS, blockingFindings, toJsonSchema } from '../../server/agents/outputs.js';

const HASH = `sha256:${'a'.repeat(64)}`;

describe('output contracts', () => {
  it('every step kind has a schema requiring specHash', () => {
    for (const kind of STEP_KINDS) {
      const schema = toJsonSchema(kind) as { required?: string[]; anyOf?: Array<{ required?: string[] }>; oneOf?: Array<{ required?: string[] }> };
      const branches = schema.anyOf ?? schema.oneOf ?? [schema];
      expect(branches.length, kind).toBeGreaterThan(0);
      for (const branch of branches) expect(branch.required, kind).toContain('specHash');
    }
    expect(Object.keys(OUTPUT_SCHEMAS).sort()).toEqual([...STEP_KINDS].sort());
  });

  it('a new plan names every task id with a slug; a stored plan with bare ids still loads', () => {
    const bare = makePlan(makeFrozenSpec(), { tasks: [makePlanTask({ id: 'T1' })] });
    expect(PlanOutput.safeParse(bare).success).toBe(false);
    expect(Plan.safeParse(bare).success).toBe(true);
    expect(PlanOutput.safeParse(makePlan(makeFrozenSpec(), { tasks: [makePlanTask({ id: 'T1-create-endpoint' })] })).success).toBe(true);
    expect(PlanOutput.safeParse(makePlan(makeFrozenSpec(), { tasks: [makePlanTask({ id: 'T0-scaffold' })] })).success).toBe(true);
  });

  it('generates draft-07 schemas without zod-only keywords', () => {
    const text = JSON.stringify(toJsonSchema('dev'));
    expect(text).toContain('draft-07');
    expect(text).not.toMatch(/"\$ref":"#\/\$defs/);
  });

  it('dev output accepts blocked with a reason and rejects it without one', () => {
    expect(DevOutput.safeParse({ specHash: HASH, status: 'blocked', summary: 's', reason: 'cluster unreachable from the sandbox', changedFiles: [] }).success).toBe(true);
    expect(DevOutput.safeParse({ specHash: HASH, status: 'blocked', summary: 's', changedFiles: [] }).success).toBe(false);
    expect(DevOutput.safeParse({ specHash: HASH, status: 'blocked', summary: 's', reason: '', changedFiles: [] }).success).toBe(false);
  });

  it('dev output requires a question for spec-gap and a commit message for done', () => {
    expect(DevOutput.safeParse({ specHash: HASH, status: 'done', summary: 's', commitMessage: 'feat: x', changedFiles: ['src/a.ts'] }).success).toBe(true);
    expect(DevOutput.safeParse({ specHash: HASH, status: 'done', summary: 's', changedFiles: [] }).success).toBe(false);
    expect(DevOutput.safeParse({ specHash: HASH, status: 'spec-gap', summary: 's', question: 'Which currency?', changedFiles: [] }).success).toBe(true);
    expect(DevOutput.safeParse({ specHash: HASH, status: 'spec-gap', summary: 's', changedFiles: [] }).success).toBe(false);
  });

  it('review output carries evidence claims per criterion and a decision', () => {
    const ok = ReviewOutput.safeParse({
      specHash: HASH,
      decision: 'approve',
      criteria: [{ id: 'AC-001', status: 'passed', evidence: ['t::[AC-001] a'] }],
      findings: [],
    });
    expect(ok.success).toBe(true);
    // Infrastructure tasks carry no acceptance criteria; the review then judges the diff alone (live-run finding:
    // a required criterion made the reviewer invent "AC-000").
    const none = ReviewOutput.safeParse({ specHash: HASH, decision: 'approve', criteria: [], findings: [] });
    expect(none.success).toBe(true);
    const bad = ReviewOutput.safeParse({ specHash: HASH, decision: 'changes', criteria: [{ id: 'AC-000', status: 'passed', evidence: [] }], findings: [] });
    expect(bad.success).toBe(true); // ids are validated against the spec by the reference check, not the schema
  });

  it('refine output lists questions with a blocking flag and a checklist', () => {
    const ok = RefineOutput.safeParse({
      specHash: HASH,
      checklist: [{ id: 'po-verifiable-ac', passed: false, detail: 'AC-002 has no measurable then' }],
      questions: [{ id: 'q1', text: 'What is the max discount?', blocking: true, relatedAcIds: ['AC-002'] }],
      docPatch: [],
    });
    expect(ok.success).toBe(true);
  });

  it('refine questions carry their choices: a malformed choice is dropped alone, and an open question has none', () => {
    const base = { specHash: HASH, checklist: [], docPatch: [] };
    const choice = { label: 'Citar as subseções', detail: 'O item cita 2.1, 2.2 e 2.3.' };
    const recommended = { label: 'Citar a seção inteira', detail: 'O item cita 2 por inteiro.', recommended: true };
    const parsed = RefineOutput.parse({ ...base, questions: [{ id: 'q1', text: 'Como citar?', blocking: true, relatedAcIds: [], options: [choice, { label: 'sem detalhe' }, 'texto', recommended] }] });
    expect(parsed.questions[0]!.options).toEqual([choice, recommended]);
    expect(RefineOutput.parse({ ...base, questions: [{ id: 'q2', text: 'Qual o nome?', blocking: false, relatedAcIds: [] }] }).questions[0]!.options).toEqual([]);
  });

  it('refine contradictions are optional, and a malformed one is dropped on its own', () => {
    const base = { specHash: HASH, checklist: [], questions: [], docPatch: [] };
    const good = { fact: 'porta', a: { file: 'brief.md', quote: 'porta 8080' }, b: { file: 'flow.md', quote: 'porta 18080' }, fix: 'Alinhe.' };
    expect(RefineOutput.parse(base).contradictions).toBeUndefined();
    expect(RefineOutput.parse({ ...base, contradictions: [good, { fact: 'sem lados' }, 'texto'] }).contradictions).toEqual([good]);
    expect(RefineOutput.parse({ ...base, contradictions: 'nope' }).contradictions).toEqual([]);
    const schema = toJsonSchema('refine') as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('contradictions');
    expect(schema.required).not.toContain('contradictions');
  });

  it('refine docPatch: a malformed patch is dropped on its own, and the schema still lists its fields', () => {
    const base = { specHash: HASH, checklist: [], questions: [] };
    const good = { file: 'docs/stack.md', find: '# Stack', replace: '# Stack\n\n- Node 22', reason: 'Preenche a pilha.' };
    const noReason = { file: 'docs/flow.md', find: '# Fluxo', replace: '# Fluxo' };
    expect(RefineOutput.parse({ ...base, docPatch: [good, noReason, 'texto'] }).docPatch).toEqual([good]);
    expect(RefineOutput.parse({ ...base, docPatch: 'nope' }).docPatch).toEqual([]);
    expect(RefineOutput.parse(base).docPatch).toEqual([]);
    const schema = toJsonSchema('refine') as { required?: string[]; properties?: Record<string, { items?: { required?: string[] } }> };
    expect(schema.required).toContain('docPatch');
    expect(schema.properties?.docPatch?.items?.required).toContain('reason');
  });
});

describe('dev output JSON Schema carries the status-dependent requirements', () => {
  it('lists commitMessage as required for done and question for spec-gap', () => {
    type Branch = { required?: string[]; properties?: Record<string, { const?: string; enum?: string[] }> };
    const schema = toJsonSchema('dev') as { anyOf?: Branch[]; oneOf?: Branch[] };
    const branches = schema.anyOf ?? schema.oneOf;
    expect(branches).toBeDefined();
    const done = branches!.find((b) => JSON.stringify(b.properties?.status).includes('done'))!;
    const gap = branches!.find((b) => JSON.stringify(b.properties?.status).includes('spec-gap'))!;
    expect(done.required).toContain('commitMessage');
    expect(gap.required).toContain('question');
  });
  it('spec-gap and replan are step kinds with their own schemas', () => {
    const HASH = 'sha256:' + 'a'.repeat(64);
    expect(STEP_KINDS).toContain('spec-gap');
    expect(STEP_KINDS).toContain('replan');
    expect(OUTPUT_SCHEMAS['spec-gap'].safeParse({ specHash: HASH, answer: 'Use UTC', assumption: 'T1: timezone → UTC' }).success).toBe(true);
    expect(OUTPUT_SCHEMAS['spec-gap'].safeParse({ specHash: HASH, answer: '' }).success).toBe(false);
    const task = { id: 'T1-r1', title: 't', description: 'd', criteriaRefs: ['AC-001'], dependsOn: [], affectedPaths: ['src'], owner: 'dev' };
    expect(OUTPUT_SCHEMAS.replan.safeParse({ specHash: HASH, replacements: [task] }).success).toBe(true);
    expect(OUTPUT_SCHEMAS.replan.safeParse({ specHash: HASH, replacements: [] }).success).toBe(false);
    expect(OUTPUT_SCHEMAS.replan.safeParse({ specHash: HASH, replacements: [task, task, task, task] }).success).toBe(false);
  });
});

describe('security output', () => {
  const finding = (severity: string) => ({ file: 'src/a.ts', line: 3, severity, category: 'injection', problem: 'user input reaches a shell', fix: 'use execFile' });
  const review = (decision: 'approve' | 'changes', ...severities: string[]) => SecurityOutput.parse({ specHash: HASH, decision, findings: severities.map(finding) });

  it('blocks on critical and high findings alone: the severities decide, the decision never overrides them', () => {
    expect(blockingFindings(review('changes', 'critical', 'medium')).map((f) => f.severity)).toEqual(['critical']);
    expect(blockingFindings(review('approve', 'low', 'high')).map((f) => f.severity)).toEqual(['high']);
    expect(blockingFindings(review('changes', 'medium', 'low'))).toEqual([]);
    expect(blockingFindings(review('changes'))).toEqual([]);
    expect(blockingFindings(review('approve', 'medium'))).toEqual([]);
  });

  it('keeps the field names the sec agent must use', () => {
    const wrong = { specHash: HASH, decision: 'changes', findings: [{ file: 'a.js', line: 1, issue: 'injection', fix: 'f' }] };
    expect(SecurityOutput.safeParse(wrong).success).toBe(false);
    expect(SecurityOutput.safeParse({ specHash: HASH, decision: 'approve', findings: [{ ...finding('low'), severity: 'minor' }] }).success).toBe(false);
  });
});

describe('derive output', () => {
  it('is a step kind whose output carries a project and a spec', async () => {
    const { DeriveOutput } = await import('../../server/agents/outputs.js');
    const { makeProject, makeSpec } = await import('../fixtures/contracts.js');
    expect(STEP_KINDS).toContain('derive');
    const out = DeriveOutput.parse({ specHash: HASH, project: makeProject(), spec: { ...makeSpec(), status: 'refining', specHash: null } });
    expect(out.spec.status).toBe('refining');
    expect(OUTPUT_SCHEMAS.derive).toBe(DeriveOutput);
  });

  it('keeps a malformed criterion id for postProcessDerived to renumber, instead of failing the step', async () => {
    const { DeriveOutput } = await import('../../server/agents/outputs.js');
    const { makeProject, makeSpec } = await import('../fixtures/contracts.js');
    const ac = { id: 'AC-13', given: 'g', when: 'w', then: 't', smoke: false };
    expect(DeriveOutput.safeParse({ specHash: HASH, project: makeProject(), spec: { ...makeSpec(), status: 'refining', specHash: null, acceptanceCriteria: [ac] } }).success).toBe(true);
  });

  // Plan 76 review: the derive agent never owns the decisions, so an echoed or malformed copy is dropped instead of failing the cycle.
  it('drops a decisions array the derive agent writes, even a malformed one, and still shows the agent the spec schema', async () => {
    const { DeriveOutput } = await import('../../server/agents/outputs.js');
    const { makeProject, makeSpec } = await import('../fixtures/contracts.js');
    const out = DeriveOutput.safeParse({ specHash: HASH, project: makeProject(), spec: { ...makeSpec(), status: 'refining', specHash: null, decisions: [{ question: 'Port?', answer: '8080', by: 'SM' }] } });
    expect(out.success).toBe(true);
    expect(out.success && out.data.spec.decisions).toBeUndefined();
    expect(JSON.stringify(toJsonSchema('derive'))).toContain('acceptanceCriteria');
  });
});

describe('backlog output', () => {
  it('is a step kind whose output carries a project and a backlog, and leaves derive untouched', async () => {
    const { BacklogOutput, DeriveOutput } = await import('../../server/agents/outputs.js');
    const { makeProject } = await import('../fixtures/contracts.js');
    expect(STEP_KINDS).toContain('backlog');
    const backlog = { epics: [{ key: 'core', title: 'Core' }], items: [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'S' }] };
    expect(BacklogOutput.safeParse({ specHash: HASH, project: makeProject(), backlog }).success).toBe(true);
    expect(BacklogOutput.safeParse({ specHash: HASH, project: makeProject(), backlog: { ...backlog, items: [] } }).success).toBe(false);
    expect(OUTPUT_SCHEMAS.backlog).toBe(BacklogOutput);
    expect(OUTPUT_SCHEMAS.derive).toBe(DeriveOutput);
    expect(JSON.stringify(toJsonSchema('backlog'))).toContain('"dependsOn"');
  });
});

describe('spec and preplan outputs', () => {
  it('are step kinds carrying one to three backlog items each, without the fields the orchestrator owns', async () => {
    const { PreplanOutput, SpecDetailOutput } = await import('../../server/agents/outputs.js');
    expect(STEP_KINDS).toEqual(expect.arrayContaining(['spec', 'preplan']));
    const item = { key: 'opme', objectives: ['o'], features: ['f'], acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }], outOfScope: [], externalDependencies: [] };
    expect(SpecDetailOutput.parse({ specHash: HASH, specs: [item] }).specs[0]!.type).toBe('feature');
    expect(SpecDetailOutput.safeParse({ specHash: HASH, specs: [item, item, item, item] }).success).toBe(false);
    expect(SpecDetailOutput.safeParse({ specHash: HASH, specs: [] }).success).toBe(false);
    const pre = { key: 'opme', modules: [{ name: 'opme', purpose: 'p' }], tasks: [{ id: 'P1', title: 't', module: 'opme', owner: 'dev', criteriaRefs: ['AC-001'], dependsOn: [] }], risks: [] };
    expect(PreplanOutput.safeParse({ specHash: HASH, preplans: [pre] }).success).toBe(true);
    expect(PreplanOutput.safeParse({ specHash: HASH, preplans: [pre, pre, pre, pre] }).success).toBe(false);
    expect(OUTPUT_SCHEMAS.spec).toBe(SpecDetailOutput);
    expect(OUTPUT_SCHEMAS.preplan).toBe(PreplanOutput);
    const specSchema = JSON.stringify(toJsonSchema('spec'));
    expect(specSchema).toContain('"acceptanceCriteria"');
    for (const owned of ['"specId"', '"status"', '"derivedFrom"', '"specVersion"']) expect(specSchema).not.toContain(owned);
    const preplanSchema = JSON.stringify(toJsonSchema('preplan'));
    expect(preplanSchema).toContain('"criteriaRefs"');
    for (const owned of ['"specId"', '"specRev"', '"inputHash"']) expect(preplanSchema).not.toContain(owned);
  });
});

describe('conflicts output', () => {
  it('is the step kind of the SM conflict map: pairs of item keys with a reason', async () => {
    const { ConflictsOutput } = await import('../../server/agents/outputs.js');
    expect(STEP_KINDS).toContain('conflicts');
    expect(OUTPUT_SCHEMAS.conflicts).toBe(ConflictsOutput);
    expect(ConflictsOutput.safeParse({ specHash: HASH, pairs: [{ a: 'login', b: 'cart', reason: 'both change the users table' }] }).success).toBe(true);
    expect(ConflictsOutput.safeParse({ specHash: HASH, pairs: [] }).success).toBe(true);
    expect(ConflictsOutput.safeParse({ specHash: HASH, pairs: [{ a: 'Login!', b: 'cart', reason: 'r' }] }).success).toBe(false);
    expect(ConflictsOutput.safeParse({ specHash: HASH, pairs: [{ a: 'login', b: 'cart', reason: '' }] }).success).toBe(false);
  });
});

describe('ServicesPlanOutput', () => {
  it('is the services-plan step schema: every task names its service and a readable id', () => {
    const plan = makeServicesPlan(makeFrozenSpec());
    expect(OUTPUT_SCHEMAS['services-plan']).toBe(ServicesPlanOutput);
    expect(ServicesPlanOutput.parse(plan).tasks.map((t) => t.service)).toEqual(plan.tasks.map((t) => t.service));
    const { service: _, ...loose } = plan.tasks[0]!;
    expect(ServicesPlanOutput.safeParse({ ...plan, tasks: [loose, ...plan.tasks.slice(1)] }).success).toBe(false);
    expect(ServicesPlanOutput.safeParse({ ...plan, tasks: [{ ...plan.tasks[0]!, id: 'T1' }, ...plan.tasks.slice(1)] }).success).toBe(false);
  });
});

describe('EnvironmentVariable', () => {
  const fake = { name: 'LLM_API_KEY', scope: 'both', reason: 'r', strategy: 'fake' } as const;
  it('takes a fake key prefix of plain characters only, never a line break or a quote', () => {
    for (const prefix of ['sk-local-', 'pk.test_', 'AKIA']) expect(EnvironmentVariable.safeParse({ ...fake, prefix }).success).toBe(true);
    for (const prefix of ['sk\nINJECTED=1', 'a b', 'x"', '$(id)']) expect(EnvironmentVariable.safeParse({ ...fake, prefix }).success).toBe(false);
  });
});
