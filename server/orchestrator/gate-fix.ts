import type { Plan } from '../contracts/plan.js';
import { E2E_GATE } from '../exec/e2e.js';
import { IMAGE_REFERENCE } from '../exec/gate-runner.js';
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

/** A gate image change the journal holds: the image it replaced and the reason the SM gave. */
export interface AppliedImageFix {
  before: string;
  after: string;
  reason: string;
}

/** The gate image changes journaled for one repository, in the order applied. */
export function gateImageFixes(events: readonly Pick<StoredEvent, 'type' | 'data'>[], service: string | null): AppliedImageFix[] {
  return events
    .filter((e) => e.type === OrchEvent.GateImageFixed && (e.data.service ?? null) === service)
    .map((e) => ({ before: String(e.data.before), after: String(e.data.after), reason: String(e.data.reason) }));
}

/** The plan as the run executes it: the journaled command corrections and the last journaled gate image. */
export function effectivePlan(plan: Plan, events: readonly Pick<StoredEvent, 'type' | 'data'>[], service: string | null): Plan {
  const fixed = applyGateFixes(plan, gateFixes(events, service));
  const image = gateImageFixes(events, service).at(-1)?.after;
  return image === undefined ? fixed : { ...fixed, gateImage: image };
}

const IMAGE_TAG = /^(\d+(?:\.\d+)*)(-.+)?$/;
const imageParts = (image: string) => {
  const [repository = '', tag = ''] = image.split(':');
  const match = IMAGE_TAG.exec(tag);
  return { repository, version: match ? match[1]!.split('.').map(Number) : null, flavour: match?.[2] ?? '' };
};

/** Why a gate image change must not stand, or nothing when it may: the same image and flavour, a newer version, within the limit. */
export function gateImageErrors(current: string, next: string, applied: number): string[] {
  if (!IMAGE_REFERENCE.test(next)) return [`${JSON.stringify(next)} is not a plain image reference`];
  const from = imageParts(current);
  const to = imageParts(next);
  if (next.includes('@') || !to.version) return [`the gate image needs a version tag such as ${from.repository}:1.27.3-bookworm`];
  if (to.repository !== from.repository) return [`the gate image keeps its repository: ${from.repository}, not ${to.repository}`];
  if (to.flavour !== from.flavour) return [`the gate image keeps its flavour: ${from.flavour}, not ${to.flavour}`];
  const old = from.version ?? [];
  const step = to.version.map((n, i) => n - (old[i] ?? 0)).find((d) => d !== 0) ?? (old.length > to.version.length ? -1 : 0);
  if (step <= 0) return [`the gate image only moves to a newer version: ${old.join('.')} to ${to.version.join('.')}`];
  if (applied >= MAX_GATE_FIXES) return [`the gate image was already changed ${applied} time(s) in this run`];
  return [];
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
