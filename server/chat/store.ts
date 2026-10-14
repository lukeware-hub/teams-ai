import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../core/atomic-write.js';

const MAX_MESSAGES = 200;

/** A correction spec the chat opened for a project, or the reason it could not. */
export interface ChatCorrection {
  title: string;
  specId?: string;
  error?: string;
}

/** What one answer cost: tokens the model read and wrote, the estimated price at API rates, the time and the turns it took. */
export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  seconds: number;
  turns: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  correction?: ChatCorrection;
  /** Assistant messages only; absent in conversations saved before the cost was measured. */
  usage?: ChatUsage;
}

/** One conversation per project, kept as a JSON file; `projectId` must already be a validated slug. */
export class ChatStore {
  constructor(readonly dir: string) {}

  private file(projectId: string): string {
    return path.join(this.dir, `${projectId}.json`);
  }

  async read(projectId: string): Promise<ChatMessage[]> {
    const text = await fs.readFile(this.file(projectId), 'utf8').catch(() => null);
    if (text === null) return [];
    try {
      const messages: unknown = JSON.parse(text);
      return Array.isArray(messages) ? (messages as ChatMessage[]) : [];
    } catch {
      return [];
    }
  }

  async append(projectId: string, ...added: ChatMessage[]): Promise<void> {
    const all = [...(await this.read(projectId)), ...added].slice(-MAX_MESSAGES);
    await fs.mkdir(this.dir, { recursive: true });
    await writeFileAtomic(this.file(projectId), JSON.stringify(all));
  }

  async clear(projectId: string): Promise<void> {
    await fs.rm(this.file(projectId), { force: true });
  }
}
