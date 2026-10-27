/**
 * How often the owner agreed with the recommended option in one refinement journal, against the replay gates.
 *   npx tsx scripts/evals/refine-replay.ts <path to events.ndjson>
 * Only deliberate answers label the agreement: an answer a few seconds after the owner's previous one is a bulk click or a script.
 */
import { bands, clusterInterval, leaveOneItemOut, ownerAnswers, REPLAY } from '../../server/refine/agreement.js';
import { MIN_READ_SECONDS } from '../../server/decide/evals.js';
import { loadEvents } from '../../server/store/event-store.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: refine-replay.ts <path to events.ndjson>');
  process.exit(2);
}

const pct = (share: number) => `${(100 * share).toFixed(1)}%`;
const answers = ownerAnswers(await loadEvents(file));
console.log(`gates: read at least ${MIN_READ_SECONDS} s, long pause ${REPLAY.longPauseSeconds} s, z ${REPLAY.z}, bootstrap ${REPLAY.bootstrapRuns} runs, seed ${REPLAY.seed}`);
console.log(`owner answers with a recommended option: ${answers.length}`);
for (const b of bands(answers)) {
  console.log(`${b.label.padEnd(26)} n=${String(b.n).padStart(4)}  agreed=${String(b.agreed).padStart(4)}  share=${(b.share === null ? '-' : pct(b.share)).padStart(6)}  Wilson lower=${b.lower === null ? '-' : b.lower.toFixed(3)}`);
}
const interval = clusterInterval(answers);
console.log(interval ? `labels, cluster bootstrap by item: 95% interval ${pct(interval[0])} to ${pct(interval[1])}` : 'labels: none');
const loo = leaveOneItemOut(answers);
console.log(loo ? `leave one item out: lowest ${pct(loo.lowest.share)} without ${loo.lowest.item}, highest ${pct(loo.highest.share)} without ${loo.highest.item}` : 'leave one item out: fewer than two items');
