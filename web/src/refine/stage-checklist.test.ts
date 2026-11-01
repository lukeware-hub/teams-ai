import { describe, expect, it } from 'vitest';
import { firstFailing, graphLabel, stageChecklist, type StageChecklistInput } from './stage-checklist.js';

const ready: StageChecklistInput = { reviewed: true, openQuestions: 0, pendingSuggestions: 0, formatProblem: null, graphed: true, graphing: false, graphError: null };

describe('stage checklist', () => {
  it('passes every line when the stage is ready to continue', () => {
    const checks = stageChecklist(ready);
    expect(checks.map((c) => c.id)).toEqual(['reviewed', 'no-question', 'no-suggestion', 'format', 'graphed']);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(firstFailing(checks)).toBeNull();
  });

  it('names the first failing line, so the disabled Continuar can say why', () => {
    const checks = stageChecklist({ ...ready, openQuestions: 2, graphed: false });
    expect(firstFailing(checks)).toMatchObject({ id: 'no-question', hint: 'Responda a pergunta obrigatória desta etapa.' });
  });

  it('shows the format problem in plain words, as the hint of its line', () => {
    const check = stageChecklist({ ...ready, formatProblem: 'A etapa flow.md está vazia.' }).find((c) => c.id === 'format');
    expect(check).toMatchObject({ ok: false, hint: 'A etapa flow.md está vazia.' });
  });

  it('shows the graph failure reason on the graph line', () => {
    const check = stageChecklist({ ...ready, graphed: false, graphError: 'limite de uso atingido' }).find((c) => c.id === 'graphed');
    expect(check?.hint).toBe('limite de uso atingido');
  });
});

describe('graph label', () => {
  it('says the extraction runs, then how many nodes the document has in the graph', () => {
    expect(graphLabel({ graphed: false, graphing: true }, null)).toBe('Adicionando ao Graphify…');
    expect(graphLabel({ graphed: true, graphing: false }, 42)).toBe('No Graphify: 42 nós');
    expect(graphLabel({ graphed: false, graphing: false }, null)).toBe('No Graphify');
  });
});
