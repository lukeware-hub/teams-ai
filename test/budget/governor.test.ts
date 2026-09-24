import { describe, expect, it } from 'vitest';
import { Governor } from '../../server/budget/governor.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Governor', () => {
  it('lets `limit` tasks run at once and queues the rest', async () => {
    const g = new Governor(2);
    const r1 = await g.acquire();
    const r2 = await g.acquire();
    let third = false;
    const p3 = g.acquire().then((release) => {
      third = true;
      return release;
    });
    await flush();
    expect(third).toBe(false);
    expect(g.active).toBe(2);
    expect(g.waiting).toBe(1);
    r1();
    const r3 = await p3;
    expect(third).toBe(true);
    r2();
    r3();
    expect(g.active).toBe(0);
  });

  it('lowering the limit takes effect as slots free up', async () => {
    const g = new Governor(3);
    const a = await g.acquire();
    const b = await g.acquire();
    g.setLimit(1);
    let got = false;
    const p = g.acquire().then((r) => {
      got = true;
      return r;
    });
    a();
    await flush();
    expect(got).toBe(false); // still 1 active, limit 1
    b();
    const c = await p;
    expect(got).toBe(true);
    c();
  });

  it('release is idempotent', async () => {
    const g = new Governor(1);
    const r = await g.acquire();
    r();
    r();
    expect(g.active).toBe(0);
  });

  it('rejects a non-positive limit', () => {
    expect(() => new Governor(0)).toThrow(RangeError);
    expect(() => new Governor(1).setLimit(0)).toThrow(RangeError);
  });
});
