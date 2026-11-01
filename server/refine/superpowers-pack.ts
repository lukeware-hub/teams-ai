import path from 'node:path';
import type { SpecDecision } from '../contracts/spec.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';
import type { RepositoryContext } from '../contracts/architecture.js';
import { planFileOf, taskFileOf } from './plan-file.js';
import { ADJUST_NOTE, PLAN_INPUTS, questionLedger } from './plan-inputs.js';
import type { QuestionRow } from './state.js';

export interface PlanPackInput {
  specHash: string;
  /** The folder of the six Markdown inputs, relative to the step's folder. */
  inputDir: string;
  specId: string;
  key: string;
  title: string;
  /** The acceptance criterion ids of the spec, each one named by a task. */
  criteria: readonly string[];
  decisions?: readonly SpecDecision[];
  history?: readonly QuestionRow[];
  adjust?: boolean;
  /** The problems the previous plan of this step had, when this run repairs it. */
  repair?: string | null;
  /** The part of the document graph about the spec, when the graph has something. */
  graphContext?: string;
  /** The repository the spec changes, in a stamped draft: its plan names it in the header. */
  repository?: RepositoryContext;
}

/** The clause that runs a skill unattended in a stamped draft: loaded with the Skill tool, and never a stop to ask. */
export function skillClause(skill: string): string {
  return `Load the skill ${skill} with the Skill tool and follow it. Nobody is present: never stop to ask a question, never commit, open a worktree or start a subagent, and load no other skill. The JSON answer is the deliverable.`;
}

/** The repository block of a pack: what the repository is for and the integrations that reach it. */
export function repositoryNote(repo: RepositoryContext): string {
  return [
    `The spec changes the repository ${repo.name} (${repo.kind ?? 'no suffix'}): ${repo.responsibility}.`,
    ...(repo.integrations.length > 0 ? [`Its integrations: ${repo.integrations.join('; ')}.`] : []),
  ].join(' ');
}

/** The plan of one backlog item: the writing-plans skill runs unattended in the staging folder and writes only the plan file. */
export function planPack(input: PlanPackInput): ContextPackInput {
  const inputs = PLAN_INPUTS.map((file) => path.posix.join(input.inputDir, file)).join(', ');
  const file = planFileOf(input.specId);
  const feedback = [
    `Write the implementation plan of the spec ${input.specId}, the backlog item "${input.key}: ${input.title}", with the writing-plans skill of Superpowers: load it with the Skill tool and follow it, with the overrides below.`,
    '- Nobody is present: never stop to ask a question in the chat. Answer the handoff question of the skill "no": no execution choice, no commit, no worktree, no subagent and no other skill.',
    `- Your inputs are these six Markdown files, read with the Read tool: ${inputs}. The spec is the section "## ${input.key}: ${input.title}" of specs.md, with its acceptance criteria and its pre-plan. Every criterion id of that section must be named in a task's **Criteria:** line: ${input.criteria.join(', ')}.`,
    `- Save the plan to ${file} in this folder, and write no other file. Never change the inputs or .claude/.`,
    `- The header of the plan is the title, then **Goal:**, **Architecture:**, **Tech Stack:** and **Spec:** (the repository path docs/specs/${input.specId}/spec.md, the spec the plan implements), then ## Global Constraints (the project principles and the stack values, copied exactly), then ## Review Focus (up to five lines, each one a case the spec implies with the behavior a reasonable person expects, citing the document it comes from or marked as an assumption).`,
    '- Each task is a "### Task N: <name>" block with **Files:** (the paths it creates or changes), **Criteria:** (the ids it delivers, separated by commas), its interfaces, and its test-first steps. Leave out commit, git and worktree steps.',
    "- A fact or a rule comes from the six files or from the owner's decisions, and the plan cites the file for it. Never invent a business rule, and never change existing behavior to follow good practice, unless a failing test or a security fix requires it.",
    '- When nothing settles a point, take the smallest choice that changes nothing else, and record it under ## Assumptions as a bullet ending with "Reason: <why no document settles it>". An assumption is never presented as a fact.',
    '- The owner\'s decisions under "## Decisões" in briefing.md, and the ones below, win over every earlier question. The decisions marked "(PO, from the docs)" or "(SM, from the docs)" are provisional.',
    '- Answer status done with `files` holding the plan path, relative to this folder, and a one-sentence `summary`. Answer status blocked, with `reason`, only when the plan cannot be written at all.',
    '- `questions` is always an empty list.',
    '- Write the content in Brazilian Portuguese; keep the template headings, ids, code names and commands as they are.',
    ...(input.graphContext ? [`### Graph context
${input.graphContext}`] : []),
    ...(input.repository ? [`${repositoryNote(input.repository)} The plan header has one more line, **Repository:** ${input.repository.name}, after **Spec:**.`] : []),
    `### Earlier questions of this item (the latest owner answer wins; never ask one of them again, even reworded)\n${questionLedger(input.history ?? [])}`,
    ...(input.repair ? [input.repair] : []),
    ...(input.adjust ? [ADJUST_NOTE] : []),
  ].join('\n\n');
  return { kind: 'speckit', role: 'dev', specHash: input.specHash, principles: [], outputContract: outputContract('speckit'), criteria: [], feedback, budgetTokens: 8_000, decisions: input.decisions };
}

