import path from 'node:path';

/** The implementation plan of one spec, relative to the folder the plan step writes in and to the draft's docs. */
export const planFileOf = (specId: string): string => path.posix.join('docs', 'specs', specId, 'implementation-plan.md');

/** The section of specs.md one backlog item has: its heading to the next level-two heading, or empty when there is none. */
export function specSectionOf(specsMd: string, key: string): string {
  const lines = specsMd.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${key}:`));
  if (start === -1) return '';
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}
