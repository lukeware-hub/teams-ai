import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJson, sha256 } from '../contracts/hash.js';
import { Project } from '../contracts/project.js';
import { Spec } from '../contracts/spec.js';
import { stepId } from '../core/ids.js';
import type { Exec } from '../exec/command.js';
import { fetch as gitFetch, git, showFile } from '../git/git.js';
import { mergeDoc, sameDoc } from '../git/merge-doc.js';
import type { Workspace } from '../orchestrator/workspace.js';
import type { ReportRouting } from '../decide/decisions/report-routing.js';

export type RouteReport = (criteria: Spec['acceptanceCriteria'], report: string, confidential: boolean) => Promise<ReportRouting | null>;

export interface Draft {
  projectId: string;
  specId: string;
  root: string;
  docs: string;
  projectMd: string;
  projectJson: string;
  briefMd: string;
  /** Backlog mode: the target project's briefing, one hand-edited file for the whole project. */
  briefingMd?: string;
  stackMd: string;
  flowMd: string;
  designMd?: string;
  specJson: string;
  /** The docs as a new or continued spec received them; absent on a new project. */
  base?: string;
  events: string;
  steps: (seq: number) => string;
}
export type DocFile = 'project.md' | 'brief.md' | 'stack.md' | 'flow.md' | 'design.md';

export const BRIEFING_REL = 'docs/briefing.md';

/** `brief.md` is the briefing: the draft's own file for one spec, or the target project's `docs/briefing.md` in backlog mode. */
export const DOC_REL: Record<DocFile, (specId: string, projectBriefing?: boolean) => string> = {
  'project.md': () => 'docs/project.md',
  'brief.md': (specId, projectBriefing = false) => (projectBriefing ? BRIEFING_REL : `docs/specs/${specId}/brief.md`),
  'stack.md': () => 'docs/stack.md',
  'flow.md': () => 'docs/flow.md',
  'design.md': () => 'docs/design.md',
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
    briefingMd: path.posix.join(docs, 'briefing.md'),
    stackMd: path.posix.join(docs, 'stack.md'),
    flowMd: path.posix.join(docs, 'flow.md'),
    designMd: path.posix.join(docs, 'design.md'),
    specJson: path.posix.join(docs, 'specs', specId, 'spec.json'),
    base: path.posix.join(root, '.base', 'docs'),
    events: path.posix.join(root, 'events.ndjson'),
    steps: (seq) => path.posix.join(root, 'steps', stepId(seq)),
  };
}

export const docPath = (d: Draft, file: DocFile): string => ({ 'project.md': d.projectMd, 'brief.md': d.briefMd, 'stack.md': d.stackMd, 'flow.md': d.flowMd, 'design.md': d.designMd ?? path.posix.join(d.docs, 'design.md') })[file];

export function projectTemplate(name: string): string {
  return `# ${name}\n\n## Vision\n\n<what the product is and why it exists>\n\n## Personas\n\n- <name>: <who they are and what they need>\n\n## Constraints\n\n- <free-text constraint>\n\n## Stack\n\n<optional; leave empty to let the Dev choose>\n\n## Principles\n\n- <non-negotiable rule every agent follows>\n\n## Deploy target\n\ndocker-local\n\n## GitHub owner\n\n<optional override of config.json github.owner>\n`;
}

export function briefTemplate(): string {
  return `## Type\n\nfeature\n\n## Objectives\n\n- <objective>\n\n## Features\n\n- <feature>\n\n## Acceptance criteria\n\n- AC-001 (smoke): Given <state>, when <action>, then <outcome>\n\n## Out of scope\n\n- <item>\n\n## External dependencies\n\n- <name>: <purpose> (secrets: <NAME>)\n\n## Bug details\n\n- Actual: <required only for bugs>\n- Expected: <required only for bugs>\n- Reproduction: <required only for bugs>\n- Evidence: <optional>\n\n## Tasks\n\n<optional; one "- title: description" per line>\n`;
}

export function stackTemplate(): string {
  return `# Stack\n\n## Runtime\n\n- <runtime and language>\n\n## Frameworks\n\n- <framework or library>\n\n## Storage\n\n- <database or file storage>\n\n## Tooling\n\n- <build, test, and deployment tools>\n`;
}

