import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import { stepId } from '../core/ids.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import type { NameOutput } from '../agents/outputs.js';
import { outputContract } from '../orchestrator/steps.js';
import type { StepOutcome } from '../runner/step.js';
import type { RunAgent } from './cycle.js';
import { fitPackBudget } from './fit-pack.js';
import { ownerFailure, TRY_AGAIN } from './agent-failure.js';

export type NameKind = 'project' | 'spec';

export interface NameInput {
  kind: NameKind;
  /** The human's display name (projects only). */
  name: string;
  description: string;
  /** Project id the spec belongs to (specs only); never repeated inside the spec id. */
  projectId?: string;
  /** Ids already taken in the same scope; the agent avoids them and `uniqueId` settles any clash. */
  taken: readonly string[];
}

export interface NameSuggestion {
  id: string;
  /** Projects only: the id of the project's first spec, named from the same description. */
  firstSpecId?: string;
}

const RULES = [
  'Name ids the way an English-speaking engineer would name a repository or a feature branch:',
  '- 2 to 4 English words, lowercase kebab-case (letters, digits, single hyphens), at most 40 characters.',
  '- Translate to English when the name or description is in another language.',
  '- Say what the thing is or does: a product noun for projects (`order-service`, `team-wiki`), an outcome for specs (`add-health-check`, `user-login`).',
  '- Never use numbers, dates, version tags, ticket codes or generic words alone (`app`, `project`, `spec`, `mvp`, `initial`).',
  '- A spec id never repeats its project id.',
  '- Never return an id from the taken list.',
];

export function namePack(input: NameInput & { specHash: string }): ContextPackInput {
  const ask = input.kind === 'project'
    ? 'Return `id` for the new project and `firstSpecId` for its first spec (the first deliverable the description asks for).'
    : 'Return `id` for the new spec. Omit `firstSpecId`.';
  const feedback = [
    ask,
    RULES.join('\n'),
    ...(input.projectId ? [`### project id\n${input.projectId}`] : []),
    ...(input.name.trim() ? [`### name\n${input.name.trim()}`] : []),
    `### description\n${input.description.trim() || '(none)'}`,
    `### taken ids\n${input.taken.length ? input.taken.join(', ') : '(none)'}`,
  ].join('\n\n');
  return { kind: 'name', role: 'po', specHash: input.specHash, principles: [], outputContract: outputContract('name'), criteria: [], feedback, budgetTokens: 4_000 };
}

/** The agent's id, made unique in its scope with a `-2`, `-3`, ... suffix (still within 40 characters). */
export function uniqueId(id: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(id)) return id;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${id.slice(0, 40 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * Roadmap R11.12: one small PO step that names a new project or spec. It runs before any workspace exists, so it gets a
 * throwaway directory under the workspaces root (the step runner refuses a cwd outside it) and an in-memory journal.
 */
export async function suggestName(deps: { runAgent: RunAgent; workspacesRoot: string; model?: string }, input: NameInput): Promise<NameSuggestion> {
  const specHash = sha256(canonicalJson({ kind: input.kind, name: input.name, description: input.description, projectId: input.projectId ?? null }));
  const cwd = path.join(deps.workspacesRoot, '_naming', randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  let seq = 0;
  try {
    const out = (await deps.runAgent<'name'>(
      { kind: 'name', role: 'po', pack: fitPackBudget(namePack({ ...input, specHash })), cwd, phase: 'refine', taskId: null, attempt: 1, model: deps.model },
      { journal: { allocStepSeq: () => ++seq, fact: async () => undefined } as never, stepDir: (n) => path.join(cwd, 'steps', stepId(n)), specHash },
    )) as StepOutcome<NameOutput>;
    if (!out.ok) throw ownerFailure('A sugestão de nome', out.failure, out.errors, TRY_AGAIN);
    const id = uniqueId(out.value.id, input.taken);
    if (input.kind === 'spec') return { id };
    const first = out.value.firstSpecId && out.value.firstSpecId !== id ? out.value.firstSpecId : `${id}-core`;
    return { id, firstSpecId: first };
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}
