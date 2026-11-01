import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateServicesPlan, type ServicesPlanCheckOptions } from '../../server/validators/plan.js';
import { sourceFiles, taskListRule } from '../../server/orchestrator/steps.js';
import { makeFrozenSpec, makeServicesPlan } from '../fixtures/contracts.js';

const opts: ServicesPlanCheckOptions = { services: ['orders-api', 'inventory-api'], newServices: new Set(['inventory-api']) };

describe('services plan of a spec that names a repository', () => {
  it('refuses a plan that names another service, and a task of another service', () => {
    const spec = makeFrozenSpec({ repository: 'orders-api' });
    const errors = validateServicesPlan(makeServicesPlan(spec), spec, opts);
    expect(errors).toContain('the spec changes only orders-api, but the plan names the service inventory-api');
    expect(errors).toContain('task T0-scaffold-inventory-api belongs to inventory-api, but the spec changes orders-api');
  });

  it('asks nothing of the plan of a spec with no repository', () => {
    const spec = makeFrozenSpec();
    const errors = validateServicesPlan(makeServicesPlan(spec), spec, opts);
    expect(errors.some((error) => error.includes('the spec changes only'))).toBe(false);
  });
});

describe('the task list reaches the builders of a spec', () => {
  it('names the task list in the rules, and lists it among the source files a builder reads', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-task-sources-'));
    try {
      await fs.mkdir(path.join(dir, 'docs', 'specs', 'orders-001'), { recursive: true });
      await fs.writeFile(path.join(dir, 'docs', 'specs', 'orders-001', 'task.md'), '# tasks');
      await fs.writeFile(path.join(dir, 'docs', 'project.md'), 'p');
      const files = await sourceFiles(dir, undefined, 'orders-001', 'docs/specs/orders-001/task.md');
      expect(files).toEqual(['docs/specs/orders-001/task.md', 'docs/project.md']);
      expect(taskListRule('docs/specs/orders-001/task.md')).toContain('read that task\'s entry');
      expect(taskListRule(undefined)).toBe('');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
