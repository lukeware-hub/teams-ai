import { describe, expect, it } from 'vitest';
import { planShapeIssues } from '../../server/refine/plan-shape.js';

const CRITERIA = ['AC-001', 'AC-002'];

/** A plan that passes: every rule holds, with neutral names. */
const VALID = `# Login Implementation Plan

> **For agentic workers:** the implementation follows this plan, task by task.

**Goal:** Let a registered user sign in.

**Architecture:** One handler compares the password with its stored hash.

**Tech Stack:** TypeScript, Vitest.

**Spec:** specs.md, section "## login".

## Global Constraints

- Passwords are stored as hashes only.

## Review Focus

- A wrong password answers the same message as an unknown user, as the spec says.

---

### Task 1: Sign-in handler

**Files:**
- Create: \`src/login.ts\`
- Test: \`test/login.test.ts\`

**Criteria:** AC-001

**Interfaces:**
- Produces: \`signIn(email: string, password: string): Promise<boolean>\`

### Task 2: Failure message

**Files:**
- Modify: \`src/login.ts\`

**Criteria:** AC-002

## Assumptions

- A session lasts one hour. Reason: no document gives a duration.
`;

/** The valid plan with one line changed, so each rule can fail on its own. */
const change = (from: string, to: string): string => VALID.replace(from, to);

describe('planShapeIssues', () => {
  it('passes a plan that has every part, names every criterion and records each assumption with its reason', () => {
    expect(planShapeIssues(VALID, CRITERIA)).toEqual([]);
  });

  it('names a missing header line', () => {
    expect(planShapeIssues(change('**Goal:**', '**Aim:**'), CRITERIA)).toContain('the header has no **Goal:** line');
  });

  it('names a missing section', () => {
    expect(planShapeIssues(change('## Review Focus', '## Focus'), CRITERIA)).toContain('the plan has no "## Review Focus" section');
  });

  it('needs at least one task', () => {
    const text = VALID.replace(/### Task 1[\s\S]*?(?=## Assumptions)/, '');
    expect(planShapeIssues(text, CRITERIA)).toContain('the plan has no task: add at least one "### Task N: <name>" block');
  });

  it('needs a Files line and a Criteria line in every task', () => {
    const issues = planShapeIssues(change('**Files:**\n- Modify: `src/login.ts`', 'Files later.'), CRITERIA);
    expect(issues).toContain('Task 2 has no **Files:** line');
    expect(planShapeIssues(change('**Criteria:** AC-002', ''), CRITERIA)).toContain('Task 2 has no **Criteria:** line');
  });

  it('names a criterion that no task delivers', () => {
    expect(planShapeIssues(change('**Criteria:** AC-002', '**Criteria:** AC-001'), CRITERIA)).toContain("criterion AC-002 is in no task's **Criteria:** line");
  });

  it('reads a criteria line that joins its ids with a word', () => {
    expect(planShapeIssues(change('**Criteria:** AC-002', '**Criteria:** AC-002 e AC-001'), CRITERIA)).toEqual([]);
  });

  it('names a criterion the spec does not have', () => {
    expect(planShapeIssues(change('**Criteria:** AC-002', '**Criteria:** AC-002, AC-009'), CRITERIA)).toContain('criterion AC-009 is not in the spec');
  });

  it('names placeholder text, which a finished plan never keeps', () => {
    const issues = planShapeIssues(change('Let a registered user sign in.', 'Let a registered user sign in. TBD'), CRITERIA);
    expect(issues.some((issue) => issue.startsWith('line 5 has placeholder text'))).toBe(true);
  });

  it('accepts the word placeholder when it names a form field attribute', () => {
    const text = change('Passwords are stored as hashes only.', 'Passwords are stored as hashes only; the field has a `placeholder` attribute.');
    expect(planShapeIssues(text, CRITERIA)).toEqual([]);
  });

  it('does not take the Portuguese word "todo" for the TODO marker', () => {
    const text = change('Passwords are stored as hashes only.', 'Todo serviço guarda senhas só como hash.');
    expect(planShapeIssues(text, CRITERIA)).toEqual([]);
  });

  it('names the capitalised TODO marker', () => {
    const issues = planShapeIssues(change('Passwords are stored as hashes only.', 'TODO: choose the hash.'), CRITERIA);
    expect(issues.some((issue) => issue.endsWith('has placeholder text: - TODO: choose the hash.'))).toBe(true);
  });

  it('names an open clarification marker', () => {
    const issues = planShapeIssues(change('Passwords are stored as hashes only.', 'Passwords are stored as hashes [NEEDS CLARIFICATION: salt]'), CRITERIA);
    expect(issues.some((issue) => issue.includes('open [NEEDS CLARIFICATION] marker'))).toBe(true);
  });

  it('names an assumption without its reason', () => {
    const issues = planShapeIssues(change('Reason: no document gives a duration.', 'no reason given.'), CRITERIA);
    expect(issues).toContain('an assumption has no Reason: - A session lasts one hour. no reason given.');
  });

  it('accepts an empty assumptions list written as None', () => {
    expect(planShapeIssues(change('- A session lasts one hour. Reason: no document gives a duration.', '- None.'), CRITERIA)).toEqual([]);
  });
});
