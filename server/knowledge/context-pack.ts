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
  retrieval?: readonly Hit[];
  /** The shared docs a docs step rewrites; they leave the pack right before the feedback, since the step can read them in its working directory. */
  currentDocs?: string;
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
  'code',
  'retrieval',
  'current-docs',
  'feedback',
  'change-set',
] as const;
type Section = (typeof SECTION_ORDER)[number];

/** Present in every pack. The optional `change-set` is never dropped either: it is simply absent from DROP_ORDER. */
export const NEVER_DROP: readonly Section[] = ['principles', 'contract', 'task', 'criteria'];
/** Drop order when over budget; feedback last because a retry is useless without it. */
const DROP_ORDER: readonly Section[] = ['retrieval', 'code', 'adrs', 'tech-spec', 'objectives', 'handoffs', 'assumptions', 'current-docs', 'feedback'];

const MAX_HANDOFFS = 6;
const HANDOFF_SUMMARY_CHARS = 400;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
    out.set('decisions', `## Owner decisions (answers the owner gave during refinement; follow them)\n${input.decisions.map(renderDecision).join('\n')}`);
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
  if (input.code && input.code.source !== 'none') {
    if (input.code.source === 'graph') {
      const nodes = (input.code.nodes ?? []).map((n) => `- ${n.label} — ${n.file}${n.line ? `:${n.line}` : ''}`);
      const affected = (input.code.affected ?? []).map((a) => `- ${a.label} [${a.relation}] — ${a.file}${a.line ? `:${a.line}` : ''}`);
      out.set(
        'code',
        `## Code context (graph${input.code.truncated ? ', truncated — ask for more with graphify query' : ''})\n${nodes.join('\n') || '- no nodes'}${affected.length ? `\n### Impact radius\n${affected.join('\n')}` : ''}`,
      );
    } else {
      out.set('code', `## Code context (grep; code graph unavailable or too thin)\n${(input.code.grep ?? []).map((g) => `- ${g.file}:${g.line}: ${g.text}`).join('\n') || '- no matches'}`);
    }
  }
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
  // The change set is outside DROP_ORDER and outside the budget, so a diff bigger than the whole budget cannot push itself out.
  const budget = input.budgetTokens + estimateTokens(sections.get('change-set') ?? '');
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
