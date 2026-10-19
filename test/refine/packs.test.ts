import { describe, expect, it } from 'vitest';
import { flowTemplate, stackTemplate } from '../../server/refine/draft.js';
import { fitPackBudget, PACK_TOKEN_CAP } from '../../server/refine/fit-pack.js';
import { refinePack } from '../../server/refine/packs.js';
import type { BacklogState } from '../../server/refine/state.js';
import { makeSpec } from '../fixtures/contracts.js';

const base = {
  specHash: 'sha256:' + 'a'.repeat(64),
  principles: [],
  specId: 'spec-1',
  projectMd: '# p',
  briefMd: '# b',
  derived: { project: {}, spec: { acceptanceCriteria: [], objectives: [] } },
  retrieval: [],
  history: [],
  rejected: [],
} as unknown as Parameters<typeof refinePack>[0];

describe('refinePack', () => {
  it('asks every role to report defects in the documents it does not own as findings, at most 3 each', () => {
    for (const role of ['po', 'sm', 'front'] as const) {
      const { feedback } = refinePack({ ...base, role });
      expect(feedback).toContain('FINDINGS:');
      expect(feedback).toContain('at most 3 findings per document');
    }
  });

  it('tells the front agent to review only and answer with the JSON object', () => {
    const { feedback } = refinePack({ ...base, role: 'front' });
    expect(feedback).toContain('This is a review, not an implementation task');
    expect(feedback).toContain('do not edit or create files');
  });

  // R11.7.1: a continued spec's decisions are answered questions the agents must not ask again.
  it('lists the decisions the spec carries with the answered questions', () => {
    const decided = { ...base, derived: { project: {}, spec: { acceptanceCriteria: [], objectives: [], decisions: [{ question: 'Port?', answer: '8080' }] } } } as unknown as Parameters<typeof refinePack>[0];
    const feedback = refinePack({ ...decided, role: 'sm' }).feedback ?? '';
    const answered = feedback.slice(feedback.indexOf('### Answered questions (do not ask again)'), feedback.indexOf('### Skipped questions'));
    expect(answered).toContain('Port?');
    expect(answered).toContain('8080');
  });

  it('asks the SM to fill a blank stack.md and flow.md instead of questioning the human, and keeps the PO out of it', () => {
    const blank = { ...base, stackMd: stackTemplate(), flowMd: flowTemplate() };
    const sm = refinePack({ ...blank, role: 'sm' }).feedback;
    expect(sm).toContain('only the blank template');
    expect(sm).toContain('docs/stack.md');
    expect(sm).toContain('docs/flow.md');
    expect(sm).toContain('Do NOT ask the human');
    const po = refinePack({ ...blank, role: 'po' }).feedback;
    expect(po).toContain('the SM fills them');
    expect(po).not.toContain('Do NOT ask the human');
    // once the files hold real content there is nothing to fill
    expect(refinePack({ ...base, role: 'sm', stackMd: '# Stack\n\n- Node 22\n', flowMd: '# Fluxo\n' }).feedback).not.toContain('only the blank template');
  });

  it('lists the open questions, and from the second cycle says an answer is final', () => {
    const history = [{ questionId: 'po-c1-0', role: 'po', text: 'Qual porta?', blocking: true, relatedAcIds: [], cycle: 1, status: 'pending', answer: null }];
    const po = refinePack({ ...base, role: 'po', cycle: 2, history } as never).feedback ?? '';
    expect(po).toContain('### Open questions (waiting for the owner: do not ask again, not even reworded)\n\n- [po] Qual porta?');
    expect(po).toContain('An answer the owner gave is final');
  });

  it('gives reviewers the Jev scores as a hint, not as raw JSON', () => {
    const jevValidation = { available: true, decision: 'blocked', consistent: false, confidence: 0.56, model: 'jev', checks: { documents_consistent: 0.44 }, stateTruncated: false };
    const po = refinePack({ ...base, role: 'po', jevValidation } as never).feedback ?? '';
    expect(po).toContain('Automatic and often wrong, never a verdict. Scores (probability of yes): documents_consistent 0.44.');
    expect(po).not.toContain('"decision"');
  });

  it('asks only the PO for the contradictions it can prove with quotes', () => {
    const po = refinePack({ ...base, role: 'po' }).feedback ?? '';
    expect(po).toContain('add one entry to `contradictions`');
    expect(po).toContain('never shortened with "..."');
    expect(refinePack({ ...base, role: 'sm' }).feedback).not.toContain('`contradictions`');
  });

  it('tells each role what it owns and what the other two own', () => {
    for (const role of ['po', 'sm', 'front'] as const) {
      const feedback = refinePack({ ...base, role }).feedback ?? '';
      expect(feedback).toContain('ROLES IN THIS REVIEW');
      expect(feedback).toContain(`You are the ${role.toUpperCase()}`);
      expect(feedback).toContain('PO owns what and why');
      expect(feedback).toContain('SM owns how and in what order');
      expect(feedback).toContain('Front owns design.md only');
    }
  });

  it('keeps design.md with Front: PO and SM never review or patch it', () => {
    expect(refinePack({ ...base, role: 'front' }).feedback).toContain('Treat design.md as the frontend source of truth');
    for (const role of ['po', 'sm'] as const) {
      const feedback = refinePack({ ...base, role }).feedback ?? '';
      expect(feedback).not.toContain('Treat design.md as the frontend source of truth');
      expect(feedback).toContain("design.md is Front's");
    }
  });

  it('gives the PO the business flow review, the SM the build review, and Front neither', () => {
    expect(refinePack({ ...base, role: 'po' }).feedback).toContain('business and application flow contract');
    expect(refinePack({ ...base, role: 'sm' }).feedback).toContain('Review flow.md as something to build');
    const front = refinePack({ ...base, role: 'front' }).feedback ?? '';
    expect(front).not.toContain('business and application flow contract');
    expect(front).not.toContain('Review flow.md as something to build');
    expect(front).toContain('flow.md is context for you: do not review it.');
  });

  it('does not add the review-only rule for po', () => {
    expect(refinePack({ ...base, role: 'po' }).feedback).not.toContain('not an implementation task');
  });

  it('reviews the derived backlog instead of a spec in backlog mode, and keeps criteria empty', () => {
    const backlog = { enabled: true, project: null, epics: [{ key: 'core', title: 'Núcleo' }], items: [{ key: 'base', title: 'Base', epic: 'core', scope: 's', priority: 'P0', rationale: 'r', dependsOn: [], sources: [{ doc: 'briefing.md', heading: 'x' }], size: 'S', rank: 1 }], cycle: 1 };
    const pack = refinePack({ ...base, role: 'po', derived: { project: {}, spec: null }, backlog, projectBriefing: true, rejected: [{ file: 'brief.md', find: 'old', decision: 'no' }] } as never);
    expect(pack.feedback).toContain('### docs/briefing.md');
    expect(pack.feedback).toContain('Patch files: docs/project.md, docs/briefing.md, docs/flow.md.');
    expect(pack.feedback).toContain('- docs/briefing.md: "old" → rejected: no');
    expect(pack.feedback).not.toContain('brief.md');
    expect(pack.feedback).toContain('### derived backlog');
    expect(pack.feedback).toContain('"key": "base"');
    expect(pack.feedback).not.toContain('### derived spec.json');
    expect(pack.feedback).toContain('Backlog mode');
    // R11.10 (plan 87): one heading per decision, so each item cites only the decisions it needs.
    expect(pack.feedback).toContain('its own `### <subject>` heading under the `## Decisões` section of docs/briefing.md');
    // R11.10 (plan 90): the orchestrator writes the owner's answers, so no agent records one again.
    expect(pack.feedback).toContain('Give every question a `subject`: 3 to 8 words in Brazilian Portuguese naming its topic');
    expect(pack.feedback).toContain('The orchestrator writes each answer the owner gives under that subject as its own heading there, so never propose a patch that records an answer again.');
    expect(pack.feedback).not.toContain('recorded as a docPatch');
    // Plan 90 review: an older list turns into headings through a patch of its own, and the outline rule no longer asks to record answers.
    expect(pack.feedback).toContain('propose one patch that turns each of its lines into its own heading');
    expect(pack.feedback).not.toContain('in the same patch');
    expect(pack.feedback).not.toContain('recording a decision the owner gave');
    // Plan 87 review: an older list of decisions saves nothing until each line is a heading; the Front never records one.
    expect(refinePack({ ...base, role: 'front', derived: { project: {}, spec: null }, backlog, projectBriefing: true } as never).feedback).not.toContain('## Decisões');
    expect(pack.criteria).toEqual([]);
    expect(pack.objectives).toEqual(['Núcleo']);
    expect(refinePack({ ...base, role: 'po' }).feedback).not.toContain('Backlog mode');
    expect(refinePack({ ...base, role: 'po' }).feedback).not.toContain('## Decisões');
  });
  // R11.10 (plan 88): before the detailing, the review leaves what a spec decides to the detailing, and nothing else waits.
  it('tells the PO and the SM reviewing an outline to leave spec details to the detailing, and nobody else', () => {
    const backlog = { enabled: true, project: null, epics: [{ key: 'core', title: 'Núcleo' }], items: [], cycle: 1 };
    const review = (role: 'po' | 'sm' | 'front', b: object = backlog, cycle = 1) => String(refinePack({ ...base, role, derived: { project: {}, spec: null }, backlog: b, projectBriefing: true, cycle } as never).feedback);
    const rule = 'Outline review (no spec yet): never ask about or patch a detail a spec decides';
    expect(review('po')).toContain(rule);
    expect(review('po')).toContain('It never holds back a contradiction between the docs, a split into services the docs leave open, filling a blank stack.md or flow.md, or turning an older list of decisions into headings.');
    expect(review('po')).not.toContain('which asks about it then');
    expect(review('sm')).toContain(rule);
    expect(review('front')).not.toContain(rule);
    // From the second cycle on it stands beside the convergence rule.
    expect(review('po', backlog, 2)).toContain(rule);
    expect(review('po', backlog, 2)).toContain('CONVERGENCE');
    const detailed = { ...backlog, detail: true, flowHeadings: [] };
    expect(review('po', detailed)).not.toContain(rule);
    expect(review('sm', detailed)).not.toContain(rule);
    expect(refinePack({ ...base, role: 'po' }).feedback).not.toContain(rule);
  });
});

