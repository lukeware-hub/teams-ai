import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { webSearchAllowed } from '../../server/chat/web-access.js';
import { loadConfig } from '../../server/config/config.js';
import { writeRun } from '../fixtures/runs/write-run.js';

const HELLO = path.resolve('test/fixtures/hello-app');
let home = '';
let dir = '';

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-web-access-'));
  dir = path.join(home, 'project');
  await fs.cp(HELLO, dir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const allowed = () => webSearchAllowed({ cfg: loadConfig({ paths: { workspaces: path.join(home, 'ws').split('\\').join('/') }, projects: [{ dir }] }), home, dir, projectId: 'hello-app' });
/** The refinement journal of the example spec, as the owner's answers left it. */
const refine = (events: Array<{ type: string; data?: Record<string, unknown> }>) => writeRun(path.join(home, 'ws', 'hello-app', 'refine'), 'hello-001', events);

describe('whether the chat may search the web about a project', () => {
  it('allows a project the owner has not marked confidential, with no refinement in question', async () => {
    expect(await allowed()).toBe(true);
  });

  it('refuses a project marked confidential', async () => {
    const project = JSON.parse(await fs.readFile(path.join(dir, 'docs', 'project.json'), 'utf8'));
    await fs.writeFile(path.join(dir, 'docs', 'project.json'), JSON.stringify({ ...project, confidential: true }));
    expect(await allowed()).toBe(false);
  });

  it('refuses while a refinement answers yes to confidentiality, and allows once the owner answers no', async () => {
    await refine([{ type: 'REFINE_CREATED', data: { stages: true } }, { type: 'REFINE_CONFIDENTIALITY_ANSWERED', data: { confidential: true } }]);
    expect(await allowed()).toBe(false);
    await fs.rm(path.join(home, 'ws', 'hello-app', 'refine'), { recursive: true, force: true });
    await refine([{ type: 'REFINE_CREATED', data: { stages: true } }, { type: 'REFINE_CONFIDENTIALITY_ANSWERED', data: { confidential: false } }]);
    expect(await allowed()).toBe(true);
  });

  it('refuses a stage session that has not yet been asked about confidentiality', async () => {
    await refine([{ type: 'REFINE_CREATED', data: { stages: true } }]);
    expect(await allowed()).toBe(false);
  });

  it('refuses when a refinement journal cannot be read', async () => {
    await refine([]);
    await fs.writeFile(path.join(home, 'ws', 'hello-app', 'refine', 'hello-001', 'events.ndjson'), '{"seq":2}\n');
    expect(await allowed()).toBe(false);
  });
});
