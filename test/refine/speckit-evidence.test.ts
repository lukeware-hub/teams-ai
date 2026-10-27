import { describe, expect, it } from 'vitest';
import { diagnoseEvidence, scan, STRICT_RULES, verifyEvidence } from '../../server/refine/speckit-answers.js';
import type { SpeckitInput } from '../../server/refine/speckit-pack.js';

const BRIEF = [
  '# Briefing',
  '',
  '## Regras',
  '',
  'O link de recuperação de senha vale por 90 dias depois do envio.',
  'O sistema não enviará e-mails de cobrança aos clientes ativos ao fim do mês.',
  '',
  '## Decisões',
  '',
  '### Prazo',
  '',
  'O prazo de recuperação vale por trinta dias corridos para todos os clientes.',
].join('\n');
const DOCS = { 'project.md': '# Projeto\n\nVisão do produto.', 'flow.md': '', 'briefing.md': BRIEF, 'stack.md': '', 'design.md': '', 'specs.md': '' } as Record<SpeckitInput, string>;
const LINK = 'O link de recuperação de senha vale por 90 dias depois do envio.';
const DECISION = 'O prazo de recuperação vale por trinta dias corridos para todos os clientes.';

describe('why a quote does not verify, one case per reason', () => {
  it('source-unknown: a source that is not one of the six documents', () => {
    expect(scan(DOCS, { source: 'notas.md', quote: LINK })).toEqual({ reason: 'source-unknown' });
  });

  it('not-in-file: a quote that the named document does not hold', () => {
    expect(scan(DOCS, { source: 'briefing.md', quote: 'Esta frase não existe no documento de briefing.' })).toEqual({ reason: 'not-in-file' });
  });

  it('in-other-file: a quote that another of the six documents holds', () => {
    expect(scan(DOCS, { source: 'briefing.md', quote: 'Visão do produto.' })).toEqual({ reason: 'in-other-file' });
  });

  it('joins-lines: a quote that runs across two lines', () => {
    expect(scan(DOCS, { source: 'briefing.md', quote: 'vale por 90 dias depois do envio. O sistema não enviará' })).toEqual({ reason: 'joins-lines' });
  });

  it('too-short: a single word, however exact', () => {
    expect(scan(DOCS, { source: 'briefing.md', quote: '90' })).toEqual({ reason: 'too-short' });
  });

  it('negation: a part of a sentence whose rest of line holds a negation', () => {
    expect(scan(DOCS, { source: 'briefing.md', quote: 'enviará e-mails de cobrança aos clientes ativos ao fim do mês' })).toEqual({ reason: 'negation' });
  });

  it('decisions: a sentence of the owner decisions, which an answer would cite back', () => {
    expect(scan(DOCS, { source: 'briefing.md', quote: DECISION })).toEqual({ reason: 'decisions' });
  });

  it('hits a whole sentence and names the heading above it', () => {
    expect(scan(DOCS, { source: 'briefing.md', quote: LINK })).toEqual({ hit: { file: 'briefing.md', heading: 'Regras', quote: LINK } });
  });
});

describe('each relaxed rule changes only its own case', () => {
  it('sourceNames: a document named with a folder or another spelling is the document it means', () => {
    expect(scan(DOCS, { source: 'docs/briefing.md', quote: LINK }, STRICT_RULES)).toEqual({ reason: 'source-unknown' });
    expect(scan(DOCS, { source: 'docs/briefing.md', quote: LINK }, { ...STRICT_RULES, sourceNames: true })).toEqual({ hit: { file: 'briefing.md', heading: 'Regras', quote: LINK } });
  });

  it('decisions: a decision sentence counts only when the owner wrote that text', () => {
    expect(scan(DOCS, { source: 'briefing.md', quote: DECISION }, { ...STRICT_RULES, decisions: true, ownerTexts: ['trinta dias'] })).toEqual({ reason: 'decisions' });
    expect(scan(DOCS, { source: 'briefing.md', quote: DECISION }, { ...STRICT_RULES, decisions: true, ownerTexts: [DECISION] })).toEqual({ hit: { file: 'briefing.md', heading: 'Prazo', quote: DECISION } });
  });

  it('perQuote: an answer stands on the verified quotes when they hold its numbers, and strict refuses it', () => {
    const evidence = [{ source: 'briefing.md', quote: LINK }, { source: 'briefing.md', quote: 'Esta frase não existe no documento de briefing.' }];
    expect(verifyEvidence(DOCS, evidence, '90 dias')).toBeNull();
    const d = diagnoseEvidence(DOCS, evidence, '90 dias');
    expect(d.admits).toEqual({ strict: false, sourceNames: false, decisions: false, perQuote: true });
  });
});

describe('the strict rule and the diagnosis agree, and a relaxed rule never refuses what strict admits', () => {
  const quotes = [LINK, LINK.slice(0, 40), 'vale por 90 dias depois do envio', 'vale por 90 dias depois do envio. O sistema não enviará', LINK.replace(/ /g, '  '), 'O link de recuperação de senha vale por 60 dias depois do envio.', DECISION];
  const sources = ['briefing.md', 'project.md', 'docs/briefing.md'];

  it('matches verifyEvidence for each mutated quote, and strict implies every relaxed rule', () => {
    for (const source of sources) {
      for (const quote of quotes) {
        for (const answer of ['90 dias', '60 dias']) {
          const evidence = [{ source, quote }];
          const d = diagnoseEvidence(DOCS, evidence, answer, [DECISION]);
          expect(d.admits.strict).toBe(verifyEvidence(DOCS, evidence, answer) !== null);
          if (d.admits.strict) expect([d.admits.sourceNames, d.admits.decisions, d.admits.perQuote]).toEqual([true, true, true]);
        }
      }
    }
  });
});

describe('numbers of an answer', () => {
  it('names a number that no quote holds as missing', () => {
    expect(diagnoseEvidence(DOCS, [{ source: 'briefing.md', quote: LINK }], '60 dias').numbers).toEqual([{ number: '60', reason: 'number-missing' }]);
  });

  it('names a number written with a separator in the quote as a format difference', () => {
    const texts = { ...DOCS, 'briefing.md': 'O limite é 1.000 usuários por conta.' } as Record<SpeckitInput, string>;
    expect(diagnoseEvidence(texts, [{ source: 'briefing.md', quote: 'O limite é 1.000 usuários por conta.' }], '1000 usuários').numbers).toEqual([{ number: '1000', reason: 'number-format' }]);
  });

  it('reports the reason of each quote under the strict rule, or ok', () => {
    const d = diagnoseEvidence(DOCS, [{ source: 'briefing.md', quote: LINK }, { source: 'briefing.md', quote: DECISION }], '90 dias');
    expect(d.quotes).toEqual([{ source: 'briefing.md', reason: 'ok' }, { source: 'briefing.md', reason: 'decisions' }]);
  });
});
