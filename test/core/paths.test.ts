import { describe, expect, it } from 'vitest';
import { hasGlobChars, normalizePath, pathsOverlap, staticPrefix } from '../../server/core/paths.js';

describe('normalizePath', () => {
  it('converts backslashes, strips ./ and trailing slashes, collapses repeats', () => {
    expect(normalizePath('.\\src\\auth\\')).toBe('src/auth');
    expect(normalizePath('./src//user/')).toBe('src/user');
    expect(normalizePath('package.json')).toBe('package.json');
  });

  it('collapses inner ./ segments and strips a leading slash', () => {
    expect(normalizePath('src/./a.ts')).toBe('src/a.ts');
    expect(normalizePath('/src/a.ts')).toBe('src/a.ts');
  });

  it('maps the repository root to the empty string', () => {
    expect(normalizePath('.')).toBe('');
    expect(normalizePath('./')).toBe('');
    expect(normalizePath('')).toBe('');
  });
});

describe('hasGlobChars', () => {
  it('detects glob syntax but not parentheses or plus signs', () => {
    expect(hasGlobChars('src/**')).toBe(true);
    expect(hasGlobChars('src/{a,b}.ts')).toBe(true);
    expect(hasGlobChars('src/auth')).toBe(false);
    expect(hasGlobChars('app/(auth)/page.tsx')).toBe(false);
    expect(hasGlobChars('src/c++/x.cc')).toBe(false);
  });
});

describe('staticPrefix', () => {
  it('returns the path before the first glob segment', () => {
    expect(staticPrefix('src/auth/**')).toBe('src/auth');
    expect(staticPrefix('src/*.ts')).toBe('src');
    expect(staticPrefix('**/*.md')).toBe('');
    expect(staticPrefix('Dockerfile')).toBe('Dockerfile');
    expect(staticPrefix('app/(auth)/**')).toBe('app/(auth)');
  });
});

describe('pathsOverlap', () => {
  it('detects ancestor and equal paths', () => {
    expect(pathsOverlap(['src/auth/**'], ['src/auth/login.ts'])).toBe(true);
    expect(pathsOverlap(['src/auth'], ['src/auth/login.ts'])).toBe(true);
    expect(pathsOverlap(['Dockerfile'], ['Dockerfile'])).toBe(true);
  });

  it('does not confuse sibling names sharing a prefix', () => {
    expect(pathsOverlap(['src/auth/**'], ['src/authz/**'])).toBe(false);
    expect(pathsOverlap(['src/a.ts'], ['src/a.ts.bak'])).toBe(false);
  });

  it('treats root-level globs and the repository root as overlapping everything', () => {
    expect(pathsOverlap(['**/*.md'], ['src/user/**'])).toBe(true);
    expect(pathsOverlap(['.'], ['src/user/**'])).toBe(true);
  });

  it('normalizes agent-style paths before comparing', () => {
    expect(pathsOverlap(['.\\src\\auth\\'], ['src/auth/**'])).toBe(true);
    expect(pathsOverlap(['src/./a.ts'], ['src/a.ts'])).toBe(true);
    expect(pathsOverlap(['/src/a.ts'], ['src/a.ts'])).toBe(true);
  });
});
