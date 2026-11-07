/** The documentation gate of the docs tree: every file exists with content or says why it does not apply, and the tasks are documented. */
import { posix } from 'node:path';
import { APP_FOLDER, APP_KINDS, DOCS_TREE, type AppKind } from '../docs/tree.js';
import { checkSections, documentedEndpoints, featureEndpoints, MIN_SECTION_CHARS, missingReadmeSections, README_SECTIONS, RUNBOOK_SECTIONS } from './docs.js';

const NOT_APPLICABLE = /^não se aplica:\s*\S.{9,}/i;
const LINK = /\]\(([^)\s]+)\)/g;
const RUNBOOK = 'docs/06-infra-e-deploy/runbooks/operacao.md';
/** The file each standard section must head: run, test, environment, architecture, pipeline and the runbook. */
const SECTION_FILE: Record<string, string> = {
  run: 'docs/01-onboarding/setup-ambiente.md',
  env: 'docs/01-onboarding/docker-local.md',
  test: 'docs/02-padroes/testes.md',
  architecture: 'docs/00-visao-geral/arquitetura.md',
  pipeline: 'docs/06-infra-e-deploy/ci-cd.md',
  start: RUNBOOK,
  stop: RUNBOOK,
  logs: RUNBOOK,
  rollback: RUNBOOK,
};
const STANDARD: Record<string, RegExp> = { ...README_SECTIONS, ...RUNBOOK_SECTIONS };

export interface DocsTreeInput {
  /** Every file under docs/ of the checkout after the answer, keyed by its repository path. */
  files: ReadonlyMap<string, string>;
  /** The files under docs/ on main before the answer, for the endpoints they already name. */
  current?: ReadonlyMap<string, string>;
  /** The kinds of application the repository holds; the others must say "Não se aplica". */
  kinds: readonly AppKind[];
  /** The tasks the spec delivered, and the tasks the answer names in its files. */
  delivered: readonly string[];
  covered: readonly string[];
  features: readonly string[];
  readmeSections?: readonly string[];
}

const kindOf = (path: string): AppKind | undefined => APP_KINDS.find((kind) => path.startsWith(`docs/${APP_FOLDER[kind]}/`));
const filled = (text: string): boolean => text.trim().length >= MIN_SECTION_CHARS;
const notApplicable = (text: string): boolean => NOT_APPLICABLE.test(text.trim());
const under = (files: ReadonlyMap<string, string>, prefix: string): string[] => [...files].filter(([path]) => path.startsWith(prefix)).map(([, text]) => text);

/** A file of a kind the repository does not hold says only why it does not apply; a file of a held kind has content or says why not. */
function contentErrors(path: string, text: string, kinds: readonly AppKind[]): string[] {
  const kind = kindOf(path);
  if (kind && !kinds.includes(kind)) return notApplicable(text) ? [] : [`${path} documents ${kind}, which this repository does not hold: write "Não se aplica: <motivo>"`];
  return filled(text) || notApplicable(text) ? [] : [`${path} is empty (at least ${MIN_SECTION_CHARS} characters, or "Não se aplica: <motivo>")`];
}

/** A relative link must point at a file or at a folder that holds one. */
function linkErrors(path: string, text: string, files: ReadonlyMap<string, string>): string[] {
  if (!path.endsWith('.md')) return [];
  return [...text.matchAll(LINK)]
    .map((m) => m[1]!)
    .filter((link) => !/^([a-z]+:|#|\/)/i.test(link))
    .filter((link) => {
      const target = posix.normalize(posix.join(posix.dirname(path), link.split('#')[0]!)).replace(/\/+$/, '');
      return !files.has(target) && ![...files.keys()].some((key) => key.startsWith(`${target}/`));
    })
    .map((link) => `${path} links to ${link}, which does not exist`);
}

function sectionErrors(files: ReadonlyMap<string, string>): string[] {
  const byFile = new Map<string, string[]>();
  for (const [key, file] of Object.entries(SECTION_FILE)) byFile.set(file, [...(byFile.get(file) ?? []), key]);
  return [...byFile].flatMap(([file, keys]) => checkSections(files.get(file) ?? '', file, Object.fromEntries(keys.map((key) => [key, STANDARD[key]!]))));
}

function endpointErrors(input: DocsTreeInput): string[] {
  if (!input.kinds.includes('api')) return [];
  const api = under(input.files, 'docs/03-api/').join('\n');
  const endpoints = featureEndpoints(input.features);
  const before = input.current ? under(input.current, 'docs/03-api/').join('\n') : '';
  return [
    ...endpoints.filter((endpoint) => !api.includes(endpoint)).map((endpoint) => `docs/03-api does not document endpoint ${endpoint}`),
    ...documentedEndpoints(before).filter((endpoint) => !endpoints.includes(endpoint) && !api.includes(endpoint)).map((endpoint) => `docs/03-api dropped endpoint ${endpoint}, which it documented before; keep it, or mark it as removed if this spec removed it`),
  ];
}

/** Every error of the docs tree, in the words the agent reads back; an empty list passes. */
export function validateDocsTree(input: DocsTreeInput): string[] {
  const { files, kinds } = input;
  const text = [...files.values()].join('\n');
  return [
    ...[...files].flatMap(([path, body]) => contentErrors(path, body, kinds)),
    ...DOCS_TREE.filter((path) => !path.endsWith('/') && !files.has(path)).map((path) => `${path} is missing`),
    ...DOCS_TREE.filter((path) => path.endsWith('/') && under(files, path).length === 0).map((path) => `${path} holds no file`),
    ...[...files].flatMap(([path, body]) => linkErrors(path, body, files)),
    ...sectionErrors(files),
    ...missingReadmeSections(text, input.readmeSections ?? []).map((section) => `the plan requires a "${section}" section, which no document heads`),
    ...input.delivered.filter((id) => !input.covered.includes(id)).map((id) => `task ${id} has no documentation`),
    ...endpointErrors(input),
  ];
}
