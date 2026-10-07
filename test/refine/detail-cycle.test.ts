import { access, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../../server/contracts/backlog.js';
import { runCycle } from '../../server/refine/cycle.js';
import { RefineEvent } from '../../server/refine/events.js';
import { applyRefineEvent, emptyRefineState } from '../../server/refine/state.js';
import { makeProject } from '../fixtures/contracts.js';

const H = `sha256:${'a'.repeat(64)}`;
const FLOW = ['# Fluxo', '', '```mermaid', '%% 1. Caso', '  A --> B', '%% 2. Triagem', '  B --> C', '%% 3. OPME', '  C --> D', '%% 4. Faturamento', '  D --> E', '```', ''].join('\n');
const item = (key: string, epic: string, heading: string, over: Partial<BacklogItem> = {}): BacklogItem => ({
  key, title: `Item ${key}`, epic, scope: `Entrega ${key}`, priority: 'P1', rationale: 'valor', dependsOn: [], sources: [{ doc: 'flow.md', heading }], size: 'M', ...over,
});
const OUTLINE = [
  item('caso', 'atend', '1. Caso', { priority: 'P0' }),
  item('triagem', 'atend', '2. Triagem', { dependsOn: ['caso'] }),
  item('opme', 'supr', '3. OPME', { dependsOn: ['caso'] }),
  item('fat', 'fin', '4. Faturamento', { priority: 'P2', dependsOn: ['opme'] }),
];
const epics = [{ key: 'atend', title: 'Atendimento' }, { key: 'supr', title: 'Suprimentos' }, { key: 'fin', title: 'Financeiro' }, { key: 'extra', title: 'Extra' }];
const ok = (value: unknown) => ({ ok: true, value, summary: {} });
const check = (ids: string[]) => ids.map((id) => ({ id, passed: true, detail: 'ok' }));
const itemSpec = (key: string) => ({
  key, type: 'feature', objectives: [`Entregar ${key}`], features: [key], outOfScope: [], externalDependencies: [],
  acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: `w ${key}`, then: 't1', smoke: true }, { id: 'AC-002', given: 'g', when: `w ${key}`, then: 't2' }],
});
const preplanFor = (section: string) => {
  const key = /^([a-z0-9-]+):/.exec(section)![1]!;
  // Only the spec's own criterion lines; a rejection in the pack may name other ids.
  const ids = [...new Set([...section.matchAll(/^- (AC-\d{3})/gm)].map((m) => m[1]!))];
  return { key, modules: [{ name: 'm', purpose: 'p' }], tasks: ids.map((id, n) => ({ id: `P${n + 1}`, title: `Tarefa ${id}`, module: 'm', owner: 'dev', criteriaRefs: [id], dependsOn: [] })), risks: [] };
};

