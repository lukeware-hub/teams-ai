import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeDocsMarker, writeState } from '../../server/docs/project-state.js';
import { ConflictError } from '../../server/refine/session.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';
import { makeRig, PROJECT, type Rig } from '../fixtures/docs-repo-rig.js';

const BOUND = '0123456789abcdef0123456789abcdef01234567';
const PROJECT_JSON = `${JSON.stringify(makeProject(), null, 2)}\n`;
const UNPUBLISHED = /o repositório de documentos deste projeto ainda não foi publicado/;
const TAKEN = /already exists on main/;
const ANOTHER_NAME = /informe outro nome para a primeira spec/;
const NOT_CREATED = /o repositório de documentos ainda não foi criado/;

let rig: Rig;

afterEach(async () => {
  await rig?.close();
});

describe('a documentation repository whose first push has not landed', () => {
  it('refuses a new spec in plain words, without reading a clone', async () => {
    rig = await makeRig({ docsRepoLayout: true });
    await writeDocsMarker(rig.ws, { layout: 'docs-repo', style: 'monolith', target: { owner: 'acme', name: PROJECT }, firstSha: null });
    await writeState(rig.ws, 'project.json', PROJECT_JSON);
    const refusal = rig.registry.newSpec(PROJECT, 'alpha-001');
    await expect(refusal).rejects.toBeInstanceOf(ConflictError);
    await expect(refusal).rejects.toThrow(UNPUBLISHED);
  });

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
