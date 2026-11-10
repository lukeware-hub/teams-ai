import { describe, expect, it } from 'vitest';
import { stageReviewPack } from '../../server/refine/stage-cycle.js';
import { consultDocs } from '../../server/refine/stage-consult.js';
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

describe('stage review context of the other documents', () => {
  const earlier = '# Projeto\n\n## Regras de pagamento\n\nO pagamento é feito no ato. FIM-PAGAMENTO\n\n## Outra parte\n\nTexto sem relação. FIM-OUTRA\n';
  const build = async (briefing: string) => JSON.stringify(stageReviewPack({
    role: 'po', specHash: 'h', principles: [], file: 'briefing.md', docs: { ...docs, 'project.md': earlier, 'briefing.md': briefing }, specId: 's', history: [], rejected: [],
    consult: await consultDocs({ docs: { ...docs, 'project.md': earlier, 'briefing.md': briefing }, consulted: ['project.md'], part: briefing, graphDirOf: () => '' }),
  }));

  it('reads the excerpts of the other documents that match the stage document, and no other, never the whole document', async () => {
    const text = await build('# Briefing\n\nSegue as regras de pagamento do projeto.\n');
    expect(text).toContain('FIM-PAGAMENTO');
    expect(text).not.toContain('FIM-OUTRA');
    expect(text).not.toContain('a digest');
  });

  it('gives no excerpt when the stage document matches none', async () => {
    const text = await build('# Briefing\n\nCampo livre sobre cores.\n');
    expect(text).not.toContain('FIM-PAGAMENTO');
    expect(text).toContain('Nothing in these documents matches this part.');
  });
});

describe('criterionIdsInDocs', () => {
  it('collects every criterion id the documents already use, whole ids only', async () => {
    const { criterionIdsInDocs } = await import('../../server/refine/detail-cycle.js');
    const ids = criterionIdsInDocs({ briefing: 'AC-001 e AC-006 do briefing', flow: 'sem ids', stack: 'XAC-0010 não conta; AC-012 conta' });
    expect([...ids].sort()).toEqual(['AC-001', 'AC-006', 'AC-012']);
  });
});
