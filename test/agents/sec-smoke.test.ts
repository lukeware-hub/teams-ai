import { describe, expect, it } from 'vitest';
import { secSmokeProblems } from '../../scripts/smoke/sec-check.js';

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
