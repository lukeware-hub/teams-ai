import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeDocsMarker, writeState } from '../../server/docs/project-state.js';
import { createNewProject, draftPaths } from '../../server/refine/draft.js';
import { ConflictError } from '../../server/refine/session.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';
import { makeRig, PROJECT, type Rig } from '../fixtures/docs-repo-rig.js';

const BOUND = '0123456789abcdef0123456789abcdef01234567';
const PROJECT_JSON = `${JSON.stringify(makeProject(), null, 2)}\n`;
const TAKEN = /já existe na main/;
const ANOTHER_NAME = /informe outro nome para a primeira spec/;
const NOT_CREATED = /o repositório de documentos ainda não foi criado/;

let rig: Rig;

afterEach(async () => {
  await rig?.close();
});

describe('a spec the mirror already holds', () => {
  it('refuses a spec the mirror already holds as taken, without asking for a workspace clone', async () => {
    rig = await makeRig({ docsRepoLayout: true });
    await writeDocsMarker(rig.ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: PROJECT }, firstSha: BOUND });
    await writeState(rig.ws, 'project.json', PROJECT_JSON);
    await writeState(rig.ws, 'specs/taken-001/spec.json', `${JSON.stringify(makeSpec({ specId: 'taken-001' }), null, 2)}\n`);
    await expect(rig.registry.newSpec(PROJECT, 'taken-001')).rejects.toThrow(TAKEN);
  });
});

describe('the default first spec of a project name', () => {
  it('asks for another first spec when the name makes an invalid alias, and writes nothing', async () => {
    rig = await makeRig({ docsRepoLayout: true });
    const refusal = rig.registry.newProject('a'.repeat(37), 'Hello');
    await expect(refusal).rejects.toBeInstanceOf(ConflictError);
    await expect(refusal).rejects.toThrow(ANOTHER_NAME);
    expect(await fs.readdir(path.join(rig.ws.root, 'refine')).catch(() => [])).toEqual([]);
  });
});

describe('a spec of a project whose documentation repository is not created yet', () => {
  it('refuses it in plain words when the flag is on', async () => {
    rig = await makeRig({ docsRepoLayout: true });
    await expect(rig.registry.newSpec(PROJECT, 'alpha-001')).rejects.toThrow(NOT_CREATED);
  });

  it('keeps the legacy message when the flag is off', async () => {
    rig = await makeRig({ docsRepoLayout: false });
    await expect(rig.registry.newSpec(PROJECT, 'alpha-001')).rejects.toThrow(/has no workspace clone/);
  });
});

/** A bound documentation repository whose mirror holds the project, so a spec can be created or continued. */
async function boundMirror(): Promise<void> {
  rig = await makeRig({ docsRepoLayout: true });
  await writeDocsMarker(rig.ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: PROJECT }, firstSha: BOUND });
  await writeState(rig.ws, 'project.json', PROJECT_JSON);
}

describe('a spec that cannot be created or continued', () => {
  it('refuses a spec whose refinement is already open, and asks for another name', async () => {
    await boundMirror();
    await createNewProject(draftPaths(rig.ws, 'open-002'), 'Hello');
    await expect(rig.registry.newSpec(PROJECT, 'open-002')).rejects.toThrow('A spec open-002 já tem um refinamento. Escolha outro nome para a spec.');
  });

  it('refuses to continue a concluded spec, and asks for a new one', async () => {
    await boundMirror();
    await writeState(rig.ws, 'specs/done-001/spec.json', `${JSON.stringify(makeSpec({ specId: 'done-001', status: 'done' }), null, 2)}\n`);
    await expect(rig.registry.continueSpec(PROJECT, 'done-001')).rejects.toThrow('A spec done-001 já foi concluída. Crie uma nova spec.');
  });

  it('refuses to continue a spec that is not awaiting validation on main', async () => {
    await boundMirror();
    await writeState(rig.ws, 'specs/running-001/spec.json', `${JSON.stringify(makeSpec({ specId: 'running-001', status: 'running' }), null, 2)}\n`);
    await expect(rig.registry.continueSpec(PROJECT, 'running-001')).rejects.toThrow('A spec running-001 não está aguardando validação na main. Só specs aguardando validação podem continuar.');
  });
});
