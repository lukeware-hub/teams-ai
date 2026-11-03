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

describe('stage review context of the earlier documents', () => {
  const long = 'x'.repeat(2500);
  const earlier = `# Projeto\n\n## Regras de pagamento\n\n${long} FIM-PAGAMENTO\n\n## Outra parte\n\n${long} FIM-OUTRA\n`;
  const build = (briefing: string) => JSON.stringify(stageReviewPack({ role: 'po', specHash: 'h', principles: [], file: 'briefing.md', docs: { ...docs, 'project.md': earlier, 'briefing.md': briefing }, specId: 's', history: [], rejected: [] }));

  it('reads whole the section the document names, and cuts the others', () => {
    const text = build('# Briefing\n\nSegue as regras de pagamento do projeto.\n');
    expect(text).toContain('FIM-PAGAMENTO');
    expect(text).not.toContain('FIM-OUTRA');
  });

  it('cuts every section when the document names none', () => {
    const text = build('# Briefing\n\nTexto solto.\n');
    expect(text).not.toContain('FIM-PAGAMENTO');
  });
});
