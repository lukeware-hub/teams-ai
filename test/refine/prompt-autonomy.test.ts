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

describe('namesItem', () => {
  it('finds an item key written whole, and not one that is part of a longer key', async () => {
    const { namesItem } = await import('../../server/refine/session.js');
    expect(namesItem('Item hello-world-greet-user, AC-006: o critério', 'hello-world-greet-user')).toBe(true);
    expect(namesItem('Itens a e b: hello-world-swagger-docs', 'hello-world')).toBe(false);
    expect(namesItem('specs.md › base: ok', 'base')).toBe(true);
    expect(namesItem('baseline sem item', 'base')).toBe(false);
  });
});

describe('feedbackByItem: the reviewers send back only the items not yet redone', () => {
  const findings = [{ role: 'sm', text: 'Item caso: falta o critério de cancelamento.' }, { role: 'po', text: 'Os critérios estão vagos.' }];

  it('sends a finding to the item it names, and one that names none to every item', async () => {
    const { feedbackByItem } = await import('../../server/refine/session.js');
    expect(feedbackByItem(findings, ['caso', 'fat'], new Set())).toEqual({
      caso: ['SM (review of specs.md): Item caso: falta o critério de cancelamento.', 'PO (review of specs.md): Os critérios estão vagos.'],
      fat: ['PO (review of specs.md): Os critérios estão vagos.'],
    });
  });

  it('leaves out an item already redone on feedback, so a repeated point goes to the owner instead of another detail', async () => {
    const { feedbackByItem } = await import('../../server/refine/session.js');
    expect(Object.keys(feedbackByItem(findings, ['caso', 'fat'], new Set(['caso'])))).toEqual(['fat']);
    expect(feedbackByItem(findings, ['caso', 'fat'], new Set(['caso', 'fat']))).toEqual({});
  });
});

describe('criterionIdsInDocs', () => {
  it('collects every criterion id the documents already use, whole ids only', async () => {
    const { criterionIdsInDocs } = await import('../../server/refine/detail-cycle.js');
    const ids = criterionIdsInDocs({ briefing: 'AC-001 e AC-006 do briefing', flow: 'sem ids', stack: 'XAC-0010 não conta; AC-012 conta' });
    expect([...ids].sort()).toEqual(['AC-001', 'AC-006', 'AC-012']);
  });
});
