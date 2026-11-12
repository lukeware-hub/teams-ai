import { describe, expect, it } from 'vitest';
import { codeQuestionOf } from '../../server/knowledge/code-question.js';

const task = (affectedPaths: string[]) => ({ title: 'Registrar o evento', description: 'Grava o evento na cadeia.', affectedPaths });

describe('codeQuestionOf', () => {
  it('asks with what the task is, then the names of the files it will change', () => {
    expect(codeQuestionOf(task(['cmd/audit/main.go', 'internal/store/store.go']))).toBe('Registrar o evento Grava o evento na cadeia. main.go store.go');
  });

  it('names a file once, leaves out the patterns, and keeps only the first few names', () => {
    expect(codeQuestionOf(task(['a/main.go', 'b/main.go', 'src/**/*.ts']))).toBe('Registrar o evento Grava o evento na cadeia. main.go');
    const many = Array.from({ length: 9 }, (_, i) => `src/f${i}.go`);
    expect(codeQuestionOf(task(many)).split(' ').filter((w) => w.endsWith('.go'))).toEqual(['f0.go', 'f1.go', 'f2.go', 'f3.go', 'f4.go', 'f5.go']);
  });

  it('is the old question when the task changes no named file', () => {
    expect(codeQuestionOf(task([]))).toBe('Registrar o evento Grava o evento na cadeia.');
    expect(codeQuestionOf(task(['src/**']))).toBe('Registrar o evento Grava o evento na cadeia.');
  });
});
