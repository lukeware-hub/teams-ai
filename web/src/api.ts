import type { Divergence } from '@server/refine/checklist';
import type { Readiness } from '@server/refine/readiness';
import type { ClaudeUsage } from '@server/usage/claude-usage';
export type ItemName = 'claude' | 'githubOwner' | 'ghLogin' | 'githubToken' | 'openrouterKey';
export type LicenseView =
  | { state: 'missing' }
  | { state: 'authorized' }
  | { state: 'revoked'; contactEmail: string; contactPhone: string }
  | { state: 'unavailable' }
  | { state: 'other-machine' };
export interface Item { ok: boolean; detail: string; secret?: { set: boolean; hint: string } }
export interface Status { items: Record<ItemName, Item>; allOk: boolean }
export type SessionState =
  | { name: 'idle' }
  | { name: 'starting' }
  | { name: 'awaiting-browser'; url: string; code: string | null }
  | { name: 'awaiting-code'; url: string | null }
  | { name: 'verifying' }
  | { name: 'done'; detail: string }
  | { name: 'failed'; reason: string };
export type Cli = 'claude' | 'gh';

const P = '/api/onboarding';
async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }; // a non-JSON body still reports the status
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}
export const api = {
  status: () => fetch(`${P}/status`).then((r) => json<Status>(r)),
  organizations: () => fetch(`${P}/github-organizations`).then((r) => json<{ organizations: string[]; owner: string | null }>(r)),
  login: (cli: Cli) => fetch(`${P}/${cli}/login`, { method: 'POST', headers: { 'content-type': 'application/json' } }).then((r) => json<{ state: SessionState }>(r)),
  cancel: (cli: Cli) => fetch(`${P}/${cli}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' } }).then((r) => json<{ state: SessionState }>(r)),
  code: (cli: Cli, code: string) => fetch(`${P}/${cli}/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }).then((r) => json<{ state: SessionState }>(r)),
  owner: (owner: string) => fetch(`${P}/github-owner`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner }) }).then((r) => json<{ item: Item }>(r)),
  secret: (name: 'GITHUB_TOKEN' | 'OPENROUTER_API_KEY', value: string) => fetch(`${P}/secrets/${name}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) }).then((r) => json<{ item: Item }>(r)),
  events: (cli: Cli) => `${P}/${cli}/events`,
  license: (sync = false) => fetch(sync ? '/api/license/sync' : '/api/license', sync ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : undefined).then((r) => json<LicenseView>(r)),
  activateLicense: (key: string) => fetch('/api/license/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) }).then((r) => json<{ state: 'authorized' }>(r)),
};

export const AGENT_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const;
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'max'] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
export interface AgentSetting { model: AgentModel; effort: AgentEffort }
/** `inUse` is the model and effort the role's next step runs on: its setting, or the automatic default. */
export interface AgentRow { role: string; setting: AgentSetting | null; inUse: AgentSetting }
export type AgentChoice = { mode: 'auto' } | ({ mode: 'manual' } & AgentSetting);

const S = '/api/settings';
export const settingsApi = {
  agents: (projectId: string) => fetch(`${S}/agents/${projectId}`).then((r) => json<{ agents: AgentRow[] }>(r)),
  setAgent: (projectId: string, role: string, choice: AgentChoice) =>
    fetch(`${S}/agents/${projectId}/${role}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(choice) }).then((r) => json<{ setting: AgentSetting | null; inUse: AgentSetting }>(r)),
  stepTimeout: (projectId: string) => fetch(`${S}/step-timeout/${projectId}`).then((r) => json<{ timeoutMinutes: number }>(r)),
  setStepTimeout: (projectId: string, timeoutMinutes: number) =>
    fetch(`${S}/step-timeout/${projectId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timeoutMinutes }) }).then((r) => json<{ timeoutMinutes: number }>(r)),
  agentsDecide: (projectId: string) => fetch(`${S}/agents-decide/${projectId}`).then((r) => json<{ agentsDecide: boolean }>(r)),
  setAgentsDecide: (projectId: string, agentsDecide: boolean) =>
    fetch(`${S}/agents-decide/${projectId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentsDecide }) }).then((r) => json<{ agentsDecide: boolean }>(r)),
  planAgents: () => fetch(`${S}/plan-agents`).then((r) => json<{ agents: number }>(r)),
  setPlanAgents: (agents: number) =>
    fetch(`${S}/plan-agents`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agents }) }).then((r) => json<{ agents: number }>(r)),
};

