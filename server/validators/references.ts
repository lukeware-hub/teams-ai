import { normalizePath } from '../core/paths.js';

export interface RefContext {
  acIds: ReadonlySet<string>;
  taskIds: ReadonlySet<string>;
  /** Normalized repository-relative paths (see normalizePath). */
  files: ReadonlySet<string>;
  tests: ReadonlySet<string>;
  adrIds: ReadonlySet<string>;
}

export interface References {
  acIds?: readonly string[];
  taskIds?: readonly string[];
  files?: readonly string[];
  tests?: readonly string[];
  adrIds?: readonly string[];
}

export function unresolvedReferences(refs: References, ctx: RefContext): string[] {
  const errors: string[] = [];
  const check = (
    label: string,
    values: readonly string[] | undefined,
    known: ReadonlySet<string>,
    normalize: (v: string) => string = (v) => v,
  ) => {
    for (const value of values ?? []) {
      if (!known.has(normalize(value))) errors.push(`unknown ${label}: ${value}`);
    }
  };
  check('acceptance criterion', refs.acIds, ctx.acIds);
  check('task', refs.taskIds, ctx.taskIds);
  check('file', refs.files, ctx.files, normalizePath);
  check('test', refs.tests, ctx.tests);
  check('ADR', refs.adrIds, ctx.adrIds);
  return errors;
}
