import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execCommand } from '../../server/exec/command.js';
import { buildContextPack } from '../../server/knowledge/context-pack.js';
import { Graphify, MIN_COVERAGE, grepFallback } from '../../server/knowledge/graphify.js';
import { KnowledgeIndex } from '../../server/knowledge/retrieval.js';

const repo = path.resolve(process.argv[2] ?? '.');
const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-graph-'));
const g = new Graphify({ exec: execCommand, readFile: async (p) => fs.readFile(p, 'utf8').catch(() => null) });

console.log('== graphify update');
const cov = await g.update(repo, outDir);
console.log('  coverage', JSON.stringify(cov));
console.log('  god nodes', JSON.stringify(await g.godNodes(outDir, 5)));
const q = await g.query(outDir, 'how is a step result summarized', 600);
console.log(`  query: ${q.nodes.length} nodes, truncated=${q.truncated}`);
const aff = await g.affected(outDir, 'summarizeStream', 1);
console.log(`  affected: ${aff.length}`, aff.slice(0, 3));
const code = cov.ratio >= MIN_COVERAGE ? { source: 'graph' as const, nodes: q.nodes.slice(0, 8), affected: aff, truncated: q.truncated } : { source: 'grep' as const, grep: await grepFallback(repo, ['summarizeStream'], execCommand) };

console.log('== retrieval over docs/');
const idx = KnowledgeIndex.open(':memory:');
const docsDir = path.join(repo, 'docs');
const walk = async (dir: string): Promise<string[]> => (await fs.readdir(dir, { withFileTypes: true })).flatMap((e) => (e.isDirectory() ? [] : [path.join(dir, e.name)]));
let files: string[] = [];
for (const d of ['superpowers/specs', 'superpowers/spikes']) files = files.concat(await walk(path.join(docsDir, d)).catch(() => []));
for (const f of files.filter((f) => f.endsWith('.md'))) idx.index({ id: path.relative(repo, f), kind: f.includes('/specs/') ? 'spec' : 'other', title: path.basename(f), text: await fs.readFile(f, 'utf8') });
console.log(`  indexed ${idx.count()} chunks from ${files.length} files`);
for (const query of ['quota breaker rate limit reset', 'sandbox bubblewrap socat', 'merge queue head commit']) {
  const hits = idx.search(query, { k: 2 });
  console.log(`  "${query}" →`, hits.map((h) => `${h.title}${h.heading ? ' › ' + h.heading : ''} (${h.score.toFixed(2)})`));
}

const pack = buildContextPack({
  kind: 'dev',
  role: 'dev',
  specHash: `sha256:${'a'.repeat(64)}`,
  principles: ['Every acceptance test carries its [AC-xxx] tag'],
  outputContract: 'Return the dev output JSON.',
  criteria: [],
  code,
  retrieval: idx.search('quota breaker', { k: 2 }),
  budgetTokens: 3000,
});
console.log(`== pack: ${pack.tokens} tokens, sections ${pack.sections.join(',')}, dropped ${pack.dropped.join(',') || 'none'}`);
idx.close();
await fs.rm(outDir, { recursive: true, force: true });
