import { describe, expect, it } from 'vitest';
import { DevOutput, OUTPUT_SCHEMAS, RefineOutput, ReviewOutput, SecurityOutput, STEP_KINDS, blockingFindings, toJsonSchema } from '../../server/agents/outputs.js';

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
