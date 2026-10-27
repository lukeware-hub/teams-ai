import { nextHeal, type HealView } from './heal.js';
import { BusyError } from './session.js';

/** One draft the driver may heal: what it needs about the draft, and the only three calls it makes. It never freezes, starts or marks a run. */
export interface HealTarget {
  key: string;
  view(): HealView;
  evaluate(): Promise<void>;
  prepare(): Promise<void>;
  pause(reason: string): Promise<void>;
}

/** Heals the failed drafts one tick at a time: a tick never starts while another runs, and a draft a run holds is left for the next tick. */
export class RefineHealer {
  private running = false;

  constructor(
    private readonly targets: () => Promise<readonly HealTarget[]>,
    private readonly enabled: () => Promise<boolean>,
    private readonly onError: (key: string, err: unknown) => void,
  ) {}

  async tick(): Promise<void> {
    // The lock is taken before the first await, so two ticks that start together never both heal.
    if (this.running) return;
    this.running = true;
    try {
      if (!(await this.enabled())) return;
      for (const target of await this.targets()) {
        try {
          await this.heal(target);
        } catch (err) {
          // A draft a run holds is healed on a later tick; any other refusal or failure is reported, and the draft waits for the owner.
          if (err instanceof BusyError) continue;
          this.onError(target.key, err);
          await target.pause(err instanceof Error ? err.message : String(err)).catch((pauseErr: unknown) => this.onError(target.key, pauseErr));
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async heal(target: HealTarget): Promise<void> {
    const action = nextHeal(target.view());
    if (action.do === 'evaluate') await target.evaluate();
    else if (action.do === 'prepare') await target.prepare();
    else if (action.do === 'pause') await target.pause(action.reason);
  }
}
