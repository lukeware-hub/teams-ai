import { afterEach, describe, expect, it } from 'vitest';
import type { CommandResult, Exec } from '../../server/exec/command.js';
import { completeStages, makeRig, type Rig } from '../fixtures/docs-repo-rig.js';

let rig: Rig | null = null;
afterEach(async () => {
  await rig?.close();
  rig = null;
});

const done = (stdout = ''): CommandResult => ({ exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, durationMs: 1, truncated: false });

describe('steps 1 to 6 of a documentation repository', () => {
  it('create a project and run the five document stages with no git and no gh command', async () => {
    const commands: string[] = [];
    const spy: Exec = async (spec) => {
      commands.push(`${spec.bin} ${spec.args.join(' ')}`);
      return done();
    };
    rig = await makeRig({ docsRepoLayout: true, owner: 'acme', exec: spy, ghExec: spy });
    const s = await rig.registry.newProject('hello-app', 'Hello');
    await completeStages(rig, s);
    expect(s.state.docsRepo).toBe(true);
    expect(s.state.stages).toBe(true);
    expect(commands.filter((c) => /^(git|gh) /.test(c))).toEqual([]);
    await s.close();
  });
});
