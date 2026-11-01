import { describe, expect, it } from 'vitest';
import { nextStep, prevStep, stepsOf, wizardNodes, WIZARD_STEPS } from './wizard.js';

const base = { stages: true, doneStages: [] as string[], outdatedDocs: [] as string[], staleBy: {}, reviewClosed: false };

describe('architecture step of a repository session', () => {
  it('puts the architecture between the review and the backlog only in a repository session', () => {
    expect(stepsOf({ repositories: true })).toEqual(['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md', 'review', 'architecture', 'backlog']);
    expect(stepsOf({})).toBe(WIZARD_STEPS);
    expect(prevStep('backlog', stepsOf({ repositories: true }))).toBe('architecture');
    expect(nextStep('architecture', stepsOf({ repositories: true }))).toBe('backlog');
  });

  it('labels the node Arquitetura and marks it done once the architecture is decided', () => {
    const undecided = wizardNodes({ ...base, repositories: true, architecture: null }, 'review');
    expect(undecided.find((n) => n.key === 'architecture')).toMatchObject({ label: 'Arquitetura', state: 'todo' });
    const decided = wizardNodes({ ...base, repositories: true, architecture: { docsHash: 'h', decision: { style: 'monolith', rationale: 'Uma aplicação.', repositories: [], integrations: [] } } }, 'architecture');
    expect(decided.find((n) => n.key === 'architecture')).toMatchObject({ state: 'active' });
  });

  it('keeps the node list of an unstamped draft as it was', () => {
    expect(wizardNodes({ ...base, architecture: null }, 'review').map((n) => n.key)).not.toContain('architecture');
  });
});
