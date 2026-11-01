import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ConflictsOutput, ItemPreplan, ItemSpec, PreplanOutput, SpecDetailOutput } from '../agents/outputs.js';
import { Governor } from '../budget/governor.js';
import { ID_PATTERNS } from '../core/ids.js';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import { Preplan } from '../contracts/preplan.js';
import { computeSpecHash, Spec } from '../contracts/spec.js';
import { preplanFlags, specFlags } from '../decide/decisions/detail-check.js';
import { AC_ID } from '../contracts/patterns.js';
import { adjusted } from './adjustments.js';
import { failureMessage, internalErrorMessage } from './agent-failure.js';
import { isStarted } from './coverage.js';
import type { StepOutcome } from '../runner/step.js';
import type { FailureKind } from '../scheduler/retry-policy.js';
import { validatePreplan } from '../validators/preplan.js';
import type { CycleDeps } from './cycle.js';
import { acNum } from './derive.js';
import { citedSections, fitConflictsPack, preplanPack, specPack } from './detail-packs.js';
import { repositoryContextOf } from './architecture-step.js';
import { batches, preplanInputHash, sourceHashes, specInputHash, type BacklogDocs } from './details.js';
import { readMainSpec, renderBriefMd, restoreFromBase, type Draft } from './draft.js';
import { RefineEvent } from './events.js';
import { fitPackBudget } from './fit-pack.js';
import { postProcessItemSpec } from './item-spec.js';
import { specIdOf } from './specs-index.js';
import type { BacklogState, PreplanRow, SpecRow } from './state.js';

/** Agent calls of one detailing run at a time; the account-wide governor still caps every session together. */
const DETAIL_CONCURRENCY = 3;
const STOPPING = new Set(['quota', 'auth']);

type Item = BacklogState['items'][number];
type Ctx = Parameters<CycleDeps['runAgent']>[1];
export type DetailResult = { ok: true; backlog: BacklogState } | { ok: false; reason: string; detail?: string; kind?: FailureKind };
/** What an answer came to: recorded when it has no issues; `flagged` marks a valid answer the Jev flagged and nothing recorded; `detail` is what a retry tells the agent when it differs from the owner's `issues`. */
type Verdict = { issues: string[]; flagged?: boolean; detail?: string[] };

