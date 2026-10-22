/**
 * Calibration of the Jev document score (plan 91, phase C): scores each set of documents with the real scorer.
 *   OPENROUTER_API_KEY=... npx tsx scripts/evals/doc-readiness.ts <name>=<docs dir> ... [--out <file.json>]
 * A docs dir holds project.md, briefing.md (or briefing.md), stack.md, flow.md and design.md.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../server/config/config.js';
import type { DocFile } from '../../server/refine/draft.js';
import { createJevScorer } from '../../server/refine/jev-scoring.js';
import { SCORE_CHECKS, type DocsScoreRecord } from '../../server/refine/readiness.js';

const FILES: Array<{ file: DocFile; names: string[] }> = [
  { file: 'project.md', names: ['project.md'] },
  { file: 'briefing.md', names: ['briefing.md', 'brief.md'] },
  { file: 'stack.md', names: ['stack.md'] },
  { file: 'flow.md', names: ['flow.md'] },
  { file: 'design.md', names: ['design.md'] },
];

async function firstFile(dir: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => null);
    if (text !== null) return text;
  }
  return null;
}

/** The five documents of a folder, by the names the projects and the seeds use. */
async function readDocs(dir: string): Promise<Record<DocFile, string>> {
  const docs = {} as Record<DocFile, string>;
  for (const { file, names } of FILES) {
    const text = await firstFile(dir, names);
    if (text === null) throw new Error(`${dir}: missing ${names.join(' or ')}`);
    docs[file] = text;
  }
  return docs;
}

const percent = (value: number | null): string => (value === null ? '-' : `${Math.round(value * 100)}%`);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const outFile = outAt >= 0 ? args[outAt + 1] : undefined;
  const sets = args.filter((arg, i) => arg.includes('=') && args[i - 1] !== '--out');
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');
  const score = createJevScorer(loadConfig({}), async () => ({ OPENROUTER_API_KEY: key }));
  const results: Record<string, DocsScoreRecord> = {};
  for (const set of sets) {
    const at = set.indexOf('=');
    const name = set.slice(0, at);
    const record = await score(await readDocs(set.slice(at + 1)));
    results[name] = record;
    console.log(`${name}: average ${percent(record.average)}, available ${record.available}, tokens in ${record.usage?.inputTokens ?? '-'} out ${record.usage?.outputTokens ?? '-'}, cost US$ ${record.usage?.costUsd ?? '-'}`);
    for (const file of Object.keys(record.docs ?? {}) as DocFile[]) {
      const doc = record.docs![file]!;
      console.log(`  ${file.padEnd(10)} ${percent(doc.score).padStart(4)}  ${SCORE_CHECKS.map((id) => `${id} ${percent(doc.checks[id])}`).join('  ')}`);
    }
  }
  if (outFile) await fs.writeFile(outFile, JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
