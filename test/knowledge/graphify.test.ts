import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Graphify, MIN_COVERAGE, grepFallback, parseAffected, parseGodNodes, parseQuery } from '../../server/knowledge/graphify.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const fx = (name: string) => readFileSync(path.resolve(`test/fixtures/graphify/${name}`), 'utf8');

describe('parsers', () => {
  it('parses query nodes, keeps the truncation flag and drops nodes without a source', () => {
    const r = parseQuery(fx('query.txt'));
    expect(r.truncated).toBe(true);
    expect(r.nodes).toEqual([
      { label: 'stream-events.ts', file: 'server/runner/stream-events.ts', line: 1 },
      { label: 'StreamEvent', file: 'server/runner/stream-events.ts', line: 3 },
      { label: 'RateLimitInfo', file: 'server/runner/stream-events.ts', line: 63 },
    ]);
  });

  it('parses affected nodes with their relation', () => {
    expect(parseAffected(fx('affected.txt'))).toEqual([
      { label: 'process-runner.ts', relation: 'imports', file: 'server/runner/process-runner.ts', line: 6 },
      { label: 'runProcess()', relation: 'calls', file: 'server/runner/process-runner.ts', line: 130 },
    ]);
  });

  it('parses god nodes', () => {
    expect(parseGodNodes(fx('god-nodes.txt'))).toEqual([
      { label: 'DeploymentIntent', edges: 23 },
      { label: 'DockerLocalTarget', edges: 14 },
      { label: 'git()', edges: 13 },
    ]);
  });

  it('returns empty results for unexpected text', () => {
    expect(parseQuery('graphify: error: no graph found')).toEqual({ nodes: [], truncated: false });
    expect(parseAffected('')).toEqual([]);
    expect(parseGodNodes('nothing')).toEqual([]);
  });
});

describe('Graphify', () => {
  const files = (map: Record<string, string>) => async (p: string) => map[p.replace(/\\/g, '/')] ?? null;

  it('runs update inside the repo, then moves graphify-out outside it and reports coverage', async () => {
    const fake = new FakeExec();
    const moves: Array<[string, string]> = [];
    const g = new Graphify({
      exec: fake.exec,
      readFile: files({ '/ws/graph/graphify-out/graph.json': fx('graph.json') }),
      moveDir: async (from, to) => void moves.push([from.replace(/\\/g, '/'), to.replace(/\\/g, '/')]),
    });
    const cov = await g.update('/ws/repo', '/ws/graph');
    // graphify writes graphify-out/ next to the path it scans; the graph must not live in the repository (spec §9).
    expect(fake.calls[0]).toMatchObject({ bin: 'graphify', args: ['update', '.', '--no-cluster'], cwd: '/ws/repo' });
    expect(moves).toEqual([['/ws/repo/graphify-out', '/ws/graph/graphify-out']]);
    expect(cov).toEqual({ extracted: 3, failed: 1, nodes: 2, links: 1, ratio: 0.75 });
  });

  it('reports zero coverage when graph.json is missing or has no sources', async () => {
    const g = new Graphify({ exec: new FakeExec().exec, readFile: files({}) });
    expect(await g.coverage('/ws/graph')).toEqual({ extracted: 0, failed: 0, nodes: 0, links: 0, ratio: 0 });
    const empty = new Graphify({ exec: new FakeExec().exec, readFile: files({ '/ws/graph/graphify-out/graph.json': '{"nodes":[],"links":[],"extracted_sources":[],"failed_sources":[]}' }) });
    expect((await empty.coverage('/ws/graph')).ratio).toBe(0);
    expect(MIN_COVERAGE).toBe(0.5);
  });

  it('passes --graph and the budget to query, depth to affected, top to god-nodes', async () => {
    const fake = new FakeExec()
      .onArgs('graphify', ['query'], () => ({ stdout: fx('query.txt') }))
      .onArgs('graphify', ['affected'], () => ({ stdout: fx('affected.txt') }))
      .onArgs('graphify', ['god-nodes'], () => ({ stdout: fx('god-nodes.txt') }));
    const g = new Graphify({ exec: fake.exec, readFile: files({}) });
    const q = await g.query('/ws/graph', 'how are results summarized', 400);
    expect(q.nodes).toHaveLength(3);
    expect(q.truncated).toBe(true);
    expect(fake.lines('graphify')[0]).toBe('query how are results summarized --budget 400 --graph /ws/graph/graphify-out/graph.json');
    expect((await g.affected('/ws/graph', 'summarizeStream', 2))[1]!.relation).toBe('calls');
    expect(fake.lines('graphify')[1]).toBe('affected summarizeStream --depth 2 --graph /ws/graph/graphify-out/graph.json');
    expect(await g.godNodes('/ws/graph', 3)).toHaveLength(3);
  });

  it('returns empty results instead of throwing when graphify fails', async () => {
    const fake = new FakeExec().on((s) => s.bin === 'graphify', () => ({ exitCode: 1, stderr: 'no graph' }));
    const g = new Graphify({ exec: fake.exec, readFile: files({}) });
    expect(await g.query('/ws/graph', 'x', 100)).toEqual({ nodes: [], truncated: false, text: '' });
    expect(await g.affected('/ws/graph', 'x', 1)).toEqual([]);
  });
});

