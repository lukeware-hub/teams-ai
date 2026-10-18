import { describe, expect, it } from 'vitest';
import { outlineQuestions } from '../../server/refine/cycle.js';

describe('outlineQuestions', () => {
  it('turns each rule the outline breaks into a blocking question for the owner', () => {
    const questions = outlineQuestions(['seção do flow.md sem nenhum item: "33. Máquinas de estado canônicas"', 'item web-portal-shell cita design.md › "2. Tokens semânticos"'], 3, []);
    expect(questions).toHaveLength(2);
    expect(questions[0]).toMatchObject({ questionId: 'outline-c3-0', role: 'po', blocking: true, relatedAcIds: [], cycle: 3 });
    expect(questions[0]!.text).toContain('33. Máquinas de estado canônicas');
    expect(questions[1]!.text).toContain('2. Tokens semânticos');
  });

  it('does not ask again a rule a pending question already names', () => {
    const asked = ['O backlog ainda não fecha: seção do flow.md sem nenhum item: "33. Máquinas de estado canônicas". Como o backlog deve tratar isso?'];
    expect(outlineQuestions(['seção do flow.md sem nenhum item: "33. Máquinas de estado canônicas"'], 4, asked)).toEqual([]);
  });
});
