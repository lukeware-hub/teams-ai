import { describe, expect, it } from 'vitest';
import { planPack } from '../../server/refine/superpowers-pack.js';
import type { QuestionRow } from '../../server/refine/state.js';

const base = { specHash: 'hash-1', inputDir: 'speckit-input', specId: 'user-login', key: 'user-login', title: 'Sign in', criteria: ['AC-001', 'AC-002'] };

const answered: QuestionRow = { questionId: 'q-1', role: 'po', text: 'Which session length applies?', blocking: false, relatedAcIds: [], cycle: 1, status: 'answered', answer: 'One hour', answeredAt: '2026-10-27T10:00:00Z', answeredBy: null, origin: 'speckit', itemKey: 'user-login' } as unknown as QuestionRow;

describe('planPack', () => {
  it('asks the writing-plans skill, unattended, and names the one file it writes', () => {
    const { feedback } = planPack(base);
    expect(feedback).toContain('writing-plans skill of Superpowers');
    expect(feedback).toContain('load it with the Skill tool');
    expect(feedback).toContain('never stop to ask a question in the chat');
    expect(feedback).toContain('Save the plan to docs/specs/user-login/implementation-plan.md in this folder, and write no other file.');
    expect(feedback).toContain('**Spec:** (the repository path docs/specs/user-login/spec.md, the spec the plan implements)');
  });

  it('names the six inputs and every criterion id the plan must deliver', () => {
    const { feedback } = planPack(base);
    expect(feedback).toContain('speckit-input/specs.md');
    expect(feedback).toContain('AC-001, AC-002');
  });

  it('keeps questions empty and records every unknown as an assumption with its reason', () => {
    const { feedback } = planPack(base);
    expect(feedback).toContain('`questions` is always an empty list.');
    expect(feedback).toContain('record it under ## Assumptions as a bullet ending with "Reason:');
  });

  it('lists the earlier questions of the item, with the owner answer', () => {
    const { feedback } = planPack({ ...base, history: [answered] });
    expect(feedback).toContain('Which session length applies?');
    expect(feedback).toContain('answered by the owner');
    expect(feedback).toContain('One hour');
  });

  it('carries the repair note of the previous plan, and the reuse note when the plan is rebuilt', () => {
    const { feedback } = planPack({ ...base, repair: 'The previous answer left these problems: - criterion AC-002 is in no task', adjust: true });
    expect(feedback).toContain('criterion AC-002 is in no task');
    expect(feedback).toContain('Its files from an earlier run are already in this folder');
  });

  it('is a speckit step run as dev, with the output contract of the speckit answer', () => {
    const pack = planPack(base);
    expect(pack.kind).toBe('speckit');
    expect(pack.role).toBe('dev');
    expect(pack.specHash).toBe('hash-1');
  });
});