type Req = { kind: string; role: string; pack: { feedback?: string } };
/** A fake agent answering each step kind from what its pack carries; `hook` may replace an answer. */
function fakeAgent(outline: () => BacklogItem[], hook: (req: Req, n: number) => unknown = () => undefined) {
  const calls: Array<{ kind: string; feedback: string }> = [];
  const fn = vi.fn(async (req: Req) => {
    const feedback = String(req.pack.feedback);
    calls.push({ kind: req.kind, feedback });
    const replaced = hook(req, calls.filter((c) => c.kind === req.kind).length);
    if (replaced !== undefined) return replaced;
    if (req.kind === 'backlog') return ok({ specHash: H, project: makeProject(), backlog: { epics, items: outline() } });
    if (req.kind === 'spec') return ok({ specHash: H, specs: [...feedback.matchAll(/^## Item ([a-z0-9-]+):/gm)].map((m) => itemSpec(m[1]!)) });
    if (req.kind === 'preplan') return ok({ specHash: H, preplans: feedback.split(/^## Spec /m).slice(1).map(preplanFor) });
    if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [] });
    return ok({ checklist: check(['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
  });
  const kinds = (from = 0) => calls.slice(from).map((c) => c.kind);
  return { fn, calls, kinds };
}

async function setup() {
  const root = (await mkdtemp(path.join(os.tmpdir(), 'teams-ai-detail-'))).replace(/\\/g, '/');
  const docs = `${root}/docs`;
  await mkdir(docs, { recursive: true });
  const draft = {
    projectId: 'big', specId: 'big-001', root, docs,
    projectMd: `${docs}/project.md`, projectJson: `${docs}/project.json`, briefMd: `${docs}/specs/big-001/brief.md`, briefingMd: `${docs}/briefing.md`,
    stackMd: `${docs}/stack.md`, flowMd: `${docs}/flow.md`, designMd: `${docs}/design.md`,
    specJson: `${docs}/specs/big-001/spec.json`, events: `${root}/events.ndjson`, steps: (seq: number) => `${root}/steps/${seq}`,
  };
  await writeFile(draft.projectMd, '# Projeto\n\n## Personas\n\n- Médico');
  await writeFile(draft.briefingMd, '# Briefing\n\n## Objectives\n\n- tudo');
  await writeFile(draft.stackMd, '# Stack\n\n- Node 22');
  await writeFile(draft.flowMd, FLOW);
  await writeFile(draft.designMd, '# Design');
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  let seq = 0;
  const journal = {
    state: emptyRefineState(),
    allocStepSeq: () => ++seq,
    fact: async (type: string, data: Record<string, unknown> = {}) => {
      const e = { type, data };
      events.push(e);
      applyRefineEvent(journal.state, e);
      return { seq: events.length, at: '', runId: 'big/big-001', specHash: 'draft', type, kind: 'fact' as const, data };
    },
  };
  await journal.fact(RefineEvent.BacklogEnabled, {});
  const run = (agent: ReturnType<typeof fakeAgent>, cycle: number) => runCycle({ draft, journal, runAgent: agent.fn as never, principles: () => [], retrieval: () => [], secretsDir: root }, cycle);
  const itemDir = (key: string) => `${docs}/specs/big-001-${key}`;
  return { draft, journal, events, run, itemDir, docs };
}

const exists = (p: string) => access(p).then(() => true, () => false);

describe('backlog detailing in the refinement cycle', () => {
  it('details every item once, writes its files, reaches ready, and later re-derives only what the docs changed', async () => {
    const { journal, events, run, itemDir, draft } = await setup();
    const agent = fakeAgent(() => OUTLINE);
    await run(agent, 1);
    expect(agent.kinds()).toEqual(['backlog', 'refine', 'refine']);
    await journal.fact(RefineEvent.BacklogDetailEnabled, {});

    let from = agent.calls.length;
    await run(agent, 2);
    // The docs did not change since the outline, so the backlog step is skipped; three epics make three calls each.
    expect(agent.kinds(from)).toEqual(['spec', 'spec', 'spec', 'preplan', 'preplan', 'preplan', 'refine', 'refine']);
    expect(journal.state.status).toBe('ready');
    const ids: string[] = [];
    for (const key of ['caso', 'triagem', 'opme', 'fat']) {
      const spec = JSON.parse(await readFile(`${itemDir(key)}/spec.json`, 'utf8'));
      expect(spec).toMatchObject({ specId: `big-001-${key}`, status: 'planned', derivedFrom: { backlogKey: key, sources: [{ doc: 'flow.md', hash: expect.stringMatching(/^sha256:/) }] } });
      ids.push(...spec.acceptanceCriteria.map((c: { id: string }) => c.id));
      expect(await readFile(`${itemDir(key)}/spec.md`, 'utf8')).toMatch(/^> Gerado pelo teams-ai a partir de spec\.json; não edite\. Fontes: flow\.md › /);
      expect(JSON.parse(await readFile(`${itemDir(key)}/preplan.json`, 'utf8'))).toMatchObject({ specId: `big-001-${key}`, tasks: [{ id: 'P1' }, { id: 'P2' }] });
      expect((await readdir(itemDir(key))).sort()).toEqual(['preplan.json', 'spec.json', 'spec.md']);
    }
    expect(new Set(ids).size).toBe(8);
    expect(journal.state.backlog?.acHighWater).toBe(8);

    from = agent.calls.length;
    await run(agent, 3);
    expect(agent.kinds(from)).toEqual(['refine', 'refine']);

    from = agent.calls.length;
    await writeFile(draft.flowMd, FLOW.replace('C --> D', 'C --> D2[Cotação]'));
    await run(agent, 4);
    expect(agent.kinds(from)).toEqual(['backlog', 'spec', 'refine', 'refine']);
    expect(agent.calls.at(-3)!.feedback).toContain('## Item opme:');
    const opme = JSON.parse(await readFile(`${itemDir('opme')}/spec.json`, 'utf8'));
    expect(opme.acceptanceCriteria.map((c: { id: string }) => c.id)).toEqual(ids.slice(4, 6));
    // Same content, same revision: its pre-plan is still current and the spec stays planned.
    expect(opme.status).toBe('planned');
    expect(events.filter((e) => e.type === 'REFINE_CYCLE_FAILED')).toEqual([]);
  });

  it('retries an item alone with its rejection when its spec or pre-plan breaks a rule', async () => {
    const { journal, run, itemDir } = await setup();
    const agent = fakeAgent(() => OUTLINE, (req, n) => {
      const fb = String(req.pack.feedback);
      if (req.kind === 'spec' && n === 1 && fb.includes('## Item triagem:')) return ok({ specHash: H, specs: [itemSpec('caso'), { ...itemSpec('triagem'), type: 'bug' }] });
      if (req.kind === 'preplan' && n === 2) return ok({ specHash: H, preplans: fb.split(/^## Spec /m).slice(1).map((s) => ({ ...preplanFor(s), tasks: [...preplanFor(s).tasks, { id: 'P9', title: 'x', module: 'm', owner: 'dev', criteriaRefs: ['AC-099'], dependsOn: [] }] })) });
      return undefined;
    });
    await run(agent, 1);
    await journal.fact(RefineEvent.BacklogDetailEnabled, {});
    const from = agent.calls.length;
    await run(agent, 2);
    const detail = agent.calls.slice(from).filter((c) => c.kind === 'spec' || c.kind === 'preplan');
    expect(detail.map((c) => c.kind)).toEqual(['spec', 'spec', 'spec', 'spec', 'preplan', 'preplan', 'preplan', 'preplan']);
    const solo = detail.find((c) => c.kind === 'spec' && c.feedback.includes('rejected'))!;
    expect([...solo.feedback.matchAll(/^## Item ([a-z0-9-]+):/gm)].map((m) => m[1])).toEqual(['triagem']);
    expect(solo.feedback).toMatch(/bug/);
    expect(detail.filter((c) => c.kind === 'preplan' && c.feedback.includes('AC-099'))).toHaveLength(1);
    expect(journal.state.status).toBe('ready');
    expect(JSON.parse(await readFile(`${itemDir('triagem')}/spec.json`, 'utf8')).status).toBe('planned');
  });

  it('stops starting batches at the first quota failure and keeps what finished', async () => {
    const { journal, events, run } = await setup();
    const spread = () => OUTLINE.map((i, n) => ({ ...i, epic: epics[n]!.key }));
    const agent = fakeAgent(spread, (req, n) => (req.kind === 'spec' && n === 1 ? { ok: false, failure: 'quota', errors: ['5-hour window'], summary: {}, sandboxDisabled: false } : undefined));
    await run(agent, 1);
    await journal.fact(RefineEvent.BacklogDetailEnabled, {});
    const from = agent.calls.length;
    await run(agent, 2);
    expect(agent.kinds(from)).toEqual(['spec', 'spec', 'spec']);
    expect(String(events.find((e) => e.type === 'REFINE_CYCLE_FAILED')?.data.reason)).toMatch(/quota/);
    expect(events.filter((e) => e.type === 'SPEC_DERIVED' && e.data.spec !== null)).toHaveLength(2);
  });

  it('removes the files of an item the outline no longer has', async () => {
    const { journal, run, itemDir, draft } = await setup();
    let outline = OUTLINE;
    const agent = fakeAgent(() => outline);
    await run(agent, 1);
    await journal.fact(RefineEvent.BacklogDetailEnabled, {});
    await run(agent, 2);
    expect(await exists(itemDir('fat'))).toBe(true);
    outline = OUTLINE.slice(0, 3);
    await writeFile(draft.flowMd, FLOW.replace('%% 4. Faturamento\n  D --> E\n', ''));
    await run(agent, 3);
    expect(await exists(itemDir('fat'))).toBe(false);
    expect(await exists(itemDir('opme'))).toBe(true);
    expect(Object.keys(journal.state.backlog?.specs ?? {}).sort()).toEqual(['caso', 'opme', 'triagem']);
  });
});
