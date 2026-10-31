import { describe, expect, it } from 'vitest';
import { chatSystem } from '../../server/chat/pack.js';

describe('the chat rules', () => {
  const rules = chatSystem('context');

  it('answer from the recorded facts, the detail files and the guide, and say when a fact is not recorded', () => {
    expect(rules).toContain('"Problemas registrados"');
    expect(rules).toContain('`falhas/`');
    expect(rules).toContain('If the record does not say it, say so in one sentence');
  });

  it('never turns an agent\x27s suggestion into a question for the person', () => {
    expect(rules).toContain('Pergunta pendente de você');
    expect(rules).toContain('not a fact of the system');
  });

  it('ask for the three-part answer to a problem and keep the chat read-only', () => {
    expect(rules).toContain('**O que você pode fazer**');
    expect(rules).toContain('Never give orders');
  });

  it('allow one web search only for a recorded error, and never a web address of its own', () => {
    expect(rules).toContain('at most one search per question');
    expect(rules).toContain('Write no web address; the system adds the sources.');
  });

  it('keep the context after the rules, so the rules stay the same prefix of every question', () => {
    expect(rules.indexOf('### Project context')).toBeGreaterThan(rules.indexOf('Help a person'));
    expect(rules.endsWith('### Project context\ncontext')).toBe(true);
  });
});

describe('the two rules the answers keep missing', () => {
  const rules = chatSystem('context');
  it('names the record in a sentence that a missing fact must end with', () => {
    expect(rules).toContain('then name the record by its name: o histórico da execução, o arquivo de falhas da spec, os documentos do projeto ou o guia');
  });
  it('gives the three labels to every question about what happened, why, or what to do', () => {
    expect(rules).toContain('Every question about what happened, why, or what to do gets the three labelled paragraphs');
  });
});
