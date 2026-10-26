import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sha256 } from '../contracts/hash.js';
import type { SuggestOutput } from '../agents/outputs.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import type { StepOutcome } from '../runner/step.js';
import type { Project } from '../contracts/project.js';
import { freezeSpec, providedSecretNames, Spec, type ExternalDependency } from '../contracts/spec.js';
import { writeFileAtomic } from '../core/atomic-write.js';
import { OwnerError } from '../core/owner-error.js';
import { execCommand, type Exec } from '../exec/command.js';
import { loadSecrets, SECRET_NAME, writeSecret } from '../core/secrets.js';
import type { ProgramEntry } from '../program/controller.js';
import type { Hit } from '../knowledge/retrieval.js';
import type { Workspace } from '../orchestrator/workspace.js';
import { EventStore, type StoredEvent } from '../store/event-store.js';
import { isConfidential, recordScore, runCycle, type CycleDeps, type RunAgent } from './cycle.js';
import { DOC_STAGES } from './doc-stages.js';
import { reshapeBackup } from './reshape.js';
import { runStageCycle } from './stage-cycle.js';
import { scoresDocs } from './readiness.js';
import { decisionsSpan, recordDecision, withDecisions } from './decisions.js';
import { maxCriterionInDraft } from './detail-cycle.js';
import { designTemplate, flowTemplate, moveBriefingToProject, readDerived, readDoc, readMainSpec, stackTemplate, writeDerived, writeDoc, type DocFile, type Draft } from './draft.js';
import { DRAFT_HASH, RefineEvent } from './events.js';
import { applyPatch, COVERED_REASON } from './patches.js';
import { restoreMove } from './moves.js';
import { buildSpecsIndex } from './specs-index.js';
import { fitPackBudget } from './fit-pack.js';
import { ownerFailure, TRY_AGAIN } from './agent-failure.js';
import { DOC_FILES, designFromImagesPack, SUGGEST_ROLE, suggestPack, type SuggestFile } from './suggest.js';
import { allGreen, applyRefineEvent, canStart, emptyRefineState, speckitPending, type BacklogState, type RefineLimits, type RefineState } from './state.js';
import { refineLimits } from './limits.js';
import { isStarted } from './coverage.js';
import { answerUntriaged, prepareSpeckit, speckitInputHash, SPECKIT_STAGE } from './speckit.js';

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
  limits?: RefineLimits;
  draft: Draft;
  runAgent: RunAgent;
  frontAgent?: RunAgent;
  secretsDir: string;
  retrieval: (query: string) => readonly Hit[];
  validateDocs?: CycleDeps['validateDocs'];
  scoreDocs?: CycleDeps['scoreDocs'];
  decider?: CycleDeps['decider'];
  /** Read at each evaluation, so a floor set in the config reaches drafts already open. */
  autoAnswerFloor?: () => Promise<number | undefined>;
  /** Read at each preparation and each request, so the owner's setting applies to drafts already open. */
  speckitResearch?: () => Promise<boolean>;
  /** Runs `specify init` for the Spec Kit preparation; the real command when absent. */
  exec?: Exec;
  /** How many backlog items the Spec Kit preparation runs at once, read when it starts; one when absent. */
  speckitAgents?: () => Promise<number>;
}
/** The external dependencies the specs declare: every backlog spec, or the single derived spec while the backlog has none yet. */
export function declaredDependencies(state: RefineState): ExternalDependency[] {
  const backlogDependencies = Object.values(state.backlog?.specs ?? {}).flatMap((row) => row.spec?.externalDependencies ?? []);
  if (state.backlog?.enabled && backlogDependencies.length > 0) return backlogDependencies;
  return state.derived?.spec.externalDependencies ?? [];
}
/** The secrets the specs list as external dependencies, so the screen offers a field for each one that is missing. */
function requiredSecretNames(state: RefineState): string[] {
  return providedSecretNames(declaredDependencies(state));
}
/** The document sections (heading level) where a secret name appears, in document order. */
export function sectionsMentioning(docs: Readonly<Record<string, string>>, name: string): Array<{ doc: string; heading: string }> {
  const found: Array<{ doc: string; heading: string }> = [];
  for (const [doc, text] of Object.entries(docs)) {
    let heading = doc;
    for (const line of text.split('\n')) {
      const title = /^#{1,6}\s+(.*)$/.exec(line);
      if (title) heading = title[1]!.trim();
      else if (line.includes(name) && !found.some((f) => f.doc === doc && f.heading === heading)) found.push({ doc, heading });
    }
  }
  return found;
}
export interface SecretRow {
  name: string;
  present: boolean;
  hint: string | null;
  /** The dependencies that need this secret, with what each one is for. */
  uses: Array<{ dependency: string; purpose: string }>;
  /** The document sections that name this secret. */
  mentions: Array<{ doc: string; heading: string }>;
}
export interface Snapshot {
  projectId: string;
  specId: string;
  state: RefineState;
  docs: { 'project.md': string; 'briefing.md': string; 'stack.md': string; 'flow.md': string; 'design.md': string };
  secrets: SecretRow[];
  tokens: { inputTokens: number; outputTokens: number; costUsd: number; steps: number };
  /** True from the evaluate call on, even before the cycle journals that it started. */
  busy: boolean;
  /** The seq of the last event the state holds; the page applies only the events after it. */
  seq: number;
  limits: RefineLimits;
}

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

