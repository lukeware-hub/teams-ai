import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeToolsInstaller } from '../../server/orchestrator/tools-install.js';
import { renderToolsInstaller } from '../../server/validators/tools-installer.js';

describe('writeToolsInstaller', () => {
  it('writes the rendered script into .tools/install.sh of the worktree', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'tools-'));
    try {
      const file = await writeToolsInstaller(dir);
      expect(file).toBe(path.join(dir, '.tools', 'install.sh'));
      expect(readFileSync(file, 'utf8')).toBe(renderToolsInstaller());
      expect(statSync(file).isFile()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
