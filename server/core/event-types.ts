/** Reads events written under older type names: each type found in `renames` takes its current name. */
export const withRenamedTypes = (renames: ReadonlyMap<string, string>) => <T extends { type: string }>(e: T): T => {
  const type = renames.get(e.type);
  return type === undefined ? e : { ...e, type };
};