/** Cycles one click may spend: the documents, the backlog outline, the detail, and one more for what the detail left open. */
const MAX_CHAIN_CYCLES = 4;

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
    // A restart in a pause between two cycles of one click: its end would be the restart, so its record is void.
    if (journal.state.evaluation?.endedAt === null) await journal.fact(RefineEvent.EvaluationEnded, { interrupted: true });
    // A Spec Kit preparation cut by a restart is failed too; the owner runs it again.
    if (journal.state.speckit?.status === 'running') await journal.fact(RefineEvent.SpeckitFailed, { reason: 'A preparação foi interrompida quando o servidor reiniciou.' });
    // The answers of the PO and the SM cut by a restart end with it, so the page does not show them as running.
    if (journal.state.speckitAnswering) await journal.fact(RefineEvent.SpeckitAnswersDone, {});
    // A crash between enabling backlog mode and moving the briefing: finish the move.
    if (journal.state.backlog?.enabled) await moveBriefingToProject(deps.draft);
    // A continued spec carries its JSON from main before any cycle has derived one.
    if (!journal.state.derived) journal.state.derived = await readDerived(deps.draft);
    return new RefineSession(deps, journal);
  }

  static async create(deps: SessionDeps, mode: 'new-project' | 'new-spec' | 'continue' | 'backlog'): Promise<RefineSession> {
    const s = await RefineSession.open(deps);
    await s.journal.fact(RefineEvent.Created, { projectId: deps.draft.projectId, specId: deps.draft.specId, mode, stages: mode === 'new-project' });
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

  private guardStarting(): void {
    if (this.starting) throw new ConflictError('a start is already in progress');
  }

  private guard(): void {
    if (this.state.status === 'started') throw new ConflictError('session already started a run');
    this.guardStarting();
    if (this.busy) throw new ConflictError('Já tem uma avaliação em andamento. Aguarde ela terminar e tente de novo.');
  }

  ensureCanEvaluate(): void {
    this.guard();
  }

  async snapshot(): Promise<Snapshot> {
    const docs = {
      'project.md': await readDoc(this.deps.draft, 'project.md'),
      'briefing.md': await readDoc(this.deps.draft, 'briefing.md'),
      'stack.md': await readDoc(this.deps.draft, 'stack.md'),
      'flow.md': await readDoc(this.deps.draft, 'flow.md'),
      'design.md': await readDoc(this.deps.draft, 'design.md'),
    } as Record<DocFile, string>;
    const present = await loadSecrets(this.deps.secretsDir);
    const names = [...new Set([...Object.keys(present), ...requiredSecretNames(this.state)])].sort();
    const dependencies = declaredDependencies(this.state);
    const secrets = names.map((name) => ({
      name,
      present: name in present,
      hint: name in present ? '****' : null,
      uses: dependencies.filter((d) => d.secretNames.includes(name)).map((d) => ({ dependency: d.name, purpose: d.purpose })),
      mentions: sectionsMentioning(docs, name),
    }));
    const tokens = { inputTokens: 0, outputTokens: 0, costUsd: 0, steps: 0 };
    for (const e of this.journal.events) {
      if (e.type !== 'STEP_FINISHED') continue;
      const u = e.data.usage as { inputTokens: number; outputTokens: number } | undefined;
      tokens.steps += 1;
      tokens.inputTokens += u?.inputTokens ?? 0;
      tokens.outputTokens += u?.outputTokens ?? 0;
      tokens.costUsd += Number(e.data.costUsd ?? 0);
    }
    return { projectId: this.deps.draft.projectId, specId: this.deps.draft.specId, state: this.state, docs, secrets, tokens, busy: this.busy, seq: this.journal.events.at(-1)?.seq ?? 0, limits: this.limits() };
  }

  /** The rounds the current stage has used count against its limit. */
  private guardRounds(): void {
    const rounds = this.state.cycle - (this.state.stageStartCycle ?? 0);
    if (rounds >= this.limits().max) throw new ConflictError(`o refinamento já tem ${rounds} rodadas nesta etapa, o limite de ${this.limits().max}: revise os documentos e inicie a análise, ou ajuste TEAMS_AI_REFINE_MAX_ROUNDS`);
  }

  /** The first document whose stage the owner has not moved on from. */
  private currentStage(): DocFile | undefined {
    return DOC_STAGES.find((file) => !(this.state.doneStages ?? []).includes(file));
  }

  /** One review of a stage's document, the current one or any other: only that document changes. */
  evaluateStage(file: DocFile): Promise<void> {
    return this.startStage(file, false);
  }

  /** The review of a stage again, from the text the owner passed: the document goes back to it first. */
  reprocessStage(file: DocFile): Promise<void> {
    if (!(this.state.passedStages ?? []).includes(file)) throw new ConflictError(`não há texto entregue de ${file} para reprocessar`);
    return this.startStage(file, true);
  }

  private startStage(file: DocFile, restore: boolean): Promise<void> {
    this.ensureCanEvaluate();
    if (this.state.stages !== true) throw new ConflictError('só um refinamento de projeto novo tem etapas');
    this.guardRounds();
    const ctl = (this.abortCtl = new AbortController());
    const run = this.timedStage(ctl, file, restore).finally(() => {
      this.running = null;
      this.abortCtl = null;
    });
    this.running = run;
    return run;
  }

  /** Keeps the text passed to a stage the first time it is processed; a reprocess puts that text back in the document. */
  private async keepPassedText(file: DocFile, restore: boolean): Promise<void> {
    const kept = path.posix.join(this.deps.draft.root, 'passed', file);
    if (restore) {
      const text = await fs.readFile(kept, 'utf8');
      await writeDoc(this.deps.draft, file, text);
      await this.journal.fact(RefineEvent.DocEdited, { file, hash: sha256(text), source: 'human' });
      return;
    }
    if ((this.state.passedStages ?? []).includes(file)) return;
    const text = await readDoc(this.deps.draft, file);
    await fs.mkdir(path.posix.dirname(kept), { recursive: true });
    await fs.writeFile(kept, text);
    await this.journal.fact(RefineEvent.StagePassed, { file, hash: sha256(text) });
  }

  private async timedStage(ctl: AbortController, file: DocFile, restore: boolean): Promise<void> {
    await this.journal.fact(RefineEvent.EvaluationStarted, {});
    try {
      await this.keepPassedText(file, restore);
      const deps = { draft: this.deps.draft, journal: this.journal, runAgent: this.deps.runAgent, frontAgent: this.deps.frontAgent, validateDocs: this.deps.validateDocs, principles: () => this.state.derived?.project.principles ?? [], signal: ctl.signal };
      await runStageCycle(deps, this.state.cycle + 1, file);
    } finally {
      await this.journal.fact(RefineEvent.EvaluationEnded, {});
    }
  }

  /** The owner moves on from a document's stage, the named one or else the current one; the rounds of the next stage count from here. */
  async continueStage(doc?: DocFile): Promise<void> {
    this.guard();
    if (this.state.stages !== true) throw new ConflictError('só um refinamento de projeto novo tem etapas');
    const target = doc ?? this.currentStage();
    if (!target) throw new ConflictError('todas as etapas já foram concluídas');
    if (!DOC_STAGES.includes(target)) throw new ConflictError(`${target} não é uma etapa do refinamento`);
    if ((this.state.doneStages ?? []).includes(target)) throw new ConflictError(`a etapa ${target} já foi concluída`);
    await this.journal.fact(RefineEvent.StageAdvanced, { doc: target, cycle: this.state.cycle });
  }

  /** The owner moves on from the final review to the backlog; the review then shows as done. */
  async closeReview(): Promise<void> {
    this.guard();
    if (this.state.stages !== true) throw new ConflictError('só um refinamento de projeto novo tem etapas');
    if (this.state.reviewClosed) throw new ConflictError('a revisão já foi concluída');
    await this.journal.fact(RefineEvent.ReviewClosed, {});
  }

  /** The owner's answer on confidentiality; a stage session sends no document to the Jev until it comes. */
  async answerConfidentiality(confidential: boolean): Promise<void> {
    this.guard();
    await this.journal.fact(RefineEvent.ConfidentialityAnswered, { confidential });
  }

  async saveDoc(file: DocFile, text: string): Promise<void> {
    this.guard();
    const saved = file === 'briefing.md' ? await this.keepDecisions(text) : text;
    await writeDoc(this.deps.draft, file, saved);
    await this.journal.fact(RefineEvent.DocEdited, { file, hash: sha256(saved), source: 'human' });
  }

  /** The briefing's `## Decisões` section stays when a save leaves it out, so an answered question is never lost by an edit. */
  private async keepDecisions(text: string): Promise<string> {
    if (decisionsSpan(text)) return text;
    const current = await readDoc(this.deps.draft, 'briefing.md');
    const span = decisionsSpan(current);
    return span ? `${text.trimEnd()}\n\n${current.slice(span.start, span.end).trim()}\n` : text;
  }

  /** "Sugerir": the agent's version of `file` written from flow.md; nothing is saved, the human reviews it in the editor. */
  async suggest(file: SuggestFile): Promise<string> {
    this.guard();
    const docs = Object.fromEntries(await Promise.all(DOC_FILES.map(async (f) => [f, await readDoc(this.deps.draft, f)]))) as Record<DocFile, string>;
    if (docs['flow.md'].trim() === '' || docs['flow.md'] === flowTemplate()) throw new ConflictError('Preencha o flow.md antes de pedir uma sugestão.');
    const specHash = sha256(`${file}\n${DOC_FILES.map((f) => docs[f]).join('\n')}`);
    return this.runSuggest(SUGGEST_ROLE[file], fitPackBudget(suggestPack({ file, projectId: this.deps.draft.projectId, specHash, docs, earlierOnly: this.state.stages === true })), specHash);
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
    if (!out.ok) throw ownerFailure('A sugestão do documento', out.failure, out.errors, TRY_AGAIN);
    return out.value.text;
  }

  /** Backlog mode: the next evaluations break the docs into a prioritized backlog instead of deriving one spec, and the
   *  briefing becomes the target project's docs/briefing.md. */
  async enableBacklog(): Promise<void> {
    this.guard();
    await this.enableBacklogStep();
  }

  private async enableBacklogStep(): Promise<void> {
    if (this.state.backlog?.enabled) return;
    // Plan 90: the owner's earlier answers go into the brief before the move, which carries them, so a crash loses none.
    const answered = this.state.questions.filter((q) => q.status === 'answered' && q.answer && !q.answeredBy);
    if (answered.length > 0) {
      const after = answered.reduce((doc, q) => recordDecision(doc, q.text, q.answer!, q.subject), await readDoc(this.deps.draft, 'briefing.md'));
      await writeDoc(this.deps.draft, 'briefing.md', after);
      await this.journal.fact(RefineEvent.DocEdited, { file: 'briefing.md', hash: sha256(after), source: 'decision' });
    }
    // The move removes this draft's own spec.json (a continued spec's, on main): its criterion ids stay the numbering floor.
    await this.journal.fact(RefineEvent.BacklogEnabled, { acFloor: await maxCriterionInDraft(this.deps.draft), keyIds: true });
    // The detailing is part of the one process: every evaluation of the backlog details its changed items.
    await this.journal.fact(RefineEvent.BacklogDetailEnabled, {});
    await moveBriefingToProject(this.deps.draft);
  }

  /** "Preparar Spec Kit": the constitution, and a spec, plan and tasks for each item of the detailed backlog. */
  runSpeckit(): Promise<void> {
    this.guard();
    const backlog = this.state.backlog;
    if (!backlog?.enabled || !backlog.detail || backlog.items.length === 0 || backlog.items.some((i) => !backlog.specs?.[i.key]?.spec)) {
      throw new ConflictError('Detalhe o backlog antes de preparar o Spec Kit: cada item precisa da sua spec.');
    }
    const ctl = (this.abortCtl = new AbortController());
    const run = this.timedSpeckit(ctl, backlog).finally(() => {
      this.running = null;
      this.abortCtl = null;
    });
    this.running = run;
    return run;
  }

  /** "Pedir ao PO e ao SM": the PO and the SM answer the Spec Kit questions nobody has read yet; a new answer leaves the preparation stale. */
  askSpeckitAnswers(): Promise<void> {
    this.guard();
    const backlog = this.state.backlog;
    if (!backlog) return Promise.resolve();
    const ctl = (this.abortCtl = new AbortController());
    const run = this.timedAnswers(ctl, backlog).finally(() => {
      this.running = null;
      this.abortCtl = null;
    });
    this.running = run;
    return run;
  }

  /** The journal keeps the start and the end of the answers, so the page shows them while they run. */
  private async timedAnswers(ctl: AbortController, backlog: BacklogState): Promise<void> {
    await this.journal.fact(RefineEvent.SpeckitAnswersStarted, {});
    try {
      const answered = await answerUntriaged({ draft: this.deps.draft, journal: this.journal, runAgent: this.deps.runAgent, signal: ctl.signal, research: (await this.deps.speckitResearch?.()) === true }, backlog);
      if (answered > 0 && this.state.speckit) await this.journal.fact(RefineEvent.SpeckitStale, {});
    } finally {
      await this.journal.fact(RefineEvent.SpeckitAnswersDone, {});
    }
  }

  /** The journal keeps the preparation's start, each step and its end; a failure is journaled for the owner, never thrown. */
  private async timedSpeckit(ctl: AbortController, backlog: BacklogState): Promise<void> {
    try {
      const agents = (await this.deps.speckitAgents?.()) ?? 1;
      const hash = await prepareSpeckit({ draft: this.deps.draft, journal: this.journal, runAgent: this.deps.runAgent, exec: this.deps.exec ?? execCommand, decider: this.deps.decider, signal: ctl.signal, agents, research: (await this.deps.speckitResearch?.()) === true }, backlog);
      await this.journal.fact(RefineEvent.SpeckitDone, { inputHash: hash });
    } catch (err) {
      const reason = err instanceof OwnerError ? err.message : `${SPECKIT_STAGE} parou por um erro interno. ${TRY_AGAIN}`;
      const detail = err instanceof OwnerError ? err.detail : String(err instanceof Error ? err.message : err).slice(0, 1000);
      await this.journal.fact(RefineEvent.SpeckitFailed, { reason, detail });
    }
  }

  async evaluate(): Promise<void> {
    this.ensureCanEvaluate();
    this.guardRounds();
    const ctl = (this.abortCtl = new AbortController());
    // Set at once, so no other action slips in while the floor is read.
    this.running = this.timedChain(ctl).finally(() => {
      this.running = null;
      this.abortCtl = null;
    });
    await this.running;
  }

  /** One click from its start to its end: the journal keeps the time, and the page counts from the start. */
  private async timedChain(ctl: AbortController): Promise<void> {
    await this.journal.fact(RefineEvent.EvaluationStarted, {});
    try {
      await this.evaluateChain(ctl);
    } finally {
      await this.journal.fact(RefineEvent.EvaluationEnded, {});
    }
  }

  /** One evaluation cycle; the caller holds the lock, since `running` is set before this runs. */
  private async cycleOnce(ctl: AbortController): Promise<void> {
    const cycle = this.state.cycle + 1;
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
        validateDocs: this.deps.validateDocs,
        scoreDocs: this.deps.scoreDocs,
        decider: this.deps.decider,
        autoAnswerFloor,
      },
      cycle,
    );
  }

  /**
   * One click: cycles until the owner has to act, or the documents and the backlog are complete, or the cap is reached. A new
   * project carries on from ready documents into its backlog; a spec on main or a continuation runs one cycle, as before.
   */
  private async evaluateChain(ctl: AbortController): Promise<void> {
    // A draft from before the detailing was part of every evaluation: its backlog is detailed from this one on.
    if (this.state.backlog?.enabled && !this.state.backlog.detail) await this.journal.fact(RefineEvent.BacklogDetailEnabled, {});
    for (let n = 0; n < MAX_CHAIN_CYCLES && !ctl.signal.aborted; n++) {
      await this.cycleOnce(ctl);
      const { status, stale, backlog, mode } = this.state;
      // A question or an error needs the owner; the next click resumes from the journal.
      if (status === 'error' || status === 'answering') return;
      if (mode !== 'new-project' && mode !== 'backlog') return;
      // The documents changed during the cycle, so they are evaluated again.
      if (stale) continue;
      if (status === 'ready') {
        if (backlog?.enabled) return;
        await this.enableBacklogStep();
        continue;
      }
      // Drafting: a failing check or an open item is the owner's to act on; only a green documents set with an unfinished backlog goes on.
      const open = this.state.patches.some((p) => p.status === 'pending') || this.state.questions.some((q) => q.status === 'pending');
      if (!backlog?.enabled || open || !allGreen(this.state.checklist)) return;
    }
  }

  /** The Jev's score of the documents as they stand: no agent step and no round, so the screen can ask for it at any time. */
  async score(file?: DocFile): Promise<void> {
    this.guard();
    const scoreDocs = this.deps.scoreDocs;
    if (!scoreDocs || !scoresDocs(this.state.mode)) throw new ConflictError('A nota do Jev vale só para o refinamento de um projeto novo ou de um backlog.');
    const scored = { draft: this.deps.draft, journal: this.journal, scoreDocs };
    const cycle = this.state.cycle;
    this.running = (async () => recordScore(scored, cycle, await isConfidential(scored.draft, this.state), file ? [file] : undefined))().finally(() => {
      this.running = null;
    });
    await this.running;
  }

  /** Kills the agent processes of a running evaluation and waits for the cycle to wind down. */
  async abort(): Promise<void> {
    this.abortCtl?.abort();
    await this.running?.catch(() => undefined);
  }

  /** The question a reply is for: pending, or answered by the PO or the SM, which the owner may replace when `replaceAgent` says so. */
  private question(id: string, replaceAgent = false) {
    const q = this.state.questions.find((x) => x.questionId === id);
    if (!q) throw new NotFoundError(`unknown question ${id}`);
    const replaceable = replaceAgent && q.status === 'answered' && Boolean(q.answeredBy);
    if (q.status !== 'pending' && !replaceable) throw new ConflictError(`question ${id} already ${q.status}`);
    return q;
  }

  /** `docsAnswered`: the owner's mark that the documents already answered it, the label the routing eval reads. */
  async answer(questionId: string, text: string, docsAnswered = false): Promise<void> {
    this.guard();
    const q = this.question(questionId, true);
    // R11.10 (plan 90): a backlog reads the owner's answer from the briefing; written first, a retry rewrites the same heading.
    if (this.state.backlog?.enabled) {
      const after = recordDecision(await readDoc(this.deps.draft, 'briefing.md'), q.text, text, q.subject);
      await writeDoc(this.deps.draft, 'briefing.md', after);
      await this.journal.fact(RefineEvent.DocEdited, { file: 'briefing.md', hash: sha256(after), source: 'decision' });
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
      await this.journal.fact(RefineEvent.PatchDropped, { patchId, reason: COVERED_REASON });
      throw new ConflictError(`Este ajuste (${patchId}) já foi coberto por outra alteração e foi descartado.`);
    }
    await writeDoc(this.deps.draft, p.file, after);
    await this.journal.fact(RefineEvent.DocEdited, { file: p.file, hash: sha256(after), source: 'patch' });
    await this.journal.fact(RefineEvent.PatchAccepted, { patchId });
    // PO and SM often propose overlapping edits: the ones this change made stale leave the list now, instead of failing on click.
    for (const other of this.state.patches) {
      if (other.status === 'pending' && other.file === p.file && applyPatch(after, other) === null) {
        await this.journal.fact(RefineEvent.PatchDropped, { patchId: other.patchId, reason: COVERED_REASON });
      }
    }
  }

  async reject(patchId: string, reason: string | null): Promise<void> {
    this.guard();
    this.patch(patchId);
    await this.journal.fact(RefineEvent.PatchRejected, { patchId, reason });
  }

  /** Puts back the two documents a move changed, when neither has changed since the move. */
  async undoMove(moveId: string): Promise<void> {
    this.guard();
    const row = this.state.moves.find((m) => m.moveId === moveId);
    if (!row) throw new NotFoundError(`unknown move ${moveId}`);
    if (row.status !== 'applied') throw new ConflictError(`move ${moveId} already undone`);
    const restored = restoreMove(row, await readDoc(this.deps.draft, row.from), await readDoc(this.deps.draft, row.to));
    if (!restored) throw new ConflictError('Esta movimentação não pode ser desfeita: um dos documentos mudou depois dela.');
    await writeDoc(this.deps.draft, row.from, restored.from);
    await writeDoc(this.deps.draft, row.to, restored.to);
    await this.journal.fact(RefineEvent.DocEdited, { file: row.from, hash: sha256(restored.from), source: 'undo' });
    await this.journal.fact(RefineEvent.DocEdited, { file: row.to, hash: sha256(restored.to), source: 'undo' });
    await this.journal.fact(RefineEvent.DocMoveUndone, { moveId });
  }

  /** Puts back the text a reshape replaced, when the document has not changed since. */
  async undoReshape(reshapeId: string): Promise<void> {
    this.guard();
    const row = this.state.reshapes.find((r) => r.reshapeId === reshapeId);
    if (!row) throw new NotFoundError(`unknown reshape ${reshapeId}`);
    if (row.status !== 'applied') throw new ConflictError(`reshape ${reshapeId} already undone`);
    if (sha256(await readDoc(this.deps.draft, row.file)) !== row.afterHash) throw new ConflictError('Esta reorganização não pode ser desfeita: o arquivo mudou depois dela.');
    const before = await fs.readFile(reshapeBackup(this.deps.draft, reshapeId), 'utf8');
    await writeDoc(this.deps.draft, row.file, before);
    await this.journal.fact(RefineEvent.DocEdited, { file: row.file, hash: sha256(await readDoc(this.deps.draft, row.file)), source: 'undo' });
    await this.journal.fact(RefineEvent.DocReshapeUndone, { reshapeId });
  }

  /** Hides the notice of a move or a reshape for good; the change itself stays. */
  async closeNotice(noticeId: string): Promise<void> {
    const known = this.state.moves.some((m) => m.moveId === noticeId) || this.state.reshapes.some((r) => r.reshapeId === noticeId);
    if (!known) throw new NotFoundError(`unknown notice ${noticeId}`);
    await this.journal.fact(RefineEvent.NoticeClosed, { noticeId });
  }

  async writeSecret(name: string, value: string): Promise<void> {
    this.guardStarting();
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

  private limits(): RefineLimits {
    return this.deps.limits ?? refineLimits();
  }

  /** Spec (refinement) §3.6 steps 1–2. */
  async freeze(): Promise<{ spec: Spec; project: Project }> {
    if (this.state.backlog?.enabled) throw new ConflictError('O início a partir do backlog ainda não está disponível: por enquanto o backlog serve para organizar e priorizar.');
    if (this.state.status === 'started') throw new ConflictError('session already started a run');
    if (this.starting) throw new ConflictError('a start is already in progress');
    if (this.running) await this.running;
    // Another freeze may have passed the same checks while this one awaited the running cycle.
    if (this.starting) throw new ConflictError('a start is already in progress');
    if (!canStart(this.state)) throw new ConflictError(`session cannot start now (${this.state.status})`);
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
    const inputHash = await speckitInputHash(this.deps.draft, backlog);
    if (this.starting) throw new ConflictError('a start is already in progress');
    if (!backlog.detail) throw new ConflictError('Detalhe as specs do backlog antes de iniciar: o início a partir do backlog usa as specs planejadas.');
    // A running evaluation is the reason that comes first; the Spec Kit preparation is the next.
    if (this.state.status !== 'evaluating' && speckitPending(this.state, inputHash)) throw new ConflictError('Prepare o Spec Kit antes de iniciar: a preparação ainda não foi feita, falhou, os documentos mudaram depois dela ou há uma pergunta obrigatória dela sem resposta.');
    if (!canStart(this.state)) throw new ConflictError(`session cannot start now (${this.state.status})`);
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

  /** The spawned run died before writing its journal (e.g. a precondition failed); undo the `starting` lock so the session can retry. */
  failStart(): void {
    this.starting = false;
  }
}