export function flowTemplate(): string {
  return `# Application flow\n\n\`\`\`mermaid\nflowchart TD\n  A[Start] --> B[Configure Claude and GitHub]\n  B --> C[Create or open project]\n  C --> D[Edit project.md]\n  D --> E[Edit briefing.md]\n  E --> F[Define stack.md]\n  F --> G[Define flow.md]\n  G --> H[Evaluate with Claude]\n  H --> I[Derive project and spec JSON]\n  I --> J[PO and SM review]\n  J --> K{Questions pending?}\n  K -- Yes --> L[Answer or skip question]\n  L --> H\n  K -- No --> M{Patches pending?}\n  M -- Yes --> N[Accept or reject patch]\n  N --> H\n  M -- No --> O{Checklist green?}\n  O -- No --> D\n  O -- Yes --> P[Start implementation run]\n  P --> Q[Execute tasks and verification]\n  Q --> R[Review evidence]\n  R --> S[Merge or fix] \n  S --> T[Deploy locally]\n\`\`\`\n`;
}

export function designTemplate(): string {
  return `# Design\n\n> This file is the executable visual contract. The Front agent owns its review and edits.\n\n## Brand and direction\n\n- Audience: <who this is for>\n- Product character: <specific visual language, not generic adjectives>\n- Signature: <one memorable design decision>\n- Avoid: <AI tells, visual patterns, or references that do not belong>\n\n## Foundations\n\n### Color tokens\n\n| Token | Value | Usage | Contrast / exception |\n|---|---|---|---|\n| color.bg | <hex> | page background | <rule> |\n| color.surface | <hex> | surfaces | <rule> |\n| color.ink | <hex> | primary text | <rule> |\n| color.muted | <hex> | secondary text | <rule> |\n| color.accent | <hex> | primary action | <rule> |\n| color.success | <hex> | success state | <rule> |\n| color.warning | <hex> | warning state | <rule> |\n| color.danger | <hex> | error state | <rule> |\n\n### Typography\n\n- Families: <display>, <body>, <mono if needed>\n- Scale: <named sizes, weights, line-heights, tracking>\n- Rules: <sentence case, max line length, hierarchy>\n\n### Spacing, shape, elevation\n\n- Base unit and scale: <values>\n- Containers and grid: <max width, columns, gutters>\n- Radii and borders: <values and usage>\n- Elevation: <shadow tokens and layering rules>\n\n## Responsive composition\n\n- Breakpoints: <mobile, tablet, desktop values and rationale>\n- Web: <layout and input behavior>\n- Mobile: <layout, orientation, touch target and safe-area behavior>\n- States: <loading, empty, error, offline, success>\n\n## Components and patterns\n\n- Buttons: <anatomy, variants, sizes, disabled/loading/focus>\n- Forms: <labels, validation, errors, keyboard and autofill>\n- Navigation: <desktop/mobile behavior>\n- Surfaces: <when to use cards, panels, lists, tables>\n- Feedback: <toast, dialog, inline, confirmation>\n\n## Interaction and motion\n\n- Feedback: <what changes immediately after each action>\n- Motion: <durations, easing/spring, purpose, interruptibility>\n- Reduced motion: <static alternatives>\n\n## Accessibility and content\n\n- Semantics and focus: <landmarks, heading order, visible focus>\n- Contrast and targets: <minimums and touch sizes>\n- Copy: <plain language, action labels, error/empty guidance>\n- Icons and assets: <source, sizing, alt text, no fake screenshots>\n\n## Implementation contract\n\n- <CSS/component token mapping and examples>\n- <tests or screenshots required before approval>\n`;
}

const list = (items: readonly string[]) => (items.length === 0 ? '- (none)' : items.map((i) => `- ${i}`).join('\n'));

export function renderProjectMd(p: Project): string {
  return [
    `# ${p.name}`, '', '## Vision', '', p.vision, '', '## Personas', '', list(p.personas.map((x) => `${x.name}: ${x.description}`)), '',
    '## Constraints', '', list(p.constraints), '', '## Stack', '', p.stack ?? '', '', '## Principles', '', list(p.principles), '',
    '## Deploy target', '', p.deploy.target, '', '## GitHub owner', '', p.github.owner ?? '', '',
  ].join('\n');
}

