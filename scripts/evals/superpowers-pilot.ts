/**
 * The Superpowers plan pilot (plan 107, increment 2). Runs one plan step per sampled backlog item with the real CLI, in a scratch
 * draft under its own workspace folder, and prints one line per plan and the gate verdict. It never writes to a live draft.
 *
 * Usage: tsx scripts/evals/superpowers-pilot.ts --root <draft folder> --variant pinned|sonnet [--limit 20] [--concurrency 4]
 * The draft folder holds `journal.ndjson` (a copy of the live journal), `speckit-input/` (the six inputs) and `docs/`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SpeckitOutput } from '../../server/agents/outputs.js';
import type { AgentSetting } from '../../server/config/config.js';
import { sha256 } from '../../server/contracts/hash.js';
import { expandHome } from '../../server/orchestrator/workspace.js';
import { readUserConfig } from '../../server/onboarding/config-store.js';
import { makeRunAgent } from '../../server/refine/agent.js';
import { planFileOf, specSectionOf } from '../../server/refine/plan-file.js';
import { runPlanStep, type PlanStepResult } from '../../server/refine/plan-step.js';
import { planItems, type PlanItem } from '../../server/refine/plan-items.js';
import { planPack } from '../../server/refine/superpowers-pack.js';
import { reduceRefineEvents } from '../../server/refine/state.js';
import { absoluteRule } from '../../server/runner/role-settings.js';
import type { StepOutcome } from '../../server/runner/step.js';

const DRAFT_ID = 'kayron-hub-001';
const PROJECT = 'kayron-hub';
const GATE = { validShare: 0.95, maxRatio: 3, maxPlanChars: 60_000, maxMedianSeconds: 600 };

const flags = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) flags.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1]!);
const root = flags.get('root') ?? '';
const variant = flags.get('variant') ?? 'pinned';
/** A label for one execution: its staging folder and its results file are new, so nothing an earlier run left is read. */
const run = flags.get('run') ?? 'a';
const limit = Number(flags.get('limit') ?? 20);
const concurrency = Number(flags.get('concurrency') ?? 4);
if (!root || !['pinned', 'sonnet', 'haiku-max'].includes(variant)) throw new Error('usage: --root <draft folder> --variant pinned|sonnet|haiku-max');

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length === 0 ? 0 : sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};


/** A sample of the backlog: the five items with the most criteria, then the rest spread across the rank order. */
function sampleOf<T extends { criteria: readonly string[] }>(all: readonly T[], size: number): T[] {
  const take = Math.min(size, all.length);
  const most = [...all].sort((a, b) => b.criteria.length - a.criteria.length || all.indexOf(a) - all.indexOf(b)).slice(0, Math.min(5, take));
  const rest = all.filter((x) => !most.includes(x));
  const spread = Array.from({ length: take - most.length }, (_, k) => rest[Math.floor((k * rest.length) / (take - most.length))]!);
  return [...most, ...spread].sort((a, b) => all.indexOf(a) - all.indexOf(b));
}

const { cfg } = await readUserConfig();
const pinned = cfg.agentSettings[PROJECT]?.dev;
if (!pinned) throw new Error(`no dev pin for ${PROJECT} in the config`);
const setting: AgentSetting = variant === 'sonnet' ? { model: 'claude-sonnet-5-5', effort: pinned.effort } : variant === 'haiku-max' ? { model: 'claude-haiku-5-5', effort: 'max' } : pinned;

