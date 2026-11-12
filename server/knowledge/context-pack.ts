import type { StepKind } from '../agents/outputs.js';
import type { PlanTask } from '../contracts/plan.js';
import type { AcceptanceCriterion, SpecDecision } from '../contracts/spec.js';
import { renderDecision } from '../refine/decisions.js';
import type { AffectedNode, GraphNode } from './graphify.js';
import type { Hit } from './retrieval.js';

export interface HandoffSummary {
  taskId: string;
  title: string;
  summary: string;
  changedFiles: string[];
  mergedAt: string;
}

export interface CodeContext {
  source: 'graph' | 'grep' | 'none';
  nodes?: GraphNode[];
  affected?: AffectedNode[];
  grep?: Array<{ file: string; line: number; text: string }>;
  truncated?: boolean;
  /** The graph file the agent can query with graphify. */
  graphFile?: string;
}

/** The graph files an agent may query: the repository's and the project's brain. Each is present only when its file exists. */
export interface GraphAccess {
  repoGraph?: string;
  projectGraph?: string;
}

export interface ContextPackInput {
  kind: StepKind;
  role: string;
  specHash: string;
  principles: readonly string[];
  outputContract: string;
  task?: PlanTask;
  criteria: readonly AcceptanceCriterion[];
  /** R11.7.6: the owner's answers from the refinement, which the delivery follows; never dropped, like the criteria. */
  decisions?: readonly SpecDecision[];
  objectives?: readonly string[];
  techSpecExcerpt?: string;
  adrs?: ReadonlyArray<{ id: string; title: string; text: string }>;
  assumptions?: readonly string[];
  handoffs?: readonly HandoffSummary[];
  code?: CodeContext;
  /** What the graph's relations say about the spec the step works on; rendered in every pack that has one and never dropped (it is short by construction). */
  specBrief?: string;
  /** Where the agent finds the graphs; rendered in every pack and never dropped, so the agent always knows the brain exists. */
  graphAccess?: GraphAccess;
  retrieval?: readonly Hit[];
  /** The shared docs a docs step rewrites; they leave the pack right before the feedback, since the step can read them in its working directory. */
  currentDocs?: string;
  /** The rules of the step and the errors of its earlier attempts: never dropped and outside `budgetTokens`, like the change set (live: three plan attempts with an identical prompt, every rule and error cut for budget). */
  feedback?: string;
  /**
   * What the step judges and cannot do without: the changed files and diff a security review reads. Rendered last,
   * never dropped and kept out of `budgetTokens`, which only trims the context around it. The caller bounds its size.
   */
  changeSet?: string;
  budgetTokens: number;
}

export interface ContextPack {
  text: string;
  tokens: number;
  sections: string[];
  dropped: string[];
}

export const SECTION_ORDER = [
  'principles',
  'contract',
  'task',
  'criteria',
  'decisions',
  'objectives',
  'tech-spec',
  'adrs',
  'assumptions',
  'handoffs',
  'spec-brief',
  'code',
  'graph-access',
  'retrieval',
  'current-docs',
  'feedback',
  'change-set',
] as const;
type Section = (typeof SECTION_ORDER)[number];

/** Present in every pack. The optional `feedback` and `change-set` are never dropped either: they are simply absent from DROP_ORDER. */
export const NEVER_DROP: readonly Section[] = ['principles', 'contract', 'task', 'criteria'];
/** Drop order when over budget. */
const DROP_ORDER: readonly Section[] = ['retrieval', 'code', 'adrs', 'tech-spec', 'objectives', 'handoffs', 'assumptions', 'current-docs'];

