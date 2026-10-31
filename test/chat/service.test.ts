import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { CHAT_ALLOW, CHAT_MODEL, ChatService, ChatUnavailableError } from '../../server/chat/service.js';
import { ChatStore, type ChatMessage } from '../../server/chat/store.js';
import { ConflictError, NotFoundError } from '../../server/refine/session.js';
import { makePlanTask } from '../fixtures/contracts.js';
import { writeRun } from '../fixtures/runs/write-run.js';

const HELLO = path.resolve('test/fixtures/hello-app');
let home = '';

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-chatsvc-'));
  await fs.mkdir(path.join(home, 'ws', 'imports'), { recursive: true });
  await fs.writeFile(path.join(home, 'config.json'), '{}');
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const ok = (value: unknown) => ({ ok: true, value: { specHash: 'x', ...(value as object) }, summary: {} });

interface Req { model?: string; kind: string; role: string; cwd: string; pack: { feedback?: string }; extraAllow?: string[]; denyRead?: string[]; systemExtra?: string }

function make(runAgent: (req: Req) => Promise<unknown>, extra: { newSpec?: () => Promise<unknown>; log?: (line: string) => void; refreshProjectGraph?: (projectId: string) => Promise<void>; confidential?: (projectId: string) => Promise<boolean> } = {}) {
  const newSpec = vi.fn(extra.newSpec ?? (async () => undefined));
  const suggestSpecId = vi.fn(async () => 'fix-greeting');
  const service = new ChatService({
    guideDir: path.resolve('docs/guia'),
    store: new ChatStore(path.join(home, 'chats')),
    index: async () => ({ cfg: loadConfig({ paths: { runs: path.posix.join(home, 'runs').replace(/\\/g, '/') }, projects: [{ dir: HELLO }] }), home, isAlive: () => false }),
    runAgent: runAgent as never,
    workspacesRoot: async () => path.join(home, 'ws'),
    suggestSpecId,
    newSpec,
    now: () => new Date('2026-10-14T10:00:00.000Z'),
    log: extra.log,
    refreshProjectGraph: extra.refreshProjectGraph,
    confidential: extra.confidential,
  });
  return { service, newSpec, suggestSpecId };
}

