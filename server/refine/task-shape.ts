import { placeholderIssues, planCriteriaByTask } from './plan-shape.js';

/** The labels every task entry of task.md carries, each on its own line. */
const LABELS = ['**Spec:**', '**Plan:**', '**Repository:**', '**Objective:**', '**Criteria:**', '**Success scenario:**', '**Error scenario:**', '**Done when:**'];
const ENTRY = /^## Task (\d+):/;
const CRITERION = /AC-\d+/g;

interface Entry {
  number: string;
  lines: string[];
}

/** The `## Task N:` entries of a task list, each with the lines under its heading up to the next level-two heading. */
function entriesOf(lines: readonly string[]): Entry[] {
  const entries: Entry[] = [];
  let open: Entry | null = null;
  for (const line of lines) {
    const heading = ENTRY.exec(line);
    if (heading) {
      open = { number: heading[1]!, lines: [] };
      entries.push(open);
    } else if (/^## /.test(line)) {
      open = null;
    } else if (open) {
      open.lines.push(line);
    }
  }
  return entries;
}

/** The criterion ids a line names, each once, in the order they appear. */
const idsIn = (line: string | undefined): string[] => [...new Set(line?.match(CRITERION) ?? [])];

/** What is wrong with a task list against its plan and its spec; an empty list means it passes. */
export function taskShapeIssues(text: string, plan: string, criteria: readonly string[], repository?: string): string[] {
  const lines = text.split('\n');
  const issues: string[] = [];
  if (!(lines.find((line) => line.trim() !== '') ?? '').startsWith('# ')) issues.push('the first line must be the title, starting with "# "');
  const entries = entriesOf(lines);
  const planned = planCriteriaByTask(plan);
  const numbers = entries.map((entry) => entry.number);
  if (new Set(numbers).size !== numbers.length) issues.push('two task entries share a number');
  for (const number of planned.keys()) if (!numbers.includes(number)) issues.push(`plan task ${number} has no "## Task ${number}:" entry`);
  for (const number of numbers) if (!planned.has(number)) issues.push(`task.md has entry ${number}, which the plan does not have`);

  const cited: string[] = [];
  for (const entry of entries) {
    for (const label of LABELS) if (!entry.lines.some((line) => line.startsWith(label))) issues.push(`Task ${entry.number} has no ${label} line`);
    const repoLine = entry.lines.find((line) => line.startsWith('**Repository:**'));
    if (repository !== undefined && repoLine !== undefined && repoLine.trim() !== `**Repository:** ${repository}`) issues.push(`Task ${entry.number} names another repository than ${repository}`);
    const ids = idsIn(entry.lines.find((line) => line.startsWith('**Criteria:**')));
    cited.push(...ids);
    const delivered = planned.get(entry.number) ?? [];
    if (delivered.length > 0 && [...delivered].sort().join() !== [...ids].sort().join()) issues.push(`Task ${entry.number} lists criteria ${ids.join(', ') || 'none'}, but its plan task delivers ${delivered.join(', ')}`);
    for (const id of ids) if (!criteria.includes(id)) issues.push(`criterion ${id} is not in the spec`);
  }
  for (const id of criteria) if (!cited.includes(id)) issues.push(`criterion ${id} is in no task entry`);
  issues.push(...placeholderIssues(lines));
  return issues;
}
