import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphLinkResolver, type GraphLinkDeps } from '../../server/api/graph-links.js';
import type { GraphViewNode } from '../../server/api/repository-graph.js';
import { blobUrl } from '../../server/api/run-routes.js';

let dir = '';
let commit = '';
const run = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const node = (file: string, over: Partial<GraphViewNode> = {}): GraphViewNode => ({ id: file, label: file, repo: 'shop', file, line: 1, community: '', edges: 1, url: null, ...over });
const deps = (repoUrl: string | null): GraphLinkDeps => ({
  blobUrl,
  repoUrlOf: async () => repoUrl,
  git: async (cwd, args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  },
});

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'graph-links-'));
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 't@t.t']);
  run(['config', 'user.name', 't']);
  mkdirSync(path.join(dir, 'docs', 'with space'), { recursive: true });
  writeFileSync(path.join(dir, 'docs', 'brief.md'), '# brief\n');
  writeFileSync(path.join(dir, 'docs', 'with space', 'a b.md'), '# spaced\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'init']);
  commit = run(['rev-parse', 'HEAD']);
  // The commit is on the remote, as it is for a clone that was fetched and not changed.
  run(['update-ref', 'refs/remotes/origin/main', commit]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const REPO = 'https://github.com/acme/shop';

describe('graph link resolver', () => {
  it('links a file the commit holds, with the commit and the line', async () => {
    const resolve = graphLinkResolver(deps(REPO), { shop: dir });
    expect(await resolve(node('docs/brief.md', { line: 7 }))).toBe(`${REPO}/blob/${commit}/docs/brief.md#L7`);
  });

  it('uses line 1 when the node has no line, and encodes a path with spaces', async () => {
    const resolve = graphLinkResolver(deps(REPO), { shop: dir });
    expect(await resolve(node('docs/with space/a b.md', { line: null }))).toBe(`${REPO}/blob/${commit}/docs/with%20space/a%20b.md#L1`);
  });

  it('tries the path again without the folder name some graphs put in front', async () => {
    const resolve = graphLinkResolver(deps(REPO), { shop: dir });
    expect(await resolve(node('shop/docs/brief.md'))).toBe(`${REPO}/blob/${commit}/docs/brief.md#L1`);
  });

  it('gives no link for a file the commit does not hold', async () => {
    const resolve = graphLinkResolver(deps(REPO), { shop: dir });
    expect(await resolve(node('docs/gone.md'))).toBeNull();
  });

  it('gives no link for a path that leaves the repository', async () => {
    const resolve = graphLinkResolver(deps(REPO), { shop: dir });
    expect(await resolve(node('x/../../etc/passwd'))).toBeNull();
    expect(await resolve(node('/etc/passwd'))).toBeNull();
  });

  it('gives no link when the clone has no GitHub page, or the node belongs to no clone', async () => {
    expect(await graphLinkResolver(deps(null), { shop: dir })(node('docs/brief.md'))).toBeNull();
    expect(await graphLinkResolver(deps(REPO), { shop: dir })(node('docs/brief.md', { repo: 'other' }))).toBeNull();
    expect(await graphLinkResolver(deps(REPO), { shop: dir })(node('docs/brief.md', { repo: 'constructor' }))).toBeNull();
  });

  it('gives no link for a commit no remote branch holds yet', async () => {
    writeFileSync(path.join(dir, 'docs', 'local.md'), '# local');
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'local only']);
    try {
      expect(await graphLinkResolver(deps(REPO), { shop: dir })(node('docs/local.md'))).toBeNull();
    } finally {
      run(['reset', '-q', '--hard', commit]);
    }
  });

  it('gives no link when git fails in the clone', async () => {
    expect(await graphLinkResolver(deps(REPO), { shop: path.join(dir, 'not-a-clone') })(node('docs/brief.md'))).toBeNull();
  });
});
