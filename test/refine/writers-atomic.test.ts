import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Workspace } from '../../server/orchestrator/workspace.js';
import { createNewProject, draftPaths, moveBriefingToProject, writeDoc } from '../../server/refine/draft.js';

let root = '';
let ws: Workspace;

beforeEach(async () => {
  root = (await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-writers-'))).replace(/\\/g, '/');
  ws = { projectId: 'hello-app', root, repo: `${root}/repo`, worktrees: `${root}/worktrees`, graph: `${root}/graph`, knowledgeDb: `${root}/k.sqlite`, secrets: `${root}/secrets`, runs: `${root}/runs` };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const temporaryFiles = async (dir: string): Promise<string[]> => (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'));

describe('atomic writes of the draft', () => {
  it('writeDoc stores the exact text and leaves no temporary file beside it', async () => {
    const d = draftPaths(ws, 'hello-050');
    await createNewProject(d, 'Hello App');
    const text = '# Projeto\n\nTexto com acentos: ção ✓\n';
    await writeDoc(d, 'project.md', text);
    expect(await fs.readFile(d.projectMd, 'utf8')).toBe(text);
    expect(await temporaryFiles(d.docs)).toEqual([]);
  });

  it('moveBriefingToProject writes the merged briefing and leaves no temporary file beside it', async () => {
    const d = draftPaths(ws, 'hello-051');
    await createNewProject(d, 'Hello App', 'Add a goodbye endpoint.');
    await fs.writeFile(`${d.docs}/briefing.md`, '# Briefing\n');
    await moveBriefingToProject(d);
    const merged = await fs.readFile(`${d.docs}/briefing.md`, 'utf8');
    expect(merged.startsWith('# Briefing\n\n## Nova demanda (hello-051)\n\n### Description\n\nAdd a goodbye endpoint.')).toBe(true);
    expect(merged.endsWith('\n')).toBe(true);
    expect(await temporaryFiles(d.docs)).toEqual([]);
  });
});
