/** R8.6: documentation is a gate. Pure validators for docs/README.md, docs/RUNBOOK.md and docs/API.md. */

export const MIN_SECTION_CHARS = 40;

/** Required headings; each accepts English or Portuguese names (matched case-insensitively on the heading text). */
export const README_SECTIONS: Record<string, RegExp> = {
  run: /\b(run|running|execu[cç][aã]o|executar|rodar)\b/i,
  test: /\b(tests?|testing|testes?)\b/i,
  env: /\b(env|environment|vari[aá]veis?)\b/i,
  architecture: /\b(architecture|arquitetura)\b/i,
  pipeline: /\b(pipeline|ci\/cd|ci)\b/i,
};
export const RUNBOOK_SECTIONS: Record<string, RegExp> = {
  start: /\b(start|starting|iniciar|subir)\b/i,
  stop: /\b(stop|stopping|parar|derrubar)\b/i,
  logs: /\b(logs?)\b/i,
  rollback: /\b(rollback|revert|reverter)\b/i,
};

interface Section { title: string; body: string }

function sections(md: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  let fence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { cur = { title: h[1]!, body: '' }; out.push(cur); } else if (cur) cur.body += `${line}\n`;
  }
  return out;
}

function checkSections(md: string, file: string, required: Record<string, RegExp>): string[] {
  if (md.trim() === '') return [`${file} is empty`];
  const found = sections(md);
  const errors: string[] = [];
  for (const [name, re] of Object.entries(required)) {
    const matches = found.filter((s) => re.test(s.title));
    if (matches.length === 0) errors.push(`${file} is missing a "${name}" section (add a heading naming it)`);
    else if (!matches.some((s) => s.body.trim().length >= MIN_SECTION_CHARS)) errors.push(`${file} section "${name}" has no content (at least ${MIN_SECTION_CHARS} characters of text)`);
  }
  return errors;
}

export const validateReadme = (md: string): string[] => checkSections(md, 'docs/README.md', README_SECTIONS);
export const validateRunbook = (md: string): string[] => checkSections(md, 'docs/RUNBOOK.md', RUNBOOK_SECTIONS);

/** Endpoint paths named in spec features, e.g. "GET /health" or "exposes /api/items". */
export function featureEndpoints(features: readonly string[]): string[] {
  const out = new Set<string>();
  for (const f of features) for (const m of f.matchAll(/(?:^|[\s`(])(\/[\w\-./:{}]*[\w}])/g)) out.add(m[1]!);
  return [...out];
}

export function validateApiDocs(md: string | null, features: readonly string[]): string[] {
  const endpoints = featureEndpoints(features);
  if (endpoints.length === 0) return [];
  if (!md || md.trim() === '') return ['docs/API.md is empty; the spec features name endpoints'];
  return endpoints.filter((e) => !md.includes(e)).map((e) => `docs/API.md does not document endpoint ${e}`);
}

export interface DocsInput { readme: string; runbook: string | null | undefined; apiDocs: string | null | undefined }

export function validateDocs(d: DocsInput, features: readonly string[]): string[] {
  return [...validateReadme(d.readme), ...validateRunbook(d.runbook ?? ''), ...validateApiDocs(d.apiDocs ?? null, features)];
}