export function renderBriefMd(s: Spec, validationReport?: string, routing?: ReportRouting | null): string {
  const acs = s.acceptanceCriteria.map((c) => `- ${c.id}${c.smoke ? ' (smoke)' : ''}: Given ${c.given}, when ${c.when}, then ${c.then}`);
  const deps = s.externalDependencies.map((d) => `${d.name}: ${d.purpose} (secrets: ${d.secretNames.join(', ') || 'none'})`);
  const tasks = (s.tasks ?? []).map((t) => `${t.title}: ${t.description}`);
  const bug = s.bug ? [
    `- Actual: ${s.bug.actual}`,
    `- Expected: ${s.bug.expected}`,
    `- Reproduction: ${s.bug.reproduction}`,
    ...(s.bug.evidence ? [`- Evidence: ${s.bug.evidence}`] : []),
  ] : ['- (not applicable)'];
  const parts = [
    '## Type', '', s.type, '', '## Objectives', '', list(s.objectives), '', '## Features', '', list(s.features), '', '## Acceptance criteria', '', acs.join('\n') || '- (none)', '',
    '## Out of scope', '', list(s.outOfScope), '', '## External dependencies', '', list(deps), '', '## Bug details', '', bug.join('\n'), '', '## Tasks', '', list(tasks), '',
  ];
  if (validationReport) parts.push('## Validation report', '', validationReport, '');
  if (validationReport && routing) {
    // Spec 10A.5 decision 7: a hint for PO and SM, never a verdict; `unclear` asks the human.
    const confidence = routing.confidence === null ? '' : ` (${routing.confidence.toFixed(2)})`;
    parts.push(`Routing (System 1, ${routing.source}): ${routing.route}${confidence}`, '');
    if (routing.route === 'unclear') parts.push('PO: ask the human what the report means before patching the spec.', '');
  }
  return parts.join('\n');
}

const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false);
const briefingPath = (d: Draft): string => d.briefingMd ?? path.posix.join(d.docs, 'briefing.md');

/** The briefing a draft edits: its own brief.md for one spec, else the target project's docs/briefing.md (backlog mode). */
async function briefPath(d: Draft): Promise<string> {
  return (await exists(d.briefMd)) || !(await exists(briefingPath(d))) ? d.briefMd : briefingPath(d);
}

export const draftExists = async (d: Draft): Promise<boolean> => (await exists(d.briefMd)) || exists(briefingPath(d));

/**
 * Backlog mode: the draft's brief becomes the target project's `docs/briefing.md`, so the five docs live together and a
 * later session continues from the same file. An existing briefing is kept and the draft's own demand is appended under
 * its heading (a bare template adds nothing). Idempotent: reopening a session finishes a move a crash cut short.
 */
/** Shifts every markdown heading in `text` down one level, so an appended brief's own sections (## Type, ## Objectives...)
 * never collide with the target briefing's own `##` structure once they sit under its "## Nova demanda" heading. */
