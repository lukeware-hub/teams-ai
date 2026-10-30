import type { Plan } from '../contracts/plan.js';
import { E2E_GATE } from '../exec/e2e.js';
import type { StoredEvent } from '../store/event-store.js';
import { DISARMED, validateSecurityGates } from '../validators/security-tooling.js';
import { OrchEvent } from './events.js';

/** The corrections one gate takes in a run: a second try after a wrong first one, never an open-ended rewrite. */
export const MAX_GATE_FIXES = 2;

/** A corrected command for one blocking gate of the plan, as the SM proposes it. */
export interface GateFix {
  gate: string;
  command: string;
}

/** A correction the journal holds: the command it replaced and the reason the SM gave. */
export interface AppliedGateFix extends GateFix {
  before: string;
  reason: string;
}

/** The corrections journaled for one repository (`service` null for the project repository), in the order applied. */
export function gateFixes(events: readonly Pick<StoredEvent, 'type' | 'data'>[], service: string | null): AppliedGateFix[] {
  return events
    .filter((e) => e.type === OrchEvent.GateFixed && (e.data.service ?? null) === service)
    .map((e) => ({ gate: String(e.data.gate), command: String(e.data.after), before: String(e.data.before), reason: String(e.data.reason) }));
}

/** The plan with every correction applied; the last one for a gate wins. */
export function applyGateFixes(plan: Plan, fixes: readonly GateFix[]): Plan {
  if (fixes.length === 0) return plan;
  const command = new Map(fixes.map((f) => [f.gate, f.command]));
  return { ...plan, gates: plan.gates.map((g) => (command.has(g.name) ? { ...g, command: command.get(g.name)! } : g)) };
}

/** Why a correction must not stand, or nothing when it may: a blocking gate of this plan gets a new command that disarms no check and adds no security-tooling error. */
export function gateFixErrors(plan: Plan, fix: GateFix, applied: number): string[] {
  const gate = plan.gates.find((g) => g.name === fix.gate);
  if (!gate) return [`no gate named ${fix.gate} in this plan`];
  if (fix.gate === E2E_GATE) return [`gate ${E2E_GATE} runs after deploy, outside the task gates`];
  if (!gate.blocking) return [`gate ${fix.gate} is not blocking`];
  if (fix.command.trim() === gate.command.trim()) return [`gate ${fix.gate} already runs this command`];
  if (applied >= MAX_GATE_FIXES) return [`gate ${fix.gate} was already corrected ${applied} time(s) in this run`];
  if (DISARMED.test(fix.command)) return [`gate ${fix.gate} would pass without its check (|| true, exit 0 or an exit-zero flag)`];
  const before = new Set(validateSecurityGates(plan));
  return validateSecurityGates(applyGateFixes(plan, [fix])).filter((e) => !before.has(e));
}
