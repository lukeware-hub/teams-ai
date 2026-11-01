import { z } from 'zod';
import { Project, SERVICE_NAMING } from '../contracts/project.js';
import { AC_ID, AcceptanceCriterion, Spec, type SpecDecision } from '../contracts/spec.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';
import { buildWithDocs, DIGEST_NOTE } from './docs-view.js';
import { jevHint, type JevValidationResult } from './jev-validation.js';

export function derivePack(input: {
  specHash: string;
  principles: readonly string[];
  projectMd: string;
  briefMd: string;
  stackMd?: string;
  flowMd?: string;
  designMd?: string;
  previous: { project: Project; spec: Spec } | null;
  specId: string;
  jevValidation?: JevValidationResult;
  /** The repositories of the decided architecture, when the draft is stamped: the spec names one of them. */
  repositories?: readonly string[];
}): ContextPackInput {
  const schemas = {
    project: z.toJSONSchema(Project, { target: 'draft-07', io: 'input' }),
    spec: z.toJSONSchema(Spec, { target: 'draft-07', io: 'input' }),
  };
  const feedback = buildWithDocs({ project: input.projectMd, brief: input.briefMd, stack: input.stackMd, flow: input.flowMd, design: input.designMd }, (d, digested) => [
    ...(input.repositories ? [`The architecture names these repositories: ${input.repositories.join(', ')}. Set spec.repository to the one the spec changes, exactly as written here.`] : []),
    `specId must be ${input.specId}. Derive project.json and spec.json from the Markdown below. Classify the demand as feature, bug, maintenance, or refactor. For bugs, preserve actual behavior, expected behavior, reproduction steps, and optional evidence in the bug object; do not invent missing reproduction details. In project.json, \`services\` lists the services the docs split the system into (one repository each; ${SERVICE_NAMING}) and stays out when they describe one application; \`platform\` lists the shared containers stack.md declares for every service, each with an image pinned to a version (never latest) and the command, environment and healthcheck stack.md gives; \`platform\` stays out too when \`services\` does, since a single application keeps the containers it needs in its own docker-compose.yml. Invent neither.`,
    'Use flow.md as the business-flow reference and keep the derived objectives, features, and acceptance criteria consistent with its application behavior.',
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
    '### previous derived JSON (keep unchanged acceptance criterion ids)',
    input.previous ? JSON.stringify(input.previous, null, 2) : '(none)',
    '### JSON schemas',
    JSON.stringify(schemas),
  ].join('\n\n'));
  return {
    kind: 'derive',
    role: 'po',
    specHash: input.specHash,
    principles: input.principles,
    outputContract: outputContract('derive'),
    criteria: input.previous?.spec.acceptanceCriteria ?? [],
    feedback,
    budgetTokens: 20_000,
  };
}

export type DeriveCheck = { ok: true; value: { project: Project; spec: Spec } } | { ok: false; issues: string[] };

export const acNum = (id: string) => Number(id.slice(3));
export const acId = (n: number) => `AC-${String(n).padStart(3, '0')}`;
export const sameText = (a: AcceptanceCriterion, b: AcceptanceCriterion) => a.given === b.given && a.when === b.when && a.then === b.then;

/**
 * Spec (refinement) §3.2 step 1: the orchestrator, not the agent, owns ids, status, hash and version.
 * `floor` (roadmap R11.8) is the highest criterion id already used by any other spec of the same project (single-spec
 * projects with several specs): without it a second spec renumbers from AC-001 again and Phase 4 matches its tests
 * against the JUnit of the whole repo, so an earlier spec's `AC-001` would wrongly "prove" this one's criterion too.
 */
export function postProcessDerived(out: { project: unknown; spec: unknown }, previous: Spec | null, specId: string, floor = 0, decisions?: SpecDecision[], repositories?: readonly string[]): DeriveCheck {
  const p = Project.safeParse(out.project);
  const raw = typeof out.spec === 'object' && out.spec !== null ? (out.spec as Record<string, unknown>) : {};
  // Ids are renumbered before the Spec schema runs, since the schema rejects duplicates the agent may produce.
  // Any string id passes here: a malformed id from the agent is renumbered below instead of failing the whole derive.
  const acs = z.array(AcceptanceCriterion.extend({ id: z.string() })).safeParse(raw.acceptanceCriteria ?? []);
  const prevAcs = previous?.acceptanceCriteria ?? [];
  let criteria: AcceptanceCriterion[] = [];
  if (acs.success) {
    const used = new Set<string>();
    const wellFormed = (c: { id: string }) => AC_ID.test(c.id);
    let max = Math.max(0, floor, ...prevAcs.map((c) => acNum(c.id)), ...acs.data.filter(wellFormed).map((c) => acNum(c.id)));
    criteria = acs.data.map((c) => {
      const kept = prevAcs.find((pc) => sameText(pc, c) && !used.has(pc.id));
      let id = kept ? kept.id : c.id;
      const takenByOther = !kept && prevAcs.some((pc) => pc.id === id && !sameText(pc, c));
      // Below the floor and not this spec's own retained id: a sibling spec already owns that number (R11.8).
      const belowFloor = !kept && wellFormed({ id }) && acNum(id) <= floor;
      if (used.has(id) || takenByOther || belowFloor || !wellFormed({ id })) id = acId(++max);
      used.add(id);
      return { ...c, id };
    });
  }
  const s = Spec.safeParse({
    ...raw,
    acceptanceCriteria: acs.success ? criteria : raw.acceptanceCriteria,
    specId,
    status: 'refining',
    specHash: null,
    specVersion: previous?.specVersion ?? 0,
    validationReports: previous?.validationReports ?? [],
    // Only backlog detailing records where a spec comes from; one the agent fills in here would be invented.
    derivedFrom: undefined,
    // Decisions come from the brief's Decisions section, where the owner reads and edits them, never from the derive agent.
    decisions,
  });
  const issues = [
    ...(p.success ? [] : p.error.issues.map((i) => `project.${i.path.join('.')}: ${i.message}`)),
    ...(s.success ? [] : s.error.issues.map((i) => `spec.${i.path.join('.')}: ${i.message}`)),
  ];
  // A stamped draft names the spec's repository from the architecture: one it does not name is refused.
  const repoIssues = s.success && repositories && !repositories.includes(s.data.repository ?? '') ? [`spec.repository: the spec names its repository, one of ${repositories.join(', ')}`] : [];
  if (!p.success || !s.success || repoIssues.length > 0) return { ok: false, issues: [...issues, ...repoIssues] };
  return { ok: true, value: { project: p.data, spec: s.data } };
}
