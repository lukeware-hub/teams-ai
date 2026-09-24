import { describe, expect, it } from 'vitest';
import { unresolvedReferences, type RefContext } from '../../server/validators/references.js';

const ctx: RefContext = {
  acIds: new Set(['AC-001']),
  taskIds: new Set(['T1-create']),
  files: new Set(['src/todos/create.ts']),
  tests: new Set(['test/todos.test.ts::[AC-001] creates a todo']),
  adrIds: new Set(['ADR-001']),
};

describe('unresolvedReferences', () => {
  it('accepts references that exist', () => {
    expect(
      unresolvedReferences(
        {
          acIds: ['AC-001'],
          taskIds: ['T1-create'],
          files: ['src/todos/create.ts'],
          tests: ['test/todos.test.ts::[AC-001] creates a todo'],
          adrIds: ['ADR-001'],
        },
        ctx,
      ),
    ).toEqual([]);
  });

  it('reports each unknown reference', () => {
    expect(
      unresolvedReferences({ acIds: ['AC-009'], taskIds: ['T7-x'], tests: ['ghost'], adrIds: ['ADR-404'] }, ctx),
    ).toEqual(['unknown acceptance criterion: AC-009', 'unknown task: T7-x', 'unknown test: ghost', 'unknown ADR: ADR-404']);
  });

  it('normalizes file paths before lookup', () => {
    expect(unresolvedReferences({ files: ['.\\src\\todos\\create.ts'] }, ctx)).toEqual([]);
    expect(unresolvedReferences({ files: ['src/todos/delete.ts'] }, ctx)).toEqual(['unknown file: src/todos/delete.ts']);
  });
});