describe('ChatService.ask', () => {
  it('runs one read-only chat step, strips codes from the answer and saves both messages', async () => {
    const runAgent = vi.fn(async (_req: Req) => ok({ answer: 'Está sendo feito o cumprimento (AC-001).', correction: null }));
    const { service, newSpec } = make(runAgent);
    const reply = await service.ask('hello-app', ' o que está sendo feito? ');
    expect(reply).toEqual({ role: 'assistant', text: 'Está sendo feito o cumprimento.', at: '2026-10-14T10:00:00.000Z' });
    expect(runAgent.mock.calls[0]![0]).toMatchObject({ kind: 'chat', role: 'po', model: 'haiku' });
    expect(CHAT_MODEL).toBe('haiku');
    expect(runAgent.mock.calls[0]![0].pack.feedback).toContain('o que está sendo feito?');
    expect((await service.messages('hello-app')).map((m) => [m.role, m.text])).toEqual([['user', 'o que está sendo feito?'], ['assistant', 'Está sendo feito o cumprimento.']]);
    expect(newSpec).not.toHaveBeenCalled();
    await expect(fs.readdir(path.join(home, 'ws', '_chat'))).resolves.toEqual([]);
  });

  it('stages the guide and its graph in the working directory and fences the step', async () => {
    let staged: Record<string, string> = {};
    await fs.mkdir(path.join(home, 'ws', '_chat', 'stale-chat'), { recursive: true });
    const runAgent = vi.fn(async (req: Req) => {
      const read = (rel: string) => fs.readFile(path.join(req.cwd, rel), 'utf8').catch(() => 'MISSING');
      staged = { guide: await read('guia/criar-spec.md'), graph: (await read('graphify-out/graph.json')).slice(0, 1) };
      return ok({ answer: 'ok', correction: null });
    });
    const { service } = make(runAgent);
    await service.ask('hello-app', 'primeira pergunta');
    await service.ask('hello-app', 'e a segunda?');
    expect(staged.guide).toContain('Como criar uma nova spec');
    expect(staged.graph).toBe('{');
    const call = runAgent.mock.calls[1]![0];
    expect(call.extraAllow).toEqual([...CHAT_ALLOW]);
    expect(CHAT_ALLOW).toEqual(['Bash(graphify query:*)', 'Bash(graphify explain:*)', 'Bash(graphify path:*)']);
    const ws = path.join(home, 'ws');
    // the whole workspace of each project (drafts, services, environment, code), the folders next to it, and nothing of the chat's own directory
    expect(call.denyRead).toEqual(expect.arrayContaining([path.join(ws, '*', 'repo'), path.join(ws, '*', 'refine'), path.join(ws, '*', 'services'), path.join(ws, 'imports'), path.posix.join(home, 'runs').replace(/\\/g, '/'), path.join(home, 'chats'), path.join(home, 'config.json')]));
    expect(call.denyRead).not.toContain(ws);
    expect(call.denyRead).toContain(path.join(ws, '_naming'));
    // an earlier chat's directory is fenced off; this question's own directory is not
    expect(call.denyRead!.filter((d) => d.includes('_chat'))).toEqual([path.join(ws, '_chat', 'stale-chat')]);
  });

  it('keeps what each answer cost on the answer, and logs it, also when the agent skipped the JSON', async () => {
    const summary = { usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 5000, cacheWriteTokens: 800 }, costUsd: 0.0421, durationMs: 14_400, numTurns: 3 };
    const lines: string[] = [];
    const { service } = make(async (_req: Req) => ({ ok: true, value: { specHash: 'x', answer: 'ok', correction: null }, summary }), { log: (l) => lines.push(l) });
    const reply = await service.ask('hello-app', 'pergunta');
    expect(reply.usage).toEqual({ inputTokens: 1200, outputTokens: 340, cacheReadTokens: 5000, cacheWriteTokens: 800, costUsd: 0.0421, seconds: 14, turns: 3 });
    expect((await service.messages('hello-app'))[1]!.usage).toEqual(reply.usage);
    expect(lines).toEqual(['chat hello-app: 7000 tokens read, 340 written, 3 turns, 14s, US$ 0.0421']);
    const prose = make(async (_req: Req) => ({ ok: false, failure: 'schema', errors: ['no JSON'], summary: { ...summary, costUsd: null, resultText: 'Texto livre.' }, sandboxDisabled: false }));
    expect((await prose.service.ask('hello-app', 'outra')).usage).toMatchObject({ costUsd: null, turns: 3 });
  });

  it('brings the older messages that match the question into the prompt, with no search step, and keeps the prompt prefix the same for every question', async () => {
    const store = new ChatStore(path.join(home, 'chats'));
    const old = Array.from({ length: 10 }, (_, i): ChatMessage => ({ role: i % 2 ? 'assistant' : 'user', text: i === 0 ? 'Como funciona a comunicação assíncrona entre os microsserviços?' : `Mensagem ${i} sobre outro assunto`, at: '2026-10-14T10:00:00.000Z' }));
    await store.append('hello-app', ...old);
    const runAgent = vi.fn(async (_req: Req) => ok({ answer: 'ok', correction: null }));
    const { service } = make(runAgent);
    await service.ask('hello-app', 'E a comunicação assíncrona dos microsserviços, como era?');
    await service.ask('hello-app', 'outra pergunta qualquer');
    const [first, second] = runAgent.mock.calls.map((c) => c[0].pack.feedback!);
    expect(first).toContain('### Older conversation excerpts\nPerson: Como funciona a comunicação assíncrona');
    expect(second).not.toContain('Older conversation excerpts');
    // the rules and the project context go in the agent's prompt (cached by the API) and are the same for both questions; the question prompt carries only what changes
    const [sys1, sys2] = runAgent.mock.calls.map((c) => c[0].systemExtra!);
    expect(sys1).toContain('### Project context');
    expect(sys1).toContain('Greet a caller by name over HTTP');
    expect(sys1).toBe(sys2);
    expect(first).not.toContain('Greet a caller by name');
    // the contract (with the hash) opens the prompt and is the same for both questions, so the cache serves everything above the question
    expect(JSON.stringify(runAgent.mock.calls[0]![0])).toContain('"kind":"chat"');
  });

  it('opens a correction spec draft when the answer proposes one, and never lists it again as new', async () => {
    const runAgent = vi.fn(async (_req: Req) => ok({ answer: 'Isso não deveria estar sendo feito.', correction: { title: 'Login indevido', whatHappens: 'Cria login', whatShouldHappen: 'Sem login' } }));
    const { service, newSpec, suggestSpecId } = make(runAgent);
    const reply = await service.ask('hello-app', 'tem algo fora do escopo?');
    expect(reply.correction).toEqual({ title: 'Login indevido', specId: 'fix-greeting' });
    expect(suggestSpecId).toHaveBeenCalledWith('hello-app', expect.stringContaining('Tipo: correção (bug)'));
    expect(newSpec).toHaveBeenCalledWith('hello-app', 'fix-greeting', expect.stringContaining('Sem login'));
    await service.ask('hello-app', 'e agora?');
    expect(runAgent.mock.calls[1]![0].pack.feedback).toContain('- Login indevido');
  });

  it('keeps the answer and records the reason when the correction cannot be opened', async () => {
    const runAgent = async () => ok({ answer: 'Algo está fora.', correction: { title: 'Fora', whatHappens: 'a', whatShouldHappen: 'b' } });
    const { service } = make(runAgent, { newSpec: async () => { throw new ConflictError('spec fix-greeting already exists on main'); } });
    const reply = await service.ask('hello-app', 'pergunta');
    expect(reply.text).toBe('Algo está fora.');
    expect(reply.correction).toEqual({ title: 'Fora', error: 'não consegui criar o rascunho agora. Crie a spec de correção à mão em Projetos.' });
    expect(await service.messages('hello-app')).toHaveLength(2);
  });

  it('says in plain Portuguese why the step failed, logs the detail and saves nothing', async () => {
    const lines: string[] = [];
    const fail = (failure: string, errors: string[], resultText: string | null = null) => async (_req: Req) => ({ ok: false, failure, errors, summary: { resultText }, sandboxDisabled: false });
    const { service } = make(fail('quota', ['5-hour window']), { log: (l) => lines.push(l) });
    await expect(service.ask('hello-app', 'oi')).rejects.toThrow(new ChatUnavailableError('O limite de uso do Claude acabou por agora. Tente de novo mais tarde, quando o limite renovar.'));
    expect(lines).toEqual(['chat hello-app: quota: 5-hour window']);
    expect(await service.messages('hello-app')).toEqual([]);
    const other = make(fail('code', ['boom'])).service;
    await expect(other.ask('hello-app', 'oi')).rejects.toThrow('Não consegui responder agora. Tente de novo em instantes.');
    await expect(other.ask('hello-app', 'oi')).rejects.not.toBeInstanceOf(ConflictError);
  });

  it('takes a plain-prose answer as the answer when the agent skips the JSON', async () => {
    const prose = async (_req: Req) => ({ ok: false, failure: 'schema', errors: ['no JSON'], summary: { resultText: ' Há dois tipos de conversa entre os serviços. ' }, sandboxDisabled: false });
    const { service, newSpec } = make(prose);
    const reply = await service.ask('hello-app', 'como os serviços conversam?');
    expect(reply).toMatchObject({ role: 'assistant', text: 'Há dois tipos de conversa entre os serviços.' });
    expect(reply.correction).toBeUndefined();
    expect(newSpec).not.toHaveBeenCalled();
    expect(await service.messages('hello-app')).toHaveLength(2);
  });

  it('does not show broken JSON as the answer', async () => {
    const broken = async (_req: Req) => ({ ok: false, failure: 'schema', errors: ['bad'], summary: { resultText: '{"answer": "oi", ' }, sandboxDisabled: false });
    const { service } = make(broken);
    await expect(service.ask('hello-app', 'oi')).rejects.toBeInstanceOf(ChatUnavailableError);
    expect(await service.messages('hello-app')).toEqual([]);
  });

  it('never waits for a paused quota: the person gets the plain message at once', async () => {
    const seen: Array<boolean | undefined> = [];
    const runAgent = async (_req: Req, ctx?: { noQuotaWait?: boolean }) => { seen.push(ctx?.noQuotaWait); return { ok: false, failure: 'quota', errors: ['the Claude quota is paused'], summary: {}, sandboxDisabled: false }; };
    const { service } = make(runAgent as never);
    await expect(service.ask('hello-app', 'oi')).rejects.toThrow('O limite de uso do Claude acabou por agora');
    expect(seen).toEqual([true]);
    await expect(service.ask('hello-app', 'oi')).rejects.not.toBeInstanceOf(ConflictError);
  });

  it('refuses a second question while one is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { service } = make(async () => { await gate; return ok({ answer: 'ok', correction: null }); });
    const first = service.ask('hello-app', 'primeira');
    await new Promise((r) => setTimeout(r, 20));
    await expect(service.ask('hello-app', 'segunda')).rejects.toBeInstanceOf(ConflictError);
    await expect(service.ask('another-project', 'terceira')).rejects.toBeInstanceOf(ConflictError);
    release();
    await first;
  });

  it('rejects a bad id, an empty or long question and an unknown project', async () => {
    const { service } = make(async () => ok({ answer: 'x', correction: null }));
    await expect(service.ask('Bad Id', 'oi')).rejects.toBeInstanceOf(RangeError);
    await expect(service.ask('hello-app', '   ')).rejects.toBeInstanceOf(RangeError);
    await expect(service.ask('hello-app', 'a'.repeat(2001))).rejects.toBeInstanceOf(RangeError);
    await expect(service.ask('nope', 'oi')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('clears the conversation', async () => {
    const { service } = make(async () => ok({ answer: 'ok', correction: null }));
    await service.ask('hello-app', 'oi');
    await service.clear('hello-app');
    expect(await service.messages('hello-app')).toEqual([]);
  });
});

describe('ChatService project graph', () => {
  const graphFile = () => path.join(home, 'ws', 'hello-app', 'graph', 'project', 'graphify-out', 'graph.json');
  const writeGraph = async (ageMs = 0) => {
    await fs.mkdir(path.dirname(graphFile()), { recursive: true });
    await fs.writeFile(graphFile(), '{"nodes":[]}');
    const at = new Date(Date.now() - ageMs);
    await fs.utimes(graphFile(), at, at);
  };
  const answer = ok({ answer: 'ok', correction: null });

  it('builds the graph before the first question and hands it to the step', async () => {
    let staged: string | null = null;
    const runAgent = vi.fn(async (req: Req) => {
      staged = await fs.readFile(path.join(req.cwd, 'project-graph', 'graph.json'), 'utf8').catch(() => null);
      return answer;
    });
    const refresh = vi.fn(async () => writeGraph());
    await make(runAgent, { refreshProjectGraph: refresh }).service.ask('hello-app', 'e o código?');
    expect(refresh).toHaveBeenCalledWith('hello-app');
    expect(staged).toBe('{"nodes":[]}');
  });

  it('does not build a graph that is fresh', async () => {
    await writeGraph();
    const refresh = vi.fn(async () => undefined);
    await make(vi.fn(async (_req: Req) => answer), { refreshProjectGraph: refresh }).service.ask('hello-app', 'e o código?');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('answers from an old graph while a new one builds, and starts one build at a time', async () => {
    await writeGraph(60 * 60_000);
    const refresh = vi.fn(() => new Promise<void>(() => undefined));
    const { service } = make(vi.fn(async (_req: Req) => answer), { refreshProjectGraph: refresh });
    await service.ask('hello-app', 'primeira?');
    await service.ask('hello-app', 'segunda?');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('logs a failed build and still answers', async () => {
    const log = vi.fn();
    const refresh = vi.fn(async () => { throw new Error('graphify missing'); });
    const reply = await make(vi.fn(async (_req: Req) => answer), { refreshProjectGraph: refresh, log }).service.ask('hello-app', 'e o código?');
    expect(reply.text).toBe('ok');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('project graph not built for hello-app: graphify missing'));
  });

  it('asks for web search only when the project allows it, and says where the answer found its sources', async () => {
    const runAgent = vi.fn(async (_req: Req) => ({ ok: true, value: { specHash: 'x', answer: 'Resposta (AC-001) com https://invented.example/x.', correction: { title: 'Corrigir', whatHappens: 'a', whatShouldHappen: 'b' } }, summary: { webSearchSources: [{ title: 'Guia', url: 'https://ok.example/guia' }], webSearchQueries: ['erro go'] } }));
    const { service } = make(runAgent, { confidential: async () => false });
    const reply = await service.ask('hello-app', 'o que significa este erro?');
    expect(runAgent.mock.calls[0]![0]).toMatchObject({ webSearch: true });
    expect(reply.text).toContain('Fontes da pesquisa:');
    expect(reply.text).toContain('[Guia](https://ok.example/guia)');
    expect(reply.text).not.toContain('invented.example');
    expect(reply.correction).toBeUndefined();
  });

  it('does not search the web when the project does not allow it', async () => {
    const runAgent = vi.fn(async (_req: Req) => ok({ answer: 'Resposta.', correction: null }));
    const { service } = make(runAgent, { confidential: async () => true });
    await service.ask('hello-app', 'o que está sendo feito?');
    expect(runAgent.mock.calls[0]![0]).toMatchObject({ webSearch: false });
  });

  it('logs each web query redacted, and says so when a query names the project', async () => {
    const log = vi.fn();
    const runAgent = vi.fn(async (_req: Req) => ({ ok: true, value: { specHash: 'x', answer: 'Resposta.', correction: null }, summary: { webSearchSources: [{ title: 'Guia', url: 'https://ok.example/guia' }], webSearchQueries: ['erro go.mod requires go', 'como o hello app responde'] } }));
    const { service } = make(runAgent, { confidential: async () => false, log });
    await service.ask('hello-app', 'o que significa este erro?');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('web search query: erro go.mod requires go'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('names the project'));
  });
});

describe('the failure record the chat gets', () => {
  it('stages each spec record for the chat, and gives the same context to two questions', async () => {
    await writeRun(path.join(home, 'runs'), 'hello-001-r1', [
      { type: 'RUN_STARTED', data: { runId: 'hello-001-r1', specId: 'hello-001', projectId: 'hello-app' } },
      { type: 'TASK_PLANNED', data: { task: makePlanTask({ id: 'T1-gate', title: 'Instalar' }) } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-gate', to: 'ready' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-gate', to: 'implementing' } },
      { type: 'TASK_STATE_CHANGED', data: { taskId: 'T1-gate', to: 'blocked' } },
      { type: 'TASK_BLOCKED', data: { taskId: 'T1-gate', reason: 'Gate install failed (code, exit 1)\n\nstderr (tail):\ngo: go.mod requires go >= 1.27.3' } },
      { type: 'RUN_FINISHED', data: { result: 'blocked', reason: null, merged: [], blocked: [] } },
    ]);
    const seen: Array<{ staged: boolean; system: string }> = [];
    const runAgent = vi.fn(async (req: Req) => {
      const staged = await fs.access(path.join(req.cwd, 'falhas', 'hello-001.md')).then(() => true, () => false);
      seen.push({ staged, system: req.systemExtra ?? '' });
      return ok({ answer: 'Resposta.', correction: null });
    });
    const { service } = make(runAgent);
    await service.ask('hello-app', 'primeira pergunta');
    await service.ask('hello-app', 'segunda pergunta');
    expect(seen.map((s) => s.staged)).toEqual([true, true]);
    expect(seen[0]!.system).toContain('go.mod requires go >= 1.27.3');
    expect(seen[0]!.system).toBe(seen[1]!.system);
  });
});

describe('the web search the chat may make', () => {
  it('does not search the web when the confidentiality check fails, or is missing', async () => {
    const runAgent = vi.fn(async (_req: Req) => ok({ answer: 'Resposta.', correction: null }));
    await make(runAgent, { confidential: async () => { throw new Error('registro ilegível'); } }).service.ask('hello-app', 'primeira pergunta');
    await make(runAgent).service.ask('hello-app', 'segunda pergunta');
    expect(runAgent.mock.calls[0]![0]).toMatchObject({ webSearch: false });
    expect(runAgent.mock.calls[1]![0]).toMatchObject({ webSearch: false });
  });

  it('keeps the failure record out of the paths the chat may not read', async () => {
    const runAgent = vi.fn(async (_req: Req) => ok({ answer: 'Resposta.', correction: null }));
    await make(runAgent).service.ask('hello-app', 'o que aconteceu?');
    const denied: string[] = runAgent.mock.calls[0]![0].denyRead ?? [];
    expect(denied.some((p) => p.includes('falhas'))).toBe(false);
  });
});
