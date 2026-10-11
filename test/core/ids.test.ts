import { describe, expect, it } from 'vitest';
import {
  InvalidIdError,
  parseRunId,
  runIdOf,
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
    expect(repoName('shop', 'orders')).toBe('shop-orders');
    expect(() => repoName('shop', 'Orders')).toThrow(InvalidIdError);
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

describe('run ids', () => {
  it('builds project--spec--run-n and parses it back, for every kind', () => {
    expect(runIdOf('order-service', 'add-health-check', 'run', 1)).toBe('order-service--add-health-check--run-1');
    expect(runIdOf('order-service', 'add-health-check', 'complete', 2)).toBe('order-service--add-health-check--complete-run-2');
    expect(parseRunId('order-service--add-health-check--deploy-run-3')).toEqual({ projectId: 'order-service', specId: 'add-health-check', kind: 'deploy', n: 3 });
    expect(() => runIdOf('Bad', 'x', 'run', 1)).toThrow(InvalidIdError);
  });
  it('still parses legacy ids, which name no project', () => {
    expect(parseRunId('r11p-svc-001-r1')).toEqual({ projectId: null, specId: 'r11p-svc-001', kind: 'run', n: 1 });
    expect(parseRunId('todo-001-complete-r2')).toEqual({ projectId: null, specId: 'todo-001', kind: 'complete', n: 2 });
    expect(parseRunId('not-a-run')).toBeNull();
  });
});