export const usageApi = {
  claude: () => fetch('/api/usage/claude').then((r) => json<ClaudeUsage>(r)),
  jev: () => fetch('/api/usage/jev').then((r) => json<{ costUsd: number }>(r)),
};

export interface SpecRow {
  specId: string;
  status: string;
  activeRunId: string | null;
}
export interface ProjectRow {
  projectId: string;
  dir: string;
  name: string;
  description: string;
  specs: SpecRow[];
  repoUrl?: string | null;
  /** A project split into services: each with the GitHub page of its repository, null until it exists. */
  services?: Array<{ name: string; repoUrl: string | null }>;
  /** The shared containers every service reaches by name. */
  platform?: Array<{ name: string; image: string }>;
}
/** One of the five main documents as main has it; text is null when main does not have it yet. */
export interface ProjectDoc { file: string; text: string | null }
export interface RunRow {
  runId: string;
  specId: string;
  projectId: string;
  status: string;
  at: string | null;
  tokens: number;
  cost: number;
  stoppable: boolean;
  kind: 'run' | 'complete' | 'readme' | 'deploy';
  n: number;
  /** The spec was concluded: the run is read-only. */
  locked: boolean;
}
export interface StoredEvent {
  seq: number;
  at: string;
  runId: string;
  specHash: string;
  type: string;
  kind: 'fact' | 'intent' | 'confirm';
  intentId?: string;
  data: Record<string, unknown>;
}
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  steps: number;
}
export interface AcceptanceCriterion {
  id: string;
  given: string;
  when: string;
  then: string;
  smoke: boolean;
}
export interface TaskRow {
  def: { id: string; title: string; description?: string; owner: string; dependsOn: string[]; criteriaRefs: string[]; affectedPaths?: string[]; origin?: string };
  state: string;
  attempts: number;
  replanned: boolean;
  replacedBy: string[];
}
export interface PlanArtifact {
  specId: string;
  specHash: string;
  stack: string;
  adrRefs: string[];
  commands: Record<string, string | undefined>;
  gateImage: string;
  junitPath: string;
  gates: Array<{ name: string; command: string; blocking: boolean }>;
  frozenPaths: string[];
  tasks: Array<{ id: string; title: string; description: string; criteriaRefs: string[]; dependsOn: string[]; affectedPaths: string[]; owner: string; origin: string; service?: string }>;
  deploy: { image: string; port: number; healthcheckPath: string; manifests: string[] };
}
/** A plan of a project split into services: each task names its service, each service has its own settings. */
export interface ServicesPlanArtifact {
  specId: string;
  specHash: string;
  adrRefs: string[];
  tasks: PlanArtifact['tasks'];
  services: Record<string, { stack: string }>;
}
export interface SmokeRow { acId: string; testId: string | null; status: 'passed' | 'failed' | 'missing'; service?: string }
export interface EvidenceRow { criterion: string; tasks: string[]; tests: string[]; status: 'passed' | 'failed' | 'missing' | 'blocked'; e2e?: 'passed' | 'failed' | 'missing' | 'not-applicable'; e2eReason?: string }
export interface SecurityFinding {
  taskId?: string;
  file: string;
  line: number | null;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  problem: string;
  fix: string;
}
/** The orchestrator probing the deployed service: online means its health url answered below 400. */
export interface ServiceStatus {
  online: boolean;
  status: number | null;
  /** The root of the service answers with a page: it has a web UI. */
  ui?: boolean;
  /** The documentation path the plan declares answers with a success. */
  docs?: boolean;
  checkedAt: string;
  /** A services run answers for each service. */
  services?: Array<{ service: string; online: boolean; status: number | null; ui?: boolean; docs?: boolean }>;
}
/** Why a doc section is open, as the run recorded it. */
export type GapCause =
  | { kind: 'no-task' }
  | { kind: 'blocked'; roots: Array<{ taskId: string; reason: string }> }
  | { kind: 'tests-failing'; acIds: string[] }
  | { kind: 'run-stopped'; result: string }
  | { kind: 'not-built' };
