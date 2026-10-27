import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SpeckitOutput } from '../../server/agents/outputs.js';
import type { ContextPackInput } from '../../server/knowledge/context-pack.js';
import { MAX_PLAN_REPAIRS, runPlanStep } from '../../server/refine/plan-step.js';
import { planFileOf } from '../../server/refine/plan-file.js';

const CRITERIA = ['AC-001'];
const SPEC = 'user-login';
const GOOD = `# Login Implementation Plan

**Goal:** Sign in.

**Architecture:** One handler.

**Tech Stack:** TypeScript.

**Spec:** specs.md, section "## user-login".

## Global Constraints

- Passwords are stored as hashes.

## Review Focus

- A wrong password is refused.

### Task 1: Handler

**Files:**
- Create: \`src/login.ts\`

**Criteria:** AC-001

## Assumptions

- None.
`;
const BAD = GOOD.replace('**Criteria:** AC-001', '**Criteria:** AC-009');

let staging: string;
const planPath = (): string => path.join(staging, planFileOf(SPEC));
const done = (questions: SpeckitOutput['questions'] = []): SpeckitOutput => ({ specHash: 'h', status: 'done', summary: 'Plan written.', files: [planFileOf(SPEC)], questions });

/** Runs the step with one answer per call; each answer may write the plan file first. */
function scripted(answers: Array<{ write?: string; output: SpeckitOutput | null; errors?: string[] }>) {
  const packs: ContextPackInput[] = [];
  const run = async (pack: ContextPackInput) => {
    packs.push(pack);
    const next = answers.shift()!;
    if (next.write !== undefined) {
      await fs.mkdir(path.dirname(planPath()), { recursive: true });
      await fs.writeFile(planPath(), next.write);
    }
    if (next.output === null) return { ok: false as const, failure: 'schema' as const, errors: next.errors ?? ['bad answer'], summary: {} as never, sandboxDisabled: false };
    return { ok: true as const, value: next.output, summary: {} as never };
  };
  return { run, packs };
}

const stepOf = (run: ReturnType<typeof scripted>['run']) => ({
  staging,
  specId: SPEC,
  criteria: CRITERIA,
  pack: (repair: string | null) => ({ kind: 'speckit', role: 'dev', specHash: 'h', principles: [], outputContract: '', criteria: [], feedback: repair ?? 'first', budgetTokens: 1 }) as ContextPackInput,
  run,
});

beforeEach(async () => {
  staging = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-step-'));
});

afterEach(async () => {
  await fs.rm(staging, { recursive: true, force: true });
});

describe('runPlanStep', () => {
  it('accepts a plan that passes on the first answer', async () => {
    const { run, packs } = scripted([{ write: GOOD, output: done() }]);
    const result = await runPlanStep(stepOf(run));
    expect(result).toEqual({ status: 'valid', file: planFileOf(SPEC), issues: [], repairs: 0, questions: 0 });
    expect(packs).toHaveLength(1);
  });

  it('repairs a plan that fails its shape, with the problems named in the next run', async () => {
    const { run, packs } = scripted([{ write: BAD, output: done() }, { write: GOOD, output: done() }]);
    const result = await runPlanStep(stepOf(run));
    expect(result.status).toBe('valid');
    expect(result.repairs).toBe(1);
    expect(packs[1]!.feedback).toContain('criterion AC-001 is in no task');
  });

  it('gives up after the repairs run out, and names the problems left', async () => {
    const answers = Array.from({ length: MAX_PLAN_REPAIRS + 1 }, () => ({ write: BAD, output: done() }));
    const { run, packs } = scripted(answers);
    const result = await runPlanStep(stepOf(run));
    expect(result.status).toBe('failed');
    expect(result.repairs).toBe(MAX_PLAN_REPAIRS);
    expect(result.issues).toContain('criterion AC-009 is not in the spec');
    expect(packs).toHaveLength(MAX_PLAN_REPAIRS + 1);
  });

  it('does not repair a step that says it is blocked', async () => {
    const blocked: SpeckitOutput = { specHash: 'h', status: 'blocked', reason: 'The spec section is empty.', summary: 'No spec.', files: [], questions: [] };
    const { run, packs } = scripted([{ output: blocked }]);
    const result = await runPlanStep(stepOf(run));
    expect(result).toMatchObject({ status: 'blocked', issues: ['The spec section is empty.'], repairs: 0 });
    expect(packs).toHaveLength(1);
  });

  it('counts the questions an answer puts, which the step never asks', async () => {
    const asked = done([{ text: 'Which length?', blocking: false }]);
    const { run } = scripted([{ write: GOOD, output: asked }]);
    expect((await runPlanStep(stepOf(run))).questions).toBe(1);
  });

  it('fails a plan file that was never written', async () => {
    const { run } = scripted([{ output: done() }, { output: done() }, { output: done() }]);
    const result = await runPlanStep(stepOf(run));
    expect(result.status).toBe('failed');
    expect(result.issues).toEqual([`the plan file ${planFileOf(SPEC)} is missing`]);
  });

  it('fails at once when the runner fails, without a repair', async () => {
    const { run, packs } = scripted([{ output: null, errors: ['timeout'] }]);
    expect(await runPlanStep(stepOf(run))).toMatchObject({ status: 'failed', issues: ['timeout'], repairs: 0 });
    expect(packs).toHaveLength(1);
  });
});
