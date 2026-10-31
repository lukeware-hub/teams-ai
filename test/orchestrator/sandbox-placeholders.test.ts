import { describe, expect, it } from 'vitest';
import { devChangedFiles } from '../../server/orchestrator/sandbox-placeholders.js';

describe('devChangedFiles', () => {
  it('drops the empty dotfiles the sandbox leaves in a worktree', () => {
    expect(devChangedFiles(['.bashrc', 'api/package.json', '.gitconfig', '.mcp.json'])).toEqual(['api/package.json']);
  });

  it('keeps the files the Dev changed, dotfiles included when they are not sandbox placeholders', () => {
    expect(devChangedFiles(['.dockerignore', 'Dockerfile', 'api/migrations/001.sql'])).toEqual(['.dockerignore', 'Dockerfile', 'api/migrations/001.sql']);
  });

  it('drops the build cache the sandbox keeps under .tools, which no commit of a task holds', () => {
    expect(devChangedFiles(['.tools/go-build/aa/x', 'src/a.ts', '.tools'])).toEqual(['src/a.ts']);
  });
});