describe('grepFallback', () => {
  it('searches tracked files case-insensitively and parses file:line:text', async () => {
    const fake = new FakeExec().onArgs('git', ['grep'], () => ({ stdout: 'src/a.ts:12:const discount = 5;\nsrc/b.ts:3:// Discount rules\n' }));
    const hits = await grepFallback('/ws/repo', ['discount', 'vip'], fake.exec);
    expect(hits).toEqual([
      { file: 'src/a.ts', line: 12, text: 'const discount = 5;' },
      { file: 'src/b.ts', line: 3, text: '// Discount rules' },
    ]);
    expect(fake.calls[0]).toMatchObject({ bin: 'git', cwd: '/ws/repo', args: ['grep', '-n', '-I', '-i', '-e', 'discount', '-e', 'vip', '--', '.'] });
  });

  it('caps hits and tolerates exit code 1 (no match)', async () => {
    const fake = new FakeExec().onArgs('git', ['grep'], () => ({ exitCode: 1 }));
    expect(await grepFallback('/ws/repo', ['zzz'], fake.exec)).toEqual([]);
    const many = new FakeExec().onArgs('git', ['grep'], () => ({ stdout: Array.from({ length: 50 }, (_, i) => `f.ts:${i + 1}:x`).join('\n') }));
    expect(await grepFallback('/ws/repo', ['x'], many.exec, { maxHits: 5 })).toHaveLength(5);
  });
});

describe('coverage from AST graphs', () => {
  const files = (map: Record<string, string>) => async (p: string) => map[p.replace(/\\/g, '/')] ?? null;
  const astGraph = JSON.stringify({
    nodes: [
      { id: 'a', label: 'a.ts', source_file: 'src/a.ts', _origin: 'ast' },
      { id: 'a_fn', label: 'fn()', source_file: 'src/a.ts', _origin: 'ast' },
      { id: 'b', label: 'b.ts', source_file: 'src/b.ts', _origin: 'ast' },
      { id: 'doc', label: 'README', source_file: 'README.md', _origin: 'ast' },
      { id: 'ref', label: 'ref_zod', source_file: '', _origin: 'ast' },
    ],
    links: [{ source: 'a', target: 'b', relation: 'imports' }],
    extracted_sources: [],
    failed_sources: [],
  });

  it('measures coverage as code files in the graph over tracked code files when the source lists are empty', async () => {
    const fake = new FakeExec().onArgs('git', ['ls-files'], () => ({ stdout: 'src/a.ts\nsrc/b.ts\nsrc/c.ts\nsrc/d.py\nREADME.md\npackage.json\n' }));
    const g = new Graphify({ exec: fake.exec, readFile: files({ '/ws/graph/graphify-out/graph.json': astGraph }), moveDir: async () => undefined });
    const cov = await g.update('/ws/repo', '/ws/graph');
    expect(fake.calls.find((c) => c.bin === 'git')).toMatchObject({ args: ['ls-files'], cwd: '/ws/repo' });
    expect(cov).toEqual({ extracted: 2, failed: 2, nodes: 5, links: 1, ratio: 0.5 });
  });

  it('counts only code extensions as tracked sources', async () => {
    const fake = new FakeExec().onArgs('git', ['ls-files'], () => ({ stdout: 'src/a.ts\nsrc/b.ts\ndocs/x.md\nimg.png\n' }));
    const g = new Graphify({ exec: fake.exec, readFile: files({ '/ws/graph/graphify-out/graph.json': astGraph }), moveDir: async () => undefined });
    expect((await g.update('/ws/repo', '/ws/graph')).ratio).toBe(1);
  });
});
