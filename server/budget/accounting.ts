import type { StepKind } from '../agents/outputs.js';
import type { Role } from '../config/config.js';
import type { Usage } from '../runner/stream-events.js';

export interface UsageRecord {
  role: Role;
  phase: string;
  taskId: string | null;
  attempt: number;
  stepKind: StepKind;
  provider: 'claude' | 'omniroute';
  model: string;
  usage: Usage;
  costUsd: number | null;
  durationMs: number;
  numTurns: number;
  at: string;
}

type Filter = Partial<Pick<UsageRecord, 'role' | 'phase' | 'taskId' | 'provider'>>;

export class Accounting {
  private readonly list: UsageRecord[] = [];

  record(r: UsageRecord): void {
    this.list.push({ ...r, usage: { ...r.usage } });
  }

  records(): readonly UsageRecord[] {
    return Object.freeze([...this.list]);
  }

  tokensOf(u: Usage): number {
    return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  }

  total(filter: Filter = {}): Usage & { costUsd: number; steps: number } {
    const out = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, steps: 0 };
    for (const r of this.list) {
      if (filter.role !== undefined && r.role !== filter.role) continue;
      if (filter.phase !== undefined && r.phase !== filter.phase) continue;
      if (filter.taskId !== undefined && r.taskId !== filter.taskId) continue;
      if (filter.provider !== undefined && r.provider !== filter.provider) continue;
      out.inputTokens += r.usage.inputTokens;
      out.outputTokens += r.usage.outputTokens;
      out.cacheReadTokens += r.usage.cacheReadTokens;
      out.cacheWriteTokens += r.usage.cacheWriteTokens;
      out.costUsd += r.costUsd ?? 0;
      out.steps += 1;
    }
    out.costUsd = Math.round(out.costUsd * 1e6) / 1e6;
    return out;
  }
}
