import { describe, expect, it } from 'vitest';
import type { Plan } from '../../server/contracts/plan.js';
import { gateFileErrors } from '../../server/validators/gate-files.js';

const gate = (name: string, command: string, blocking = true) => ({ name, command, blocking });
const plan = (gates: ReturnType<typeof gate>[], roots: string[]): Plan =>
  ({
    gates,
    tasks: [
      { id: 'T0-scaffold', dependsOn: [], affectedPaths: roots },
      { id: 'T1', dependsOn: ['T0-scaffold'], affectedPaths: ['smoke/smoke.mjs'] },
    ],
  }) as unknown as Plan;
const repo = new Set(['server.mjs', 'test/hello.test.mjs', 'package.json']);

describe('gateFileErrors', () => {
  it('rejects a blocking gate that names a file only a later task creates (the live T0 deadlock)', () => {
    const errs = gateFileErrors(plan([gate('lint', 'node --check server.mjs && node --check smoke/smoke.mjs')], ['.gitignore']), repo);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/gate lint names smoke\/smoke\.mjs/);
  });

  it('accepts files that exist, files a root task owns, gate-owned paths and non-blocking gates', () => {
    expect(gateFileErrors(plan([gate('lint', 'node --check server.mjs && node --check smoke/smoke.mjs')], ['smoke/**']), repo)).toEqual([]);
    expect(gateFileErrors(plan([gate('install', 'sh .tools/install.sh'), gate('t', 'mkdir -p reports && npm test')], []), repo)).toEqual([]);
    expect(gateFileErrors(plan([gate('lint', 'node --check smoke/smoke.mjs', false)], []), repo)).toEqual([]);
  });
});

describe('gateTerminationErrors', () => {
  it('rejects a gate that imports a repo module without process.exit(0), accepts one that exits', async () => {
    const { gateTerminationErrors } = await import('../../server/validators/gate-files.js');
    const bad = plan([gate('build', `node -e "import('./server.mjs').then(m=>console.log(typeof m.handler))"`)], []);
    expect(gateTerminationErrors(bad)[0]).toMatch(/gate build loads a repo module but never calls process\.exit\(0\)/);
    const ok = plan([gate('build', `node -e "import('./server.mjs').then(()=>process.exit(0))"`), gate('t', 'npm test')], []);
    expect(gateTerminationErrors(ok)).toEqual([]);
  });
});