export interface GapItem { doc: string; heading: string; status: 'delivered' | 'partial' | 'missing'; evidence: string[]; missing: string; acIds: string[]; cause: GapCause | null }
export type GapsReport = { items: GapItem[] } | { unavailable: string };
/** A doc section the user accepted as out of scope. */
export interface GapDecision { doc: string; heading: string; note: string; at: string }
/** A question a blocked run asked the owner, with its choices and the answer given to it, if any. */
export interface RunDecision { taskId: string; question: string; options: Array<{ label: string; detail: string; recommended?: boolean }>; answer: string | null }
export interface Report {
  runId: string;
  specId: string;
  specHash: string;
  result: 'awaiting-validation' | 'verification-failed' | 'deploy-failed';
  service: { url: string; healthcheck: string; smoke: SmokeRow[]; e2e?: Array<{ acId: string; testId: string | null; status: string; reason?: string }>; port?: number; healthcheckPath?: string; kind?: 'api' | 'front' | 'mobile'; docsPath?: string; artifact?: string } | null;
  /** Every service of a services run; `service` is the first one. */
  services?: Array<{ service: string; url: string; healthcheck: string; port?: number; healthcheckPath?: string; kind?: 'api' | 'front'; docsPath?: string }>;
  deploy: { attempts: number; lastFailure: { attempt: number; stage: string; detail: string; rolledBack: boolean; rollbackHealthy: boolean | null; service?: string } | null };
  evidence: EvidenceRow[];
  delivered: string[];
  blocked: Array<{ taskId: string; reason: string }>;
  assumptions: string[];
  exploratoryScript: Array<{ acId: string; steps: string[] }>;
  securityFindings?: SecurityFinding[];
  tokens: { byRole: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>; total: { inputTokens: number; outputTokens: number; costUsd: number } };
  summary: string;
  gaps?: GapsReport;
}
/** The GitHub link of one test: the permalink to its line, and where that line is. */
export interface TestLink {
  url: string;
  path: string;
  line: number;
}
export interface RunDetail {
  runId: string;
  specId: string;
  projectId: string;
  repoUrl?: string | null;
  readme?: string | null;
  status: string;
  /** The spec was concluded: the run is read-only. */
  locked?: boolean;
  /** The owner lets the agents decide blocks: the screen offers no reprocess. */
  agentsDecide?: boolean;
  phase: number;
  report: Report | null;
  state: { status: string; order: string[]; tasks: TaskRow[] };
  finished: Record<string, unknown> | null;
  tokens: Usage;
  acceptanceCriteria: AcceptanceCriterion[];
  plan: PlanArtifact | ServicesPlanArtifact | null;
  gapDecisions?: GapDecision[];
  decisions?: RunDecision[];
}

