import { Backlog, type BacklogItem } from '../contracts/backlog.js';
import { Project } from '../contracts/project.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';
import { flowHeadings, rankItems, validateBacklog } from '../validators/backlog.js';
import type { JevValidationResult } from './jev-validation.js';
import type { BacklogState } from './state.js';

const RULES = [
  'LANGUAGE (mandatory): write every title, scope, rationale and epic title 100% in Brazilian Portuguese, even when the docs are in English. Keys stay short lowercase slugs; keep file names and technical identifiers unchanged.',
  'Break the project described by the five docs below into a BACKLOG of specs, grouped into epics and prioritized. The docs are the only source of truth: invent nothing they do not say, and leave out nothing they do.',
  '- A spec is the smallest deliverable one run can ship and test end to end: a vertical slice of one capability (the delivery contract ships one service per spec, with bounded contexts as internal modules). Not a single task, not a whole product area.',
  '- Every item cites where it comes from in `sources`: `doc` is one of project.md, briefing.md, stack.md, flow.md, design.md and `heading` is the exact heading text (for flow.md the numbered sections, such as "7. OPME"). Every numbered or headed section of flow.md must be cited by at least one item; a section may feed several items.',
  '- priority: P0 = walking skeleton and the foundations everything else needs; P1 = the core value flow; P2 = important, can follow; P3 = later or optional. `rationale` says why in one sentence (value, risk, dependency).',
  '- dependsOn lists the keys an item cannot ship without. A dependency is never lower priority than its dependent, there are no cycles, and there are at most 60 items.',
  '- Treat any explicit priority, cut, merge or split instruction written in the docs (above all briefing.md) as binding.',
  '- key: a short slug. Keep the key of every item that still exists in the previous backlog so the ids derived from them stay stable.',
  'Also return `project`: the project.json derived from project.md, exactly as in a normal derivation.',
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
}): ContextPackInput {
  const previous = input.previous?.items.length ? JSON.stringify({ epics: input.previous.epics, items: input.previous.items.map((i) => ({ key: i.key, title: i.title, epic: i.epic, priority: i.priority })) }, null, 2) : '(none)';
  const feedback = [
    RULES,
    '### docs/project.md',
    input.projectMd,
    '### briefing.md',
    input.briefMd,
    ...(input.stackMd ? ['### stack.md', input.stackMd] : []),
    ...(input.flowMd ? ['### flow.md (Mermaid)', input.flowMd] : []),
    ...(input.designMd ? ['### design.md', input.designMd] : []),
    '### Jev preflight validation',
    input.jevValidation ? JSON.stringify(input.jevValidation, null, 2) : '(not available)',
    '### previous backlog (keep the keys)',
    previous,
    ...(input.rejection?.length ? ['### Your last attempt was rejected: fix every point', input.rejection.map((r) => `- ${r}`).join('\n')] : []),
  ].join('\n\n');
  return { kind: 'backlog', role: 'po', specHash: input.specHash, principles: input.principles, outputContract: outputContract('backlog'), criteria: [], feedback, budgetTokens: 20_000 };
}

export type BacklogCheck = { ok: true; value: { project: Project; backlog: { epics: Backlog['epics']; items: Array<BacklogItem & { rank: number }> } } } | { ok: false; issues: string[] };

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The agent may rename a key between cycles; an item with the title of a previous one keeps that previous key. */
function keepPreviousKeys(items: readonly BacklogItem[], previous: BacklogState | null): BacklogItem[] {
  if (!previous) return [...items];
  const taken = new Set(items.map((i) => i.key));
  const rename = new Map<string, string>();
  for (const i of items) {
    const old = previous.items.find((p) => sameTitle(p.title, i.title));
    if (old && old.key !== i.key && !previous.items.some((p) => p.key === i.key) && !taken.has(old.key)) {
      rename.set(i.key, old.key);
      taken.add(old.key);
    }
  }
  return items.map((i) => ({ ...i, key: rename.get(i.key) ?? i.key, dependsOn: i.dependsOn.map((d) => rename.get(d) ?? d) }));
}

/** The orchestrator, not the agent, owns key stability, validity and rank. */
export function postProcessBacklog(out: { project: unknown; backlog: unknown }, previous: BacklogState | null, flow: string): BacklogCheck {
  const project = Project.safeParse(out.project);
  const backlog = Backlog.safeParse(out.backlog);
  const issues = [
    ...(project.success ? [] : project.error.issues.map((i) => `project.${i.path.join('.')}: ${i.message}`)),
    ...(backlog.success ? [] : backlog.error.issues.map((i) => `backlog.${i.path.join('.')}: ${i.message}`)),
  ];
  if (!project.success || !backlog.success) return { ok: false, issues };
  const items = keepPreviousKeys(backlog.data.items, previous);
  const rules = validateBacklog({ epics: backlog.data.epics, items }, { flowHeadings: flowHeadings(flow) });
  if (rules.length > 0) return { ok: false, issues: rules };
  return { ok: true, value: { project: project.data, backlog: { epics: backlog.data.epics, items: rankItems(items) } } };
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
