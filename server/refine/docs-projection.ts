import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Spec } from '../contracts/spec.js';
import { repoPath, type Style } from '../docs/layout.js';
import { renderRepoSpec } from '../docs/repo-spec.js';
import { DOC_STAGES } from './doc-stages.js';
import { readDoc, type Draft } from './draft.js';
import { planFileOf, taskFileOf } from './plan-file.js';

/** A spec of the draft whose folder is projected: its alias, and its repository for a microservice. */
export interface SpecAlias {
  alias: string;
  service?: string;
}

const readOptional = (file: string): Promise<string | null> => fs.readFile(file, 'utf8').catch(() => null);

/** The repository files of one alias folder: its spec, plan and task list, each only when the draft has it. */
async function aliasFiles(draft: Draft, style: Style, { alias, service }: SpecAlias): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  const json = await readOptional(path.posix.join(draft.docs, 'specs', alias, 'spec.json'));
  if (json !== null) found[repoPath(style, 'spec', alias, service)] = renderRepoSpec(Spec.parse(JSON.parse(json)));
  const plan = await readOptional(path.posix.join(draft.root, planFileOf(alias)));
  if (plan !== null) found[repoPath(style, 'plan', alias, service)] = plan;
  const task = await readOptional(path.posix.join(draft.root, taskFileOf(alias)));
  if (task !== null) found[repoPath(style, 'task', alias, service)] = task;
  return found;
}

/** The repository files of a draft: its five documents, then the spec, plan and task of each alias it owns. */
export async function projectDraftFiles(draft: Draft, style: Style, aliases: readonly SpecAlias[]): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const doc of DOC_STAGES) files[`docs/${doc}`] = await readDoc(draft, doc);
  for (const spec of aliases) Object.assign(files, await aliasFiles(draft, style, spec));
  return files;
}
