import { describe, expect, it } from 'vitest';
import { aboutADocument, specsReviewPack } from '../../server/refine/specs-review.js';

describe('specs.md review rules', () => {
  it('sees a finding about a document even with the docs/ folder in front', () => {
    expect(aboutADocument('[docs/stack.md › Pontos em aberto] a seção não pode existir')).toBe(true);
    expect(aboutADocument('briefing.md › Decisões: premissa')).toBe(true);
    expect(aboutADocument('Pré-plano de register-user (P2): ordem')).toBe(false);
  });

  it('tells the reviewers that a written assumption is settled and must not be rejected again', () => {
    const docs = { projectMd: 'p', briefMd: 'b', stackMd: 's', flowMd: 'f', designMd: 'd' };
    const pack = specsReviewPack({ role: 'po', specHash: 'h', specsMd: 'x', docs });
    expect(JSON.stringify(pack.feedback)).toContain('never reject because an assumption is unconfirmed');
  });
});
