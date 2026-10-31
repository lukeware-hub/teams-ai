import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isConfidential } from '../../server/chat/confidential.js';
import { loadConfig } from '../../server/config/config.js';
import { writeRun } from '../fixtures/runs/write-run.js';

const HELLO = path.resolve('test/fixtures/hello-app');
let home = '';
let dir = '';

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-confidential-'));
  dir = path.join(home, 'project');
  await fs.cp(HELLO, dir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const check = () => isConfidential({ cfg: loadConfig({ paths: { workspaces: path.join(home, 'ws').split('\\').join('/') }, projects: [{ dir }] }), home, dir, projectId: 'hello-app' });
/** The refinement journal of the example spec, as the owner's answers left it. */
const refine = (events: Array<{ type: string; data?: Record<string, unknown> }>) => writeRun(path.join(home, 'ws', 'hello-app', 'refine'), 'hello-001', events);

describe('whether a project is confidential, for the web search of the chat', () => {
  it('is not confidential when the owner has not said so and no refinement says otherwise', async () => {
    expect(await check()).toBe(false);
  });

  it('is confidential when the project file says so', async () => {
    const project = JSON.parse(await fs.readFile(path.join(dir, 'docs', 'project.json'), 'utf8'));
    await fs.writeFile(path.join(dir, 'docs', 'project.json'), JSON.stringify({ ...project, confidential: true }));
    expect(await check()).toBe(true);
  });

  it('is confidential while a refinement answers yes, and not once the owner answers no', async () => {
    await refine([{ type: 'REFINE_CREATED', data: { stages: true } }, { type: 'REFINE_CONFIDENTIALITY_ANSWERED', data: { confidential: true } }]);
    expect(await check()).toBe(true);
    await fs.rm(path.join(home, 'ws', 'hello-app', 'refine'), { recursive: true, force: true });
    await refine([{ type: 'REFINE_CREATED', data: { stages: true } }, { type: 'REFINE_CONFIDENTIALITY_ANSWERED', data: { confidential: false } }]);
    expect(await check()).toBe(false);
  });

  it('is confidential for a stage session that has not answered yet', async () => {
    await refine([{ type: 'REFINE_CREATED', data: { stages: true } }]);
    expect(await check()).toBe(true);
  });

  it('is confidential when a refinement record cannot be read', async () => {
    await refine([]);
    await fs.writeFile(path.join(home, 'ws', 'hello-app', 'refine', 'hello-001', 'events.ndjson'), '{"seq":2}\n');
    expect(await check()).toBe(true);
  });
});
