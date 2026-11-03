import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import { assumptionBullets } from './plan-shape.js';
import { planFileOf } from './plan-file.js';
import type { ArchitectureOutput, SpecsReviewOutput, SuggestOutput } from '../agents/outputs.js';
import { Architecture } from '../contracts/architecture.js';
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
import { documentCounts } from '../knowledge/doc-graph.js';
import { isConfidential, recordScore, runCycle, type CycleDeps, type RunAgent } from './cycle.js';
import { DOC_STAGES, stageBlocked, stageReviewBlock } from './doc-stages.js';
import { reshapeBackup } from './reshape.js';
import { NOT_APPLICABLE_DESIGN } from './not-applicable.js';
import { lastReviewKeyOf, runStageCycle } from './stage-cycle.js';
import { PASS_LINE, percentOf, scoresDocs } from './readiness.js';
import { decisionsSpan, recordDecision, withDecisions } from './decisions.js';
import { maxCriterionInDraft } from './detail-cycle.js';
import { designTemplate, flowTemplate, MainConflict, moveBriefingToProject, readBase, readDerived, readDoc, readMainSpec, readSpecsMd, stackTemplate, writeDerived, writeDoc, writeSpecsMd, type DocFile, type Draft } from './draft.js';
import { currentEvent, DRAFT_HASH, RefineEvent, type Question } from './events.js';
import { architecturePack, checkDecision, docsHashOf, RulesOpenError, writeArchitectureFiles } from './architecture-step.js';
import { applyPatch, COVERED_REASON } from './patches.js';
import { restoreMove } from './moves.js';
import { buildSpecsIndex } from './specs-index.js';
import { fitPackBudget } from './fit-pack.js';
import { ownerFailure, TRY_AGAIN } from './agent-failure.js';
import { DOC_FILES, designFromImagesPack, SUGGEST_ROLE, suggestPack, type SuggestFile } from './suggest.js';
import { allGreen, applyRefineEvent, canStart, closingChecks, emptyRefineState, newestReshape, safePatches, speckitPending, type BacklogState, type ClosingCheck, type RefineLimits, type RefineState, type SpecsVerdict } from './state.js';
import { renderSpecsMd } from './specs-md.js';
import { SPECS_REVIEWERS, specsReviewPack, type SpecsReviewer } from './specs-review.js';
import { refineLimits } from './limits.js';
import { isStarted } from './coverage.js';
import { preparePlans } from './plan-prepare.js';
import { PREPARATION_STAGE, PreparationFailed, planInputHash, stopKindOf } from './plan-inputs.js';
import { healRunsOf, type HealView } from './heal.js';
import { flowIsMermaid } from './sections.js';
import { bindDocumentRepo, DocsBindRefused, styleRefusal } from './docs-bind.js';
import { viewerLogin } from '../git/github.js';
import { DocsStoreError, holdsConflictMarkers, openStore, readStoreText } from '../docs/store.js';
import { readDocsMarker } from '../docs/project-state.js';
import { docsTarget, FIVE_DOCS, githubOwnerOf, type RepoTarget, type Style } from '../docs/layout.js';
import { mergeDocStrict, sameDoc } from '../git/merge-doc.js';
import { boundaryLabel } from './docs-boundary.js';
import { DocsSync, type DocsSyncView } from './docs-sync.js';
import type { SpecAlias } from './docs-projection.js';

export type { RunAgent } from './cycle.js';
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
/** The rollout switches new projects onto the repository flow (plan increment K); until then a session is created without the stamp. */
export const REPOSITORY_FLOW = true;

export class ConflictError extends Error {}
/** The draft is held by a run, a start or a discard: the caller tries again later. */
export class BusyError extends ConflictError {}
export class NotFoundError extends Error {}

