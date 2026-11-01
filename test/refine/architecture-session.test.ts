import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createNewProject, draftPaths, writeDoc, type DocFile } from '../../server/refine/draft.js';
import { DOC_STAGES } from '../../server/refine/doc-stages.js';
import { RefineSession } from '../../server/refine/session.js';
import { calls, makeFakeRunAgent, type Script } from '../fixtures/fake-run-agent.js';

let root = '';
let ws: Workspace;
let secretsDir = '';
let script: Script;

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

const draft = () => draftPaths(ws, 'hello-001');
const deps = () => ({ ws, draft: draft(), runAgent: makeFakeRunAgent(script), secretsDir, retrieval: () => [] });

/** A graphify stand-in: one node per document of the folder. */
async function extractDocs(dir: string, outDir: string): Promise<void> {
  const files = await fs.readdir(dir);
  await fs.mkdir(path.join(outDir, 'graphify-out'), { recursive: true });
  await fs.writeFile(path.join(outDir, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: files.map((file) => ({ id: file, source_file: file })), edges: [], input_tokens: 10, output_tokens: 5 }));
}

const MONOLITH = {
  style: 'monolith',
  rationale: 'O project.md descreve uma aplicação única.',
  repositories: [{ name: 'hello-app', responsibility: 'Entrega a saudação', evidence: { doc: 'project.md', quote: 'entrega uma saudação ao usuário' } }],
  integrations: [],
  questions: [],
};
const MICROSERVICES = {
  style: 'microservices',
  rationale: 'O flow.md separa o servidor da tela.',
  repositories: [
    { name: 'hello-api', responsibility: 'Responde a saudação', evidence: { doc: 'project.md', quote: 'entrega uma saudação ao usuário' } },
    { name: 'hello-web', responsibility: 'Mostra a tela', evidence: { doc: 'design.md', quote: 'Tela simples com um botão' } },
  ],
  integrations: [{ consumer: 'hello-web', provider: 'hello-api', contract: 'GET /greeting' }],
  questions: [],
};
/** The microservices answer with one name that has no suffix: the validator refuses it. */
const NO_SUFFIX = { ...MICROSERVICES, repositories: [{ ...MICROSERVICES.repositories[0]!, name: 'hello' }, MICROSERVICES.repositories[1]!] };

/** Writes the five documents and runs each stage through its review, its extraction and its advance. */
async function completeStages(s: RefineSession): Promise<void> {
  for (const file of DOC_STAGES) await writeDoc(draft(), file, DOCS[file]);
  script['refine/po'] = [refineOut(green(PO)), refineOut(green(PO)), refineOut(green(PO))];
  script['refine/sm'] = [refineOut(green(['sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions', 'sm.flow-is-mermaid']))];
  script['refine/front'] = [refineOut([])];
  for (const file of DOC_STAGES) {
    await s.evaluateStage(file);
    await s.continueStage();
    await s.settled();
  }
}

