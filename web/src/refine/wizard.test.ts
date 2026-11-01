import { describe, expect, it } from 'vitest';
import { docPatches, docQuestions, initialStep, nextStep, parseStep, pendingCount, prevStep, speckitQuestions, stepParam, stepsOf, unfiledQuestions, wizardNodes } from './wizard.js';

const question = (questionId: string, over: Record<string, unknown> = {}) => ({ questionId, role: 'po', text: 'q', blocking: false, relatedAcIds: [], cycle: 1, status: 'pending', answer: null, ...over });
const patch = (patchId: string, file: string, status = 'pending') => ({ patchId, role: 'po', file, find: 'a', replace: 'b', reason: 'r', diff: '', cycle: 1, status, decision: null });
const state = (over: Record<string, unknown> = {}) => ({ stages: true, doneStages: [], questions: [], patches: [], ...over }) as never;

describe('step names in the address', () => {
  it('reads a document, the review, the backlog, and nothing else', () => {
    expect(parseStep('flow.md')).toBe('flow.md');
    expect(parseStep('revisao')).toBe('review');
    expect(parseStep('backlog')).toBe('backlog');
    expect(stepParam('backlog')).toBe('backlog');
    expect(parseStep('brief.md')).toBeNull();
    expect(parseStep(null)).toBeNull();
    expect(stepParam('review')).toBe('revisao');
    expect(stepParam('stack.md')).toBe('stack.md');
  });
});

describe('initialStep', () => {
  it('opens the step named in the address', () => {
    expect(initialStep(state({ doneStages: ['flow.md'] }), 'stack.md')).toBe('stack.md');
  });

  it('opens the first document not done, or the review when all are done', () => {
    expect(initialStep(state({ doneStages: ['flow.md'] }), null)).toBe('project.md');
    expect(initialStep(state({ doneStages: ['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md'] }), null)).toBe('review');
  });

  it('opens the first document of a project that records no stages', () => {
    expect(initialStep(state({ stages: undefined, doneStages: undefined }), null)).toBe('flow.md');
  });
});

describe('wizardNodes', () => {
  it('has the five documents, the review and the backlog, with no score on any node', () => {
    const nodes = wizardNodes(state(), 'flow.md');
    expect(nodes.map((n) => n.key)).toEqual(['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md', 'review', 'backlog']);
    expect(nodes.at(-2)!.label).toBe('Revisão');
    expect(nodes.at(-1)!.label).toBe('Backlog');
    expect(nodes.every((n) => !/%/.test(n.label + (n.marker ?? '')))).toBe(true);
  });

  it('marks done from the journal in a stage session, and the current one active', () => {
    const nodes = wizardNodes(state({ doneStages: ['flow.md', 'briefing.md'] }), 'project.md');
    expect(nodes.map((n) => n.state)).toEqual(['done', 'active', 'done', 'todo', 'todo', 'todo', 'todo']);
  });

  it('marks the review done once the owner has closed it', () => {
    const all = ['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md'];
    expect(wizardNodes(state({ doneStages: all }), 'review').map((n) => n.state).at(-2)).toBe('active');
    expect(wizardNodes(state({ doneStages: all, reviewClosed: true }), 'backlog').map((n) => n.state).at(-2)).toBe('done');
  });

  it('marks done by position when the project records no stages', () => {
    const nodes = wizardNodes(state({ stages: undefined, doneStages: undefined }), 'briefing.md');
    expect(nodes.map((n) => n.state)).toEqual(['done', 'done', 'active', 'todo', 'todo', 'todo', 'todo']);
  });

  it('flags a document that changed after its score or after an earlier document changed', () => {
    const nodes = wizardNodes(state({ outdatedDocs: ['stack.md'], staleBy: { 'design.md': 'flow.md' } }), 'flow.md');
    expect(nodes.find((n) => n.key === 'stack.md')!.marker).toBe('desatualizado');
    expect(nodes.find((n) => n.key === 'design.md')!.marker).toBe('desatualizado');
    expect(nodes.find((n) => n.key === 'flow.md')!.marker).toBeUndefined();
  });
});

describe('moving between steps', () => {
  it('goes from the last document to the review and then the backlog, and stops at both ends', () => {
    expect(nextStep('design.md')).toBe('review');
    expect(nextStep('review')).toBe('backlog');
    expect(nextStep('backlog')).toBeNull();
    expect(prevStep('flow.md')).toBeNull();
    expect(prevStep('backlog')).toBe('review');
    expect(prevStep('review')).toBe('design.md');
    expect(prevStep('project.md')).toBe('flow.md');
  });
});

describe('what is pending for one document', () => {
  const st = state({
    questions: [
      question('a', { file: 'project.md' }),
      question('b', { file: 'project.md', blocking: true }),
      question('c', { file: 'flow.md' }),
      question('d'),
      question('e', { file: 'project.md', status: 'answered' }),
    ],
    patches: [patch('p1', 'project.md'), patch('p2', 'flow.md'), patch('p3', 'project.md', 'accepted')],
  });

  it('lists the pending questions of the document, blocking first', () => {
    expect(docQuestions(st, 'project.md').map((q) => q.questionId)).toEqual(['b', 'a']);
  });

  it('lists the pending patches of the document', () => {
    expect(docPatches(st, 'project.md').map((p) => p.patchId)).toEqual(['p1']);
  });

  it('keeps the questions with no document apart, as general ones', () => {
    expect(unfiledQuestions(st).map((q) => q.questionId)).toEqual(['d']);
  });

  it('counts the pending questions and patches of the document', () => {
    expect(pendingCount(st, 'project.md')).toBe(3);
    expect(pendingCount(st, 'stack.md')).toBe(0);
  });
});

describe('the questions the plan preparation asks', () => {
  it('go to stage 7, blocking first, and stay out of the unfiled ones of the review', () => {
    const st = state({ questions: [question('a'), question('s1', { origin: 'speckit' }), question('s2', { origin: 'speckit', blocking: true }), question('s3', { origin: 'speckit', status: 'answered' })] });
    expect(speckitQuestions(st).map((q) => q.questionId)).toEqual(['s2', 's1']);
    expect(unfiledQuestions(st).map((q) => q.questionId)).toEqual(['a']);
  });
});

describe('the step after the review', () => {
  it('is the architecture in a repository session, so the backlog is never reached before it', () => {
    expect(nextStep('review', stepsOf({ repositories: true }))).toBe('architecture');
    expect(nextStep('architecture', stepsOf({ repositories: true }))).toBe('backlog');
  });
});
