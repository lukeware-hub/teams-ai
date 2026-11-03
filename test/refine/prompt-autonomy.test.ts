import { describe, expect, it } from 'vitest';
import { stageReviewPack } from '../../server/refine/stage-cycle.js';
import { DOC_STAGES } from '../../server/refine/doc-stages.js';
import type { DocFile } from '../../server/refine/draft.js';

const docs = Object.fromEntries(DOC_STAGES.map((f) => [f, `# ${f}`])) as Record<DocFile, string>;
const pack = JSON.stringify(stageReviewPack({ role: 'po', specHash: 'h', principles: [], file: 'briefing.md', docs, specId: 's', history: [], rejected: [] }));

describe('stage review prompt keeps the owner for scope changes only', () => {
  it('asks the owner only under the scope rule', () => {
    expect(pack).not.toContain('cannot be completed without the owner');
    expect(pack).toContain('question rule 5');
  });
});
