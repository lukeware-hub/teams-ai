import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sha256 } from '../contracts/hash.js';
import type { SuggestOutput } from '../agents/outputs.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import type { StepOutcome } from '../runner/step.js';
import type { Project } from '../contracts/project.js';
import { freezeSpec, providedSecretNames, Spec } from '../contracts/spec.js';
import { writeFileAtomic } from '../core/atomic-write.js';
import { loadSecrets, SECRET_NAME, writeSecret } from '../core/secrets.js';
import type { ProgramEntry } from '../program/controller.js';
import type { Hit } from '../knowledge/retrieval.js';
import type { Workspace } from '../orchestrator/workspace.js';
import { EventStore, type StoredEvent } from '../store/event-store.js';
import { runCycle, type CycleDeps, type RunAgent } from './cycle.js';
import { recordDecision, withDecisions } from './decisions.js';
import { maxCriterionInDraft } from './detail-cycle.js';
import { designTemplate, flowTemplate, moveBriefingToProject, readDerived, readDoc, readMainSpec, stackTemplate, writeDerived, writeDoc, type DocFile, type Draft } from './draft.js';
import { DRAFT_HASH, RefineEvent } from './events.js';
import { applyPatch } from './patches.js';
import { buildSpecsIndex } from './specs-index.js';
import { fitPackBudget } from './fit-pack.js';
import { designFromImagesPack, SUGGEST_ROLE, suggestPack, type SuggestFile } from './suggest.js';
import { applyRefineEvent, emptyRefineState, type BacklogState, type RefineState } from './state.js';
import { isStarted } from './coverage.js';

export type { RunAgent } from './cycle.js';
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

/** Single-writer journal of one refinement session, reduced into RefineState as it is appended. */
export class RefineJournal {
  readonly state: RefineState = emptyRefineState();
  private readonly log: StoredEvent[] = [];
  private stepSeq = 0;

  private constructor(
    private readonly store: EventStore,
    events: StoredEvent[],
  ) {
    for (const e of events) this.push(e);
  }

  static async open(file: string, ids: { projectId: string; specId: string }): Promise<RefineJournal> {
    const store = await EventStore.open({ file, runId: `${ids.projectId}/${ids.specId}`, specHash: DRAFT_HASH });
    return new RefineJournal(store, await store.readAll());
  }

  get events(): readonly StoredEvent[] {
    return this.log;
  }

  private push(e: StoredEvent): void {
    this.log.push(e);
    applyRefineEvent(this.state, e);
    if (e.type === 'STEP_STARTED') this.stepSeq += 1;
  }

  async fact(type: string, data: Record<string, unknown> = {}): Promise<StoredEvent> {
    const stored = await this.store.append({ type, kind: 'fact', data });
    this.push(stored);
    return stored;
  }

  allocStepSeq(): number {
    return ++this.stepSeq;
  }

  close(): Promise<void> {
    return this.store.close();
  }
}

export interface SessionDeps {
  ws: Workspace;
  draft: Draft;
  runAgent: RunAgent;
  frontAgent?: RunAgent;
  secretsDir: string;
  retrieval: (query: string) => readonly Hit[];
  validateDocs?: CycleDeps['validateDocs'];
  decider?: CycleDeps['decider'];
  /** Read at each evaluation, so a floor set in the config reaches drafts already open. */
  autoAnswerFloor?: () => Promise<number | undefined>;
}
/** The secrets the specs list as external dependencies, so the screen offers a field for each one that is missing. */
function requiredSecretNames(state: RefineState): string[] {
  const dependencies = state.backlog?.enabled
    ? Object.values(state.backlog.specs ?? {}).flatMap((row) => row.spec?.externalDependencies ?? [])
    : state.derived?.spec.externalDependencies ?? [];
  return providedSecretNames(dependencies);
}
export interface SecretRow {
  name: string;
  present: boolean;
  hint: string | null;
}
export interface Snapshot {
  projectId: string;
  specId: string;
  state: RefineState;
  docs: { 'project.md': string; 'brief.md': string; 'stack.md': string; 'flow.md': string; 'design.md': string };
  secrets: SecretRow[];
  tokens: { inputTokens: number; outputTokens: number; costUsd: number; steps: number };
  /** True from the evaluate call on, even before the cycle journals that it started. */
  busy: boolean;
  /** The seq of the last event the state holds; the page applies only the events after it. */
  seq: number;
}

