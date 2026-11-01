import { SERVICE_SUFFIXES } from '../core/ids.js';
import { type Architecture, type Integration, type Repository, repoKind } from '../contracts/architecture.js';

export interface ArchitectureInput {
  projectId: string;
  docs: Record<Repository['evidence']['doc'], string>;
  normalize: (text: string) => string;
}

/** Returns the problems in Portuguese; an empty list means the architecture is valid. */
export function validateArchitecture(arch: Architecture, input: ArchitectureInput): string[] {
  return [...checkStyle(arch, input.projectId), ...checkIntegrations(arch.repositories.map((repo) => repo.name), arch.integrations), ...checkEvidence(arch, input)];
}

function checkStyle(arch: Architecture, projectId: string): string[] {
  const names = arch.repositories.map((repo) => repo.name);
  if (arch.style === 'monolith') {
    if (names.length !== 1) return [`o monólito deve ter exatamente um repositório, mas tem ${names.length}.`];
    if (names[0] !== projectId) return [`o repositório do monólito deve se chamar "${projectId}", não "${names[0]}".`];
    return arch.integrations.length > 0 ? ['o monólito não pode ter integrações entre repositórios.'] : [];
  }
  const problems: string[] = [];
  if (names.length < 2) problems.push('microsserviços exigem pelo menos dois repositórios.');
  for (const name of new Set(names.filter((name, index) => names.indexOf(name) !== index))) {
    problems.push(`o nome "${name}" aparece em mais de um repositório.`);
  }
  for (const name of names) {
    if (repoKind(name, 'microservices') === null) problems.push(`o repositório "${name}" precisa terminar com um sufixo: ${SERVICE_SUFFIXES.join(', ')}.`);
  }
  if (arch.integrations.length === 0) problems.push('microsserviços exigem pelo menos uma integração.');
  return problems;
}

function checkIntegrations(names: string[], integrations: Integration[]): string[] {
  return integrations.flatMap((link) => {
    const problems = [link.consumer, link.provider]
      .filter((side) => !names.includes(side))
      .map((side) => `a integração "${link.consumer}" -> "${link.provider}" cita "${side}", que não é um repositório da arquitetura.`);
    if (link.consumer === link.provider) problems.push(`a integração "${link.consumer}" aponta para ele mesmo.`);
    return problems;
  });
}

function checkEvidence(arch: Architecture, input: ArchitectureInput): string[] {
  return arch.repositories.flatMap((repo) => {
    const { doc, quote } = repo.evidence;
    const found = input.normalize(input.docs[doc]).includes(input.normalize(quote));
    return found ? [] : [`a citação do repositório "${repo.name}" não existe em ${doc}.`];
  });
}
