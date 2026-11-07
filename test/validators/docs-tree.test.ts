import { describe, expect, it } from 'vitest';
import { APP_FOLDER, APP_KINDS, DOCS_TREE, type AppKind } from '../../server/docs/tree.js';
import { validateDocsTree } from '../../server/validators/docs-tree.js';

const TEXT = 'Texto de apoio com conteúdo real para o leitor do documento.';
const HEADINGS = ['Executar', 'Testes', 'Variáveis de ambiente', 'Arquitetura', 'Pipeline', 'Iniciar', 'Parar', 'Logs', 'Rollback'].map((h) => `## ${h}\n\n${TEXT}\n`).join('\n');
const NA = 'Não se aplica: este repositório não tem aplicativo mobile.';

/** A complete tree: real content for the kinds the repository holds, "Não se aplica" for the others. */
function tree(kinds: readonly AppKind[], overrides: Record<string, string | null> = {}): Map<string, string> {
  const files = new Map<string, string>();
  const real = (path: string) => `# ${path}\n\n${HEADINGS}\n${TEXT}\n`;
  for (const path of DOCS_TREE) {
    if (path.endsWith('/')) {
      files.set(`${path}README.md`, real(path));
      continue;
    }
    const kind = APP_KINDS.find((k) => path.startsWith(`docs/${APP_FOLDER[k]}/`));
    files.set(path, kind && !kinds.includes(kind) ? NA : real(path));
  }
  for (const [path, text] of Object.entries(overrides)) {
    if (text === null) files.delete(path);
    else files.set(path, text);
  }
  return files;
}

const base = { kinds: ['api'] as AppKind[], delivered: ['T1'], covered: ['T1'], features: [] as string[] };

describe('docs tree gate', () => {
  it('accepts a complete tree', () => {
    expect(validateDocsTree({ ...base, files: tree(['api']) })).toEqual([]);
  });

  it('names a file of the tree that is missing', () => {
    const errors = validateDocsTree({ ...base, files: tree(['api'], { 'docs/04-web/design-system.md': null }) });
    expect(errors).toContain('docs/04-web/design-system.md is missing');
  });

  it('refuses real content in a kind the repository does not hold', () => {
    const errors = validateDocsTree({ ...base, files: tree(['api'], { 'docs/05-mobile/dispositivos.md': `# x\n\n${HEADINGS}\n${TEXT}` }) });
    expect(errors.some((e) => e.startsWith('docs/05-mobile/dispositivos.md documents mobile'))).toBe(true);
  });

  it('refuses an empty file of a kind the repository holds', () => {
    const errors = validateDocsTree({ ...base, files: tree(['api'], { 'docs/03-api/arquitetura.md': '' }) });
    expect(errors.some((e) => e.startsWith('docs/03-api/arquitetura.md is empty'))).toBe(true);
  });

  it('accepts a reasoned "Não se aplica" in a kind the repository holds', () => {
    const files = tree(['api'], { 'docs/03-api/openapi.yaml': 'Não se aplica: a API não expõe contrato OpenAPI.' });
    expect(validateDocsTree({ ...base, files })).toEqual([]);
  });

  it('refuses a delivered task that no file documents', () => {
    expect(validateDocsTree({ ...base, covered: [], files: tree(['api']) })).toContain('task T1 has no documentation');
  });

  it('refuses a relative link to a file that does not exist', () => {
    const files = tree(['api'], { 'docs/README.md': `# x\n\n${HEADINGS}\n[produto](00-visao-geral/nao-existe.md)` });
    expect(validateDocsTree({ ...base, files }).some((e) => e.includes('links to 00-visao-geral/nao-existe.md'))).toBe(true);
  });

  it('refuses a standard section that its file loses', () => {
    const files = tree(['api'], { 'docs/01-onboarding/setup-ambiente.md': '# x\n\n## Testes\n\n' + TEXT });
    expect(validateDocsTree({ ...base, files })).toContain('docs/01-onboarding/setup-ambiente.md is missing a "run" section (add a heading naming it)');
  });

  it('refuses to drop an endpoint the current docs documented', () => {
    const current = new Map([['docs/03-api/endpoints/estoque.md', '### POST /stock\n']]);
    const errors = validateDocsTree({ ...base, current, files: tree(['api']) });
    expect(errors.some((e) => e.startsWith('docs/03-api dropped endpoint /stock,'))).toBe(true);
  });

  it('refuses a feature endpoint that no api document names', () => {
    expect(validateDocsTree({ ...base, features: ['GET /orders'], files: tree(['api']) })).toContain('docs/03-api does not document endpoint /orders');
  });
});
