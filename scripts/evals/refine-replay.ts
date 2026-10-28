/**
 * How often the owner agreed with the recommended option in one refinement journal, against the replay gates; then what the
 * resolver would have decided for each question (plan 101).
 *   npx tsx scripts/evals/refine-replay.ts <path to events.ndjson> [--since <ISO time>] [--bins] [--audit <n>]
 * Only deliberate answers label the agreement: an answer a few seconds after the owner's previous one is a bulk click or a script.
 */
import path from 'node:path';
import { bands, clusterInterval, leaveOneItemOut, ownerAnswers, REPLAY } from '../../server/refine/agreement.js';
import { MIN_READ_SECONDS } from '../../server/decide/evals.js';
import { renderResolverReport, replayResolver } from '../../server/refine/resolver-replay.js';
import { askCapLines } from '../../server/refine/ask-caps.js';
import { loadEvents } from '../../server/store/event-store.js';
import { currentEvent } from '../../server/refine/events.js';
import { existsSync } from 'node:fs';

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error('usage: refine-replay.ts <path to events.ndjson> [--since <ISO time>] [--bins] [--audit <n>]');
  process.exit(2);
}
const flagValue = (name: string): string | undefined => {
  const at = flags.indexOf(name);
  return at < 0 ? undefined : flags[at + 1];
};
const sinceText = flagValue('--since');
const since = sinceText === undefined ? undefined : Date.parse(sinceText);
if (since !== undefined && Number.isNaN(since)) {
  console.error('--since needs an ISO time, for example 2026-10-27T16:49:00Z');
  process.exit(2);
}
const auditText = flagValue('--audit');
const audit = auditText === undefined ? undefined : Number(auditText);
if (audit !== undefined && (!Number.isInteger(audit) || audit < 1)) {
  console.error('--audit needs a whole number of questions, for example 40');
  process.exit(2);
}

const pct = (share: number) => `${(100 * share).toFixed(1)}%`;
if (!existsSync(file)) {
  // loadEvents reads a missing file as an empty journal, which would print zeros as if they were the journal's.
  console.error(`no journal at ${file}`);
  process.exit(2);
}
const events = (await loadEvents(file)).map(currentEvent);
const answers = ownerAnswers(events);
console.log(`gates: read at least ${MIN_READ_SECONDS} s, long pause ${REPLAY.longPauseSeconds} s, z ${REPLAY.z}, bootstrap ${REPLAY.bootstrapRuns} runs, seed ${REPLAY.seed}`);
console.log(`owner answers with a recommended option: ${answers.length}`);
for (const b of bands(answers)) {
  console.log(`${b.label.padEnd(26)} n=${String(b.n).padStart(4)}  agreed=${String(b.agreed).padStart(4)}  share=${(b.share === null ? '-' : pct(b.share)).padStart(6)}  Wilson lower=${b.lower === null ? '-' : b.lower.toFixed(3)}`);
}
const interval = clusterInterval(answers);
console.log(interval ? `labels, cluster bootstrap by item: 95% interval ${pct(interval[0])} to ${pct(interval[1])}` : 'labels: none');
const loo = leaveOneItemOut(answers);
console.log(loo ? `leave one item out: lowest ${pct(loo.lowest.share)} without ${loo.lowest.item}, highest ${pct(loo.highest.share)} without ${loo.highest.item}` : 'leave one item out: fewer than two items');
console.log('');
for (const line of renderResolverReport(replayResolver(events), { since, bins: flags.includes('--bins'), audit })) console.log(line);

for (const line of askCapLines(events)) console.log(line);
console.log('');

