import { describe, expect, it } from 'vitest';
import { explainStop } from '../../server/orchestrator/stop-explain.js';

describe('explainStop: a gate that keeps failing after its command was fixed', () => {
  it('puts the decision with the owner, not with the system', () => {
    const explained = explainStop('The gate unit-test still fails with the command it already runs. Only the owner can change its scope or its environment: x');
    expect(explained).toMatchObject({ owner: 'Você', title: 'Um gate continua reprovando, e a decisão é sua' });
  });
});
