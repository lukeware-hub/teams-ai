/** Whether a path of the repository is one of the eight kinds. */
export function isEightKind(rel: string): boolean;

/** The paths of a list that are not one of the eight kinds. */
export function disallowedFiles(files: string[]): string[];
