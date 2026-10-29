import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The time budget of the backend suite: no test file over `fileS`, the whole run within `suiteS`. */
export const LIMITS = { fileS: 60, suiteS: 480 };

export interface FileTiming {
  name: string;
  startTime: number;
  endTime: number;
}

export interface Budget {
  suiteS: number;
  slowest: Array<{ name: string; s: number }>;
  problems: string[];
}

/** The budget of a run, from the timing of each test file in the vitest JSON report. */
export function budgetOf(files: readonly FileTiming[], limits = LIMITS): Budget {
  const per = files.map((f) => ({ name: path.basename(f.name), s: (f.endTime - f.startTime) / 1000 }));
  const suiteS = files.length ? (Math.max(...files.map((f) => f.endTime)) - Math.min(...files.map((f) => f.startTime))) / 1000 : 0;
  const slowest = [...per].sort((a, b) => b.s - a.s).slice(0, 5);
  const problems = [
    ...per.filter((f) => f.s > limits.fileS).map((f) => `${f.name} took ${f.s.toFixed(0)} s, over ${limits.fileS} s`),
    ...(suiteS > limits.suiteS ? [`the suite took ${suiteS.toFixed(0)} s, over ${limits.suiteS} s`] : []),
  ];
  return { suiteS, slowest, problems };
}

/** Prints the budget of the report. On CI an over-budget run fails; on a local machine it only reports. */
async function main(file: string): Promise<number> {
  const report = JSON.parse(await fs.readFile(file, 'utf8')) as { testResults: FileTiming[] };
  const budget = budgetOf(report.testResults);
  console.log(`suite ${budget.suiteS.toFixed(0)} s; slowest: ${budget.slowest.map((f) => `${f.name} ${f.s.toFixed(0)} s`).join(', ')}`);
  for (const problem of budget.problems) console.log(`over budget: ${problem}`);
  if (budget.problems.length === 0) return 0;
  if (process.env.CI) return 1;
  console.log('not enforced here: the CI runner is the budget');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv[2] ?? 'reports/vitest-results.json');
}
