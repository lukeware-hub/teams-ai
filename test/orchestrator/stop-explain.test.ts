import { describe, expect, it } from 'vitest';
import { blockExplanation, explainStop } from '../../server/orchestrator/stop-explain.js';

describe('explainStop: the repository could not be prepared on GitHub', () => {
  it.each(['gh repo create failed', 'git push main failed', 'git ls-remote failed', 'git remote add origin failed'])('explains "%s" in pt-BR and keeps the next step with the owner', (prefix) => {
    const explained = explainStop(`${prefix}: remote: fatal error in commit_refs_rules\nAttempts: 4 of 4.`);
    expect(explained).toMatchObject({ owner: 'Você', title: 'O GitHub recusou criar ou preencher o repositório' });
    expect(explained!.hint).toContain('Tentar de novo');
    expect(explained!.hint).not.toMatch(/reprocess/i);
  });
});

describe('explainStop: the documentation snapshot lacks a file the task reads', () => {
  it('explains it in pt-BR and keeps the next step with the system', () => {
    const explained = explainStop('the documentation snapshot has no docs/specify/x/plan.md, docs/project.md');
    expect(explained).toMatchObject({ owner: 'Sistema', title: 'Faltam documentos no retrato dos documentos desta execução' });
    expect(explained!.hint).toContain('Tentar de novo');
    expect(explained!.hint).not.toMatch(/reprocess/i);
  });
});

describe('explainStop: a gate that keeps failing after its command was fixed', () => {
  it('puts the decision with the owner, not with the system', () => {
    const explained = explainStop('The gate unit-test still fails with the command it already runs. Only the owner can change its scope or its environment: x');
    expect(explained).toMatchObject({ owner: 'Você', title: 'Um gate continua reprovando, e a decisão é sua' });
  });
});

describe('blockExplanation: spec-gap rounds exhausted', () => {
  const reason = 'spec-gap rounds exhausted (3); last question: which Go?';

  it('stays with the owner when the owner decides', () => {
    expect(blockExplanation(reason, false)).toMatchObject({ owner: 'Você' });
  });

  it('is the system failing, not the owner, when the agents decide', () => {
    const why = blockExplanation(reason, true);
    expect(why.owner).toBe('Sistema');
    expect(why.next).not.toMatch(/spec|nova execução/i);
  });
});
