import { promises as fs } from 'node:fs';
import path from 'node:path';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import { Project } from '../contracts/project.js';
import { Spec } from '../contracts/spec.js';
import { stepId } from '../core/ids.js';
import type { Exec } from '../exec/command.js';
import { fetch as gitFetch, git } from '../git/git.js';
import type { Workspace } from '../orchestrator/workspace.js';

export interface Draft {
  projectId: string;
  specId: string;
  root: string;
  docs: string;
  projectMd: string;
  projectJson: string;
  briefMd: string;
  stackMd: string;
  flowMd: string;
  specJson: string;
  events: string;
  steps: (seq: number) => string;
}
export type DocFile = 'project.md' | 'brief.md' | 'stack.md' | 'flow.md';

export const DOC_REL: Record<DocFile, (specId: string) => string> = {
  'project.md': () => 'docs/project.md',
  'brief.md': (specId) => `docs/specs/${specId}/brief.md`,
  'stack.md': () => 'docs/stack.md',
  'flow.md': () => 'docs/flow.md',
};

/** Spec (refinement) §2: the draft lives beside the workspace, never inside the clone. */
export function draftPaths(ws: Workspace, specId: string): Draft {
  const root = path.posix.join(ws.root, 'refine', specId);
  const docs = path.posix.join(root, 'docs');
  return {
    projectId: ws.projectId,
    specId,
    root,
    docs,
    projectMd: path.posix.join(docs, 'project.md'),
    projectJson: path.posix.join(docs, 'project.json'),
    briefMd: path.posix.join(docs, 'specs', specId, 'brief.md'),
    stackMd: path.posix.join(docs, 'stack.md'),
    flowMd: path.posix.join(docs, 'flow.md'),
    specJson: path.posix.join(docs, 'specs', specId, 'spec.json'),
    events: path.posix.join(root, 'events.ndjson'),
    steps: (seq) => path.posix.join(root, 'steps', stepId(seq)),
  };
}

export const docPath = (d: Draft, file: DocFile): string => ({ 'project.md': d.projectMd, 'brief.md': d.briefMd, 'stack.md': d.stackMd, 'flow.md': d.flowMd })[file];

export function projectTemplate(name: string): string {
  return `# ${name}\n\n## Vision\n\n<what the product is and why it exists>\n\n## Personas\n\n- <name>: <who they are and what they need>\n\n## Constraints\n\n- <free-text constraint>\n\n## Stack\n\n<optional; leave empty to let the Dev choose>\n\n## Principles\n\n- <non-negotiable rule every agent follows>\n\n## Deploy target\n\ndocker-local\n\n## GitHub owner\n\n<optional override of config.json github.owner>\n`;
}

export function briefTemplate(): string {
  return `## Objectives\n\n- <objective>\n\n## Features\n\n- <feature>\n\n## Acceptance criteria\n\n- AC-001 (smoke): Given <state>, when <action>, then <outcome>\n\n## Out of scope\n\n- <item>\n\n## External dependencies\n\n- <name>: <purpose> (secrets: <NAME>)\n\n## Tasks\n\n<optional; one "- title: description" per line>\n`;
}

export function stackTemplate(): string {
  return `# Stack\n\n## Runtime\n\n- <runtime and language>\n\n## Frameworks\n\n- <framework or library>\n\n## Storage\n\n- <database or file storage>\n\n## Tooling\n\n- <build, test, and deployment tools>\n`;
}

export function flowTemplate(): string {
  return `# Application flow\n\n\`\`\`mermaid\nflowchart TD\n  A[Start] --> B[Configure Claude and GitHub]\n  B --> C[Create or open project]\n  C --> D[Edit project.md]\n  D --> E[Edit briefing.md]\n  E --> F[Define stack.md]\n  F --> G[Define flow.md]\n  G --> H[Evaluate with Claude]\n  H --> I[Derive project and spec JSON]\n  I --> J[PO and SM review]\n  J --> K{Questions pending?}\n  K -- Yes --> L[Answer or skip question]\n  L --> H\n  K -- No --> M{Patches pending?}\n  M -- Yes --> N[Accept or reject patch]\n  N --> H\n  M -- No --> O{Checklist green?}\n  O -- No --> D\n  O -- Yes --> P[Start implementation run]\n  P --> Q[Execute tasks and verification]\n  Q --> R[Review evidence]\n  R --> S[Merge or fix] \n  S --> T[Deploy locally]\n\`\`\`\n`;
}

const list = (items: readonly string[]) => (items.length === 0 ? '- (none)' : items.map((i) => `- ${i}`).join('\n'));

