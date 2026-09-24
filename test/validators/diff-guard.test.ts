import { describe, expect, it } from 'vitest';
import { checkScope } from '../../server/validators/diff-guard.js';

const base = {
  affectedPaths: ['src/todos/create/**'],
  frozenPaths: ['package.json', 'vitest.config.ts', '.github/**'],
};

describe('checkScope', () => {
  it('accepts changes inside affected paths', () => {
    expect(checkScope({ ...base, changedFiles: ['src/todos/create/handler.ts'] })).toEqual({
      ok: true,
      errors: [],
      frozenTouched: [],
      outOfScope: [],
    });
  });

  it('rejects frozen files even with a justification', () => {
    const result = checkScope({ ...base, changedFiles: ['package.json'], scopeJustification: 'needed a dependency' });
    expect(result.ok).toBe(false);
    expect(result.frozenTouched).toEqual(['package.json']);
    expect(result.errors).toEqual(['frozen files modified: package.json']);
  });

  it('matches dotfile directories in frozen globs', () => {
    expect(checkScope({ ...base, changedFiles: ['.github/workflows/ci.yml'] }).frozenTouched).toEqual(['.github/workflows/ci.yml']);
  });

  it('allows frozen files for the scaffold task', () => {
    const result = checkScope({ ...base, affectedPaths: ['package.json'], changedFiles: ['package.json'], allowFrozen: true });
    expect(result.ok).toBe(true);
    expect(result.frozenTouched).toEqual([]);
  });

  it('rejects out-of-scope files without a justification', () => {
    const result = checkScope({ ...base, changedFiles: ['src/todos/list/handler.ts'] });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['files outside affectedPaths without scopeJustification: src/todos/list/handler.ts']);
  });

  it('accepts out-of-scope files with a justification and reports them for review', () => {
    const result = checkScope({ ...base, changedFiles: ['src/shared/id.ts'], scopeJustification: 'shared id helper' });
    expect(result.ok).toBe(true);
    expect(result.outOfScope).toEqual(['src/shared/id.ts']);
  });

  it('treats a whitespace-only justification as missing', () => {
    expect(checkScope({ ...base, changedFiles: ['src/shared/id.ts'], scopeJustification: '   ' }).ok).toBe(false);
  });

  it('normalizes agent-style paths and removes duplicates', () => {
    const result = checkScope({ ...base, changedFiles: ['.\\src\\todos\\create\\handler.ts', 'src/todos/create/handler.ts'] });
    expect(result.ok).toBe(true);
  });

  it('treats a bare directory in affectedPaths as covering its children', () => {
    expect(checkScope({ ...base, affectedPaths: ['src/todos/create'], changedFiles: ['src/todos/create/deep/x.ts'] }).ok).toBe(true);
    expect(checkScope({ ...base, affectedPaths: ['src/todos/create/'], changedFiles: ['src/todos/create/x.ts'] }).ok).toBe(true);
  });

  it('matches directories with parentheses or plus signs literally', () => {
    expect(checkScope({ ...base, affectedPaths: ['app/(auth)'], changedFiles: ['app/(auth)/page.tsx'] }).ok).toBe(true);
    expect(checkScope({ ...base, affectedPaths: ['src/c++'], changedFiles: ['src/c++/x.cc'] }).ok).toBe(true);
  });

  it('treats the repository root as covering everything instead of crashing', () => {
    expect(checkScope({ ...base, affectedPaths: ['./'], changedFiles: ['anything/at/all.ts'] }).ok).toBe(true);
    expect(checkScope({ ...base, affectedPaths: ['.'], changedFiles: ['x.ts'] }).ok).toBe(true);
  });

  it('matches a leading-slash frozen glob', () => {
    expect(checkScope({ ...base, frozenPaths: ['/package.json'], changedFiles: ['package.json'] }).frozenTouched).toEqual(['package.json']);
  });
});
