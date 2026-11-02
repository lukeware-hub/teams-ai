import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { docsMirrorDir, readState, updateState, writeState } from '../../server/docs/project-state.js';

let root: string;
const at = () => ({ root });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-mirror-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('mirror state', () => {
  it('round-trips a JSON file written as text', async () => {
    await writeState(at(), 'project.json', '{"id":"kayron"}\n');
    expect(await readState(at(), 'project.json')).toEqual({ id: 'kayron' });
  });

  it('reads a missing file as absent', async () => {
    expect(await readState(at(), 'plan.json')).toBeUndefined();
  });

  it('reads an unparsable file as absent', async () => {
    await writeState(at(), 'plan.json', '{not json');
    expect(await readState(at(), 'plan.json')).toBeUndefined();
  });

  it('creates the folders of a nested path', async () => {
    await writeState(at(), 'specs/alpha/spec.json', '{"alias":"alpha"}');
    expect(await readState(at(), 'specs/alpha/spec.json')).toEqual({ alias: 'alpha' });
    expect(await fs.readFile(path.join(docsMirrorDir(at()), 'specs', 'alpha', 'spec.json'), 'utf8')).toBe('{"alias":"alpha"}');
  });

  it('updates a file from its parsed content', async () => {
    await writeState(at(), 'report.json', '{}');
    await updateState(at(), 'report.json', (current) => JSON.stringify({ ...(current as object), first: 1 }));
    await updateState(at(), 'report.json', (current) => JSON.stringify({ ...(current as object), second: 2 }));
    expect(await readState(at(), 'report.json')).toEqual({ first: 1, second: 2 });
  });

  it('leaves the file alone when the update returns undefined', async () => {
    await writeState(at(), 'report.json', '{"kept":true}');
    await updateState(at(), 'report.json', () => undefined);
    expect(await readState(at(), 'report.json')).toEqual({ kept: true });
  });

  it('refuses an unparsable file instead of rewriting it from nothing', async () => {
    await writeState(at(), 'report.json', '{broken');
    await expect(updateState(at(), 'report.json', () => '{}')).rejects.toThrow();
    expect(await fs.readFile(path.join(docsMirrorDir(at()), 'report.json'), 'utf8')).toBe('{broken');
  });

  it('refuses a file the mirror does not have, so a status is never silently skipped', async () => {
    await expect(updateState(at(), 'specs/alpha/spec.json', () => '{}')).rejects.toThrow('the mirror has no specs/alpha/spec.json');
  });
});
