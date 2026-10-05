import { describe, expect, it } from 'vitest';
import { containerUser } from '../../server/orchestrator/run.js';
import { DEFAULT_CONFIG } from '../../server/config/config.js';

describe('containerUser', () => {
  it('is the process uid:gid on a rootful daemon and absent on a rootless one (its root owns the files)', () => {
    if (typeof process.getuid === 'function') expect(containerUser()).toBe(`${process.getuid()}:${process.getgid!()}`);
    expect(containerUser(true)).toBeUndefined();
  });

  it('defaults to a rootful daemon', () => {
    expect(DEFAULT_CONFIG.docker.rootless).toBe(false);
  });
});
