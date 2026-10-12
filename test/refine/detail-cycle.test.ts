import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../../server/contracts/backlog.js';
import { runCycle } from '../../server/refine/cycle.js';
import { QuotaBreaker } from '../../server/budget/quota-breaker.js';
import { retireDropped } from '../../server/refine/detail-cycle.js';
import { withQuotaWait } from '../../server/refine/quota-wait.js';
import { restoreFromBase } from '../../server/refine/draft.js';
import { RefineEvent } from '../../server/refine/events.js';
import { applyPatch } from '../../server/refine/patches.js';
import { programEntries } from '../../server/refine/session.js';
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

/** A Jev that flags every detailing check whose state holds `marker`, whatever the config, and answers no other decision. */
function jev(marker: string) {
  const states: string[] = [];
  const confidential: boolean[] = [];
  const decide = async (id: string, state: string, questions: Record<string, unknown>, ctx: { confidential: boolean }) => {
    if (!['spec-cited-sections', 'criterion-shared-deploy', 'preplan-tech-decisions'].includes(id)) return { answered: false, reason: 'disabled' };
    states.push(state);
    confidential.push(ctx.confidential);
    const value = state.includes(marker) ? 0.9 : 0.1;
    return { answered: true, backend: 'jev', escalated: false, answers: { [Object.keys(questions).join()]: { type: 'noul', value, probabilities: { yes: value, no: 1 - value }, confidence: 0.9 } } };
  };
  return { states, confidential, decide };
}

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
    if (req.kind === 'conflicts') return ok({ specHash: H, pairs: [{ a: 'triagem', b: 'opme', reason: 'mesmo módulo m' }, { a: 'opme', b: 'triagem', reason: 'eco' }, { a: 'opme', b: 'zzz', reason: 'chave inexistente' }] });
    if (req.role === 'po') return ok({ checklist: check(['po.objectives-verifiable', 'po.personas', 'po.scope-explicit', 'po.no-contradictions']), questions: [], docPatch: [] });
    return ok({ checklist: check(['sm.dependencies-and-secrets', 'sm.constraints-clear', 'sm.tasks-feasible', 'sm.no-open-questions']), questions: [], docPatch: [] });
  });
  const kinds = (from = 0) => calls.slice(from).map((c) => c.kind);
  return { fn, calls, kinds };
}

