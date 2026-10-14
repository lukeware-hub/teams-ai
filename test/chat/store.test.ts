import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatStore, type ChatMessage } from '../../server/chat/store.js';

let dir = '';
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-chatstore-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const msg = (text: string, role: ChatMessage['role'] = 'user'): ChatMessage => ({ role, text, at: '2026-10-14T10:00:00.000Z' });

describe('ChatStore', () => {
  it('reads nothing before the first message, then keeps messages in order', async () => {
    const store = new ChatStore(path.join(dir, 'chats'));
    expect(await store.read('p')).toEqual([]);
    await store.append('p', msg('oi'), msg('olá', 'assistant'));
    await store.append('p', msg('e agora?'));
    expect((await store.read('p')).map((m) => m.text)).toEqual(['oi', 'olá', 'e agora?']);
    expect(await store.read('other')).toEqual([]);
  });

  it('keeps only the last 200 messages', async () => {
    const store = new ChatStore(dir);
    await store.append('p', ...Array.from({ length: 205 }, (_, i) => msg(`m${i}`)));
    const all = await store.read('p');
    expect(all).toHaveLength(200);
    expect(all[0]!.text).toBe('m5');
  });

  it('clears one conversation and treats a corrupt file as empty', async () => {
    const store = new ChatStore(dir);
    await store.append('p', msg('oi'));
    await store.clear('p');
    expect(await store.read('p')).toEqual([]);
    await fs.writeFile(path.join(dir, 'bad.json'), '{not json');
    expect(await store.read('bad')).toEqual([]);
  });
});
