import type { BacklogItem } from '../contracts/backlog.js';
import type { Preplan } from '../contracts/preplan.js';
import type { Spec } from '../contracts/spec.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';
import type { BacklogDocs } from './details.js';
import { sectionText } from './sections.js';

type RankedItem = BacklogItem & { rank: number };

const LANGUAGE = 'LANGUAGE (mandatory): write every objective, feature, criterion, out-of-scope line, module, task title, risk and mitigation 100% in Brazilian Portuguese, even when the docs are in English. Keep keys, ids, file names and technical identifiers unchanged.';
const SELF_CONTAINED = 'Everything you need is in this pack: do not read files, run commands or use tools. Reply with the single JSON object and nothing else.';

const SPEC_RULES = [
  LANGUAGE,
  SELF_CONTAINED,
  'Write the spec of each backlog item below: one entry per item, with the same `key`. Derive it only from the item and the doc sections it cites; invent nothing they do not say, and leave to other items what their scope covers.',
  '- objectives: what the item delivers, each one verifiable. features: the capabilities it ships. outOfScope: what it leaves to other items or out of the product.',
  '- acceptanceCriteria: Given/When/Then, each one testable end to end; set `smoke: true` on the one or two that prove the slice works after a deploy. The orchestrator numbers criteria across the backlog: echo the previous id of a criterion you keep or edit, and use any AC-nnn id for a new one.',
  '- Time in criteria: state instants relative to a reference instant the test controls (for example "15 days after the loan"), never a fixed calendar date and never the real clock, unless the docs fix the date.',
  '- One end-to-end suite checks the criteria of every spec on one shared deploy, and the data of earlier tests stays there: never assume an empty database or exact global counts; assert only on data the test itself creates (a unique prefix, the ids it got back), and leave a case that needs a clean state to integration tests.',
  '- Each criterion is checked only through what this item and the items it depends on, directly or through others, deliver (their routes, screens and data), never through what a later or unrelated item delivers: the program delivers and verifies the item before those exist. A rule of a cited section that needs what a later item delivers goes to outOfScope, naming what it needs.',
  '- externalDependencies: the services the item needs, with the secret names (UPPER_SNAKE_CASE) it reads.',
  '- type is feature unless the item fixes a bug, which then needs its bug details.',
  '- An item that adjusts specs already started or delivered (listed under it) changes software that already exists: its objectives, features and criteria cover only what its cited sections add or change against those specs; restate a criterion that changes in full as a new one, and never repeat what they already deliver.',
].join('\n');

const PREPLAN_RULES = [
  LANGUAGE,
  SELF_CONTAINED,
  'Pre-plan each spec below: one entry per spec, with the same `key`. This is the contract the human reviews; the real plan is still made at execution against the code, and deviations from this one are recorded.',
  '- modules (1-8): the parts of the services this spec changes (the one application when the project has no services) that the tasks touch (name and purpose).',
  '- tasks (1-12): ids P1, P2 ... in execution order; owner dev, devops or front; `module` is one of the modules; dependsOn lists earlier task ids of the same pre-plan. Every task cites at least one acceptance criterion id of its own spec in criteriaRefs, and every criterion is cited by some task.',
  '- The spec marked FIRST also carries the walking skeleton (repository scaffold, local docker infra, CI), cited against its smoke criterion. The others build on what the specs they depend on deliver.',
  '- risks (0-5): what could break the plan, and the mitigation.',
  '- Follow stack.md and the technical decisions in project.md.',
  "- Delivery contract (teams-ai, fixed, not a choice to ask about): the application, or each service the project lists, is its own compose stack that is not torn down or recreated between specs, so a dependent service another spec already added (database, mail catcher, queue) is still running and reachable by its compose service name; the platform containers project.json lists run on the project's shared network, reachable by name — plan to reuse them, never a task to stand them up again or to reset their data.",
].join('\n');

const criteriaLines = (spec: Pick<Spec, 'acceptanceCriteria'>) => spec.acceptanceCriteria.map((c) => `- ${c.id}${c.smoke ? ' (smoke)' : ''}: Given ${c.given}, when ${c.when}, then ${c.then}`).join('\n');
const dependencyLines = (item: BacklogItem, all: readonly RankedItem[]) =>
  item.dependsOn.map((k) => all.find((i) => i.key === k)).map((d, n) => (d ? `- ${d.key}: ${d.title} — ${d.scope}` : `- ${item.dependsOn[n]}`)).join('\n') || '- (nenhuma)';

/** The sections an item cites, as the PO's pack shows them. */
export const citedSections = (item: Pick<BacklogItem, 'sources'>, docs: BacklogDocs) =>
  item.sources.map((s) => ({ heading: `${s.doc} › ${s.heading}`, text: sectionText(docs[s.doc], s.heading) ?? '(seção não encontrada no documento)' }));

