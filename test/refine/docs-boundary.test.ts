import { describe, expect, it } from 'vitest';
import { boundaryLabel } from '../../server/refine/docs-boundary.js';
import { RefineEvent } from '../../server/refine/events.js';
import type { BacklogState } from '../../server/refine/state.js';

const backlog: BacklogState = {
  enabled: true,
  project: null,
  epics: [],
  items: [],
  cycle: 1,
  specs: { login: { inputHash: 'h', specId: 'hello-app-login', rev: null, spec: null, issues: [], cycle: 1 } },
};

describe('boundaryLabel', () => {
  it('names the commit of each boundary fact', () => {
    expect(boundaryLabel({ type: RefineEvent.BacklogEnabled, data: {} }, backlog)).toBe('backlog enabled');
    expect(boundaryLabel({ type: RefineEvent.BacklogDerived, data: {} }, backlog)).toBe('backlog derived');
    expect(boundaryLabel({ type: RefineEvent.SpecDerived, data: { specId: 'hello-app-login' } }, backlog)).toBe('spec hello-app-login');
    expect(boundaryLabel({ type: RefineEvent.PlansPrepared, data: {} }, backlog)).toBe('plans prepared');
  });

  it('names a plan or a task list of an item by its alias', () => {
    expect(boundaryLabel({ type: RefineEvent.SpeckitStepDone, data: { command: 'plan', itemKey: 'login', files: ['x'] } }, backlog)).toBe('plan hello-app-login');
    expect(boundaryLabel({ type: RefineEvent.SpeckitStepDone, data: { command: 'tasks', itemKey: 'login', files: [] } }, backlog)).toBe('tasks hello-app-login');
  });

  it('ends no unit for a blocked step, an unknown item or another command', () => {
    expect(boundaryLabel({ type: RefineEvent.SpeckitStepDone, data: { command: 'plan', itemKey: 'login', files: [], blocked: true } }, backlog)).toBeNull();
    expect(boundaryLabel({ type: RefineEvent.SpeckitStepDone, data: { command: 'plan', itemKey: 'other', files: ['x'] } }, backlog)).toBeNull();
    expect(boundaryLabel({ type: RefineEvent.SpeckitStepDone, data: { command: 'constitution', files: ['x'] } }, backlog)).toBeNull();
  });

  it('ignores the created, architecture and docs facts', () => {
    for (const type of [RefineEvent.Created, RefineEvent.ArchitectureDecided, RefineEvent.DocsReorganized, RefineEvent.DocsValidated, RefineEvent.DocsScored]) {
      expect(boundaryLabel({ type, data: {} }, backlog)).toBeNull();
    }
  });
});

describe('a document change', () => {
  it('is a boundary of its own, named by its file, so it reaches the store at the next tick', () => {
    expect(boundaryLabel({ type: RefineEvent.DocEdited, data: { file: 'briefing.md' } }, backlog)).toBe('document briefing.md');
    expect(boundaryLabel({ type: RefineEvent.PatchAccepted, data: { file: 'stack.md' } }, backlog)).toBe('document stack.md');
    for (const type of [RefineEvent.DocMoved, RefineEvent.DocMoveUndone, RefineEvent.DocReshaped, RefineEvent.DocReshapeUndone]) {
      expect(boundaryLabel({ type, data: {} }, backlog)).toBe('documents edited');
    }
  });

  it('is null for any other fact', () => {
    expect(boundaryLabel({ type: RefineEvent.QuestionAnswered, data: {} }, backlog)).toBeNull();
  });
});