describe('refinePack moves and findings', () => {
  it('every role may move misplaced content, and the move rule reaches every review', () => {
    for (const role of ['po', 'sm', 'front'] as const) {
      const feedback = refinePack({ ...base, role }).feedback ?? '';
      expect(feedback).toContain('MOVES: content that sits in the wrong document');
      expect(feedback).toContain('except content in the wrong document: any role may move that');
    }
    expect(refinePack({ ...base, role: 'front' }).feedback).toContain('is a move to the document that holds it, not a patch');
    expect(refinePack({ ...base, role: 'front' }).feedback).toContain('A visual value written in the briefing (a color, size or contrast) is a move to design.md too');
    expect(refinePack({ ...base, role: 'front' }).feedback).toContain('A patch never replaces or deletes such a line');
  });

  it('reads the move rule before the roles, and asks for a line-by-line check', () => {
    const feedback = refinePack({ ...base, role: 'po' }).feedback ?? '';
    expect(feedback.indexOf('MOVES: content that sits in the wrong document')).toBeLessThan(feedback.indexOf('ROLES IN THIS REVIEW'));
    expect(feedback).toContain('read each of the five documents line by line');
  });

  it('shows each role only the findings about the documents it owns', () => {
    const finding = { cycle: 1, role: 'po', doc: 'stack.md', severity: 'blocking', quote: '- Node 22', text: 'A versão difere do flow.', fix: 'Alinhe a versão.' };
    expect(refinePack({ ...base, role: 'sm', findings: [finding] } as never).feedback).toContain('- [po] stack.md (blocking): "- Node 22" → A versão difere do flow. Fix: Alinhe a versão.');
    expect(refinePack({ ...base, role: 'po', findings: [finding] } as never).feedback).not.toContain('A versão difere do flow.');
  });

  it('lists the moves the owner undid, so no role proposes them again', () => {
    const undone = [{ from: 'design.md' as const, to: 'flow.md' as const, quote: '- Feedback: ao criar uma tarefa, primeiro salve.' }];
    const feedback = refinePack({ ...base, role: 'front', undoneMoves: undone } as never).feedback ?? '';
    expect(feedback).toContain('### Moves the owner undid (do not propose them again)\n\n- docs/design.md → docs/flow.md: "- Feedback: ao criar uma tarefa, primeiro salve."');
    expect(refinePack({ ...base, role: 'front' }).feedback).toContain('### Moves the owner undid (do not propose them again)\n\n(none)');
  });

  it('lets each role patch the documents it owns: the SM stack.md and flow.md, the PO project.md, brief.md and flow.md', () => {
    expect(refinePack({ ...base, role: 'sm' }).feedback).toContain('Patch files: docs/stack.md, docs/flow.md.');
    expect(refinePack({ ...base, role: 'po' }).feedback).toContain('Patch files: docs/project.md, docs/specs/spec-1/brief.md, docs/flow.md.');
    expect(refinePack({ ...base, role: 'po' }).feedback).not.toContain('docs/stack.md');
  });

  it('asks for the spec-scope move only in the detailed review', () => {
    const backlog = { enabled: true, project: null, epics: [{ key: 'core', title: 'Núcleo' }], items: [], cycle: 1, detail: true, flowHeadings: [] };
    expect(refinePack({ ...base, role: 'po', derived: { project: {}, spec: null }, backlog, projectBriefing: true, cycle: 3 } as never).feedback).toContain('never edit a generated spec');
    expect(refinePack({ ...base, role: 'po' }).feedback).not.toContain('never edit a generated spec');
  });
});

