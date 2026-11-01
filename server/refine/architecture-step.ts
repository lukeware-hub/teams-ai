import path from 'node:path';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import { Architecture, repoKind, repositoryContext, type RepositoryContext } from '../contracts/architecture.js';
import { Project, SERVICE_NAMING } from '../contracts/project.js';
import type { ArchitectureOutput } from '../agents/outputs.js';
import { SERVICE_SUFFIXES } from '../core/ids.js';
import type { ContextPackInput } from '../knowledge/context-pack.js';
import { outputContract } from '../orchestrator/steps.js';
import { writeFileAtomic } from '../core/atomic-write.js';
import { buildWithDocs, DIGEST_NOTE } from './docs-view.js';
import { validateArchitecture } from './architecture-validate.js';
import { DOC_STAGES } from './doc-stages.js';
import type { DocFile } from './draft.js';
import { normHeading } from './sections.js';

/** The architecture of one project: a monolith is one repository; microservices list one repository per service. */
export const ARCHITECTURE_DOC = 'architecture';

/** The hash of the five documents, as the architecture was decided on them; an edit of any of them changes it. */
export function docsHashOf(docs: Readonly<Record<DocFile, string>>): string {
  return sha256(canonicalJson(DOC_STAGES.map((file) => [file, sha256(docs[file])])));
}

/** The services a stamped project gets from its architecture: its repositories, or none for a monolith (no services, no platform). */
export function withArchitecture(project: Project, arch: Architecture): Project {
  const { services: _services, platform: _platform, ...rest } = project;
  if (arch.style === 'monolith') return Project.parse(rest);
  return Project.parse({ ...rest, services: arch.repositories.map((repo) => repo.name) });
}

/** The repositories of a stamped draft's decided architecture; undefined before the decision and for an unstamped draft. */
export function repositoryNamesOf(state: ArchitectureState): string[] | undefined {
  return state.repositories === true && state.architecture ? state.architecture.decision.repositories.map((r) => r.name) : undefined;
}

/** The context of the item's repository in a stamped draft's architecture; undefined when the item names none. */
export function repositoryContextOf(state: ArchitectureState, name: string | undefined): RepositoryContext | undefined {
  return state.repositories === true && state.architecture ? repositoryContext(state.architecture.decision, name) : undefined;
}

/** The part of the refinement state the architecture helpers read. */
type ArchitectureState = { repositories?: boolean; architecture?: { decision: Architecture } | null };

/** A stamped project takes its services from the decided architecture; before the decision it keeps what the docs gave. */
export function projectWithArchitecture(project: Project, state: { repositories?: boolean; architecture?: { decision: Architecture } | null }): Project {
  return state.repositories === true && state.architecture ? withArchitecture(project, state.architecture.decision) : project;
}

/** The architecture's repositories with the kind each one has, for the owner and the packs. */
export function repositoryLines(arch: Architecture): string[] {
  return arch.repositories.map((repo) => `- ${repo.name} (${repoKind(repo.name, arch.style) ?? 'sem sufixo'}): ${repo.responsibility}`);
}

/** The architecture as the owner reads it: the style, its reason, each repository with its quote, and each integration. */
export function renderArchitectureMd(arch: Architecture): string {
  const style = arch.style === 'monolith' ? 'Monólito' : 'Microsserviços';
  const repos = arch.repositories.map((repo) => `### ${repo.name}\n\n- Responsabilidade: ${repo.responsibility}\n- Tipo: ${repoKind(repo.name, arch.style) ?? 'sem sufixo'}\n- Evidência (${repo.evidence.doc}): "${repo.evidence.quote}"`);
  const links = arch.integrations.map((link) => `- ${link.consumer} → ${link.provider}: ${link.contract}`);
  return [
    '# Arquitetura',
    `## Estilo\n\n${style}\n\n${arch.rationale}`,
    `## Repositórios (${arch.repositories.length})\n\n${repos.join('\n\n')}`,
    `## Integrações (${arch.integrations.length})\n\n${links.length > 0 ? links.join('\n') : 'Nenhuma.'}`,
    '',
  ].join('\n\n');
}

