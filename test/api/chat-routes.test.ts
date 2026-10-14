import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatRoutes } from '../../server/api/chat-routes.js';
import { startApi } from '../../server/api/server.js';
import { ChatUnavailableError, type ChatService } from '../../server/chat/service.js';
import { ConflictError, NotFoundError } from '../../server/refine/session.js';

let api: { port: number; close(): Promise<void> };
const base = () => `http://127.0.0.1:${api.port}`;
const chat = { messages: vi.fn(), ask: vi.fn(), clear: vi.fn() };
const post = (url: string, body: unknown) => fetch(`${base()}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(async () => {
  Object.values(chat).forEach((f) => f.mockReset());
  api = await startApi({ routes: chatRoutes({ chat: chat as unknown as ChatService }) }, 0);
});
afterEach(() => api.close());

describe('chat routes', () => {
  it('lists, asks and clears', async () => {
    chat.messages.mockResolvedValue([{ role: 'user', text: 'oi', at: 'a' }]);
    chat.ask.mockResolvedValue({ role: 'assistant', text: 'olá', at: 'b' });
    expect(await (await fetch(`${base()}/api/chat/p`)).json()).toEqual({ messages: [{ role: 'user', text: 'oi', at: 'a' }] });
    const res = await post('/api/chat/p/messages', { text: 'oi' });
    expect(await res.json()).toEqual({ message: { role: 'assistant', text: 'olá', at: 'b' } });
    expect(chat.ask).toHaveBeenCalledWith('p', 'oi');
    expect((await fetch(`${base()}/api/chat/p`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })).status).toBe(200);
    expect(chat.clear).toHaveBeenCalledWith('p');
  });

  it('maps errors: text missing 400, bad input 400, unknown project 404, busy 409, step down 503', async () => {
    expect((await post('/api/chat/p/messages', {})).status).toBe(400);
    chat.ask.mockRejectedValueOnce(new RangeError('x'));
    expect((await post('/api/chat/p/messages', { text: 'a' })).status).toBe(400);
    chat.ask.mockRejectedValueOnce(new NotFoundError('x'));
    expect((await post('/api/chat/p/messages', { text: 'a' })).status).toBe(404);
    chat.ask.mockRejectedValueOnce(new ConflictError('x'));
    expect((await post('/api/chat/p/messages', { text: 'a' })).status).toBe(409);
    chat.ask.mockRejectedValueOnce(new ChatUnavailableError('O limite de uso do Claude acabou por agora.'));
    const down = await post('/api/chat/p/messages', { text: 'a' });
    expect([down.status, await down.json()]).toEqual([503, { error: 'O limite de uso do Claude acabou por agora.' }]);
  });
});
