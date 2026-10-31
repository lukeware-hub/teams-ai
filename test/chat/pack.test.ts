import { describe, expect, it } from 'vitest';
import { chatSystem } from '../../server/chat/pack.js';

describe('the chat rules', () => {
  const rules = chatSystem('context');

  it('answer from the recorded facts, the detail files and the guide, and say when a fact is not recorded', () => {
    expect(rules).toContain('"Problemas registrados"');
    expect(rules).toContain('`falhas/`');
    expect(rules).toContain('If the record does not say it, say so in one sentence');
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
