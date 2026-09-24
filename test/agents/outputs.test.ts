import { describe, expect, it } from 'vitest';
import { DevOutput, OUTPUT_SCHEMAS, RefineOutput, ReviewOutput, STEP_KINDS, toJsonSchema } from '../../server/agents/outputs.js';

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
    const bad = ReviewOutput.safeParse({ specHash: HASH, decision: 'changes', criteria: [], findings: [] });
    expect(bad.success).toBe(false);
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
});