export interface TaskPackInput {
  specHash: string;
  /** The folder of the six Markdown inputs, relative to the step's folder. */
  inputDir: string;
  specId: string;
  key: string;
  title: string;
  criteria: readonly string[];
  repository?: RepositoryContext;
  repair?: string | null;
  /** The part of the document graph about the spec, when the graph has something. */
  graphContext?: string;
}

/** The task list of one spec: QA writes it from the plan in the staging folder, one entry per plan task, each proven by its criteria. */
export function taskPack(input: TaskPackInput): ContextPackInput {
  const inputs = PLAN_INPUTS.map((file) => path.posix.join(input.inputDir, file)).join(', ');
  const feedback = [
    `Write the task list of the spec ${input.specId}, the backlog item "${input.key}: ${input.title}". Read the implementation plan docs/specs/${input.specId}/implementation-plan.md in this folder, and the six Markdown inputs read with the Read tool: ${inputs}.`,
    `- ${skillClause('superpowers:writing-plans')} Use it for the granularity of the entries.`,
    `- Write only ${taskFileOf(input.specId)} in this folder, and never change the plan, the inputs or .claude/.`,
    `- Write one entry per plan task, headed "## Task N: <name>" with the same number N as the plan's "### Task N:" block. Under it, one line each, in this order: **Spec:** (docs/specs/${input.specId}/spec.md), **Plan:** (docs/specs/${input.specId}/implementation-plan.md), **Repository:**${input.repository ? ` (${input.repository.name})` : ''}, **Objective:**, **Criteria:** (the ids the plan task delivers, the same ids and no others), **Success scenario:** (a test that the feature works), **Error scenario:** (a test that a wrong input or a failing dependency is refused), **Done when:** (what the owner can observe). Keep the labels in English and the content in Brazilian Portuguese.`,
    '- Every criterion id of the spec must appear in at least one entry. Never invent a criterion, and never invent a business rule: a fact comes from the six files, and the entry cites the file for it.',
    '- Each entry says which of the spec\'s business rules it keeps, under **Business rules preserved:**, and lists its dependencies under **Dependencies:** as task numbers.',
    ...(input.graphContext ? [`### Graph context
${input.graphContext}`] : []),
    ...(input.repository ? [repositoryNote(input.repository)] : []),
    ...(input.repair ? [input.repair] : []),
  ].join('\n\n');
  return { kind: 'speckit', role: 'test', specHash: input.specHash, principles: [], outputContract: outputContract('speckit'), criteria: [], feedback, budgetTokens: 8_000 };
}