const architectureCalls = () => calls.filter((c) => c.kind === 'architecture');

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-architecture-session-'))).replace(/\\/g, '/');
  secretsDir = `${root}/secrets`;
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
  await createNewProject(draft(), 'Hello');
  script = {};
  calls.length = 0;
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe('architecture decision of a repository session', () => {
  it('waits for the five documents in the graph before it decides', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await expect(s.decideArchitecture()).rejects.toThrow(/Conclua as etapas dos documentos antes/);
    await s.close();
  });

  it('decides the architecture, writes it into the draft, and marks it current', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await completeStages(s);
    script['architecture/sm'] = [MONOLITH];
    await s.decideArchitecture();
    await s.settled();
    expect(s.state.architecture?.decision).toMatchObject({ style: 'monolith', repositories: [{ name: 'hello-app' }] });
    expect(s.state.architectureError ?? null).toBeNull();
    expect((await s.snapshot()).architectureStale).toBe(false);
    const written = JSON.parse(await fs.readFile(path.join(draft().root, 'docs', 'architecture.json'), 'utf8'));
    expect(written).toMatchObject({ style: 'monolith' });
    expect(await fs.readFile(path.join(draft().root, 'docs', 'architecture.md'), 'utf8')).toContain('# Arquitetura');
    await s.close();
  });

  it('holds the backlog until the architecture is decided', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await completeStages(s);
    await expect(s.enableBacklog()).rejects.toThrow('Decida a arquitetura antes do backlog.');
    await s.close();
  });

  it('sends one broken rule back to the agent with the rule named, and keeps the second answer', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await completeStages(s);
    script['architecture/sm'] = [NO_SUFFIX, MICROSERVICES];
    await s.decideArchitecture();
    await s.settled();
    const attempts = architectureCalls();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.prompt).toContain('precisa terminar com um sufixo');
    expect(s.state.architecture?.decision.repositories.map((r) => r.name)).toEqual(['hello-api', 'hello-web']);
    await s.close();
  });

  it('stops after two broken answers, journals the reason, and keeps the backlog closed', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await completeStages(s);
    script['architecture/sm'] = [NO_SUFFIX, NO_SUFFIX];
    await s.decideArchitecture();
    await s.settled();
    expect(s.state.architecture ?? null).toBeNull();
    expect(s.state.architectureError).toContain('A arquitetura não fechou com as regras.');
    await expect(s.enableBacklog()).rejects.toThrow('Decida a arquitetura antes do backlog.');
    await s.close();
  });

  it('turns an open split into a blocking question that holds the backlog until the owner answers', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await completeStages(s);
    const asked = { ...MICROSERVICES, questions: [{ text: 'O pagamento fica no hello-api?', context: 'O project.md não diz onde ele roda.', blocking: true, options: [{ label: 'Sim', detail: 'Fica no hello-api.' }] }] };
    script['architecture/sm'] = [asked];
    await s.decideArchitecture();
    await s.settled();
    const question = s.state.questions.find((q) => q.origin === 'architecture');
    expect(question).toMatchObject({ status: 'pending', blocking: true, role: 'sm' });
    await expect(s.enableBacklog()).rejects.toThrow('Responda as perguntas da arquitetura antes do backlog.');
    await s.answer(question!.questionId, 'Sim');
    script['architecture/sm'] = [MICROSERVICES];
    await s.decideArchitecture();
    await s.settled();
    expect(s.state.questions.filter((q) => q.origin === 'architecture' && q.status === 'pending')).toEqual([]);
    expect(s.state.questions.find((q) => q.origin === 'architecture' && q.status === 'answered')?.answer).toBe('Sim');
    await s.enableBacklog();
    expect(s.state.backlog?.enabled).toBe(true);
    await s.close();
  });

  it('marks the architecture stale after an edit, and the backlog waits for a new decision once the document is graphed again', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await completeStages(s);
    script['architecture/sm'] = [MICROSERVICES];
    await s.decideArchitecture();
    await s.settled();
    await s.saveDoc('flow.md', `${FLOW}\nEditado depois da arquitetura.\n`);
    expect((await s.snapshot()).architectureStale).toBe(true);
    script['refine/po'] = [refineOut(green(PO))];
    await s.evaluateStage('flow.md');
    await s.continueStage('flow.md');
    await s.settled();
    expect(s.state.graphed).toContain('flow.md');
    await expect(s.enableBacklog()).rejects.toThrow('Os documentos mudaram depois da arquitetura: decida a arquitetura de novo.');
    await s.close();
  });

  it('a restart during the architecture decision does not leave the session evaluating', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: true });
    await completeStages(s);
    const seq = s.events.length + 1;
    await s.close();
    await fs.appendFile(draft().events, `${JSON.stringify({ seq, at: new Date().toISOString(), runId: 'hello-app/hello-001', specHash: 'draft', type: 'REFINE_EVALUATION_STARTED', kind: 'fact', data: {} })}
`);
    const again = await RefineSession.open({ ...deps(), extractDocs });
    expect(again.state.status).not.toBe('evaluating');
    await again.close();
  });

  it('refuses the decision in a draft that was not stamped with the repository flow', async () => {
    const s = await RefineSession.create({ ...deps(), extractDocs }, 'new-project', { repositories: false });
    await expect(s.decideArchitecture()).rejects.toThrow('só um refinamento com repositórios decide a arquitetura');
    await s.close();
  });
});
