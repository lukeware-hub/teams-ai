import { ID_PATTERNS } from '../core/ids.js';

/** The five documents every project keeps, at the root of the docs folder. */
export const FIVE_DOCS = ['project.md', 'flow.md', 'briefing.md', 'design.md', 'stack.md'] as const;

/** The repository paths of the five documents, at the root of the docs folder. */
export const FIVE_DOC_PATHS: readonly string[] = FIVE_DOCS.map((doc) => `docs/${doc}`);

/** The three files of one spec, in its own folder of the documentation repository. */
export const SPEC_FILES = { spec: 'spec.md', plan: 'plan.md', task: 'task.md' } as const;

export type Kind = keyof typeof SPEC_FILES;
export type Style = 'monolith' | 'microservices';
export interface RepoTarget {
  owner: string;
  name: string;
}

/** The name of the central documentation repository of a multi-repo project. */
export const CENTRAL_REPO = 'artefacty';

const MAX_ALIAS = 40;
const WINDOWS_DEVICE = /^(con|nul|aux|prn|com[1-9]|lpt[1-9])$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const OWNER_HEADING = '## GitHub owner';

/** An alias names a spec folder: a slug of at most 40 characters that is not a Windows device name. */
export function isAlias(value: string): boolean {
  return ID_PATTERNS.SLUG.test(value) && value.length <= MAX_ALIAS && !WINDOWS_DEVICE.test(value);
}

export function assertAlias(value: string): string {
  if (!isAlias(value)) throw new RangeError(`alias must be a slug of at most ${MAX_ALIAS} characters and not a Windows device name, got "${value}"`);
  return value;
}

/** The legacy folder of a spec: one folder per spec under docs/specs. */
export const legacyDir = (alias: string): string => `docs/specs/${alias}`;

const LEGACY_FILE: Record<Kind, string> = { spec: 'spec.md', plan: 'implementation-plan.md', task: 'task.md' };

/** A spec's file in the legacy layout; the plan keeps its legacy name, implementation-plan.md. */
export const legacyPath = (kind: Kind, alias: string): string => `${legacyDir(alias)}/${LEGACY_FILE[kind]}`;

/** The folder that holds the specify folder: docs for a monolith, docs/<service> for a microservice. */
function serviceFolder(style: Style, service: string | undefined): string {
  if (style === 'monolith') {
    if (service !== undefined) throw new RangeError('a monolith has no service folder');
    return 'docs';
  }
  if (service === undefined || !ID_PATTERNS.SERVICE.test(service)) throw new RangeError(`a microservice needs a service name with a type suffix, got "${service}"`);
  return `docs/${service}`;
}

/** A spec's file in the documentation repository: one folder per alias, under the service folder when there are services. */
export function repoPath(style: Style, kind: Kind, alias: string, service?: string): string {
  return `${serviceFolder(style, service)}/specify/${assertAlias(alias)}/${SPEC_FILES[kind]}`;
}

/** Whether a folder is the alias folder of one spec: docs/specify/<alias>, or docs/<service>/specify/<alias> for microservices. */
export function isAliasFolder(style: Style, folder: string): boolean {
  const parts = folder.split('/');
  if (style === 'monolith') return parts.length === 3 && parts[0] === 'docs' && parts[1] === 'specify' && isAlias(parts[2]);
  return parts.length === 4 && parts[0] === 'docs' && ID_PATTERNS.SERVICE.test(parts[1]) && parts[2] === 'specify' && isAlias(parts[3]);
}

/** Whether a path of the repository is one of the eight kinds: the five documents, or a spec file of its style. */
export function isAllowedPath(style: Style, rel: string): boolean {
  const parts = rel.split('/');
  if (parts.length === 2 && parts[0] === 'docs') return (FIVE_DOCS as readonly string[]).includes(parts[1]);
  if (!(Object.values(SPEC_FILES) as string[]).includes(parts.at(-1) ?? '')) return false;
  return isAliasFolder(style, parts.slice(0, -1).join('/'));
}

/** The repository that holds the documents: the project's own for a monolith, the central one for microservices. */
export function docsTarget(style: Style, projectId: string, owner: string): RepoTarget {
  if (projectId === CENTRAL_REPO) throw new RangeError(`${CENTRAL_REPO} is the name of the central documentation repository`);
  return { owner, name: style === 'monolith' ? projectId : CENTRAL_REPO };
}

/** The GitHub owner the project's document names, or null when the section is empty or still the template. */
export function githubOwnerOf(projectMd: string): string | null {
  const lines = projectMd.split('\n');
  const start = lines.findIndex((line) => line.trim() === OWNER_HEADING);
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  const value = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (value === undefined || /[<>]/.test(value)) return null;
  if (!GITHUB_LOGIN.test(value)) throw new RangeError(`the owner under "${OWNER_HEADING}" must be a GitHub login, got "${value}"`);
  return value;
}

/** The tag that marks where development starts for one spec. */
export const startTagOf = (alias: string): string => `dev-start/${assertAlias(alias)}`;
