import type { Preplan } from '../../contracts/preplan.js';
import type { AcceptanceCriterion, Spec } from '../../contracts/spec.js';
import { MAX_STATE_CHARS, type DecideContext, type Decider } from '../decider.js';
import type { DecisionId } from '../types.js';
import { splitSections } from '../windows.js';
import { noul } from './gate1.js';

/**
 * R11.5a item 3 (plan 85): before PO and SM review the detailed backlog, the Jev checks each new spec and pre-plan
 * against rules their packs already state; a flag sends the item back to its agent once and never fails it. Each check
 * is its own decision, so the config switches each one on by itself once an eval measures it.
 */
export const FLAG_MIN = 0.5;

type Decide = Pick<Decider, 'decide'>;
type Check = { id: DecisionId; instructions: string; criteria: { true: string; false: string } };

// One objective per question: on the whole spec the Jev was never sure; on one objective it was (a probe on kayron-hub, 2026-11-09).
const CITED: Check = {
  id: 'spec-cited-sections',
  instructions: 'Does this objective of the spec ask for a capability or rule that neither the item nor its cited sections ask for? Making a rule they state concrete and testable, such as a status code, a field or a message, is not adding one.',
  criteria: { true: 'Yes: the objective adds something the item and its cited sections never ask for.', false: 'No: the objective only delivers, and makes testable, what the item and its cited sections ask for.' },
};
// The pre-plan against the decisions only: on windows of stack.md and project.md the Jev missed a pre-plan built on the wrong architecture.
const PROJECT: Check = {
  id: 'preplan-tech-decisions',
  instructions: 'Does the pre-plan go against one of the decisions below: the architecture (its style and its repositories) or a decision of the owner?',
  criteria: { true: 'Yes: some module, task or risk goes against one of these decisions.', false: 'No: nothing in the pre-plan goes against these decisions.' },
};

/** The flag's opening, so the agent reads it as a check that can be wrong. */
const JEV = 'o Jev (uma checagem automática que pode errar) apontou que';

/**
 * Rules first for the shared deploy: a criterion that needs the whole database empty, a count of every record, a fixed date
 * or the real clock. The Jev was never sure on this check (1102 questions, no answer above 0.8), so a rule decides it.
 */
const NEEDS_SHARED_STATE = [
  /\b(banco|base de dados|tabela)\b(?![^.;]{0,20}\bnov[oa]\b)[^.;]{0,30}\bvazi[oa]\b/i,
  /\b(o banco|a base de dados|a tabela|o sistema)\b[^.;]{0,30}\b(contém|tem|possui)\s+(exatamente\s+)?\d+\b/i,
  /\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b(19|20)\d\d-\d\d-\d\d\b/,
  /\b(data de hoje|data atual|hora atual|relógio real)\b/i,
];
/** A criterion that says it does not depend on that state. */
const INDEPENDENT = /\bsem depender\b|\bnão depende\b/i;
export const needsSharedState = (c: AcceptanceCriterion): boolean => {
  const text = criterion(c);
  return !INDEPENDENT.test(text) && NEEDS_SHARED_STATE.some((rule) => rule.test(text));
};

/** Whether the Jev answers yes; an unanswered question flags nothing. */
const flagged = async (decider: Decide, state: string, check: Check, ctx: DecideContext) =>
  ((await noul(decider, check.id, state, check.instructions, check.criteria, ctx)) ?? 0) >= FLAG_MIN;

const criterion = (c: AcceptanceCriterion) => `Given ${c.given}, when ${c.when}, then ${c.then}`;

export interface SpecCheck {
  item: { key: string; title: string; scope: string };
  /** The sections the item cites, as the PO's pack shows them. */
  sections: ReadonlyArray<{ heading: string; text: string }>;
  spec: Pick<Spec, 'objectives' | 'features' | 'acceptanceCriteria'>;
}

/** The issues for the PO's retry, in Brazilian Portuguese; empty when the Jev flags nothing or does not answer. */
export async function specFlags({ item, sections, spec }: SpecCheck, decider: Decide, ctx: DecideContext): Promise<string[]> {
  // What the spec leaves out is not shown: the Jev could read it as something the spec adds.
  const base = [`item ${item.key}: ${item.title}\nscope: ${item.scope}`, ...sections.map((s) => `### ${s.heading}\n${s.text}`)].join('\n\n');
  const states = spec.objectives.map((objective) => `${base}\n\nspec objective: ${objective}`);
  // A cut state would hide cited sections and flag what they say.
  const outside = await Promise.all(states.map((state) => (state.length > MAX_STATE_CHARS ? false : flagged(decider, state, CITED, ctx))));
  const added = spec.objectives.filter((_, i) => outside[i]);
  return [
    ...(added.length > 0 ? [`${JEV} esta tentativa da spec acrescenta algo que nem o item nem as seções citadas pedem, nos objetivos "${added.join('; ')}": mantenha tudo o que vem do item ou das seções citadas e tire só o que não vem deles`] : []),
    ...spec.acceptanceCriteria
      .filter(needsSharedState)
      .map((c) => `uma regra automática apontou que o critério "Dado ${c.given}, quando ${c.when}, então ${c.then}" depende do que o teste não controla no deploy compartilhado (o banco inteiro vazio, a contagem de todos os registros, uma data fixa ou o relógio real): reescreva-o sobre dados que o próprio teste cria e instantes que ele fixa, ou mantenha-o se as seções citadas fixam essa data`),
  ];
}

export interface PreplanCheck {
  preplan: Pick<Preplan, 'modules' | 'tasks' | 'risks'>;
  /** The architecture and the owner's decisions: the only decisions the pre-plan is compared with. */
  decisions: string;
}

/** The issue for the SM's retry, in Brazilian Portuguese; empty when there is no decision, or the Jev flags nothing or does not answer. */
export async function preplanFlags({ preplan, decisions }: PreplanCheck, decider: Decide, ctx: DecideContext): Promise<string[]> {
  if (decisions.trim() === '') return [];
  const { modules, tasks, risks } = preplan;
  const head = ['pre-plan:', JSON.stringify({ modules, tasks, risks }, null, 2)].join('\n\n');
  const whole = `${head}\n\n${decisions}`;
  // Decisions past the cap are cut into windows that each carry the pre-plan, so every decision is read.
  const room = MAX_STATE_CHARS - head.length - 100;
  const states = whole.length <= MAX_STATE_CHARS || room < 2_000
    ? [whole]
    : splitSections([{ title: 'decisions', text: decisions }], room).map((window) => `${head}\n\n${window}`);
  if (!(await Promise.all(states.map((state) => flagged(decider, state, PROJECT, ctx)))).some(Boolean)) return [];
  return [`${JEV} esta tentativa do pré-plano contradiz uma decisão técnica do stack.md ou do project.md; ela tinha os módulos "${modules.map((m) => m.name).join('; ')}" e as tarefas "${tasks.map((t) => `${t.id} ${t.title}`).join('; ')}": siga essas decisões e mantenha o que já as segue`];
}