/** Single-writer journal of one refinement session, reduced into RefineState as it is appended. */
export class RefineJournal {
  readonly state: RefineState = emptyRefineState();
  /** Called after each live fact is applied; a replay never calls it, and a failure here never fails the fact. */
  onFact?: (e: StoredEvent) => void;
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
    return new RefineJournal(store, (await store.readAll()).map(currentEvent));
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
    this.notify(stored);
    return stored;
  }

  private notify(stored: StoredEvent): void {
    try {
      this.onFact?.(stored);
    } catch {
      // The fact is already journaled; the hook's failure stays with the hook.
    }
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
  /** How many backlog items the plan preparation runs at once, read when it starts; one when absent. */
  speckitAgents?: () => Promise<number>;
  /** Extracts the documents of `dir` into the graph folder `outDir`; required by a repository session, which adds each stage to the graph. */
  extractDocs?: (dir: string, outDir: string) => Promise<void>;
  /** The part of the document graph in `outDir` that answers a question, for the packs; empty when the graph has nothing. */
  docGraphContext?: (outDir: string, question: string, budgetTokens: number) => Promise<string>;
  /** Binds the documentation repository at the Backlog step: the git and gh exec with the token, and the configured owner. */
  docsBind?: { exec: Exec; configuredOwner: () => Promise<string | undefined> };
}
/** The external dependencies the specs declare: every backlog spec, or the single derived spec while the backlog has none yet. */
export function declaredDependencies(state: RefineState): ExternalDependency[] {
  const backlogDependencies = Object.values(state.backlog?.specs ?? {}).flatMap((row) => row.spec?.externalDependencies ?? []);
  if (state.backlog?.enabled && backlogDependencies.length > 0) return backlogDependencies;
  return state.derived?.spec.externalDependencies ?? [];
}
/** The secrets the specs list as external dependencies, so the screen offers a field for each one that is missing. */
export function requiredSecretNames(state: RefineState): string[] {
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
  /** The sha256 of each document as it is on disk: a save states the one its text was typed over. */
  hashes: Record<DocFile, string>;
  secrets: SecretRow[];
  tokens: { inputTokens: number; outputTokens: number; costUsd: number; steps: number };
  /** True from the evaluate call on, even before the cycle journals that it started. */
  busy: boolean;
  /** True when the architecture was decided on documents that have changed since. */
  architectureStale: boolean;
  /** True when the session has the documentation-repository stamp; absent for a legacy session. */
  docsRepo?: true;
  /** The repository the backlog step creates, once the architecture is decided; absent for a legacy session. */
  docsTarget?: RepoTarget;
  /** The documentation repository sync, in memory only: absent for a session that is not one. */
  docsSync?: DocsSyncView;
  /** The closing summary of a repository session; absent for other sessions. */
  closing?: ClosingSummary;
  /** Why each stage document cannot be continued as it is in format, in plain words; null when it can. */
  stageProblems: Record<DocFile, string | null>;
  /** The seq of the last event the state holds; the page applies only the events after it. */
  seq: number;
  limits: RefineLimits;
  /** specs.md is written from the current backlog and PO and SM both approved it: the final review may go on. */
  specsApproved: boolean;
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
/** Whether a finding names a backlog item by its key, not as a piece of a longer key. */
export function namesItem(text: string, key: string): boolean {
  for (let at = text.indexOf(key); at !== -1; at = text.indexOf(key, at + 1)) {
    const before = text[at - 1];
    const after = text[at + key.length];
    if (!/[\w-]/.test(before ?? ' ') && !/[\w-]/.test(after ?? ' ')) return true;
  }
  return false;
}

/** The automatic repairs of a rejected specs.md before the owner is asked. */
const MAX_SPECS_REPAIRS = 2;
const MAX_CHAIN_CYCLES = 4;

/** What the architecture pack asks the graph for: the system's repositories and the links between them. */
const ARCHITECTURE_QUESTION = 'repositories of the system, their responsibilities and the integrations between them';
const GRAPH_CONTEXT_TOKENS = 4_000;

/** What the owner reads before starting a repository session; its hash is what the owner authorizes. */
export interface ClosingSummary {
  ok: boolean;
  checks: ClosingCheck[];
  repositories: Array<{ name: string; specs: number; plans: number; tasks: number }>;
  assumptions: string[];
  summaryHash: string;
}

/** The verdict approves the text with this hash. */
const approvedAt = (v: SpecsVerdict | undefined, hash: string): boolean => v?.specsHash === hash && v.verdict === 'approved';

export class RefineSession {
  private running: Promise<void> | null = null;
  private abortCtl: AbortController | null = null;
  private queuedReview: Promise<void> | null = null;
  /** A graph extraction is the only thing running: the owner's answers and rejections do not wait for it, since they edit no document. */
  private indexing = false;
  private readonly changedWhileIndexing = new Set<DocFile>();
  /** The documents whose low score already got its one extra review. */
  private readonly improved = new Set<DocFile>();
  /** Set by `beginStart()` before any await, and cleared by `markStarted()` or `failStart()`. */
  private starting = false;
  /** Set while `syncWithMain` brings main's changes in: no start or evaluation reads the docs meanwhile. */
  private syncing = false;
  /** Set when the owner throws the draft away: no run starts on it after that. */
  private discarding = false;
  /** The Backlog step in flight: a second call awaits it, so the repository is bound and the backlog enabled once. */
  private binding: Promise<void> | null = null;
  /** The documentation repository flush; set once the store is bound, and absent for every other session. */
  private docs: DocsSync | null = null;

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
    if (journal.state.status === 'evaluating') await journal.fact(RefineEvent.CycleFailed, { cycle: journal.state.cycle, reason: 'interrupted', kind: 'interrupted' });
    // A restart in a pause between two cycles of one click: its end would be the restart, so its record is void.
    if (journal.state.evaluation?.endedAt === null) await journal.fact(RefineEvent.EvaluationEnded, { interrupted: true });
    // A plan preparation cut by a restart is failed too; the owner runs it again.
    if (journal.state.speckit?.status === 'running') await journal.fact(RefineEvent.SpeckitFailed, { reason: 'A preparação foi interrompida quando o servidor reiniciou.', kind: 'interrupted' });
    // An architecture decision cut by a restart is failed, so the owner decides again instead of waiting on it.
    if (journal.state.architectureRunning) await journal.fact(RefineEvent.ArchitectureFailed, { reason: 'A decisão da arquitetura foi interrompida quando o servidor reiniciou.', issues: [] });
    // A graph extraction cut by a restart is failed, so the stage does not wait forever; Continuar tries again.
    if (journal.state.graphing) await journal.fact(RefineEvent.DocGraphFailed, { file: journal.state.graphing, reason: 'A extração foi interrompida quando o servidor reiniciou.' });
    // A crash between enabling backlog mode and moving the briefing: finish the move.
    if (journal.state.backlog?.enabled) await moveBriefingToProject(deps.draft);
    // A continued spec carries its JSON from main before any cycle has derived one.
    if (!journal.state.derived) journal.state.derived = await readDerived(deps.draft);
    const session = new RefineSession(deps, journal);
    await session.attachDocs(true);
    return session;
  }

  static async create(deps: SessionDeps, mode: 'new-project' | 'new-spec' | 'continue' | 'backlog', options: { repositories?: boolean; docsRepo?: boolean } = {}): Promise<RefineSession> {
    const s = await RefineSession.open(deps);
    // A continued spec keeps the backlog key that names its plan file, which its next derivation no longer carries.
    const featureKey = mode === 'continue' ? s.state.derived?.spec.derivedFrom?.backlogKey : undefined;
    // Only a new project takes the repository flow; the stamp is written once, here, and the event without it is the same as before.
    // A documentation repository decides its architecture, so it is a repository session too.
    const repositories = options.docsRepo === true || (options.repositories ?? (mode === 'new-project' && REPOSITORY_FLOW));
    await s.journal.fact(RefineEvent.Created, { projectId: deps.draft.projectId, specId: deps.draft.specId, mode, stages: mode === 'new-project', ...(featureKey ? { featureKey } : {}), ...(repositories ? { repositories: true } : {}), ...(options.docsRepo === true ? { docsRepo: true } : {}) });
    if (repositories) await s.adoptArchitecture();
    if (options.docsRepo === true) await s.attachDocs(false);
    return s;
  }

  /** A follow-on draft takes the architecture its main copy holds: decided on the documents it starts from, so no stage is asked again. */
  private async adoptArchitecture(): Promise<void> {
    const file = path.posix.join(this.deps.draft.root, 'docs', 'architecture.json');
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text === null) return;
    const architecture = Architecture.parse(JSON.parse(text));
    const docs = await this.docsNow();
    await this.journal.fact(RefineEvent.ArchitectureDecided, { docsHash: docsHashOf(docs), architecture, questions: [] });
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
    if (this.starting || this.syncing) throw new BusyError('a start is already in progress');
  }

  private guard(): void {
    if (this.state.status === 'started') throw new ConflictError('session already started a run');
    this.guardStarting();
    if (this.discarding) throw new BusyError('o rascunho está sendo descartado');
    if (this.busy) throw new BusyError('Já tem uma avaliação em andamento. Aguarde ela terminar e tente de novo.');
  }

  /** Like `guard`, but a graph extraction does not stop the action: it changes no document. */
  private guardLight(): void {
    if (this.busy && this.indexing) return;
    this.guard();
  }

  ensureCanEvaluate(): void {
    this.guard();
  }

  /** What the heal driver needs about this draft, read from the journal: the failures in a row and whether the driver paused. */
  healView(): HealView {
    const runs = healRunsOf(this.journal.events);
    return {
      busy: this.busy || this.discarding,
      started: this.state.status === 'started',
      // A new project's stage reviews run until the owner closes the final review; the driver only retries one that failed.
      staged: this.state.stages === true && this.state.reviewClosed !== true && this.state.status !== 'error',
      paused: runs.paused,
      cycle: this.state.status === 'error' ? runs.cycle : undefined,
      speckit: this.state.speckit?.status === 'failed' ? runs.speckit : undefined,
    };
  }

  /** The heal driver stops on this draft; a later failure, which the owner's action produces, lifts the pause. */
  async pauseHeal(reason: string): Promise<void> {
    await this.journal.fact(RefineEvent.AutopilotPaused, { reason });
  }

  /** Takes the start lock at once, before any await; it is held until `markStarted` or `failStart`. */
  beginStart(): void {
    this.guardStarting();
    this.starting = true;
  }

  /** The owner throws this draft away: no run starts on it from now on, and the heal driver leaves it. */
  beginDiscard(): void {
    this.guardStarting();
    this.discarding = true;
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
    for (const e of this.journal.events) {
      if (e.type !== RefineEvent.DocGraphed) continue;
      tokens.inputTokens += Number(e.data.inputTokens ?? 0);
      tokens.outputTokens += Number(e.data.outputTokens ?? 0);
    }
    const hashes = Object.fromEntries(Object.entries(docs).map(([file, text]) => [file, sha256(text)])) as Record<DocFile, string>;
    const architectureStale = this.state.architecture ? this.state.architecture.docsHash !== docsHashOf(docs) : false;
    const target = await this.docsTargetOf(docs);
    return { projectId: this.deps.draft.projectId, specId: this.deps.draft.specId, state: this.state, docs, hashes, secrets, tokens, busy: this.busy, architectureStale, closing: this.state.repositories === true ? { ...(await this.closingSummary()), repositories: [] } : undefined, stageProblems: Object.fromEntries(DOC_STAGES.map((file) => [file, this.stageProblem(file, docs[file])])) as Record<DocFile, string | null>, seq: this.journal.events.at(-1)?.seq ?? 0, limits: this.limits(), specsApproved: this.specsApproved(),...(this.state.docsRepo === true ? { docsRepo: true } : {}), ...(target ? { docsTarget: target } : {}), ...(this.docs ? { docsSync: this.docs.view } : {}) };
  }

  /** The repository the backlog step creates: the owner of the project document or the default one, and the name of the style. */
  private async docsTargetOf(docs: Record<DocFile, string>): Promise<RepoTarget | undefined> {
    const style = this.state.architecture?.decision.style;
    if (this.state.docsRepo !== true || !style) return undefined;
    const owner = githubOwnerOf(docs['project.md']) ?? (await this.defaultOwner());
    if (!owner) return undefined;
    try {
      return docsTarget(style, this.deps.draft.projectId, owner);
    } catch (err) {
      if (err instanceof RangeError) return undefined;
      throw err;
    }
  }

  /** The owner when the project document names none: the configured owner, else the signed-in account, the same one the bind uses. */
  private async defaultOwner(): Promise<string | undefined> {
    const docsBind = this.deps.docsBind;
    if (!docsBind) return undefined;
    return (await docsBind.configuredOwner()) ?? (await viewerLogin(this.deps.ws.root, docsBind.exec)) ?? undefined;
  }

  /** The reviews a document has had since its stage last advanced, failed ones too: a re-review of an earlier document spends nothing here. */
  private reviewsOf(file: DocFile): number {
    let count = 0;
    for (const e of this.journal.events) {
      if (e.type === RefineEvent.StageAdvanced && e.data.doc === file) count = 0;
      else if (e.type === RefineEvent.CycleStarted && e.data.file === file) count += 1;
    }
    return count;
  }

  /** The rounds the current stage has used count against its limit. */
  private guardRounds(file?: DocFile): void {
    const rounds = file ? this.reviewsOf(file) : this.state.cycle - (this.state.stageStartCycle ?? 0);
    if (rounds >= this.limits().max) throw new ConflictError(`o refinamento já tem ${rounds} rodadas nesta etapa, o limite de ${this.limits().max}: revise os documentos e inicie a análise, ou ajuste TEAMS_AI_REFINE_MAX_ROUNDS`);
  }

  /** The first document whose stage the owner has not moved on from. */
  private currentStage(): DocFile | undefined {
    return DOC_STAGES.find((file) => !(this.state.doneStages ?? []).includes(file));
  }

  /** In a repository session the documents go in order: only the current stage and the finished ones can be reviewed or suggested. */
  private guardStage(file: DocFile): void {
    if (this.state.repositories !== true || this.state.stages !== true) return;
    const why = stageBlocked(this.state.doneStages ?? [], file);
    if (why) throw new ConflictError(why);
  }

  /** In a repository session the backlog, the plans and the final review wait until all five documents are done. */
  private guardStagesDone(): void {
    if (this.state.repositories !== true || this.state.stages !== true) return;
    const open = DOC_STAGES.filter((file) => !(this.state.doneStages ?? []).includes(file));
    if (open.length > 0) throw new ConflictError(`Conclua as etapas dos documentos antes: falta ${open.join(', ')}.`);
  }

  /** The steps after the documents wait while a document is outdated: its stage is reviewed again first. */
  private guardNoStale(): void {
    const stale = Object.keys(this.state.staleBy ?? {});
    if (this.state.stages === true && stale.length > 0) throw new ConflictError(`Revise de novo as etapas desatualizadas antes: ${stale.join(', ')}.`);
  }

  /** In a repository session the backlog and the evaluation wait until all five documents are in the Graphify graph. */
  private guardGraphed(): void {
    if (this.state.repositories !== true || this.state.stages !== true) return;
    const missing = DOC_STAGES.filter((file) => !(this.state.graphed ?? []).includes(file));
    if (missing.length > 0) throw new ConflictError(`Adicione os cinco documentos ao Graphify antes: falta ${missing.join(', ')}.`);
  }

  /** Shows the extraction in the state, then runs it in the background; the session stays busy until the graph has the document or refused it. */
  private startIndexing(file: DocFile, advance = true): Promise<void> {
    const started = this.journal.fact(RefineEvent.DocGraphStarted, { file });
    this.indexing = true;
    this.running = started.then(() => this.indexStage(file, advance)).then(async () => {
      // A document the owner changed while it was being extracted holds an older text in the graph: it is marked again.
      for (const changed of this.changedWhileIndexing) await this.journal.fact(RefineEvent.DocGraphStale, { file: changed });
    }).finally(() => {
      this.changedWhileIndexing.clear();
      this.running = null;
      this.indexing = false;
    });
    return started.then(() => undefined);
  }

  /** One extraction: the finished documents and this one, as they are now, go to the graph; a failure is journaled for the owner. */
  private async indexStage(file: DocFile, advance = true): Promise<void> {
    try {
      const staging = path.posix.join(this.deps.draft.root, 'doc-graph');
      const folder = path.posix.join(staging, 'docs');
      await fs.rm(folder, { recursive: true, force: true });
      await fs.mkdir(folder, { recursive: true });
      for (const doc of [...(this.state.doneStages ?? []), file]) await fs.writeFile(path.posix.join(folder, doc), await readDoc(this.deps.draft, doc));
      // The count before this extraction: a document that loses nodes is recorded with both counts, not refused.
      const previous = await documentCounts(staging, file).catch(() => null);
      await this.deps.extractDocs!(folder, staging);
      const counts = await documentCounts(staging, file);
      if (counts.nodes === 0) throw new Error('O Graphify não encontrou conteúdo neste documento.');
      await this.journal.fact(RefineEvent.DocGraphed, { file, hash: sha256(await readDoc(this.deps.draft, file)), nodes: counts.nodes, previousNodes: previous?.nodes ?? null, links: counts.links, inputTokens: counts.inputTokens, outputTokens: counts.outputTokens });
      if (advance) await this.journal.fact(RefineEvent.StageAdvanced, { doc: file, cycle: this.state.cycle });
    } catch (err) {
      await this.journal.fact(RefineEvent.DocGraphFailed, { file, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Why a document cannot be continued as it is, in plain words; null when it can. */
  private stageProblem(file: DocFile, text: string): string | null {
    if (text.trim() === '') return `A etapa ${file} está vazia.`;
    if (file === 'flow.md' && (text === flowTemplate() || !flowIsMermaid(text))) return 'O flow.md precisa de um diagrama Mermaid com o fluxo do negócio.';
    return null;
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
    this.guardRounds(file);
    this.guardStage(file);
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
      await this.journal.fact(RefineEvent.StageReprocessed, { file });
      return;
    }
    if ((this.state.passedStages ?? []).includes(file)) return;
    await this.keepPassed(file, await readDoc(this.deps.draft, file));
  }

  /** Writes `text` as the text passed to a stage: the reprocess goes back to it. */
  private async keepPassed(file: DocFile, text: string): Promise<void> {
    const kept = path.posix.join(this.deps.draft.root, 'passed', file);
    await fs.mkdir(path.posix.dirname(kept), { recursive: true });
    await fs.writeFile(kept, text);
    await this.journal.fact(RefineEvent.StagePassed, { file, hash: sha256(text) });
  }

  /** One review of a stage document, then the safe suggestions accepted and the Jev score taken again. */
  private async reviewAndScore(deps: Parameters<typeof runStageCycle>[0], file: DocFile): Promise<void> {
    await runStageCycle(deps, this.state.cycle + 1, file);
    if (this.state.status === 'error') return;
    await this.acceptSafePatches(file);
    // The Jev score of the reviewed document follows on its own: the owner no longer asks for it with a button.
    if (this.deps.scoreDocs && scoresDocs(this.state.mode)) {
      const scored = { draft: this.deps.draft, journal: this.journal, scoreDocs: this.deps.scoreDocs };
      await recordScore(scored, this.state.cycle, await isConfidential(scored.draft, this.state), [file]);
    }
  }

  /** The Jev score of a document in percent when it is below the pass line, else null. */
  private lowScore(file: DocFile): number | null {
    const score = this.state.readiness?.docs?.[file]?.score;
    return score !== undefined && score < PASS_LINE ? percentOf(score) : null;
  }

  private async timedStage(ctl: AbortController, file: DocFile, restore: boolean): Promise<void> {
    await this.journal.fact(RefineEvent.EvaluationStarted, {});
    try {
      await this.keepPassedText(file, restore);
      const deps = { draft: this.deps.draft, journal: this.journal, runAgent: this.deps.runAgent, frontAgent: this.deps.frontAgent, validateDocs: this.deps.validateDocs, principles: () => this.state.derived?.project.principles ?? [], signal: ctl.signal, lastReviewKey: (f: DocFile) => lastReviewKeyOf(this.journal.events, f) };
      await this.reviewAndScore(deps, file);
      // A document scored below the pass line is reviewed once more, now with its new score in front of the agents.
      if (this.state.status !== 'error' && this.lowScore(file) !== null && !this.improved.has(file)) {
        this.improved.add(file);
        await this.reviewAndScore(deps, file);
      }
      // A repository session adds the reviewed document to the graph when its review ends; a failed review adds nothing.
      if (this.state.status !== 'error' && this.state.repositories === true && (DOC_STAGES as readonly DocFile[]).includes(file) && this.deps.extractDocs) {
        await this.journal.fact(RefineEvent.DocGraphStarted, { file });
        await this.indexStage(file, false);
      }
    } finally {
      await this.journal.fact(RefineEvent.EvaluationEnded, {});
    }
  }

  /** The owner moves on from a document's stage, the named one or else the current one; the rounds of the next stage count from here. */
  async continueStage(doc?: DocFile, confirmLowScore = false): Promise<void> {
    this.guard();
    if (this.state.stages !== true) throw new ConflictError('só um refinamento de projeto novo tem etapas');
    const target = doc ?? this.currentStage();
    if (!target) throw new ConflictError('todas as etapas já foram concluídas');
    if (!DOC_STAGES.includes(target)) throw new ConflictError(`${target} não é uma etapa do refinamento`);
    const low = (this.state.doneStages ?? []).includes(target) ? null : this.lowScore(target);
    if (low !== null && !confirmLowScore) throw new ConflictError(`A nota do Jev de ${target} está em ${low}%, abaixo de ${percentOf(PASS_LINE)}%. Confirme para continuar mesmo assim.`);
    // A finished document only goes back to the graph when a human edit took it out of there: the review then comes first, and the extraction adds it again.
    const finished = (this.state.doneStages ?? []).includes(target);
    if (finished && (this.state.repositories !== true || (this.state.graphed ?? []).includes(target))) throw new ConflictError(`a etapa ${target} já foi concluída`);
    if (this.state.repositories === true) {
      this.guardStage(target);
      const why = stageReviewBlock(this.state, target);
      if (why) throw new ConflictError(why);
      const problem = this.stageProblem(target, await readDoc(this.deps.draft, target));
      if (problem) throw new ConflictError(problem);
      if (!this.deps.extractDocs) throw new ConflictError('O Graphify não está disponível para adicionar o documento.');
      await this.skipOpenQuestions(target);
      // The stage advances only once the graph has the document: the request answers at once, the extraction runs in the background.
      await this.startIndexing(target);
      return;
    }
    await this.journal.fact(RefineEvent.StageAdvanced, { doc: target, cycle: this.state.cycle });
  }

  /** A reprocessed stage does not wait for its mandatory questions: moving on skips the open ones. */
  private async skipOpenQuestions(file: DocFile): Promise<void> {
    if (!(this.state.reprocessedStages ?? []).includes(file)) return;
    for (const q of this.state.questions.filter((x) => x.file === file && x.status === 'pending' && x.blocking)) {
      await this.journal.fact(RefineEvent.QuestionSkipped, { questionId: q.questionId });
    }
  }

  /** "Não se aplica" on design.md: the text is written and kept as passed; a repository session adds it to the graph and moves on at once. */
  async markNotApplicable(): Promise<void> {
    this.guard();
    if (this.state.stages === true) this.guardStage('design.md');
    await writeDoc(this.deps.draft, 'design.md', NOT_APPLICABLE_DESIGN);
    await this.journal.fact(RefineEvent.DocEdited, { file: 'design.md', hash: sha256(NOT_APPLICABLE_DESIGN), source: 'human' });
    await this.keepPassed('design.md', NOT_APPLICABLE_DESIGN);
    if (this.state.stages === true && this.state.repositories === true) await this.continueStage('design.md');
  }

  /** The final review puts a finished document in the graph: one edited since its review is reviewed again first, and the question and suggestion gates do not apply. */
  async addToGraph(file: DocFile): Promise<void> {
    this.guard();
    if (this.state.repositories !== true || this.state.stages !== true) throw new ConflictError('só um refinamento de projeto novo com repositórios tem Graphify por etapa');
    this.guardStagesDone();
    if ((this.state.graphed ?? []).includes(file)) throw new ConflictError(`${file} já está no Graphify`);
    const problem = this.stageProblem(file, await readDoc(this.deps.draft, file));
    if (problem) throw new ConflictError(problem);
    if (!this.deps.extractDocs) throw new ConflictError('O Graphify não está disponível para adicionar o documento.');
    // A document edited since its review is reviewed again first, by its own role; the review then puts it in the graph.
    if (!(this.state.reviewedStages ?? []).includes(file)) {
      void this.startStage(file, false);
      return;
    }
    // The stage does not move: it is already done.
    await this.startIndexing(file, false);
  }

  /** The owner moves on from the final review to the backlog; the review then shows as done. */
  async closeReview(): Promise<void> {
    this.guard();
    if (this.state.stages !== true) throw new ConflictError('só um refinamento de projeto novo tem etapas');
    this.guardStagesDone();
    this.guardNoStale();
    if (this.state.reviewClosed) throw new ConflictError('a revisão já foi concluída');
    await this.journal.fact(RefineEvent.ReviewClosed, {});
  }

  /** The owner's answer on confidentiality; a stage session sends no document to the Jev until it comes. */
  async answerConfidentiality(confidential: boolean): Promise<void> {
    this.guard();
    await this.journal.fact(RefineEvent.ConfidentialityAnswered, { confidential });
  }

  /** `baseHash` is the hash of the file the text was typed over: a file another change has moved since is a conflict, never an overwrite. Returns the hash of the file as saved. */
  async saveDoc(file: DocFile, text: string, baseHash?: string): Promise<string> {
    this.guardLight();
    if (baseHash !== undefined && sha256(await readDoc(this.deps.draft, file)) !== baseHash) {
      throw new ConflictError('O documento mudou desde que você o abriu. Recarregue a página antes de salvar.');
    }
    const saved = file === 'briefing.md' ? await this.keepDecisions(text) : text;
    await writeDoc(this.deps.draft, file, saved);
    await this.journal.fact(RefineEvent.DocEdited, { file, hash: sha256(saved), source: 'human' });
    if (this.indexing) this.changedWhileIndexing.add(file);
    return sha256(await readDoc(this.deps.draft, file));
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
    this.guardStage(file);
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
  enableBacklog(): Promise<void> {
    this.binding ??= this.enableBacklogOnce().finally(() => {
      this.binding = null;
    });
    return this.binding;
  }

  private async enableBacklogOnce(): Promise<void> {
    this.guard();
    await this.enableBacklogStep(true);
  }

  /** Binds the documentation repository of this project, once; a refusal is a conflict whose message the owner reads. */
  private async bindDocsRepo(): Promise<void> {
    const docsBind = this.deps.docsBind;
    if (!docsBind) throw new ConflictError('O GitHub não está configurado: não é possível criar o repositório de documentos.');
    const architecture = this.state.architecture;
    if (!architecture) throw new ConflictError('Decida a arquitetura antes do backlog.');
    const { draft } = this.deps;
    try {
      await bindDocumentRepo({ ws: this.deps.ws, style: architecture.decision.style, projectId: draft.projectId, draftId: draft.specId, docs: await this.docsNow(), configuredOwner: await docsBind.configuredOwner(), exec: docsBind.exec });
    } catch (err) {
      if (err instanceof DocsStoreError || err instanceof DocsBindRefused) throw new ConflictError(err.message);
      throw err;
    }
    await this.attachDocs(false);
  }

  /** Syncs a documentation repository session once its store is bound: the journal's hook, and at open one flush. */
  private async attachDocs(atOpen: boolean): Promise<void> {
    const exec = this.deps.docsBind?.exec;
    if (this.docs || this.state.docsRepo !== true || !exec) return;
    const marker = await readDocsMarker(this.deps.ws);
    if (!marker) return;
    this.docs = new DocsSync({ ws: this.deps.ws, draft: this.deps.draft, style: marker.style, exec, aliases: () => this.docsAliases(marker.style) });
    this.journal.onFact = (e) => this.onFact(e);
    if (atOpen) void this.docs.flush();
    else void this.docs.publish();
  }

  /** A boundary or a document change is committed at the next tick; nothing counts once the draft starts or syncs. */
  private onFact(e: StoredEvent): void {
    if (!this.docs || this.state.status === 'started' || this.discarding || this.starting || this.syncing) return;
    const label = boundaryLabel(e, this.state.backlog);
    if (label !== null) this.docs.boundary(label);
  }

  /** The specs this draft derived: each alias folder, and for a microservice its repository. */
  private docsAliases(style: Style): SpecAlias[] {
    return Object.values(this.state.backlog?.specs ?? {}).flatMap((row) => (row.spec ? [{ alias: row.specId, service: style === 'microservices' ? row.spec.repository : undefined }] : []));
  }

  /** Closes the documentation repository before the launch; a refusal is a conflict, and nothing launches. A legacy session has nothing to close. */
  async closeDocs(aliases: readonly string[]): Promise<void> {
    if (this.state.docsRepo !== true) return;
    const exec = this.deps.docsBind?.exec;
    const docs = this.docs;
    if (!docs || !exec) throw new ConflictError('O repositório de documentos não está ligado a este refinamento.');
    await this.mergeClosingDocs(exec).then(() => docs.close(aliases)).catch((err: unknown) => {
      throw new ConflictError(err instanceof Error ? err.message : String(err));
    });
  }

  /** Merges each document the store changed since the draft began into the draft; a conflict keeps its markers in the draft and refuses. */
  private async mergeClosingDocs(exec: Exec): Promise<void> {
    const marker = await readDocsMarker(this.deps.ws);
    if (!marker) return;
    const draft = this.deps.draft;
    const store = await openStore(this.deps.ws, marker.style, exec);
    const conflicts: string[] = [];
    for (const doc of FIVE_DOCS) {
      const base = await readBase(draft, doc);
      const theirs = await readStoreText(store, `docs/${doc}`);
      if (base === null || theirs === null || sameDoc(theirs, base)) continue;
      const merged = await mergeDocStrict(`docs/${doc}`, base, theirs, await readDoc(draft, doc), exec);
      await writeDoc(draft, doc, merged);
      if (holdsConflictMarkers(merged)) conflicts.push(doc);
      else await fs.writeFile(path.posix.join(draft.base!, doc), theirs);
    }
    if (conflicts.length > 0) throw new ConflictError(`O documento ${conflicts.join(', ')} mudou na loja e conflita com o rascunho: resolva as marcas no rascunho e inicie de novo.`);
  }

  /** A discarded draft that never started takes its alias folders out of the store; a refusal is a conflict. */
  async retireDocs(): Promise<void> {
    await this.docs?.retire().catch((err: unknown) => {
      throw new ConflictError(err instanceof Error ? err.message : String(err));
    });
  }

  /** The registry tick: a waiting boundary or a failed flush is committed and pushed again, and the start tags are retried. */
  async tickDocs(): Promise<void> {
    await this.docs?.tick();
    await this.publishStartTags();
  }

  /** After a marked start: the start tags of the closing. Never fails the start; a tag left pending is retried by the tick. */
  publishStartTags(): Promise<void> {
    if (this.state.status !== 'started') return Promise.resolve();
    return this.docs?.publishTags() ?? Promise.resolve();
  }

  /** The five documents as they are now, by file name. */
  private async docsNow(): Promise<Record<DocFile, string>> {
    return Object.fromEntries(await Promise.all(DOC_STAGES.map(async (file) => [file, await readDoc(this.deps.draft, file)]))) as Record<DocFile, string>;
  }

  /** Why the backlog cannot start yet, in plain words; null when the architecture is decided on the documents as they are. */
  private async architectureProblem(): Promise<string | null> {
    if (this.state.repositories !== true) return null;
    if (!this.state.architecture) return 'Decida a arquitetura antes do backlog.';
    if (this.state.architecture.docsHash !== docsHashOf(await this.docsNow())) return 'Os documentos mudaram depois da arquitetura: decida a arquitetura de novo.';
    if (this.state.questions.some((q) => q.origin === 'architecture' && q.status === 'pending' && q.blocking)) return 'Responda as perguntas da arquitetura antes do backlog.';
    return null;
  }

  /** "Decidir a arquitetura": the architecture the five documents support, decided in the background; the request answers once it has started. */
  async decideArchitecture(): Promise<void> {
    this.guard();
    if (this.state.repositories !== true) throw new ConflictError('só um refinamento com repositórios decide a arquitetura');
    this.guardStagesDone();
    this.guardNoStale();
    this.guardGraphed();
    const ctl = (this.abortCtl = new AbortController());
    const started = this.docsNow().then(async (docs) => {
      await this.journal.fact(RefineEvent.ArchitectureStarted, { docsHash: docsHashOf(docs) });
      return docs;
    });
    this.running = started.then((docs) => this.architectureRun(docs, ctl)).finally(() => {
      this.running = null;
      this.abortCtl = null;
    });
    await started;
  }

  /** One decision, journaled inside an evaluation so a restart ends it; a failure is journaled for the owner, never thrown. */
  private async architectureRun(docs: Record<DocFile, string>, ctl: AbortController): Promise<void> {
    await this.journal.fact(RefineEvent.EvaluationStarted, {});
    try {
      const out = await this.decideOnDocs(docs, ctl.signal);
      const bound = this.state.docsRepo === true ? await readDocsMarker(this.deps.ws) : null;
      const lock = styleRefusal(bound, out.style);
      if (lock) throw new Error(lock);
      const arch: Architecture = { style: out.style, rationale: out.rationale, repositories: out.repositories, integrations: out.integrations };
      await writeArchitectureFiles(this.deps.draft.root, arch);
      // The questions get ids from the journal's length, so a replay names them the same way.
      const prefix = `arch-${this.journal.events.length}`;
      const questions: Question[] = out.questions.map((q, i) => ({ questionId: `${prefix}-${i}`, role: 'sm', text: q.text, context: q.context, blocking: q.blocking, relatedAcIds: [], cycle: this.state.cycle, options: q.options.length > 0 ? q.options : undefined, origin: 'architecture' }));
      await this.journal.fact(RefineEvent.ArchitectureDecided, { docsHash: docsHashOf(docs), architecture: arch, questions });
    } catch (err) {
      await this.journal.fact(RefineEvent.ArchitectureFailed, { reason: err instanceof Error ? err.message : String(err), issues: err instanceof RulesOpenError ? err.issues : [] });
    } finally {
      await this.journal.fact(RefineEvent.EvaluationEnded, {});
    }
  }

  /** The agent decides; a rule it breaks goes back once, with the rules named, and a second break stops the decision. */
  private async decideOnDocs(docs: Record<DocFile, string>, signal: AbortSignal): Promise<ArchitectureOutput> {
    const { draft } = this.deps;
    const hash = docsHashOf(docs);
    const graphContext = this.deps.docGraphContext ? await this.deps.docGraphContext(path.posix.join(draft.root, 'doc-graph'), ARCHITECTURE_QUESTION, GRAPH_CONTEXT_TOKENS) : '';
    const answers = this.state.questions.filter((q) => q.origin === 'architecture' && q.status === 'answered' && q.answer).map((q) => `${q.text}: ${q.answer}`);
    const existingServices = this.state.derived?.project.services ?? [];
    let issues: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const pack = fitPackBudget(architecturePack({ specHash: hash, principles: [], docs, graphContext, existingServices, answers, issues }));
      const out = (await this.deps.runAgent<'architecture'>(
        { kind: 'architecture', role: 'sm', pack, cwd: draft.root, phase: 'refine', taskId: null, attempt },
        { journal: this.journal, stepDir: draft.steps, specHash: hash, signal },
      )) as StepOutcome<ArchitectureOutput>;
      if (!out.ok) throw ownerFailure('A arquitetura', out.failure, out.errors, TRY_AGAIN);
      issues = checkDecision(out.value, draft.projectId, docs);
      if (issues.length === 0) return out.value;
    }
    throw new RulesOpenError(issues);
  }

  /** `bindRepo` is set only by the owner's Backlog step: no evaluation binds a documentation repository. */
  private async enableBacklogStep(bindRepo = false): Promise<void> {
    if (this.state.backlog?.enabled) return;
    this.guardStagesDone();
    this.guardNoStale();
    this.guardGraphed();
    // Plan 90: the owner's answers reach the brief first, so the architecture is decided on the documents the backlog is made of.
    await this.recordOwnerAnswers();
    // A decision made on documents that have changed is taken again on the documents as they are.
    if (await this.isArchitectureStale()) await this.redecideArchitecture();
    const why = await this.architectureProblem();
    if (why) throw new ConflictError(why);
    if (bindRepo && this.state.docsRepo === true) await this.bindDocsRepo();
    // The move removes this draft's own spec.json (a continued spec's, on main): its criterion ids stay the numbering floor.
    await this.journal.fact(RefineEvent.BacklogEnabled, { acFloor: await maxCriterionInDraft(this.deps.draft), keyIds: true });
    // The detailing is part of the one process: every evaluation of the backlog details its changed items.
    await this.journal.fact(RefineEvent.BacklogDetailEnabled, {});
    await moveBriefingToProject(this.deps.draft);
  }

  /** Plan 90: the owner's answers not yet in the brief go into it as decisions, so the brief carries them into the move. */
  private async recordOwnerAnswers(): Promise<void> {
    const answered = this.state.questions.filter((q) => q.status === 'answered' && q.answer && !q.answeredBy);
    if (answered.length === 0) return;
    const after = answered.reduce((doc, q) => recordDecision(doc, q.text, q.answer!, q.subject), await readDoc(this.deps.draft, 'briefing.md'));
    await writeDoc(this.deps.draft, 'briefing.md', after);
    await this.journal.fact(RefineEvent.DocEdited, { file: 'briefing.md', hash: sha256(after), source: 'decision' });
  }

  /** Whether the architecture was decided on documents that have changed since. */
  async isArchitectureStale(): Promise<boolean> {
    return this.state.architecture != null && this.state.architecture.docsHash !== docsHashOf(await this.docsNow());
  }

  /** Decides the architecture again on the documents as they are; a failed decision is the reason the backlog cannot start. */
  private async redecideArchitecture(): Promise<void> {
    await this.decideArchitecture();
    await this.settled();
    if (this.state.architectureError) throw new ConflictError(this.state.architectureError);
  }

  /** "Preparar planos": the constitution, and a spec, plan and tasks for each item of the detailed backlog, or for the single spec. */
  runPlans(): Promise<void> {
    this.guard();
    this.guardStagesDone();
    this.guardNoStale();
    const backlog = this.state.backlog;
    if (backlog?.enabled && (!backlog.detail || backlog.items.length === 0 || backlog.items.some((i) => !backlog.specs?.[i.key]?.spec))) {
      throw new ConflictError('Detalhe o backlog antes de preparar os planos: cada item precisa da sua spec.');
    }
    if (!backlog?.enabled && !this.state.derived) throw new ConflictError('Avalie a spec antes de preparar os planos.');
    const ctl = (this.abortCtl = new AbortController());
    const run = this.timedPlans(ctl).finally(() => {
      this.running = null;
      this.abortCtl = null;
    });
    this.running = run;
    return run;
  }


  /** The journal keeps the preparation's start, each step and its end; a failure is journaled for the owner, never thrown. */
  private async timedPlans(ctl: AbortController): Promise<void> {
    try {
      const agents = (await this.deps.speckitAgents?.()) ?? 1;
      const hash = await preparePlans({ draft: this.deps.draft, journal: this.journal, runAgent: this.deps.runAgent, signal: ctl.signal, agents, docGraphContext: this.deps.docGraphContext }, this.state);
      await this.journal.fact(RefineEvent.PlansPrepared, { inputHash: hash });
    } catch (err) {
      const reason = err instanceof OwnerError ? err.message : `${PREPARATION_STAGE} parou por um erro interno. ${TRY_AGAIN}`;
      const detail = err instanceof OwnerError ? err.detail : String(err instanceof Error ? err.message : err).slice(0, 1000);
      // Every item step that stopped, each with its kind: the owner reads them, and the next run starts from the steps that finished.
      const failures = err instanceof PreparationFailed ? err.failures : undefined;
      await this.journal.fact(RefineEvent.SpeckitFailed, { reason, detail, failures, kind: stopKindOf(err) });
    }
  }

  async evaluate(): Promise<void> {
    // A stage session reviews its open document only; the whole documents are evaluated once every stage is done.
    const stage = this.state.stages === true ? this.currentStage() : undefined;
    if (stage) return this.evaluateStage(stage);
    this.ensureCanEvaluate();
    this.guardRounds();
    this.guardStagesDone();
    this.guardGraphed();
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

  /** The rendered specs.md of the detailed backlog and its hash, once the backlog is ready; null before that. */
  private specsOf(): { text: string; hash: string } | null {
    const b = this.state.backlog;
    if (this.state.status !== 'ready' || !b?.enabled || b.detail !== true || b.items.length === 0) return null;
    const text = renderSpecsMd(this.deps.draft.specId, b);
    return { text, hash: sha256(text) };
  }

  /** specs.md is written for this text and both PO and SM approved it. */
  private specsSettled(hash: string): boolean {
    return this.state.specsMd?.hash === hash && SPECS_REVIEWERS.every((role) => approvedAt(this.state.specsReview?.[role], hash));
  }

  /** The gate of the final review: specs.md is written from the current backlog and approved by PO and SM. */
  specsApproved(): boolean {
    const specs = this.specsOf();
    return specs !== null && this.specsSettled(specs.hash);
  }

  /** Opens the specs check when the backlog is ready and a reviewer still owes its approval of this text; null when nothing is due. */
  startSpecs(): Promise<void> | null {
    if (this.busy || this.starting || this.syncing || this.discarding || this.state.status === 'started') return null;
    const specs = this.specsOf();
    if (!specs || this.specsSettled(specs.hash)) return null;
    const ctl = (this.abortCtl = new AbortController());
    const run = this.specsRounds(ctl, specs).finally(() => {
      this.running = null;
      this.abortCtl = null;
    });
    this.running = run;
    return run;
  }

  /** The check of specs.md, and when a reviewer rejects it, up to MAX_SPECS_REPAIRS rounds in which the agents detail the named items again with what was wrong; the owner is asked only after that. */
  private async specsRounds(ctl: AbortController, first: { text: string; hash: string }): Promise<void> {
    let specs = first;
    for (;;) {
      await this.timedSpecs(ctl, specs);
      const feedback = ctl.signal.aborted || (this.state.specsRepairs ?? 0) >= MAX_SPECS_REPAIRS ? null : this.specsFeedbackOf(specs.hash);
      if (!feedback) return;
      await this.journal.fact(RefineEvent.SpecsFeedback, { specsHash: specs.hash, feedback });
      await this.timedChain(ctl);
      const next = this.specsOf();
      if (!next || this.specsSettled(next.hash)) return;
      specs = next;
    }
  }

  /** What the reviewers rejected in this specs.md text, by backlog item; a finding that names no item goes to every item. Null when nothing was rejected. */
  private specsFeedbackOf(hash: string): Record<string, string[]> | null {
    const keys = (this.state.backlog?.items ?? []).map((i) => i.key);
    const findings = SPECS_REVIEWERS.flatMap((role) => {
      const review = this.state.specsReview?.[role];
      return review?.specsHash === hash && review.verdict === 'rejected' ? review.findings.map((text) => ({ role, text })) : [];
    });
    if (findings.length === 0) return null;
    const out: Record<string, string[]> = {};
    for (const { role, text } of findings) {
      const named = keys.filter((key) => namesItem(text, key));
      for (const key of named.length > 0 ? named : keys) (out[key] ??= []).push(`${role.toUpperCase()} (review of specs.md): ${text}`);
    }
    return out;
  }

  /** Writes specs.md and reads it back, then PO and SM check it; a failure is journaled for each reviewer, never thrown. */
  private async timedSpecs(ctl: AbortController, specs: { text: string; hash: string }): Promise<void> {
    // An open evaluation spans the file and both checks, so the page shows the work, its timer and its end like any other.
    await this.journal.fact(RefineEvent.EvaluationStarted, {});
    try {
      await writeSpecsMd(this.deps.draft, specs.text);
      if (sha256((await readSpecsMd(this.deps.draft)) ?? '') !== specs.hash) throw new Error('o arquivo não foi encontrado depois de gravado');
      await this.journal.fact(RefineEvent.SpecsMdWritten, { hash: specs.hash, bytes: Buffer.byteLength(specs.text) });
      const docs = await this.docsNow();
      const pending = SPECS_REVIEWERS.filter((role) => !approvedAt(this.state.specsReview?.[role], specs.hash));
      await Promise.all(pending.map((role) => this.reviewSpecs(role, specs, docs, ctl)));
    } catch (err) {
      const reason = `O specs.md não pôde ser gravado: ${err instanceof Error ? err.message : String(err)}. ${TRY_AGAIN}`;
      for (const role of SPECS_REVIEWERS) await this.journal.fact(RefineEvent.SpecsReviewed, { role, specsHash: specs.hash, verdict: 'failed', findings: [], reason });
    } finally {
      await this.journal.fact(RefineEvent.EvaluationEnded, {});
    }
  }

  /** One reviewer's check of specs.md; its verdict is journaled, or `failed` when the step did not finish. */
  private async reviewSpecs(role: SpecsReviewer, specs: { text: string; hash: string }, docs: Record<DocFile, string>, ctl: AbortController): Promise<void> {
    const out = (await this.deps.runAgent<'specs-review'>(
      {
        kind: 'specs-review',
        role,
        pack: fitPackBudget(specsReviewPack({ role, specHash: specs.hash, specsMd: specs.text, docs: { projectMd: docs['project.md'], briefMd: docs['briefing.md'], stackMd: docs['stack.md'], flowMd: docs['flow.md'], designMd: docs['design.md'] } })),
        cwd: this.deps.draft.root,
        phase: 'refine',
        taskId: null,
        attempt: this.state.cycle,
      },
      { journal: this.journal, stepDir: this.deps.draft.steps, specHash: specs.hash, signal: ctl.signal },
    )) as StepOutcome<SpecsReviewOutput>;
    const verdict = out.ok ? { verdict: out.value.verdict, findings: out.value.findings, reason: null } : { verdict: 'failed', findings: [], reason: `A análise do ${role.toUpperCase()} não terminou. ${TRY_AGAIN}` };
    await this.journal.fact(RefineEvent.SpecsReviewed, { role, specsHash: specs.hash, ...verdict });
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
        docGraphContext: this.deps.docGraphContext,
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
        // A repository session waits for the architecture of the documents as they are now.
        if (await this.architectureProblem()) return;
        // A documentation repository is bound only by the owner's Backlog step, so an evaluation stops here.
        if (this.state.docsRepo === true) return;
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

  /** Resolves when the background work of the session (an evaluation, a plan preparation or a document extraction) has ended. */
  async settled(): Promise<void> {
    await this.running?.catch(() => undefined);
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
    // A stage answer is only recorded, so the owner answers the whole batch while a review or an extraction runs.
    if (this.state.backlog?.enabled || !this.busy) this.guard();
    const q = this.question(questionId, true);
    // R11.10 (plan 90): a backlog reads the owner's answer from the briefing; written first, a retry rewrites the same heading.
    if (this.state.backlog?.enabled) {
      const after = recordDecision(await readDoc(this.deps.draft, 'briefing.md'), q.text, text, q.subject);
      await writeDoc(this.deps.draft, 'briefing.md', after);
      await this.journal.fact(RefineEvent.DocEdited, { file: 'briefing.md', hash: sha256(after), source: 'decision' });
    }
    await this.journal.fact(RefineEvent.QuestionAnswered, { questionId, text, ...(docsAnswered ? { docsAnswered: true } : {}) });
  }

  /** One review of the stage after the answers: answers given while a review runs wait for it and share one more review. */
  reviewAfterAnswers(file: DocFile): Promise<void> {
    this.queuedReview ??= this.settled().then(() => {
      this.queuedReview = null;
      return this.evaluateStage(file);
    });
    return this.queuedReview;
  }

  async skip(questionId: string): Promise<void> {
    this.guardLight();
    if (this.question(questionId).blocking) throw new ConflictError(`question ${questionId} is blocking and cannot be skipped`);
    await this.journal.fact(RefineEvent.QuestionSkipped, { questionId });
  }

  /** The owner asks again for a question the guard dropped: it comes back as a pending question. */
  async reask(questionId: string): Promise<void> {
    this.guard();
    const dropped = this.state.droppedQuestions?.find((d) => d.questionId === questionId);
    if (!dropped) throw new NotFoundError(`unknown dropped question ${questionId}`);
    if (this.state.questions.some((q) => q.questionId === questionId)) throw new ConflictError(`question ${questionId} is already on record`);
    await this.journal.fact(RefineEvent.QuestionReasked, { ...dropped });
  }

  private patch(id: string) {
    const p = this.state.patches.find((x) => x.patchId === id);
    if (!p) throw new NotFoundError(`unknown patch ${id}`);
    if (p.status !== 'pending') throw new ConflictError(`patch ${id} already ${p.status}`);
    return p;
  }

  async accept(patchId: string): Promise<void> {
    this.guardLight();
    const { file } = this.patch(patchId);
    await this.applyPatchRow(patchId);
    await this.markGraphOutdated(file as DocFile);
  }

  /** A document already in the graph holds an older text now: it is marked, and goes back in once, when the stage continues or the summary runs. */
  private async markGraphOutdated(file: DocFile): Promise<void> {
    if (this.state.repositories !== true) return;
    if (this.indexing) this.changedWhileIndexing.add(file);
    else if ((this.state.graphed ?? []).includes(file)) await this.journal.fact(RefineEvent.DocGraphStale, { file });
  }

  /** The safe suggestions of a stage (no scope change, no owner decision) are accepted when its review ends. */
  private async acceptSafePatches(file: DocFile): Promise<void> {
    for (const p of safePatches(this.state.patches.filter((x) => x.file === file))) {
      await this.applyPatchRow(p.patchId, true).catch((err) => {
        if (!(err instanceof ConflictError)) throw err;
      });
    }
  }

  private async applyPatchRow(patchId: string, auto = false): Promise<void> {
    const p = this.patch(patchId);
    const before = await readDoc(this.deps.draft, p.file);
    const after = applyPatch(before, p);
    if (after === null) {
      await this.journal.fact(RefineEvent.PatchDropped, { patchId, reason: COVERED_REASON });
      throw new ConflictError(`Este ajuste (${patchId}) já foi coberto por outra alteração e foi descartado.`);
    }
    await writeDoc(this.deps.draft, p.file, after);
    await this.journal.fact(RefineEvent.DocEdited, { file: p.file, hash: sha256(after), source: 'patch' });
    await this.journal.fact(RefineEvent.PatchAccepted, { patchId, ...(auto ? { auto: true } : {}) });
    // PO and SM often propose overlapping edits: the ones this change made stale leave the list now, instead of failing on click.
    for (const other of this.state.patches) {
      if (other.status === 'pending' && other.file === p.file && applyPatch(after, other) === null) {
        await this.journal.fact(RefineEvent.PatchDropped, { patchId: other.patchId, reason: COVERED_REASON });
      }
    }
  }

  async reject(patchId: string, reason: string | null): Promise<void> {
    this.guardLight();
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
    const row = newestReshape(this.state.reshapes, reshapeId);
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
    this.syncing = true;
    try {
      // A sync that kept conflict markers still journals what it brought in, and then refuses the start.
      const { changed, refusal } = await sync().then(
        (changed) => ({ changed, refusal: null }),
        (err: unknown) => (err instanceof MainConflict ? { changed: err.changed, refusal: new ConflictError(err.message) } : Promise.reject(err)),
      );
      for (const c of changed) await this.journal.fact(RefineEvent.DocEdited, { ...c, source: 'main' });
      if (refusal) throw refusal;
      if (changed.length > 0 && this.state.stale) {
        throw new ConflictError(`A main mudou desde o início deste refinamento (${changed.map((c) => c.file).join(', ')}): os documentos foram atualizados com essas mudanças. Avalie de novo para iniciar.`);
      }
    } finally {
      this.syncing = false;
    }
  }

  private limits(): RefineLimits {
    return this.deps.limits ?? refineLimits();
  }

  /** Refuses a start whose plan preparation is not current for the inputs as they are on disk; a running evaluation is the reason that comes first. */
  private refuseWithoutSpeckit(inputHash: string): void {
    if (this.state.status !== 'evaluating' && speckitPending(this.state, inputHash)) throw new ConflictError('Prepare os planos antes de iniciar: a preparação ainda não foi feita, falhou, os documentos mudaram depois dela ou há uma pergunta obrigatória dela sem resposta.');
  }

  /** Spec (refinement) §3.6 steps 1–2. */
  async freeze(): Promise<{ spec: Spec; project: Project }> {
    if (this.state.backlog?.enabled) throw new ConflictError('O início a partir do backlog ainda não está disponível: por enquanto o backlog serve para organizar e priorizar.');
    if (this.state.status === 'started') throw new ConflictError('session already started a run');
    if (this.running) await this.running;
    const inputHash = this.state.derived && (await planInputHash(this.deps.draft, this.state));
    // A spec not derived yet is refused below; a derived one needs its plan preparation first.
    if (inputHash) this.refuseWithoutSpeckit(inputHash);
    if (!canStart(this.state)) throw new ConflictError(`session cannot start now (${this.state.status})`);
    const derived = this.state.derived!;
    // Every answer of this session travels with the frozen spec, also one given after the last evaluation (R11.7.1).
    const value = { project: derived.project, spec: freezeSpec(withDecisions(derived.spec, this.state.questions)) };
    await writeDerived(this.deps.draft, value);
    return value;
  }

  /** The summary of a repository session: its seven checks, each repository's counts, and the assumptions taken; hashed for the authorization. */
  async closingSummary(): Promise<ClosingSummary> {
    const docs = await this.docsNow();
    const architectureCurrent = this.state.architecture?.docsHash === docsHashOf(docs);
    const checks = closingChecks(this.state, architectureCurrent === true);
    const items = this.state.backlog?.items ?? [];
    const done = (command: string, key: string) => (this.state.speckit?.steps ?? []).some((step) => step.command === command && step.itemKey === key && step.basis !== undefined);
    const repositories = (this.state.architecture?.decision.repositories ?? []).map((repo) => {
      const own = items.filter((i) => i.repository === repo.name);
      return { name: repo.name, specs: own.length, plans: own.filter((i) => done('plan', i.key)).length, tasks: own.filter((i) => done('tasks', i.key)).length };
    });
    const summary = { checks, repositories, assumptions: await this.assumptionsOf(items) };
    return { ok: checks.every((c) => c.ok), ...summary, summaryHash: sha256(canonicalJson(summary)) };
  }

  /** The assumptions the plans of the backlog took, each with its item, and the decisions the documents settled for the owner. */
  private async assumptionsOf(items: readonly { key: string }[]): Promise<string[]> {
    const specs = buildSpecsIndex(this.deps.draft.specId, this.state.backlog ?? { epics: [], items: [] }).specs;
    const planned = await Promise.all(
      items.map(async (item) => {
        const specId = specs.find((spec) => spec.key === item.key)?.specId ?? item.key;
        const text = await fs.readFile(path.join(this.deps.draft.docs, path.posix.relative('docs', planFileOf(specId))), 'utf8').catch(() => '');
        return assumptionBullets(text.split('\n')).map((bullet) => `${item.key}: ${bullet}`);
      }),
    );
    const decided = this.state.questions.filter((q) => q.answeredBy).map((q) => `${q.text}: ${q.answer ?? ''}`);
    return [...planned.flat(), ...decided];
  }

  /** R11.4: checks the gate of a backlog start and hands back its items in rank order; `beginStart()` takes the starting lock first. */
  async freezeProgram(summaryHash?: string): Promise<ProgramEntry[]> {
    if (!this.state.backlog?.enabled) throw new ConflictError('Esta sessão não está em modo backlog.');
    this.guardStagesDone();
    if (this.state.status === 'started') throw new ConflictError('session already started a run');
    if (this.running) await this.running;
    const backlog = this.state.backlog;
    // Each item's status on main, which the start's sync just brought into the base copy (R11.7.2).
    const specs = buildSpecsIndex(this.deps.draft.specId, backlog).specs;
    const onMain = Object.fromEntries(await Promise.all(specs.map(async (s) => [s.specId, (await readMainSpec(this.deps.draft, s.specId))?.status] as const)));
    const inputHash = await planInputHash(this.deps.draft, this.state);
    if (!backlog.detail) throw new ConflictError('Detalhe as specs do backlog antes de iniciar: o início a partir do backlog usa as specs planejadas.');
    this.refuseWithoutSpeckit(inputHash);
    if (this.state.repositories === true) {
      // The owner starts on the summary he read, the same one the page showed (its hash); its unmet checks only advise.
      if (summaryHash === undefined) throw new ConflictError('Abra o resumo do refinamento e confirme antes de iniciar.');
      const summary = await this.closingSummary();
      if (summary.summaryHash !== summaryHash) throw new ConflictError('O resumo mudou desde que você o abriu: revise-o antes de iniciar.');
      // The specs.md is made and checked in the backlog step, so the development starts only once PO and SM approved it.
      if (!this.specsApproved()) throw new ConflictError('O specs.md precisa estar gerado e aprovado por PO e SM antes de iniciar o desenvolvimento.');
      await this.journal.fact(RefineEvent.DevelopmentAuthorized, { summaryHash });
    }
    if (!canStart(this.state)) throw new ConflictError(`session cannot start now (${this.state.status})`);
    const entries = programEntries(this.deps.draft.specId, backlog, onMain);
    await this.closeDocs(entries.map((e) => e.specId));
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
    this.starting = false;
  }

  /** The start failed before its run was recorded: undo the `starting` lock and drop the closing of that launch. */
  async failStart(): Promise<void> {
    this.starting = false;
    await this.docs?.discardClosing();
  }
}
