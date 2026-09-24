import picomatch from 'picomatch';
import { hasGlobChars, normalizePath } from '../core/paths.js';

export interface ScopeInput {
  changedFiles: readonly string[];
  affectedPaths: readonly string[];
  frozenPaths: readonly string[];
  scopeJustification?: string;
  /** Only for T0-scaffold on the first spec, which creates the frozen files. */
  allowFrozen?: boolean;
}

export interface ScopeResult {
  ok: boolean;
  errors: string[];
  frozenTouched: string[];
  outOfScope: string[];
}

/** Escapes characters picomatch would otherwise read as extglob or negation syntax. */
function escapeLiteral(p: string): string {
  return p.replace(/[()+@!]/g, (c) => `\\${c}`);
}

function matcher(globs: readonly string[]): (file: string) => boolean {
  const patterns = globs.flatMap((raw) => {
    const glob = normalizePath(raw);
    if (glob === '') return ['**'];
    if (hasGlobChars(glob)) return [glob];
    // A bare path covers the file itself and everything below it.
    const literal = escapeLiteral(glob);
    return [literal, `${literal}/**`];
  });
  if (patterns.length === 0) return () => false;
  return picomatch(patterns, { dot: true });
}

export function checkScope(input: ScopeInput): ScopeResult {
  const isFrozen = input.allowFrozen ? () => false : matcher(input.frozenPaths);
  const inScope = matcher(input.affectedPaths);
  const files = [...new Set(input.changedFiles.map(normalizePath))].filter((f) => f !== '');

  const frozenTouched = files.filter((f) => isFrozen(f));
  const outOfScope = files.filter((f) => !isFrozen(f) && !inScope(f));

  const errors: string[] = [];
  if (frozenTouched.length > 0) errors.push(`frozen files modified: ${frozenTouched.join(', ')}`);
  if (outOfScope.length > 0 && !input.scopeJustification?.trim()) {
    errors.push(`files outside affectedPaths without scopeJustification: ${outOfScope.join(', ')}`);
  }
  return { ok: errors.length === 0, errors, frozenTouched, outOfScope };
}
