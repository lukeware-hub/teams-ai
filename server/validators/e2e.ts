import type { Spec } from '../contracts/spec.js';
import type { Plan } from '../contracts/plan.js';
import { E2E_GATE, e2eCommand } from '../exec/e2e.js';

const DISARMED = /\|\|\s*(true|exit\s+0|:)/;

// The gate runs without root, apt or a browser, so a command that installs one can never pass.
const BROWSER_INSTALL = /\bapt(-get)?\b|--with-deps|\b(playwright|puppeteer|cypress|selenium|chromium)\b/i;

/** R8.4: the post-deploy e2e gate exists, blocks, runs the delivery e2e suite and is not the smoke command. */
export function validateE2e(plan: Plan): string[] {
  const errors: string[] = [];
  const gate = plan.gates.find((g) => g.name === E2E_GATE);
  if (gate && !gate.blocking) errors.push('gate e2e must be blocking');
  const command = e2eCommand(plan);
  if (!command) return [...errors, 'commands.e2e is required (post-deploy e2e suite, not the smoke command)'];
  if (DISARMED.test(command)) errors.push(`e2e command must not be disarmed: ${command}`);
  if (BROWSER_INSTALL.test(command)) errors.push(`e2e command must not install a browser or system packages (the gate has no root, apt or browser; test over HTTP): ${command}`);
  if (plan.commands.smoke && command.trim() === plan.commands.smoke.trim()) errors.push('commands.e2e must differ from commands.smoke');
  const suite = plan.delivery?.e2eSuite;
  if (!suite) errors.push('delivery.e2eSuite is required when the e2e gate is required');
  else if (!command.includes(suite.replace(/^\.\//, ''))) errors.push(`commands.e2e must reference delivery.e2eSuite (${suite})`);
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
