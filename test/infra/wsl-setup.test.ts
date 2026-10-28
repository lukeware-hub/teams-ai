import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';


describe('scripts/wsl/setup-ubuntu.sh', () => {
  it('installs no Spec Kit: the Dockerfile, the setup script and the tool checks name no Spec Kit release or command', async () => {
    for (const file of ['Dockerfile', 'scripts/wsl/setup-ubuntu.sh', 'scripts/wsl/check-tools.sh']) {
      expect(await fs.readFile(file, 'utf8'), file).not.toMatch(/spec-kit|specify-cli|speckit|specify init/i);
    }
  });
});