const journal = (await fs.readFile(path.join(root, 'journal.ndjson'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
const state = reduceRefineEvents(journal);
const items = planItems(DRAFT_ID, state);
const withCriteria = items.map((item) => ({ item, criteria: (state.backlog?.specs?.[item.key]?.spec?.acceptanceCriteria ?? []).map((c: { id: string }) => c.id) }));
const sample = sampleOf(withCriteria, limit);

const inputDir = path.join(root, 'speckit-input');
const staging = path.join(root, flags.get('stage') ?? `speckit-${variant}-${run}`);
const resultsFile = path.join(root, `results-${variant}-${run}.jsonl`);
const specsMd = await fs.readFile(path.join(inputDir, 'specs.md'), 'utf8');
await fs.mkdir(staging, { recursive: true });

const runAgent = await makeRunAgent({
  cfg,
  agentsDir: '/app/.claude/agents',
  hostEnv: process.env,
  secretsDir: expandHome(cfg.paths.secrets),
  workspacesRoot: expandHome(cfg.paths.workspaces),
  agentSettings: async () => ({ dev: setting }),
  speckitAgents: async () => concurrency,
});

let seq = 0;
const journalStub = { allocStepSeq: () => ++seq, fact: async () => undefined } as never;

interface Row {
  key: string;
  specId: string;
  status: PlanStepResult['status'];
  repairs: number;
  questions: number;
  runs: number;
  seconds: number;
  costUsd: number;
  planChars: number;
  specChars: number;
  ratio: number;
  issues: string[];
}

async function runItem({ item, criteria }: (typeof withCriteria)[number]): Promise<Row> {
  const specHash = sha256(`plan\n${item.specId}\n${variant}\n${inputDir}`);
  const file = path.join(staging, planFileOf(item.specId));
  let seconds = 0;
  let costUsd = 0;
  let runs = 0;
  const result = await runPlanStep({
    staging,
    specId: item.specId,
    criteria,
    pack: (repair) => planPack({ specHash, inputDir, specId: item.specId, key: item.key, title: item.title, criteria, repair }),
    run: async (pack) => {
      const t0 = Date.now();
      const outcome = await runAgent<'speckit'>({ kind: 'speckit', role: 'dev', pack, cwd: staging, phase: 'refine', taskId: null, attempt: 1, extraAllow: [`Read(${absoluteRule(inputDir)}/**)`] }, { journal: journalStub, stepDir: (n: number) => path.join(root, 'steps', `${variant}-${n}`), specHash, projectId: PROJECT });
      seconds += (Date.now() - t0) / 1000;
      costUsd += outcome.summary.costUsd ?? 0;
      runs++;
      return outcome as StepOutcome<SpeckitOutput>;
    },
  });
  const planChars = await fs.readFile(file, 'utf8').then((text) => text.length).catch(() => 0);
  const specChars = specSectionOf(specsMd, item.key).length;
  return { key: item.key, specId: item.specId, status: result.status, repairs: result.repairs, questions: result.questions, runs, seconds: Math.round(seconds), costUsd: Math.round(costUsd * 10_000) / 10_000, planChars, specChars, ratio: specChars === 0 ? 0 : Math.round((planChars / specChars) * 100) / 100, issues: result.issues.slice(0, 4) };
}

const rows: Row[] = [];
// With --resume 1, items already in the results file are not run again; the gate reads the whole file.
const recorded = new Set<string>();
if (flags.get('resume') === '1') for (const line of (await fs.readFile(resultsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean)) recorded.add((JSON.parse(line) as Row).key);
const todo = sample.filter((s) => !recorded.has(s.item.key));
let next = 0;
const worker = async (): Promise<void> => {
  for (;;) {
    const index = next++;
    if (index >= todo.length) return;
    const row = await runItem(todo[index]!);
    process.stdout.write(`${JSON.stringify(row)}\n`);
    await fs.appendFile(resultsFile, `${JSON.stringify(row)}\n`);
  }
};
await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
rows.splice(0, rows.length, ...(await fs.readFile(resultsFile, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Row));

const valid = rows.filter((r) => r.status === 'valid').length;
const withQuestions = rows.filter((r) => r.questions > 0).length;
const gate = {
  variant,
  plans: rows.length,
  valid,
  validShare: Math.round((valid / rows.length) * 1000) / 1000,
  withQuestions,
  medianRatio: median(rows.map((r) => r.ratio)),
  maxPlanChars: Math.max(0, ...rows.map((r) => r.planChars)),
  medianSeconds: median(rows.map((r) => r.seconds)),
  totalCostUsd: Math.round(rows.reduce((sum, r) => sum + r.costUsd, 0) * 1000) / 1000,
};
const pass = gate.validShare >= GATE.validShare && withQuestions === 0 && gate.medianRatio <= GATE.maxRatio && gate.maxPlanChars <= GATE.maxPlanChars && gate.medianSeconds <= GATE.maxMedianSeconds;
process.stdout.write(`${JSON.stringify({ ...gate, pass }, null, 2)}\n`);
