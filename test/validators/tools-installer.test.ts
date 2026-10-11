import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stackEnv } from '../../server/runner/stacks.js';
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
    expect(out.match(/^fetch "/gm)).toHaveLength(4);
    expect(out).toContain('semgrep==');
  });

  // pip --target never replaces a folder already there: sharing the project's folder kept its bin/ and lost semgrep's.
  it('installs semgrep from scratch in a folder of its own, apart from the Python packages the project installs', () => {
    const out = renderToolsInstaller();
    const target = /--target "\$ROOT\/([^"]+)"/.exec(out)![1]!;
    expect(target).not.toBe(path.relative('/work', stackEnv('/work').PYTHONPATH));
    expect(out.indexOf(`rm -rf "$ROOT/${target}"\n`)).toBeGreaterThan(-1);
    expect(out.indexOf(`rm -rf "$ROOT/${target}"\n`)).toBeLessThan(out.indexOf('--target "$ROOT/'));
    const own = target.replace(/^\.tools\//, '$D/');
    expect(out).toContain(`PYTHONPATH="${own}"`);
    expect(out).toContain(`exec python3 "${own}/bin/semgrep"`);
  });
});
