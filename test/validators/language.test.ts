import { describe, expect, it } from 'vitest';
import { isPortugueseLine, languageCheck, languageHits } from '../../server/validators/language.js';

/** One new-side hunk of a `git diff -U0` for one file, adding `lines` from line `start`. */
const added = (file: string, lines: string[], start = 1): string =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -0,0 +${start},${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n');

describe('isPortugueseLine', () => {
  it.each([
    'const ação = 1;',
    '// trata o erro de conexao',
    'function criarUsuario() {}',
    'const nome = "São Paulo";',
  ])('flags %j', (line) => {
    expect(isPortugueseLine(line)).toBe(true);
  });

  it.each([
    '// returns the list of active customers',
    'const data = await fetch(url)',
    'const url = "https://example.com/usuario/abc1234";',
    `const long = 'usuario ${'a'.repeat(400)}';`,
    `const blob = 'usuario ${'QUJD'.repeat(12)}';`,
  ])('does not flag %j, a URL, a hash or an encoded blob', (line) => {
    expect(isPortugueseLine(line)).toBe(false);
  });
});

describe('languageHits', () => {
  it('reports an added Portuguese line with its file and its line number in the new file', () => {
    expect(languageHits(added('server/a.ts', ['const x = 1;', '// calcula o preço'], 4))).toEqual([{ file: 'server/a.ts', line: 5, text: '// calcula o preço' }]);
  });

  it('reports nothing for English code', () => {
    expect(languageHits(added('server/a.ts', ['const x = 1;', '// returns the list of customers']))).toEqual([]);
  });

  it('ignores removed and context lines', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,1 @@', '-// comentário antigo', '-const usuario = 1;', '+const user = 1;'].join('\n');
    expect(languageHits(diff)).toEqual([]);
  });

  it('reads a removed line that starts with -- as a removed line, so the added line after it is still checked', () => {
    const diff = ['--- a/a.ts', '+++ b/a.ts', '@@ -1,1 +1,2 @@', '--- velho', '+// criar o total', '+const x = 1;'].join('\n');
    expect(languageHits(diff)).toEqual([{ file: 'a.ts', line: 1, text: '// criar o total' }]);
  });

  it('reads an added line that starts with ++ as an added line, not as a file header', () => {
    const diff = ['--- a/a.ts', '+++ b/a.ts', '@@ -0,0 +1 @@', '+++ nao faca isso'].join('\n');
    expect(languageHits(diff)).toEqual([{ file: 'a.ts', line: 1, text: '++ nao faca isso' }]);
  });

  it('skips the owner documents, locale files, snapshots and lock files', () => {
    for (const file of ['docs/project.md', 'docs/specs/shop/briefing.md', 'locales/pt.json', 'src/i18n/pt.ts', 'package-lock.json', 'web/__snapshots__/a.snap']) {
      expect(languageHits(added(file, ['// criar o total']))).toEqual([]);
    }
  });

  it('leaves out the Markdown documents, which are Brazilian Portuguese, and still checks the code', () => {
    expect(languageHits(added('docs/specs/shop/tech-spec.md', ['Execução do sistema.']))).toEqual([]);
    expect(languageHits(added('docs/adr/0001-cache.md', ['Decisão: usar cache.']))).toEqual([]);
    expect(languageHits(added('README.md', ['Execução do sistema.']))).toEqual([]);
    expect(languageHits(added('server/cache.ts', ['// Decisão: usar cache.']))).toHaveLength(1);
  });

  it('names a new file whose name is Portuguese, and does not name a changed file', () => {
    const created = ['diff --git a/server/usuario.ts b/server/usuario.ts', 'new file mode 100644', '--- /dev/null', '+++ b/server/usuario.ts', '@@ -0,0 +1 @@', '+export const x = 1;'].join('\n');
    expect(languageHits(created)).toEqual([{ file: 'server/usuario.ts', line: null, text: 'file name' }]);
    const changed = ['--- a/server/usuario.ts', '+++ b/server/usuario.ts', '@@ -1 +1 @@', '-x', '+export const x = 1;'].join('\n');
    expect(languageHits(changed)).toEqual([]);
  });

  it('reads a diff that ends early, as the trimmed git output does', () => {
    const diff = ['--- a/a.ts', '+++ b/a.ts', '@@ -0,0 +1,3 @@', '+// criar o total', '+const x = 1;'].join('\n');
    expect(languageHits(diff)).toEqual([{ file: 'a.ts', line: 1, text: '// criar o total' }]);
  });

  it('removes the carriage return of a CRLF line and skips the no-newline marker', () => {
    const diff = ['--- a/a.ts', '+++ b/a.ts', '@@ -0,0 +1,2 @@', '+// criar o total\r', '+const x = 1;', '\\ No newline at end of file'].join('\n');
    expect(languageHits(diff)).toEqual([{ file: 'a.ts', line: 1, text: '// criar o total' }]);
  });

  it('reads no text from a binary file or a deleted file', () => {
    const binary = ['diff --git a/x.png b/x.png', 'Binary files a/x.png and b/x.png differ'].join('\n');
    const deleted = ['--- a/a.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-// criar o total'].join('\n');
    expect(languageHits(binary)).toEqual([]);
    expect(languageHits(deleted)).toEqual([]);
  });
});

describe('languageCheck', () => {
  it('renders nothing when no line is flagged', () => {
    expect(languageCheck(added('a.ts', ['const x = 1;']))).toBe('');
  });

  it('renders a header and one line per hit', () => {
    const text = languageCheck(added('server/a.ts', ['// calcula o preço'], 4));
    expect(text.split('\n')).toEqual([expect.stringContaining('Language check (hints, not proof)'), '- server/a.ts:4 // calcula o preço']);
  });

  it('checks the commit messages of the task too, since rule 1 covers them', () => {
    expect(languageCheck('', 'feat(usuario): criar cadastro\n\nAdds the sign-up form.').split('\n').at(-1)).toBe('- commit message: feat(usuario): criar cadastro');
    expect(languageCheck('', 'feat(orders): add checkout\n\nAdds the checkout flow.')).toBe('');
  });

  it('cuts a long line to 120 characters', () => {
    const long = `// criar ${'ab '.repeat(60)}`;
    expect(languageCheck(added('a.ts', [long])).split('\n')[1]).toBe(`- a.ts:1 ${long.slice(0, 120)}`);
  });

  it('shows three lines of a file and counts the rest, and twelve files at most', () => {
    const many = Array.from({ length: 13 }, (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n--- a/f${i}.ts\n+++ b/f${i}.ts\n@@ -0,0 +1 @@\n+// criar ${i}`).join('\n');
    const lines = languageCheck(many).split('\n');
    expect(lines).toHaveLength(1 + 12 + 1);
    expect(lines.at(-1)).toBe('- 1 more files');
    const one = languageCheck(added('a.ts', ['// criar 1', '// criar 2', '// criar 3', '// criar 4', '// criar 5']));
    expect(one.split('\n').at(-1)).toBe('- a.ts: 2 more');
  });
});
