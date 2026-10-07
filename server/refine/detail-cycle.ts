import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ItemPreplan, ItemSpec, PreplanOutput, SpecDetailOutput } from '../agents/outputs.js';
import { Governor } from '../budget/governor.js';
import { Preplan } from '../contracts/preplan.js';
import { computeSpecHash, Spec } from '../contracts/spec.js';
import type { StepOutcome } from '../runner/step.js';
import { validatePreplan } from '../validators/preplan.js';
import type { CycleDeps } from './cycle.js';
import { acNum } from './derive.js';
import { preplanPack, specPack } from './detail-packs.js';
import { batches, preplanInputHash, sourceHashes, specInputHash, type BacklogDocs } from './details.js';
import { renderBriefMd, type Draft } from './draft.js';
import { RefineEvent } from './events.js';
import { fitPackBudget } from './fit-pack.js';
import { postProcessItemSpec } from './item-spec.js';
import type { BacklogState, PreplanRow, SpecRow } from './state.js';

/** Agent calls of one detailing run at a time; the account-wide governor still caps every session together. */
const DETAIL_CONCURRENCY = 3;
const STOPPING = new Set(['quota', 'auth']);

type Item = BacklogState['items'][number];
type Ctx = Parameters<CycleDeps['runAgent']>[1];
export type DetailResult = { ok: true; backlog: BacklogState } | { ok: false; reason: string };

