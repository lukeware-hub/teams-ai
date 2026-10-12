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
  it('checks Go and Rust files too and treats build folders as gate-owned', () => {
    const errs = gateFileErrors(plan([gate('test', 'go test ./cmd/main_test.go && cargo test --manifest-path crates/app/Cargo.toml')], ['.gitignore']), repo);
    expect(errs.join('\n')).toMatch(/cmd\/main_test\.go/);
    expect(errs.join('\n')).toMatch(/Cargo\.toml/);
    expect(gateFileErrors(plan([gate('build', 'ls target/release/app.rs vendor/x.go .venv/bin/y.py')], []), repo)).toEqual([]);
  });

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

  it('accepts what the coverage tool writes into coverage/ while the gate runs (live: the summary vitest writes, then read in the same command)', () => {
    const cmd = "npx vitest run --coverage --coverage.reporter=json-summary && node -e \"const s=require('./coverage/coverage-summary.json');console.log(s.total.lines.pct)\"";
    expect(gateFileErrors(plan([gate('coverage', cmd)], []), repo)).toEqual([]);
  });

  it('accepts the coverage and junit files the gates themselves write', () => {
    const cmd = "npm test && node -e \"require('fs').writeFileSync('coverage/coverage.json', '{}')\" && cat reports/junit.xml.json";
    const p = { ...plan([gate('coverage', cmd)], []), coveragePath: 'coverage/coverage.json', junitPath: 'reports/junit.xml.json' } as Plan;
    expect(gateFileErrors(p, repo)).toEqual([]);
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
