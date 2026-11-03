import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';
import { buildWithDocs, DIGEST_NOTE } from './docs-view.js';

/** The two owners who approve specs.md: the PO for the requirements, the SM for the constraints and the plan. */
export const SPECS_REVIEWERS = ['po', 'sm'] as const;
export type SpecsReviewer = (typeof SPECS_REVIEWERS)[number];

const CHECKS: Record<SpecsReviewer, string> = {
  po: 'Check that every objective, persona, flow step and requirement of project.md, briefing.md and flow.md is covered by a spec in specs.md with testable acceptance criteria, and that specs.md states nothing the documents do not.',
  sm: 'Check that every constraint of stack.md and design.md is respected by the specs and pre-plans in specs.md, that each pre-plan task can be done, that the dependencies between items hold, and that no open question remains.',
};

/** The PO or the SM reads specs.md against the five documents: approved only when no check fails, else one finding per failed check. */
export function specsReviewPack(input: { role: SpecsReviewer; specHash: string; specsMd: string; docs: { projectMd: string; briefMd: string; stackMd: string; flowMd: string; designMd: string } }): ContextPackInput {
  const feedback = buildWithDocs({ project: input.docs.projectMd, brief: input.docs.briefMd, stack: input.docs.stackMd, flow: input.docs.flowMd, design: input.docs.designMd, specs: input.specsMd }, (d, digested) =>
    [
      `${CHECKS[input.role]} Return verdict "approved" only when no check fails; otherwise return "rejected" with one finding per failed check, each naming the section it concerns. Write the findings in Brazilian Portuguese. Do not edit any file.`,
      ...(digested ? [DIGEST_NOTE] : []),
      `### project.md\n${d.project}`,
      `### briefing.md\n${d.brief}`,
      `### stack.md\n${d.stack}`,
      `### flow.md (Mermaid)\n${d.flow}`,
      `### design.md\n${d.design}`,
      `### specs.md\n${d.specs}`,
    ].join('\n\n'),
  );
  return { kind: 'specs-review', role: input.role, specHash: input.specHash, principles: [], outputContract: outputContract('specs-review'), criteria: [], feedback, budgetTokens: 30_000 };
}