export function renderProjectMd(p: Project): string {
  return [
    `# ${p.name}`, '', '## Vision', '', p.vision, '', '## Personas', '', list(p.personas.map((x) => `${x.name}: ${x.description}`)), '',
    '## Constraints', '', list(p.constraints), '', '## Stack', '', p.stack ?? '', '', '## Principles', '', list(p.principles), '',
    '## Deploy target', '', p.deploy.target, '', '## GitHub owner', '', p.github.owner ?? '', '',
  ].join('\n');
}

export function renderBriefMd(s: Spec, validationReport?: string): string {
  const acs = s.acceptanceCriteria.map((c) => `- ${c.id}${c.smoke ? ' (smoke)' : ''}: Given ${c.given}, when ${c.when}, then ${c.then}`);
  const deps = s.externalDependencies.map((d) => `${d.name}: ${d.purpose} (secrets: ${d.secretNames.join(', ') || 'none'})`);
  const tasks = (s.tasks ?? []).map((t) => `${t.title}: ${t.description}`);
  const parts = [
    '## Objectives', '', list(s.objectives), '', '## Features', '', list(s.features), '', '## Acceptance criteria', '', acs.join('\n') || '- (none)', '',
    '## Out of scope', '', list(s.outOfScope), '', '## External dependencies', '', list(deps), '', '## Tasks', '', list(tasks), '',
  ];
  if (validationReport) parts.push('## Validation report', '', validationReport, '');
  return parts.join('\n');
}

export const draftExists = (d: Draft): Promise<boolean> => fs.access(d.briefMd).then(() => true, () => false);

export async function createNewProject(d: Draft, name: string): Promise<void> {
  await fs.mkdir(path.dirname(d.briefMd), { recursive: true });
  await fs.writeFile(d.projectMd, projectTemplate(name));
  await fs.writeFile(d.briefMd, briefTemplate());
  await fs.writeFile(d.stackMd, stackTemplate());
  await fs.writeFile(d.flowMd, flowTemplate());
}

export async function createFromRepo(d: Draft, repo: string, exec: Exec, mode: { kind: 'new-spec' } | { kind: 'continue'; report?: string }): Promise<void> {
  await gitFetch(repo, exec);
  const files = (await git(repo, ['ls-tree', '-r', '--name-only', 'origin/main', 'docs/'], exec)).split('\n').filter((f) => f !== '');
  for (const rel of files) {
    const target = path.posix.join(d.root, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await git(repo, ['show', `origin/main:${rel}`], exec));
  }
  await fs.mkdir(path.dirname(d.briefMd), { recursive: true });
  if (!files.includes('docs/stack.md')) await fs.writeFile(d.stackMd, stackTemplate());
  if (!files.includes('docs/flow.md')) await fs.writeFile(d.flowMd, flowTemplate());
  if (!files.includes('docs/project.md')) {
    const project = Project.parse(JSON.parse(await fs.readFile(d.projectJson, 'utf8')));
    await fs.writeFile(d.projectMd, renderProjectMd(project));
  }
  if (mode.kind === 'new-spec') {
    await fs.writeFile(d.briefMd, briefTemplate());
    return;
  }
  const spec = Spec.parse(JSON.parse(await fs.readFile(d.specJson, 'utf8')));
  await fs.writeFile(d.briefMd, renderBriefMd(spec, mode.report));
  await fs.writeFile(d.specJson, JSON.stringify({ ...spec, status: 'refining', specHash: null }, null, 2));
}

export const readDoc = (d: Draft, file: DocFile): Promise<string> => fs.readFile(docPath(d, file), 'utf8');
export const writeDoc = (d: Draft, file: DocFile, text: string): Promise<void> => fs.writeFile(docPath(d, file), text);

export async function readDerived(d: Draft): Promise<{ project: Project; spec: Spec } | null> {
  const read = (f: string) => fs.readFile(f, 'utf8').then(JSON.parse, () => null);
  const [p, s] = await Promise.all([read(d.projectJson), read(d.specJson)]);
  if (p === null || s === null) return null;
  return { project: Project.parse(p), spec: Spec.parse(s) };
}

export async function writeDerived(d: Draft, v: { project: Project; spec: Spec }): Promise<void> {
  await fs.writeFile(d.projectJson, JSON.stringify(v.project, null, 2));
  await fs.writeFile(d.specJson, JSON.stringify(v.spec, null, 2));
}

export async function draftHash(d: Draft): Promise<string> {
  const [project, brief, stack, flow] = await Promise.all([readDoc(d, 'project.md'), readDoc(d, 'brief.md'), readDoc(d, 'stack.md'), readDoc(d, 'flow.md')]);
  return sha256(canonicalJson({ project, brief, stack, flow }));
}
