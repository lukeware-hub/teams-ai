import { describe, expect, it } from 'vitest';
import { absentDocsNote, windowNote } from '../../server/refine/jev-validation.js';

describe('windowNote', () => {
  it('says nothing for a single window, and names the part and the count when there are several', () => {
    expect(windowNote(1, 1)).toBe('');
    expect(windowNote(2, 3)).toContain('You see part 2 of 3 of the documents.');
  });
});

describe('absentDocsNote', () => {
  it('says nothing when all five documents are written', () => {
    expect(absentDocsNote({ project: '# A', briefing: '# B', stack: '# C', flow: '# D', design: '# E' })).toBe('');
  });

  it('names the documents that exist yet, and asks the Jev not to penalize the others', () => {
    expect(absentDocsNote({ project: '# A', briefing: '', stack: '', flow: '# D', design: '' })).toContain('Only these documents exist yet: project.md, flow.md.');
  });

  it('says none when no document is written', () => {
    expect(absentDocsNote({ project: '', briefing: '', stack: '', flow: '', design: '' })).toContain('none');
  });
});