const itemDir = (draft: Draft, specId: string) => path.posix.join(draft.docs, 'specs', specId);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Generated files of a backlog item: spec.json and spec.md (never brief.md, the hand-edited briefing's name). */
async function writeItemSpec(draft: Draft, spec: Spec, status: 'refining' | 'planned'): Promise<void> {
  const dir = itemDir(draft, spec.specId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.posix.join(dir, 'spec.json'), json({ ...spec, status }));
  const sources = (spec.derivedFrom?.sources ?? []).map((s) => `${s.doc} › ${s.heading}${s.hash ? ` (${s.hash.slice(0, 15)}…)` : ''}`).join('; ');
  await fs.writeFile(path.posix.join(dir, 'spec.md'), `> Gerado pelo teams-ai a partir de spec.json; não edite. Fontes: ${sources}\n\n${renderBriefMd(spec)}`);
}

/** The highest criterion number in the target project's specs (main's, copied into the draft, and the generated ones). */
export async function maxCriterionInDraft(draft: Draft): Promise<number> {
  const root = path.posix.join(draft.docs, 'specs');
  const dirs = await fs.readdir(root).catch(() => [] as string[]);
  let max = 0;
  for (const dir of dirs) {
    const text = await fs.readFile(path.posix.join(root, dir, 'spec.json'), 'utf8').catch(() => null);
    const ids = text === null ? [] : ((JSON.parse(text) as { acceptanceCriteria?: Array<{ id?: string }> }).acceptanceCriteria ?? []).map((c) => c.id ?? '');
    for (const id of ids) if (/^AC-\d{3}$/.test(id)) max = Math.max(max, acNum(id));
  }
  return max;
}

/** The generated files of items a new outline dropped; keys come from state, never from a scan of main's spec dirs. */
export async function removeRetired(draft: Draft, before: BacklogState | null, items: ReadonlyArray<{ key: string }>): Promise<void> {
  const kept = new Set(items.map((i) => i.key));
  for (const [key, row] of Object.entries(before?.specs ?? {})) {
    if (!kept.has(key)) await fs.rm(itemDir(draft, row.specId), { recursive: true, force: true });
  }
}

/**
 * Backlog detailing: the spec (PO) of every item whose inputs changed, then the pre-plan (SM) of every spec whose inputs
 * changed, three items per call by epic, each item checked alone and retried alone once with its rejection. The first
 * quota or auth failure stops new calls and fails the cycle; what finished stays recorded.
 */
export async function detailBacklog(deps: CycleDeps, input: { cycle: number; hash: string; docs: BacklogDocs; backlog: BacklogState; ctx: Ctx }): Promise<DetailResult> {
  const { draft, journal } = deps;
  const { cycle, hash, docs, ctx } = input;
  const items = [...input.backlog.items].sort((a, b) => a.rank - b.rank);
  const specs: Record<string, SpecRow> = { ...input.backlog.specs };
  const preplans: Record<string, PreplanRow> = { ...input.backlog.preplans };
  let highWater = Math.max(input.backlog.acHighWater ?? 0, await maxCriterionInDraft(draft));
  let stopped: string | null = null;
  const governor = new Governor(DETAIL_CONCURRENCY);

  /** Runs one call unless the run already stopped; records the stop on a quota or auth failure. */
  const call = async <T>(run: () => Promise<StepOutcome<T>>): Promise<StepOutcome<T> | null> => {
    const release = await governor.acquire();
    try {
      if (deps.signal?.aborted) stopped ??= 'interrompido';
      if (stopped) return null;
      const out = await run();
      if (!out.ok && STOPPING.has(out.failure)) stopped ??= `${out.failure}: ${out.errors.join('; ')}`;
      return out;
    } finally {
      release();
    }
  };

  // Specs.
  const specHash = new Map(items.map((i) => [i.key, specInputHash(i, docs)]));
  // Each item's last valid spec: its row, or the generated spec.json a failed attempt left on disk (keeps ids stable).
  const previous = new Map<string, Spec | null>();
  for (const i of items) {
    previous.set(i.key, specs[i.key]?.spec ?? (await fs.readFile(path.posix.join(itemDir(draft, `${draft.specId}-${i.key}`), 'spec.json'), 'utf8').then((t) => Spec.parse(JSON.parse(t)), () => null)));
  }
  const acceptSpec = async (item: Item, entry: ItemSpec | undefined): Promise<string[]> => {
    if (!entry) return ['o agente não devolveu a spec deste item'];
    const inputHash = specHash.get(item.key)!;
    const r = postProcessItemSpec(entry, { draftId: draft.specId, previous: previous.get(item.key) ?? null, highWater, provenance: { backlogKey: item.key, inputHash, docsHash: hash, sources: sourceHashes(item, docs) } });
    if (!r.ok) return r.issues;
    highWater = r.highWater;
    const rev = computeSpecHash(r.spec);
    specs[item.key] = { inputHash, specId: r.spec.specId, rev, spec: r.spec, issues: [], cycle };
    // Unchanged content keeps its revision, and with it a pre-plan that is still current.
    const planned = preplans[item.key]?.preplan && preplans[item.key]!.specRev === rev;
    await writeItemSpec(draft, r.spec, planned ? 'planned' : 'refining');
    await journal.fact(RefineEvent.SpecDerived, { cycle, key: item.key, specId: r.spec.specId, inputHash, rev, spec: r.spec, issues: [], highWater });
    return [];
  };
  const failSpec = async (item: Item, issues: string[]) => {
    const inputHash = specHash.get(item.key)!;
    specs[item.key] = { inputHash, specId: `${draft.specId}-${item.key}`, rev: null, spec: null, issues, cycle };
    await journal.fact(RefineEvent.SpecDerived, { cycle, key: item.key, specId: `${draft.specId}-${item.key}`, inputHash, rev: null, spec: null, issues, highWater });
  };
  const runSpecs = (batch: readonly Item[], rejection: Record<string, string[]>) => call(() => deps.runAgent<'spec'>({
    kind: 'spec', role: 'po', cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle,
    pack: fitPackBudget(specPack({ specHash: hash, principles: deps.principles(), docs, batch, all: items, previous: Object.fromEntries(batch.map((i) => [i.key, previous.get(i.key)])), rejection })),
  }, ctx) as Promise<StepOutcome<SpecDetailOutput>>);
  const specTodo = items.filter((i) => !specs[i.key] || specs[i.key]!.inputHash !== specHash.get(i.key) || specs[i.key]!.spec === null);
  await Promise.all(batches(specTodo).map(async (batch) => {
    const out = await runSpecs(batch, {});
    if (!out) return;
    for (const item of batch) {
      const issues = out.ok ? await acceptSpec(item, out.value.specs.find((s) => s.key === item.key)) : [`${out.failure}: ${out.errors.join('; ')}`];
      if (issues.length === 0 || stopped) continue;
      const solo = await runSpecs([item], { [item.key]: issues });
      if (!solo) return;
      const again = solo.ok ? await acceptSpec(item, solo.value.specs.find((s) => s.key === item.key)) : [`${solo.failure}: ${solo.errors.join('; ')}`];
      if (again.length > 0) await failSpec(item, again);
    }
  }));
  if (stopped) return { ok: false, reason: `detalhamento interrompido (${stopped})` };

  // Pre-plans, for the specs that are valid now.
  const planHash = new Map(items.filter((i) => specs[i.key]?.rev).map((i) => [i.key, preplanInputHash(i, specs[i.key]!.rev!, docs['stack.md'], i.rank === 1)]));
  const acceptPreplan = async (item: Item, entry: ItemPreplan | undefined): Promise<string[]> => {
    if (!entry) return ['o agente não devolveu o pré-plano desta spec'];
    const row = specs[item.key]!;
    const spec = row.spec!;
    const parsed = Preplan.safeParse({ specId: spec.specId, specRev: row.rev, inputHash: planHash.get(item.key), modules: entry.modules, tasks: entry.tasks, risks: entry.risks });
    if (!parsed.success) return parsed.error.issues.map((i) => `preplan ${item.key}.${i.path.join('.')}: ${i.message}`);
    const rules = validatePreplan(parsed.data, spec);
    if (rules.length > 0) return rules;
    preplans[item.key] = { inputHash: parsed.data.inputHash, specRev: parsed.data.specRev, preplan: parsed.data, issues: [], cycle };
    await fs.writeFile(path.posix.join(itemDir(draft, spec.specId), 'preplan.json'), json(parsed.data));
    await writeItemSpec(draft, spec, 'planned');
    await journal.fact(RefineEvent.PreplanDerived, { cycle, key: item.key, inputHash: parsed.data.inputHash, specRev: parsed.data.specRev, preplan: parsed.data, issues: [] });
    return [];
  };
  const failPreplan = async (item: Item, issues: string[]) => {
    const row = { inputHash: planHash.get(item.key)!, specRev: specs[item.key]!.rev!, preplan: null, issues, cycle };
    preplans[item.key] = row;
    await journal.fact(RefineEvent.PreplanDerived, { key: item.key, ...row });
  };
  const runPreplans = (batch: readonly Item[], rejection: Record<string, string[]>) => call(() => deps.runAgent<'preplan'>({
    kind: 'preplan', role: 'sm', cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle,
    pack: fitPackBudget(preplanPack({ specHash: hash, principles: deps.principles(), stackMd: docs['stack.md'], batch: batch.map((i) => ({ item: i, spec: specs[i.key]!.spec!, first: i.rank === 1, previous: preplans[i.key]?.preplan ?? null, rejection: rejection[i.key] ?? [] })) })),
  }, ctx) as Promise<StepOutcome<PreplanOutput>>);
  const preplanTodo = items.filter((i) => planHash.has(i.key) && (!preplans[i.key] || preplans[i.key]!.inputHash !== planHash.get(i.key) || preplans[i.key]!.preplan === null));
  await Promise.all(batches(preplanTodo).map(async (batch) => {
    const out = await runPreplans(batch, {});
    if (!out) return;
    for (const item of batch) {
      const issues = out.ok ? await acceptPreplan(item, out.value.preplans.find((p) => p.key === item.key)) : [`${out.failure}: ${out.errors.join('; ')}`];
      if (issues.length === 0 || stopped) continue;
      const solo = await runPreplans([item], { [item.key]: issues });
      if (!solo) return;
      const again = solo.ok ? await acceptPreplan(item, solo.value.preplans.find((p) => p.key === item.key)) : [`${solo.failure}: ${solo.errors.join('; ')}`];
      if (again.length > 0) await failPreplan(item, again);
    }
  }));
  if (stopped) return { ok: false, reason: `detalhamento interrompido (${stopped})` };
  return { ok: true, backlog: { ...input.backlog, specs, preplans, acHighWater: highWater } };
}