const R = '/api';
export type StartedRun = { runId: string; queued?: undefined } | { queued: true; draftId: string };
/** Where a started spec is followed: its run, or the execution screen of the program that queued it. */
export const startedPath = (projectId: string, r: StartedRun) => (r.queued ? `/refine/${projectId}/${r.draftId}/program` : `/runs/${r.runId}`);
const jsonPost = (p: string, body?: unknown) => fetch(`${R}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
/** A repository card of the project page: its kind, what it is for, its counts, and its state. */
export interface RepoCardView {
  name: string;
  kind: string | null;
  responsibility: string;
  status: 'blocked' | 'running' | 'waiting' | 'refining' | 'done' | 'empty';
  specs: number;
  plans: number;
  tasks: number;
  tasksDone: number;
  blockers: number;
}

/** One spec of a repository's dashboard: its state, its plan, its tasks, and whether its run needs the owner. */
export interface RepoSpecView {
  specId: string;
  status: string;
  activeRunId: string | null;
  repository?: string;
  title: string | null;
  priority: string | null;
  dependsOn: string[];
  plan: boolean;
  tasks: number;
  blocked: boolean;
}

/** A repository's dashboard: the card, its integrations, its specs, and the last events of its runs. */
export interface RepoDetailView extends RepoCardView {
  integrations: string[];
  rows: RepoSpecView[];
  history: Array<{ at: string; type: string; runId: string; specId: string }>;
}

export const runApi = {
  repository: (projectId: string, repo: string) => fetch(`${R}/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repo)}`).then((r) => json<RepoDetailView>(r)),
  repositories: (projectId: string) => fetch(`${R}/projects/${encodeURIComponent(projectId)}/repositories`).then((r) => json<{ repositories: RepoCardView[] }>(r)).then((b) => b.repositories),
  projects: () => fetch(`${R}/projects`).then((r) => json<ProjectRow[]>(r)),
  addProject: (url: string) => jsonPost('/projects', { url }).then((r) => json<ProjectRow>(r)),
  deleteProject: (projectId: string) => fetch(`${R}/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } }).then((r) => json<{ deleted: true }>(r)),
  runs: (projectId: string) => fetch(`${R}/projects/${encodeURIComponent(projectId)}/runs`).then((r) => json<RunRow[]>(r)),
  docs: (projectId: string) => fetch(`${R}/projects/${encodeURIComponent(projectId)}/docs`).then((r) => json<{ docs: ProjectDoc[] }>(r)),
  /** A spec a running backlog program owns is queued there instead: the answer names that program's draft. */
  startRun: (projectId: string, specId: string) => jsonPost(`/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/runs`).then((r) => json<StartedRun>(r)),
  resumeRun: (runId: string) => jsonPost(`/runs/${encodeURIComponent(runId)}/resume`).then((r) => json<{ runId: string }>(r)),
  decide: (runId: string, answers: Array<{ taskId: string; answer: string }>) => jsonPost(`/runs/${encodeURIComponent(runId)}/decisions`, { decisions: answers }).then((r) => json<{ saved: number }>(r)),
  serviceStatus: (runId: string) => fetch(`${R}/runs/${encodeURIComponent(runId)}/service`).then((r) => json<ServiceStatus>(r)),
  artifactUrl: (runId: string) => `${R}/runs/${encodeURIComponent(runId)}/artifact`,
  deployAgain: (projectId: string, specId: string) => jsonPost(`/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/deploy`).then((r) => json<{ runId: string }>(r)),
  complete: (projectId: string, specId: string) => jsonPost(`/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/complete`).then((r) => json<{ runId: string }>(r)),
  reportProblem: (projectId: string, specId: string, report: string) => jsonPost(`/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/continue`, { report }).then((r) => json<{ sessionId: string }>(r)),
  writeReadme: (runId: string) => jsonPost(`/runs/${encodeURIComponent(runId)}/readme`).then((r) => json<{ runId: string }>(r)),
  stopRun: (runId: string) => jsonPost(`/runs/${encodeURIComponent(runId)}/stop`).then((r) => json<{ stopped: boolean }>(r)),
  acceptGap: (runId: string, gap: { doc: string; heading: string; note: string }) => jsonPost(`/runs/${encodeURIComponent(runId)}/gaps/accept`, gap).then((r) => json<{ accepted: boolean }>(r)),
  run: (runId: string) => fetch(`${R}/runs/${encodeURIComponent(runId)}`).then((r) => json<RunDetail>(r)),
  step: (runId: string, stepId: string) => fetch(`${R}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}`).then((r) => json<{ prompt: string; output: unknown }>(r)),
  testLinks: (runId: string) => fetch(`${R}/runs/${encodeURIComponent(runId)}/test-links`).then((r) => json<Record<string, TestLink>>(r)),
  runEvents: (runId: string) => `${R}/runs/${encodeURIComponent(runId)}/events`,
};

export type RefineStatus = 'drafting' | 'evaluating' | 'answering' | 'ready' | 'error' | 'started';
export interface ChecklistItem {
  id: string;
  role: 'po' | 'sm' | 'front';
  passed: boolean;
  detail: string;
  divergences?: Divergence[];
}
/** A question the guard dropped as a repeat of a decided one, which the owner may ask again: the question as it was asked. */
export interface DroppedQuestionRow {
  questionId: string;
  role: 'po' | 'sm';
  text: string;
  cycle: number;
  blocking?: boolean;
  relatedAcIds?: string[];
  /** The document of a stage review's question; absent for a question of a full round or a plan question. */
  file?: 'project.md' | 'briefing.md' | 'stack.md' | 'flow.md' | 'design.md';
  origin?: 'speckit';
  command?: string;
  itemKey?: string;
  matchedQuestionId: string;
  matchedText: string;
  matchedAnswer: string | null;
}

