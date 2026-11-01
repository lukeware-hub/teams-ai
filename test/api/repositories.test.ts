import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Architecture } from '../../server/contracts/architecture.js';
import { historyOf, loadRepoSource, repositoryCards, repositoryDetail, statusOf, type RepoSource, type RepoSpec } from '../../server/api/repositories.js';

const ARCH: Architecture = {
  style: 'microservices',
  rationale: 'Two parts.',
  repositories: [
    { name: 'shop-api', responsibility: 'Sells', evidence: { doc: 'project.md', quote: 'sells' } },
    { name: 'shop-web', responsibility: 'Shows', evidence: { doc: 'design.md', quote: 'shows' } },
  ],
  integrations: [
    { consumer: 'shop-web', provider: 'shop-api', contract: 'GET /cart' },
    { consumer: 'shop-api', provider: 'shop-api', contract: 'x' },
  ],
};

const spec = (specId: string, repository: string, status: string, extra: Partial<RepoSpec> = {}): RepoSpec => ({
  specId,
  key: null,
  status,
  activeRunId: null,
  repository,
  title: null,
  priority: null,
  dependsOn: [],
  plan: false,
  tasks: 0,
  blocked: false,
  ...extra,
});

describe('status of a repository', () => {
  it('shows the worst state among its specs, retired ones aside', () => {
    expect(statusOf([])).toBe('empty');
    expect(statusOf([spec('a', 'r', 'done'), spec('b', 'r', 'retired')])).toBe('done');
    expect(statusOf([spec('a', 'r', 'done'), spec('b', 'r', 'refining')])).toBe('refining');
    expect(statusOf([spec('a', 'r', 'awaiting-validation'), spec('b', 'r', 'refining')])).toBe('waiting');
    expect(statusOf([spec('a', 'r', 'awaiting-validation'), spec('b', 'r', 'running')])).toBe('running');
    expect(statusOf([spec('a', 'r', 'running'), spec('b', 'r', 'paused:quota')])).toBe('blocked');
  });

  it('counts a spec with an active run as running even when its status says otherwise', () => {
    expect(statusOf([spec('a', 'r', 'refining', { activeRunId: 'run-1' })])).toBe('running');
  });
});

describe('cards and dashboard of the repositories', () => {
  const src: RepoSource = {
    architecture: ARCH,
    specs: [
      spec('cart', 'shop-api', 'done', { plan: true, tasks: 3 }),
      spec('pay', 'shop-api', 'paused:quota', { plan: true, tasks: 2 }),
      spec('catalog', 'shop-web', 'refining', { tasks: 1 }),
    ],
  };

  it('gives one card per repository, in the order the architecture names them', () => {
    expect(repositoryCards(src)).toEqual([
      { name: 'shop-api', kind: 'api', responsibility: 'Sells', status: 'blocked', specs: 2, plans: 2, tasks: 5, tasksDone: 3, fixes: 0, deployFixes: 0, blockers: 1 },
      { name: 'shop-web', kind: 'web', responsibility: 'Shows', status: 'refining', specs: 1, plans: 0, tasks: 1, tasksDone: 0, fixes: 0, deployFixes: 0, blockers: 0 },
    ]);
  });

  it('counts the fix and deploy-fix tasks of a repository apart from its planned tasks', () => {
    const src: RepoSource = { architecture: ARCH, specs: [{ ...spec('cart', 'shop-api', 'done', { plan: true, tasks: 3 }), fixes: 2, deployFixes: 1 }] };
    expect(repositoryCards(src)[0]).toMatchObject({ tasks: 3, fixes: 2, deployFixes: 1 });
  });

  it('gives the dashboard of a repository with its integrations, and nothing for a name the architecture does not give', () => {
    const detail = repositoryDetail(src, 'shop-web');
    expect(detail?.integrations).toEqual(['shop-web → shop-api: GET /cart']);
    expect(detail?.rows.map((r) => r.specId)).toEqual(['catalog']);
    expect(repositoryDetail(src, 'shop-cli')).toBeNull();
  });
});

