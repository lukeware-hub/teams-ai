import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Decider } from '../../server/decide/decider.js';
import { heldForOwner } from '../../server/refine/auto-floor.js';
import { buildContextPack } from '../../server/knowledge/context-pack.js';
import { runCycle } from '../../server/refine/cycle.js';
import { draftPaths, createNewProject } from '../../server/refine/draft.js';
import { emptyRefineState } from '../../server/refine/state.js';
import { summarizeJevChecks, type JevValidationResult, type ValidationDocs } from '../../server/refine/jev-validation.js';
import type { BacklogItem } from '../../server/contracts/backlog.js';
import type { Workspace } from '../../server/orchestrator/workspace.js';
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

describe('refinement cycle acceptance criterion ids (R11.8)', () => {
  it('numbers a new spec above a sibling spec already copied into the draft, instead of restarting at AC-001', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const ws = { projectId: 'shop', root, repo: `${root}/repo`, worktrees: `${root}/wt`, graph: `${root}/g`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` } as Workspace;
    const draft = draftPaths(ws, 'shop-002');
    await createNewProject(draft, 'Shop');
    // A sibling spec of the same project, copied from main into the draft the way createFromRepo does for a new spec.
    const siblingDir = path.join(draft.docs, 'specs', 'shop-001');
    await mkdir(siblingDir, { recursive: true });
    await writeFile(path.join(siblingDir, 'spec.json'), JSON.stringify({ ...makeSpec(), specId: 'shop-001', acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w', then: 't', smoke: false }] }));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'shop/shop-002', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const runAgent = vi.fn(async (req: { kind: string; role: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...makeSpec(), specId: 'shop-002', acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w', then: 't2', smoke: false }] } });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [] });
      return ok({ checklist: check(['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], secretsDir: root }, 1);
    const derived = events.find((e) => e.type === 'DERIVED')!;
    const ids = (derived.data.spec as { acceptanceCriteria: Array<{ id: string }> }).acceptanceCriteria.map((c) => c.id);
    expect(ids).toEqual(['AC-002']);
  });
});

describe('refinement cycle flow.md must be mermaid (R11.11)', () => {
  const build = async (flow: string, validateDocs?: (docs: ValidationDocs) => Promise<JevValidationResult>, id = 'sm.flow-is-mermaid') => {
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
    await Promise.all([draft.projectMd, draft.briefMd, draft.stackMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    await writeFile(draft.flowMd, flow);
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const runAgent = vi.fn(async (req: { kind: string; role: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [] });
      return ok({ checklist: check(['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions', 'sm.flow-is-mermaid']), questions: [], docPatch: [] });
    });
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], secretsDir: root, validateDocs }, 1);
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    return (evaluated.data.checklist as Array<{ id: string; passed: boolean; detail: string }>).find((i) => i.id === id)!;
  };

  it('fails deterministically, overriding the agent, when flow.md has no mermaid fence', async () => {
    const item = await build('# Flow\n\n## 1. Checkout\n\nUser pays.\n');
    expect(item).toMatchObject({ passed: false });
    expect(item.detail).toMatch(/mermaid/);
  });

  it('passes when flow.md has a mermaid fence', async () => {
    const item = await build('# Flow\n\n```mermaid\nflowchart TD\n  A --> B\n```\n');
    expect(item).toMatchObject({ passed: true });
  });

  it('fails po.no-contradictions when Jev finds the five documents inconsistent, overriding the agent', async () => {
    const seen: ValidationDocs[] = [];
    const jev = (consistent: number) => async (docs: ValidationDocs) => {
      seen.push(docs);
      return summarizeJevChecks({ documents_consistent: consistent }, 'jev');
    };
    expect(await build('# Flow', jev(0.2), 'po.no-contradictions')).toMatchObject({ passed: false });
    expect(await build('# Flow', jev(0.9), 'po.no-contradictions')).toMatchObject({ passed: true });
    expect(Object.keys(seen[0]!).sort()).toEqual(['briefing', 'design', 'flow', 'project', 'stack']);
  });

  // Seen live on a 42-item backlog: the Jev read the documents cut at its cap for 9 cycles, scored 0.37 to 0.43, and no fix could move it.
  it('keeps the PO verdict on po.no-contradictions when the Jev read the documents cut at its cap, and says why', async () => {
    const item = await build('# Flow', async () => summarizeJevChecks({ documents_consistent: 0.2 }, 'jev', true), 'po.no-contradictions');
    expect(item).toMatchObject({ passed: true });
    expect(item.detail).toMatch(/os documentos passam do limite que ele lê e foram cortados/);
  });
});

describe('refinement cycle patch dedup (R11.10)', () => {
  it('drops an SM patch byte-identical to one PO already proposed this cycle, keeping PO\'s', async () => {
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
    await writeFile(draft.briefMd, '# Brief\n\nTODO: port.\n');
    await Promise.all([draft.projectMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const samePatch = { file: `docs/specs/${spec.specId}/brief.md`, find: 'TODO: port.', replace: 'Port: 8080.', reason: 'fill it in' };
    const runAgent = vi.fn(async (req: { kind: string; role: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [samePatch] });
      return ok({ checklist: check(['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [samePatch] });
    });
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], secretsDir: root }, 1);
    const proposed = events.filter((e) => e.type === 'PATCH_PROPOSED');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.data.role).toBe('po');
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    const discarded = evaluated.data.discardedPatches as Array<{ role: string; reason: string }>;
    expect(discarded).toContainEqual({ role: 'sm', file: samePatch.file, reason: 'the same change was already proposed this cycle' });
  });
});

describe('refinement cycle patch dedup (R11.5a item 2)', () => {
  it('drops a paraphrased patch on the same file when the decision says it is the same change', async () => {
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
    await writeFile(draft.briefMd, '# Brief\n\nTODO: port.\n');
    await Promise.all([draft.projectMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const poPatch = { file: `docs/specs/${spec.specId}/brief.md`, find: 'TODO: port.', replace: 'Port: 8080.', reason: 'fill it in' };
    const smPatch = { file: `docs/specs/${spec.specId}/brief.md`, find: 'TODO: port.', replace: 'The service listens on port 8080.', reason: 'state the port' };
    const runAgent = vi.fn(async (req: { kind: string; role: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [poPatch] });
      return ok({ checklist: check(['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [smPatch] });
    });
    const decider = {
      decide: async (id: string, _state: string, questions: Record<string, unknown>) => {
        if (id !== 'patch-dedup') return { answered: false as const, reason: 'disabled' as const };
        return { answered: true as const, backend: 'jev' as const, escalated: false, answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, value: 0.9, probabilities: { yes: 0.9, no: 0.1 }, confidence: 0.9 }])) };
      },
    };
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], secretsDir: root, decider }, 1);
    const proposed = events.filter((e) => e.type === 'PATCH_PROPOSED');
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.data.role).toBe('po');
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    const discarded = evaluated.data.discardedPatches as Array<{ role: string; reason: string }>;
    expect(discarded).toContainEqual({ role: 'sm', file: smPatch.file, reason: 'a near-duplicate of a patch already proposed this cycle (same change in substance)' });
  });

  it('keeps both patches when the decision says they differ', async () => {
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
    await writeFile(draft.briefMd, '# Brief\n\nTODO: port.\nTODO: auth.\n');
    await Promise.all([draft.projectMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const poPatch = { file: `docs/specs/${spec.specId}/brief.md`, find: 'TODO: port.', replace: 'Port: 8080.', reason: 'fill it in' };
    const smPatch = { file: `docs/specs/${spec.specId}/brief.md`, find: 'TODO: auth.', replace: 'No authentication required.', reason: 'state the auth' };
    const runAgent = vi.fn(async (req: { kind: string; role: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [poPatch] });
      return ok({ checklist: check(['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [smPatch] });
    });
    const decider = {
      decide: async (id: string, _state: string, questions: Record<string, unknown>) => {
        if (id !== 'patch-dedup') return { answered: false as const, reason: 'disabled' as const };
        return { answered: true as const, backend: 'jev' as const, escalated: false, answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'noul' as const, value: 0.1, probabilities: { yes: 0.1, no: 0.9 }, confidence: 0.9 }])) };
      },
    };
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], secretsDir: root, decider }, 1);
    const proposed = events.filter((e) => e.type === 'PATCH_PROPOSED');
    expect(proposed).toHaveLength(2);
  });
});

describe('refinement cycle question routing (plan 53, R11.5a slice 1)', () => {
  it('journals a routing hint per blocking question without changing which questions reach the human', async () => {
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
    const runAgent = vi.fn(async (req: { kind: string; role: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [{ text: 'How does the e2e suite reach MailHog?', blocking: true, relatedAcIds: ['AC-001'] }], docPatch: [] });
      return ok({ checklist: check(['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    const decider = {
      decide: async (id: string, _state: string, questions: Record<string, unknown>) => {
        if (id !== 'question-routing') return { answered: false as const, reason: 'disabled' as const };
        return { answered: true as const, backend: 'jev' as const, escalated: false, answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: 'choice' as const, value: 'auto', probabilities: { auto: 0.95 }, confidence: 0.95 }])) };
      },
    };
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], secretsDir: root, decider }, 1);
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    const questions = evaluated.data.questions as Array<{ questionId: string; text: string }>;
    expect(questions).toHaveLength(1); // the question still reaches the human: shadow mode changes nothing observable
    const routing = evaluated.data.questionRouting as Record<string, { route: string; confidence: number | null }>;
    expect(routing[questions[0]!.questionId]).toMatchObject({ route: 'auto' });
  });

  it('adds no hint without a decider', async () => {
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
    const runAgent = vi.fn(async (req: { kind: string; role: string }) => {
      if (req.kind === 'derive') return ok({ project: makeProject(), spec: { ...spec, status: 'refining', specHash: null } });
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [{ text: 'Which port?', blocking: true, relatedAcIds: ['AC-001'] }], docPatch: [] });
      return ok({ checklist: check(['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], secretsDir: root }, 1); // no decider at all
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    expect(evaluated.data.questionRouting).toEqual({});
  });

  /** A refinement draft whose PO asks the given blocking questions, and a decider that routes each one `auto` at its confidence. */
  async function autoRouted(questions: Record<string, number>, docText = '# doc\nA porta é 8080.', over: { answer?: string | null; ok?: boolean; backend?: 'jev' | 'local'; contradiction?: boolean; decider?: unknown; confidential?: boolean } = {}) {
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
    await Promise.all([draft.projectMd, draft.briefMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, docText)));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const ok = (value: unknown) => ({ ok: true, value, summary: {} });
    const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
    const answered: string[] = [];
    const answerPacks: Array<Parameters<typeof buildContextPack>[0]> = [];
    const runAgent = vi.fn(async (req: { kind: string; role: string; pack: { feedback?: string } }) => {
      if (req.kind === 'derive') return ok({ project: { ...makeProject(), ...(over.confidential ? { confidential: true } : {}) }, spec: { ...spec, status: 'refining', specHash: null } });
      if (req.kind === 'answer') {
        // A marker in the journal order shows when the answer step ran against the evaluation fact.
        events.push({ type: 'ANSWER_STEP', data: {} });
        answerPacks.push(req.pack as never);
        answered.push(`${req.role}: ${Object.keys(questions).find((q) => String(req.pack.feedback).includes(q))}`);
        if (over.ok === false) return { ok: false, failure: 'schema', errors: ['bad'], summary: {} };
        return ok({ specHash: 'draft', answer: over.answer === undefined ? 'project.md diz 8080.' : over.answer });
      }
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: Object.keys(questions).map((text) => ({ text, blocking: true, relatedAcIds: [] })), docPatch: [] });
      return ok({ checklist: check(['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    const decider = {
      decide: async (id: string, state: string) => {
        if (id === 'history-contradiction' && over.contradiction) return { answered: true as const, backend: 'jev' as const, escalated: false, answers: { q0: { type: 'noul' as const, value: 1, probabilities: { yes: 1, no: 0 }, confidence: 1 } } };
        if (id !== 'question-routing') return { answered: false as const, reason: 'disabled' as const };
        const confidence = Object.entries(questions).find(([q]) => state.includes(q))?.[1] ?? 0.99;
        return { answered: true as const, backend: over.backend ?? ('jev' as const), escalated: false, answers: { route: { type: 'choice' as const, value: 'auto', probabilities: { auto: confidence }, confidence } } };
      },
    };
    const history = [{ chunkId: 'c', docId: 'd', kind: 'spec', title: 'Spec 1', heading: 'Decisões', snippet: 'a porta é 9090', text: 'A porta é 9090.', score: 1 }];
    const run = (autoAnswerFloor?: number) => runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => (over.contradiction ? history : []), secretsDir: root, decider: over.decider ?? decider, autoAnswerFloor } as never, 1);
    return { events, answered, answerPacks, runAgent, run };
  }

  it('keeps about one question in ten above the floor for the owner, so labels keep coming once the floor is on', async () => {
    const questions = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`Question ${String(i).padStart(2, '0')}?`, 0.99]));
    const r = await autoRouted(questions);
    await r.run(0.9);
    const ids = Array.from({ length: 20 }, (_, i) => `po-c1-${i}`);
    expect(ids.filter(heldForOwner).length).toBeGreaterThan(0);
    expect(r.events.filter((e) => e.type === 'QUESTION_ANSWERED').map((e) => e.data.questionId)).toEqual(ids.filter((id) => !heldForOwner(id)));
  });

  it('leaves the question with the human when the answer step returns null or fails', async () => {
    for (const over of [{ answer: null }, { ok: false }]) {
      const r = await autoRouted({ 'Which port?': 0.95 }, undefined, over);
      await r.run(0.9);
      expect(r.events.some((e) => e.type === 'QUESTION_ANSWERED')).toBe(false);
      expect(r.events.some((e) => e.type === 'REFINE_CYCLE_FAILED')).toBe(false);
    }
  });

  it('answers only what Jev routed: a route from the local model is no measured route', async () => {
    const r = await autoRouted({ 'Which port?': 0.99 }, undefined, { backend: 'local' });
    await r.run(0.9);
    expect(r.answered).toEqual([]);
  });

  it('never answers a history contradiction, which exists for the human to decide', async () => {
    const r = await autoRouted({ 'Which port?': 0.5 }, undefined, { contradiction: true });
    await r.run(0.9);
    const evaluated = r.events.find((e) => e.type === 'REFINE_EVALUATED')!.data;
    const contradiction = (evaluated.questions as Array<{ questionId: string; text: string }>).find((q) => q.text.startsWith('The new spec seems to contradict earlier project history'))!;
    expect(r.answered).toEqual([]);
    // Never answered on its own, so never routed either: no Jev call, and no sample the floor could count.
    expect(Object.keys(evaluated.questionRouting as object)).not.toContain(contradiction.questionId);
  });

  it('routes nothing on a confidential draft, where the decider skips Jev, so nothing is answered', async () => {
    const jev = { evaluate: async () => { throw new Error('a confidential draft never reaches Jev'); } };
    const decider = new Decider({ backends: { jev } as never, config: () => ({ enabled: true, chain: ['jev', 'local'], thresholds: { jev: 0.8, local: 0.9 }, escalateTo: 'po' }), onDecision: () => undefined, clock: () => new Date() });
    const r = await autoRouted({ 'Which port?': 0.99 }, undefined, { decider, confidential: true });
    await r.run(0.9);
    expect(r.events.find((e) => e.type === 'REFINE_EVALUATED')!.data.questionRouting).toEqual({});
    expect(r.answered).toEqual([]);
  });

  it('runs the answer steps before journaling the evaluation, so the page stays in evaluating until the answers land', async () => {
    const r = await autoRouted({ 'Which port?': 0.95 });
    await r.run(0.9);
    const types = r.events.map((e) => e.type);
    const evaluated = types.indexOf('REFINE_EVALUATED');
    expect(types.indexOf('ANSWER_STEP')).toBeLessThan(evaluated);
    expect(types[evaluated + 1]).toBe('QUESTION_ANSWERED');
  });

  it('fits the answer pack to the docs, so a large draft never loses the question', async () => {
    const r = await autoRouted({ 'Which port?': 0.95 }, `# doc\n${'x'.repeat(40_000)}`);
    await r.run(0.9);
    const pack = buildContextPack(r.answerPacks[0]!);
    expect(pack.dropped).not.toContain('feedback');
    expect(pack.text).toContain('Which port?');
  });

  it('answers a question routed auto at the floor or above from the docs, by its owner role, and leaves the others with the human', async () => {
    const r = await autoRouted({ 'Which port?': 0.95, 'Which name?': 0.85 });
    await r.run(0.9);
    expect(r.answered).toEqual(['po: Which port?']);
    const evaluated = r.events.findIndex((e) => e.type === 'REFINE_EVALUATED');
    const answers = r.events.filter((e) => e.type === 'QUESTION_ANSWERED');
    expect(answers.map((e) => e.data)).toEqual([{ questionId: 'po-c1-0', text: 'project.md diz 8080.', by: 'po' }]);
    // The floor the cycle answered at stays on record, so a later reader knows when and where it switched on.
    expect(r.events.find((e) => e.type === 'REFINE_EVALUATED')!.data.autoAnswerFloor).toBe(0.9);
    expect(r.events.indexOf(answers[0]!)).toBeGreaterThan(evaluated);
  });

  it('never answers a question by itself while the floor is unset, the default', async () => {
    const r = await autoRouted({ 'Which port?': 0.99 });
    await r.run();
    expect(r.runAgent.mock.calls.some(([req]) => req.kind === 'answer')).toBe(false);
    expect(r.events.some((e) => e.type === 'QUESTION_ANSWERED')).toBe(false);
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
    const order = [...new Set(asked)];
    expect(order).toEqual(['gate1-readiness', 'question-dedup', 'history-contradiction', 'question-routing']);
    expect(asked.filter((id) => id === 'gate1-readiness')).toHaveLength(spec.acceptanceCriteria.length); // one call per criterion
    expect(asked.filter((id) => id === 'history-contradiction')).toHaveLength(1); // one call per retrieved chunk
    // Every decision leaves a DECISION_MADE record the eval harness can read (spec 10A.4/10A.6).
    const made = events.filter((e) => e.type === 'DECISION_MADE').map((e) => e.data as { cycle: number; record: { decisionId: string; backend: string; escalated: boolean; durationMs: number; answers: Record<string, { probabilities: unknown }> } });
    expect(made.map((m) => m.record.decisionId)).toEqual(asked);
    expect(made[0]).toMatchObject({ cycle: 1, record: { backend: 'jev', escalated: false } });
    expect(typeof made[0]!.record.durationMs).toBe('number');
    expect(Object.keys(made[0]!.record.answers).length).toBeGreaterThan(0);
    expect(packs.po).toContain('Not ready: ' + spec.acceptanceCriteria.map((c) => c.id).join(', '));
    const evaluated = events.find((e) => e.type === 'REFINE_EVALUATED')!;
    const texts = (evaluated.data.questions as Array<{ text: string; blocking: boolean }>).map((q) => q.text);
    expect(texts).toContain('Which port?');
    expect(texts).not.toContain('What port does it listen on?');
    expect(texts.some((t) => t.includes('contradict earlier project history (spec-000 › Ports)'))).toBe(true);
  });
});