function demoteHeadings(text: string): string {
  return text
    .split('\n')
    .map((line) => (/^#{1,5} /.test(line) ? `#${line}` : line))
    .join('\n');
}

export async function moveBriefingToProject(d: Draft): Promise<void> {
  const brief = await fs.readFile(d.briefMd, 'utf8').catch(() => null);
  if (brief !== null) {
    const briefing = await fs.readFile(briefingPath(d), 'utf8').catch(() => null);
    const demoted = demoteHeadings(brief.trim());
    if (briefing === null) await fs.rename(d.briefMd, briefingPath(d));
    else if (brief.trim() !== briefTemplate().trim() && !briefing.includes(demoted)) {
      await fs.writeFile(briefingPath(d), withNewline(`${briefing.trimEnd()}\n\n## Nova demanda (${d.specId})\n\n${demoted}`));
    }
  }
  // Only the single-spec files go; anything else in the spec directory stays, and the directory goes once empty.
  await fs.rm(d.briefMd, { force: true });
  await fs.rm(d.specJson, { force: true });
  await fs.rmdir(path.posix.dirname(d.briefMd)).catch(() => undefined);
}

export const MAX_DESCRIPTION = 20_000;

/** The text the user wrote when creating a project or a spec: trimmed, and refused when it is too long to be a brief. */
export function cleanDescription(text: string | undefined): string {
  const t = (text ?? '').trim();
  if (t.length > MAX_DESCRIPTION) throw new RangeError(`description must have at most ${MAX_DESCRIPTION} characters`);
  return t;
}

/** The description goes on top of the brief, where the user sees it first and PO and SM read it with the rest. */
const briefWith = (description: string): string => (description === '' ? briefTemplate() : `## Description

${description}

${briefTemplate()}`);

export async function createNewProject(d: Draft, name: string, description = ''): Promise<void> {
  await fs.mkdir(path.dirname(d.briefMd), { recursive: true });
  await fs.writeFile(d.projectMd, projectTemplate(name));
  await fs.writeFile(d.briefMd, briefWith(cleanDescription(description)));
  await fs.writeFile(d.stackMd, stackTemplate());
  await fs.writeFile(d.flowMd, flowTemplate());
  await fs.writeFile(docPath(d, 'design.md'), designTemplate());
}

/** Every file under docs/ on main, as `docs/...` paths. */
const mainDocFiles = async (repo: string, exec: Exec): Promise<string[]> =>
  (await git(repo, ['ls-tree', '-r', '--name-only', 'origin/main', 'docs/'], exec)).split('\n').filter((f) => f !== '');

export async function createFromRepo(d: Draft, repo: string, exec: Exec, mode: { kind: 'new-spec'; description?: string } | { kind: 'continue'; report?: string; route?: RouteReport }): Promise<void> {
  await gitFetch(repo, exec);
  const files = await mainDocFiles(repo, exec);
  for (const rel of files) {
    const target = path.posix.join(d.root, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await showFile(repo, 'origin/main', rel, exec));
  }
  await fs.mkdir(path.dirname(d.briefMd), { recursive: true });
  if (!files.includes('docs/stack.md')) await fs.writeFile(d.stackMd, stackTemplate());
  if (!files.includes('docs/flow.md')) await fs.writeFile(d.flowMd, flowTemplate());
  if (!files.includes('docs/design.md')) await fs.writeFile(docPath(d, 'design.md'), designTemplate());
  if (!files.includes('docs/project.md')) {
    const project = Project.parse(JSON.parse(await fs.readFile(d.projectJson, 'utf8')));
    await fs.writeFile(d.projectMd, renderProjectMd(project));
  }
  // The docs as the session received them: the start publishes only what differs from this copy.
  await fs.cp(d.docs, d.base!, { recursive: true });
  if (mode.kind === 'new-spec') {
    await fs.writeFile(d.briefMd, briefWith(cleanDescription(mode.description)));
    return;
  }
  const spec = Spec.parse(JSON.parse(await fs.readFile(d.specJson, 'utf8')));
  let routing: ReportRouting | null = null;
  if (mode.report && mode.route) {
    const project = Project.parse(JSON.parse(await fs.readFile(d.projectJson, 'utf8')));
    routing = await mode.route(spec.acceptanceCriteria, mode.report, project.confidential);
  }
  await fs.writeFile(d.briefMd, renderBriefMd(spec, mode.report, routing));
  await fs.writeFile(d.specJson, JSON.stringify({ ...spec, status: 'refining', specHash: null }, null, 2));
}

export async function readDoc(d: Draft, file: DocFile): Promise<string> {
  try {
    return await fs.readFile(file === 'brief.md' ? await briefPath(d) : docPath(d, file), 'utf8');
  } catch (err) {
    // Older drafts predate design.md; treat the new contract as its migration default.
    if (file === 'design.md' && (err as NodeJS.ErrnoException).code === 'ENOENT') return designTemplate();
    throw err;
  }
}
/** Docs end with a newline: they are copied verbatim into the project repo, where a format gate will check them. */
const withNewline = (text: string): string => (text.endsWith('\n') ? text : `${text}\n`);
export const writeDoc = async (d: Draft, file: DocFile, text: string): Promise<void> => fs.writeFile(file === 'brief.md' ? await briefPath(d) : docPath(d, file), withNewline(text));

/** A file of the base copy, or null when the draft has no base or the file was not in it. */
export const readBase = (d: Draft, rel: string): Promise<string | null> =>
  d.base ? fs.readFile(path.posix.join(d.base, rel), 'utf8').catch(() => null) : Promise.resolve(null);

/** The project docs: a change main brings to one of them makes a derived spec stale. Other specs' files are not. */
const PROJECT_DOCS = new Set(['project.md', 'project.json', 'briefing.md', 'stack.md', 'flow.md', 'design.md']);

/**
 * Before a start: what main changed since the draft began comes into the draft, merged with the draft's own edits, and the
 * base copy moves to main, so Phase 0 publishes only this spec's changes. Returns the project docs it changed.
 */
export async function syncWithMain(d: Draft, repo: string, exec: Exec): Promise<Array<{ file: string; hash: string }>> {
  if (!d.base || !(await fs.access(d.base).then(() => true, () => false))) return []; // a new project: main does not exist yet
  await gitFetch(repo, exec);
  const own = `specs/${d.specId}/`;
  const changed: Array<{ file: string; hash: string }> = [];
  for (const rel of (await mainDocFiles(repo, exec)).map((f) => f.slice('docs/'.length)).filter((f) => !f.startsWith(own))) {
    const main = await showFile(repo, 'origin/main', `docs/${rel}`, exec);
    const base = await readBase(d, rel);
    if (sameDoc(main, base)) continue;
    const file = path.posix.join(d.docs, rel);
    const draft = await fs.readFile(file, 'utf8').catch(() => null);
    // Without a base copy the doc is new on main, and Phase 0 would keep main's copy anyway.
    const next = draft === null || base === null || sameDoc(draft, base) ? main : await mergeDoc(rel, base, main, draft, exec);
    for (const [target, text] of [[file, next], [path.posix.join(d.base, rel), main]] as const) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, text);
    }
    if (PROJECT_DOCS.has(rel) && !sameDoc(next, draft)) changed.push({ file: rel, hash: sha256(next) });
  }
  return changed;
}

