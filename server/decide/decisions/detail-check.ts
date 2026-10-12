import type { Preplan } from '../../contracts/preplan.js';
import type { AcceptanceCriterion, Spec } from '../../contracts/spec.js';
import { MAX_STATE_CHARS, type DecideContext, type Decider } from '../decider.js';
import { noul } from './gate1.js';

/**
 * R11.5a item 3 (plan 85): before PO and SM review the detailed backlog, the Jev checks each new spec and pre-plan
 * against rules their packs already state; a flag sends the item back to its agent once and never fails it.
 */
export const FLAG_MIN = 0.5;

type Decide = Pick<Decider, 'decide'>;
type Check = { instructions: string; criteria: { true: string; false: string } };

const CITED: Check = {
  instructions: 'Does the spec add a capability or rule that neither the item nor its cited sections ask for? Making a rule they state concrete and testable, such as a status code, a field or a message, is not adding one.',
  criteria: { true: 'Yes: some objective, feature or criterion adds a capability or rule the item and its cited sections never ask for.', false: 'No: the spec only delivers, and makes testable, what the item and its cited sections ask for.' },
};
const SHARED_DEPLOY: Check = {
  instructions: 'The end-to-end tests of every spec run against one shared deploy whose data is never reset. Does this criterion depend on something its own test cannot control there: an empty database, an exact count of all records, a fixed calendar date or the real current time?',
  criteria: { true: 'Yes: it needs global state, a fixed date or the real clock, so earlier tests or the day it runs can break it.', false: 'No: it checks only data its test creates and instants its test sets.' },
};
const PROJECT: Check = {
  instructions: 'Does the pre-plan contradict a technical decision that project.md or stack.md states, such as the architecture, a language, a framework, the storage or an interface the documents require?',
  criteria: { true: 'Yes: some module, task or risk goes against a technical decision those documents state.', false: 'No: nothing in the pre-plan goes against a technical decision of those documents.' },
};

/** Whether the Jev answers yes; an unanswered question flags nothing. */
const flagged = async (decider: Decide, state: string, check: Check, ctx: DecideContext) =>
  ((await noul(decider, 'detail-check', state, check.instructions, check.criteria, ctx)) ?? 0) >= FLAG_MIN;

const list = (title: string, lines: readonly string[]) => [title, ...(lines.length ? lines.map((l) => `- ${l}`) : ['(none)'])].join('\n');
const criterion = (c: AcceptanceCriterion) => `Given ${c.given}, when ${c.when}, then ${c.then}`;

export interface SpecCheck {
  item: { key: string; title: string; scope: string };
  /** The sections the item cites, as the PO's pack shows them. */
  sections: ReadonlyArray<{ heading: string; text: string }>;
  spec: Pick<Spec, 'objectives' | 'features' | 'outOfScope' | 'acceptanceCriteria'>;
}

/** The issues for the PO's retry, in Brazilian Portuguese; empty when the Jev flags nothing or does not answer. */
export async function specFlags({ item, sections, spec }: SpecCheck, decider: Decide, ctx: DecideContext): Promise<string[]> {
  const state = [
    `item ${item.key}: ${item.title}\nscope: ${item.scope}`,
    ...sections.map((s) => `### ${s.heading}\n${s.text}`),
    list('spec objectives:', spec.objectives),
    list('spec features:', spec.features),
    list('spec out of scope:', spec.outOfScope),
    list('spec acceptance criteria:', spec.acceptanceCriteria.map(criterion)),
  ].join('\n\n');
  const [outside, ...shared] = await Promise.all([
    // A cut state would hide cited sections and flag what they say.
    state.length > MAX_STATE_CHARS ? false : flagged(decider, state, CITED, ctx),
    ...spec.acceptanceCriteria.map((c) => flagged(decider, `acceptance criterion:\n${criterion(c)}`, SHARED_DEPLOY, ctx)),
  ]);
  return [
    ...(outside ? ['o Jev apontou que a spec acrescenta uma capacidade ou regra que nem o item nem as seções citadas pedem: confira e tire só o que elas não pedem'] : []),
    ...spec.acceptanceCriteria
      .filter((_, i) => shared[i])
      .map((c) => `o Jev apontou que o critério "Dado ${c.given}, quando ${c.when}, então ${c.then}" depende do que o teste não controla no deploy compartilhado (banco vazio, contagem de todos os registros, data fixa ou relógio real): confira e reescreva-o sobre dados que o próprio teste cria e instantes que ele fixa`),
  ];
}

export interface PreplanCheck {
  preplan: Pick<Preplan, 'modules' | 'tasks' | 'risks'>;
  projectMd: string;
  stackMd: string;
}

/** The issue for the SM's retry, in Brazilian Portuguese; empty when the Jev flags nothing or does not answer. */
export async function preplanFlags({ preplan, projectMd, stackMd }: PreplanCheck, decider: Decide, ctx: DecideContext): Promise<string[]> {
  const { modules, tasks, risks } = preplan;
  // The pre-plan comes first: a state cut at the cap loses the end of the docs, which can only hide a contradiction.
  const state = ['pre-plan:', JSON.stringify({ modules, tasks, risks }, null, 2), '### project.md', projectMd, '### stack.md', stackMd].join('\n\n');
  return (await flagged(decider, state, PROJECT, ctx)) ? ['o Jev apontou que o pré-plano contradiz uma decisão técnica do project.md ou do stack.md: confira e siga essas decisões'] : [];
}
