import type { Spec } from '../contracts/spec.js';
import type { Plan, PlanTask } from '../contracts/plan.js';
import { E2E_GATE, e2eCommand } from '../exec/e2e.js';

const DISARMED = /\|\|\s*(true|exit\s+0|:)/;

// The gate runs without root, apt or network, so a command that installs anything can never pass.
const INSTALL = /\bapt(-get)?\b|--with-deps|\bplaywright install\b/;
// Only Playwright drives a browser in the gate, and only a front plan's gate image carries Chromium.
const OTHER_BROWSER = /\b(puppeteer|cypress|selenium)\b/i;
const PLAYWRIGHT_TEST = /\bplaywright test\b/;

/** R8.4: the post-deploy e2e gate exists, blocks, runs the delivery e2e suite and is not the smoke command. */
export function validateE2e(plan: Plan): string[] {
  const errors: string[] = [];
  const gate = plan.gates.find((g) => g.name === E2E_GATE);
  if (gate && !gate.blocking) errors.push('gate e2e must be blocking');
  const command = e2eCommand(plan);
  if (!command) return [...errors, 'commands.e2e is required (post-deploy e2e suite, not the smoke command)'];
  if (DISARMED.test(command)) errors.push(`e2e command must not be disarmed: ${command}`);
  if (INSTALL.test(command)) errors.push(`e2e command must not install a browser or system packages (the gate has no root, apt or network): ${command}`);
  if (OTHER_BROWSER.test(command)) errors.push(`e2e command must not drive a browser other than Playwright: ${command}`);
  if (PLAYWRIGHT_TEST.test(command) && plan.deploy.kind !== 'front') errors.push(`e2e command runs Playwright only for a front plan (deploy.kind front), since only its gate image carries Chromium: ${command}`);
  if (plan.commands.smoke && command.trim() === plan.commands.smoke.trim()) errors.push('commands.e2e must differ from commands.smoke');
  const suite = plan.delivery?.e2eSuite;
  if (!suite) errors.push('delivery.e2eSuite is required when the e2e gate is required');
  else if (!runsSuite(command, suite.replace(/^\.\//, ''))) errors.push(`commands.e2e must reference delivery.e2eSuite (${suite})`);
  return errors;
}

/** An exemption names a real criterion once, with a reason, and at least one criterion stays under e2e. */
export function validateE2eExemptions(plan: Pick<Plan, 'e2eExemptions'>, spec: Spec): string[] {
  const exemptions = plan.e2eExemptions ?? [];
  const errors: string[] = [];
  const known = new Set(spec.acceptanceCriteria.map((ac) => ac.id));
  const seen = new Set<string>();
  for (const x of exemptions) {
    if (!known.has(x.acId)) errors.push(`e2eExemptions: ${x.acId} is not a criterion of the spec`);
    if (seen.has(x.acId)) errors.push(`e2eExemptions: duplicate ${x.acId}`);
    seen.add(x.acId);
    if (x.reason.trim().length < 10) errors.push(`e2eExemptions: ${x.acId} needs a reason of at least 10 characters`);
  }
  if (known.size > 0 && [...known].every((id) => seen.has(id))) errors.push('e2eExemptions: at least one criterion must be covered by the e2e suite');
  return errors;
}

/** A screen is never exempt: a criterion a front task delivers runs in the e2e suite of a front service. */
export function validateFrontExemptions(tasks: readonly Pick<PlanTask, 'id' | 'owner' | 'criteriaRefs'>[], exemptions: readonly { acId: string }[]): string[] {
  const exempt = new Set(exemptions.map((x) => x.acId));
  const errors = tasks.filter((t) => t.owner === 'front').flatMap((t) => t.criteriaRefs.filter((ac) => exempt.has(ac)).map((ac) => `e2eExemptions: ${ac} is delivered by the front task ${t.id}; a screen is never exempt from the e2e suite`));
  return [...new Set(errors)];
}

/** A front task changes UI code only, so it belongs to a service that deploys a front (its own repository). */
export function validateFrontTasks(tasks: readonly Pick<PlanTask, 'id' | 'owner' | 'service'>[], deployKindOf: (task: Pick<PlanTask, 'id' | 'owner' | 'service'>) => string | undefined): string[] {
  return tasks.filter((t) => t.owner === 'front' && deployKindOf(t) !== 'front').map((t) => `front task ${t.id} must belong to a service with deploy.kind front (its own repository); a front inside an api service gets no browser test`);
}

/** The command names the suite, or the folder of a suite file, which runs it too (go test ./e2e/...). */
function runsSuite(command: string, suite: string): boolean {
  const folder = suite.slice(0, suite.lastIndexOf('/') + 1);
  return command.includes(suite) || (folder !== '' && folder !== suite && command.includes(folder));
}
