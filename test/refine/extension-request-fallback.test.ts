import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { makeProject } from '../fixtures/contracts.js';
import { makeRig, PROJECT, type Rig } from '../fixtures/docs-repo-rig.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

/** Main of a project that never had a backlog: its documents, and no backlog index. */
const MAIN_WITHOUT_BACKLOG: Record<string, string> = {
  'docs/project.json': `${JSON.stringify(makeProject({ projectId: PROJECT }), null, 2)}\n`,
  'docs/project.md': '# Projeto\n\nVisão do produto.\n',
  'docs/briefing.md': '# Briefing\n\nO pedido do projeto.\n',
  'docs/flow.md': '# Fluxo\n\n1. Login\n',
  'docs/stack.md': '# Stack\n\nNode 22.\n',
  'docs/design.md': '# Design\n\nTela simples.\n',
};

let rig: Rig;
let remote: Remote;

beforeEach(async () => {
  remote = await makeRemote(MAIN_WITHOUT_BACKLOG);
  rig = await makeRig({ docsRepoLayout: false, exec: execCommand });
  await fs.mkdir(path.dirname(rig.ws.repo), { recursive: true });
  await git(path.dirname(rig.ws.repo), ['clone', '-q', remote.origin, rig.ws.repo], execCommand);
  // The agent suggests the id of the one spec the request becomes.
  rig.script['name/po'] = [{ id: 'exportar-pdf' }];
});
afterEach(async () => {
  await rig.close();
  await remote.cleanup();
});

describe('a request in a project with no backlog on main', () => {
  it('takes the request as one spec under the suggested id', async () => {
    const s = await rig.registry.addRequest(PROJECT, 'Exportar o relatório mensal em PDF.');
    try {
      expect(s.state.mode).toBe('new-spec');
      expect((await s.snapshot()).specId).toBe('exportar-pdf');
    } finally {
      await s.settled();
    }
  });
});