const COVERED = 'Este ajuste já foi coberto por outra alteração e foi descartado.';

/**
 * R11.7.2: the program's entries from each item's status on main (`onMain`, by spec id). A done item starts done; a running
 * or paused one runs again from its freeze; one awaiting validation, or started on main while this draft re-derived it, refuses.
 */
export function programEntries(draftId: string, backlog: BacklogState, onMain: Readonly<Record<string, string | undefined>>): ProgramEntry[] {
  const specs = buildSpecsIndex(draftId, backlog).specs;
  const idOf = new Map(specs.map((s) => [s.key, s.specId]));
  // The SM's conflict map as each entry's spec ids; no map leaves the field out, so the program runs one at a time.
  const conflictsWith = (key: string) => ({ conflictsWith: backlog.conflicts!.pairs.flatMap((p) => (p.a === key ? [p.b] : p.b === key ? [p.a] : [])).flatMap((k) => idOf.get(k) ?? []) });
  const entries = specs.map((s): ProgramEntry => {
    const status = onMain[s.specId];
    if (isStarted(status) && !isStarted(backlog.specs?.[s.key]?.spec?.status)) throw new ConflictError(`A spec ${s.specId} foi iniciada ou entregue enquanto este rascunho refinava; avalie de novo para mantê-la como está na main.`);
    if (status === 'awaiting-validation') throw new ConflictError(`A spec ${s.specId} aguarda validação; valide essa entrega antes de iniciar este programa.`);
    return { specId: s.specId, key: s.key, rank: s.rank, dependsOn: s.dependsOn, ...(backlog.conflicts ? conflictsWith(s.key) : {}), ...(status === 'done' ? { done: true } : {}) };
  });
  if (entries.every((e) => e.done)) throw new ConflictError('Todas as specs deste backlog já foram entregues; não há nada para iniciar.');
  return entries;
}

export class RefineSession {
  private running: Promise<void> | null = null;
  private abortCtl: AbortController | null = null;
  /** Set synchronously by `freeze()`, before any await, so a second concurrent `start` never slips
   *  through the window between freezing the spec and the run being marked started. */
  private starting = false;

  private constructor(
    private readonly deps: SessionDeps,
    private readonly journal: RefineJournal,
  ) {}

  static async open(deps: SessionDeps): Promise<RefineSession> {
    await fs.mkdir(deps.draft.root, { recursive: true });
    await fs.mkdir(deps.draft.docs, { recursive: true });
    await Promise.all([
      fs.access(deps.draft.stackMd).catch(() => fs.writeFile(deps.draft.stackMd, stackTemplate())),
      fs.access(deps.draft.flowMd).catch(() => fs.writeFile(deps.draft.flowMd, flowTemplate())),
      fs.access(deps.draft.designMd ?? `${deps.draft.docs}/design.md`).catch(() => fs.writeFile(deps.draft.designMd ?? `${deps.draft.docs}/design.md`, designTemplate())),
    ]);
    const journal = await RefineJournal.open(deps.draft.events, { projectId: deps.draft.projectId, specId: deps.draft.specId });
    // Spec §8: a cycle cut by a restart is failed, never resumed; nothing was charged as an attempt.
    if (journal.state.status === 'evaluating') await journal.fact(RefineEvent.CycleFailed, { cycle: journal.state.cycle, reason: 'interrupted' });
    // A crash between enabling backlog mode and moving the briefing: finish the move.
    if (journal.state.backlog?.enabled) await moveBriefingToProject(deps.draft);
    // A continued spec carries its JSON from main before any cycle has derived one.
    if (!journal.state.derived) journal.state.derived = await readDerived(deps.draft);
    return new RefineSession(deps, journal);
  }

  static async create(deps: SessionDeps, mode: 'new-project' | 'new-spec' | 'continue'): Promise<RefineSession> {
    const s = await RefineSession.open(deps);
    await s.journal.fact(RefineEvent.Created, { projectId: deps.draft.projectId, specId: deps.draft.specId, mode });
    return s;
  }

  get busy(): boolean {
    return this.running !== null;
  }
  get eventsFile(): string {
    return this.deps.draft.events;
  }
  get events(): readonly StoredEvent[] {
    return this.journal.events;
  }
  get state(): RefineState {
    return this.journal.state;
  }

  close(): Promise<void> {
    return this.journal.close();
  }

