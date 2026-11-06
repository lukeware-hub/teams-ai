import { describe, expect, it } from 'vitest';
import { stageText, type StageTextInput } from './stage-text.js';

const base: StageTextInput = { file: 'project.md', running: [], reviewed: false, scored: false, graphing: false, jevReads: true, jevDown: false, firstStage: false };
const step = (kind: string, role: string) => ({ stepId: 's', kind, role, model: 'claude-sonnet-5-5', effort: 'low', part: null, limitMs: null, startedAt: '2026-11-06T22:00:00Z' });

describe('stageText: what a stage review is doing, in plain words', () => {
  it('names the document and says the earlier ones are context only, after the first stage', () => {
    expect(stageText({ ...base, running: [step('refine', 'po')] })).toBe('PO está revisando só project.md; os documentos anteriores entram como resumo, para consulta.');
  });

  it('names only the document on the first stage, which has none before it', () => {
    expect(stageText({ ...base, file: 'flow.md', firstStage: true, running: [step('refine', 'po')] })).toBe('PO está revisando flow.md.');
  });

  it('names who reshapes the document while the reshape runs', () => {
    expect(stageText({ ...base, file: 'stack.md', running: [step('suggest', 'sm')] })).toBe('SM está reorganizando stack.md no modelo do documento.');
  });

  it('says the Jev gives the score of this document only, when it reads it', () => {
    expect(stageText({ ...base, reviewed: true })).toBe('Jev está dando a nota de project.md.');
    expect(stageText({ ...base, reviewed: true, jevReads: false })).toBe('Concluindo a revisão de project.md.');
  });

  it('shows the Graphify step for this document alone', () => {
    expect(stageText({ ...base, graphing: true })).toBe('Graphify está extraindo só project.md.');
  });

  it('says the Jev did not answer, and the stage goes on without its score', () => {
    expect(stageText({ ...base, jevDown: true })).toBe('Jev indisponível: confira a chave do OpenRouter. A etapa segue sem a nota dele.');
  });

  it('says it is preparing when nothing runs yet', () => {
    expect(stageText(base)).toBe('Preparando a revisão de project.md.');
  });
});
