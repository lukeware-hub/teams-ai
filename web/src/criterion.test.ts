import { describe, expect, it } from 'vitest';
import { criterionSentence } from './criterion.js';

describe('criterionSentence', () => {
  it('joins the three parts', () => {
    expect(criterionSentence({ id: 'AC-1', given: 'um serviço', when: 'o cliente chama', then: 'responde 200', smoke: false })).toBe('dado um serviço, quando o cliente chama, então responde 200');
  });

  it('drops a keyword the agent already wrote inside a part', () => {
    expect(criterionSentence({ id: 'AC-2', given: 'Dado que o serviço roda', when: 'Quando o cliente chama', then: 'Então responde 200', smoke: false })).toBe('dado que o serviço roda, quando o cliente chama, então responde 200');
  });
});
