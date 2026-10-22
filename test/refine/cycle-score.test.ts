import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { isConfidential, recordScore } from '../../server/refine/cycle.js';
import { createNewProject, draftPaths } from '../../server/refine/draft.js';
import { RefineEvent } from '../../server/refine/events.js';
import { applyRefineEvent, emptyRefineState } from '../../server/refine/state.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-score-'));
  const ws = { projectId: 'shop', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` } as Workspace;
  const draft = draftPaths(ws, 'shop-002');
  await createNewProject(draft, 'Shop');
  return draft;
}

const scored = (average: number) => ({ available: true, model: 'jev-1.13.0', average, docs: null, usage: null });

describe('recordScore', () => {
  it('keeps a current score, so the same documents are not sent again', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const scoreDocs = vi.fn(async (_docs: Record<string, string>) => scored(0.9));
    await recordScore({ draft, journal, scoreDocs }, 1, false);
    await recordScore({ draft, journal, scoreDocs }, 1, false);
    expect(scoreDocs).toHaveBeenCalledTimes(1);
  });

  it('scores again after a document changed, and the new score is current', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const scoreDocs = vi.fn(async (_docs: Record<string, string>) => scored(0.9));
    await recordScore({ draft, journal, scoreDocs }, 1, false);
    await journal.fact(RefineEvent.DocEdited, { file: 'flow.md', hash: 'x', source: 'human' });
    await recordScore({ draft, journal, scoreDocs }, 1, false);
    expect(scoreDocs).toHaveBeenCalledTimes(2);
    expect(journal.state.readiness).toMatchObject({ average: 0.9, outdated: false });
  });

  it('sends the documents as they stand when the score is taken', async () => {
    const draft = await newDraft();
    await writeFile(draft.flowMd, '# Fluxo\n\nAltered now.\n');
    const journal = foldingJournal();
    const scoreDocs = vi.fn(async (_docs: Record<string, string>) => scored(0.9));
    await recordScore({ draft, journal, scoreDocs }, 1, false);
    expect(scoreDocs.mock.calls[0]![0]['flow.md']).toContain('Altered now.');
  });

  it('journals a confidential project as skipped, never sends its documents, and does not journal the skip again', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const scoreDocs = vi.fn(async (_docs: Record<string, string>) => scored(0.9));
    await recordScore({ draft, journal, scoreDocs }, 1, true);
    await recordScore({ draft, journal, scoreDocs }, 1, true);
    expect(scoreDocs).not.toHaveBeenCalled();
    expect(journal.events.filter((e) => e.type === 'REFINE_DOCS_SCORED')).toHaveLength(1);
    expect(journal.state.readiness).toMatchObject({ skipped: 'confidential', available: false, average: null });
  });

  it('journals a failed score as unavailable, without throwing', async () => {
    const draft = await newDraft();
    const journal = foldingJournal();
    const scoreDocs = vi.fn(async (_docs: Record<string, string>): Promise<never> => { throw new Error('jev down'); });
    await expect(recordScore({ draft, journal, scoreDocs }, 1, false)).resolves.toBeUndefined();
    expect(journal.state.readiness).toMatchObject({ available: false, average: null, outdated: false });
  });
});

describe('isConfidential', () => {
  const outline = (confidential: boolean) => ({ ...emptyRefineState(), backlog: { enabled: true, project: makeProject({ confidential }), epics: [], items: [], cycle: 1 } }) as never;
  const withBase = async (confidential: boolean) => {
    const draft = await newDraft();
    const base = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-base-'));
    await writeFile(path.join(base, 'project.json'), JSON.stringify(makeProject({ confidential })));
    return { ...draft, base };
  };

  it('stays confidential when the base record says so, even when the outline carries the default false', async () => {
    expect(await isConfidential(await withBase(true), outline(false))).toBe(true);
  });

  it('is confidential when only the outline says so', async () => {
    expect(await isConfidential(await newDraft(), outline(true))).toBe(true);
  });

  it('is not confidential when no record says so', async () => {
    expect(await isConfidential(await withBase(false), outline(false))).toBe(false);
  });

  it('is confidential when the derived project says so', async () => {
    const draft = await newDraft();
    await writeFile(draft.projectJson, JSON.stringify(makeProject({ confidential: true })));
    await writeFile(draft.specJson, JSON.stringify(makeSpec()));
    expect(await isConfidential(draft, emptyRefineState())).toBe(true);
  });

  it('a stage session with no answer is confidential, so no document reaches the Jev before the owner answers', async () => {
    expect(await isConfidential(await newDraft(), { ...emptyRefineState(), stages: true })).toBe(true);
  });

  it('the owner answer that the project is confidential holds, even with no record', async () => {
    expect(await isConfidential(await newDraft(), { ...emptyRefineState(), stages: true, confidential: true })).toBe(true);
  });

  it('the owner answer that the project is not confidential lets the records decide, and a record that says yes still wins', async () => {
    expect(await isConfidential(await withBase(false), { ...emptyRefineState(), stages: true, confidential: false })).toBe(false);
    expect(await isConfidential(await withBase(true), { ...emptyRefineState(), stages: true, confidential: false })).toBe(true);
  });
});