const itemDir = (draft: Draft, specId: string) => path.posix.join(draft.docs, 'specs', specId);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Pairs of two distinct items of this backlog, each pair once whatever its order. */
function uniquePairs(pairs: ConflictsOutput['pairs'], keys: ReadonlySet<string>): ConflictsOutput['pairs'] {
  const seen = new Set<string>();
  return pairs.filter((p) => {
    const id = [p.a, p.b].sort().join(' ');
    if (p.a === p.b || !keys.has(p.a) || !keys.has(p.b) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** A JSON file, or null when it is missing or unreadable: a broken generated file never blocks the refinement. */
const readJson = (file: string): Promise<unknown> => fs.readFile(file, 'utf8').then((t) => JSON.parse(t) as unknown).catch(() => null);

/** Generated files of a backlog item: spec.json and spec.md (never briefing.md, the hand-edited briefing's name). */
async function writeItemSpec(draft: Draft, spec: Spec, status: 'refining' | 'planned'): Promise<void> {
  const dir = itemDir(draft, spec.specId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.posix.join(dir, 'spec.json'), json({ ...spec, status }));
  const sources = (spec.derivedFrom?.sources ?? []).map((s) => `${s.doc} › ${s.heading}${s.hash ? ` (${s.hash.slice(0, 15)}…)` : ''}`).join('; ');
  await fs.writeFile(path.posix.join(dir, 'spec.md'), `> Gerado pelo teams-ai a partir de spec.json; não edite. Fontes: ${sources}\n\n${renderBriefMd(spec)}`);
}

/** The item's last valid generated spec on disk, or null. */
async function readItemSpec(draft: Draft, specId: string): Promise<Spec | null> {
  const parsed = Spec.safeParse(await readJson(path.posix.join(itemDir(draft, specId), 'spec.json')));
  return parsed.success ? parsed.data : null;
}

/** A spec whose last attempt failed is not planned any more, on disk either: a later publisher reads that status. */
async function markRefining(draft: Draft, specId: string, spec: Spec | null): Promise<void> {
  const current = spec ?? (await readItemSpec(draft, specId));
  if (current) await writeItemSpec(draft, current, 'refining');
}

/** The highest criterion number in the target project's specs (main's, copied into the draft, and the generated ones). */
export async function maxCriterionInDraft(draft: Draft): Promise<number> {
  const root = path.posix.join(draft.docs, 'specs');
  const dirs = await fs.readdir(root).catch(() => [] as string[]);
  let max = 0;
  for (const dir of dirs) {
    const spec = (await readJson(path.posix.join(root, dir, 'spec.json'))) as { acceptanceCriteria?: Array<{ id?: unknown }> } | null;
    for (const c of Array.isArray(spec?.acceptanceCriteria) ? spec.acceptanceCriteria : []) {
      if (typeof c?.id === 'string' && AC_ID.test(c.id)) max = Math.max(max, acNum(c.id));
    }
  }
  return max;
}

/**
 * The items a new outline dropped (R11.7.5): a spec main has planned gets main's folder back with the status `retired`,
 * which Phase 0 publishes; any other folder of theirs leaves the draft. Ids come from state and the outline the PO was
 * shown, never from a scan of main's spec dirs.
 */
export async function retireDropped(draft: Draft, specIds: readonly string[]): Promise<void> {
  for (const specId of specIds) {
    // A spec id is a slug; anything else could name a path outside the draft.
    if (!ID_PATTERNS.SLUG.test(specId)) continue;
    const onMain = await readMainSpec(draft, specId);
    if (onMain?.status === 'planned' || onMain?.status === 'refining') {
      await restoreFromBase(draft, specId);
      await fs.writeFile(path.posix.join(itemDir(draft, specId), 'spec.json'), json({ ...onMain, status: 'retired' }));
    } else await fs.rm(itemDir(draft, specId), { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Backlog detailing: the spec (PO) of every item whose inputs changed, then the pre-plan (SM) of every spec whose inputs
 * changed, three items per call by epic. Each call's valid items are recorded first, then each rejected item is retried
 * alone once with its rejection. The first quota or auth failure, or any error, stops new calls and fails the cycle with
 * the reason once the calls in flight end; what finished stays recorded. With the decision layer on, the Jev checks each
 * valid first answer, and an item it flags is retried alone once as well (R11.5a item 3).
 */
export async function detailBacklog(deps: CycleDeps, input: { cycle: number; hash: string; docs: BacklogDocs; backlog: BacklogState; ctx: Ctx }): Promise<DetailResult> {
  try {
    return await detail(deps, input);
  } catch (err) {
    return { ok: false, ...internalErrorMessage('O detalhamento dos itens', err) };
  }
}

async function detail(deps: CycleDeps, input: { cycle: number; hash: string; docs: BacklogDocs; backlog: BacklogState; ctx: Ctx }): Promise<DetailResult> {
  const { draft, journal, decider } = deps;
  const { cycle, hash, docs, ctx } = input;
  // A backlog with no project yet counts as confidential, so its text never reaches the Jev.
  const dctx = { confidential: journal.state.confidential === true || (input.backlog.project?.confidential ?? true) };
  const items = [...input.backlog.items].sort((a, b) => a.rank - b.rank);
  const specs: Record<string, SpecRow> = { ...input.backlog.specs };
  const preplans: Record<string, PreplanRow> = { ...input.backlog.preplans };
  let highWater = Math.max(input.backlog.acHighWater ?? 0, await maxCriterionInDraft(draft));
  let stopped = null as { reason: string; detail?: string; kind?: FailureKind } | null;
  /** The run's stop, read through a call so each check sees its current value. */
  const haltedResult = (): DetailResult | null => (stopped ? { ok: false, ...stopped } : null);
  const governor = new Governor(DETAIL_CONCURRENCY);

  /** Runs one call unless the run already stopped; records the stop on a quota or auth failure. */
  const call = async <T>(run: () => Promise<StepOutcome<T>>): Promise<StepOutcome<T> | null> => {
    const release = await governor.acquire();
    try {
      if (deps.signal?.aborted) stopped ??= { reason: 'O detalhamento foi interrompido. Clique em Reavaliar.' };
      if (stopped) return null;
      const out = await run();
      if (!out.ok && STOPPING.has(out.failure)) stopped ??= failureMessage('O detalhamento dos itens', out.failure, out.errors);
      return out;
    } finally {
      release();
    }
  };

  /**
   * Every batch: record what the call returned valid, then retry each rejected item alone once; an error stops the run.
   * Only a first answer goes to the Jev (`review`), and one it flagged is recorded when its retry is not valid or never ran.
   */
  const runBatches = async <T, E>(
    todo: readonly Item[],
    run: (batch: readonly Item[], rejection: Record<string, string[]>) => Promise<StepOutcome<T> | null>,
    entry: (value: T, key: string) => E | undefined,
    accept: (item: Item, entry: E | undefined, review: boolean) => Promise<Verdict>,
    fail: (item: Item, issues: string[]) => Promise<void>,
  ): Promise<void> => {
    const outcome = (out: StepOutcome<T>, item: Item, review: boolean): Promise<Verdict> => {
      if (out.ok) return accept(item, entry(out.value, item.key), review);
      const { reason, detail } = failureMessage('O agente deste item', out.failure, out.errors);
      return Promise.resolve({ issues: [reason], detail: [detail] });
    };
    await Promise.all(batches(todo).map(async (batch) => {
      try {
        const out = await run(batch, {});
        if (!out) return;
        // A batch that gave no answer fails each item once: a retry alone would fail the same way, and a stop is reported by the cycle.
        if (!out.ok && out.failure !== 'schema') {
          if (!STOPPING.has(out.failure)) for (const item of batch) await fail(item, (await outcome(out, item, false)).issues);
          return;
        }
        const rejected: Array<[Item, Verdict]> = [];
        for (const item of batch) {
          const first = await outcome(out, item, true);
          if (first.issues.length > 0) rejected.push([item, first]);
        }
        for (const [item, first] of rejected) {
          const solo = await run([item], { [item.key]: first.detail ?? first.issues });
          let again = solo && (await outcome(solo, item, false));
          if (first.flagged && (!again || again.issues.length > 0)) again = await outcome(out, item, false);
          if (!again) continue;
          // A quota or auth stop is reported once, by the cycle, not as this item's issue.
          const stoppedBy = solo && !solo.ok && STOPPING.has(solo.failure);
          if (again.issues.length > 0 && !stoppedBy) await fail(item, again.issues);
        }
      } catch (err) {
        stopped ??= internalErrorMessage('O detalhamento dos itens', err);
      }
    }));
  };

  // Specs. Each item's last valid spec (its row, or the generated spec.json on disk) keeps its criterion ids stable.
  const specHash = new Map(items.map((i) => [i.key, specInputHash(i, docs, repositoryContextOf(deps.journal.state, i.repository))]));
  const previous = new Map<string, Spec | null>();
  const idOf = (key: string) => specIdOf(draft.specId, key, input.backlog.keyIds);
  for (const i of items) previous.set(i.key, specs[i.key]?.spec ?? (await readItemSpec(draft, idOf(i.key))));
  // R11.7.2: an item whose spec on main started or was delivered is kept as main has it; a newer delivery is recorded again.
  const kept = new Set<string>();
  for (const i of items) {
    const onMain = await readMainSpec(draft, idOf(i.key));
    if (!onMain || !isStarted(onMain.status)) continue;
    kept.add(i.key);
    await restoreFromBase(draft, onMain.specId);
    const rev = computeSpecHash(onMain);
    if (specs[i.key]?.rev === rev && specs[i.key]?.spec?.status === onMain.status) continue;
    specs[i.key] = { inputHash: specHash.get(i.key)!, specId: onMain.specId, rev, spec: onMain, issues: [], cycle };
    await journal.fact(RefineEvent.SpecDerived, { cycle, key: i.key, specId: onMain.specId, inputHash: specHash.get(i.key), rev, spec: onMain, issues: [], highWater });
  }
  const planHashOf = (item: Item, rev: string) => preplanInputHash(item, rev, docs['stack.md'], item.rank === 1);
  // R11.7.3: a new draft reuses main's spec of an item whose inputs did not change, and its pre-plan when still current.
  for (const i of items) {
    if (kept.has(i.key) || specs[i.key]) continue;
    const onMain = await readMainSpec(draft, idOf(i.key));
    if (!onMain || onMain.derivedFrom?.inputHash !== specHash.get(i.key)) continue;
    // Main's folder back in the draft: an item dropped and added again in this draft lost it, and its run reads it.
    await restoreFromBase(draft, onMain.specId);
    // R11.7.5: a retired spec whose item is back is planned again, and Phase 0 publishes that.
    const spec = onMain.status === 'retired' ? { ...onMain, status: 'planned' as const } : onMain;
    if (spec !== onMain) await fs.writeFile(path.posix.join(itemDir(draft, spec.specId), 'spec.json'), json(spec));
    const rev = computeSpecHash(spec);
    specs[i.key] = { inputHash: specHash.get(i.key)!, specId: spec.specId, rev, spec, issues: [], cycle };
    await journal.fact(RefineEvent.SpecDerived, { cycle, key: i.key, specId: spec.specId, inputHash: specHash.get(i.key), rev, spec, issues: [], highWater });
    const pre = Preplan.safeParse(draft.base ? await readJson(path.posix.join(draft.base, 'specs', onMain.specId, 'preplan.json')) : null);
    if (!pre.success || pre.data.specRev !== rev || pre.data.inputHash !== planHashOf(i, rev)) continue;
    preplans[i.key] = { inputHash: pre.data.inputHash, specRev: rev, preplan: pre.data, issues: [], cycle };
    await journal.fact(RefineEvent.PreplanDerived, { cycle, key: i.key, inputHash: pre.data.inputHash, specRev: rev, preplan: pre.data, issues: [] });
  }
  const acceptSpec = async (item: Item, entry: ItemSpec | undefined, review: boolean): Promise<Verdict> => {
    if (!entry) return { issues: ['o agente não devolveu a spec deste item'], detail: ['the answer has no spec for this item'] };
    const inputHash = specHash.get(item.key)!;
    const processed = () => postProcessItemSpec(entry, { specId: idOf(item.key), previous: previous.get(item.key) ?? null, highWater, provenance: { backlogKey: item.key, inputHash, docsHash: hash, sources: sourceHashes(item, docs) }, repository: item.repository });
    if (review && decider) {
      const dry = processed();
      if (!dry.ok) return { issues: dry.issues, detail: dry.detail };
      const flags = await specFlags({ item, sections: citedSections(item, docs), spec: dry.spec }, decider, dctx);
      if (flags.length > 0) return { issues: flags, flagged: true };
    }
    // Numbered after the Jev's answer, so a batch running beside this one never takes the same criterion numbers.
    const r = processed();
    if (!r.ok) return { issues: r.issues, detail: r.detail };
    highWater = r.highWater;
    const rev = computeSpecHash(r.spec);
    specs[item.key] = { inputHash, specId: r.spec.specId, rev, spec: r.spec, issues: [], cycle };
    // Unchanged content and inputs keep the pre-plan current, and the spec planned.
    const pre = preplans[item.key];
    const planned = pre?.preplan && pre.specRev === rev && pre.inputHash === planHashOf(item, rev);
    await writeItemSpec(draft, r.spec, planned ? 'planned' : 'refining');
    await journal.fact(RefineEvent.SpecDerived, { cycle, key: item.key, specId: r.spec.specId, inputHash, rev, spec: r.spec, issues: [], highWater });
    return { issues: [] };
  };
  const failSpec = async (item: Item, issues: string[]) => {
    const specId = idOf(item.key);
    const inputHash = specHash.get(item.key)!;
    specs[item.key] = { inputHash, specId, rev: null, spec: null, issues, cycle };
    await markRefining(draft, specId, null);
    await journal.fact(RefineEvent.SpecDerived, { cycle, key: item.key, specId, inputHash, rev: null, spec: null, issues, highWater });
  };
  // R11.7.4: an adjustment is derived against the started specs it changes.
  const adjustsOf = (item: Item) => adjusted(item.key, items).flatMap((k) => (specs[k]?.spec ? [specs[k]!.spec!] : []));
  const runSpecs = (batch: readonly Item[], rejection: Record<string, string[]>) => call(() => deps.runAgent<'spec'>({
    kind: 'spec', role: 'po', cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle,
    pack: fitPackBudget(specPack({ specHash: hash, principles: deps.principles(), docs, batch, all: items, previous: Object.fromEntries(batch.map((i) => [i.key, previous.get(i.key)])), rejection, adjusts: Object.fromEntries(batch.map((i) => [i.key, adjustsOf(i)])), repositories: Object.fromEntries(batch.map((i) => [i.key, repositoryContextOf(deps.journal.state, i.repository)])) })),
  }, ctx) as Promise<StepOutcome<SpecDetailOutput>>);
  const specTodo = items.filter((i) => !kept.has(i.key) && (!specs[i.key] || specs[i.key]!.inputHash !== specHash.get(i.key) || specs[i.key]!.spec === null));
  await runBatches(specTodo, runSpecs, (v: SpecDetailOutput, key) => v.specs.find((s) => s.key === key), acceptSpec, failSpec);
  const haltSpecs = haltedResult();
  if (haltSpecs) return haltSpecs;

  // Pre-plans, for the specs that are valid now.
  const planHash = new Map(items.filter((i) => specs[i.key]?.rev).map((i) => [i.key, planHashOf(i, specs[i.key]!.rev!)]));
  const acceptPreplan = async (item: Item, entry: ItemPreplan | undefined, review: boolean): Promise<Verdict> => {
    if (!entry) return { issues: ['o agente não devolveu o pré-plano desta spec'], detail: ['the answer has no pre-plan for this spec'] };
    const row = specs[item.key]!;
    const spec = row.spec!;
    const parsed = Preplan.safeParse({ specId: spec.specId, specRev: row.rev, inputHash: planHash.get(item.key), modules: entry.modules, tasks: entry.tasks, risks: entry.risks });
    if (!parsed.success) return { issues: parsed.error.issues.map((i) => `o pré-plano não passou na validação (${i.path.join('.') || 'raiz'})`), detail: parsed.error.issues.map((i) => `preplan ${i.path.join('.')}: ${i.message}`) };
    const rules = validatePreplan(parsed.data, spec);
    if (rules.length > 0) return { issues: rules };
    if (review && decider) {
      const flags = await preplanFlags({ preplan: parsed.data, projectMd: docs['project.md'], stackMd: docs['stack.md'] }, decider, dctx);
      if (flags.length > 0) return { issues: flags, flagged: true };
    }
    preplans[item.key] = { inputHash: parsed.data.inputHash, specRev: parsed.data.specRev, preplan: parsed.data, issues: [], cycle };
    await fs.writeFile(path.posix.join(itemDir(draft, spec.specId), 'preplan.json'), json(parsed.data));
    await writeItemSpec(draft, spec, 'planned');
    await journal.fact(RefineEvent.PreplanDerived, { cycle, key: item.key, inputHash: parsed.data.inputHash, specRev: parsed.data.specRev, preplan: parsed.data, issues: [] });
    return { issues: [] };
  };
  const failPreplan = async (item: Item, issues: string[]) => {
    const row = { inputHash: planHash.get(item.key)!, specRev: specs[item.key]!.rev!, preplan: null, issues, cycle };
    preplans[item.key] = row;
    await markRefining(draft, specs[item.key]!.specId, specs[item.key]!.spec);
    await journal.fact(RefineEvent.PreplanDerived, { key: item.key, ...row });
  };
  const runPreplans = (batch: readonly Item[], rejection: Record<string, string[]>) => call(() => deps.runAgent<'preplan'>({
    kind: 'preplan', role: 'sm', cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle,
    pack: fitPackBudget(preplanPack({ specHash: hash, principles: deps.principles(), projectMd: docs['project.md'], stackMd: docs['stack.md'], batch: batch.map((i) => ({ item: i, spec: specs[i.key]!.spec!, first: i.rank === 1, previous: preplans[i.key]?.preplan ?? null, rejection: rejection[i.key] ?? [] })) })),
  }, ctx) as Promise<StepOutcome<PreplanOutput>>);
  const preplanTodo = items.filter((i) => !kept.has(i.key) && planHash.has(i.key) && (!preplans[i.key] || preplans[i.key]!.inputHash !== planHash.get(i.key) || preplans[i.key]!.preplan === null));
  await runBatches(preplanTodo, runPreplans, (v: PreplanOutput, key) => v.preplans.find((p) => p.key === key), acceptPreplan, failPreplan);
  const haltPreplans = haltedResult();
  if (haltPreplans) return haltPreplans;

  // The SM's conflict map, made again only when a pre-plan changed. A failed call leaves none: the program then runs one spec at a time.
  let conflicts = input.backlog.conflicts;
  const planned = items.flatMap((item) => (preplans[item.key]?.preplan ? [{ item, preplan: preplans[item.key]!.preplan! }] : []));
  const conflictsHash = sha256(canonicalJson(planned.map(({ item, preplan }) => ({ key: item.key, dependsOn: item.dependsOn, modules: preplan.modules, tasks: preplan.tasks.map((t) => [t.title, t.module]) }))));
  if (planned.length === items.length && conflicts?.inputHash !== conflictsHash) {
    const out = items.length < 2 ? null : await call(() => deps.runAgent<'conflicts'>({
      kind: 'conflicts', role: 'sm', cwd: draft.root, phase: 'refine', taskId: null, attempt: cycle,
      pack: fitConflictsPack({ specHash: hash, principles: deps.principles(), items: planned }),
    }, ctx) as Promise<StepOutcome<ConflictsOutput>>);
    const haltConflicts = haltedResult();
    if (haltConflicts) return haltConflicts;
    if (items.length < 2 || out?.ok) {
      conflicts = { inputHash: conflictsHash, pairs: out?.ok ? uniquePairs(out.value.pairs, new Set(items.map((i) => i.key))) : [] };
      await journal.fact(RefineEvent.ConflictsDerived, { ...conflicts });
    }
  }
  return { ok: true, backlog: { ...input.backlog, specs, preplans, acHighWater: highWater, ...(conflicts ? { conflicts } : {}) } };
}
