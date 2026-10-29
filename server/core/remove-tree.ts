import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Removes a tree even when a folder inside it is read-only, as the Go module cache leaves its folders. */
export async function removeTree(target: string): Promise<void> {
  await makeWritable(target);
  await fs.rm(target, { recursive: true, force: true });
}

// Unlinking a file needs write permission on its folder, so each folder gets the owner's write bit first.
async function makeWritable(target: string): Promise<void> {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isDirectory()) return;
  await fs.chmod(target, stat.mode | 0o700).catch(() => undefined);
  for (const name of await fs.readdir(target).catch(() => [] as string[])) await makeWritable(path.join(target, name));
}
