import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fits, locateTests, needlesOf, parseHits, pickPlace, testsByRepo, type Hit, type TestRef } from '../../server/evidence/locate.js';
import { execCommand, type CommandResult, type CommandSpec, type Exec } from '../../server/exec/command.js';
import { commitAll } from '../../server/git/git.js';
import type { StoredEvent } from '../../server/store/event-store.js';

const SHA = 'b'.repeat(40);
const NUL = '\u0000';
const lineOf = (text: string, needle: string) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;
const matches = (pattern: string, text: string) => new RegExp(pattern).test(text);
const ref = (classname: string, name: string): TestRef => ({ id: `${classname}::${name}`, name, classname });

describe('needlesOf', () => {
  it('finds a Go test by its function and a subtest by its quoted title', () => {
    expect(needlesOf('TestAc_031_PaginaTemOsTresMarcos')).toEqual({ anchor: '^func TestAc_031_PaginaTemOsTresMarcos[(]', leaf: null });
    const leaf = needlesOf('TestAc_031_X/[AC-031]_aponta_o_nav_que_falta')!.leaf!;
    expect(matches(leaf, '"[AC-031] aponta o nav que falta"')).toBe(true);
    expect(matches(leaf, '"[AC-031] aponta o nav que falta com detalhe"')).toBe(false);
    // A duplicate subtest keeps its #01, so it finds no title and falls back to the function.
    const duplicate = needlesOf('TestAc_031_X/[AC-031]_aponta_o_nav_que_falta#01')!.leaf!;
    expect(matches(duplicate, '"[AC-031] aponta o nav que falta"')).toBe(false);
  });

  it('finds other stacks by the function name, or by the quoted title with its AC tag', () => {
    expect(matches(needlesOf('test_ac_003_health[1-a]')!.anchor, 'def test_ac_003_health():')).toBe(true);
    expect(matches(needlesOf('tests::ac_001_x')!.anchor, 'fn ac_001_x() {')).toBe(true);
    expect(matches(needlesOf('shouldPlaceOrder()')!.anchor, '    void shouldPlaceOrder() {}')).toBe(true);
    expect(matches(needlesOf('suite > [AC-003] checks it')!.anchor, 'it("[AC-003] checks it", () => {})')).toBe(true);
    expect(matches(needlesOf('app do médico › [AC-039] cabeçalho')!.anchor, 'test("[AC-039] cabeçalho", () => {})')).toBe(true);
  });

  it('escapes the characters a title may hold, so they match only themselves', () => {
    const anchor = needlesOf('suite > [AC-004] a (b)+ c*')!.anchor;
    expect(matches(anchor, '"[AC-004] a (b)+ c*"')).toBe(true);
    expect(matches(anchor, '"[AC-004] a b c"')).toBe(false);
  });

  it('refuses names it cannot search for safely', () => {
    for (const bad of ['', `${NUL}x`, 'x\ny', 'a'.repeat(301), 'free text without a tag', 'ab', 'TestAc_001 x']) {
      expect(needlesOf(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('fits', () => {
  it('matches a path, a Go package or a dotted class to its file', () => {
    expect(fits('web/src/a.test.ts', 'src/a.test.ts')).toBe(true);
    expect(fits('web/src/b.test.ts', 'src/a.test.ts')).toBe(false);
    expect(fits('tests/smoke/tls_test.go', 'web-bff-api/tests/smoke')).toBe(true);
    expect(fits('tests/smoke/tls_test.go', 'web-bff-api/mytests/smoke')).toBe(false);
    expect(fits('tests/test_smoke.py', 'tests.test_smoke')).toBe(true);
    expect(fits('src/test/java/com/acme/OrdersTest.java', 'com.acme.OrdersTest')).toBe(true);
    expect(fits('a.go', 'tap')).toBe(false);
    expect(fits('a.go', '')).toBe(false);
  });
});

describe('parseHits', () => {
  it('reads path, line and match of each record and keeps only the records of this commit', () => {
    const stdout = [`${SHA}:tests/a.go${NUL}63${NUL}func TestX(`, `${'c'.repeat(40)}:other.go${NUL}1${NUL}func TestX(`, `${SHA}:b c/d.go${NUL}5${NUL}"[AC-001] x"`, ''].join('\n');
    expect(parseHits(stdout, SHA)).toEqual([
      { path: 'tests/a.go', line: 63, text: 'func TestX(' },
      { path: 'b c/d.go', line: 5, text: '"[AC-001] x"' },
    ]);
  });
});

describe('pickPlace', () => {
  const hit = (p: string, line: number, text: string): Hit => ({ path: p, line, text });

  it('takes a subtest title only inside the function of its own test', () => {
    const hits = [hit('t/x_test.go', 10, 'func TestA('), hit('t/x_test.go', 14, '"[AC-001] um titulo"'), hit('t/x_test.go', 30, 'func TestB('), hit('t/x_test.go', 40, '"[AC-001] um titulo"')];
    expect(pickPlace(hits, needlesOf('TestA/[AC-001]_um_titulo')!, 't')).toEqual({ path: 't/x_test.go', line: 14 });
  });

  it('falls back to the function line when the title is repeated in the function or missing', () => {
    const hits = [hit('t/x_test.go', 10, 'func TestA('), hit('t/x_test.go', 14, '"[AC-001] um titulo"'), hit('t/x_test.go', 20, '"[AC-001] um titulo"')];
    expect(pickPlace(hits, needlesOf('TestA/[AC-001]_um_titulo')!, 't')).toEqual({ path: 't/x_test.go', line: 10 });
    expect(pickPlace([hits[0]!], needlesOf('TestA/[AC-002]_outro')!, 't')).toEqual({ path: 't/x_test.go', line: 10 });
  });

  it('picks the file of the test class when two files define the same function', () => {
    const hits = [hit('a/x_test.go', 10, 'func TestA('), hit('b/x_test.go', 3, 'func TestA(')];
    expect(pickPlace(hits, needlesOf('TestA')!, 'pkg/b')).toEqual({ path: 'b/x_test.go', line: 3 });
    expect(pickPlace(hits, needlesOf('TestA')!, 'pkg/c')).toBeNull();
  });

  it('gives no place for a free-text title that appears twice in one file', () => {
    const hits = [hit('web/src/a.test.ts', 2, '"[AC-003] checks it"'), hit('web/src/a.test.ts', 9, '"[AC-003] checks it"')];
    expect(pickPlace(hits, needlesOf('suite > [AC-003] checks it')!, 'src/a.test.ts')).toBeNull();
  });
});

describe('testsByRepo', () => {
  const row = (classname: string, name: string, acIds: string[]) => ({ id: `${classname}::${name}`, name, classname, status: 'passed', acIds });
  const gate = (data: Record<string, unknown>): StoredEvent => ({ seq: 1, at: '', runId: 'r', specHash: '', type: 'GATE_PASSED', kind: 'fact', data });

  it('groups the acceptance tests by the repository of their gate and leaves out ids seen in two repositories', () => {
    const events = [
      gate({ taskId: 'T1', junit: [row('p/api', 'TestAc_001_A', ['AC-001']), row('p/api', 'TestHelper', []), row('p', 'TestAc_004_X', ['AC-004'])] }),
      gate({ phase: 4, service: 'web', junit: [row('p/web', 'TestAc_002_W', ['AC-002']), row('p/shared', 'TestAc_003_D', ['AC-003']), row('p', 'TestAc_004_X', ['AC-004'])] }),
      gate({ taskId: 'T9', junit: [row('p/shared', 'TestAc_003_D', ['AC-003'])] }),
    ];
    const byRepo = testsByRepo(events, (taskId) => ({ T1: 'api', T9: 'web' })[taskId]);
    expect(byRepo).toEqual(
      new Map([
        ['api', [ref('p/api', 'TestAc_001_A')]],
        ['web', [ref('p/web', 'TestAc_002_W'), ref('p/shared', 'TestAc_003_D')]],
      ]),
    );
  });
});

const roots: string[] = [];
afterAll(async () => {
  for (const dir of roots) await fs.rm(dir, { recursive: true, force: true });
});

/** A git repository with the files committed; origin/main points at the commit unless `origin` is false. */
async function repoWith(files: Record<string, string>, origin = true): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-locate-'));
  roots.push(dir);
  await execCommand({ bin: 'git', args: ['init', '-q'], cwd: dir, timeoutMs: 20_000 });
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  }
  await commitAll(dir, 'init', { exclude: [] });
  if (origin) await execCommand({ bin: 'git', args: ['update-ref', 'refs/remotes/origin/main', 'HEAD'], cwd: dir, timeoutMs: 20_000 });
  return dir;
}

const TLS = [
  'package smoke',
  '',
  '// aponta o nav que falta [AC-031]',
  'func TestAc_031_PaginaTemOsTresMarcos(t *testing.T) {',
  '\tcasos := []struct{ nome string }{',
  '\t\t{nome: "[AC-031] aponta o nav que falta"},',
  '\t\t{nome: "[AC-031] aponta o nav que falta com detalhe"},',
  '\t}',
  '\tfor _, c := range casos {',
  '\t\tt.Run(c.nome, func(t *testing.T) {})',
  '\t}',
  '}',
  '',
  'func TestAc_031_Literal(t *testing.T) {',
  '\tt.Run("[AC-031] titulo literal", func(t *testing.T) {})',
  '}',
  '',
  'func TestAc_033_Montado(t *testing.T) {',
  '\tt.Run("[AC-033] parte "+"fixa", func(t *testing.T) {})',
  '}',
  '',
].join('\n');
const OTHER = 'package other\n\nfunc TestAc_031_PaginaTemOsTresMarcos(t *testing.T) {}\n';
const REL = 'package relatorio\n\nfunc TestAc_040_Relatorio(t *testing.T) {\n\tt.Run("[AC-040] gera relatório", func(t *testing.T) {})\n}\n';
const VITEST = "describe('suite', () => {\n  it('[AC-003] checks it', () => {});\n});\n";
const PYTHON = 'def test_ac_003_health():\n    pass\n';
const JAVA = 'package com.acme;\n\nclass OrdersTest {\n    void shouldPlaceOrder() {}\n}\n';

describe('locateTests', () => {
  it('finds a subtest on its title line and a function on its line, in the commit of origin/main', async () => {
    const repo = await repoWith({
      'tests/smoke/tls_test.go': TLS,
      'tests/other/tls_test.go': OTHER,
      'tests/relatório/rel_test.go': REL,
      'web/src/a.test.ts': VITEST,
      'web/src/b.test.ts': VITEST,
      'tests/test_smoke.py': PYTHON,
      'src/test/java/com/acme/OrdersTest.java': JAVA,
    });
    const refs = [
      ref('acme/tests/smoke', 'TestAc_031_PaginaTemOsTresMarcos/[AC-031]_aponta_o_nav_que_falta'),
      ref('acme/tests/smoke', 'TestAc_031_PaginaTemOsTresMarcos/[AC-031]_aponta_o_nav_que_falta_com_detalhe'),
      ref('acme/tests/smoke', 'TestAc_031_Literal/[AC-031]_titulo_literal'),
      ref('acme/tests/smoke', 'TestAc_033_Montado/[AC-033]_parte_fixa'),
      ref('acme/tests/other', 'TestAc_031_PaginaTemOsTresMarcos'),
      ref('acme/tests/relatório', 'TestAc_040_Relatorio/[AC-040]_gera_relatório'),
      ref('src/b.test.ts', 'suite > [AC-003] checks it'),
      ref('tests.test_smoke', 'test_ac_003_health[1-a]'),
      ref('com.acme.OrdersTest', 'shouldPlaceOrder()'),
    ];
    const found = await locateTests(repo, refs);
    expect(found!.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.fromEntries(found!.places)).toEqual({
      [refs[0]!.id]: { path: 'tests/smoke/tls_test.go', line: lineOf(TLS, '{nome: "[AC-031] aponta o nav que falta"}') },
      [refs[1]!.id]: { path: 'tests/smoke/tls_test.go', line: lineOf(TLS, 'com detalhe"') },
      [refs[2]!.id]: { path: 'tests/smoke/tls_test.go', line: lineOf(TLS, 't.Run("[AC-031] titulo literal"') },
      [refs[3]!.id]: { path: 'tests/smoke/tls_test.go', line: lineOf(TLS, 'func TestAc_033_Montado(') },
      [refs[4]!.id]: { path: 'tests/other/tls_test.go', line: lineOf(OTHER, 'func TestAc_031_PaginaTemOsTresMarcos(') },
      [refs[5]!.id]: { path: 'tests/relatório/rel_test.go', line: lineOf(REL, 't.Run("[AC-040] gera relatório"') },
      [refs[6]!.id]: { path: 'web/src/b.test.ts', line: 2 },
      [refs[7]!.id]: { path: 'tests/test_smoke.py', line: 1 },
      [refs[8]!.id]: { path: 'src/test/java/com/acme/OrdersTest.java', line: lineOf(JAVA, 'void shouldPlaceOrder()') },
    });
  });

  it('does not search vendored code or documents', async () => {
    const repo = await repoWith({
      'vendor/lib/x_test.go': 'package lib\n\nfunc TestAc_050_SoNoVendor(t *testing.T) {}\n',
      'docs/guia.md': '- "[AC-060] so no doc"\n',
    });
    const found = await locateTests(repo, [ref('lib', 'TestAc_050_SoNoVendor'), ref('acme', 'suite > [AC-060] so no doc')]);
    expect(found!.places.size).toBe(0);
  });

  it('gives null when origin/main does not exist', async () => {
    const repo = await repoWith({ 'tests/smoke/tls_test.go': TLS }, false);
    expect(await locateTests(repo, [ref('acme/tests/smoke', 'TestAc_031_PaginaTemOsTresMarcos')])).toBeNull();
  });
});

/** An exec that answers each call with the next reply, recording the calls. */
function fakeExec(replies: Array<Partial<CommandResult>>, calls: CommandSpec[] = []): Exec {
  return async (spec) => {
    calls.push(spec);
    return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 0, truncated: false, ...(replies.shift() ?? {}) };
  };
}

describe('locateTests with a fake git', () => {
  it('greps the commit it resolved, not the ref, and sends the names on stdin only', async () => {
    const calls: CommandSpec[] = [];
    const exec = fakeExec([{ stdout: `${SHA}\n` }, { exitCode: 1 }], calls);
    const found = await locateTests('/repo', [ref('x', 'TestAc_001_A/[AC-001]_b')], exec);
    expect(found).toEqual({ sha: SHA, places: new Map() });
    expect(calls[1]!.args).toContain(SHA);
    expect(calls[1]!.args).not.toContain('refs/remotes/origin/main');
    expect(calls[1]!.args.join(' ')).not.toContain('TestAc_001');
    expect(calls[1]!.stdin).toContain('TestAc_001_A');
  });

  it('searches nothing when no name is usable', async () => {
    const calls: CommandSpec[] = [];
    await locateTests('/repo', [ref('x', 'free text')], fakeExec([{ stdout: `${SHA}\n` }], calls));
    expect(calls).toHaveLength(1);
  });

  it('raises when git grep fails, times out or is cut short, so no link is guessed', async () => {
    const tests = [ref('x', 'TestAc_001_A')];
    await expect(locateTests('/repo', tests, fakeExec([{ stdout: `${SHA}\n` }, { exitCode: 128, stderr: 'fatal' }]))).rejects.toThrow('git grep failed');
    await expect(locateTests('/repo', tests, fakeExec([{ stdout: `${SHA}\n` }, { exitCode: null, timedOut: true }]))).rejects.toThrow('git grep failed');
    await expect(locateTests('/repo', tests, fakeExec([{ stdout: `${SHA}\n` }, { exitCode: 0, truncated: true }]))).rejects.toThrow('git grep failed');
  });

  it('gives null when the commit cannot be resolved', async () => {
    expect(await locateTests('/repo', [ref('x', 'TestAc_001_A')], fakeExec([{ exitCode: 1 }]))).toBeNull();
  });
});
