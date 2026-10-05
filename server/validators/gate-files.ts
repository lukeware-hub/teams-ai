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