describe('blockers and history', () => {
  it('counts a spec with a root blocked task as blocked, and gives the task and its cause in the dashboard', () => {
    const src: RepoSource = {
      architecture: ARCH,
      specs: [spec('cart', 'shop-api', 'running'), spec('pay', 'shop-api', 'refining')],
      rootBlocks: [{ specId: 'cart', taskId: 'T2-reserve', reason: 'o banco recusou a conexão' }],
    };
    expect(repositoryCards(src)[0]).toMatchObject({ status: 'blocked', blockers: 1 });
    expect(repositoryDetail(src, 'shop-api')?.rootBlocks).toEqual([{ specId: 'cart', taskId: 'T2-reserve', reason: 'o banco recusou a conexão' }]);
  });

  it('counts a spec the program stopped with a reason as blocked, once, and gives the reason in the dashboard', () => {
    const src: RepoSource = {
      architecture: ARCH,
      specs: [spec('cart', 'shop-api', 'running'), spec('pay', 'shop-api', 'refining')],
      programStops: [{ specId: 'cart', status: 'failed', reason: 'a verificação falhou' }, { specId: 'cart', status: 'blocked', reason: 'de novo' }],
    };
    expect(repositoryCards(src)[0]).toMatchObject({ status: 'blocked', blockers: 1 });
    expect(repositoryDetail(src, 'shop-api')?.reasons).toEqual([
      { specId: 'cart', status: 'failed', reason: 'a verificação falhou' },
      { specId: 'cart', status: 'blocked', reason: 'de novo' },
    ]);
  });

  it('counts a pending blocking question on a spec of the repository as one of its blockers, and lists the missing secrets', () => {
    const src: RepoSource = {
      architecture: ARCH,
      specs: [{ ...spec('cart', 'shop-api', 'refining'), key: 'cart' }, spec('catalog', 'shop-web', 'refining')],
      questions: [{ itemKey: 'cart', text: 'Quem paga?' }, { itemKey: 'other', text: 'Outra?' }],
      missingSecrets: ['STRIPE_KEY'],
    };
    expect(repositoryCards(src)[0]).toMatchObject({ name: 'shop-api', blockers: 1 });
    expect(repositoryCards(src)[1]).toMatchObject({ name: 'shop-web', blockers: 0 });
    expect(repositoryDetail(src, 'shop-api')).toMatchObject({ questions: [{ itemKey: 'cart', text: 'Quem paga?' }], missingSecrets: ['STRIPE_KEY'] });
  });

  it('counts a spec whose run needs the owner as blocked, even when its status reads running', () => {
    const src: RepoSource = { architecture: ARCH, specs: [spec('cart', 'shop-api', 'running', { blocked: true })] };
    expect(repositoryCards(src)[0]).toMatchObject({ status: 'blocked', blockers: 1 });
  });

  it('keeps the last events of the runs, oldest first', async () => {
    const runs = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-history-'));
    try {
      const ev = (seq: number, type: string, at: string) => JSON.stringify({ seq, at, runId: 'r1', specHash: 'h', type, kind: 'fact', data: {} });
      await fs.mkdir(path.join(runs, 'r1'), { recursive: true });
      await fs.writeFile(path.join(runs, 'r1', 'events.ndjson'), [ev(1, 'B', '2026-10-31T10:00:00Z'), ev(2, 'A', '2026-10-31T09:00:00Z')].join('\n') + '\n');
      const history = await historyOf(runs, [{ runId: 'r1', specId: 'cart' }], 50);
      expect(history.map((h) => h.type)).toEqual(['A', 'B']);
      expect(history[0]).toMatchObject({ runId: 'r1', specId: 'cart' });
    } finally {
      await fs.rm(runs, { recursive: true, force: true });
    }
  });
});

describe('reading a project\'s repositories from disk', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'teams-ai-repos-'));
  });
  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it('reads the architecture, the spec index and each spec\'s plan and task list', async () => {
    await fs.mkdir(path.join(dir, 'docs', 'specs', 'cart'), { recursive: true });
    await fs.writeFile(path.join(dir, 'docs', 'architecture.json'), JSON.stringify(ARCH));
    await fs.writeFile(path.join(dir, 'docs', 'specs.json'), JSON.stringify({ specs: [{ specId: 'cart', title: 'Carrinho', priority: 'P1', dependsOn: ['pay'] }] }));
    await fs.writeFile(path.join(dir, 'docs', 'specs', 'cart', 'implementation-plan.md'), '# plan');
    await fs.writeFile(path.join(dir, 'docs', 'specs', 'cart', 'task.md'), '# tasks\n\n## Task 1: a\n\n## Task 2: b\n');
    const src = await loadRepoSource(dir, [{ specId: 'cart', status: 'done', activeRunId: null, repository: 'shop-api', blocked: false }]);
    expect(src?.specs).toEqual([{ specId: 'cart', key: null, status: 'done', activeRunId: null, repository: 'shop-api', blocked: false, title: 'Carrinho', priority: 'P1', dependsOn: ['pay'], plan: true, tasks: 2 }]);
  });

  it('gives no source for a project with no architecture yet', async () => {
    expect(await loadRepoSource(dir, [])).toBeNull();
  });
});
