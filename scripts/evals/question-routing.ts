/**
 * R11.5.7: the confidence floor for answering a blocking refinement question from the documents, from labelled journals.
 *   npx tsx scripts/evals/question-routing.ts --refine ~/.teams-ai/workspaces/<project>/refine [--refine <other project>/refine ...]
 * An answer the owner marked "the documents already answered this" labels its question; set decisions.autoAnswerFloor to
 * the floor printed, and only once it is not null and the precision near it holds too.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { autoAnswerFloor, precisionNearFloor, routingSamples, type RoutingSample } from '../../server/decide/evals.js';

const dirs = process.argv.flatMap((a, i) => (process.argv[i - 1] === '--refine' ? [a] : []));
if (dirs.length === 0) {
  console.error('usage: question-routing.ts --refine <refine dir> [--refine <refine dir> ...]');
  process.exit(2);
}
const samples: RoutingSample[] = [];
for (const dir of dirs) {
  for (const specId of await fs.readdir(dir)) {
    const text = await fs.readFile(path.join(dir, specId, 'events.ndjson'), 'utf8').catch(() => '');
    samples.push(...routingSamples(text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))));
  }
}
const auto = samples.filter((s) => s.route === 'auto');
const floor = autoAnswerFloor(samples);
console.log(JSON.stringify({ samples: samples.length, routedAuto: auto.length, answeredByDocs: auto.filter((s) => s.docsAnswered).length, floor, precisionNearFloor: floor === null ? null : precisionNearFloor(samples, floor) }, null, 2));