export interface QuestionRow {
  questionId: string;
  role: 'po' | 'sm';
  text: string;
  blocking: boolean;
  relatedAcIds: string[];
  cycle: number;
  status: 'pending' | 'answered' | 'skipped';
  answer: string | null;
  answeredBy?: 'po' | 'sm' | null;
  /** The decided questions this plan question repeats, each with the difference the agent named. */
  distinctFrom?: Array<{ questionId: string; difference: string }>;
  subject?: string;
  /** The document of a stage review's question; absent for a question of a full round. */
  file?: 'project.md' | 'briefing.md' | 'stack.md' | 'flow.md' | 'design.md';
  options?: Array<{ label: string; detail: string; recommended?: boolean }>;
  /** Set on a question plan left open during its preparation. */
  origin?: 'speckit';
  /** The backlog item a plan question is about. */
  itemKey?: string;
  /** The plain words the owner reads about a plan question: what it is about and why it needs a decision. */
  context?: string;
  /** The quotes of the documents that back an answer the PO or SM gave. */
  evidence?: Array<{ file: string; heading: string; quote: string }>;
}
export interface PatchRow {
  patchId: string;
  role: 'po' | 'sm' | 'front';
  file: 'project.md' | 'briefing.md' | 'stack.md' | 'flow.md' | 'design.md';
  find: string;
  replace: string;
  reason: string;
  diff: string;
  cycle: number;
  status: 'pending' | 'accepted' | 'rejected' | 'dropped';
  decision: string | null;
}
export interface DerivedDoc {
  spec: {
    type: 'feature' | 'bug' | 'maintenance' | 'refactor';
    bug?: { actual: string; expected: string; reproduction: string; evidence?: string };
    acceptanceCriteria: AcceptanceCriterion[];
    tasks?: Array<{ title: string; description: string }>;
    externalDependencies: Array<{ name: string; secretNames: string[] }>;
  } & Record<string, unknown>;
  project: unknown;
}
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
/** A move the agents applied to two documents at once; the owner can undo it while neither document changed since. */
export interface MoveRow {
  moveId: string;
  role: 'po' | 'sm' | 'front';
  cycle: number;
  from: string;
  to: string;
  reason: string;
  quote: string;
  text: string;
  status: 'applied' | 'undone';
  closed?: boolean;
}
/** A stage document the agents rewrote in its template's shape; the owner can undo it while the document is unchanged. */
export interface ReshapeRow {
  reshapeId: string;
  file: string;
  cycle: number;
  role: 'po' | 'sm' | 'front';
  status: 'applied' | 'undone';
  closed?: boolean;
}
export interface BacklogViewItem {
  key: string;
  title: string;
  epic: string;
  /** The repository the item changes, in a repository session. */
  repository?: string;
  scope: string;
  priority: Priority;
  rationale: string;
  dependsOn: string[];
  sources: Array<{ doc: string; heading: string }>;
  size: 'S' | 'M' | 'L';
  rank: number;
}
/** A backlog item's derived spec, as the detailing writes it. */
export interface ItemSpecView {
  specId: string;
  type: string;
  objectives: string[];
  features: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  outOfScope: string[];
  externalDependencies: Array<{ name: string; purpose?: string; secretNames: string[] }>;
  status?: string;
}
/** The SM's pre-plan of one backlog spec. */
export interface PreplanView {
  specId: string;
  specRev: string;
  inputHash: string;
  modules: Array<{ name: string; purpose: string }>;
  tasks: Array<{ id: string; title: string; module: string; owner: string; criteriaRefs: string[]; dependsOn: string[] }>;
  risks: Array<{ risk: string; mitigation: string }>;
}
/** Backlog mode: the docs broken into epics and ranked items; absent or null when the session is a single spec. */
export interface BacklogView {
  enabled: boolean;
  project: unknown;
  epics: Array<{ key: string; title: string }>;
  items: BacklogViewItem[];
  cycle: number;
  /** The detailing is part of every evaluation: every item gets a spec and a pre-plan. */
  detail?: boolean;
  flowHeadings?: string[];
  specs?: Record<string, { inputHash: string; specId: string; rev: string | null; spec: ItemSpecView | null; issues: string[]; cycle: number }>;
  preplans?: Record<string, { inputHash: string; specRev: string; preplan: PreplanView | null; issues: string[]; cycle: number }>;
  acHighWater?: number;
}
/** One spec of the program that runs the backlog (server/program/controller.ts). */
export interface ProgramViewItem {
  specId: string;
  key: string;
  rank: number;
  dependsOn: string[];
  status: 'pending' | 'running' | 'completing' | 'waiting' | 'done' | 'partial' | 'failed' | 'blocked';
  runId: string | null;
  completeRunId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  reason: string | null;
  resumes: number;
  costUsd: number | null;
  /** The pull requests the item's runs opened. */
  prs?: Array<{ number: number; url: string }>;
  /** The run waits for the Claude quota or for a new login. */
  pause?: { reason: 'quota' | 'auth'; until?: string };
  /** The run in flight lost its process: the owner stopped it, or it died. */
  interrupted?: { runId: string };
  /** Asked to run now: it starts at the next free slot. */
  priority?: boolean;
  /** While waiting after an environment failure: when it starts again. */
  retryAt?: string;
}
export interface ProgramDecision {
  at: string;
  key: string;
  runId: string;
  decisionId: string;
  backend: string | null;
  escalated: boolean;
  answers: Array<{ question: string; value: string | number; confidence: number | null }>;
}
export interface ProgramView {
  version: 1;
  draftId: string;
  status: 'running' | 'finished';
  items: ProgramViewItem[];
  updatedAt: string;
}
export interface RefineState {
  status: RefineStatus;
  stale: boolean;
  cycle: number;
  derived: DerivedDoc | null;
  checklist: ChecklistItem[];
  questions: QuestionRow[];
  droppedQuestions?: DroppedQuestionRow[];
  patches: PatchRow[];
  moves: MoveRow[];
  reshapes: ReshapeRow[];
  discarded: Array<{ cycle: number; role: string; file: string; reason: string }>;
  error: string | null;
  runId: string | null;
  backlog?: BacklogView | null;
  mode?: 'new-project' | 'new-spec' | 'continue' | null;
  /** The backlog key a continued spec came from, which names its plan feature folder. */
  featureKey?: string;
  readiness?: Readiness;
  /** The documents the owner moved on from, in order, and the round the current stage began at. */
  doneStages?: string[];
  /** A repository session: the architecture gives the repositories and the start waits for the closing summary. */
  repositories?: boolean;
  /** The architecture the five documents support, with the hash of the documents it was decided on. */
  architecture?: { docsHash: string; decision: ArchitectureView } | null;
  /** The last architecture decision failed, with the reason in plain words. */
  architectureError?: string | null;
  /** The documents reviewed since their last human edit, in a repository session. */
  reviewedStages?: string[];
  /** The documents in the Graphify graph after their last edit, in a repository session. */
  graphed?: string[];
  /** The document whose graph extraction runs now, if any. */
  graphing?: string | null;
  /** The last graph extraction that failed, with the reason in plain words. */
  graphError?: { file: string; reason: string } | null;
  /** The documents whose passed text is kept, so a stage can be reprocessed from it. */
  passedStages?: string[];
  /** The owner moved on from the final review to the backlog. */
  reviewClosed?: boolean;
  stageStartCycle?: number;
  stages?: boolean;
  confidential?: boolean;
  outdatedDocs?: string[];
  stageAlignment?: Record<string, string[]>;
  staleBy?: Record<string, string>;
  /** When the latest evaluation started and ended (ISO times); `endedAt` stays null while it runs. */
  evaluation?: { startedAt: string; endedAt: string | null };
  /** The plan preparation of a detailed backlog; stale once a document or the backlog changes after it. */
  speckit?: { status: 'running' | 'done' | 'failed'; startedAt?: string; running?: Array<{ command: string; itemKey?: string; startedAt?: string }>; steps: Array<{ command: string; itemKey?: string; startedAt?: string; endedAt?: string; reused?: boolean }>; total?: number; error?: string; detail?: string; stale: boolean; features?: Record<string, string> };
}
/** The architecture as the page shows it: the style, the reason, the repositories and the integrations between them. */
export interface ArchitectureView {
  style: 'monolith' | 'microservices';
  rationale: string;
  repositories: Array<{ name: string; responsibility: string; evidence: { doc: string; quote: string } }>;
  integrations: Array<{ consumer: string; provider: string; contract: string }>;
}

