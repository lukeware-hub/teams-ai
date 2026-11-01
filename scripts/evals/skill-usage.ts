// Reads run journals and reports, per step kind, how many steps loaded a skill.
// A call counts even when it failed: the report proves a call, not a successful load.
import { loadEvents } from '../../server/store/event-store.js';

export interface UsageEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface KindUsage {
  steps: number;
  loaded: number;
  /** Share of the steps that loaded the skill, from 0 to 1; 0 when the kind had no step. */
  rate: number;
}

/** Steps per kind, and how many of them called the named skill. */
export function skillUsage(events: readonly UsageEvent[], skill: string): Record<string, KindUsage> {
  const out: Record<string, { steps: number; loaded: number }> = {};
  for (const event of events) {
    if (event.type !== 'STEP_FINISHED') continue;
    const kind = String(event.data.kind ?? 'unknown');
    const profile = event.data.profile as { skills?: Record<string, number> } | undefined;
    out[kind] ??= { steps: 0, loaded: 0 };
    out[kind]!.steps += 1;
    if ((profile?.skills?.[skill] ?? 0) > 0) out[kind]!.loaded += 1;
  }
  return Object.fromEntries(Object.entries(out).map(([kind, row]) => [kind, { ...row, rate: row.steps === 0 ? 0 : row.loaded / row.steps }]));
}

async function main(): Promise<void> {
  const [skill, ...files] = process.argv.slice(2);
  if (!skill || files.length === 0) {
    process.stderr.write('usage: tsx scripts/evals/skill-usage.ts <skill> <journal.jsonl>...\n');
    process.exit(2);
  }
  const events: UsageEvent[] = [];
  for (const file of files) events.push(...((await loadEvents(file)) as unknown as UsageEvent[]));
  process.stdout.write(`${JSON.stringify(skillUsage(events, skill), null, 2)}\n`);
}

if (process.argv[1]?.endsWith('skill-usage.ts')) await main();
