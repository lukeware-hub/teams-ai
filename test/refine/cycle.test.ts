import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCycle } from '../../server/refine/cycle.js';
import { emptyRefineState } from '../../server/refine/state.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';

describe('refinement cycle Jev advisory', () => {
  it('passes grave document findings to the agents without blocking derivation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'demo',
      specId: 'demo-001',
      root,
      docs,
      projectMd: path.join(docs, 'project.md'),
      projectJson: path.join(docs, 'project.json'),
      briefMd: path.join(docs, 'brief.md'),
      stackMd: path.join(docs, 'stack.md'),
      flowMd: path.join(docs, 'flow.md'),
      designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'),
      events: path.join(root, 'events.ndjson'),
      steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await Promise.all([
      writeFile(draft.projectMd, '# Project'),
      writeFile(draft.briefMd, '# Brief'),
      writeFile(draft.stackMd, '# Stack'),
      writeFile(draft.flowMd, '# Flow'),
      writeFile(draft.designMd, '# Design'),
    ]);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = {
      state: emptyRefineState(),
      allocStepSeq: () => 1,
      fact: async (type: string, data: Record<string, unknown>) => {
        events.push({ type, data });
        return { seq: events.length, at: '', runId: 'demo/demo-001', specHash: 'draft', type, kind: 'fact' as const, data };
      },
    };
    const runAgent = vi.fn().mockResolvedValue({ ok: false, failure: 'test', errors: [], summary: {}, sandboxDisabled: false });
    await runCycle({
      draft,
      journal,
      runAgent: runAgent as never,
      principles: () => [],
      retrieval: () => [],
      secretsDir: root,
      validateDocs: async () => ({ available: true, decision: 'blocked' as const, consistent: false, confidence: 0.99, model: 'jev', checks: { documents_consistent: 0.2 }, stateTruncated: false }),
    }, 1);
    expect(events.some((event) => event.type === 'REFINE_DOCS_VALIDATED')).toBe(true);
    expect(events.some((event) => event.type === 'REFINE_CYCLE_FAILED' && String(event.data.reason).startsWith('Jev bloqueou'))).toBe(false);
    expect(runAgent).toHaveBeenCalledOnce();
  });
});

describe('refinement cycle System 1 filters (decisions 2-4)', () => {
  it('hints not-ready criteria, drops a duplicate question and asks about a contradicted history chunk', async () => {
    const spec = makeSpec();
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'shop', specId: spec.specId, root, docs,
      projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'brief.md'),
      stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await Promise.all([draft.projectMd, draft.briefMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const packs: Record<string, string> = {};
    const runAgent = vi.fn(async (req: { kind: string; role: string; pack: { feedback?: string } }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      packs[req.role] = String(req.pack.feedback);
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [{ text: 'Which port?', blocking: true, relatedAcIds: ['AC-001'] }, { text: 'What port does it listen on?', blocking: true, relatedAcIds: ['AC-001'] }], docPatch: [] });
      return ok({ checklist: check(['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    const asked: string[] = [];
    const decider = {
      decide: async (id: string, _state: string, questions: Record<string, unknown>) => {
        asked.push(id);
        const value = id === 'gate1-readiness' ? 0.1 : 0.9;
        return { answered: true as const, backend: 'jev' as const, escalated: false, answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, value, probabilities: { yes: value, no: 1 - value }, confidence: 0.9 }])) };
      },
    };
    const hit = { chunkId: 'c1', docId: 'd1', kind: 'spec' as never, title: 'spec-000', heading: 'Ports', snippet: 'the service listens on 8080', text: 'the service listens on 8080', score: 1 };
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [hit], secretsDir: root, decider }, 1);
    expect(asked).toEqual(['gate1-readiness', 'question-dedup', 'history-contradiction']);
    expect(packs.po).toContain('Not ready: ' + spec.acceptanceCriteria.map((c) => c.id).join(', '));
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    const texts = (evaluated.data.questions as Array<{ text: string; blocking: boolean }>).map((q) => q.text);
    expect(texts).toContain('Which port?');
    expect(texts).not.toContain('What port does it listen on?');
    expect(texts.some((t) => t.includes('contradict earlier project history (spec-000 › Ports)'))).toBe(true);
  });
});

