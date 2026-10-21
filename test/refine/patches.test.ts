import { describe, expect, it } from 'vitest';
import { applyPatch, checkPatch, patchId, unifiedDiff } from '../../server/refine/patches.js';

const docs = { 'project.md': '# App\n\n## Vision\n\nfast\n', 'briefing.md': '## Objectives\n\n- ship\n- ship\n' } as const;

describe('patches', () => {
  it('accepts a patch whose find occurs once in a known file', () => {
    expect(checkPatch({ file: 'docs/project.md', find: 'fast', replace: 'fast and small', reason: 'r' }, 'hello-001', docs)).toEqual({ ok: true, file: 'project.md' });
    expect(checkPatch({ file: 'docs/specs/hello-001/briefing.md', find: '## Objectives', replace: '## Goals', reason: 'r' }, 'hello-001', docs)).toEqual({ ok: true, file: 'briefing.md' });
  });
  it('rejects unknown files, absent finds and ambiguous finds with a reason', () => {
    expect(checkPatch({ file: 'docs/project.json', find: 'x', replace: 'y', reason: 'r' }, 'hello-001', docs)).toEqual({ ok: false, reason: 'unknown file docs/project.json' });
    expect(checkPatch({ file: 'docs/project.md', find: 'slow', replace: 'y', reason: 'r' }, 'hello-001', docs)).toEqual({ ok: false, reason: 'find not found in project.md' });
    expect(checkPatch({ file: 'docs/specs/hello-001/briefing.md', find: '- ship', replace: 'y', reason: 'r' }, 'hello-001', docs)).toEqual({ ok: false, reason: 'find occurs 2 times in briefing.md' });
  });
  it('in backlog mode a briefing patch targets the target project docs/briefing.md', () => {
    expect(checkPatch({ file: 'docs/briefing.md', find: '## Objectives', replace: '## Goals', reason: 'r' }, 'hello-001', docs, true)).toEqual({ ok: true, file: 'briefing.md' });
    expect(checkPatch({ file: 'docs/specs/hello-001/briefing.md', find: '## Objectives', replace: '## Goals', reason: 'r' }, 'hello-001', docs, true)).toEqual({ ok: false, reason: 'unknown file docs/specs/hello-001/briefing.md' });
    expect(checkPatch({ file: 'docs/briefing.md', find: '## Objectives', replace: '## Goals', reason: 'r' }, 'hello-001', docs)).toEqual({ ok: false, reason: 'unknown file docs/briefing.md' });
  });
  it('accepts a root document cited by its bare name, and nothing nested under another folder', () => {
    expect(checkPatch({ file: 'project.md', find: 'fast', replace: 'fast and small', reason: 'r' }, 'hello-001', docs)).toEqual({ ok: true, file: 'project.md' });
    expect(checkPatch({ file: 'docs/specs/hello-001/project.md', find: 'fast', replace: 'y', reason: 'r' }, 'hello-001', docs)).toEqual({ ok: false, reason: 'unknown file docs/specs/hello-001/project.md' });
  });
  it('applies exactly once and yields a unified diff naming the file', () => {
    expect(applyPatch('a fast b', { find: 'fast', replace: 'slow' })).toBe('a slow b');
    expect(applyPatch('a b', { find: 'fast', replace: 'slow' })).toBeNull();
    const d = unifiedDiff('project.md', 'a\nfast\nb\n', 'a\nslow\nb\n');
    expect(d).toContain('--- project.md');
    expect(d).toContain('-fast');
    expect(d).toContain('+slow');
    expect(patchId('po', 2, 0)).toBe('po-c2-0');
  });
  it("appends when find is empty, which only the orchestrator's own patches carry: an agent's empty find is still refused", () => {
    expect(applyPatch('a\nb', { find: '', replace: '## C\n' })).toBe('a\nb\n## C\n');
    expect(checkPatch({ file: 'docs/project.md', find: '', replace: 'x', reason: 'r' }, 'hello-001', docs)).toEqual({ ok: false, reason: 'find not found in project.md' });
  });
});