  private guard(): void {
    if (this.state.status === 'started') throw new ConflictError('session already started a run');
    if (this.starting) throw new ConflictError('a start is already in progress');
    if (this.busy) throw new ConflictError('evaluation in progress');
  }

  ensureCanEvaluate(): void {
    this.guard();
  }

  async snapshot(): Promise<Snapshot> {
    const docs = {
      'project.md': await readDoc(this.deps.draft, 'project.md'),
      'brief.md': await readDoc(this.deps.draft, 'brief.md'),
      'stack.md': await readDoc(this.deps.draft, 'stack.md'),
      'flow.md': await readDoc(this.deps.draft, 'flow.md'),
      'design.md': await readDoc(this.deps.draft, 'design.md'),
    } as Record<DocFile, string>;
    const present = await loadSecrets(this.deps.secretsDir);
    const names = [...new Set([...Object.keys(present), ...requiredSecretNames(this.state)])].sort();
    const secrets = names.map((name) => ({ name, present: name in present, hint: name in present ? '****' : null }));
    const tokens = { inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 };
    for (const e of this.journal.events) {
      if (e.type !== 'STEP_FINISHED') continue;
      const u = e.data.usage as { inputTokens: number; outputTokens: number } | undefined;
      tokens.steps += 1;
      tokens.inputTokens += u?.inputTokens ?? 0;
      tokens.outputTokens += u?.outputTokens ?? 0;
      tokens.costUsd += Number(e.data.costUsd ?? 0);
    }
    return { projectId: this.deps.draft.projectId, specId: this.deps.draft.specId, state: this.state, docs, secrets, tokens, busy: this.busy, seq: this.journal.events.at(-1)?.seq ?? 0 };
  }

  async saveDoc(file: DocFile, text: string): Promise<void> {
    this.guard();
    await writeDoc(this.deps.draft, file, text);
    await this.journal.fact(RefineEvent.DocEdited, { file, hash: sha256(text), source: 'human' });
  }

  /** "Sugerir": the agent's version of `file` written from flow.md; nothing is saved, the human reviews it in the editor. */
  async suggest(file: SuggestFile): Promise<string> {
    this.guard();
    const flowMd = await readDoc(this.deps.draft, 'flow.md');
    if (flowMd.trim() === '' || flowMd === flowTemplate()) throw new ConflictError('Preencha o flow.md antes de pedir uma sugestão.');
    const currentMd = await readDoc(this.deps.draft, file);
    const specHash = sha256(`${file}\n${flowMd}\n${currentMd}`);
    return this.runSuggest(SUGGEST_ROLE[file], fitPackBudget(suggestPack({ file, projectId: this.deps.draft.projectId, specHash, flowMd, currentMd })), specHash);
  }

