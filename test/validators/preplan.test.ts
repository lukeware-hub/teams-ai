import { describe, expect, it } from 'vitest';
import type { PreplanTask } from '../../server/contracts/preplan.js';
import { validatePreplan } from '../../server/validators/preplan.js';

const ac = (id: string) => ({ id, given: 'g', when: 'w', then: 't', smoke: false });
const spec = { acceptanceCriteria: [ac('AC-047'), ac('AC-048')] };
const task = (id: string, over: Partial<PreplanTask> = {}): PreplanTask => ({ id, title: `Tarefa ${id}`, module: 'opme', owner: 'dev', criteriaRefs: ['AC-047'], dependsOn: [], ...over });
const modules = [{ name: 'opme', purpose: 'p' }];

describe('validatePreplan', () => {
  it('accepts a pre-plan whose tasks cover every criterion of the spec', () => {
    expect(validatePreplan({ modules, tasks: [task('P1'), task('P2', { criteriaRefs: ['AC-048'], dependsOn: ['P1'] })] }, spec)).toEqual([]);
  });

  it('rejects duplicate ids, unknown modules and dependencies, self and cyclic dependencies', () => {
    const errors = validatePreplan({ modules, tasks: [
      task('P1', { dependsOn: ['P3'] }), task('P1', { criteriaRefs: ['AC-048'] }), task('P2', { module: 'faturamento', dependsOn: ['P2', 'P9'] }), task('P3', { dependsOn: ['P1'] }),
    ] }, spec);
    expect(errors).toEqual(expect.arrayContaining([
      'tarefa duplicada: P1',
      'tarefa P2: módulo desconhecido faturamento',
      'tarefa P2 depende dela mesma',
      'tarefa P2: dependência desconhecida P9',
      expect.stringMatching(/^ciclo de dependências: /),
    ]));
  });

  it('rejects criteria of other specs and criteria no task covers', () => {
    const errors = validatePreplan({ modules, tasks: [task('P1', { criteriaRefs: ['AC-047', 'AC-099'] })] }, spec);
    expect(errors).toEqual(['tarefa P1: critério AC-099 não é desta spec', 'critério AC-048 sem nenhuma tarefa']);
  });
});
