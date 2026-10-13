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
  it('reads ac_001 and ac-001 where an identifier cannot hold brackets (Rust fn, pytest def)', () => {
    expect(extractAcIds('tests::ac_001_lists_books test_ac-002_health stack_ac_0034 tractac_005')).toEqual(['AC-001', 'AC-002']);
  });

  it('reads ids of four digits and more, but not a leading zero', () => {
    expect(extractAcIds('[ac-1000] ac_1001_x test_ac-0034 stack_ac_01000')).toEqual(['AC-1000', 'AC-1001']);
  });

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

describe('parseTap', () => {
  it('reads top-level ok / not ok lines with their [AC-xxx] tags', async () => {
    const { parseTap } = await import('../../server/evidence/junit.js');
    const tap = ['TAP version 13', 'ok 1 - [AC-001] GET /hello answers 200', 'not ok 2 - [AC-003] bad path', 'ok 3 - [AC-002] later # SKIP not now', '1..3'].join('\n');
    expect(parseTap(tap).map((t) => [t.acIds, t.status])).toEqual([[['AC-001'], 'passed'], [['AC-003'], 'failed'], [['AC-002'], 'skipped']]);
    expect(parseTap('no tap here')).toEqual([]);
  });

  it('reads go test -v result lines with their [AC-xxx] tags', async () => {
    const { parseTap } = await import('../../server/evidence/junit.js');
    const out = ['=== RUN   TestSmoke', '--- FAIL: TestSmoke (0.00s)', '    --- PASS: TestSmoke/[AC-003]_check_devolve_SERVING (0.00s)', '    --- FAIL: TestSmoke/[AC-004]_not_found (0.01s)', '    --- SKIP: TestSmoke/[AC-005]_watch (0.00s)'].join('\n');
    expect(parseTap(out).filter((t) => t.acIds.length > 0).map((t) => [t.acIds, t.status])).toEqual([[['AC-003'], 'passed'], [['AC-004'], 'failed'], [['AC-005'], 'skipped']]);
  });

  it('reads cargo test and pytest -v result lines with their ac ids', async () => {
    const { parseTap } = await import('../../server/evidence/junit.js');
    const out = ['test ac_001_health_ok ... ok', 'test ac_002_bad ... FAILED', 'tests/test_smoke.py::test_ac_003_health PASSED [ 50%]', 'tests/test_smoke.py::test_ac_004_x SKIPPED'].join('\n');
    expect(parseTap(out).map((t) => [t.acIds, t.status])).toEqual([[['AC-001'], 'passed'], [['AC-002'], 'failed'], [['AC-003'], 'passed'], [['AC-004'], 'skipped']]);
  });

  it('reads python unittest verbose result lines with their ac ids', async () => {
    const { parseTap } = await import('../../server/evidence/junit.js');
    const out = ['test_ac_001_health (__main__.Smoke.test_ac_001_health) ... ok', 'test_ac_002_hello (__main__.Smoke.test_ac_002_hello) ... FAIL', 'test_ac_003_x (__main__.Smoke.test_ac_003_x) ... skipped "later"'].join('\n');
    expect(parseTap(out).map((t) => [t.acIds, t.status])).toEqual([[['AC-001'], 'passed'], [['AC-002'], 'failed'], [['AC-003'], 'skipped']]);
  });

  it('also reads indented subtest lines: a [AC-xxx] test() nested under a describe() still counts (R8.7 golden run finding)', async () => {
    const { parseTap } = await import('../../server/evidence/junit.js');
    const tap = [
      'TAP version 13',
      '# Subtest: smoke contra http://x',
      '    # Subtest: [AC-005] GET /health responde 200',
      '    ok 1 - [AC-005] GET /health responde 200',
      '      ---',
      "      duration_ms: 1.23",
      '      ...',
      '    1..1',
      'ok 1 - smoke contra http://x',
      '  ---',
      '  ...',
      '1..1',
    ].join('\n');
    const results = parseTap(tap);
    expect(results.some((t) => t.acIds.includes('AC-005') && t.status === 'passed')).toBe(true);
    // The parent describe's own rollup line carries no [AC-xxx] tag; evaluateSmoke/evaluateE2e never select it.
    expect(results.some((t) => t.acIds.length === 0)).toBe(true);
  });

  it('reads the spec reporter lines of node --test too (live, user-api run-4: a passing smoke read back as "no smoke test")', async () => {
    const { parseTap } = await import('../../server/evidence/junit.js');
    const spec = [
      '✔ [AC-005] GET /health responde 200 com status ok (47.249713ms)',
      '▶ users',
      '  ✖ [AC-007] POST /users registra usuário (15.4ms)',
      '  ﹣ [AC-008] later (0.1ms) # SKIP',
      'ℹ tests 3',
    ].join('\n');
    expect(parseTap(spec).map((t) => [t.name, t.acIds, t.status])).toEqual([
      ['[AC-005] GET /health responde 200 com status ok', ['AC-005'], 'passed'],
      ['[AC-007] POST /users registra usuário', ['AC-007'], 'failed'],
      ['[AC-008] later', ['AC-008'], 'skipped'],
    ]);
  });
});
