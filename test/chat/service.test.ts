import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../server/config/config.js';
import { ChatService, ChatUnavailableError } from '../../server/chat/service.js';
import { ChatStore } from '../../server/chat/store.js';
import { ConflictError, NotFoundError } from '../../server/refine/session.js';

const HELLO = path.resolve('test/fixtures/hello-app');
let home = '';

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-chatsvc-'));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const ok = (value: unknown) => ({ ok: true, value: { specHash: 'x', ...(value as object) }, summary: {} });

interface Req { kind: string; role: string; cwd: string; pack: { feedback?: string } }

function make(runAgent: (req: Req) => Promise<unknown>, extra: { newSpec?: () => Promise<unknown>; log?: (line: string) => void } = {}) {
  const newSpec = vi.fn(extra.newSpec ?? (async () => undefined));
  const suggestSpecId = vi.fn(async () => 'fix-greeting');
  const service = new ChatService({
    store: new ChatStore(path.join(home, 'chats')),
    index: async () => ({ cfg: loadConfig({ paths: { runs: path.join(home, 'runs').replace(/\\/g, '/') }, projects: [{ dir: HELLO }] }), home, isAlive: () => false }),
    runAgent: runAgent as never,
    workspacesRoot: async () => path.join(home, 'ws'),
    suggestSpecId,
    newSpec,
    now: () => new Date('2026-10-14T10:00:00.000Z'),
    log: extra.log,
  });
  return { service, newSpec, suggestSpecId };
}

describe('ChatService.ask', () => {
  it('runs one read-only chat step, strips codes from the answer and saves both messages', async () => {
    const runAgent = vi.fn(async (_req: Req) => ok({ answer: 'Está sendo feito o cumprimento (AC-001).', correction: null }));
    const { service, newSpec } = make(runAgent);
    const reply = await service.ask('hello-app', ' o que está sendo feito? ');
    expect(reply).toEqual({ role: 'assistant', text: 'Está sendo feito o cumprimento.', at: '2026-10-14T10:00:00.000Z' });
    expect(runAgent.mock.calls[0]![0]).toMatchObject({ kind: 'chat', role: 'po' });
    expect(runAgent.mock.calls[0]![0].pack.feedback).toContain('o que está sendo feito?');
    expect((await service.messages('hello-app')).map((m) => [m.role, m.text])).toEqual([['user', 'o que está sendo feito?'], ['assistant', 'Está sendo feito o cumprimento.']]);
    expect(newSpec).not.toHaveBeenCalled();
    await expect(fs.readdir(path.join(home, 'ws', '_chat'))).resolves.toEqual([]);
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

  it('refuses a second question while one is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { service } = make(async () => { await gate; return ok({ answer: 'ok', correction: null }); });
    const first = service.ask('hello-app', 'primeira');
    await new Promise((r) => setTimeout(r, 20));
    await expect(service.ask('hello-app', 'segunda')).rejects.toBeInstanceOf(ConflictError);
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