  /** "Anexar imagem": the agent's design.md adjusted from template images; nothing is saved and the images are deleted after the step. */
  async suggestDesignFromImages(images: { data: string }[]): Promise<string> {
    this.guard();
    if (images.length < 1 || images.length > MAX_IMAGES) throw new RangeError(`envie de 1 a ${MAX_IMAGES} imagens`);
    const files = images.map((img) => {
      const bytes = Buffer.from(img.data, 'base64');
      const ext = bytes.subarray(0, 4).equals(PNG_MAGIC) ? 'png' : bytes.subarray(0, 3).equals(JPEG_MAGIC) ? 'jpg' : null;
      if (ext === null) throw new RangeError('só imagens png ou jpg');
      if (bytes.length > MAX_IMAGE_BYTES) throw new RangeError('cada imagem deve ter até 5 MB');
      return { bytes, ext };
    });
    const dir = path.posix.join(this.deps.draft.root, `.attach-${randomUUID()}`);
    try {
      await fs.mkdir(dir, { recursive: true });
      const imagePaths = files.map((f, i) => path.posix.join(dir, `${i + 1}.${f.ext}`));
      await Promise.all(files.map((f, i) => fs.writeFile(imagePaths[i]!, f.bytes)));
      const currentMd = await readDoc(this.deps.draft, 'design.md');
      const specHash = sha256(`design-images\n${currentMd}\n${files.map((f) => sha256(f.bytes.toString('base64'))).join()}`);
      return await this.runSuggest(SUGGEST_ROLE['design.md'], fitPackBudget(designFromImagesPack({ projectId: this.deps.draft.projectId, specHash, currentMd, imagePaths })), specHash);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  private async runSuggest(role: 'po' | 'sm', pack: ContextPackInput, specHash: string): Promise<string> {
    const out = (await this.deps.runAgent<'suggest'>(
      { kind: 'suggest', role, pack, cwd: this.deps.draft.root, phase: 'refine', taskId: null, attempt: 1 },
      { journal: this.journal, stepDir: this.deps.draft.steps, specHash },
    )) as StepOutcome<SuggestOutput>;
    if (!out.ok) throw new Error(`suggestion failed: ${out.failure}: ${out.errors.join('; ')}`);
    return out.value.text;
  }

  /** Backlog mode: the next evaluations break the docs into a prioritized backlog instead of deriving one spec, and the
   *  briefing becomes the target project's docs/briefing.md. */
  async enableBacklog(): Promise<void> {
    this.guard();
    if (this.state.backlog?.enabled) return;
    // Plan 90: the owner's earlier answers go into the brief before the move, which carries them, so a crash loses none.
    const answered = this.state.questions.filter((q) => q.status === 'answered' && q.answer && !q.answeredBy);
    if (answered.length > 0) {
      const after = answered.reduce((doc, q) => recordDecision(doc, q.text, q.answer!), await readDoc(this.deps.draft, 'brief.md'));
      await writeDoc(this.deps.draft, 'brief.md', after);
      await this.journal.fact(RefineEvent.DocEdited, { file: 'brief.md', hash: sha256(after), source: 'decision' });
    }
    // The move removes this draft's own spec.json (a continued spec's, on main): its criterion ids stay the numbering floor.
    await this.journal.fact(RefineEvent.BacklogEnabled, { acFloor: await maxCriterionInDraft(this.deps.draft), keyIds: true });
    await moveBriefingToProject(this.deps.draft);
  }

  /** Backlog detailing ("Detalhar specs"): from the next evaluation on, every item gets its spec and pre-plan. The human
   *  reviews the outline first, so only a ready outline can be detailed. */
  async enableDetail(): Promise<void> {
    this.guard();
    const backlog = this.state.backlog;
    if (backlog?.detail) return;
    // A stale outline is one the human has not seen yet: the next evaluation would re-derive and detail it in one go.
    if (!backlog?.enabled || backlog.items.length === 0 || this.state.status !== 'ready' || this.state.stale) {
      throw new ConflictError(`Detalhar specs pede um backlog avaliado e pronto: avalie até o esboço ficar pronto.${this.state.stale ? ' Os documentos mudaram depois da última avaliação.' : ''}`);
    }
    await this.journal.fact(RefineEvent.BacklogDetailEnabled, {});
  }

  async evaluate(): Promise<void> {
    this.ensureCanEvaluate();
    const cycle = this.state.cycle + 1;
    const ctl = (this.abortCtl = new AbortController());
    // Set at once, so no other action slips in while the floor is read.
    this.running = (async () => {
      const autoAnswerFloor = await this.deps.autoAnswerFloor?.();
      // Aborted while the floor was read: no cycle starts at all.
      if (ctl.signal.aborted) return;
      await runCycle(
        {
          signal: ctl.signal,
          draft: this.deps.draft,
          journal: this.journal,
          runAgent: this.deps.runAgent,
          frontAgent: this.deps.frontAgent,
          principles: () => this.state.derived?.project.principles ?? this.state.backlog?.project?.principles ?? [],
          retrieval: this.deps.retrieval,
          secretsDir: this.deps.secretsDir,
          validateDocs: this.deps.validateDocs,
          decider: this.deps.decider,
          autoAnswerFloor,
        },
        cycle,
      );
    })().finally(() => {
      this.running = null;
      this.abortCtl = null;
    });
    await this.running;
  }

  /** Kills the agent processes of a running evaluation and waits for the cycle to wind down. */
  async abort(): Promise<void> {
    this.abortCtl?.abort();
    await this.running?.catch(() => undefined);
  }

  private question(id: string) {
    const q = this.state.questions.find((x) => x.questionId === id);
    if (!q) throw new NotFoundError(`unknown question ${id}`);
    if (q.status !== 'pending') throw new ConflictError(`question ${id} already ${q.status}`);
    return q;
  }

  /** `docsAnswered`: the owner's mark that the documents already answered it, the label the routing eval reads. */
  async answer(questionId: string, text: string, docsAnswered = false): Promise<void> {
    this.guard();
    const q = this.question(questionId);
    // R11.10 (plan 90): a backlog reads the owner's answer from the briefing; written first, a retry rewrites the same heading.
    if (this.state.backlog?.enabled) {
      const after = recordDecision(await readDoc(this.deps.draft, 'brief.md'), q.text, text);
      await writeDoc(this.deps.draft, 'brief.md', after);
      await this.journal.fact(RefineEvent.DocEdited, { file: 'brief.md', hash: sha256(after), source: 'decision' });
    }
    await this.journal.fact(RefineEvent.QuestionAnswered, { questionId, text, ...(docsAnswered ? { docsAnswered: true } : {}) });
  }

  async skip(questionId: string): Promise<void> {
    this.guard();
    if (this.question(questionId).blocking) throw new ConflictError(`question ${questionId} is blocking and cannot be skipped`);
    await this.journal.fact(RefineEvent.QuestionSkipped, { questionId });
  }

  private patch(id: string) {
    const p = this.state.patches.find((x) => x.patchId === id);
    if (!p) throw new NotFoundError(`unknown patch ${id}`);
    if (p.status !== 'pending') throw new ConflictError(`patch ${id} already ${p.status}`);
    return p;
  }

  async accept(patchId: string): Promise<void> {
    this.guard();
    const p = this.patch(patchId);
    const before = await readDoc(this.deps.draft, p.file);
    const after = applyPatch(before, p);
    if (after === null) {
      await this.journal.fact(RefineEvent.PatchDropped, { patchId, reason: COVERED });
      throw new ConflictError(`Este ajuste (${patchId}) já foi coberto por outra alteração e foi descartado.`);
    }
    await writeDoc(this.deps.draft, p.file, after);
    await this.journal.fact(RefineEvent.DocEdited, { file: p.file, hash: sha256(after), source: 'patch' });
    await this.journal.fact(RefineEvent.PatchAccepted, { patchId });
    // PO and SM often propose overlapping edits: the ones this change made stale leave the list now, instead of failing on click.
    for (const other of this.state.patches) {
      if (other.status === 'pending' && other.file === p.file && applyPatch(after, other) === null) {
        await this.journal.fact(RefineEvent.PatchDropped, { patchId: other.patchId, reason: COVERED });
      }
    }
  }

  async reject(patchId: string, reason: string | null): Promise<void> {
    this.guard();
    this.patch(patchId);
    await this.journal.fact(RefineEvent.PatchRejected, { patchId, reason });
  }

  async writeSecret(name: string, value: string): Promise<void> {
    this.guard();
    if (!SECRET_NAME.test(name)) throw new NotFoundError(`invalid secret name ${name}`);
    await writeSecret(this.deps.secretsDir, name, value);
    await this.journal.fact(RefineEvent.SecretWritten, { name });
  }

  /** Before a start: `sync` brings in what main changed since this draft began; a changed project doc needs a new evaluation. */
  async syncWithMain(sync: () => Promise<Array<{ file: string; hash: string }>>): Promise<void> {
    this.guard();
    this.starting = true; // no evaluation reads the docs while main's changes come in
    try {
      const changed = await sync();
      for (const c of changed) await this.journal.fact(RefineEvent.DocEdited, { ...c, source: 'main' });
      if (changed.length > 0 && this.state.stale) {
        throw new ConflictError(`A main mudou desde o início deste refinamento (${changed.map((c) => c.file).join(', ')}): os documentos foram atualizados com essas mudanças. Avalie de novo para iniciar.`);
      }
    } finally {
      this.starting = false;
    }
  }

  /** Spec (refinement) §3.6 steps 1–2. */
  async freeze(): Promise<{ spec: Spec; project: Project }> {
    if (this.state.backlog?.enabled) throw new ConflictError('O início a partir do backlog ainda não está disponível: por enquanto o backlog serve para organizar e priorizar.');
    if (this.state.status === 'started') throw new ConflictError('session already started a run');
    if (this.starting) throw new ConflictError('a start is already in progress');
    if (this.running) await this.running;
    // Another freeze may have passed the same checks while this one awaited the running cycle.
    if (this.starting) throw new ConflictError('a start is already in progress');
    if (this.state.status !== 'ready' || this.state.stale) {
      throw new ConflictError(`session is ${this.state.status}${this.state.stale ? ' (stale)' : ''}; evaluate until ready`);
    }
    this.starting = true;
    try {
      const derived = this.state.derived!;
      // Every answer of this session travels with the frozen spec, also one given after the last evaluation (R11.7.1).
      const value = { project: derived.project, spec: freezeSpec(withDecisions(derived.spec, this.state.questions)) };
      await writeDerived(this.deps.draft, value);
      return value;
    } catch (err) {
      this.starting = false;
      throw err;
    }
  }

  /**
   * R11.4: the whole backlog is detailed, reviewed and ready, so the program may run it. Nothing is frozen here (each spec
   * freezes at its turn, `freezeItem`); this checks the gate, takes the `starting` lock and hands back the items in rank order.
   */
  async freezeProgram(): Promise<ProgramEntry[]> {
    if (!this.state.backlog?.enabled) throw new ConflictError('Esta sessão não está em modo backlog.');
    if (this.state.status === 'started') throw new ConflictError('session already started a run');
    if (this.starting) throw new ConflictError('a start is already in progress');
    if (this.running) await this.running;
    const backlog = this.state.backlog;
    // Each item's status on main, which the start's sync just brought into the base copy (R11.7.2).
    const specs = buildSpecsIndex(this.deps.draft.specId, backlog).specs;
    const onMain = Object.fromEntries(await Promise.all(specs.map(async (s) => [s.specId, (await readMainSpec(this.deps.draft, s.specId))?.status] as const)));
    if (this.starting) throw new ConflictError('a start is already in progress');
    if (!backlog.detail) throw new ConflictError('Detalhe as specs do backlog antes de iniciar: o início a partir do backlog usa as specs planejadas.');
    if (this.state.status !== 'ready' || this.state.stale) {
      throw new ConflictError(`session is ${this.state.status}${this.state.stale ? ' (stale)' : ''}; evaluate until ready`);
    }
    // Built before the start lock, so a refused start leaves the session free to try again.
    const entries = programEntries(this.deps.draft.specId, backlog, onMain);
    this.starting = true;
    return entries;
  }

  /** R11.4: freezes one planned item spec at its turn (specVersion+1, running, specHash) in the draft, where its run reads it. Idempotent. */
  async freezeItem(specId: string): Promise<Spec> {
    if (!this.state.backlog || !buildSpecsIndex(this.deps.draft.specId, this.state.backlog).specs.some((s) => s.specId === specId)) throw new NotFoundError(`${specId} is not a spec of this backlog`);
    const file = path.posix.join(this.deps.draft.docs, 'specs', specId, 'spec.json');
    const spec = Spec.parse(JSON.parse(await fs.readFile(file, 'utf8')));
    // A freeze whose run reached main stays; one a crash or a failed launch left behind is made again, so later answers reach it.
    const frozenBefore = spec.status === 'running' && spec.specHash !== null;
    if (frozenBefore && isStarted((await readMainSpec(this.deps.draft, specId))?.status)) return spec;
    // R11.7.5: main retired it while this backlog kept it, so the owner wants it again.
    const planned = frozenBefore ? { ...spec, status: 'planned' as const, specVersion: spec.specVersion - 1 } : spec.status === 'retired' ? { ...spec, status: 'planned' as const } : spec;
    // R11.7.6: the owner's answers about this spec's criteria travel with it to the delivery.
    const ids = new Set(spec.acceptanceCriteria.map((c) => c.id));
    const frozen = freezeSpec(withDecisions(planned, this.state.questions.filter((q) => q.relatedAcIds.some((id) => ids.has(id)))));
    await writeFileAtomic(file, `${JSON.stringify(frozen, null, 2)}
`);
    return frozen;
  }

  async markStarted(runId: string): Promise<void> {
    // R11.10: a suggestion still pending stays out of the run and moves to the history with the reason.
    for (const p of this.state.patches.filter((x) => x.status === 'pending')) {
      await this.journal.fact(RefineEvent.PatchDropped, { patchId: p.patchId, reason: 'não aplicada: a execução começou sem ela' });
    }
    await this.journal.fact(RefineEvent.StartedRun, { runId });
  }

  /** Records why the program did not start by itself in this cycle, for the screen and for the next tick. */
  async failAutoStart(reason: string): Promise<void> {
    await this.journal.fact(RefineEvent.AutoStartFailed, { cycle: this.journal.state.cycle, reason });
  }

  /** The spawned run died before writing its journal (e.g. a precondition failed); undo the `starting` lock so the session can retry. */
  failStart(): void {
    this.starting = false;
  }
}
