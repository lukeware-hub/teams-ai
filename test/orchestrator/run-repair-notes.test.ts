import { describe, expect, it } from 'vitest';
import { withRepairNotes } from '../../server/program/repair-notes.js';

describe('repair notes in the pack', () => {
  it('puts the failures of the earlier attempts before the logged assumptions', () => {
    const [first, ...rest] = withRepairNotes('attempt 1 failed: AC-004 missing\n', ['an assumption']);
    expect(first).toContain('must not repeat it');
    expect(first).toContain('attempt 1 failed: AC-004 missing');
    expect(rest).toEqual(['an assumption']);
  });

  it('leaves the assumptions alone when there is no note', () => {
    expect(withRepairNotes(null, ['a'])).toEqual(['a']);
    expect(withRepairNotes(undefined, [])).toEqual([]);
  });
});