describe('refinePack in detail mode', () => {
  const H = `sha256:${'1'.repeat(64)}`;
  const REV = `sha256:${'2'.repeat(64)}`;
  const ac = (n: number) => ({ id: `AC-${String(n).padStart(3, '0')}`, given: 'um pedido de OPME aberto pelo médico auditor', when: 'a cotação chega', then: 'o pedido segue para aprovação '.repeat(4), smoke: n % 6 === 1 });
  const detailed = (count: number, changedCycle: number): BacklogState => {
    const items = Array.from({ length: count }, (_, n) => ({ key: `item-${n}`, title: `Item ${n}`, epic: 'core', scope: 'escopo do item '.repeat(8), priority: 'P1' as const, rationale: 'r', dependsOn: [], sources: [{ doc: 'flow.md' as const, heading: `${n}. Seção` }], size: 'M' as const, rank: n + 1 }));
    const criteria = (n: number) => Array.from({ length: 6 }, (_, a) => ac(n * 6 + a + 1));
    return {
      enabled: true, project: null, epics: [{ key: 'core', title: 'Núcleo' }], items, cycle: 1, detail: true, flowHeadings: [],
      specs: Object.fromEntries(items.map((i, n) => [i.key, { inputHash: H, specId: `k-${i.key}`, rev: REV, spec: { ...makeSpec({ specId: `k-${i.key}` }), acceptanceCriteria: criteria(n) }, issues: [], cycle: n < 3 ? changedCycle : 2 }])),
      preplans: Object.fromEntries(items.map((i, n) => [i.key, { inputHash: H, specRev: REV, issues: [], cycle: 2, preplan: { specId: `k-${i.key}`, specRev: REV, inputHash: H, modules: [{ name: 'opme', purpose: 'p' }], tasks: criteria(n).map((c, t) => ({ id: `P${t + 1}`, title: `Tarefa ${t + 1} do item ${n}`, module: 'opme', owner: 'dev' as const, criteriaRefs: [c.id], dependsOn: [] })), risks: [] } }])),
    } as BacklogState;
  };

  it('reviews a digest of every item and full JSON only for what changed this cycle, within the cap for 60 items and 45k tokens of docs', () => {
    const big = 'x'.repeat(36_000);
    const pack = fitPackBudget(refinePack({ ...base, role: 'po', derived: { project: {}, spec: null }, backlog: detailed(60, 5), projectBriefing: true, cycle: 5, projectMd: big, briefMd: big, stackMd: big, flowMd: big, designMd: big } as never));
    expect(pack.budgetTokens).toBeLessThanOrEqual(PACK_TOKEN_CAP);
    expect(pack.feedback).not.toContain('the docs broken into prioritized specs');
    expect(pack.feedback).toContain('[60] P1 item-59: Item 59');
    expect(pack.feedback).toContain('P6 [AC-360] Tarefa 6 do item 59 · opme');
    expect(pack.feedback).toContain('"specId": "k-item-0"');
    expect(pack.feedback).not.toContain('"specId": "k-item-10"');
    expect(pack.feedback).toMatch(/specs change only through the docs/i);
    // R11.10 (plan 88): a criterion is read against what its item and its dependencies deliver.
    expect(pack.feedback).toContain('checkable with what its own item and the items it depends on, directly or through others, deliver');
  });

  // Plan 77 review: a started or delivered spec is frozen; the review neither re-reads it as changed nor expects a pre-plan.
  it('marks a delivered item in the digest, tells the reviewers it is frozen, and leaves it out of the changed items', () => {
    const b = detailed(2, 3);
    const done = { ...b.specs!['item-0']!, spec: { ...b.specs!['item-0']!.spec!, status: 'done' as const } };
    const pack = refinePack({ ...base, role: 'sm', derived: { project: {}, spec: null }, backlog: { ...b, specs: { ...b.specs, 'item-0': done }, preplans: { 'item-1': b.preplans!['item-1']! } }, projectBriefing: true, cycle: 3 } as never);
    expect(pack.feedback).toMatch(/item-0: Item 0 .*— entregue/);
    expect(pack.feedback).toContain('never reviewed, questioned or patched');
    expect(pack.feedback).not.toContain('"specId": "k-item-0"');
    expect(pack.feedback).toContain('"specId": "k-item-1"');
  });

  it('lists the coverage gaps for the agents to resolve', () => {
    const b = detailed(2, 2);
    const pack = refinePack({ ...base, role: 'sm', derived: { project: {}, spec: null }, backlog: { ...b, preplans: { 'item-0': b.preplans!['item-0']! } }, projectBriefing: true, cycle: 3 } as never);
    expect(pack.feedback).toContain('### Coverage gaps');
    expect(pack.feedback).toContain('item item-1: sem pré-plano válido');
  });

  it('asks a blocking question for a gap whose spec failed to generate', () => {
    const b = detailed(2, 2);
    const failed = { ...b.specs!['item-1']!, spec: null, rev: null, issues: ['falta a regra do prazo'] };
    const pack = refinePack({ ...base, role: 'po', derived: { project: {}, spec: null }, backlog: { ...b, specs: { ...b.specs, 'item-1': failed } }, projectBriefing: true, cycle: 3 } as never);
    expect(pack.feedback).toContain('problema: falta a regra do prazo');
    expect(pack.feedback).toContain('blocking question for the human');
    expect(pack.feedback).toContain('ask it.');
  });
});

