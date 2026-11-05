import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { COST_PERIODS, type CostPeriod } from '@server/usage/cost-types.js';
import { usePolling } from '../../usePolling.js';

const REFRESH_MS = 30_000;

/** The period in `?period=`; `tudo` when the address has none or an unknown one. */
export function usePeriod(): [CostPeriod, (next: CostPeriod) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('period') ?? '';
  const period = (COST_PERIODS as readonly string[]).includes(raw) ? (raw as CostPeriod) : 'tudo';
  const choose = (next: CostPeriod) => {
    const to = new URLSearchParams(params);
    to.set('period', next);
    setParams(to, { replace: true });
  };
  return [period, choose];
}

interface Slot<T> {
  key: string;
  data?: T;
  error?: unknown;
  version: number;
}

/**
 * A cost view for one scope and period, read on entry and again every 30 s while the tab is visible.
 * A failed read keeps the last value of the same scope and period, and `version` moves on each good read.
 */
export function useCostData<T>(scope: string, read: (period: CostPeriod) => Promise<T>, period: CostPeriod) {
  const key = `${scope}|${period}`;
  const [slot, setSlot] = useState<Slot<T> | null>(null);
  const latest = useRef({ key, period, read });
  latest.current = { key, period, read };

  const load = useCallback(() => {
    const asked = latest.current;
    // An answer for a scope or period the screen no longer shows is dropped.
    return asked.read(asked.period).then(
      (data) => {
        if (latest.current.key !== asked.key) return;
        setSlot((prev) => ({ key: asked.key, data, version: (prev?.key === asked.key ? prev.version : 0) + 1 }));
      },
      (error: unknown) => {
        if (latest.current.key !== asked.key) return;
        setSlot((prev) => {
          const same = prev?.key === asked.key;
          return { key: asked.key, data: same ? prev.data : undefined, error, version: same ? prev.version : 0 };
        });
      },
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load, key]);
  usePolling(load, REFRESH_MS);

  const shown = slot?.key === key ? slot : null;
  return { data: shown?.data, error: shown?.error, version: shown?.version ?? 0, reload: load };
}
