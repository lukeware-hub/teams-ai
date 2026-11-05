import { describe, expect, it } from 'vitest';
import { secSeededProblems, secSmokeProblems } from '../../scripts/smoke/sec-check.js';
import { SEC_CASES } from '../../scripts/smoke/sec-cases.js';

const HASH = `sha256:${'a'.repeat(64)}`;
const finding = (file: string) => ({ file, line: 2, severity: 'critical', category: 'command injection', problem: 'name reaches a shell', fix: 'use execFile with an argument array' });
const reply = (...files: string[]) => ({ ok: true as const, value: { specHash: HASH, decision: 'changes', findings: files.map(finding) } });

describe('sec smoke verdict', () => {
  it('passes when the reply matches the schema and flags the seeded file, however the agent writes its path', () => {
    expect(secSmokeProblems(reply('greet.js'), 'greet.js')).toEqual([]);
    expect(secSmokeProblems(reply('./greet.js'), 'greet.js')).toEqual([]);
    expect(secSmokeProblems(reply('/tmp/teams-ai-sec-smoke-x1/greet.js'), 'greet.js')).toEqual([]);
    expect(secSmokeProblems(reply('other.js', 'greet.js'), 'greet.js')).toEqual([]);
  });

  it('fails when the step itself failed, with the failure kind and the first errors', () => {
    const problems = secSmokeProblems({ ok: false, failure: 'schema', errors: ['findings.0.severity: Invalid option', 'findings.0.problem: Invalid input: expected string', 'a', 'dropped fourth error'] }, 'greet.js');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('schema');
    expect(problems[0]).toContain('findings.0.severity');
    expect(problems[0]).not.toContain('dropped fourth error');
  });

  it('fails when an ok reply does not match the SecurityOutput schema (renamed fields, missing severity)', () => {
    const wrongFields = { ok: true as const, value: { specHash: HASH, decision: 'changes', findings: [{ file: 'greet.js', line: 2, issue: 'command injection', fix: 'f' }] } };
    const problems = secSmokeProblems(wrongFields, 'greet.js');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('SecurityOutput');
    expect(secSmokeProblems({ ok: true, value: null }, 'greet.js')).toHaveLength(1);
  });

  it('fails when the reply has no findings, since the file is vulnerable on purpose', () => {
    const problems = secSmokeProblems(reply(), 'greet.js');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('no findings');
  });

  it('fails when no finding is on the seeded file, naming where the findings are', () => {
    const problems = secSmokeProblems(reply('package.json', 'README.md'), 'greet.js');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('greet.js');
    expect(problems[0]).toContain('package.json');
  });
});

describe('sec seeded verdict', () => {
  const reviewed = (...found: Array<[string, string]>) => ({ ok: true as const, value: { specHash: HASH, decision: 'changes', findings: found.map(([file, severity]) => ({ file, line: 1, severity, category: 'x', problem: 'p', fix: 'f' })) } });

  it('passes a flawed case with a blocking finding on its file and fails one with only a medium', () => {
    expect(secSeededProblems(reviewed(['./server.js', 'high']), 'server.js', true)).toEqual([]);
    expect(secSeededProblems(reviewed(['server.js', 'medium']), 'server.js', true)[0]).toContain('no critical or high finding on server.js');
  });

  it('passes a clean case with no blocking finding and flags a false alarm', () => {
    expect(secSeededProblems(reviewed(['notes.js', 'low']), 'notes.js', false)).toEqual([]);
    expect(secSeededProblems(reviewed(['notes.js', 'high']), 'notes.js', false)[0]).toContain('false alarm');
  });

  it('seeds the four named flaws and one clean control', () => {
    expect(SEC_CASES.filter((c) => c.flawed).map((c) => c.name)).toEqual(['csrf', 'idor', 'cors', 'ssrf']);
    expect(SEC_CASES.filter((c) => !c.flawed)).toHaveLength(1);
  });
});
