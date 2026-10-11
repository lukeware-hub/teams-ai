import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { processAlive } from '../../server/core/process.js';

describe('processAlive', () => {
  it('sees this process as alive and a missing pid as gone', () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 22 + 1)).toBe(false);
  });

  it.runIf(process.platform === 'linux')('treats an exited, unreaped child (zombie) as gone', async () => {
    // The child exits at once; with no 'exit' listener node still reaps it, so hold it with a parent that never waits.
    const parent = spawn('sh', ['-c', 'sleep 0 & echo $!; sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = Number(await new Promise<string>((resolve) => parent.stdout!.once('data', (d) => resolve(String(d).trim()))));
    await new Promise((r) => setTimeout(r, 300));
    try {
      expect(processAlive(pid)).toBe(false);
    } finally {
      parent.kill();
    }
  });
});
