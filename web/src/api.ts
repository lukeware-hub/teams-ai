import { authFetch } from './auth.js';
export type ItemName = 'claude' | 'githubOwner' | 'ghLogin' | 'githubToken' | 'openrouterKey';
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
  status: () => authFetch(`${P}/status`).then((r) => json<Status>(r)),
  organizations: () => authFetch(`${P}/github-organizations`).then((r) => json<{ organizations: string[]; owner: string | null }>(r)),
  login: (cli: Cli) => authFetch(`${P}/${cli}/login`, { method: 'POST', headers: { 'content-type': 'application/json' } }).then((r) => json<{ state: SessionState }>(r)),
  cancel: (cli: Cli) => authFetch(`${P}/${cli}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' } }).then((r) => json<{ state: SessionState }>(r)),
  code: (cli: Cli, code: string) => authFetch(`${P}/${cli}/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }).then((r) => json<{ state: SessionState }>(r)),
  owner: (owner: string) => authFetch(`${P}/github-owner`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner }) }).then((r) => json<{ item: Item }>(r)),
  secret: (name: 'GITHUB_TOKEN' | 'OPENROUTER_API_KEY', value: string) => authFetch(`${P}/secrets/${name}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) }).then((r) => json<{ item: Item }>(r)),
  events: (cli: Cli) => `${P}/${cli}/events`,
};

export interface SpecRow {
  specId: string;
  status: string;
  activeRunId: string | null;
}
export interface ProjectRow {
  projectId: string;
  dir: string;
  specs: SpecRow[];
}
export interface RunRow {
  runId: string;
  specId: string;
  projectId: string;
  status: string;
  at: string | null;
  tokens: number;
  cost: number;
  stoppable: boolean;
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
  tasks: Array<{ id: string; title: string; description: string; criteriaRefs: string[]; dependsOn: string[]; affectedPaths: string[]; owner: string; origin: string }>;
  deploy: { image: string; port: number; healthcheckPath: string; manifests: string[] };
}
export interface SmokeRow { acId: string; testId: string | null; status: 'passed' | 'failed' | 'missing' }
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
  checkedAt: string;
}
export interface Report {
  runId: string;
  specId: string;
  specHash: string;
  result: 'awaiting-validation' | 'verification-failed' | 'deploy-failed';
  service: { url: string; healthcheck: string; smoke: SmokeRow[]; e2e?: Array<{ acId: string; testId: string | null; status: string; reason?: string }>; port?: number; healthcheckPath?: string; kind?: 'api' | 'front'; docsPath?: string } | null;
  deploy: { attempts: number; lastFailure: { attempt: number; stage: string; detail: string; rolledBack: boolean; rollbackHealthy: boolean | null } | null };
  evidence: EvidenceRow[];
  delivered: string[];
  blocked: Array<{ taskId: string; reason: string }>;
  assumptions: string[];
  exploratoryScript: Array<{ acId: string; steps: string[] }>;
  securityFindings?: SecurityFinding[];
  tokens: { byRole: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>; total: { inputTokens: number; outputTokens: number; costUsd: number } };
  summary: string;
}
export interface RunDetail {
  runId: string;
  specId: string;
  projectId: string;
  repoUrl?: string | null;
  readme?: string | null;
  status: string;
  phase: number;
  report: Report | null;
  state: { status: string; order: string[]; tasks: TaskRow[] };
  finished: Record<string, unknown> | null;
  tokens: Usage;
  acceptanceCriteria: AcceptanceCriterion[];
  plan: PlanArtifact | null;
}

const R = '/api';
const jsonPost = (p: string, body?: unknown) => authFetch(`${R}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
export const runApi = {
  projects: () => authFetch(`${R}/projects`).then((r) => json<ProjectRow[]>(r)),
  addProject: (url: string) => jsonPost('/projects', { url }).then((r) => json<ProjectRow>(r)),
  runs: (projectId: string) => authFetch(`${R}/projects/${encodeURIComponent(projectId)}/runs`).then((r) => json<RunRow[]>(r)),
  startRun: (projectId: string, specId: string) => jsonPost(`/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/runs`).then((r) => json<{ runId: string }>(r)),
  resumeRun: (runId: string) => jsonPost(`/runs/${encodeURIComponent(runId)}/resume`).then((r) => json<{ runId: string }>(r)),
  serviceStatus: (runId: string) => authFetch(`${R}/runs/${encodeURIComponent(runId)}/service`).then((r) => json<ServiceStatus>(r)),
  deployAgain: (projectId: string, specId: string) => jsonPost(`/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/deploy`).then((r) => json<{ runId: string }>(r)),
  complete: (projectId: string, specId: string) => jsonPost(`/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/complete`).then((r) => json<{ runId: string }>(r)),
  reportProblem: (projectId: string, specId: string, report: string) => jsonPost(`/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/continue`, { report }).then((r) => json<{ sessionId: string }>(r)),
  writeReadme: (runId: string) => jsonPost(`/runs/${encodeURIComponent(runId)}/readme`).then((r) => json<{ runId: string }>(r)),
  stopRun: (runId: string) => jsonPost(`/runs/${encodeURIComponent(runId)}/stop`).then((r) => json<{ stopped: boolean }>(r)),
  run: (runId: string) => authFetch(`${R}/runs/${encodeURIComponent(runId)}`).then((r) => json<RunDetail>(r)),
  step: (runId: string, stepId: string) => authFetch(`${R}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}`).then((r) => json<{ prompt: string; output: unknown }>(r)),
  runEvents: (runId: string) => `${R}/runs/${encodeURIComponent(runId)}/events`,
};

export type RefineStatus = 'drafting' | 'evaluating' | 'answering' | 'ready' | 'error' | 'started';
export interface ChecklistItem {
  id: string;
  role: 'po' | 'sm' | 'front';
  passed: boolean;
  detail: string;
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
}
export interface PatchRow {
  patchId: string;
  role: 'po' | 'sm' | 'front';
  file: 'project.md' | 'brief.md' | 'stack.md' | 'flow.md' | 'design.md';
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
export interface RefineState {
  status: RefineStatus;
  stale: boolean;
  cycle: number;
  derived: DerivedDoc | null;
  checklist: ChecklistItem[];
  questions: QuestionRow[];
  patches: PatchRow[];
  discarded: Array<{ cycle: number; role: string; file: string; reason: string }>;
  error: string | null;
  runId: string | null;
}
export interface Snapshot {
  projectId: string;
  specId: string;
  state: RefineState;
  docs: { 'project.md': string; 'brief.md': string; 'stack.md': string; 'flow.md': string; 'design.md': string };
  secrets: Array<{ name: string; present: boolean; hint: string | null }>;
  tokens: { inputTokens: number; outputTokens: number; costUsd: number; steps: number };
}
export interface DraftRow {
  projectId: string;
  specId: string;
  state: RefineStatus;
  registered: boolean;
}

const send = (method: string, p: string, body?: unknown) => authFetch(`${R}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
export const refineApi = {
  list: () => authFetch(`${R}/refine`).then((r) => json<DraftRow[]>(r)),
  newProject: (projectId: string, name: string, description = '') => send('POST', '/projects/new', { projectId, name, description }).then((r) => json<{ sessionId: string }>(r)),
  newSpec: (projectId: string, specId: string, description = '') => send('POST', `/projects/${encodeURIComponent(projectId)}/specs`, { specId, description }).then((r) => json<{ sessionId: string }>(r)),
  continueSpec: (projectId: string, specId: string, report?: string) =>
    send('POST', `/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/continue`, { report }).then((r) => json<{ sessionId: string }>(r)),
  snapshot: (p: string, s: string) => authFetch(`${R}/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}`).then((r) => json<Snapshot>(r)),
  saveDoc: (p: string, s: string, file: 'project.md' | 'brief.md' | 'stack.md' | 'flow.md' | 'design.md', text: string) => send('PUT', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/docs/${file}`, { text }).then((r) => json<{ ok: true }>(r)),
  evaluate: (p: string, s: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/evaluate`).then((r) => json<{ state: string }>(r)),
  answer: (p: string, s: string, questionId: string, text: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/answers`, { questionId, text }).then((r) => json<{ ok: true }>(r)),
  skip: (p: string, s: string, questionId: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/questions/${encodeURIComponent(questionId)}/skip`).then((r) => json<{ ok: true }>(r)),
  accept: (p: string, s: string, patchId: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/patches/${encodeURIComponent(patchId)}/accept`).then((r) => json<{ ok: true }>(r)),
  reject: (p: string, s: string, patchId: string, reason: string | null) =>
    send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/patches/${encodeURIComponent(patchId)}/reject`, { reason: reason ?? undefined }).then((r) => json<{ ok: true }>(r)),
  secret: (p: string, s: string, name: string, value: string) => send('PUT', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/secrets/${encodeURIComponent(name)}`, { value }).then((r) => json<{ present: boolean; hint: string }>(r)),
  start: (p: string, s: string) => send('POST', `/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/start`).then((r) => json<{ runId: string }>(r)),
  events: (p: string, s: string) => `${R}/refine/${encodeURIComponent(p)}/${encodeURIComponent(s)}/events`,
};
