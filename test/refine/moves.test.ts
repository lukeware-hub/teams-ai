import { describe, expect, it } from 'vitest';
import { sha256 } from '../../server/contracts/hash.js';
import { decisionsSpan } from '../../server/refine/decisions.js';
import { cutLines, insertBlock, MAX_MOVE_QUOTE, planMove, restoreMove, type MoveContext, type MoveInput } from '../../server/refine/moves.js';

const briefing = '# Briefing\n\n## Objetivos\n\n- Agendar consultas.\n\n## Decisões\n\n### Prazo\n\n> 15 dias.\n';
const flow = '# Fluxo\n\n## Pedido\n\nO paciente envia o pedido.\n';
const design = '# Design\n\n## Assinatura\n\nValide o certificado antes do código.\n\n## Cores\n\n- fundo: branco\n';
const docs = { 'brief.md': briefing, 'flow.md': flow, 'design.md': design, 'project.md': '# Projeto\n', 'stack.md': '# Stack\n\n- Node 22\n' };

const context = (over: Partial<MoveContext> = {}): MoveContext => ({ specId: 'hello-001', projectBriefing: false, docs, blank: new Set(), applied: [], undone: [], ...over });
const move = (over: Partial<MoveInput> = {}): MoveInput => ({
  from: 'docs/design.md',
  to: 'docs/flow.md',
  quote: 'Valide o certificado antes do código.',
  text: 'O certificado é validado antes do código.',
  after: '## Pedido',
  reason: 'ordem de passos',
  ...over,
});

describe('cutLines', () => {
  it('cuts a whole line with its line break', () => {
    expect(cutLines('A\nQ\nB', 'Q')).toEqual({ next: 'A\nB', removedAt: 2, removed: 'Q\n' });
  });

  it('takes the break before the last line, and one blank line between two blank lines', () => {
    expect(cutLines('A\nQ', 'Q')).toEqual({ next: 'A', removedAt: 1, removed: '\nQ' });
    expect(cutLines('A\n\nQ\n\nB', 'Q')).toEqual({ next: 'A\n\nB', removedAt: 3, removed: 'Q\n\n' });
  });

  it('refuses a quote that is part of a line, a quote found twice, and a quote not found', () => {
    expect(cutLines('Alpha beta', 'beta')).toBeNull();
    expect(cutLines('Q\nx\nQ', 'Q')).toBeNull();
    expect(cutLines('A\nB', 'Z')).toBeNull();
  });
});

describe('insertBlock', () => {
  it('appends after one blank line when the text does not end with one', () => {
    expect(insertBlock('# A\n\nx\n', 'Novo')).toEqual({ next: '# A\n\nx\n\nNovo\n', insertAt: 7, inserted: '\nNovo\n' });
  });

  it('places the block below the anchor line, keeping the blank line that follows', () => {
    expect(insertBlock('## A\n\nx\n', 'Novo', '## A')).toEqual({ next: '## A\n\nNovo\n\nx\n', insertAt: 4, inserted: '\n\nNovo' });
  });

  it('adds a blank line when the anchor is directly followed by text', () => {
    expect(insertBlock('## A\nx\n', 'Novo', '## A')?.next).toBe('## A\n\nNovo\n\nx\n');
  });

  it('refuses an anchor that is not one whole line found once', () => {
    expect(insertBlock('## A\n\n## A\n', 'Novo', '## A')).toBeNull();
    expect(insertBlock('Texto ## A\n', 'Novo', '## A')).toBeNull();
  });

  it('adds nothing when the block is already a whole run of lines, but adds a block that only shares a prefix', () => {
    expect(insertBlock('x\n\nNovo\n', 'Novo')).toEqual({ next: 'x\n\nNovo\n', insertAt: 0, inserted: '' });
    expect(insertBlock('Novo texto\n', 'Novo')?.inserted).toBe('\nNovo\n');
  });
});

describe('decisionsSpan', () => {
  it('spans the decisions section from its heading to the end of the document', () => {
    const span = decisionsSpan(briefing);
    expect(span).not.toBeNull();
    expect(briefing.slice(span!.start, span!.end)).toBe('## Decisões\n\n### Prazo\n\n> 15 dias.\n');
  });

  it('is null without the section, and reads the English heading too', () => {
    expect(decisionsSpan('# A\n\n## B\n')).toBeNull();
    expect(decisionsSpan('## Decisions\n\n- a\n')).not.toBeNull();
  });
});

