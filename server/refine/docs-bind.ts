import { docsTarget, FIVE_DOCS, githubOwnerOf, type RepoTarget, type Style } from '../docs/layout.js';
import { readDocsMarker, type DocsMarker } from '../docs/project-state.js';
import { bind, WRITE_PERMISSIONS } from '../docs/store.js';
import type { Exec } from '../exec/command.js';
import { repoInfo, viewerLogin, type RepoInfo } from '../git/github.js';
import type { Workspace } from '../orchestrator/workspace.js';

/** A bind refused for a reason the owner reads, in plain words. */
export class DocsBindRefused extends Error {}

export interface DocsBindInput {
  ws: Workspace;
  style: Style;
  projectId: string;
  draftId: string;
  /** The five documents by file name, as the draft holds them now. */
  docs: Record<string, string>;
  /** The owner the configuration names, used when the project document names none. */
  configuredOwner: string | undefined;
  exec: Exec;
}

const full = (target: RepoTarget): string => `${target.owner}/${target.name}`;

/** Why the repository cannot take the documents, in plain words; null when it can. A non-empty repository is ours only when this project bound it. */
export function refusalOf(info: RepoInfo | null, target: RepoTarget, bound: DocsMarker | null): string | null {
  if (info === null) return null;
  const name = full(target);
  if (!info.isPrivate) return `O repositório ${name} é público; o repositório de documentos precisa ser privado.`;
  if (info.isArchived) return `O repositório ${name} está arquivado.`;
  if (!WRITE_PERMISSIONS.includes(info.viewerPermission)) return `Sua conta não tem permissão de escrita em ${name}.`;
  const ours = bound?.target.owner === target.owner && bound.target.name === target.name;
  if (!info.isEmpty && !ours) return `O repositório ${name} já tem histórico e não é deste projeto; escolha um repositório vazio.`;
  return null;
}

/** Read-only checks first, then the bind: nothing is written when a check refuses. */
export async function bindDocumentRepo(input: DocsBindInput): Promise<void> {
  const login = await viewerLogin(input.ws.root, input.exec);
  if (login === null) throw new DocsBindRefused('Entre no GitHub antes de liberar o backlog: informe um token ou faça login no gh.');
  const owner = githubOwnerOf(input.docs['project.md'] ?? '') ?? input.configuredOwner ?? login;
  const target = docsTarget(input.style, input.projectId, owner);
  const refusal = refusalOf(await repoInfo(input.ws.root, full(target), input.exec), target, await readDocsMarker(input.ws));
  if (refusal) throw new DocsBindRefused(refusal);
  const documents = Object.fromEntries(FIVE_DOCS.map((doc) => [`docs/${doc}`, input.docs[doc] ?? '']));
  await bind(input.ws, { style: input.style, target, draftId: input.draftId, documents }, input.exec);
}
