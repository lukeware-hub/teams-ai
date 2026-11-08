import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';

describe('the heal flag', () => {
  it('is on unless the owner turns it off', () => {
    expect(loadConfig({}).refine.heal.enabled).toBe(true);
    expect(loadConfig({ refine: { heal: { enabled: false } } }).refine.heal.enabled).toBe(false);
  });
});
