import { Backlog, type BacklogItem } from '../contracts/backlog.js';
import { Project, SERVICE_NAMING } from '../contracts/project.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';
import { branchOwner, flowHeadings, MAX_ITEMS, rankItems, validateBacklog } from '../validators/backlog.js';
import { adjustmentItems, isAdjustment } from './adjustments.js';
import { buildWithDocs, DIGEST_NOTE } from './docs-view.js';
import type { BacklogDocs } from './details.js';
import { jevHint, type JevValidationResult } from './jev-validation.js';
import type { BacklogState } from './state.js';

const RULES = [
  'LANGUAGE (mandatory): write every title, scope, rationale and epic title 100% in Brazilian Portuguese, even when the docs are in English. Keys stay short lowercase slugs; keep file names and technical identifiers unchanged.',
  'Break the project described by the five docs below into a BACKLOG of specs, grouped into epics and prioritized. The docs are the only source of truth: invent nothing they do not say, and leave out nothing they do.',
  '- A spec is the smallest deliverable one run can ship and test end to end: a vertical slice of one capability (one application with bounded contexts as internal modules, or the services the docs name, each in its own repository; a spec may change several of them). Not a single task, not a whole product area.',
  '- Every item cites where it comes from in `sources`: `doc` is one of project.md, briefing.md, stack.md, flow.md, design.md and `heading` is the exact heading text (for flow.md its headings or numbered sections, such as "2. Checkout"). Every numbered or headed section of flow.md must be cited by at least one item; a section may feed several items.',
  '- Cite the narrowest sections: a section that holds only sub-sections (such as `## Decisões`, one `###` heading per decision) is cited through the sub-sections the item needs, never whole; an item cites every decision that changes what it delivers. A section with text of its own is cited by its own heading too, since that text holds the rules its sub-sections follow.',
  '- An item marked `started` keeps its sources exactly as they are, broad ones included: only re-point a heading that was renamed or renumbered.',
  '- When a rule in one section needs what a later item delivers (such as a deletion an active loan blocks), that later item cites the section too, so its spec, which can check the rule, carries it.',
  '- priority: P0 = walking skeleton and the foundations everything else needs; P1 = the core value flow; P2 = important, can follow; P3 = later or optional. `rationale` says why in one sentence (value, risk, dependency).',
  `- dependsOn lists the keys an item cannot ship without. A dependency is never lower priority than its dependent, there are no cycles, and there are at most ${MAX_ITEMS} items.`,
  '- Treat any explicit priority, cut, merge or split instruction written in the docs (above all briefing.md) as binding.',
  '- key: a short slug. Keep the key of every item that still exists in the previous backlog so the ids derived from them stay stable.',
  '- Never write an item whose key ends in -ajuste-<n>: the orchestrator adds one, after its original, for each "## Ajuste aprovado:" section of briefing.md.',
  '- When the sections an item cites did not change, keep its title, scope and sources verbatim from the previous backlog, adding only the citation of each new decision that changes what it delivers: a reworded item has its spec and pre-plan derived again.',
  'Also return `project`: the project.json derived from project.md and stack.md, exactly as in a normal derivation (with `services` and `platform` when the docs give them). ' + SERVICE_NAMING,
].join('\n');

export function backlogPack(input: {
  specHash: string;
  principles: readonly string[];
  projectMd: string;
  briefMd: string;
  stackMd?: string;
  flowMd?: string;
  designMd?: string;
  previous: BacklogState | null;
  jevValidation?: JevValidationResult;
  /** What the validators rejected in the last attempt of this cycle. */
  rejection?: readonly string[];
  /** Keys of the items whose spec started or was delivered (R11.7.5), shown as `started` so their sources stay put. */
  started?: readonly string[];
}): ContextPackInput {
  const started = new Set(input.started);
  const previous = input.previous?.items.length ? JSON.stringify({ epics: input.previous.epics, items: input.previous.items.map((i) => ({ key: i.key, title: i.title, epic: i.epic, priority: i.priority, scope: i.scope, sources: i.sources, ...(started.has(i.key) ? { started: true } : {}) })) }, null, 2) : '(none)';
  const feedback = buildWithDocs({ project: input.projectMd, brief: input.briefMd, stack: input.stackMd, flow: input.flowMd, design: input.designMd }, (d, digested) => [
    RULES,
    ...(digested ? [DIGEST_NOTE] : []),
    '### docs/project.md',
    d.project,
    '### briefing.md',
    d.brief,
    ...(input.stackMd ? ['### stack.md', d.stack] : []),
    ...(input.flowMd ? ['### flow.md (Mermaid)', d.flow] : []),
    ...(input.designMd ? ['### design.md', d.design] : []),
    '### Jev preflight validation',
    jevHint(input.jevValidation),
    '### previous backlog (keep the keys)',
    previous,
    ...(input.rejection?.length ? ['### Your last attempt was rejected: fix every point', input.rejection.map((r) => `- ${r}`).join('\n')] : []),
  ].join('\n\n'));
  return { kind: 'backlog', role: 'po', specHash: input.specHash, principles: input.principles, outputContract: outputContract('backlog'), criteria: [], feedback, budgetTokens: 20_000 };
}

