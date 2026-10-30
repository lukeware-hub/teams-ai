import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Usage } from './stream-events.js';

/**
 * A step's HOME is deleted when it ends, and with it the CLI's session transcript (`.claude/projects/<cwd>/<id>.jsonl`).
 * To let a Dev retry resume its previous attempt (R11.13 slice 7: the context is read from the prompt cache instead of
 * being rebuilt), the orchestrator keeps that one directory outside the HOME, per task. The CLI finds a transcript by
 * the cwd it ran in, so the store remembers the cwd and refuses to resume from another one.
 */
const PROJECTS = 'projects';
const CWD_FILE = 'cwd';

async function transcript(storeDir: string, sessionId: string): Promise<string | null> {
  let dirs: string[];
  try {
    dirs = await fs.readdir(path.join(storeDir, PROJECTS));
  } catch {
    return null;
  }
  for (const d of dirs) {
    const file = path.join(storeDir, PROJECTS, d, `${sessionId}.jsonl`);
    if (await fs.stat(file).then((s) => s.isFile(), () => false)) return file;
  }
  return null;
}

/** True when `sessionId` was saved for this very cwd, so `--resume` will find it. */
export async function hasSession(storeDir: string, sessionId: string, cwd: string): Promise<boolean> {
  const saved = await fs.readFile(path.join(storeDir, CWD_FILE), 'utf8').catch(() => null);
  return saved === cwd && (await transcript(storeDir, sessionId)) !== null;
}

export async function restoreSession(storeDir: string, home: string): Promise<void> {
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.cp(path.join(storeDir, PROJECTS), path.join(home, '.claude', PROJECTS), { recursive: true });
}

const TOTALS_FILE = 'totals.json';

/** What the CLI reported for the last invocation: cost and API time are cumulative for the session, usage is that invocation's own. */
export interface SessionTotals {
  costUsd: number;
  durationApiMs: number;
  usage: Usage;
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export async function readTotals(storeDir: string): Promise<SessionTotals> {
  try {
    const t = JSON.parse(await fs.readFile(path.join(storeDir, TOTALS_FILE), 'utf8')) as Partial<SessionTotals>;
    // A totals file written before usage was kept reads as zero usage.
    const u: Partial<Usage> = t.usage ?? {};
    const usage = { inputTokens: Number(u.inputTokens) || 0, outputTokens: Number(u.outputTokens) || 0, cacheReadTokens: Number(u.cacheReadTokens) || 0, cacheWriteTokens: Number(u.cacheWriteTokens) || 0 };
    return { costUsd: Number(t.costUsd) || 0, durationApiMs: Number(t.durationApiMs) || 0, usage };
  } catch {
    return { costUsd: 0, durationApiMs: 0, usage: { ...ZERO_USAGE } };
  }
}

export async function writeTotals(storeDir: string, totals: SessionTotals): Promise<void> {
  await fs.mkdir(storeDir, { recursive: true });
  await fs.writeFile(path.join(storeDir, TOTALS_FILE), JSON.stringify(totals)).catch(() => undefined);
}

/** Never throws: a session that could not be kept only costs the next attempt a fresh start. */
export async function saveSession(home: string, storeDir: string, cwd: string): Promise<void> {
  const source = path.join(home, '.claude', PROJECTS);
  try {
    await fs.stat(source);
    await fs.rm(path.join(storeDir, PROJECTS), { recursive: true, force: true });
    await fs.mkdir(storeDir, { recursive: true });
    await fs.cp(source, path.join(storeDir, PROJECTS), { recursive: true });
    await fs.writeFile(path.join(storeDir, CWD_FILE), cwd);
  } catch {
    /* nothing to keep */
  }
}
