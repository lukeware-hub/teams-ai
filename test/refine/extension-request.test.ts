import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execCommand } from '../../server/exec/command.js';
import { git } from '../../server/git/git.js';
import { draftPaths } from '../../server/refine/draft.js';
import { makeProject } from '../fixtures/contracts.js';
import { makeRig, PROJECT, type Rig } from '../fixtures/docs-repo-rig.js';
import { makeRemote, type Remote } from '../fixtures/git-remote.js';

const SPECS = {
  version: 1,
  draftId: 'shop-001',
  epics: [{ key: 'core', title: 'Núcleo' }],
  specs: [{ specId: 'shop-001-login', key: 'login', title: 'Entrar', epic: 'core', priority: 'P0', rank: 1, size: 'M', scope: 'Entrar', rationale: 'base', dependsOn: [], sources: [{ doc: 'flow.md', heading: '1. Login' }] }],
};
/** Main of the project: its five documents and the backlog index of a project that already has specs. */
const MAIN: Record<string, string> = {
  'docs/project.json': `${JSON.stringify(makeProject({ projectId: PROJECT }), null, 2)}\n`,
  'docs/project.md': '# Projeto\n\nVisão do produto.\n',
  'docs/briefing.md': '# Briefing\n\nO pedido do projeto.\n',
  'docs/flow.md': '# Fluxo\n\n1. Login\n',
  'docs/stack.md': '# Stack\n\nNode 22.\n',
  'docs/design.md': '# Design\n\nTela simples.\n',
  'docs/specs.json': `${JSON.stringify(SPECS, null, 2)}\n`,
};

let rig: Rig;
let remote: Remote;

beforeEach(async () => {
  remote = await makeRemote(MAIN);
  rig = await makeRig({ docsRepoLayout: false, exec: execCommand });
  // The project's clone of main, where the follow-on reads the documents and the backlog index.
  await fs.mkdir(path.dirname(rig.ws.repo), { recursive: true });
  await git(path.dirname(rig.ws.repo), ['clone', '-q', remote.origin, rig.ws.repo], execCommand);
});
afterEach(async () => {
  await rig.close();
  await remote.cleanup();
});

describe('a request in a project already in development', () => {
  it('starts a follow-on backlog whose brief is the text, and names its specs after main', async () => {
    const s = await rig.registry.addRequest(PROJECT, 'Exportar o relatório mensal em PDF.');
    try {
      expect(s.state.extension).toMatchObject({ requestId: 'pedido-1', text: 'Exportar o relatório mensal em PDF.' });
      expect(s.state.backlog).toMatchObject({ enabled: true, idBase: 'shop-001' });
      expect(s.state.extension?.before).toEqual([{ key: 'login', specId: 'shop-001-login', title: 'Entrar', rank: 1, dependsOn: [] }]);
      const draft = draftPaths(rig.ws, 'hello-app-pedido-1');
      const briefing = await fs.readFile(path.join(draft.docs, 'briefing.md'), 'utf8');
      expect(briefing).toContain('## Pedido pedido-1');
      expect(briefing).toContain('Exportar o relatório mensal em PDF.');
    } finally {
      await s.settled();
    }
  });

  it('takes a second request at once and runs its team only after the team of the first has stopped', async () => {
    const first = await rig.registry.addRequest(PROJECT, 'Primeiro pedido.');
    const second = await rig.registry.addRequest(PROJECT, 'Segundo pedido.');
    try {
      expect(second.state.extension).toMatchObject({ requestId: 'pedido-2', text: 'Segundo pedido.' });
      for (let i = 0; i < 400 && second.state.autopilot?.status !== 'stopped'; i++) await new Promise((r) => setTimeout(r, 50));
      expect(second.state.autopilot?.status).toBe('stopped');
      const stoppedAt = first.events.find((e) => e.type === 'TEAM_AUTOPILOT_STOPPED')!.at;
      const startedAt = second.events.find((e) => e.type === 'TEAM_AUTOPILOT_STARTED')!.at;
      expect(Date.parse(startedAt!)).toBeGreaterThanOrEqual(Date.parse(stoppedAt!));
    } finally {
      await first.settled();
      await second.settled();
    }
  });
});
