import { describe, expect, it } from 'vitest';
import { sha256 } from '../../server/contracts/hash.js';
import { decisionsSpan } from '../../server/refine/decisions.js';
import { cutLines, insertBlock, MAX_MOVE_QUOTE, planMove, restoreMove, type MoveContext, type MoveInput } from '../../server/refine/moves.js';

const briefing = '# Briefing\n\n## Objetivos\n\n- Agendar consultas.\n\n## Decisões\n\n### Prazo\n\n> 15 dias.\n';
const flow = '# Fluxo\n\n## Pedido\n\nO paciente envia o pedido.\n';
const design = '# Design\n\n## Assinatura\n\nValide o certificado antes do código.\n\n## Cores\n\n- fundo: branco\n';
const docs = { 'briefing.md': briefing, 'flow.md': flow, 'design.md': design, 'project.md': '# Projeto\n', 'stack.md': '# Stack\n\n- Node 22\n' };

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

  it('keeps the blank line before a heading when the list item above it goes', () => {
    expect(cutLines('## S\n\n- P\n- Q\n\n## T\n', '- Q')).toEqual({ next: '## S\n\n- P\n\n## T\n', removedAt: 10, removed: '- Q\n' });
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

  it('keeps a list item among its neighbours, with no blank line between them', () => {
    expect(insertBlock('## F\n\n- A\n- B\n\n## G\n', '- Novo', '- A')).toEqual({ next: '## F\n\n- A\n- Novo\n- B\n\n## G\n', insertAt: 9, inserted: '\n- Novo' });
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
    expect(planMove(move({ to: 'docs/design.md' }), context())).toEqual({ ok: false, reason: 'o movimento precisa de dois documentos diferentes' });
    expect(planMove(move({ from: 'docs/outro.md' }), context())).toEqual({ ok: false, reason: 'arquivo desconhecido docs/outro.md' });
    expect(planMove(move(), context({ docs: { 'design.md': design } }))).toEqual({ ok: false, reason: 'documento não carregado' });
  });

  it('refuses to touch a blank template, the decisions section, and a heading that would open one', () => {
    expect(planMove(move(), context({ blank: new Set(['flow.md']) }))).toEqual({ ok: false, reason: 'modelo em branco não recebe movimentos; o SM preenche antes' });
    expect(planMove(move({ from: 'docs/specs/hello-001/briefing.md', to: 'docs/project.md', quote: '> 15 dias.', text: 'Prazo: 15 dias.' }), context())).toEqual({ ok: false, reason: 'o trecho está na seção de decisões' });
    expect(planMove(move({ to: 'docs/specs/hello-001/briefing.md', after: '### Prazo' }), context())).toEqual({ ok: false, reason: 'o texto iria para a seção de decisões' });
    expect(planMove(move({ text: '## Decisões\n\n- nova' }), context())).toEqual({ ok: false, reason: 'o texto abriria uma seção de decisões' });
  });

  it('refuses a move the owner undid, and content an earlier move already moved', () => {
    expect(planMove(move(), context({ undone: [{ from: 'design.md', to: 'flow.md', quote: 'Valide o certificado antes do código.' }] }))).toEqual({ ok: false, reason: 'o dono já desfez este movimento' });
    expect(planMove(move(), context({ applied: [{ text: 'Valide o certificado antes do código.' }] }))).toEqual({ ok: false, reason: 'este conteúdo já foi movido' });
  });

  it('refuses a quote that is not whole lines, a move that would empty a document, an unknown anchor, and a quote over the limit', () => {
    expect(planMove(move({ quote: 'certificado antes' }), context())).toEqual({ ok: false, reason: 'o trecho deve ser linhas inteiras encontradas uma vez em design.md' });
    expect(planMove(move(), context({ docs: { ...docs, 'design.md': 'Valide o certificado antes do código.' } }))).toEqual({ ok: false, reason: 'o movimento esvaziaria design.md' });
    expect(planMove(move({ after: '## Inexistente' }), context())).toEqual({ ok: false, reason: 'a âncora deve ser uma linha inteira encontrada uma vez em flow.md' });
    expect(planMove(move({ quote: 'x'.repeat(MAX_MOVE_QUOTE + 1) }), context())).toEqual({ ok: false, reason: `trecho com mais de ${MAX_MOVE_QUOTE} caracteres` });
  });

  it('refuses text that drops a number or a backticked name of the quote, and keeps both when only the sentence changes', () => {
    const withFacts = { ...docs, 'design.md': '# Design\n\n## Assinatura\n\nValide o certificado em 15 dias com `TOTP`.\n\n## Cores\n\n- fundo: branco\n' };
    const quote = 'Valide o certificado em 15 dias com `TOTP`.';
    expect(planMove(move({ quote, text: 'O certificado é validado com código.' }), context({ docs: withFacts }))).toEqual({ ok: false, reason: 'o texto perde "15" do trecho' });
    expect(planMove(move({ quote, text: 'O certificado vale por 15 dias.' }), context({ docs: withFacts }))).toEqual({ ok: false, reason: 'o texto perde "TOTP" do trecho' });
    expect(planMove(move({ quote, text: 'O certificado é validado em 15 dias com `TOTP`.' }), context({ docs: withFacts }))).toMatchObject({ ok: true });
  });

  it('reads a numbered list item without its marker, so the marker is no fact to keep', () => {
    const list = { ...docs, 'design.md': '# Design\n\n## Assinatura\n\n1. Valide o certificado.\n\n## Cores\n\n- fundo: branco\n' };
    expect(planMove(move({ quote: '1. Valide o certificado.', text: 'Valide o certificado.' }), context({ docs: list }))).toMatchObject({ ok: true });
  });

  it('refuses text that would land inside a code block, and a quote taken from inside one', () => {
    const diagram = '# Fluxo\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nDepois.\n';
    const flowContext = context({ docs: { ...docs, 'flow.md': diagram } });
    expect(planMove(move({ after: '  A --> B', text: 'Prosa solta.' }), flowContext)).toEqual({ ok: false, reason: 'o texto iria para um bloco de código' });
    expect(planMove(move({ from: 'docs/flow.md', to: 'docs/design.md', quote: '  A --> B', text: 'A --> B.' }), flowContext)).toEqual({ ok: false, reason: 'o trecho está em bloco de código' });
  });

  it('places text after a code block, outside it', () => {
    const diagram = '# Fluxo\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\nDepois.\n';
    expect(planMove(move({ after: 'Depois.', text: 'Mais uma frase.' }), context({ docs: { ...docs, 'flow.md': diagram } }))).toMatchObject({ ok: true });
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