/** Where the decided architecture is written in the draft; the two files travel with the other project docs. */
export async function writeArchitectureFiles(draftRoot: string, arch: Architecture): Promise<void> {
  const docs = path.posix.join(draftRoot, 'docs');
  await writeFileAtomic(path.posix.join(docs, `${ARCHITECTURE_DOC}.json`), `${JSON.stringify(arch, null, 2)}\n`);
  await writeFileAtomic(path.posix.join(docs, `${ARCHITECTURE_DOC}.md`), renderArchitectureMd(arch));
}

export interface ArchitecturePackInput {
  specHash: string;
  principles: readonly string[];
  docs: Readonly<Record<DocFile, string>>;
  /** The part of the Graphify graph that answers the question; empty when the graph has nothing, and the documents travel in full. */
  graphContext: string;
  /** The services the project already has, if any. */
  existingServices: readonly string[];
  /** The owner's answers to the earlier architecture questions. */
  answers: readonly string[];
  /** What the last attempt got wrong, for the one repair. */
  issues?: readonly string[];
}

/** The architecture pack: the five documents in full (or as a digest), the graph context, the existing services and the owner's answers. */
export function architecturePack(input: ArchitecturePackInput): ContextPackInput {
  const feedback = buildWithDocs({ project: input.docs['project.md'], brief: input.docs['briefing.md'], stack: input.docs['stack.md'], flow: input.docs['flow.md'], design: input.docs['design.md'] }, (d, digested) => [
    'Decide the architecture of the system the five documents describe, in Brazilian Portuguese: style "monolith" (one repository named after the project) or "microservices" (one repository per service).',
    'Choose microservices only when the documents describe separate parts with their own responsibility and an integration between them. Several applications are not microservices by themselves.',
    `Name each microservice repository with the suffix of its type: ${SERVICE_SUFFIXES.map((s) => `-${s}`).join(', ')}. ${SERVICE_NAMING}`,
    'Every repository cites an evidence quote copied word for word from one of the five documents. Never invent a repository or a responsibility the documents do not state.',
    'Integrations link a consumer and a provider, both repositories of this architecture, with the contract they share (an endpoint, an event, a file).',
    'A split the documents do not settle is a question for the owner, never a guess: blocking when the answer changes the repositories.',
    'Return the rationale naming the document and the section it rests on.',
    ...(input.issues && input.issues.length > 0 ? ['The last answer broke these rules, fix them all:', ...input.issues.map((i) => `- ${i}`)] : []),
    ...(input.answers.length > 0 ? ['### Owner answers\n' + input.answers.map((a) => `- ${a}`).join('\n')] : []),
    ...(input.existingServices.length > 0 ? [`### Existing services\n${input.existingServices.join(', ')}`] : []),
    ...(input.graphContext ? [`### Graph context\n${input.graphContext}`] : []),
    ...(digested ? [DIGEST_NOTE] : []),
    `### project.md\n${d.project}`,
    `### briefing.md\n${d.brief}`,
    `### stack.md\n${d.stack}`,
    `### flow.md (Mermaid)\n${d.flow}`,
    `### design.md\n${d.design}`,
  ].join('\n\n'));
  return { kind: 'architecture', role: 'sm', specHash: input.specHash, principles: input.principles, outputContract: outputContract('architecture'), criteria: [], feedback, budgetTokens: 30_000 };
}

/** The rules the validator checks, with the document texts it reads quotes from. */
export function checkDecision(out: ArchitectureOutput, projectId: string, docs: Readonly<Record<DocFile, string>>): string[] {
  const arch = Architecture.parse({ style: out.style, rationale: out.rationale, repositories: out.repositories, integrations: out.integrations });
  return validateArchitecture(arch, { projectId, docs, normalize: (text) => ` ${normHeading(text)} ` });
}
