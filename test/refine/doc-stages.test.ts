import { describe, expect, it } from 'vitest';
import { DOC_STAGES, earlierDocs } from '../../server/refine/doc-stages.js';

describe('document stages', () => {
  it('a new project refines the five documents in this order', () => {
    expect(DOC_STAGES).toEqual(['flow.md', 'project.md', 'briefing.md', 'stack.md', 'design.md']);
  });

  it('a stage reads only the documents before it', () => {
    expect(earlierDocs('flow.md')).toEqual([]);
    expect(earlierDocs('project.md')).toEqual(['flow.md']);
    expect(earlierDocs('briefing.md')).toEqual(['flow.md', 'project.md']);
    expect(earlierDocs('design.md')).toEqual(['flow.md', 'project.md', 'briefing.md', 'stack.md']);
  });
});