describe('planMove', () => {
  it('plans the cut and the insertion without writing anything', () => {
    const plan = planMove(move(), context());
    expect(plan).toMatchObject({ ok: true, from: 'design.md', to: 'flow.md' });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.cut.next).toBe('# Design\n\n## Assinatura\n\n## Cores\n\n- fundo: branco\n');
    expect(plan.put.next).toBe('# Fluxo\n\n## Pedido\n\nO certificado é validado antes do código.\n\nO paciente envia o pedido.\n');
  });

  it('refuses a move between the same document, an unknown path and a document not loaded', () => {
    expect(planMove(move({ to: 'docs/design.md' }), context())).toEqual({ ok: false, reason: 'a move needs two different documents' });
    expect(planMove(move({ from: 'docs/outro.md' }), context())).toEqual({ ok: false, reason: 'unknown file docs/outro.md' });
    expect(planMove(move(), context({ docs: { 'design.md': design } }))).toEqual({ ok: false, reason: 'document not loaded' });
  });

  it('refuses to touch a blank template, the decisions section, and a heading that would open one', () => {
    expect(planMove(move(), context({ blank: new Set(['flow.md']) }))).toEqual({ ok: false, reason: 'a blank template takes no moves; the SM fills it first' });
    expect(planMove(move({ from: 'docs/specs/hello-001/brief.md', to: 'docs/project.md', quote: '> 15 dias.', text: 'Prazo: 15 dias.' }), context())).toEqual({ ok: false, reason: 'quote is inside the decisions section' });
    expect(planMove(move({ to: 'docs/specs/hello-001/brief.md', after: '### Prazo' }), context())).toEqual({ ok: false, reason: 'text would go into the decisions section' });
    expect(planMove(move({ text: '## Decisões\n\n- nova' }), context())).toEqual({ ok: false, reason: 'text would open a decisions section' });
  });

  it('refuses a move the owner undid, and content an earlier move already moved', () => {
    expect(planMove(move(), context({ undone: [{ from: 'design.md', to: 'flow.md', quote: 'Valide o certificado antes do código.' }] }))).toEqual({ ok: false, reason: 'the owner already undid this move' });
    expect(planMove(move(), context({ applied: [{ text: 'Valide o certificado antes do código.' }] }))).toEqual({ ok: false, reason: 'this content was already moved' });
  });

  it('refuses a quote that is not whole lines, a move that would empty a document, an unknown anchor, and a quote over the limit', () => {
    expect(planMove(move({ quote: 'certificado antes' }), context())).toEqual({ ok: false, reason: 'quote must be whole lines found once in design.md' });
    expect(planMove(move(), context({ docs: { ...docs, 'design.md': 'Valide o certificado antes do código.' } }))).toEqual({ ok: false, reason: 'the move would empty design.md' });
    expect(planMove(move({ after: '## Inexistente' }), context())).toEqual({ ok: false, reason: 'after must be one whole line found once in flow.md' });
    expect(planMove(move({ quote: 'x'.repeat(MAX_MOVE_QUOTE + 1) }), context())).toEqual({ ok: false, reason: `quote longer than ${MAX_MOVE_QUOTE} characters` });
  });
});

describe('restoreMove', () => {
  it('puts both documents back exactly as they were before the move', () => {
    const plan = planMove(move(), context());
    if (!plan.ok) throw new Error(plan.reason);
    const row = { removedAt: plan.cut.removedAt, removed: plan.cut.removed, insertAt: plan.put.insertAt, inserted: plan.put.inserted, fromHash: sha256(plan.cut.next), toHash: sha256(plan.put.next) };
    expect(restoreMove(row, plan.cut.next, plan.put.next)).toEqual({ from: design, to: flow });
  });

  it('refuses when either document changed after the move', () => {
    const plan = planMove(move(), context());
    if (!plan.ok) throw new Error(plan.reason);
    const row = { removedAt: plan.cut.removedAt, removed: plan.cut.removed, insertAt: plan.put.insertAt, inserted: plan.put.inserted, fromHash: sha256(plan.cut.next), toHash: sha256(plan.put.next) };
    expect(restoreMove(row, `${plan.cut.next}\n`, plan.put.next)).toBeNull();
    expect(restoreMove(row, plan.cut.next, `${plan.put.next}x`)).toBeNull();
  });
});
