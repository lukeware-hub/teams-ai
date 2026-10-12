import type { BacklogItem } from '../contracts/backlog.js';
import type { SpecStatus } from '../contracts/spec.js';
import { isStarted } from './coverage.js';
import { sourceHashes, type BacklogDocs } from './details.js';
import type { BacklogState, PatchRow } from './state.js';

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

/** The keys an adjustment changes, oldest first: its original and the earlier adjustments of it in the outline. */
export function adjusted(key: string, items: readonly Pick<BacklogItem, 'key'>[]): string[] {
  const root = rootOf(key);
  if (!root || !items.some((i) => i.key === root)) return [];
  return [root, ...items.map((i) => i.key).filter((k) => rootOf(k) === root && numberOf(k) < numberOf(key)).sort((a, b) => numberOf(a) - numberOf(b))];
}

export interface DueAdjustment {
  key: string;
  /** The started spec it changes: the original's own, or its latest adjustment's. */
  specId: string;
  status: SpecStatus;
  /** The cited sections whose text is new since that spec was derived. */
  changed: string[];
}

const sameHashes = (a: ReadonlyArray<string | null>, b: ReadonlyArray<string | null>) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** The next adjustment of each original whose latest spec started and whose cited sections changed since; one pending or rejected in this draft is not asked again. */
export function adjustmentsDue(backlog: Pick<BacklogState, 'items' | 'specs'>, docs: BacklogDocs, patches: readonly Pick<PatchRow, 'status' | 'replace'>[]): DueAdjustment[] {
  return backlog.items.filter((i) => !isAdjustment(i.key)).flatMap((original) => {
    const latest = backlog.items.filter((i) => i.key === original.key || rootOf(i.key) === original.key).reduce((a, b) => (numberOf(b.key) > numberOf(a.key) ? b : a));
    const spec = backlog.specs?.[latest.key]?.spec;
    if (!spec?.derivedFrom || !isStarted(spec.status)) return [];
    const was = spec.derivedFrom.sources.map((s) => s.hash);
    const now = sourceHashes(latest, docs);
    if (sameHashes(was, now.map((s) => s.hash))) return [];
    const key = `${original.key}-ajuste-${numberOf(latest.key) + 1}`;
    if (patches.some((p) => (p.status === 'pending' || p.status === 'rejected') && p.replace.startsWith(`## ${approvalHeading(key)}\n`))) return [];
    return [{ key, specId: spec.specId, status: spec.status, changed: now.filter((s) => !was.includes(s.hash)).map((s) => `${s.doc} › ${s.heading}`) }];
  });
}

/** The owner's approval as a patch: its empty `find` appends a section at the end of briefing.md, which changes no other section. */
export function approvalPatch(due: DueAdjustment): { find: string; replace: string; reason: string } {
  const when = due.status === 'done' ? 'foi entregue' : 'começou';
  const changed = due.changed.join('; ') || 'uma seção que ela citava saiu do item';
  return {
    find: '',
    replace: `## ${approvalHeading(due.key)}\n\nA spec ${due.specId} ${when} antes da mudança em ${changed}; este ajuste entrega só o que mudou.\n`,
    reason: `As seções que a spec ${due.specId} cita mudaram depois que ela ${when}: ${changed}. Aceite para aprovar a spec de ajuste ${due.key}, que entrega só o que mudou; rejeite para manter a spec como está.`,
  };
}
