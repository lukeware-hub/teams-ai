/**
 * R11.5.7: the confidence floor for answering a blocking refinement question from the documents, from labelled journals.
 *   npx tsx scripts/evals/question-routing.ts --refine ~/.teams-ai/workspaces/<project>/refine [--refine <other project>/refine ...]
 * An answer the owner marked "the documents already answered this" labels its question. Each project's refinement sessions
 * prove their own floor the same way (decisions.autoAnswerFloor: measured, the default); this script prints it per project.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { measuredFloor, precisionNearFloor, routingSamples, type RoutingSample } from '../../server/decide/evals.js';

const dirs = process.argv.flatMap((a, i) => (process.argv[i - 1] === '--refine' ? [a] : []));
if (dirs.length === 0) {
  console.error('usage: question-routing.ts --refine <refine dir> [--refine <refine dir> ...]');
  process.exit(2);
}
const projects = [];
for (const dir of dirs) {
  const samples: RoutingSample[] = [];
  for (const specId of await fs.readdir(dir)) {
    const text = await fs.readFile(path.join(dir, specId, 'events.ndjson'), 'utf8').catch(() => '');
    samples.push(...routingSamples(text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))));
  }
  const auto = samples.filter((s) => s.route === 'auto');
  const floor = measuredFloor(samples);
  projects.push({ dir, samples: samples.length, routedAuto: auto.length, answeredByDocs: auto.filter((s) => s.docsAnswered).length, floor, precisionNearFloor: floor === null ? null : precisionNearFloor(samples, floor) });
}
console.log(JSON.stringify(projects, null, 2));
