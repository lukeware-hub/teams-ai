import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUIDE_GRAPH, GUIDE_HASH, guideHash, relatedMessages, stageChatFiles, stageFailureDetails, stageProjectGraph } from '../../server/chat/guide.js';

const GUIDE = path.resolve('docs/guia');
const hasGraphify = spawnSync('graphify', ['--version']).status === 0;

describe('the user guide the chat searches', () => {
  it('has a graph built from its current text (run `task guia:grafo` after editing docs/guia)', async () => {
    const recorded = (await fs.readFile(path.join(GUIDE, GUIDE_HASH), 'utf8')).trim();
    expect(await guideHash(GUIDE), 'docs/guia changed after its graph was built: run `task guia:grafo`').toBe(recorded);
    const graph = JSON.parse(await fs.readFile(path.join(GUIDE, GUIDE_GRAPH), 'utf8')) as { nodes: Array<{ source_file?: string }> };
    const sources = new Set(graph.nodes.map((n) => n.source_file));
    for (const name of await fs.readdir(GUIDE)) if (name.endsWith('.md')) expect(sources, `${name} has no node in the graph`).toContain(name);
  });

  it('writes plain Portuguese: every file says which questions it answers and none carries a spec or criterion code', async () => {
    for (const name of (await fs.readdir(GUIDE)).filter((n) => n.endsWith('.md'))) {
      const text = await fs.readFile(path.join(GUIDE, name), 'utf8');
      expect(text, name).toContain('Perguntas que este texto responde:');
      expect(text, name).not.toMatch(/\bAC-\d|\bT\d+-[a-z]/);
    }
  });

  it('stages the guide and its graph for one question and leaves the graph out when the guide has none', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'guide-stage-'));
    await stageChatFiles(cwd, GUIDE);
    expect((await fs.readdir(path.join(cwd, 'guia'))).sort()).toEqual((await fs.readdir(GUIDE)).filter((n) => n.endsWith('.md')).sort());
    await expect(fs.access(path.join(cwd, GUIDE_GRAPH))).resolves.toBeUndefined();
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'guide-bare-'));
    await fs.writeFile(path.join(bare, 'a.md'), '# a');
    const cwd2 = await fs.mkdtemp(path.join(os.tmpdir(), 'guide-stage-'));
    await stageChatFiles(cwd2, bare);
    await expect(fs.access(path.join(cwd2, GUIDE_GRAPH))).rejects.toThrow();
  });

  it('finds the older messages that share at least two words with the question, best first, ignoring accents and case', () => {
    const at = '2026-10-14T10:00:00.000Z';
    const m = (text: string) => ({ role: 'user' as const, text, at });
    const history = [m('Comunicação assíncrona entre microsserviços e eventos'), m('Só um assunto: comunicação'), m('Nada a ver com isso'), m('comunicacao assincrona')];
    expect(relatedMessages(history, 'Como é a COMUNICAÇÃO assíncrona dos microsserviços?').map((x) => x.text)).toEqual(['Comunicação assíncrona entre microsserviços e eventos', 'comunicacao assincrona']);
    expect(relatedMessages(history, 'oi')).toEqual([]);
    expect(relatedMessages([], 'comunicação assíncrona')).toEqual([]);
  });

  // Runs only where graphify is installed (the platform image has it).
  it.skipIf(!hasGraphify)('finds the right guide file among the first matches of a plain Portuguese question', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'guide-query-'));
    await stageChatFiles(cwd, GUIDE);
    const cases: Array<[string, string]> = [
      ['como criar uma nova spec', 'criar-spec.md'],
      ['onde fica o botão Nova spec', 'criar-spec.md'],
      ['o que significa pausada por cota', 'execucao.md'],
      ['como validar a entrega', 'validacao.md'],
      ['o que faz o orquestrador', 'estados-e-papeis.md'],
      ['o login do Claude expirou', 'execucao.md'],
      ['como criar um projeto novo', 'criar-projeto.md'],
      ['o que é o Jev', 'refinamento.md'],
      ['o chat pode dar ordens', 'chat.md'],
      ['o que é uma tarefa bloqueada', 'execucao.md'],
    ];
    for (const [question, file] of cases) {
      const out = spawnSync('graphify', ['query', question, '--budget', '1200'], { cwd, encoding: 'utf8' }).stdout;
      const top = out.split('\n').filter((l) => l.startsWith('NODE ')).slice(0, 5).join('\n');
      expect(top, question).toContain(`src=${file}`);
    }
  });
});

describe('the project code graph the chat queries', () => {
  it('copies the project graph into the working directory when the import built it', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-cwd-'));
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'project-graph-'));
    await fs.writeFile(path.join(src, 'graph.json'), '{"nodes":[]}');
    await stageProjectGraph(cwd, path.join(src, 'graph.json'));
    expect(await fs.readFile(path.join(cwd, 'project-graph', 'graph.json'), 'utf8')).toBe('{"nodes":[]}');
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(src, { recursive: true, force: true });
  });

  it('stages nothing and does not fail when the import has not built the graph yet', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-cwd-'));
    await stageProjectGraph(cwd, path.join(cwd, 'missing', 'graph.json'));
    await expect(fs.access(path.join(cwd, 'project-graph', 'graph.json'))).rejects.toThrow();
    await fs.rm(cwd, { recursive: true, force: true });
  });
});

describe('the failure record the chat searches', () => {
  it('stages one Markdown file per spec in falhas/, and nothing when there is no record', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-falhas-'));
    try {
      await stageFailureDetails(cwd, new Map([['hello-001', '# Falhas registradas']]));
      expect(await fs.readFile(path.join(cwd, 'falhas', 'hello-001.md'), 'utf8')).toBe('# Falhas registradas');
      const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-falhas-empty-'));
      await stageFailureDetails(empty, new Map());
      await expect(fs.access(path.join(empty, 'falhas'))).rejects.toThrow();
      await fs.rm(empty, { recursive: true, force: true });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