const setup = async (brief: string) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
  const docs = path.join(root, 'docs');
  await mkdir(docs, { recursive: true });
  const draft = {
    projectId: 'big', specId: 'big-001', root, docs,
    projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'brief.md'),
    stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
    specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
  };
  await Promise.all([draft.projectMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
  await writeFile(draft.briefMd, brief);
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'x', specHash: 'draft', type, kind: 'fact' as const, data }; } };
  const runAgent = vi.fn().mockResolvedValue({ ok: false, failure: 'test', errors: [], summary: {}, sandboxDisabled: false });
  return { draft, journal, events, runAgent, root };
};

describe('refinement cycle with large documents', () => {
  it('never lets the derive pack drop the documents when they exceed the default budget', async () => {
    const { draft, journal, runAgent, root } = await setup(`# Brief\n${'x'.repeat(100_000)}`);
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], secretsDir: root }, 1);
    const built = buildContextPack(runAgent.mock.calls[0]![0].pack);
    expect(built.dropped).toEqual([]);
    expect(built.sections).toContain('feedback');
  });

  it('fails the cycle in Portuguese, without calling an agent, when the documents cannot fit', async () => {
    const { draft, journal, events, runAgent, root } = await setup(`# Brief\n${'x'.repeat(700_000)}`);
    await runCycle({ draft, journal, runAgent: runAgent as never, principles: () => [], retrieval: () => [], secretsDir: root }, 1);
    expect(runAgent).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'REFINE_CYCLE_FAILED')?.data.reason).toMatch(/grandes demais/);
  });
});

