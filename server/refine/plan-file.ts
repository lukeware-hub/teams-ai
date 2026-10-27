import path from 'node:path';

/** The implementation plan of one spec, relative to the folder the plan step writes in and to the draft's docs. */
export const planFileOf = (specId: string): string => path.posix.join('docs', 'specs', specId, 'implementation-plan.md');
