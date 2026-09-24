import path from 'node:path';

/** Only true glob metacharacters; parentheses and `+@!` are valid in ordinary file names. */
const GLOB_CHARS = /[*?[\]{}]/;

export function normalizePath(p: string): string {
  let out = path.posix.normalize(p.replace(/\\/g, '/'));
  while (out.startsWith('/')) out = out.slice(1);
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  if (out === '.' || out === '') return '';
  return out;
}

export function hasGlobChars(p: string): boolean {
  return GLOB_CHARS.test(p);
}

export function staticPrefix(glob: string): string {
  const normalized = normalizePath(glob);
  if (normalized === '') return '';
  const fixed: string[] = [];
  for (const segment of normalized.split('/')) {
    if (hasGlobChars(segment)) break;
    fixed.push(segment);
  }
  return fixed.join('/');
}

function isAncestorOrEqual(ancestor: string, candidate: string): boolean {
  if (ancestor === '') return true;
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

export function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const x of a) {
    const px = staticPrefix(x);
    for (const y of b) {
      const py = staticPrefix(y);
      if (isAncestorOrEqual(px, py) || isAncestorOrEqual(py, px)) return true;
    }
  }
  return false;
}