/** The answer budget a graph query asks for: the graph's default of 2000 tokens cut 63% of the answers the agents measured, and the cut nodes were often the ones that mattered. */
export const GRAPH_QUERY_BUDGET = 4000;
const MAX_HANDOFFS = 6;
const HANDOFF_SUMMARY_CHARS = 400;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Text safe to put inside a shell command the agent may run: letters, digits and a few separators only. */
const plain = (s: string, max = 80) => s.replace(/[^\p{L}\p{N} ._/()-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The graphs the agent may query and, for a step on a task, queries ready to run. */
function renderGraphAccess(access: GraphAccess, task: PlanTask | undefined): string | null {
  const files = [access.projectGraph ? `- project graph (code, documents, specs, tasks, run history and failures, costs, chat): ${access.projectGraph}` : null, access.repoGraph ? `- repository graph (the code of this repository): ${access.repoGraph}` : null].filter((l) => l !== null);
  if (files.length === 0) return null;
  const main = access.projectGraph ?? access.repoGraph!;
  const ready = task
    ? [`- graphify query "${plain(task.title)}" --graph ${main} --budget ${GRAPH_QUERY_BUDGET}`, ...task.affectedPaths.slice(0, 2).map((p) => `- graphify explain "${plain(p.split('/').pop() ?? p)}" --graph ${main}`)].filter((q) => !q.includes('""'))
    : [];
  return [
    '## Graph access (the brain)',
    `Query the graph before you edit, review, plan or write a document: it holds what the project knows. Use graphify query "<question>" --graph <file> --budget ${GRAPH_QUERY_BUDGET}, also graphify explain "<node>" and graphify path "<A>" "<B>".`,
    ...files,
    ...(ready.length ? ['Ready queries for this step:', ...ready] : []),
  ].join('\n');
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function render(input: ContextPackInput): Map<Section, string> {
  const out = new Map<Section, string>();
  out.set('principles', `## Principles\n${input.principles.map((p) => `- ${p}`).join('\n')}`);
  out.set(
    'contract',
    `## Output contract\nstep: ${input.kind} · role: ${input.role}\nspecHash: ${input.specHash}\nEcho this specHash in your output. ${input.outputContract}\nReference only the acceptance criteria, tasks, files and ADRs listed in this pack.`,
  );
  if (input.task) {
    const t = input.task;
    out.set(
      'task',
      `## Task ${t.id}: ${t.title}\n${t.description}\n- owner: ${t.owner}${t.service ? `\n- service: ${t.service}` : ''}\n- dependsOn: ${t.dependsOn.join(', ') || 'none'}\n- affectedPaths: ${t.affectedPaths.join(', ')}\n- criteria: ${t.criteriaRefs.join(', ') || 'none'}`,
    );
  } else {
    out.set('task', `## Step\n${input.kind} for ${input.role}`);
  }
  out.set(
    'criteria',
    `## Acceptance criteria\n${input.criteria.map((c) => `- ${c.id}${c.smoke ? ' (smoke)' : ''}: Given ${c.given}, when ${c.when}, then ${c.then}`).join('\n') || '- none for this step'}`,
  );
  if (input.decisions?.length) {
    out.set('decisions', `## Owner decisions (answers the owner gave during refinement; follow them within the global rules)\n${input.decisions.map(renderDecision).join('\n')}`);
  }
  if (input.objectives?.length) out.set('objectives', `## Objectives\n${input.objectives.map((o) => `- ${o}`).join('\n')}`);
  if (input.techSpecExcerpt) out.set('tech-spec', `## Technical spec (excerpt)\n${input.techSpecExcerpt}`);
  if (input.adrs?.length) out.set('adrs', `## ADRs\n${input.adrs.map((a) => `### ${a.id}: ${a.title}\n${a.text}`).join('\n')}`);
  if (input.assumptions?.length) out.set('assumptions', `## Assumptions logged during this run\n${input.assumptions.map((a) => `- ${a}`).join('\n')}`);
  if (input.handoffs?.length) {
    const newest = [...input.handoffs].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)).slice(0, MAX_HANDOFFS);
    out.set(
      'handoffs',
      `## Handoffs (merged dependencies, newest first)\n${newest
        .map((h) => `### ${h.taskId}: ${h.title}\n${cut(h.summary, HANDOFF_SUMMARY_CHARS)}\nfiles: ${h.changedFiles.slice(0, 12).join(', ')}`)
        .join('\n')}`,
    );
  }
  if (input.specBrief) out.set('spec-brief', `## Spec relations (from the graph)\n${input.specBrief}`);
  if (input.code && input.code.source !== 'none') {
    if (input.code.source === 'graph') {
      const nodes = (input.code.nodes ?? []).map((n) => `- ${n.label} — ${n.file}${n.line ? `:${n.line}` : ''}`);
      const affected = (input.code.affected ?? []).map((a) => `- ${a.label} [${a.relation}] — ${a.file}${a.line ? `:${a.line}` : ''}`);
      out.set(
        'code',
        `## Code context (graph${input.code.truncated ? ', truncated' : ''})\n${nodes.join('\n') || '- no nodes'}${affected.length ? `\n### Impact radius\n${affected.join('\n')}` : ''}${input.code.graphFile ? `\nGraph file: ${input.code.graphFile}\nAsk for more with: graphify query "<question>" --graph ${input.code.graphFile}` : ''}`,
      );
    } else {
      out.set('code', `## Code context (grep; code graph unavailable or too thin)\n${(input.code.grep ?? []).map((g) => `- ${g.file}:${g.line}: ${g.text}`).join('\n') || '- no matches'}`);
    }
  }
  const access = input.graphAccess ? renderGraphAccess(input.graphAccess, input.task) : null;
  if (access) out.set('graph-access', access);
  if (input.retrieval?.length) {
    out.set('retrieval', `## Retrieved context\n${input.retrieval.map((h) => `### ${h.title}${h.heading ? ` › ${h.heading}` : ''} (${h.kind})\n${h.text}`).join('\n')}`);
  }
  if (input.currentDocs) out.set('current-docs', `## Current docs on main\n${input.currentDocs}`);
  if (input.feedback) out.set('feedback', `## Feedback from the previous attempt\n${input.feedback}`);
  if (input.changeSet) out.set('change-set', `## Change set under review\n${input.changeSet}`);
  return out;
}

function assemble(sections: Map<Section, string>, dropped: string[]): string {
  const parts = SECTION_ORDER.filter((s) => sections.has(s)).map((s) => sections.get(s)!);
  if (dropped.filter((d) => !d.startsWith('!')).length > 0) parts.push(`## Note\nDropped for budget: ${dropped.filter((d) => !d.startsWith('!')).join(', ')}`);
  return `${parts.join('\n\n')}\n`;
}

/** Deterministic, budgeted prompt for one agent step (spec §8.3, §9A.1). */
export function buildContextPack(input: ContextPackInput): ContextPack {
  const sections = render(input);
  const dropped: string[] = [];
  // Feedback and the change set are outside DROP_ORDER and outside the budget, so neither can push itself or the other out.
  const budget = input.budgetTokens + estimateTokens(sections.get('feedback') ?? '') + estimateTokens(sections.get('change-set') ?? '');
  let text = assemble(sections, dropped);
  for (const s of DROP_ORDER) {
    if (estimateTokens(text) <= budget) break;
    if (!sections.has(s)) continue;
    sections.delete(s);
    dropped.push(s);
    text = assemble(sections, dropped);
  }
  if (estimateTokens(text) > budget) dropped.push('!over-budget');
  return { text, tokens: estimateTokens(text), sections: SECTION_ORDER.filter((s) => sections.has(s)), dropped };
}