/** The closing summary a repository session shows before the owner authorizes the development. */
export interface ClosingSummary {
  ok: boolean;
  checks: Array<{ id: string; ok: boolean; detail: string }>;
  repositories: Array<{ name: string; specs: number; plans: number; tasks: number }>;
  assumptions: string[];
  summaryHash: string;
}

export interface Snapshot {
  projectId: string;
  specId: string;
  state: RefineState;
  docs: { 'project.md': string; 'briefing.md': string; 'stack.md': string; 'flow.md': string; 'design.md': string };
  /** The sha256 of each document on disk: a save sends the one its text was typed over. */
  hashes?: Partial<Record<'project.md' | 'briefing.md' | 'stack.md' | 'flow.md' | 'design.md', string>>;
  secrets: Array<{ name: string; present: boolean; hint: string | null; uses: Array<{ dependency: string; purpose: string }>; mentions: Array<{ doc: string; heading: string }> }>;
  tokens: { inputTokens: number; outputTokens: number; costUsd: number; steps: number };
  /** The seq of the last journal event the state holds. */
  seq?: number;
  /** The round after which Reavaliar stops. */
  limits?: { max: number };
  /** The closing summary of a repository session: the checks, the repositories, the assumptions, and the hash the owner authorizes. */
  closing?: ClosingSummary;
  /** The architecture was decided on documents that have changed since. */
  architectureStale?: boolean;
  /** Why each stage document cannot be continued as it is in format, in plain words; null when it can. */
  stageProblems?: Partial<Record<'project.md' | 'briefing.md' | 'stack.md' | 'flow.md' | 'design.md', string | null>>;
}
export interface DraftRow {
  projectId: string;
  specId: string;
  state: RefineStatus;
  registered: boolean;
}

