import type { Backlog, BacklogItem, Priority } from '../contracts/backlog.js';
import { itemCites } from '../refine/coverage.js';
import type { BacklogDocs } from '../refine/details.js';
import { onlySubsections, resolveHeading } from '../refine/sections.js';
import { findCycle } from '../contracts/plan.js';

export const MAX_ITEMS = 60;
/** Keys that would collide with run ids and docs branches (`<spec>-complete`, `docs/<spec>-v2`, `<spec>-r1` ...). */
const RESERVED_KEY = /^(primary|plan|complete|readme|deploy|report|workflows|done|v\d+|r\d+)$/;
/** What follows `<spec>-` in a spec's docs branches in the project's repository; a service's workflows branch lives in that service's. */
const BRANCH_TAIL = /^(?:plan|report|done|readme|workflows|v\d+)$/;
/** The key among `keys` whose spec also owns the docs branch of `key`: spec ids are the bare keys, so `pricing` owns docs/pricing-plan. */
export const branchOwner = (key: string, keys: Iterable<string>): string | undefined =>
  [...keys].find((o) => o !== key && key.startsWith(`${o}-`) && BRANCH_TAIL.test(key.slice(o.length + 1)));
const PRIORITY_RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Sections of flow.md worth covering: numbered `%% 7. TITLE` comments (mermaid) and level 2-3 markdown headings. */
export function flowHeadings(flow: string): string[] {
  const out: string[] = [];
  for (const line of flow.split(/\r?\n/)) {
    const numbered = /^%%\s*(\d+\.\s+\S.*?)\s*$/.exec(line);
    const markdown = /^#{2,3}\s+(\S.*?)\s*$/.exec(line);
    const heading = numbered?.[1] ?? markdown?.[1];
    if (heading) out.push(heading);
  }
  return out;
}

/** Deterministic rules on a derived backlog, against the docs by the names items cite; the agent gets the messages back when it breaks one. */
export function validateBacklog(backlog: Backlog, opts: { flowHeadings: readonly string[]; docs: Partial<BacklogDocs>; frozen?: ReadonlySet<string> }): string[] {
  const errors: string[] = [];
  if (backlog.items.length > MAX_ITEMS) errors.push(`o backlog tem ${backlog.items.length} itens; o máximo é ${MAX_ITEMS}`);
  const epics = new Set<string>();
  for (const e of backlog.epics) {
    if (epics.has(e.key)) errors.push(`épico com chave duplicada: ${e.key}`);
    epics.add(e.key);
  }
  const byKey = new Map<string, BacklogItem>();
  for (const i of backlog.items) {
    if (byKey.has(i.key)) errors.push(`chave duplicada: ${i.key}`);
    else byKey.set(i.key, i);
    if (RESERVED_KEY.test(i.key)) errors.push(`chave reservada: ${i.key}`);
    if (!epics.has(i.epic)) errors.push(`item ${i.key}: épico desconhecido ${i.epic}`);
  }
  for (const i of backlog.items) {
    const owner = branchOwner(i.key, backlog.items.map((o) => o.key));
    if (owner) errors.push(`chave ${i.key}: o branch docs/${i.key} já é um branch do spec ${owner}; escolha outra chave`);
    for (const d of i.dependsOn) {
      const dep = byKey.get(d);
      if (d === i.key) errors.push(`item ${i.key} depende dele mesmo`);
      else if (!dep) errors.push(`item ${i.key}: dependência desconhecida ${d}`);
      else if (PRIORITY_RANK[dep.priority] > PRIORITY_RANK[i.priority]) errors.push(`item ${i.key} (${i.priority}) depende de ${d} (${dep.priority}), que tem prioridade menor`);
    }
  }
  const cycle = findCycle(backlog.items.map((i) => ({ id: i.key, dependsOn: i.dependsOn })));
  if (cycle) errors.push(`ciclo de dependências: ${cycle.join(' -> ')}`);
  for (const heading of opts.flowHeadings) {
    if (!backlog.items.some((i) => itemCites(i, heading, opts.flowHeadings))) errors.push(`seção do flow.md sem nenhum item: "${heading}"`);
  }
  // A citation of something that is not a section (a diagram title comment) would be kept verbatim cycle after cycle.
  if (opts.flowHeadings.length > 0) {
    const sections = opts.flowHeadings.map((h) => `"${h}"`).join(', ');
    for (const i of backlog.items) {
      for (const s of i.sources) {
        if (s.doc === 'flow.md' && resolveHeading(s.heading, opts.flowHeadings) === null) errors.push(`item ${i.key} cita flow.md › "${s.heading}", que não é uma seção do flow.md; as seções são ${sections}`);
      }
    }
  }
  // R11.10: a section made only of sub-sections is cited through the ones an item needs, so a new decision re-derives only its items.
  // A started item (`frozen`) is never checked, and neither is flow.md, whose every heading the coverage rule above asks for.
  for (const i of backlog.items) {
    if (opts.frozen?.has(i.key)) continue;
    for (const s of i.sources.filter((s) => s.doc !== 'flow.md')) {
      const subs = onlySubsections(opts.docs[s.doc] ?? '', s.heading);
      if (subs) errors.push(`item ${i.key} cita ${s.doc} › "${s.heading}", uma seção feita só de subseções; cite as de que o item precisa: ${subs.map((h) => `"${h}"`).join(', ')}`);
    }
  }
  return errors;
}

/** Priority first, dependencies before dependents, the agent's own order within a level. */
export function rankItems<T extends Pick<BacklogItem, 'key' | 'priority' | 'dependsOn'>>(items: readonly T[]): Array<T & { rank: number }> {
  const position = new Map(items.map((i, n) => [i.key, n]));
  const placed = new Set<string>();
  const remaining = [...items];
  const out: Array<T & { rank: number }> = [];
  while (remaining.length > 0) {
    const ready = remaining.filter((i) => i.dependsOn.every((d) => placed.has(d) || !position.has(d)));
    const pool = ready.length > 0 ? ready : remaining; // a cycle is rejected by validateBacklog; never loop on one
    const next = [...pool].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || position.get(a.key)! - position.get(b.key)!)[0]!;
    out.push({ ...next, rank: out.length + 1 });
    placed.add(next.key);
    remaining.splice(remaining.indexOf(next), 1);
  }
  return out;
}
