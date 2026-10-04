import { promises as fs } from 'node:fs';
import path from 'node:path';
import { INSTALLER_PATH, renderToolsInstaller } from '../validators/tools-installer.js';

/** Writes the pinned scanner installer into the worktree so the `security-tools` gate can run it (plan 37). */
export async function writeToolsInstaller(worktree: string): Promise<string> {
  const file = path.join(worktree, INSTALLER_PATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, renderToolsInstaller(), { mode: 0o755 });
  return file;
}
