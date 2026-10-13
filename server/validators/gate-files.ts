import picomatch from 'picomatch';
import type { Plan } from '../contracts/plan.js';
import { BUILD_DIRS } from '../runner/stacks.js';

/** Source-like paths a gate command mentions (`node --check smoke/smoke.mjs`, `python tests/run.py`). */
const PATH_TOKEN = /(?:^|[\s'"=(])((?:[\w.-]+\/)*[\w-][\w.-]*\.(?:mjs|cjs|js|ts|tsx|jsx|py|go|rs|toml|sh|json|ya?ml))(?=$|[\s'")&;|])/g;
/** Created by the gate itself or by the orchestrator, never by a task; coverage/ is where coverage tools write their reports. */
const GATE_OWNED = new RegExp(`^(?:\\.tools/|reports/|coverage/|\\./\\.tools/|(?:${BUILD_DIRS.map((d) => d.replace('.', '\\.')).join('|')})/)`);

/**
 * Gates run in the worktree of EVERY task, the first one included. A blocking gate that names a file only a later task creates
 * (live: `node --check smoke/smoke.mjs` in `lint`) can never pass on the root task, so the whole DAG blocks behind it.
 * Each such file must already be in the repo or be owned by a root task (no dependencies), which then creates it first.
 */
export function gateFileErrors(plan: Plan, repoFiles: ReadonlySet<string>): string[] {
  const owners = (tasks: Plan['tasks']) => tasks.flatMap((t) => t.affectedPaths).map((p) => picomatch(p, { dot: true }));
  const rootOwners = owners(plan.tasks.filter((t) => t.dependsOn.length === 0));
  const anyOwners = owners(plan.tasks);
  const gateOutputs = new Set([plan.coveragePath, plan.junitPath].filter(Boolean));
  const missing = (command: string, own: ReturnType<typeof owners>) =>
    [...new Set([...command.matchAll(PATH_TOKEN)].map((m) => m[1]!.replace(/^\.\//, '')))].filter(
      (file) => !(GATE_OWNED.test(file) || gateOutputs.has(file) || repoFiles.has(file) || own.some((match) => match(file))),
    );
  const errors: string[] = [];
  for (const gate of plan.gates) {
    if (!gate.blocking) continue;
    const files = missing(gate.command, rootOwners);
    if (files.length > 0) {
      errors.push(
        `gate ${gate.name} names ${files.join(', ')}, which neither exists in the repo nor belongs to a task without dependencies; gates run on every task's worktree, so the first task could never pass. Give the file to the root task (a stub is enough) or make the gate command skip a missing file`,
      );
    }
  }
  // The smoke and e2e suites run after every task merged, so any task may create their files (live: a wrong smoke path failed the deploy).
  for (const name of ['smoke', 'e2e'] as const) {
    const files = missing(plan.commands[name] ?? '', anyOwners);
    if (files.length > 0) errors.push(`commands.${name} names ${files.join(', ')}, which neither exists in the repo nor is in any task's affectedPaths; point the command at the suite a task creates`);
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
