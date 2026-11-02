import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planPack, taskPack } from '../../server/refine/superpowers-pack.js';

const golden = (name: string): string => readFileSync(path.resolve(__dirname, '../fixtures/refine', name), 'utf8');

const base = { specHash: 'hash-1', inputDir: 'speckit-input', specId: 'user-login', key: 'user-login', title: 'Sign in', criteria: ['AC-001', 'AC-002'] };

describe('plan pack text by layout', () => {
  it('keeps the legacy text byte for byte', () => {
    expect(planPack(base).feedback).toBe(golden('pack-plan-legacy.txt'));
  });

  it('names the spec, the plan and the other files of the spec folder by relative link in the documentation repository', () => {
    expect(planPack({ ...base, layout: 'docs-repo' }).feedback).toBe(golden('pack-plan-docs-repo.txt'));
  });
});

describe('task pack text by layout', () => {
  it('keeps the legacy text byte for byte', () => {
    expect(taskPack(base).feedback).toBe(golden('pack-task-legacy.txt'));
  });

  it('names the plan, the spec and the task list by relative link in the documentation repository', () => {
    expect(taskPack({ ...base, layout: 'docs-repo' }).feedback).toBe(golden('pack-task-docs-repo.txt'));
  });
});
