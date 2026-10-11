import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve('.');
const NODE = new Set(builtinModules);
// Runtime imports only: `import type` and `export type` never reach the bundle.
const IMPORT = /^\s*(?:import|export)\s+(?!type\s)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

/** The file a relative or `@server/` import names, or null for a package. */
function resolve(from: string, spec: string): string | null {
  const target = spec.startsWith('@server/') ? path.join(ROOT, 'server', spec.slice('@server/'.length)) : spec.startsWith('.') ? path.join(path.dirname(from), spec) : null;
  if (target === null) return null;
  const base = target.replace(/\.js$/, '');
  return [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((f) => existsSync(f)) ?? null;
}

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) return sources(file);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$|test-setup\.ts$/.test(e.name) ? [file] : [];
  });

describe('the web bundle', () => {
  // The dev server turns a Node module into a stub that throws on first use, and the page stays blank.
  it('reaches no Node module through the server code it imports', () => {
    const found: string[] = [];
    const seen = new Set<string>();
    const queue = sources(path.join(ROOT, 'web', 'src')).map((f) => [f]);
    while (queue.length > 0) {
      const chain = queue.shift()!;
      const file = chain.at(-1)!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const [, spec] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
        if (spec!.startsWith('node:') || NODE.has(spec!.split('/')[0]!)) found.push([...chain.map((f) => path.relative(ROOT, f)), spec].join(' -> '));
        const next = resolve(file, spec!);
        if (next) queue.push([...chain, next]);
      }
    }
    expect(found).toEqual([]);
  });
});
