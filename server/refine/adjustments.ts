import type { BacklogItem } from '../contracts/backlog.js';

/**
 * R11.7.4: a spec whose run started never changes. When the sections it cites change, the owner approves an adjustment
 * spec `<key>-ajuste-<n>` by accepting its `## Ajuste aprovado:` section in briefing.md, and the orchestrator, never the
 * agent, adds it to the backlog after the spec it changes.
 */
const ADJUSTMENT = /^([a-z0-9]+(?:-[a-z0-9]+)*)-ajuste-(\d+)$/;
const APPROVED = /^#{1,6}[ \t]+Ajuste aprovado:[ \t]*`?([a-z0-9]+(?:-[a-z0-9]+)*-ajuste-\d+)`?[ \t]*$/gim;

const rootOf = (key: string) => ADJUSTMENT.exec(key)?.[1];
const numberOf = (key: string) => Number(ADJUSTMENT.exec(key)?.[2] ?? 0);
const approvalHeading = (key: string) => `Ajuste aprovado: ${key}`;

export const isAdjustment = (key: string): boolean => ADJUSTMENT.test(key);

/** The adjustments the owner approved: one `## Ajuste aprovado: <key>` section each in briefing.md. */
export function approvedAdjustments(briefing: string): string[] {
  return [...new Set([...briefing.matchAll(APPROVED)].map((m) => m[1]!.toLowerCase()))];
}

/** Each approved adjustment (keys from `approvedAdjustments`) of an item in the outline, after it and its earlier adjustments. */
export function adjustmentItems(items: readonly BacklogItem[], approved: readonly string[]): BacklogItem[] {
  const out: BacklogItem[] = [];
  for (const key of [...approved].sort((a, b) => rootOf(a)!.localeCompare(rootOf(b)!) || numberOf(a) - numberOf(b))) {
    const original = items.find((i) => i.key === rootOf(key));
    if (!original) continue;
    const after = out.filter((a) => rootOf(a.key) === original.key).at(-1)?.key ?? original.key;
    out.push({
      ...original,
      key,
      title: `Ajuste ${numberOf(key)}: ${original.title}`,
      scope: `Só o que mudou desde que começou: ${original.scope}`,
      rationale: 'Ajuste aprovado no briefing.md: as seções que a spec original cita mudaram depois que ela começou.',
      dependsOn: [after],
      sources: [...original.sources, { doc: 'briefing.md', heading: approvalHeading(key) }],
    });
  }
  return out;
}
