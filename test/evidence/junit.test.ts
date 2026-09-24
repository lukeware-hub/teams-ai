import { describe, expect, it } from 'vitest';
import { JUnitParseError, extractAcIds, parseJUnit } from '../../server/evidence/junit.js';

const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="todos" tests="4">
    <testcase classname="test/todos.test.ts" name="[AC-001] creates a todo"/>
    <testcase classname="test/todos.test.ts" name="[ac-002] lists todos"><failure message="expected 2, got 1"/></testcase>
    <testcase classname="test/todos.test.ts" name="[AC-2] loose tag is ignored"/>
    <testcase classname="test/todos.test.ts" name="skipped case"><skipped/></testcase>
  </testsuite>
</testsuites>`;

describe('extractAcIds', () => {
  it('accepts any case but requires three digits', () => {
    expect(extractAcIds('[ac-003] and [AC-001] and [AC-3] and [AC-001]')).toEqual(['AC-003', 'AC-001']);
  });
});

describe('parseJUnit', () => {
  it('parses statuses and AC tags', () => {
    expect(parseJUnit(REPORT)).toEqual([
      { id: 'test/todos.test.ts::[AC-001] creates a todo', name: '[AC-001] creates a todo', classname: 'test/todos.test.ts', status: 'passed', acIds: ['AC-001'] },
      { id: 'test/todos.test.ts::[ac-002] lists todos', name: '[ac-002] lists todos', classname: 'test/todos.test.ts', status: 'failed', acIds: ['AC-002'] },
      { id: 'test/todos.test.ts::[AC-2] loose tag is ignored', name: '[AC-2] loose tag is ignored', classname: 'test/todos.test.ts', status: 'passed', acIds: [] },
      { id: 'test/todos.test.ts::skipped case', name: 'skipped case', classname: 'test/todos.test.ts', status: 'skipped', acIds: [] },
    ]);
  });

  it('treats <error> as a failure', () => {
    const xml = '<testsuite name="s"><testcase classname="c" name="[AC-001] boom"><error message="x"/></testcase></testsuite>';
    expect(parseJUnit(xml)[0]!.status).toBe('failed');
  });

  it('accepts a single root testsuite with one testcase', () => {
    const results = parseJUnit('<testsuite name="one"><testcase classname="a" name="[AC-001] only"/></testsuite>');
    expect(results).toHaveLength(1);
    expect(results[0]!.acIds).toEqual(['AC-001']);
  });

  it('collects testcases from nested suites', () => {
    const xml = '<testsuites><testsuite name="outer"><testsuite name="inner"><testcase classname="b" name="[AC-003] nested"/></testsuite></testsuite></testsuites>';
    expect(parseJUnit(xml).map((r) => r.acIds)).toEqual([['AC-003']]);
  });

  it('collects testcases from nested testsuites containers', () => {
    const xml = '<testsuites><testsuites><testsuite name="s"><testcase classname="c" name="[AC-001] deep"/></testsuite></testsuites></testsuites>';
    expect(parseJUnit(xml)).toHaveLength(1);
  });

  it('falls back to the suite name when classname is missing, so ids do not collide', () => {
    const xml = '<testsuites><testsuite name="s1"><testcase name="[AC-001] t"/></testsuite><testsuite name="s2"><testcase name="[AC-001] t"><failure/></testcase></testsuite></testsuites>';
    expect(parseJUnit(xml).map((r) => r.id)).toEqual(['s1::[AC-001] t', 's2::[AC-001] t']);
  });

  it('reads AC tags from the classname too', () => {
    const xml = '<testsuite name="s"><testcase classname="[AC-004] suite" name="case"/></testsuite>';
    expect(parseJUnit(xml)[0]!.acIds).toEqual(['AC-004']);
  });

  it('returns no results for an empty report', () => {
    expect(parseJUnit('<testsuites></testsuites>')).toEqual([]);
  });

  it('throws on malformed XML', () => {
    expect(() => parseJUnit('<testsuites><testsuite>')).toThrow(JUnitParseError);
  });
});
