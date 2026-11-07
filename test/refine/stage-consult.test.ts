import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DocFile } from '../../server/refine/draft.js';
import { builtGraphNotes, CONSULT_GRAPH_TOKENS, consultDocs, fileGraphDir, questionOf } from '../../server/refine/stage-consult.js';

const docs = (over: Partial<Record<DocFile, string>> = {}): Record<DocFile, string> => ({
  'flow.md': '# Fluxo\n\n## Pagamento\n\nO cliente paga com cartão de crédito.\n',
  'project.md': '# Projeto\n\n## Entrega\n\nO prazo de entrega é de dez dias.\n',
  'briefing.md': '# Briefing\n',
  'stack.md': '# Stack\n\n## Banco\n\nPostgres guarda os pedidos.\n',
  'design.md': '# Design\n',
  ...over,
});

const ALL_OTHERS: DocFile[] = ['flow.md', 'project.md', 'stack.md', 'design.md'];

describe('the question a part asks of the other documents', () => {
  it('takes its recurring words of four letters or more, most frequent first', () => {
    expect(questionOf('Pagamento pagamento pagamento cartão de crédito. Usuário usuário. Ola.')).toBe('pagamento usuário cartão crédito');
  });

  it('keeps only the count asked for', () => {
    expect(questionOf('alfa beta gama delta épsilon', 2).split(' ')).toHaveLength(2);
  });
});

describe('consulting the other documents for one part', () => {
  it('reads nothing when there is no other document to consult', async () => {
    expect(await consultDocs({ docs: docs(), consulted: [], part: 'pagamento', graphDirOf: () => '' })).toBe('');
  });

  it('gives the excerpts that match the part, with their document and heading, and no unmatched text', async () => {
    const text = await consultDocs({ docs: docs(), consulted: ALL_OTHERS, part: '## Pagamento\n\nO cliente paga no cartão.', graphDirOf: () => '' });
    expect(text).toContain('flow.md › Pagamento');
    expect(text).toContain('O cliente paga com cartão de crédito.');
    expect(text).not.toContain('Postgres guarda os pedidos.');
  });

  it('consults a document after the stage the same way as one before it', async () => {
    const text = await consultDocs({ docs: docs(), consulted: ['stack.md'], part: 'Postgres pedidos', graphDirOf: () => '' });
    expect(text).toContain('Postgres guarda os pedidos.');
  });

  it('asks the graph of each consulted document in its own folder, and keeps only the notes that exist', async () => {
    const graphNotes = vi.fn(async (dir: string) => (dir.endsWith('stack.md') ? '' : `notas de ${path.posix.basename(dir)}`));
    const text = await consultDocs({ docs: docs(), consulted: ['flow.md', 'stack.md'], part: 'Pagamento cartão', graphDirOf: (doc) => fileGraphDir('/root', doc), graphNotes });
    const question = questionOf('Pagamento cartão');
    expect(graphNotes).toHaveBeenCalledWith(fileGraphDir('/root', 'flow.md'), question, CONSULT_GRAPH_TOKENS);
    expect(graphNotes).toHaveBeenCalledWith(fileGraphDir('/root', 'stack.md'), question, CONSULT_GRAPH_TOKENS);
    expect(text).toContain('##### flow.md\nnotas de flow.md');
    expect(text).not.toContain('##### stack.md');
  });

  it('says so when nothing in the other documents matches the part', async () => {
    expect(await consultDocs({ docs: docs(), consulted: ['design.md'], part: 'zebra', graphDirOf: () => '' })).toBe('Nothing in these documents matches this part.');
  });

  it('cuts a long matching excerpt, so one document cannot fill the review', async () => {
    const long = `# Fluxo\n\n## Pagamento\n\n${'cartão '.repeat(2000)}FIM\n`;
    const text = await consultDocs({ docs: docs({ 'flow.md': long }), consulted: ['flow.md'], part: 'cartão', graphDirOf: () => '' });
    expect(text).toContain('[…]');
    expect(text).not.toContain('FIM');
    expect(text.length).toBeLessThan(2_500);
  });
});

describe('the graph notes of a document that was never graphed', () => {
  it('asks the graph only when its graph was built', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'consulta-grafo-'));
    const graph = vi.fn(async () => 'nós do grafo');
    const notes = builtGraphNotes(graph);
    expect(await notes(path.join(root, 'sem-grafo'), 'pagamento', 10)).toBe('');
    await mkdir(path.join(root, 'com-grafo', 'graphify-out'), { recursive: true });
    await writeFile(path.join(root, 'com-grafo', 'graphify-out', 'graph.json'), '{}');
    expect(await notes(path.join(root, 'com-grafo'), 'pagamento', 10)).toBe('nós do grafo');
    expect(graph).toHaveBeenCalledTimes(1);
  });
});