/** In an existing project, project.json changes only when project.md changed. */
export async function keepBaseProject(d: Draft, derived: Project): Promise<Project> {
  const [baseJson, baseMd] = await Promise.all([readBase(d, 'project.json'), readBase(d, 'project.md')]);
  if (baseJson === null || baseMd === null) return derived;
  return (await fs.readFile(d.projectMd, 'utf8')) === baseMd ? Project.parse(JSON.parse(baseJson)) : derived;
}

export async function readDerived(d: Draft): Promise<{ project: Project; spec: Spec } | null> {
  const read = (f: string) => fs.readFile(f, 'utf8').then(JSON.parse, () => null);
  const [p, s] = await Promise.all([read(d.projectJson), read(d.specJson)]);
  if (p === null || s === null) return null;
  return { project: Project.parse(p), spec: Spec.parse(s) };
}

export async function writeDerived(d: Draft, v: { project: Project; spec: Spec }): Promise<void> {
  await writeProject(d, v.project);
  await fs.writeFile(d.specJson, withNewline(JSON.stringify(v.spec, null, 2)));
}

/** Backlog mode derives the project but no spec yet: project.json alone. */
/** An unchanged project keeps the base file's exact bytes, so the start does not see a reformatted copy as a change. */
export async function writeProject(d: Draft, project: Project): Promise<void> {
  const base = await readBase(d, 'project.json');
  const same = base !== null && isDeepStrictEqual(Project.parse(JSON.parse(base)), project);
  await fs.writeFile(d.projectJson, same ? base : withNewline(JSON.stringify(project, null, 2)));
}

/** `docs/specs.json`: the generated index of the backlog's specs (structure only; each spec keeps its own spec.json). */
export const writeSpecsIndex = (d: Draft, index: unknown): Promise<void> => fs.writeFile(path.posix.join(d.docs, 'specs.json'), withNewline(JSON.stringify(index, null, 2)));

export const writeBacklogMd = (d: Draft, text: string): Promise<void> => fs.writeFile(path.posix.join(d.docs, 'backlog.md'), withNewline(text));

export async function draftHash(d: Draft): Promise<string> {
  const [project, brief, stack, flow, design] = await Promise.all([readDoc(d, 'project.md'), readDoc(d, 'brief.md'), readDoc(d, 'stack.md'), readDoc(d, 'flow.md'), readDoc(d, 'design.md')]);
  return sha256(canonicalJson({ project, brief, stack, flow, design }));
}
