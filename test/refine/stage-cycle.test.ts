import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyRefineEvent, emptyRefineState } from '../../server/refine/state.js';
import { createNewProject, draftPaths, readDoc } from '../../server/refine/draft.js';
import { RefineEvent } from '../../server/refine/events.js';
import { runStageCycle } from '../../server/refine/stage-cycle.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';

/** A journal that folds each fact into its state, as the session's journal does. */
function foldingJournal() {
  const state = emptyRefineState();
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  return {
    state,
    events,
    allocStepSeq: () => 1,
    fact: async (type: string, data: Record<string, unknown> = {}) => {
      events.push({ type, data });
      applyRefineEvent(state, { type, data });
      return { seq: events.length, at: '', runId: 'shop/shop-002', specHash: 'draft', type, kind: 'fact' as const, data };
    },
  };
}

async function newDraft() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-stage-'));
  const ws = { projectId: 'shop', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` } as Workspace;
  const draft = draftPaths(ws, 'shop-002');
  await createNewProject(draft, 'Shop');
  return draft;
}

/** The owner's answer for one stage: a change to the project document, a change to another document, and a question. */
const answer = (docPatch: unknown[], questions: unknown[] = []) => ({
  ok: true,
  value: { specHash: 'draft', checklist: [], questions, docPatch, contradictions: [], findings: [], moves: [] },
  summary: { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, durationMs: 0, numTurns: 0, rateLimit: null },
  sandboxDisabled: false,
});

describe('runStageCycle', () => {
  it('proposes changes to the stage document only, records the questions, and takes that document’s score', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async () => answer(
      [
        { file: 'docs/project.md', find: '# Shop', replace: '# Shop Online', reason: 'nome' },
        { file: 'docs/flow.md', find: '# Flow', replace: '# Flow 2', reason: 'outro documento' },
      ],
      [{ id: 'q1', text: 'Qual o prazo?', blocking: true, relatedAcIds: [], options: [{ label: 'Trinta dias', detail: 'prazo curto', recommended: true }, { label: 'Sessenta dias', detail: 'prazo longo' }], subject: 'Prazo de entrega' }],
    ));
    const scoreDocs = vi.fn(async (_docs: Record<string, string>, files?: readonly string[]) => ({ available: true, model: 'jev', average: 0.8, docs: Object.fromEntries((files ?? []).map((f) => [f, { score: 0.8, checks: { complete: 0.8, concrete: 0.8, consistent: 0.8, scoped: 0.8 } }])), usage: null }));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], scoreDocs }, 1, 'project.md');
    const proposed = journal.events.filter((e) => e.type === RefineEvent.PatchProposed);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.data).toMatchObject({ file: 'project.md', role: 'po', cycle: 1 });
    expect(journal.state.questions).toEqual([expect.objectContaining({ questionId: 'po-s1-0', text: 'Qual o prazo?', blocking: true, status: 'pending' })]);
    expect(scoreDocs.mock.calls[0]![1]).toEqual(['project.md']);
    expect(journal.state.readiness).toMatchObject({ available: true });
  });

  it('a design document is reviewed by Front, and only when Front is wired; the other documents by their owner', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async () => answer([]));
    const frontAgent = vi.fn(async () => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, frontAgent: frontAgent as never, principles: () => [] }, 1, 'design.md');
    expect(frontAgent).toHaveBeenCalledTimes(1);
    expect(runAgent).not.toHaveBeenCalled();
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 2, 'design.md');
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it('a stack document is reviewed by the SM', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async (_req: unknown) => answer([]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'stack.md');
    expect(runAgent.mock.calls[0]![0]).toMatchObject({ role: 'sm' });
  });

  it('a failed review fails the cycle with its reason, and changes nothing', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async () => ({ ok: false, failure: 'schema', errors: ['bad json'], summary: undefined, sandboxDisabled: false }));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: 'stage review failed: schema: bad json' });
    expect(journal.events.some((e) => e.type === RefineEvent.PatchProposed)).toBe(false);
  });

  it('a review that cannot be read fails the cycle without throwing, and nothing is proposed', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async () => { throw new Error('agent down'); });
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: 'agent down' });
    expect(await readDoc(draft, 'project.md')).toContain('# Shop');
  });

  it('a stage review leaves the checklist of the last full round as it was, and journals no full evaluation', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const checked = { id: 'po.personas' as const, role: 'po' as const, passed: true, detail: 'ok' };
    journal.state.checklist = [checked];
    const runAgent = vi.fn(async () => answer([], [{ id: 'q1', text: 'Quem usa?', blocking: false, relatedAcIds: [], options: [] }]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.state.checklist).toEqual([checked]);
    expect(journal.events.some((e) => e.type === RefineEvent.Evaluated)).toBe(false);
  });

  it('a question without choices or subject is recorded without them', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async () => answer([], [{ id: 'q2', text: 'Quem aprova?', blocking: false, relatedAcIds: [], options: [] }]));
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    const [question] = journal.state.questions;
    expect(question).toMatchObject({ questionId: 'po-s1-0', text: 'Quem aprova?', blocking: false });
    expect(question).not.toHaveProperty('options');
    expect(question).not.toHaveProperty('subject');
  });

  it('a review that throws a text, not an error, fails the cycle with that text', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const runAgent = vi.fn(async () => { throw 'agent stopped'; });
    await runStageCycle({ draft, journal, runAgent: runAgent as never, principles: () => [] }, 1, 'project.md');
    expect(journal.events.find((e) => e.type === RefineEvent.CycleFailed)?.data).toMatchObject({ cycle: 1, reason: 'agent stopped' });
  });
});
