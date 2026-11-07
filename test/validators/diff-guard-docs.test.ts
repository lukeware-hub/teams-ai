import { describe, expect, it } from 'vitest';
import { checkScope } from '../../server/validators/diff-guard.js';

const frozenDocs = (changedFiles: string[]) => checkScope({ changedFiles, affectedPaths: ['src', 'docs'], frozenPaths: [], frozenDocs: true });

describe('frozen documents of a monolith build task (plan 119, I8 item 3)', () => {
  it('fails a change to a document other than README, RUNBOOK and API', () => {
    const result = frozenDocs(['docs/stack.md']);
    expect(result.ok).toBe(false);
    expect(result.frozenTouched).toEqual(['docs/stack.md']);
    expect(frozenDocs(['docs/sub/README.md']).frozenTouched).toEqual(['docs/sub/README.md']);
  });

  it('refuses a change to README, RUNBOOK and API, since the docs step writes them', () => {
    expect(frozenDocs(['docs/README.md', 'docs/RUNBOOK.md', 'docs/API.md']).ok).toBe(false);
    expect(frozenDocs(['src/a.ts']).ok).toBe(true);
  });

  it('leaves the documents alone when the rule is off', () => {
    expect(checkScope({ changedFiles: ['docs/stack.md'], affectedPaths: ['docs'], frozenPaths: [] }).ok).toBe(true);
  });
});
