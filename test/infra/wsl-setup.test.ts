import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** A Spec Kit release archive, pinned to its commit. */
const SPECKIT_PIN = /https:\/\/github\.com\/github\/spec-kit\/archive\/[0-9a-f]{40}\.zip/;

describe('scripts/wsl/setup-ubuntu.sh', () => {
  it('installs the Spec Kit release the Dockerfile pins, and replaces an install of any other version', async () => {
    const pin = (await fs.readFile('Dockerfile', 'utf8')).match(SPECKIT_PIN)?.[0];
    const setup = await fs.readFile('scripts/wsl/setup-ubuntu.sh', 'utf8');
    expect(pin).toBeDefined();
    expect(setup).toContain(`SPECKIT=${pin}\n`);
    // pipx records the archive each package came from: only the pinned one skips the install, and any other is replaced.
    expect(setup).toContain('[[ "$(pipx list --json 2>/dev/null)" == *"$SPECKIT"* ]] || pipx install --force "$SPECKIT"');
  });
});
