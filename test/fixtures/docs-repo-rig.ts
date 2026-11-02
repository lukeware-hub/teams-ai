import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunControlDeps } from '../../server/api/run-control.js';
import type { RunAgent } from '../../server/refine/cycle.js';
import type { Exec } from '../../server/exec/command.js';
import { readUserConfig } from '../../server/onboarding/config-store.js';
import { workspacePaths, type Workspace } from '../../server/orchestrator/workspace.js';
import { draftPaths, writeDoc, type Draft, type DocFile } from '../../server/refine/draft.js';
import { DOC_STAGES } from '../../server/refine/doc-stages.js';
import { SessionRegistry } from '../../server/refine/registry.js';
import type { RefineSession } from '../../server/refine/session.js';
import { makeProject, makeSpec } from './contracts.js';
import { makeFakeRunAgent, type Script } from './fake-run-agent.js';

export const PROJECT = 'hello-app';
const PO = ['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions'];
const green = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
const refineOut = (checklist: unknown[], questions: unknown[] = [], docPatch: unknown[] = []) => ({ checklist, questions, docPatch });
const FLOW = '# Fluxo\n\n```mermaid\nflowchart TD\n  A[Início] --> B[Fim]\n```\n';
const DOCS: Record<DocFile, string> = {
  'project.md': '# Projeto\n\nO hello-app entrega uma saudação ao usuário.\n',
  'briefing.md': '# Briefing\n\nO usuário pede uma saudação na tela inicial.\n',
  'stack.md': '# Stack\n\nNode e TypeScript no servidor.\n',
  'flow.md': FLOW,
  'design.md': '# Design\n\nTela simples com um botão.\n',
};

/** The spec and project a derivation returns for the hello-app project. */
export const DERIVED = { project: makeProject({ projectId: PROJECT }), spec: { ...makeSpec(), status: 'refining', specHash: null, repository: PROJECT } };

export const MONOLITH = {
  style: 'monolith',
  rationale: 'O project.md descreve uma aplicação única.',
  repositories: [{ name: 'hello-app', responsibility: 'Entrega a saudação', evidence: { doc: 'project.md', quote: 'entrega uma saudação ao usuário' } }],
  integrations: [],
  questions: [],
};
export const MICROSERVICES = {
  style: 'microservices',
  rationale: 'O flow.md separa o servidor da tela.',
  repositories: [
    { name: 'hello-api', responsibility: 'Responde a saudação', evidence: { doc: 'project.md', quote: 'entrega uma saudação ao usuário' } },
    { name: 'hello-web', responsibility: 'Mostra a tela', evidence: { doc: 'design.md', quote: 'Tela simples com um botão' } },
  ],
  integrations: [{ consumer: 'hello-web', provider: 'hello-api', contract: 'GET /greeting' }],
  questions: [],
};

/** A graphify stand-in: one node per document of the folder. */
async function extractDocs(dir: string, outDir: string): Promise<void> {
  const files = await fs.readdir(dir);
  await fs.mkdir(path.join(outDir, 'graphify-out'), { recursive: true });
  await fs.writeFile(path.join(outDir, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: files.map((file) => ({ id: file, source_file: file })), edges: [], input_tokens: 10, output_tokens: 5 }));
}

export interface Rig {
  home: string;
  ws: Workspace;
  draft: Draft;
  script: Script;
  registry: SessionRegistry;
  /** Removes the rig's folder. */
  close(): Promise<void>;
}

export interface RigOptions {
  docsRepoLayout?: boolean;
  /** The owner in the user's configuration, read when the project's document names none. */
  owner?: string;
  exec?: Exec;
  ghExec?: Exec;
}

/** A registry on a temporary home with a scripted refine agent, the first draft of the hello-app project, and no real GitHub. */
export async function makeRig(opts: RigOptions = {}): Promise<Rig> {
  const home = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-docs-rig-'))).replace(/\\/g, '/');
  await fs.mkdir(`${home}/.teams-ai`, { recursive: true });
  const github = opts.owner ? { owner: opts.owner } : {};
  await fs.writeFile(`${home}/.teams-ai/config.json`, JSON.stringify({ paths: { workspaces: `${home}/ws`, runs: `${home}/runs`, secrets: `${home}/secrets` }, projects: [], github }));
  const script: Script = {};
  const runAgent = makeFakeRunAgent(script) as RunAgent;
  const registry = new SessionRegistry({
    repositoryFlow: true,
    docsRepoLayout: opts.docsRepoLayout ?? false,
    cfg: async () => (await readUserConfig(home)).cfg,
    home,
    runAgent,
    extractDocs,
    secretsDir: `${home}/secrets`,
    exec: opts.exec ?? (async () => ({ exitCode: 1, signal: null, stdout: '', stderr: 'no exec', timedOut: false, durationMs: 1, truncated: false })),
    ghExec: opts.ghExec,
    projectDir: async () => null,
    control: {} as RunControlDeps,
    runsDir: async () => `${home}/runs`,
    register: async () => undefined,
  });
  const { cfg } = await readUserConfig(home);
  const ws = workspacePaths(cfg, PROJECT, home);
  return { home, ws, draft: draftPaths(ws, `${PROJECT}-001`), script, registry, close: () => fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

/** Writes the five documents and runs each stage through its review, its extraction and its advance. */
export async function completeStages(rig: Rig, s: RefineSession): Promise<void> {
  for (const file of DOC_STAGES) await writeDoc(rig.draft, file, DOCS[file]);
  rig.script['refine/po'] = [refineOut(green(PO)), refineOut(green(PO)), refineOut(green(PO))];
  rig.script['refine/sm'] = [refineOut(green(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions', 'sm.flow-is-mermaid']))];
  rig.script['refine/front'] = [refineOut([])];
  for (const file of DOC_STAGES) {
    await s.evaluateStage(file);
    await s.continueStage();
    await s.settled();
  }
}
