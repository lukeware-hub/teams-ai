/** The header lines every plan starts with, after its title. */
const HEADER = ['**Goal:**', '**Architecture:**', '**Tech Stack:**', '**Spec:**'];
/** The sections every plan has. */
const SECTIONS = ['## Global Constraints', '## Review Focus', '## Assumptions'];
/** Capitalised markers a finished plan never keeps; case matters, so the Portuguese word "todo" is not one. */
const MARKER = /\b(TBD|TODO|FIXME)\b/;
/** Phrases a finished plan never keeps. */
const PHRASE = /\b(handle edge cases|add appropriate|write tests for the above|similar to task|implement later|fill in details|to be determined)\b/i;
const OPEN_MARKER = '[NEEDS CLARIFICATION';
const CRITERIA_LABEL = '**Criteria:**';

interface TaskBlock {
  number: string;
  lines: string[];
}

/** The `### Task N:` blocks of a plan, each with the lines under its heading up to the next heading. */
function taskBlocks(lines: readonly string[]): TaskBlock[] {
  const blocks: TaskBlock[] = [];
  let open: TaskBlock | null = null;
  for (const line of lines) {
    const heading = /^### Task (\d+):/.exec(line);
    if (heading) {
      open = { number: heading[1]!, lines: [] };
      blocks.push(open);
    } else if (/^#{1,3} /.test(line)) {
      open = null;
    } else if (open) {
      open.lines.push(line);
    }
  }
  return blocks;
}

/** The criterion ids a **Criteria:** line names: every word that starts like an id, so a connecting word such as "e" is not one. */
const criteriaIn = (line: string): string[] =>
  line.slice(CRITERIA_LABEL.length).replace(/[`*]/g, '').split(/[\s,;]+/).map((id) => id.replace(/\.$/, '')).filter((id) => id.startsWith('AC-'));

/** The bullets under ## Assumptions. */
function assumptionBullets(lines: readonly string[]): string[] {
  const start = lines.findIndex((line) => line.trim() === '## Assumptions');
  if (start === -1) return [];
  const bullets: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3} /.test(line)) break;
    if (line.startsWith('- ')) bullets.push(line);
  }
  return bullets;
}

/** The placeholder text and open markers a finished document never keeps, line by line. */
export function placeholderIssues(lines: readonly string[]): string[] {
  return lines.flatMap((line, index) => [
    ...(MARKER.test(line) || PHRASE.test(line) ? [`line ${index + 1} has placeholder text: ${line.trim()}`] : []),
    ...(line.includes(OPEN_MARKER) ? [`line ${index + 1} still has an open [NEEDS CLARIFICATION] marker`] : []),
  ]);
}

/** The criterion ids each task of a plan delivers, by task number. */
export function planCriteriaByTask(text: string): Map<string, string[]> {
  return new Map(taskBlocks(text.split('\n')).map((task) => [task.number, task.lines.filter((line) => line.startsWith(CRITERIA_LABEL)).flatMap(criteriaIn)]));
}

/** What is wrong with a plan against its spec's acceptance criteria; an empty list means the plan passes. */
export function planShapeIssues(text: string, criteria: readonly string[], repository?: string): string[] {
  const lines = text.split('\n');
  const issues: string[] = [];
  if (repository !== undefined && !lines.some((line) => line.trim() === `**Repository:** ${repository}`)) issues.push(`the header has no **Repository:** ${repository} line`);
  if (!(lines.find((line) => line.trim() !== '') ?? '').startsWith('# ')) issues.push('the first line must be the title, starting with "# "');
  for (const label of HEADER) if (!lines.some((line) => line.startsWith(label))) issues.push(`the header has no ${label} line`);
  for (const section of SECTIONS) if (!lines.some((line) => line.trim() === section)) issues.push(`the plan has no "${section}" section`);

  const tasks = taskBlocks(lines);
  if (tasks.length === 0) issues.push('the plan has no task: add at least one "### Task N: <name>" block');
  const numbers = tasks.map((task) => task.number);
  if (new Set(numbers).size !== numbers.length) issues.push('two tasks share a number');
  const named: string[] = [];
  for (const task of tasks) {
    if (!task.lines.some((line) => line.startsWith('**Files:**'))) issues.push(`Task ${task.number} has no **Files:** line`);
    const criteriaLine = task.lines.find((line) => line.startsWith(CRITERIA_LABEL));
    if (criteriaLine === undefined) issues.push(`Task ${task.number} has no **Criteria:** line`);
    else named.push(...criteriaIn(criteriaLine));
  }
  for (const id of new Set(named)) if (!criteria.includes(id)) issues.push(`criterion ${id} is not in the spec`);
  for (const id of criteria) if (!named.includes(id)) issues.push(`criterion ${id} is in no task's **Criteria:** line`);

  issues.push(...placeholderIssues(lines));
  for (const bullet of assumptionBullets(lines)) {
    if (!/Reason:/i.test(bullet) && !/^- none\.?$/i.test(bullet.trim())) issues.push(`an assumption has no Reason: ${bullet.trim()}`);
  }
  return issues;
}
