import { describe, expect, it } from 'vitest';
import {
  InvalidIdError,
  assertSlug,
  attemptId,
  repoName,
  stepId,
  taskBranch,
} from '../../server/core/ids.js';

describe('ids', () => {
  it('accepts lowercase slugs', () => {
    expect(assertSlug('todo-api', 'projectId')).toBe('todo-api');
  });

  it('rejects slugs with spaces or uppercase', () => {
    expect(() => assertSlug('Todo API', 'projectId')).toThrow(InvalidIdError);
  });

  it('derives the repository name from the project id', () => {
    expect(repoName('todo-api')).toBe('todo-api');
  });

  it('builds a deterministic task branch that keeps the task id verbatim', () => {
    expect(taskBranch('spec-001', 'T3-auth')).toBe('task/spec-001-T3-auth');
  });

  it('rejects malformed task ids', () => {
    expect(() => taskBranch('spec-001', 'task3')).toThrow(InvalidIdError);
  });

  it('builds attempt ids and rejects non-positive attempts', () => {
    expect(attemptId('T1-create', 2)).toBe('T1-create-a2');
    expect(() => attemptId('T1-create', 0)).toThrow(InvalidIdError);
  });

  it('zero-pads step ids and never contains a path separator', () => {
    expect(stepId(7)).toBe('s00007');
    expect(stepId(7)).not.toContain('/');
    expect(() => stepId(0)).toThrow(InvalidIdError);
  });
});