/** The PO's pack for the specs of up to three backlog items: the project, each item, and each cited section once. */
export function specPack(input: {
  specHash: string;
  principles: readonly string[];
  docs: BacklogDocs;
  batch: readonly RankedItem[];
  all: readonly RankedItem[];
  previous: Readonly<Record<string, Spec | null | undefined>>;
  rejection: Readonly<Record<string, readonly string[] | undefined>>;
  /** R11.7.4: for an adjustment, the started specs it changes, oldest first. */
  adjusts?: Readonly<Record<string, readonly Spec[] | undefined>>;
}): ContextPackInput {
  const cited = new Map<string, string>();
  for (const i of input.batch) {
    for (const s of citedSections(i, input.docs)) cited.set(`### ${s.heading}`, s.text);
  }
  const items = input.batch.map((i) => {
    const prev = input.previous[i.key];
    return [
      `## Item ${i.key}: ${i.title}`,
      `- epic: ${i.epic}; priority: ${i.priority}; rank: ${i.rank}`,
      `- scope: ${i.scope}`,
      `- rationale: ${i.rationale}`,
      `- sources: ${i.sources.map((s) => `${s.doc} › ${s.heading}`).join('; ')}`,
      'Depends on:',
      dependencyLines(i, input.all),
      ...(input.adjusts?.[i.key]?.length ? ['Adjusts these specs, already started or delivered:', ...input.adjusts[i.key]!.map((s) => [`- ${s.specId}:`, JSON.stringify({ objectives: s.objectives, features: s.features, outOfScope: s.outOfScope }, null, 2), criteriaLines(s)].join('\n'))] : []),
      ...(prev ? ['Previous spec (keep what still holds; echo the ids of the criteria you keep or edit):', JSON.stringify({ objectives: prev.objectives, features: prev.features, outOfScope: prev.outOfScope, externalDependencies: prev.externalDependencies }, null, 2), criteriaLines(prev)] : []),
      ...(input.rejection[i.key]?.length ? ['Your last attempt for this item was rejected; fix every point:', input.rejection[i.key]!.map((r) => `- ${r}`).join('\n')] : []),
    ].join('\n');
  });
  const feedback = [SPEC_RULES, '### docs/project.md', input.docs['project.md'], '# Items', ...items, '# Cited sections', ...[...cited].flatMap(([h, t]) => [h, t])].join('\n\n');
  return { kind: 'spec', role: 'po', specHash: input.specHash, principles: input.principles, outputContract: outputContract('spec'), criteria: [], feedback, budgetTokens: 16_000 };
}

/** The SM's pack for the pre-plans of up to three specs: project.md, stack.md and each spec with its criteria. */
export function preplanPack(input: {
  specHash: string;
  principles: readonly string[];
  projectMd: string;
  stackMd: string;
  batch: ReadonlyArray<{ item: RankedItem; spec: Spec; first: boolean; previous: Preplan | null; rejection: readonly string[] }>;
}): ContextPackInput {
  const specs = input.batch.map(({ item, spec, first, previous, rejection }) => [
    `## Spec ${item.key}: ${item.title}${first ? ' (FIRST: carries the walking skeleton)' : ''}`,
    `- depends on: ${item.dependsOn.join(', ') || '(nothing)'}`,
    JSON.stringify({ type: spec.type, objectives: spec.objectives, features: spec.features, outOfScope: spec.outOfScope, externalDependencies: spec.externalDependencies }, null, 2),
    'Acceptance criteria:',
    criteriaLines(spec),
    ...(previous ? ['Previous pre-plan (keep what still holds):', JSON.stringify({ modules: previous.modules, tasks: previous.tasks, risks: previous.risks }, null, 2)] : []),
    ...(rejection.length ? ['Your last attempt for this spec was rejected; fix every point:', rejection.map((r) => `- ${r}`).join('\n')] : []),
  ].join('\n'));
  const feedback = [PREPLAN_RULES, '### docs/project.md', input.projectMd, '### stack.md', input.stackMd, '# Specs', ...specs].join('\n\n');
  return { kind: 'preplan', role: 'sm', specHash: input.specHash, principles: input.principles, outputContract: outputContract('preplan'), criteria: [], feedback, budgetTokens: 12_000 };
}

const CONFLICT_RULES = [
  SELF_CONTAINED,
  'Specs of this backlog may run at the same time, each on its own branches merged into main. List every pair of items that must never run together because both would change the same code: the same module, files, database migration or schema, shared configuration, routes or screen. A pair where one item depends on the other, directly or through others, already runs in order: leave it out.',
  '- One entry per pair: the two item keys and a short reason in Brazilian Portuguese. When in doubt, list the pair: a missed conflict costs a failed merge, an extra one only some speed.',
  '- Reply with an empty list when every item changes different code.',
].join('\n');

/** The SM's pack for the conflict map: every item with its dependencies and the modules and tasks of its pre-plan. */
export function conflictsPack(input: { specHash: string; principles: readonly string[]; items: ReadonlyArray<{ item: RankedItem; preplan: Preplan }> }): ContextPackInput {
  const items = input.items.map(({ item, preplan }) => [
    `## ${item.key}: ${item.title}`,
    `- depends on: ${item.dependsOn.join(', ') || '(nothing)'}`,
    `- scope: ${item.scope}`,
    'Modules:',
    preplan.modules.map((m) => `- ${m.name}: ${m.purpose}`).join('\n'),
    'Tasks:',
    preplan.tasks.map((t) => `- ${t.id} [${t.module}] ${t.title}`).join('\n'),
  ].join('\n'));
  const feedback = [CONFLICT_RULES, '# Items', ...items].join('\n\n');
  return { kind: 'conflicts', role: 'sm', specHash: input.specHash, principles: input.principles, outputContract: outputContract('conflicts'), criteria: [], feedback, budgetTokens: 12_000 };
}