export type BacklogCheck = { ok: true; value: { project: Project; backlog: { epics: Backlog['epics']; items: Array<BacklogItem & { rank: number }> } } } | { ok: false; issues: string[] };

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Whether `key` and another of `keys` would own one docs branch, as `pricing` and `pricing-plan`. */
const sharesBranch = (key: string, keys: readonly string[]): boolean => branchOwner(key, keys) !== undefined || keys.some((k) => branchOwner(k, [key]) !== undefined);

/** The agent may rename a key between cycles; an item with the title of a previous one keeps that previous key, unless it would share a docs branch. */
function keepPreviousKeys(items: readonly BacklogItem[], previous: BacklogState | null): BacklogItem[] {
  if (!previous) return [...items];
  const taken = new Set(items.map((i) => i.key));
  const rename = new Map<string, string>();
  for (const i of items) {
    const old = previous.items.find((p) => sameTitle(p.title, i.title));
    if (old && old.key !== i.key && !previous.items.some((p) => p.key === i.key) && !taken.has(old.key) && !sharesBranch(old.key, [...taken].filter((k) => k !== i.key))) {
      rename.set(i.key, old.key);
      taken.add(old.key);
    }
  }
  return items.map((i) => ({ ...i, key: rename.get(i.key) ?? i.key, dependsOn: i.dependsOn.map((d) => rename.get(d) ?? d) }));
}

/** The orchestrator, not the agent, owns key stability, validity and rank, keeps every started item (R11.7.5) and adds the adjustments the owner approved (R11.7.4). */
export function postProcessBacklog(out: { project: unknown; backlog: unknown }, previous: BacklogState | null, docs: Partial<BacklogDocs>, approved: readonly string[] = [], started: readonly BacklogItem[] = []): BacklogCheck {
  const project = Project.safeParse(out.project);
  const backlog = Backlog.safeParse(out.backlog);
  const issues = [
    ...(project.success ? [] : project.error.issues.map((i) => `project.${i.path.join('.')}: ${i.message}`)),
    ...(backlog.success ? [] : backlog.error.issues.map((i) => `backlog.${i.path.join('.')}: ${i.message}`)),
  ];
  if (!project.success || !backlog.success) return { ok: false, issues };
  const items = keepPreviousKeys(backlog.data.items.filter((i) => !isAdjustment(i.key)), previous);
  const rules = validateBacklog({ epics: backlog.data.epics, items }, { flowHeadings: flowHeadings(docs['flow.md'] ?? ''), docs, frozen: new Set(started.map((s) => s.key)) });
  if (rules.length > 0) return { ok: false, issues: rules };
  // A started item the agent dropped stays as it was, with only the dependencies still in the outline.
  const keys = new Set([...items, ...started].map((i) => i.key));
  const all = [...items, ...started.filter((s) => !items.some((i) => i.key === s.key)).map((s) => ({ ...s, dependsOn: s.dependsOn.filter((d) => keys.has(d)) }))];
  // The backlog views group items by epic: a kept item keeps its epic from the previous outline.
  const epics = [...backlog.data.epics, ...(previous?.epics ?? []).filter((e) => !backlog.data.epics.some((x) => x.key === e.key) && all.some((i) => i.epic === e.key))];
  // Adjustments first: rank breaks ties by position, so each runs right after its original, before what waits on it.
  const adjustments = adjustmentItems(all, approved).filter((a) => !all.some((i) => i.key === a.key));
  return { ok: true, value: { project: project.data, backlog: { epics, items: rankItems([...adjustments, ...all]) } } };
}

/** The backlog as a Markdown view for people (and later agents); generated, never edited by hand. */
export function renderBacklogMd(backlog: Pick<BacklogState, 'epics' | 'items'>): string {
  const byKey = new Map(backlog.items.map((i) => [i.key, i]));
  const parts = ['# Backlog', '', '> Gerado pelos agentes a partir dos documentos; não edite. Para mudar prioridades ou cortes, escreva no briefing.md e reavalie.', ''];
  for (const epic of backlog.epics) {
    const items = backlog.items.filter((i) => i.epic === epic.key).sort((a, b) => a.rank - b.rank);
    if (items.length === 0) continue;
    parts.push(`## ${epic.title}`, '', '| # | Prioridade | Spec | Tamanho | Depende de |', '|---|---|---|---|---|');
    for (const i of items) parts.push(`| ${i.rank} | ${i.priority} | ${i.key} | ${i.size} | ${i.dependsOn.map((d) => byKey.get(d)?.key ?? d).join(', ') || '-'} |`);
    parts.push('');
    for (const i of items) parts.push(`### ${i.key}: ${i.title}`, '', `- Escopo: ${i.scope}`, `- Por quê: ${i.rationale}`, `- Origem: ${i.sources.map((s) => `${s.doc} › ${s.heading}`).join('; ')}`, '');
  }
  return parts.join('\n');
}
