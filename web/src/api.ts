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
  status: () => fetch(`${P}/status`).then((r) => json<Status>(r)),
  login: (cli: Cli) => fetch(`${P}/${cli}/login`, { method: 'POST' }).then((r) => json<{ state: SessionState }>(r)),
  cancel: (cli: Cli) => fetch(`${P}/${cli}/cancel`, { method: 'POST' }).then((r) => json<{ state: SessionState }>(r)),
  code: (cli: Cli, code: string) => fetch(`${P}/${cli}/code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }).then((r) => json<{ state: SessionState }>(r)),
  owner: (owner: string) => fetch(`${P}/github-owner`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner }) }).then((r) => json<{ item: Item }>(r)),
  secret: (name: 'GITHUB_TOKEN' | 'OPENROUTER_API_KEY', value: string) => fetch(`${P}/secrets/${name}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) }).then((r) => json<{ item: Item }>(r)),
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
  def: { id: string; title: string; owner: string; dependsOn: string[]; criteriaRefs: string[] };
  state: string;
  attempts: number;
  replanned: boolean;
  replacedBy: string[];
}
export interface RunDetail {
  runId: string;
  specId: string;
  projectId: string;
  status: string;
  state: { status: string; order: string[]; tasks: TaskRow[] };
  finished: Record<string, unknown> | null;
  tokens: Usage;
  acceptanceCriteria: AcceptanceCriterion[];
}

const R = '/api';
const jsonPost = (p: string, body?: unknown) => fetch(`${R}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
export const runApi = {
  projects: () => fetch(`${R}/projects`).then((r) => json<ProjectRow[]>(r)),
  addProject: (dir: string) => jsonPost('/projects', { dir }).then((r) => json<ProjectRow>(r)),
  runs: (projectId: string) => fetch(`${R}/projects/${encodeURIComponent(projectId)}/runs`).then((r) => json<RunRow[]>(r)),
  startRun: (projectId: string, specId: string) => jsonPost(`/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/runs`).then((r) => json<{ runId: string }>(r)),
  resumeRun: (runId: string) => jsonPost(`/runs/${encodeURIComponent(runId)}/resume`).then((r) => json<{ runId: string }>(r)),
  stopRun: (runId: string) => jsonPost(`/runs/${encodeURIComponent(runId)}/stop`).then((r) => json<{ stopped: boolean }>(r)),
  run: (runId: string) => fetch(`${R}/runs/${encodeURIComponent(runId)}`).then((r) => json<RunDetail>(r)),
  step: (runId: string, stepId: string) => fetch(`${R}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}`).then((r) => json<{ prompt: string; output: unknown }>(r)),
  runEvents: (runId: string) => `${R}/runs/${encodeURIComponent(runId)}/events`,
};