describe('refinePack digest provenance', () => {
  it('marks a cited section the docs no longer have', () => {
    const H = `sha256:${'1'.repeat(64)}`;
    const item = { key: 'fat', title: 'Faturamento', epic: 'core', scope: 's', priority: 'P2', rationale: 'r', dependsOn: [], sources: [{ doc: 'flow.md', heading: '9. Faturamento' }], size: 'M', rank: 1 };
    const spec = { ...makeSpec({ specId: 'k-fat' }), derivedFrom: { backlogKey: 'fat', inputHash: H, docsHash: H, sources: [{ doc: 'flow.md', heading: '9. Faturamento', hash: null }] } };
    const backlog = { enabled: true, project: null, epics: [{ key: 'core', title: 'Núcleo' }], items: [item], cycle: 1, detail: true, flowHeadings: [], specs: { fat: { inputHash: H, specId: 'k-fat', rev: H, spec, issues: [], cycle: 2 } }, preplans: {} };
    const pack = refinePack({ ...base, role: 'po', derived: { project: {}, spec: null }, backlog, projectBriefing: true, cycle: 3 } as never);
    expect(pack.feedback).toContain('seção não encontrada: flow.md › 9. Faturamento');
  });

  it('from the second cycle on, every reviewer is told to converge: only defects, never polish', () => {
    expect(refinePack({ ...base, role: 'front', cycle: 1 }).feedback).not.toContain('CONVERGENCE');
    for (const role of ['front', 'po', 'sm'] as const) expect(refinePack({ ...base, role, cycle: 2 }).feedback).toContain('CONVERGENCE');
  });
});