describe('refinement cycle Jev requirement', () => {
  it('fails before any agent runs when Jev is unavailable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'teams-ai-refine-'));
    const docs = path.join(root, 'docs');
    await mkdir(docs, { recursive: true });
    const draft = {
      projectId: 'demo', specId: 'demo-001', root, docs,
      projectMd: path.join(docs, 'project.md'), projectJson: path.join(docs, 'project.json'), briefMd: path.join(docs, 'brief.md'),
      stackMd: path.join(docs, 'stack.md'), flowMd: path.join(docs, 'flow.md'), designMd: path.join(docs, 'design.md'),
      specJson: path.join(docs, 'spec.json'), events: path.join(root, 'events.ndjson'), steps: (seq: number) => path.join(root, 'steps', String(seq)),
    };
    await Promise.all([draft.projectMd, draft.briefMd, draft.stackMd, draft.flowMd, draft.designMd].map((f) => writeFile(f, '# doc')));
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const journal = { state: emptyRefineState(), allocStepSeq: () => 1, fact: async (type: string, data: Record<string, unknown>) => { events.push({ type, data }); return { seq: events.length, at: '', runId: 'demo/demo-001', specHash: 'draft', type, kind: 'fact' as const, data }; } };
    const runAgent = vi.fn();
    await runCycle({
      draft,
      journal,
      runAgent: runAgent as never,
      principles: () => [],
      retrieval: () => [],
      secretsDir: root,
      validateDocs: async () => ({ available: false, decision: 'review' as const, consistent: null, confidence: null, model: null, checks: {}, stateTruncated: false }),
    }, 1);
    expect(runAgent).not.toHaveBeenCalled();
    expect(events.find((event) => event.type === 'REFINE_CYCLE_FAILED')?.data.reason).toBe('Jev indisponível: confira a chave do OpenRouter.');
  });
});

