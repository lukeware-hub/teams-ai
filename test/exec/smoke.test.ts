import { describe, expect, it } from 'vitest';
import { gateReachableUrl } from '../../server/exec/smoke.js';

describe('gateReachableUrl', () => {
  it.each([
    ['http://127.0.0.1:3000', 'http://host.docker.internal:3000/'],
    ['http://localhost:3000/api', 'http://host.docker.internal:3000/api'],
    ['http://[::1]:8080', 'http://host.docker.internal:8080/'],
    ['http://0.0.0.0:3000', 'http://host.docker.internal:3000/'],
  ])('points the container at the host instead of its own loopback: %s', (from, to) => {
    expect(gateReachableUrl(from)).toBe(to);
  });

  it('leaves a non-loopback address alone', () => {
    expect(gateReachableUrl('http://10.0.0.5:3000')).toBe('http://10.0.0.5:3000');
    expect(gateReachableUrl('http://todo-api.teams-ai.svc:3000')).toBe('http://todo-api.teams-ai.svc:3000');
  });
});
