/**
 * Decision evals (spec 10A.6): joins DECISION_MADE records from run journals with hand labels and prints
 * per-decision metrics.
 *   npx tsx scripts/evals/decisions.ts --runs ~/.teams-ai/runs --labels labels.json
 * labels.json: [{ "runId": "todo-001-r3", "seq": 42, "question": "kind", "label": "code" }, ...]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { metrics, samplesFromRecords, type JournaledDecision, type Label } from '../../server/decide/evals.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const runsDir = arg('runs');
const labelsFile = arg('labels');
if (!runsDir || !labelsFile) {
  console.error('usage: decisions.ts --runs <runs dir> --labels <labels.json>');
  process.exit(2);
}

const records: JournaledDecision[] = [];
for (const runId of await fs.readdir(runsDir)) {
  const text = await fs.readFile(path.join(runsDir, runId, 'events.ndjson'), 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    if (!line.includes('"DECISION_MADE"')) continue;
    const e = JSON.parse(line) as { seq: number; data: { record: JournaledDecision['record'] } };
    records.push({ runId, seq: e.seq, record: e.data.record });
  }
}
const labels = JSON.parse(await fs.readFile(labelsFile, 'utf8')) as Label[];
const samples = samplesFromRecords(records, labels);
const ids = [...new Set(samples.map((s) => s.decisionId))];
const report = Object.fromEntries(ids.map((id) => [id, metrics(samples.filter((s) => s.decisionId === id))]));
console.log(JSON.stringify({ records: records.length, labeled: samples.length, decisions: report }, null, 2));
