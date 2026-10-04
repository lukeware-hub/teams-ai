import type { Plan } from '../contracts/plan.js';
import { E2E_GATE, e2eCommand } from '../exec/e2e.js';

const DISARMED = /\|\|\s*(true|exit\s+0|:)/;

/** R8.4: the post-deploy e2e gate exists, blocks, runs the delivery e2e suite and is not the smoke command. */
export function validateE2e(plan: Plan): string[] {
  const errors: string[] = [];
  const gate = plan.gates.find((g) => g.name === E2E_GATE);
  if (gate && !gate.blocking) errors.push('gate e2e must be blocking');
  const command = e2eCommand(plan);
  if (!command) return [...errors, 'commands.e2e is required (post-deploy e2e suite, not the smoke command)'];
  if (DISARMED.test(command)) errors.push(`e2e command must not be disarmed: ${command}`);
  if (plan.commands.smoke && command.trim() === plan.commands.smoke.trim()) errors.push('commands.e2e must differ from commands.smoke');
  const suite = plan.delivery?.e2eSuite;
  if (!suite) errors.push('delivery.e2eSuite is required when the e2e gate is required');
  else if (!command.includes(suite.replace(/^\.\//, ''))) errors.push(`commands.e2e must reference delivery.e2eSuite (${suite})`);
  return errors;
}
