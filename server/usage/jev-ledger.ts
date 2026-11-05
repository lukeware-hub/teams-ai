import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from '../config/config.js';
import { expandHome } from '../orchestrator/workspace.js';
import { jevCostUsd } from './jev-cost.js';

const LedgerLine = z.object({ costUsd: z.number().nonnegative() });

const ledgerFile = (cfg: Config): string => path.join(expandHome(cfg.paths.usage), 'jev-cost.ndjson');

/** Writes the journals' past Jev cost once, as the first ledger line, so history is counted one time. */
export async function seedJevLedger(cfg: Config): Promise<void> {
  if (await fs.access(ledgerFile(cfg)).then(() => true, () => false)) return;
  const seed = await jevCostUsd(expandHome(cfg.paths.workspaces), expandHome(cfg.paths.runs));
  await fs.mkdir(path.dirname(ledgerFile(cfg)), { recursive: true });
  await fs.writeFile(ledgerFile(cfg), JSON.stringify({ at: new Date().toISOString(), costUsd: seed, seeded: true }) + '\n', { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') throw err;
  });
}

/** Appends one Jev charge to the ledger; a zero or invalid charge adds no line. */
export async function recordJevCost(cfg: Config, costUsd: number): Promise<void> {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return;
  await fs.mkdir(path.dirname(ledgerFile(cfg)), { recursive: true });
  await fs.appendFile(ledgerFile(cfg), JSON.stringify({ at: new Date().toISOString(), costUsd }) + '\n');
}

/** The Jev's total cost since ever: the ledger when it exists, else the journals' sum. */
export async function jevTotalUsd(cfg: Config): Promise<number> {
  const raw = await fs.readFile(ledgerFile(cfg), 'utf8').catch(() => null);
  if (raw === null) return jevCostUsd(expandHome(cfg.paths.workspaces), expandHome(cfg.paths.runs));
  return raw.split('\n').filter((line) => line.trim() !== '').reduce((sum, line) => sum + chargeOf(line), 0);
}

/** The charge of one ledger line; a damaged line counts as zero. */
function chargeOf(line: string): number {
  try {
    const parsed = LedgerLine.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data.costUsd : 0;
  } catch {
    return 0;
  }
}
