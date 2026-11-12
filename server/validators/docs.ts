/** The documentation gate's pure helpers: section headings, the endpoints a document names, and the planned sections. */

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

/** A section's body holds its own text and the text of the deeper headings under it. */
function sections(md: string): Section[] {
  const out: Array<Section & { level: number }> = [];
  const open: Array<Section & { level: number }> = [];
  let fence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const h = fence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      const cur = { title: h[2]!, body: '', level: h[1]!.length };
      while (open.length > 0 && open.at(-1)!.level >= cur.level) open.pop();
      open.push(cur);
      out.push(cur);
    } else for (const s of open) s.body += `${line}\n`;
  }
  return out;
}

export function checkSections(md: string, file: string, required: Record<string, RegExp>): string[] {
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


/** Endpoint paths named in spec features, e.g. "GET /health" or "exposes /api/items". */
export function featureEndpoints(features: readonly string[]): string[] {
  const out = new Set<string>();
  for (const f of features) for (const m of f.matchAll(/(?:^|[\s`(])(\/[\w\-./:{}]*[\w}])/g)) out.add(m[1]!);
  return [...out];
}

const METHOD_PATH = /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b[\s*`|]*(\/[\w\-./:{}]*[\w}])/g;

/** Endpoint paths an API document names after an HTTP method, outside code blocks, where file paths and examples live. */
export function documentedEndpoints(md: string): string[] {
  const out = new Set<string>();
  let fence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (!fence) for (const m of line.matchAll(METHOD_PATH)) out.add(m[1]!);
  }
  return [...out];
}

/** The standard README section a planned name stands for, when it is one of the five. */
const standardSection = (name: string): RegExp | undefined => Object.values(README_SECTIONS).find((re) => re.test(name));

/**
 * The planned README sections no heading carries. A standard one is found by any of its usual names, the same rule the
 * README validator applies, so the README the report writes always passes the next verification; any other by its own word.
 */
export function missingReadmeSections(md: string, planned: readonly string[]): string[] {
  const titles = sections(md).map((s) => s.title);
  return planned.filter((name) => {
    const re = standardSection(name);
    return !titles.some((t) => (re ? re.test(t) : t.toLowerCase().includes(name.toLowerCase())));
  });
}