async function setup(existing?: string) {
  const root = existing ?? (await mkdtemp(path.join(os.tmpdir(), 'teams-ai-detail-'))).replace(/\\/g, '/');
  const docs = `${root}/docs`;
  await mkdir(docs, { recursive: true });
  const draft = {
    projectId: 'big', specId: 'big-001', root, docs, base: `${root}/.base/docs`,
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
  const run = (agent: ReturnType<typeof fakeAgent>, cycle: number, decider?: ReturnType<typeof jev>) => runCycle({ draft, journal, runAgent: agent.fn as never, principles: () => [], retrieval: () => [], secretsDir: root, decider: decider as never }, cycle);
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
    expect(agent.kinds(from)).toEqual(['spec', 'spec', 'spec', 'preplan', 'preplan', 'preplan', 'conflicts', 'refine', 'refine']);
    expect(journal.state.status).toBe('ready');
    // The SM's conflict map keeps only pairs of real, distinct items, once each.
    expect(journal.state.backlog?.conflicts?.pairs).toEqual([{ a: 'triagem', b: 'opme', reason: 'mesmo módulo m' }]);
    expect(agent.calls.find((c) => c.kind === 'conflicts')!.feedback).toContain('## triagem');
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

  // R11.10 (plan 87): the outline cites each decision an item needs, never the whole Decisões section.
  it('sends an outline citing a section made only of sub-sections back to the PO with the ones to cite', async () => {
    const { journal, events, run, draft } = await setup();
    await writeFile(draft.briefingMd, '# Briefing\n\n## Objectives\n\n- tudo\n\n## Decisões\n\n### Prazo\n\n15 dias.\n\n### Multa\n\nR$ 2 por dia.\n');
    const citing = (heading: string) => OUTLINE.map((i) => (i.key === 'caso' ? { ...i, sources: [...i.sources, { doc: 'briefing.md' as const, heading }] } : i));
    const agent = fakeAgent(() => OUTLINE, (req) => (req.kind === 'backlog' ? ok({ specHash: H, project: makeProject(), backlog: { epics, items: citing(String(req.pack.feedback).includes('Your last attempt was rejected') ? 'Prazo' : 'Decisões') } }) : undefined));
    await run(agent, 1);
    const outlines = agent.calls.filter((c) => c.kind === 'backlog');
    expect(outlines).toHaveLength(2);
    expect(outlines[1]!.feedback).toContain('item caso cita briefing.md › "Decisões", uma seção feita só de subseções; cite as de que o item precisa: "Prazo", "Multa"');
    expect(journal.state.backlog?.items.find((i) => i.key === 'caso')?.sources).toContainEqual({ doc: 'briefing.md', heading: 'Prazo' });
    expect(events.filter((e) => e.type === 'REFINE_CYCLE_FAILED')).toEqual([]);
  });

  // R11.10 (plan 87): the dependencies feed the pre-plan only, so one the outline adds re-derives no spec.
  it('re-derives only the pre-plan of an item whose dependencies changed', async () => {
    const { journal, run, draft } = await setup();
    let outline = OUTLINE;
    const agent = fakeAgent(() => outline);
    await run(agent, 1);
    await journal.fact(RefineEvent.BacklogDetailEnabled, {});
    await run(agent, 2);
    outline = OUTLINE.map((i) => (i.key === 'fat' ? { ...i, dependsOn: ['opme', 'triagem'] } : i));
    // A section no item cites: the outline runs again and nothing it cites changed.
    await writeFile(draft.designMd, '# Design\n\n- Cores da clínica');
    const from = agent.calls.length;
    await run(agent, 3);
    expect(agent.kinds(from)).toEqual(['backlog', 'preplan', 'conflicts', 'refine', 'refine']);
    expect(agent.calls.slice(from).find((c) => c.kind === 'preplan')!.feedback).toContain('## Spec fat:');
    expect(journal.state.status).toBe('ready');
  });

  // R11.7.3: a new draft over what main already planned derives nothing again unless a cited section changed.
  type Env = Awaited<ReturnType<typeof setup>>;
  const secondDraft = async (change?: (second: Env) => Promise<unknown>, agent = fakeAgent(() => OUTLINE), prepare?: (first: Env) => Promise<unknown>) => {
    const first = await setup();
    if (prepare) await prepare(first);
    const agent1 = fakeAgent(() => OUTLINE);
    await first.run(agent1, 1);
    await first.journal.fact(RefineEvent.BacklogDetailEnabled, {});
    await first.run(agent1, 2);
    // Main as the first draft published it becomes the base copy of a new draft over the same folder.
    await cp(first.docs, first.draft.base!, { recursive: true });
    const second = await setup(first.draft.root);
    if (change) await change(second);
    await second.run(agent, 1);
    await second.journal.fact(RefineEvent.BacklogDetailEnabled, {});
    const from = agent.calls.length;
    await second.run(agent, 2);
    return { second, agent, detailing: agent.calls.slice(from).filter((c) => c.kind === 'spec' || c.kind === 'preplan') };
  };
  const named = (calls: Array<{ feedback: string }>, header: string) => calls.flatMap((c) => [...c.feedback.matchAll(new RegExp(`^## ${header} ([a-z0-9-]+):`, 'gm'))].map((m) => m[1])).sort();
  // Main's copy of an item spec moved on, as a program of the first draft would leave it.
  const markStatus = async (d: Env, key: string, status: string) => {
    const file = `${d.draft.base}/specs/big-001-${key}/spec.json`;
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), status, specVersion: 1, specHash: H }));
  };
  // R11.7.4: main delivered `opme`, and later its cited flow section changed.
  const deliveredThenChanged = async (d: Env) => {
    await markStatus(d, 'opme', 'done');
    await writeFile(d.draft.flowMd, FLOW.replace('C --> D', 'C --> D2[Cotação]'));
  };
  const withoutFat = (d: Env) => writeFile(d.draft.flowMd, FLOW.replace('%% 4. Faturamento\n  D --> E\n', ''));
  const approvals = (env: Env) => env.journal.state.patches.filter((p) => p.replace.startsWith('## Ajuste aprovado'));

  it("reuses main's spec and pre-plan of every item whose inputs did not change", async () => {
    const { second, detailing } = await secondDraft();
    expect(detailing).toEqual([]);
    expect(second.journal.state.status).toBe('ready');
    expect(Object.keys(second.journal.state.backlog?.preplans ?? {}).sort()).toEqual(['caso', 'fat', 'opme', 'triagem']);
  });

  it('derives again only the item whose cited section changed', async () => {
    const { second, detailing } = await secondDraft((d) => writeFile(d.draft.flowMd, FLOW.replace('C --> D', 'C --> D2[Cotação]')));
    expect(detailing.filter((c) => c.kind === 'spec').map((c) => [...c.feedback.matchAll(/^## Item ([a-z0-9-]+):/gm)].map((m) => m[1]))).toEqual([['opme']]);
    expect(second.journal.state.status).toBe('ready');
  });

  // Plan 78 review: a real PO rewords an outline it was never shown, so a new draft's first outline starts from main's.
  it("shows a new draft's first outline main's, so a PO that rewords without it keeps the wording and nothing is derived again", async () => {
    const rewords = fakeAgent(() => OUTLINE, (req) => {
      if (req.kind !== 'backlog') return undefined;
      const shown = String(req.pack.feedback).split('### previous backlog (keep the keys)\n\n')[1]?.split('\n\n### ')[0];
      return shown && shown !== '(none)' ? undefined : ok({ specHash: H, project: makeProject(), backlog: { epics, items: OUTLINE.map((i) => ({ ...i, title: `${i.title} revisto` })) } });
    });
    const { second, detailing } = await secondDraft(undefined, rewords);
    expect(detailing).toEqual([]);
    expect(second.journal.state.status).toBe('ready');
  });

  // Plan 78 review: an item dropped and added again in the same draft lost its folder, and its run could not read its spec.
  it('brings back the files of an item dropped and added again in the same draft', async () => {
    let outline = OUTLINE;
    const agent = fakeAgent(() => outline);
    const { second } = await secondDraft(undefined, agent);
    const fat = `${second.itemDir('fat')}/spec.json`;
    outline = OUTLINE.filter((i) => i.key !== 'fat');
    await writeFile(second.draft.flowMd, FLOW.replace('%% 4. Faturamento\n  D --> E\n', ''));
    await second.run(agent, 3);
    expect(JSON.parse(await readFile(fat, 'utf8')).status).toBe('retired');
    outline = OUTLINE;
    await writeFile(second.draft.flowMd, FLOW);
    await second.run(agent, 4);
    expect(JSON.parse(await readFile(fat, 'utf8')).status).toBe('planned');
    expect(second.journal.state.status).toBe('ready');
  });

  // Plan 78 review: the plan's focus 3 to 5 as tests.
  it('makes every pre-plan again when stack.md changed, and still reuses the specs', async () => {
    const { detailing } = await secondDraft((d) => writeFile(d.draft.stackMd, '# Stack\n\n- Node 22\n- Postgres 16'));
    expect(detailing.filter((c) => c.kind === 'spec')).toEqual([]);
    expect(named(detailing.filter((c) => c.kind === 'preplan'), 'Spec')).toEqual(['caso', 'fat', 'opme', 'triagem']);
  });

  it('makes a broken or missing pre-plan on main again without failing the cycle', async () => {
    const { second, detailing } = await secondDraft(async (d) => {
      await writeFile(`${d.draft.base}/specs/big-001-opme/preplan.json`, '{"specId": "big');
      await rm(`${d.draft.base}/specs/big-001-fat/preplan.json`);
    });
    expect(detailing.filter((c) => c.kind === 'spec')).toEqual([]);
    expect(named(detailing.filter((c) => c.kind === 'preplan'), 'Spec')).toEqual(['fat', 'opme']);
    expect(second.journal.state.status).toBe('ready');
  });

  it('never writes a reused item, and keeps a delivered one beside it', async () => {
    let before = '';
    const { second, detailing } = await secondDraft(async (d) => {
      before = await readFile(`${d.itemDir('opme')}/spec.json`, 'utf8');
      const caso = JSON.parse(await readFile(`${d.draft.base}/specs/big-001-caso/spec.json`, 'utf8'));
      await writeFile(`${d.draft.base}/specs/big-001-caso/spec.json`, JSON.stringify({ ...caso, status: 'done', specVersion: 1, specHash: H }));
    });
    expect(detailing).toEqual([]);
    expect(await readFile(`${second.itemDir('opme')}/spec.json`, 'utf8')).toBe(before);
    expect(second.journal.state.backlog?.specs?.caso?.spec?.status).toBe('done');
    expect(second.journal.state.backlog?.preplans?.caso).toBeUndefined();
    expect(approvals(second)).toEqual([]);
  });

  // R11.7.4: an adjustment comes only from its approval in briefing.md; the PO is never shown one to keep or reword.
  it('adds an approved adjustment after its original and never shows it to the PO', async () => {
    const { draft, journal, run } = await setup();
    await writeFile(draft.briefingMd, '# Briefing\n\n## Objectives\n\n- tudo\n\n## Ajuste aprovado: opme-ajuste-1\n\nA spec big-001-opme foi entregue antes da mudança.\n');
    const agent = fakeAgent(() => OUTLINE);
    await run(agent, 1);
    expect(journal.state.backlog!.items.find((i) => i.key === 'opme-ajuste-1')).toMatchObject({ dependsOn: ['opme'], rank: 4 });
    await writeFile(draft.flowMd, FLOW.replace('C --> D', 'C --> D2[Cotação]'));
    await run(agent, 2);
    const shown = agent.calls.filter((c) => c.kind === 'backlog').at(-1)!.feedback.split('### previous backlog (keep the keys)\n\n')[1]!.split('\n\n### ')[0]!;
    expect(shown).toContain('"opme"');
    expect(shown).not.toContain('opme-ajuste-1');
    expect(journal.state.backlog!.items.map((i) => i.key)).toContain('opme-ajuste-1');
  });

  it('asks the owner once to approve an adjustment of a delivered item whose cited section changed', async () => {
    const { second, agent, detailing } = await secondDraft(deliveredThenChanged);
    expect(detailing).toEqual([]);
    expect(approvals(second)).toEqual([expect.objectContaining({ role: 'po', file: 'brief.md', find: '', status: 'pending' })]);
    expect(approvals(second)[0]!.replace).toMatch(/^## Ajuste aprovado: opme-ajuste-1\n/);
    expect(approvals(second)[0]!.reason).toContain('flow.md › 3. OPME');
    expect(second.journal.state.status).toBe('answering');
    await second.run(agent, 3);
    expect(approvals(second)).toHaveLength(1);
    await second.journal.fact(RefineEvent.PatchRejected, { patchId: approvals(second)[0]!.patchId, reason: null });
    await second.run(agent, 4);
    expect(approvals(second)).toHaveLength(1);
    expect(second.journal.state.status).toBe('ready');
  });

  it('adds the approved adjustment after its original, derives it against the delivered spec, and the program runs it', async () => {
    const agent = fakeAgent(() => OUTLINE);
    const { second } = await secondDraft(deliveredThenChanged, agent);
    const [patch] = approvals(second);
    await writeFile(second.draft.briefingMd, applyPatch(await readFile(second.draft.briefingMd, 'utf8'), patch!)!);
    await second.journal.fact(RefineEvent.PatchAccepted, { patchId: patch!.patchId });
    const from = agent.calls.length;
    await second.run(agent, 3);
    const backlog = second.journal.state.backlog!;
    expect(backlog.items.find((i) => i.key === 'opme-ajuste-1')).toMatchObject({ dependsOn: ['opme'], rank: 4 });
    const specCalls = agent.calls.slice(from).filter((c) => c.kind === 'spec');
    expect(named(specCalls, 'Item')).toEqual(['opme-ajuste-1']);
    expect(specCalls[0]!.feedback).toContain('- big-001-opme:');
    expect(backlog.specs?.opme?.spec?.status).toBe('done');
    expect(approvals(second)).toHaveLength(1);
    expect(second.journal.state.status).toBe('ready');
    const entries = programEntries('big-001', backlog, { 'big-001-opme': 'done' });
    expect(entries.find((e) => e.key === 'opme')?.done).toBe(true);
    expect(entries.find((e) => e.key === 'opme-ajuste-1')).toMatchObject({ dependsOn: ['big-001-opme'] });
  });

  // R11.7.5: an item that leaves the outline leaves main too, as a retired spec Phase 0 publishes.
  it('retires a planned item the new outline dropped, and leaves it out of specs.json', async () => {
    const { second } = await secondDraft(withoutFat, fakeAgent(() => OUTLINE.filter((i) => i.key !== 'fat')));
    expect(JSON.parse(await readFile(`${second.itemDir('fat')}/spec.json`, 'utf8')).status).toBe('retired');
    expect(JSON.parse(await readFile(`${second.docs}/specs.json`, 'utf8')).specs.map((s: { key: string }) => s.key)).toEqual(['caso', 'triagem', 'opme']);
    expect(second.journal.state.status).toBe('ready');
  });

  it('keeps a delivered item whose sections left the docs, and asks the owner whether an adjustment removes it', async () => {
    const { second } = await secondDraft(async (d) => {
      await markStatus(d, 'fat', 'done');
      await withoutFat(d);
    }, fakeAgent(() => OUTLINE.filter((i) => i.key !== 'fat')));
    expect(second.journal.state.backlog!.items.find((i) => i.key === 'fat')).toMatchObject({ dependsOn: ['opme'] });
    expect(second.journal.state.backlog!.specs?.fat?.spec?.status).toBe('done');
    expect(approvals(second)).toEqual([expect.objectContaining({ status: 'pending', replace: expect.stringMatching(/^## Ajuste aprovado: fat-ajuste-1\n[\s\S]*remove essa funcionalidade/) })]);
  });

  // Plan 80 review: an item main retired and a later outline brings back unchanged is planned again, not retired forever.
  it('plans again an item whose spec main retired, when the outline brings it back unchanged', async () => {
    const { second } = await secondDraft(async (d) => {
      const file = `${d.draft.base}/specs/big-001-fat/spec.json`;
      await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), status: 'retired' }));
    });
    expect(JSON.parse(await readFile(`${second.itemDir('fat')}/spec.json`, 'utf8')).status).toBe('planned');
    expect(second.journal.state.backlog!.specs?.fat?.spec?.status).toBe('planned');
    expect(second.journal.state.status).toBe('ready');
  });

  // Security: main's specs.json is a file of the target repository, and its keys become paths in the draft.
  it("ignores main's outline when a key in its index is not a slug, and deletes nothing outside the draft", async () => {
    const { second } = await secondDraft(async (d) => {
      await mkdir(`${d.draft.root}/sentinel`, { recursive: true });
      await writeFile(`${d.draft.root}/sentinel/keep.txt`, 'x');
      const file = `${d.draft.base}/specs.json`;
      const index = JSON.parse(await readFile(file, 'utf8'));
      index.specs.push({ ...index.specs[0], specId: 'outro', key: '../../../../sentinel', title: 'Outro item' });
      await writeFile(file, JSON.stringify(index));
    });
    expect(await exists(`${second.draft.root}/sentinel/keep.txt`)).toBe(true);
  });

  it('never touches a path outside the draft for a spec id that is not a slug', async () => {
    const { draft } = await setup();
    await mkdir(`${draft.root}/sentinel`, { recursive: true });
    await writeFile(`${draft.root}/sentinel/keep.txt`, 'x');
    await retireDropped(draft, ['../../sentinel']);
    await restoreFromBase(draft, '../../sentinel');
    expect(await exists(`${draft.root}/sentinel/keep.txt`)).toBe(true);
  });

  it('keeps a started adjustment whose approval section the owner removed', async () => {
    const approve = (d: Env) => writeFile(d.draft.briefingMd, '# Briefing\n\n## Objectives\n\n- tudo\n\n## Ajuste aprovado: opme-ajuste-1\n\ntexto\n');
    const { second } = await secondDraft((d) => markStatus(d, 'opme-ajuste-1', 'running'), fakeAgent(() => OUTLINE), approve);
    expect(second.journal.state.backlog!.items.find((i) => i.key === 'opme-ajuste-1')).toMatchObject({ dependsOn: ['opme'] });
    expect(second.journal.state.backlog!.specs?.['opme-ajuste-1']?.spec?.status).toBe('running');
    // Plan 80 review: removing the approval section is no change to the feature, so nothing is asked.
    expect(approvals(second)).toEqual([]);
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

  it('goes on to ready when the quota rejects a spec step once and the wait clears it', async () => {
    const { journal, run } = await setup();
    const breaker = new QuotaBreaker();
    const reading = { status: 'rejected', resetsAt: null, fiveHourUtilization: null, fiveHourResetsAt: null, sevenDayUtilization: null, sevenDayResetsAt: null };
    const agent = fakeAgent(() => OUTLINE, (req, n) => {
      if (req.kind !== 'spec' || n !== 1) return undefined;
      breaker.onQuotaFailure(reading as never);
      return { ok: false, failure: 'quota', errors: ['5-hour window'], summary: {}, sandboxDisabled: false };
    });
    const sleeps: number[] = [];
    const waiting = { ...agent, fn: withQuotaWait(agent.fn as never, breaker, { sleep: async (ms) => { sleeps.push(ms); breaker.state().status === 'paused' && vi.setSystemTime(Date.now() + ms); }, now: () => new Date(), log: () => undefined }) };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await run(waiting as never, 1);
      await journal.fact(RefineEvent.BacklogDetailEnabled, {});
      await run(waiting as never, 2);
    } finally {
      vi.useRealTimers();
    }
    expect(sleeps).toHaveLength(1);
    expect(journal.state.status).toBe('ready');
  });

  it('leaves no conflict map when the SM call fails, and the backlog still reaches ready', async () => {
    const { journal, events, run } = await setup();
    const agent = fakeAgent(() => OUTLINE, (req) => (req.kind === 'conflicts' ? { ok: false, failure: 'schema', errors: ['bad json'], summary: {}, sandboxDisabled: false } : undefined));
    await run(agent, 1);
    await journal.fact(RefineEvent.BacklogDetailEnabled, {});
    await run(agent, 2);
    expect(journal.state.backlog?.conflicts).toBeUndefined();
    expect(journal.state.status).toBe('ready');
    expect(events.filter((e) => e.type === 'REFINE_CYCLE_FAILED')).toEqual([]);
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

describe('backlog detailing failure paths', () => {
  const quota = { ok: false, failure: 'quota', errors: ['janela de 5 horas'], summary: {}, sandboxDisabled: false };
  const detailed = async () => {
    const env = await setup();
    const agent = fakeAgent(() => OUTLINE);
    await env.run(agent, 1);
    await env.journal.fact(RefineEvent.BacklogDetailEnabled, {});
    return { ...env, agent };
  };

  it('fails the cycle with the reason when a batch throws, and starts no call after the error', async () => {
    const { journal, events, run } = await setup();
    let thrown = false;
    let callsAfterError = 0;
    const agent = fakeAgent(() => OUTLINE.map((i, n) => ({ ...i, epic: epics[n]!.key })), () => {
      if (thrown) callsAfterError += 1;
      return undefined;
    });
    await run(agent, 1);
    await journal.fact(RefineEvent.BacklogDetailEnabled, {});
    const fact = journal.fact;
    journal.fact = async (type: string, data: Record<string, unknown> = {}) => {
      if (type === RefineEvent.SpecDerived && data.key === 'caso') {
        thrown = true;
        throw new Error('disco cheio');
      }
      return fact(type, data);
    };
    const from = agent.calls.length;
    await run(agent, 2);
    expect(callsAfterError).toBe(0);
    expect(agent.kinds(from).every((k) => k === 'spec')).toBe(true);
    expect(String(events.find((e) => e.type === 'REFINE_CYCLE_FAILED')?.data.reason)).toMatch(/disco cheio/);
  });

  it('records the valid items of a batch before retrying the invalid one', async () => {
    const { journal, events, run } = await setup();
    let recordedBeforeRetry: boolean | null = null;
    const agent = fakeAgent(() => OUTLINE, (req, n) => {
      const fb = String(req.pack.feedback);
      if (req.kind === 'spec' && n === 1 && fb.includes('## Item caso:')) return ok({ specHash: H, specs: [{ ...itemSpec('caso'), type: 'bug' }, itemSpec('triagem')] });
      if (req.kind === 'spec' && fb.includes('rejected')) {
        recordedBeforeRetry = events.some((e) => e.type === 'SPEC_DERIVED' && e.data.key === 'triagem' && e.data.spec !== null);
        return quota;
      }
      return undefined;
    });
    await run(agent, 1);
    await journal.fact(RefineEvent.BacklogDetailEnabled, {});
    await run(agent, 2);
    expect(recordedBeforeRetry).toBe(true);
  });

  it('ignores a generated spec.json it cannot read instead of failing every cycle', async () => {
    const { journal, events, run, itemDir, agent } = await detailed();
    await mkdir(itemDir('caso'), { recursive: true });
    await writeFile(`${itemDir('caso')}/spec.json`, '{"specId": "big-001-ca');
    await run(agent, 2);
    expect(events.filter((e) => e.type === 'REFINE_CYCLE_FAILED')).toEqual([]);
    expect(journal.state.status).toBe('ready');
  });

  it('numbers criteria above the ids of the target project specs already in the draft', async () => {
    const { run, itemDir, docs, agent } = await detailed();
    await mkdir(`${docs}/specs/outra-001`, { recursive: true });
    await writeFile(`${docs}/specs/outra-001/spec.json`, JSON.stringify({ acceptanceCriteria: [{ id: 'AC-040' }] }));
    await run(agent, 2);
    expect(JSON.parse(await readFile(`${itemDir('caso')}/spec.json`, 'utf8')).acceptanceCriteria[0].id).toBe('AC-041');
  });

  // R11.7.2: a new backlog draft over a delivered item never re-derives it, and puts back main's copy over a stale one.
  it('keeps an item whose spec on main started or was delivered exactly as main has it, and still reaches ready', async () => {
    const { journal, run, itemDir, agent, draft } = await detailed();
    const delivered = JSON.stringify({ specId: 'big-001-caso', specVersion: 2, specHash: H, type: 'feature', objectives: ['Entregar caso'], features: ['caso'], acceptanceCriteria: [{ id: 'AC-001', given: 'g', when: 'w caso', then: 't1', smoke: true }], outOfScope: [], externalDependencies: [], status: 'done', validationReports: [] }, null, 2);
    await mkdir(`${draft.base}/specs/big-001-caso`, { recursive: true });
    await writeFile(`${draft.base}/specs/big-001-caso/spec.json`, delivered);
    // A copy this draft wrote before (detailed before R11.7.2), which Phase 0 would publish over main's.
    await mkdir(itemDir('caso'), { recursive: true });
    await writeFile(`${itemDir('caso')}/spec.json`, JSON.stringify({ ...JSON.parse(delivered), status: 'planned', specVersion: 0 }));
    await run(agent, 2);
    const detailing = agent.calls.filter((c) => c.kind === 'spec' || c.kind === 'preplan');
    expect(detailing.length).toBeGreaterThan(0);
    expect(detailing.some((c) => c.feedback.includes('## Item caso:') || c.feedback.includes('## Spec caso:'))).toBe(false);
    expect(await readFile(`${itemDir('caso')}/spec.json`, 'utf8')).toBe(delivered);
    expect(journal.state.backlog?.specs?.caso?.spec?.status).toBe('done');
    expect(journal.state.status).toBe('ready');
  });

  // Plan 77 review: a start that froze an item and then failed to launch must not leave the draft refusing it forever.
  it('keeps detailing an item this draft froze itself, since main still has none started', async () => {
    const { journal, run, itemDir, agent } = await detailed();
    await run(agent, 2);
    const file = `${itemDir('caso')}/spec.json`;
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), status: 'running', specVersion: 1, specHash: H }));
    await run(agent, 3);
    expect(journal.state.backlog?.specs?.caso?.spec?.status).not.toBe('running');
    expect(programEntries('big-001', journal.state.backlog!, {}).find((e) => e.key === 'caso')?.done).toBeUndefined();
  });

  it('writes a spec back to refining on disk when its spec or its pre-plan fails again', async () => {
    const { run, itemDir, draft, journal } = await detailed();
    let failing = false;
    const agent = fakeAgent(() => OUTLINE, (req) => {
      const fb = String(req.pack.feedback);
      if (!failing) return undefined;
      if (req.kind === 'preplan' && fb.includes('## Spec opme:')) return ok({ specHash: H, preplans: fb.split(/^## Spec /m).slice(1).map((s) => ({ ...preplanFor(s), tasks: [{ id: 'P1', title: 'x', module: 'm', owner: 'dev', criteriaRefs: ['AC-099'], dependsOn: [] }] })) });
      if (req.kind === 'spec' && fb.includes('## Item fat:')) return ok({ specHash: H, specs: [{ ...itemSpec('fat'), type: 'bug' }] });
      return undefined;
    });
    await run(agent, 2);
    expect(JSON.parse(await readFile(`${itemDir('opme')}/spec.json`, 'utf8')).status).toBe('planned');
    failing = true;
    await writeFile(draft.stackMd, '# Stack\n\n- Node 22\n- Postgres 16');
    await writeFile(draft.flowMd, FLOW.replace('D --> E', 'D --> E2[Nota fiscal]'));
    await run(agent, 3);
    expect(JSON.parse(await readFile(`${itemDir('opme')}/spec.json`, 'utf8')).status).toBe('refining');
    expect(JSON.parse(await readFile(`${itemDir('fat')}/spec.json`, 'utf8')).status).toBe('refining');
    expect(JSON.parse(await readFile(`${itemDir('caso')}/spec.json`, 'utf8')).status).toBe('planned');
    expect(journal.state.status).not.toBe('ready');
  });
});

// R11.5a item 3 (plan 85): the Jev checks each first answer, and a flagged item goes back to its agent once.
describe('backlog detailing checked by the Jev', () => {
  const quota = { ok: false, failure: 'quota', errors: ['janela de 5 horas'], summary: {}, sandboxDisabled: false };
  const extra = (key: string) => ({ ...itemSpec(key), features: [key, 'pagamento'] });
  /** The specs of every item a spec pack names, `caso` with a feature no section asks for. */
  const withExtra = (req: Req) => ok({ specHash: H, specs: [...String(req.pack.feedback).matchAll(/^## Item ([a-z0-9-]+):/gm)].map((m) => (m[1] === 'caso' ? extra(m[1]) : itemSpec(m[1]!))) });
  const retried = (req: Req) => String(req.pack.feedback).includes('rejected');
  /** Derives the outline, then details it with the agent's hook and the Jev. */
  const detailWith = async (hook: (req: Req) => unknown, decider: ReturnType<typeof jev>) => {
    const env = await setup();
    const agent = fakeAgent(() => OUTLINE, hook);
    await env.run(agent, 1);
    await env.journal.fact(RefineEvent.BacklogDetailEnabled, {});
    const from = agent.calls.length;
    await env.run(agent, 2, decider);
    return { ...env, retries: agent.calls.slice(from).filter((c) => c.feedback.includes('rejected')) };
  };
  const featuresOf = async (env: { itemDir: (key: string) => string }, key: string) => JSON.parse(await readFile(`${env.itemDir(key)}/spec.json`, 'utf8')).features;

  it('sends a spec the Jev flags back alone once with the flags, records the retry, and journals each check', async () => {
    const env = await detailWith((req) => (req.kind === 'spec' && !retried(req) ? withExtra(req) : undefined), jev('pagamento'));
    expect(env.retries.map((c) => c.kind)).toEqual(['spec']);
    expect(env.retries[0]!.feedback).toContain('## Item caso:');
    expect(env.retries[0]!.feedback).toContain('apontou que esta tentativa da spec acrescenta');
    expect(env.retries[0]!.feedback).toContain('caso; pagamento');
    expect(await featuresOf(env, 'caso')).toEqual(['caso']);
    expect(env.journal.state.status).toBe('ready');
    expect(env.events.some((e) => e.type === 'DECISION_MADE' && (e.data.record as { decisionId: string }).decisionId === 'spec-cited-sections')).toBe(true);
  });

  it('never checks a solo retry, so a flag costs one more call at most', async () => {
    const decider = jev('pagamento');
    const env = await detailWith((req) => (req.kind === 'spec' ? withExtra(req) : undefined), decider);
    expect(env.retries).toHaveLength(1);
    expect(decider.states.filter((s) => s.startsWith('item caso:'))).toHaveLength(1);
    expect(await featuresOf(env, 'caso')).toEqual(['caso', 'pagamento']);
    expect(env.journal.state.status).toBe('ready');
  });

  it("keeps a flagged spec's first answer when its retry is not valid, with every criterion number unique", async () => {
    const env = await detailWith((req) => (req.kind !== 'spec' ? undefined : retried(req) ? ok({ specHash: H, specs: [{ ...itemSpec('caso'), type: 'bug' }] }) : withExtra(req)), jev('pagamento'));
    expect(env.retries).toHaveLength(1);
    expect(await featuresOf(env, 'caso')).toEqual(['caso', 'pagamento']);
    expect(env.journal.state.backlog?.specs?.caso?.issues).toEqual([]);
    const ids = Object.values(env.journal.state.backlog?.specs ?? {}).flatMap((row) => row.spec?.acceptanceCriteria.map((c) => c.id) ?? []);
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    expect(env.journal.state.status).toBe('ready');
  });

  it("keeps a flagged spec's first answer when its retry stops on quota, while the cycle fails as interrupted", async () => {
    const env = await detailWith((req) => (req.kind !== 'spec' ? undefined : retried(req) ? quota : withExtra(req)), jev('pagamento'));
    expect(env.journal.state.backlog?.specs?.caso?.spec?.features).toEqual(['caso', 'pagamento']);
    expect(String(env.events.find((e) => e.type === 'REFINE_CYCLE_FAILED')?.data.reason)).toMatch(/interrompido/);
  });

  // Plan 85 review: a rejected item earlier in the batch found the run stopped and left before the flagged one.
  it('keeps a flagged first answer when an earlier rejected item of its batch finds the run stopped', async () => {
    const env = await detailWith((req) => {
      if (req.kind !== 'spec') return undefined;
      if (String(req.pack.feedback).includes('## Item opme:')) return quota;
      if (retried(req)) return undefined;
      const keys = [...String(req.pack.feedback).matchAll(/^## Item ([a-z0-9-]+):/gm)].map((m) => m[1]!);
      return ok({ specHash: H, specs: keys.map((k) => (k === 'caso' ? { ...itemSpec(k), type: 'bug' } : k === 'triagem' ? extra(k) : itemSpec(k))) });
    }, jev('pagamento'));
    expect(String(env.events.find((e) => e.type === 'REFINE_CYCLE_FAILED')?.data.reason)).toMatch(/interrompido/);
    expect(env.journal.state.backlog?.specs?.triagem?.spec?.features).toEqual(['triagem', 'pagamento']);
  });

  it("keeps a confidential project's text away from the Jev", async () => {
    const decider = jev('pagamento');
    await detailWith((req) => (req.kind === 'backlog' ? ok({ specHash: H, project: makeProject({ confidential: true }), backlog: { epics, items: OUTLINE } }) : undefined), decider);
    expect(decider.confidential.length).toBeGreaterThan(0);
    expect(decider.confidential.every(Boolean)).toBe(true);
  });

  it('sends a pre-plan the Jev flags back alone once with the flag', async () => {
    const env = await detailWith((req) => {
      if (req.kind !== 'preplan' || retried(req)) return undefined;
      const preplans = String(req.pack.feedback).split(/^## Spec /m).slice(1).map(preplanFor);
      return ok({ specHash: H, preplans: preplans.map((p) => (p.key === 'opme' ? { ...p, modules: [{ name: 'm', purpose: 'relógio do banco' }] } : p)) });
    }, jev('relógio do banco'));
    expect(env.retries.map((c) => c.kind)).toEqual(['preplan']);
    expect(env.retries[0]!.feedback).toContain('## Spec opme:');
    expect(env.retries[0]!.feedback).toContain('apontou que esta tentativa do pré-plano contradiz');
    expect(env.journal.state.backlog?.preplans?.opme?.preplan?.modules).toEqual([{ name: 'm', purpose: 'p' }]);
    expect(env.journal.state.status).toBe('ready');
  });
});

describe('backlog detailing secrets', () => {
  it('lists each missing secret of the item specs once', async () => {
    const { journal, events, run } = await setup();
    const agent = fakeAgent(() => OUTLINE, (req) => {
      if (req.kind !== 'spec') return undefined;
      const fb = String(req.pack.feedback);
      return ok({ specHash: H, specs: [...fb.matchAll(/^## Item ([a-z0-9-]+):/gm)].map((m) => ({ ...itemSpec(m[1]!), externalDependencies: [{ name: 'db', purpose: 'dados', secretNames: ['DATABASE_URL'] }] })) });
    });
    await run(agent, 1);
    await journal.fact(RefineEvent.BacklogDetailEnabled, {});
    await run(agent, 2);
    const evaluated = events.filter((e) => e.type === 'REFINE_EVALUATED').at(-1)!;
    const secrets = (evaluated.data.checklist as Array<{ id: string; detail: string }>).find((i) => i.id === 'sm.dependencies-and-secrets')!;
    expect(secrets.detail).toBe('missing secrets: DATABASE_URL');
  });
});
