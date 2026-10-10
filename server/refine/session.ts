import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sha256 } from '../contracts/hash.js';
import type { Project } from '../contracts/project.js';
import { freezeSpec, Spec } from '../contracts/spec.js';
import { writeFileAtomic } from '../core/atomic-write.js';
import { loadSecrets, SECRET_NAME, writeSecret } from '../core/secrets.js';
import type { ProgramEntry } from '../program/controller.js';
import type { Hit } from '../knowledge/retrieval.js';
import type { Workspace } from '../orchestrator/workspace.js';
import { EventStore, type StoredEvent } from '../store/event-store.js';
import { runCycle, type CycleDeps, type RunAgent } from './cycle.js';
import { maxCriterionInDraft } from './detail-cycle.js';
import { designTemplate, flowTemplate, moveBriefingToProject, readDerived, readDoc, stackTemplate, writeDerived, writeDoc, type DocFile, type Draft } from './draft.js';
import { DRAFT_HASH, RefineEvent } from './events.js';
import { applyPatch } from './patches.js';
import { buildSpecsIndex } from './specs-index.js';
import { applyRefineEvent, emptyRefineState, type RefineState } from './state.js';

export type { RunAgent } from './cycle.js';
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
}

const COVERED = 'Este ajuste já foi coberto por outra alteração e foi descartado.';

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
    const names = Object.keys(present).sort();
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
    return { projectId: this.deps.draft.projectId, specId: this.deps.draft.specId, state: this.state, docs, secrets, tokens, busy: this.busy };
  }

  async saveDoc(file: DocFile, text: string): Promise<void> {
    this.guard();
    await writeDoc(this.deps.draft, file, text);
    await this.journal.fact(RefineEvent.DocEdited, { file, hash: sha256(text), source: 'human' });
  }

  /** Backlog mode: the next evaluations break the docs into a prioritized backlog instead of deriving one spec, and the
   *  briefing becomes the target project's docs/briefing.md. */
  async enableBacklog(): Promise<void> {
    this.guard();
    if (this.state.backlog?.enabled) return;
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
    this.running = runCycle(
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
      },
      cycle,
    ).finally(() => {
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

  async answer(questionId: string, text: string): Promise<void> {
    this.guard();
    this.question(questionId);
    await this.journal.fact(RefineEvent.QuestionAnswered, { questionId, text });
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
      const value = { project: derived.project, spec: freezeSpec(derived.spec) };
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
    const backlog = this.state.backlog;
    if (!backlog?.enabled) throw new ConflictError('Esta sessão não está em modo backlog.');
    if (this.state.status === 'started') throw new ConflictError('session already started a run');
    if (this.starting) throw new ConflictError('a start is already in progress');
    if (this.running) await this.running;
    if (this.starting) throw new ConflictError('a start is already in progress');
    if (!backlog.detail) throw new ConflictError('Detalhe as specs do backlog antes de iniciar: o início a partir do backlog usa as specs planejadas.');
    if (this.state.status !== 'ready' || this.state.stale) {
      throw new ConflictError(`session is ${this.state.status}${this.state.stale ? ' (stale)' : ''}; evaluate until ready`);
    }
    this.starting = true;
    return buildSpecsIndex(this.deps.draft.specId, backlog).specs.map((s) => ({ specId: s.specId, key: s.key, rank: s.rank, dependsOn: s.dependsOn }));
  }

  /** R11.4: freezes one planned item spec at its turn (specVersion+1, running, specHash) in the draft, where its run reads it. Idempotent. */
  async freezeItem(specId: string): Promise<Spec> {
    if (!this.state.backlog || !buildSpecsIndex(this.deps.draft.specId, this.state.backlog).specs.some((s) => s.specId === specId)) throw new NotFoundError(`${specId} is not a spec of this backlog`);
    const file = path.posix.join(this.deps.draft.docs, 'specs', specId, 'spec.json');
    const spec = Spec.parse(JSON.parse(await fs.readFile(file, 'utf8')));
    // A crash after the freeze and before the launch leaves it frozen: the second attempt keeps that freeze.
    if (spec.status === 'running' && spec.specHash) return spec;
    const frozen = freezeSpec(spec);
    await writeFileAtomic(file, `${JSON.stringify(frozen, null, 2)}
`);
    return frozen;
  }

  async markStarted(runId: string): Promise<void> {
    await this.journal.fact(RefineEvent.StartedRun, { runId });
  }

  /** The spawned run died before writing its journal (e.g. a precondition failed); undo the `starting` lock so the session can retry. */
  failStart(): void {
    this.starting = false;
  }
}
