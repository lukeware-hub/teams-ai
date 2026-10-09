/**
 * Compares runs by what they cost, from their journals (R11.13): per run the totals, then cost by model, by role/kind and by
 * task, so a routing or step-model experiment reads as cost per delivered task and per kind of step.
 *
 *   npx tsx scripts/evals/compare-runs.ts <run dir> [<run dir> ...]
 *
 * A run dir is `~/.teams-ai/runs/<run id>` (it holds `events.ndjson`). Steps booked before STEP_STARTED carried a model
 * show `?`; the MODEL_TIER_CHOSEN events (routing shadow or on) are listed too.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface Event {
  type: string;
  at: string;
  data: Record<string, any>;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const add = (m: Map<string, { n: number; cost: number; turns: number; out: number }>, key: string, step: { cost: number; turns: number; out: number }) => {
  const a = m.get(key) ?? { n: 0, cost: 0, turns: 0, out: 0 };
  a.n += 1;
  a.cost += step.cost;
  a.turns += step.turns;
  a.out += step.out;
  m.set(key, a);
};
const table = (title: string, m: Map<string, { n: number; cost: number; turns: number; out: number }>) => {
  console.log(`  ${title}`);
  for (const [k, a] of [...m].sort((x, y) => y[1].cost - x[1].cost)) console.log(`    ${k.padEnd(28)} ${String(a.n).padStart(3)} steps  ${money(a.cost).padStart(7)}  ${String(a.turns).padStart(4)} turns  ${String(a.out).padStart(7)} out`);
};

async function summarize(dir: string): Promise<void> {
  const events: Event[] = (await fs.readFile(path.join(dir, 'events.ndjson'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const started = new Map<string, Event>();
  for (const e of events) if (e.type === 'STEP_STARTED') started.set(e.data.stepId, e);
  const byModel = new Map();
  const byKind = new Map();
  const byTask = new Map();
  let cost = 0;
  let retryCost = 0;
  let steps = 0;
  for (const e of events.filter((x) => x.type === 'STEP_FINISHED')) {
    const s = started.get(e.data.stepId)?.data ?? {};
    const step = { cost: Number(e.data.costUsd ?? 0), turns: Number(e.data.numTurns ?? 0), out: Number(e.data.usage?.outputTokens ?? 0) };
    cost += step.cost;
    steps += 1;
    if (Number(e.data.attempt) > 1) retryCost += step.cost;
    add(byModel, String(s.model ?? '?'), step);
    add(byKind, `${s.role ?? '?'}/${e.data.kind}`, step);
    if (e.data.taskId) add(byTask, String(e.data.taskId), step);
  }
  const merged = events.filter((e) => e.type === 'PR_MERGED').length;
  const finished = events.find((e) => e.type === 'RUN_FINISHED');
  const wall = events.length > 1 ? (Date.parse(events[events.length - 1]!.at) - Date.parse(events[0]!.at)) / 60000 : 0;
  console.log(`\n${path.basename(dir)}: ${money(cost)} in ${steps} steps, ${wall.toFixed(1)} min, ${merged} tasks merged${merged ? ` (${money(cost / merged)} per task)` : ''}, attempts after the first ${money(retryCost)}, result ${finished ? String(finished.data.result) : 'not finished'}`);
  table('by model', byModel);
  table('by role/kind', byKind);
  table('by task', byTask);
  for (const e of events.filter((x) => x.type === 'MODEL_TIER_CHOSEN')) console.log(`  tier ${String(e.data.taskId).padEnd(26)} a${e.data.attempt} ${e.data.tier} -> ${e.data.model} ${e.data.applied ? 'applied' : 'shadow'}`);
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: tsx scripts/evals/compare-runs.ts <run dir> [<run dir> ...]');
  process.exit(2);
}
void (async () => {
  for (const d of dirs) await summarize(d);
})();