describe('refinement cycle in backlog mode', () => {
  const item = (key: string, over: Partial<BacklogItem> = {}): BacklogItem => ({ key, title: `Item ${key}`, epic: 'core', scope: `Entrega ${key}`, priority: 'P1', rationale: 'valor', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'Objectives' }], size: 'M', ...over });
  const raw = (items: BacklogItem[]) => ({ project: makeProject(), backlog: { epics: [{ key: 'core', title: 'Core' }], items } });
  const ok = (value: unknown) => ({ ok: true, value, summary: {} });
  const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
  const agent = (backlogAnswers: unknown[]) => {
    const answers = [...backlogAnswers];
    const packs: Array<{ kind: string; role: string; feedback: string }> = [];
    const fn = vi.fn(async (req: { kind: string; role: string; pack: { feedback?: string } }) => {
      packs.push({ kind: req.kind, role: req.role, feedback: String(req.pack.feedback) });
      if (req.kind === 'backlog') return ok(answers.shift());
      if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [] });
      return ok({ checklist: check(['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
    });
    return { fn, packs };
  };
  const on = (journal: { state: { backlog: unknown } }) => { journal.state.backlog = { enabled: true, project: null, epics: [], items: [], cycle: 0 }; };

  it('runs the backlog step instead of derive, journals the ranked backlog and writes project.json and backlog.md', async () => {
    const { draft, journal, events, root } = await setup('# Briefing');
    on(journal);
    const { fn, packs } = agent([raw([item('casos', { dependsOn: ['base'] }), item('base', { priority: 'P0' })])]);
    await runCycle({ draft, journal, runAgent: fn as never, principles: () => [], retrieval: () => [], secretsDir: root }, 1);
    expect(packs.map((p) => p.kind)).toEqual(['backlog', 'refine', 'refine']);
    const derived = events.find((e) => e.type === 'BACKLOG_DERIVED')!.data as { items: Array<{ key: string; rank: number }> };
    expect(derived.items.map((i) => [i.key, i.rank])).toEqual([['base', 1], ['casos', 2]]);
    expect(events.some((e) => e.type === 'DERIVED')).toBe(false);
    expect(events.some((e) => e.type === 'REFINE_EVALUATED')).toBe(true);
    expect(JSON.parse(await readFile(draft.projectJson, 'utf8')).projectId).toBe(makeProject().projectId);
    expect(await readFile(path.join(draft.docs, 'backlog.md'), 'utf8')).toContain('Item base');
    const index = JSON.parse(await readFile(path.join(draft.docs, 'specs.json'), 'utf8')) as { specs: Array<{ specId: string; rank: number; dependsOn: string[] }> };
    expect(index.specs.map((x) => [x.rank, x.specId, x.dependsOn])).toEqual([[1, 'big-001-base', []], [2, 'big-001-casos', ['big-001-base']]]);
    const po = packs.find((p) => p.role === 'po' && p.kind === 'refine')!;
    expect(po.feedback).toContain('### derived backlog');
    expect(po.feedback).not.toContain('### derived spec.json');
  });

  it('writes docs/specs.json with the spec ids a draft with readable ids really has', async () => {
    const { draft, journal, root } = await setup('# Briefing');
    journal.state.backlog = { enabled: true, project: null, epics: [], items: [], cycle: 0, keyIds: true };
    const { fn } = agent([raw([item('casos', { dependsOn: ['base'] }), item('base', { priority: 'P0' })])]);
    await runCycle({ draft, journal, runAgent: fn as never, principles: () => [], retrieval: () => [], secretsDir: root }, 1);
    const index = JSON.parse(await readFile(path.join(draft.docs, 'specs.json'), 'utf8')) as { specs: Array<{ specId: string; dependsOn: string[] }> };
    expect(index.specs.map((x) => [x.specId, x.dependsOn])).toEqual([['base', []], ['casos', ['base']]]);
  });

  it('asks once more with the rejection when the first backlog breaks a rule', async () => {
    const { draft, journal, events, root } = await setup('# Briefing');
    on(journal);
    const { fn, packs } = agent([raw([item('a', { dependsOn: ['zzz'] })]), raw([item('a')])]);
    await runCycle({ draft, journal, runAgent: fn as never, principles: () => [], retrieval: () => [], secretsDir: root }, 1);
    const asks = packs.filter((p) => p.kind === 'backlog');
    expect(asks).toHaveLength(2);
    expect(asks[0]!.feedback).not.toContain('zzz');
    expect(asks[1]!.feedback).toMatch(/dependência desconhecida zzz/);
    expect(events.some((e) => e.type === 'BACKLOG_DERIVED')).toBe(true);
  });

  it('fails the cycle when the second backlog still breaks a rule, and runs no review', async () => {
    const { draft, journal, events, root } = await setup('# Briefing');
    on(journal);
    const { fn, packs } = agent([raw([item('a', { dependsOn: ['zzz'] })]), raw([item('a', { dependsOn: ['zzz'] })])]);
    await runCycle({ draft, journal, runAgent: fn as never, principles: () => [], retrieval: () => [], secretsDir: root }, 1);
    expect(packs.map((p) => p.kind)).toEqual(['backlog', 'backlog']);
    expect(String(events.find((e) => e.type === 'REFINE_CYCLE_FAILED')?.data.reason)).toMatch(/^backlog: .*zzz/);
    expect(events.some((e) => e.type === 'BACKLOG_DERIVED')).toBe(false);
  });
});