export interface NameRequest {
  kind: 'project' | 'spec';
  projectId?: string;
  name: string;
  description: string;
}
export interface NameSuggestion {
  id: string;
  firstSpecId?: string;
}

const send = (method: string, p: string, body?: unknown) => fetch(`${R}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
export const refineApi = {
  list: () => fetch(`${R}/refine`).then((r) => json<DraftRow[]>(r)),
  newProject: (projectId: string, name: string, description = '', firstSpecId = '') => send('POST', '/projects/new', { projectId, name, description, firstSpecId }).then((r) => json<{ sessionId: string }>(r)),
  suggestName: (input: NameRequest) => send('POST', '/names/suggest', input).then((r) => json<NameSuggestion>(r)),
  newSpec: (projectId: string, specId: string, description = '') => send('POST', `/projects/${encodeURIComponent(projectId)}/specs`, { specId, description }).then((r) => json<{ sessionId: string }>(r)),
  continueSpec: (projectId: string, specId: string, report?: string) =>
    send('POST', `/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/continue`, { report }).then((r) => json<{ sessionId: string }>(r)),
  restartSpec: (projectId: string, specId: string) =>
    send('POST', `/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/restart`).then((r) => json<{ sessionId: string }>(r)),
  snapshot: (p: string, s: string) => fetch(`${R}/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}`).then((r) => json<Snapshot>(r)),
  delete: (p: string, s: string) => send('DELETE', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}`).then((r) => json<{ ok: true }>(r)),
  saveDoc: (p: string, s: string, file: 'project.md' | 'briefing.md' | 'stack.md' | 'flow.md' | 'design.md', text: string, baseHash?: string) => send('PUT', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/docs/${file}`, { text, baseHash }).then((r) => json<{ ok: true; hash: string }>(r)),
  suggestDoc: (p: string, s: string, file: 'project.md' | 'briefing.md' | 'stack.md' | 'design.md') => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/docs/${file}/suggest`).then((r) => json<{ text: string }>(r)),
  suggestDesignFromImages: (p: string, s: string, images: { data: string }[]) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/docs/design.md/images`, { images }).then((r) => json<{ text: string }>(r)),
  enableBacklog: (p: string, s: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/backlog`).then((r) => json<{ ok: true }>(r)),
  undoMove: (p: string, s: string, moveId: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/moves/${encodeURIComponent(moveId)}/undo`).then((r) => json<{ ok: true }>(r)),
  undoReshape: (p: string, s: string, reshapeId: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/reshapes/${encodeURIComponent(reshapeId)}/undo`).then((r) => json<{ ok: true }>(r)),
  closeNotice: (p: string, s: string, noticeId: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/notices/${encodeURIComponent(noticeId)}/close`).then((r) => json<{ ok: true }>(r)),
  evaluate: (p: string, s: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/evaluate`).then((r) => json<{ state: string }>(r)),
  answer: (p: string, s: string, questionId: string, text: string, docsAnswered = false) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/answers`, { questionId, text, docsAnswered }).then((r) => json<{ ok: true }>(r)),
  skip: (p: string, s: string, questionId: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/questions/${encodeURIComponent(questionId)}/skip`).then((r) => json<{ ok: true }>(r)),
  reask: (p: string, s: string, questionId: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/questions/${encodeURIComponent(questionId)}/reask`).then((r) => json<{ ok: true }>(r)),
  accept: (p: string, s: string, patchId: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/patches/${encodeURIComponent(patchId)}/accept`).then((r) => json<{ ok: true }>(r)),
  reject: (p: string, s: string, patchId: string, reason: string | null) =>
    send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/patches/${encodeURIComponent(patchId)}/reject`, { reason: reason ?? undefined }).then((r) => json<{ ok: true }>(r)),
  secret: (p: string, s: string, name: string, value: string) => send('PUT', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/secrets/${encodeURIComponent(name)}`, { value }).then((r) => json<{ present: boolean; hint: string }>(r)),
  decideArchitecture: (p: string, s: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/architecture`).then((r) => json<{ ok: boolean }>(r)),
  start: (p: string, s: string, summaryHash?: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/start`, summaryHash === undefined ? undefined : { summaryHash }).then((r) => json<{ runId: string; program?: ProgramView }>(r)),
  score: (p: string, s: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/score`).then((r) => json<{ ok: true }>(r)),
  scoreDoc: (p: string, s: string, file: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/docs/${encodeURIComponent(file)}/score`).then((r) => json<{ ok: true }>(r)),
  continueStage: (p: string, s: string, doc?: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/stage/continue`, doc ? { doc } : undefined).then((r) => json<{ ok: true }>(r)),
  closeReview: (p: string, s: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/review/close`).then((r) => json<{ ok: true }>(r)),
  reprocessStage: (p: string, s: string, file: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/docs/${encodeURIComponent(file)}/reprocess`).then((r) => json<{ ok: true }>(r)),
  plans: (p: string, s: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/plans`).then((r) => json<{ ok: true }>(r)),
  evaluateStage: (p: string, s: string, file: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/docs/${encodeURIComponent(file)}/evaluate`).then((r) => json<{ ok: true }>(r)),
  confidential: (p: string, s: string, confidential: boolean) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/confidential`, { confidential }).then((r) => json<{ ok: true }>(r)),
  program: (p: string, s: string) => fetch(`${R}/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/program`).then((r) => json<{ program: ProgramView | null }>(r)),
  programDecisions: (p: string, s: string) => fetch(`${R}/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/program/decisions`).then((r) => json<{ decisions: ProgramDecision[]; unanswered: number }>(r)),
  prioritize: (p: string, s: string, item: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/program/${encodeURIComponent(item)}/prioritize`).then((r) => json<{ program: ProgramView }>(r)),
  events: (p: string, s: string) => `${R}/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/events`,
};

export interface ChatCorrection {
  title: string;
  specId?: string;
  error?: string;
}
export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  seconds: number;
  turns: number;
}
export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  correction?: ChatCorrection;
  usage?: ChatUsage;
}
const chatUrl = (projectId: string) => `${R}/chat/${encodeURIComponent(projectId)}`;
export const chatApi = {
  messages: (projectId: string) => fetch(chatUrl(projectId)).then((r) => json<{ messages: ChatMessage[] }>(r)),
  ask: (projectId: string, text: string) => jsonPost(`/chat/${encodeURIComponent(projectId)}/messages`, { text }).then((r) => json<{ message: ChatMessage | null }>(r)),
  clear: (projectId: string) => fetch(chatUrl(projectId), { method: 'DELETE', headers: { 'content-type': 'application/json' } }).then((r) => json<{ ok: true }>(r)),
};
