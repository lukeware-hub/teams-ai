import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** How often `updateFileAtomic` redoes its change on top of a foreign write before it stops checking. */
const MAX_ATTEMPTS = 3;

/** Tail of the queued tasks per target file; see `serialized`. */
const pending = new Map<string, Promise<void>>();

/**
 * Runs `task` once every earlier task on the same file has settled. Windows fails renames onto the same target that
 * overlap with EPERM, so the writers of one file run one at a time, in call order. A failed task does not block the
 * next one, and tasks on different files never wait for each other.
 */
async function serialized<T>(file: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const run = (pending.get(key) ?? Promise.resolve()).then(task);
  const tail = run.then(
    () => {},
    () => {},
  );
  pending.set(key, tail);
  try {
    return await run;
  } finally {
    if (pending.get(key) === tail) pending.delete(key);
  }
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

interface ReplaceOptions {
  mode?: number;
  /** Runs once the tmp file is written, right before the rename; `false` abandons the write. */
  stillCurrent?: () => Promise<boolean>;
}

/** Renames a fresh tmp file over `file`; returns false, with `file` untouched, when `stillCurrent` says no. */
async function replace(file: string, content: string, { mode, stillCurrent }: ReplaceOptions = {}): Promise<boolean> {
  // Unique per call, so no writer ever renames or truncates another writer's tmp file (that was ENOENT).
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    await fs.writeFile(tmp, content, mode === undefined ? undefined : { mode });
    if (mode !== undefined) await fs.chmod(tmp, mode).catch(() => undefined); // the umask may have masked `mode`
    if (stillCurrent && !(await stillCurrent())) return false;
    await fs.rename(tmp, file);
    renamed = true;
    return true;
  } finally {
    if (!renamed) await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export interface AtomicWriteOptions {
  /** Permission bits of the new file, e.g. 0o600 for a secret. */
  mode?: number;
}

/**
 * Replaces `file` with `content` atomically: the bytes go to a tmp file next to it that no other writer shares and
 * are renamed into place, so a reader never sees a half-written file and a failed write leaves no tmp file behind.
 * Writers of one file in this process run one at a time. The parent directory must exist.
 */
export function writeFileAtomic(file: string, content: string, options: AtomicWriteOptions = {}): Promise<void> {
  return serialized(file, async () => {
    await replace(file, content, options);
  });
}

/**
 * Atomic read-modify-write of a text file. `update` gets the current content (`undefined` when the file does not
 * exist) and returns the new content, or `undefined` to leave the file alone. It must depend only on its argument,
 * because it can run again. Updates of one file in this process run one at a time, so none overwrites another.
 *
 * A writer outside this process (the claude CLI saves ~/.claude.json on its own) cannot be locked out, so a write
 * can still be lost to it. The window is kept small: the file is read again right before the rename, and when it
 * changed since `update` read it the change is redone on top of the new content. After MAX_ATTEMPTS the last
 * attempt renames without checking, so a writer that never stops cannot starve the update.
 */
export function updateFileAtomic(file: string, update: (current: string | undefined) => string | undefined): Promise<void> {
  return serialized(file, async () => {
    for (let attempt = 1; ; attempt++) {
      const before = await readText(file);
      const next = update(before);
      if (next === undefined) return;
      const stillCurrent = attempt < MAX_ATTEMPTS ? async () => (await readText(file)) === before : undefined;
      if (await replace(file, next, { stillCurrent })) return;
    }
  });
}
