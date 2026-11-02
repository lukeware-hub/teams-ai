import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../../server/', import.meta.url));
const LAYOUT = path.join(SERVER, 'docs', 'layout.ts');

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(file)));
    else if (entry.name.endsWith('.ts')) out.push(file);
  }
  return out;
}

describe('layout seam', () => {
  it('builds no documentation repository path outside server/docs/layout.ts', async () => {
    const offenders: string[] = [];
    for (const file of await tsFiles(SERVER)) {
      if (file === LAYOUT) continue;
      const lines = (await fs.readFile(file, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (line.includes('docs/specify')) offenders.push(`${path.relative(SERVER, file)}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
