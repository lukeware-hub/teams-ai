import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PINNED_TOOLS, renderToolsInstaller } from '../../server/validators/tools-installer.js';

describe('renderToolsInstaller', () => {
  it('matches the golden file (regenerate it deliberately when a pin changes)', () => {
    expect(renderToolsInstaller()).toBe(readFileSync(new URL('../fixtures/tools-install.sh', import.meta.url), 'utf8'));
  });

  it('is deterministic, LF only, and verifies a sha256 for every download', () => {
    const out = renderToolsInstaller();
    expect(renderToolsInstaller()).toBe(out);
    expect(out).not.toContain('\r');
    for (const t of Object.values(PINNED_TOOLS)) expect(out).toContain(`"${t.url}" ${t.sha256}`);
    expect(out.match(/^fetch "/gm)).toHaveLength(3);
    expect(out).toContain('semgrep==');
  });
});
