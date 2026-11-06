import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';
import { buildWithDocs, DIGEST_NOTE } from './docs-view.js';
import type { DocFile } from './draft.js';

/** The two owners who approve specs.md: the PO for the requirements, the SM for the constraints and the plan. */
export const SPECS_REVIEWERS = ['po', 'sm'] as const;
export type SpecsReviewer = (typeof SPECS_REVIEWERS)[number];

/** The owner gave the team full autonomy, so a written assumption is a settled decision, not an open point. */
const ASSUMPTION_RULE = 'A line written as `Assumption: <claim>. Reason: <why>.` in a document is a decision the owner delegated to the team and is settled: never reject because an assumption is unconfirmed, because it is listed in an open-points section, or because a spec treats it as a fact. Reject only a real conflict between documents, a requirement no spec covers, or a question with no assumption yet.';

const CHECKS: Record<SpecsReviewer, string> = {
  po: 'Check that every objective, persona, flow step and requirement of project.md, briefing.md and flow.md is covered by a spec in specs.md with testable acceptance criteria, and that specs.md states nothing the documents do not.',
  sm: 'Check that every constraint of stack.md and design.md is respected by the specs and pre-plans in specs.md, that each pre-plan task can be done, that the dependencies between items hold, and that no open question remains.',
};

/** The PO or the SM reads specs.md against the five documents: approved only when no check fails, else one finding per failed check. */
export function specsReviewPack(input: { role: SpecsReviewer; specHash: string; specsMd: string; docs: { projectMd: string; briefMd: string; stackMd: string; flowMd: string; designMd: string } }): ContextPackInput {
  const feedback = buildWithDocs({ project: input.docs.projectMd, brief: input.docs.briefMd, stack: input.docs.stackMd, flow: input.docs.flowMd, design: input.docs.designMd, specs: input.specsMd }, (d, digested) =>
    [
      `${CHECKS[input.role]} Return verdict "approved" only when no check fails; otherwise return "rejected" with one finding per failed check, each naming the section it concerns. Write the findings in Brazilian Portuguese. Do not edit any file. ${ASSUMPTION_RULE}`,
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

/** What the PO does when the agents could not repair a rejected specs.md: settle the obvious in the documents, and ask the owner only the rest. */
export function specsAskPack(input: { specHash: string; specsMd: string; findings: ReadonlyArray<{ role: SpecsReviewer; text: string }>; decide?: boolean }): ContextPackInput {
  const feedback = [
    'The PO and the SM rejected specs.md, and detailing the items again twice did not settle it. Their findings:',
    ...input.findings.map((f) => `- ${f.role.toUpperCase()}: ${f.text}`),
    '',
    'Your job, in this order:',
    '1. What the five documents already settle (docs/project.md, briefing.md, stack.md, flow.md, design.md, which you can read) you decide yourself: write a docPatch that fixes the document, and make no question of it. A point that only needs a choice the documents lean towards is an assumption, written into the document as `Assumption: <claim>. Reason: <why>.`',
    input.decide
      ? '2. The owner gave you full autonomy: what no document settles you decide yourself, choosing the option you would recommend, and write the decision into the right document as `Assumption: <claim>. Reason: <why>.` Return no question at all.'
      : '2. What no document settles, and changes what gets built, you ask the owner, as few questions as possible and never one the documents answer.',
    'Write every question for a person who reads it in ten seconds: the text is one or two plain sentences that say what is unclear and why it matters, no file jargon, no acronyms. Give two to four options. Each option has a short label and a detail that says, in one sentence, what happens if it is chosen. Mark exactly one option as recommended, the one you would pick, and make the first option that one.',
    'Each docPatch changes only the document its finding names: a patch to any other document is discarded.',
    'Mark every question blocking. Return an empty checklist. Write everything in Brazilian Portuguese.',
    '',
    `### specs.md\n${input.specsMd}`,
  ].join('\n');
  return { kind: 'refine', role: 'po', specHash: input.specHash, principles: [], outputContract: outputContract('refine'), criteria: [], feedback, budgetTokens: 40_000 };
}

/** The PO decides one open question for the owner, who gave the team full autonomy: the decision goes into the right document as an assumption. */
export function decideQuestionPack(input: { specHash: string; question: string; file?: DocFile }): ContextPackInput {
  const feedback = [
    'The owner gave you full autonomy: decide this open question yourself, using what the documents say (docs/project.md, briefing.md, stack.md, flow.md, design.md, which you can read) and choosing what you would recommend.',
    `Question: ${input.question}`,
    'Write the decision into the right document as a docPatch, as `Assumption: <claim>. Reason: <why>.` Return no question and an empty checklist. Write everything in Brazilian Portuguese.',
    ...(input.file ? [`Change only docs/${input.file}: a docPatch to any other document is discarded.`] : []),
  ].join('\n');
  return { kind: 'refine', role: 'po', specHash: input.specHash, principles: [], outputContract: outputContract('refine'), criteria: [], feedback, budgetTokens: 30_000 };
}

/** The files a finding can open with when it is about a document and not about specs.md. */
const DOC_NAMES = /^[\[(\s]*(docs\/)?(project|briefing|stack|flow|design)\.md/i;

/** Whether a reviewer's finding is about one of the five documents, so redoing a backlog item cannot fix it. */
/** The document a finding names, when it is about one of the five documents. */
export const docNamedBy = (finding: string): DocFile | undefined => {
  const named = DOC_NAMES.exec(finding);
  return named ? (`${named[2]!.toLowerCase()}.md` as DocFile) : undefined;
};
export const aboutADocument = (finding: string): boolean => docNamedBy(finding) !== undefined;

/** What the PO does with the findings that are about the documents: fix them there, so the specs are derived from sound documents. */
export function specsDocsPack(input: { specHash: string; findings: ReadonlyArray<{ role: SpecsReviewer; text: string }> }): ContextPackInput {
  const feedback = [
    'The PO and the SM rejected specs.md, and these findings are about the documents themselves, so redoing a backlog item cannot fix them:',
    ...input.findings.map((f) => `- ${f.role.toUpperCase()}: ${f.text}`),
    '',
    'Fix each one in the right document (docs/project.md, briefing.md, stack.md, flow.md, design.md, which you can read) with a docPatch: merge a section that appears more than once into a single one, close an open point by writing the decision the documents lean towards as `Assumption: <claim>. Reason: <why>.`, correct a wrong citation. Change nothing the owner decided, and add no feature.',
    'Each docPatch changes only the document its finding names: a patch to any other document is discarded.',
    'Return no question and an empty checklist. Write everything in Brazilian Portuguese.',
  ].join('\n');
  return { kind: 'refine', role: 'po', specHash: input.specHash, principles: [], outputContract: outputContract('refine'), criteria: [], feedback, budgetTokens: 30_000 };
}
