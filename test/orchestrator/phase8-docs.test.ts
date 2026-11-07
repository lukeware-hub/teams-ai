import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { APP_FOLDER, DOCS_TREE } from '../../server/docs/tree.js';
import { MergeQueue } from '../../server/git/merge-queue.js';
import { Journal, OrchEvent } from '../../server/orchestrator/events.js';
import { runDocsPhase } from '../../server/orchestrator/phases/docs.js';
import type { PhaseDeps } from '../../server/orchestrator/phases/index.js';
import type { AgentStepRequest } from '../../server/orchestrator/steps.js';
import type { StepOutcome } from '../../server/runner/step.js';
import type { ResultSummary } from '../../server/runner/stream-events.js';
import { makeFrozenSpec, makePlan, makeProject } from '../fixtures/contracts.js';
import { FakeExec } from '../fixtures/fake-exec.js';
import { FakeGh } from '../fixtures/fake-gh.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const spec = makeFrozenSpec();
const HASH = spec.specHash!;
const project = makeProject();
const plan = makePlan(spec);
const view = { service: null, plan };
const BRANCH = 'docs/spec-001-docs';
const summary: ResultSummary = { found: true, isError: false, subtype: 'success', numTurns: 1, durationMs: 1, costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, sessionId: null, resultText: null, structuredOutput: null, structuredSource: null, terminalReason: null, apiErrorStatus: null, rateLimit: null, compactions: 0 };
const ok = <T,>(value: T): StepOutcome<T> => ({ ok: true, value, summary });

const TEXT = 'Texto de apoio com conteúdo real para o leitor do documento.';
const HEADINGS = ['Executar', 'Testes', 'Variáveis de ambiente', 'Arquitetura', 'Pipeline', 'Iniciar', 'Parar', 'Logs', 'Rollback'].map((h) => `## ${h}\n\n${TEXT}\n`).join('\n');
const NA = 'Não se aplica: este repositório não tem esta parte do produto.';

/** Writes the whole tree: real text for the kinds the repository holds, "Não se aplica" for the others. */
async function writeTree(cwd: string, kinds: readonly string[]): Promise<void> {
  for (const file of DOCS_TREE) {
    const target = path.join(cwd, file.endsWith('/') ? `${file}README.md` : file);
    const kind = (['api', 'web', 'mobile'] as const).find((k) => file.startsWith(`docs/${APP_FOLDER[k]}/`));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, kind && !kinds.includes(kind) ? `${NA}\n` : `# ${file}\n\n${HEADINGS}\n`);
  }
}

let remote: Remote;
let journal: Journal;
let gh: FakeGh;
let calls: AgentStepRequest<any>[];

beforeEach(async () => {
  remote = await makeRemote({ 'docs/project.json': JSON.stringify(project), 'docs/specs/spec-001/spec.json': JSON.stringify(spec) });
  journal = await Journal.open({ file: path.join(remote.root, 'events.ndjson'), runId: 'r1', specHash: HASH });
  gh = new FakeGh();
  calls = [];
});
afterEach(async () => {
  await journal.close();
  await remote.cleanup();
});

function deps(agent: (req: AgentStepRequest<any>) => Promise<StepOutcome<any>>): PhaseDeps {
  const ghExec = new FakeExec().on((s) => s.bin === 'git', (s) => execCommand(s));
  gh.install(ghExec);
  const ws = { projectId: 'shop', root: remote.root, repo: remote.repo, worktrees: path.join(remote.root, 'wt'), graph: '', knowledgeDb: '', secrets: path.join(remote.root, 'secrets'), runs: remote.root };
  return {
    journal, ws, spec, project, specHash: HASH, firstSpec: true, exec: execCommand, plan,
    runAgent: (async (req) => { calls.push(req); return agent(req); }) as PhaseDeps['runAgent'],
    mergeQueue: new MergeQueue(),
    mergeDeps: { journal, ws, exec: execCommand, ghExec: ghExec.exec, gates: async () => ({ results: [], blockingFailure: null }), graphify: null, secretValues: () => [], handoffs: [], clock: () => new Date() },
    packBase: () => ({ spec, project, specHash: HASH, assumptions: [], budgetTokens: 8000 }),
    godNodes: async () => [],
  };
}

const writesTree = async (req: AgentStepRequest<any>) => {
  await writeTree(req.cwd, ['api']);
  return ok({ specHash: HASH, files: [{ path: 'docs/README.md', covers: [] }] });
};

describe('phase 8: docs', () => {
  it('writes the tree of the repository and merges it as one docs pull request', async () => {
    const outcome = await runDocsPhase(deps(writesTree), view);
    expect(outcome).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(journal.events.some((e) => e.type === OrchEvent.DocsMerged && e.data.branch === BRANCH)).toBe(true);
  });

  it('asks the agent again with the errors when the tree is incomplete', async () => {
    const agent = async (req: AgentStepRequest<any>) => (calls.length === 1 ? ok({ specHash: HASH, files: [] }) : writesTree(req));
    const outcome = await runDocsPhase(deps(agent), view);
    expect(outcome).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(String(calls[1]!.pack.feedback)).toContain('Your previous documents were rejected');
  });

  it('blocks the run after two rejected trees, and journals why', async () => {
    const outcome = await runDocsPhase(deps(async () => ok({ specHash: HASH, files: [] })), view);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.reason).toMatch(/^Phase 8 blocked: documentation rejected: /);
    expect(calls).toHaveLength(2);
    expect(journal.events.some((e) => e.type === OrchEvent.PhaseFailed && e.data.phase === 8)).toBe(true);
  });

  it('refuses a change to a main document', async () => {
    const agent = async (req: AgentStepRequest<any>) => {
      await writeTree(req.cwd, ['api']);
      await fs.writeFile(path.join(req.cwd, 'docs/project.md'), '# Changed by the docs step\n');
      return ok({ specHash: HASH, files: [{ path: 'docs/README.md', covers: [] }] });
    };
    const outcome = await runDocsPhase(deps(agent), view);
    expect(outcome.ok ? '' : outcome.reason).toContain('docs/project.md is a main document and must not change');
  });

  it('does nothing when its docs pull request already merged', async () => {
    await journal.fact(OrchEvent.DocsMerged, { phase: 8, pr: 1, branch: BRANCH });
    expect(await runDocsPhase(deps(writesTree), view)).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
  });
});
