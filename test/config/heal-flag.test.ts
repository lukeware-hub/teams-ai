import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config/config.js';

describe('the heal flag', () => {
  it('is off unless the owner turns it on', () => {
    expect(loadConfig({}).refine.heal.enabled).toBe(false);
    expect(loadConfig({ refine: { heal: { enabled: true } } }).refine.heal.enabled).toBe(true);
  });
});
