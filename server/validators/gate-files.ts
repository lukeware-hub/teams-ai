import picomatch from 'picomatch';
import type { Plan } from '../contracts/plan.js';

/** Source-like paths a gate command mentions (`node --check smoke/smoke.mjs`, `python tests/run.py`). */
const PATH_TOKEN = /(?:^|[\s'"=(])((?:[\w.-]+\/)*[\w-][\w.-]*\.(?:mjs|cjs|js|ts|tsx|jsx|py|sh|json|ya?ml))(?=$|[\s'")&;|])/g;
/** Created by the gate itself or by the orchestrator, never by a task. */
const GATE_OWNED = /^(?:\.tools\/|node_modules\/|reports\/|\.\/\.tools\/)/;

/**
 * Gates run in the worktree of EVERY task, the first one included. A blocking gate that names a file only a later task creates
 * (live: `node --check smoke/smoke.mjs` in `lint`) can never pass on the root task, so the whole DAG blocks behind it.
 * Each such file must already be in the repo or be owned by a root task (no dependencies), which then creates it first.
 */
export function gateFileErrors(plan: Plan, repoFiles: ReadonlySet<string>): string[] {
  const rootOwners = plan.tasks.filter((t) => t.dependsOn.length === 0).flatMap((t) => t.affectedPaths).map((p) => picomatch(p, { dot: true }));
  const errors: string[] = [];
  for (const gate of plan.gates) {
    if (!gate.blocking) continue;
    const missing = new Set<string>();
    for (const m of gate.command.matchAll(PATH_TOKEN)) {
      const file = m[1]!.replace(/^\.\//, '');
      if (GATE_OWNED.test(file) || repoFiles.has(file) || rootOwners.some((own) => own(file))) continue;
      missing.add(file);
    }
    if (missing.size > 0) {
      errors.push(
        `gate ${gate.name} names ${[...missing].join(', ')}, which neither exists in the repo nor belongs to a task without dependencies; gates run on every task's worktree, so the first task could never pass. Give the file to the root task (a stub is enough) or make the gate command skip a missing file`,
      );
    }
  }
  return errors;
}

/**
 * A gate that imports a repo module and then never calls process.exit(0) hangs when that module starts a server at import time
 * (live: a build gate `import('./server.mjs').then(...)` on the not-yet-refactored fixture ran into the 15 min timeout, was retried
 * as infra, and blocked the scaffold). Ending the check with an explicit exit keeps it bounded.
 */
export function gateTerminationErrors(plan: Plan): string[] {
  const errors: string[] = [];
  for (const gate of plan.gates) {
    if (!gate.blocking) continue;
    if (/(?:import|require)\(\s*['"]\.{1,2}\//.test(gate.command) && !/process\.exit\(\s*0\s*\)/.test(gate.command)) {
      errors.push(`gate ${gate.name} loads a repo module but never calls process.exit(0): if the module starts a server at import time the gate never ends. Finish the check with process.exit(0)`);
    }
  }
  return errors;
}
