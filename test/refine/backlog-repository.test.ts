import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ItemSpec } from '../../server/agents/outputs.js';
import { repositoryContext, type Architecture } from '../../server/contracts/architecture.js';
import { computeSpecHash } from '../../server/contracts/spec.js';
import type { BacklogItem } from '../../server/contracts/backlog.js';
import { backlogPack, postProcessBacklog, renderBacklogMd } from '../../server/refine/backlog.js';
import { batches, specInputHash, type BacklogDocs } from '../../server/refine/details.js';
import { postProcessItemSpec } from '../../server/refine/item-spec.js';
import { buildSpecsIndex } from '../../server/refine/specs-index.js';
import { renderSpecsMd } from '../../server/refine/specs-md.js';
import { specPack } from '../../server/refine/detail-packs.js';
import { validateBacklog } from '../../server/validators/backlog.js';
import { makeProject, makeSpec } from '../fixtures/contracts.js';

const epics = [
  { key: 'login', title: 'Entrar' },
  { key: 'shop', title: 'Loja' },
];
const item = (key: string, epic: string, rank: number, dependsOn: string[] = [], repository?: string): BacklogItem & { rank: number } => ({
  key,
  title: `Título ${key}`,
  epic,
  scope: `Escopo de ${key}`,
  priority: 'P1',
  rationale: `Motivo de ${key}`,
  dependsOn,
  sources: [{ doc: 'project.md', heading: 'Visão' }],
  size: 'M',
  rank,
  ...(repository === undefined ? {} : { repository }),
});
const DOCS = { 'project.md': 'Visão do produto.', 'briefing.md': '', 'stack.md': '', 'flow.md': '', 'design.md': '' } as BacklogDocs;

const ARCH: Architecture = {
  style: 'microservices',
  rationale: 'Dois serviços.',
  repositories: [
    { name: 'shop-api', responsibility: 'Vende', evidence: { doc: 'project.md', quote: 'Visão do produto' } },
    { name: 'shop-web', responsibility: 'Mostra a loja', evidence: { doc: 'project.md', quote: 'Visão do produto' } },
  ],
  integrations: [{ consumer: 'shop-web', provider: 'shop-api', contract: 'GET /cart' }],
};

describe('repository-less outputs stay byte for byte', () => {
  it('keeps the index, the markdown views, the batches and the spec hash of a backlog with no repository', () => {
    const golden = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/refine/golden-repo-less.json'), 'utf8'));
    const items = [item('user-login', 'login', 1), item('reset-password', 'login', 2, ['user-login']), item('cart', 'shop', 3)];
    const backlog = { epics, items, keyIds: true, specs: {}, preplans: {} } as never;
    expect(buildSpecsIndex('hello-001', { epics, items, keyIds: true })).toEqual(golden.index);
    expect(renderSpecsMd('hello-001', backlog)).toBe(golden.specsMd);
    expect(renderBacklogMd({ epics, items })).toBe(golden.backlogMd);
    expect(batches(items)).toEqual(golden.batches);
    expect(computeSpecHash(makeSpec({ specId: 'hello-001-user-login' }))).toBe(golden.specHash);
  });
});

describe('validateBacklog with repositories', () => {
  const backlog = (items: BacklogItem[]) => ({ epics, items });

  it('asks every item of a stamped draft to name one of its repositories', () => {
    const errors = validateBacklog(backlog([item('cart', 'shop', 1), item('user-login', 'login', 2, [], 'shop-cli')]), { flowHeadings: [], docs: {}, repositories: ['shop-api', 'shop-web'] });
    expect(errors).toEqual(['item cart: sem repositório', 'item user-login: repositório desconhecido shop-cli']);
  });

  it('accepts items that name known repositories, and ignores repositories for an unstamped draft', () => {
    expect(validateBacklog(backlog([item('cart', 'shop', 1, [], 'shop-api')]), { flowHeadings: [], docs: {}, repositories: ['shop-api'] })).toEqual([]);
    expect(validateBacklog(backlog([item('cart', 'shop', 1)]), { flowHeadings: [], docs: {} })).toEqual([]);
  });
});

describe('repository on the spec and its hash', () => {
  it('changes the spec hash only when a repository is set', () => {
    const plain = makeSpec({ specId: 'hello-001-cart' });
    expect(computeSpecHash({ ...plain, repository: 'shop-api' })).not.toBe(computeSpecHash(plain));
  });

  it('changes the input hash of a spec when its repository changes, and not when there is none', () => {
    const cart = item('cart', 'shop', 1);
    expect(specInputHash(cart, DOCS, undefined)).toBe(specInputHash(cart, DOCS));
    const api = repositoryContext(ARCH, 'shop-api');
    const web = repositoryContext(ARCH, 'shop-web');
    expect(specInputHash(cart, DOCS, api)).not.toBe(specInputHash(cart, DOCS));
    expect(specInputHash(cart, DOCS, api)).not.toBe(specInputHash(cart, DOCS, web));
  });

  it('sets the repository of a derived spec from its item, and leaves it out when the item has none', () => {
    const { specId: _s, specVersion: _v, specHash: _h, status: _st, validationReports: _r, derivedFrom: _d, ...rest } = makeSpec();
    const itemSpec = { ...rest, key: 'cart' } as unknown as ItemSpec;
    const hash = 'sha256:' + 'a'.repeat(64);
    const provenance = { backlogKey: 'cart', inputHash: hash, docsHash: hash, sources: [{ doc: 'project.md' as const, heading: 'Visão', hash: null, bodyHash: null }] };
    const withRepo = postProcessItemSpec(itemSpec, { specId: 'hello-001-cart', previous: null, highWater: 0, provenance, repository: 'shop-api' });
    expect(withRepo.ok && withRepo.spec.repository).toBe('shop-api');
    const without = postProcessItemSpec(itemSpec, { specId: 'hello-001-cart', previous: null, highWater: 0, provenance });
    expect(without.ok && 'repository' in without.spec).toBe(false);
  });
});

describe('repository context', () => {
  it('names the kind, the responsibility and the integrations that reach the repository', () => {
    expect(repositoryContext(ARCH, 'shop-api')).toEqual({ name: 'shop-api', kind: 'api', responsibility: 'Vende', integrations: ['shop-web → shop-api: GET /cart'] });
    expect(repositoryContext(ARCH, 'missing-api')).toBeUndefined();
  });
});

describe('grouping by repository', () => {
  it('keeps items of different repositories apart when a batch is made', () => {
    const items = [item('cart', 'shop', 1, [], 'shop-api'), item('catalog', 'shop', 2, [], 'shop-web'), item('pay', 'shop', 3, [], 'shop-api')];
    expect(batches(items).map((b) => b.map((i) => i.key))).toEqual([['cart', 'pay'], ['catalog']]);
  });

  it('writes the backlog under its repositories when some item names one, and the index names the repository of each spec', () => {
    const items = [item('cart', 'shop', 1, [], 'shop-api'), item('catalog', 'shop', 2, [], 'shop-web')];
    const md = renderBacklogMd({ epics, items });
    expect(md).toContain('## shop-api');
    expect(md).toContain('## shop-web');
    expect(md).not.toContain('## Loja');
    const index = buildSpecsIndex('hello-001', { epics, items, keyIds: true });
    expect(index.specs.map((s) => s.repository)).toEqual(['shop-api', 'shop-web']);
  });

  it('groups specs.md under each repository, the repositories in the order they first appear', () => {
    const items = [item('cart', 'shop', 1, [], 'shop-api'), item('catalog', 'shop', 2, [], 'shop-web'), item('pay', 'shop', 3, [], 'shop-api')];
    const md = renderSpecsMd('hello-001', { epics, items, keyIds: true, specs: {}, preplans: {} } as never);
    expect(md.split('# shop-api').length).toBe(2);
    expect(md.indexOf('## cart')).toBeLessThan(md.indexOf('## pay'));
    expect(md.indexOf('## pay')).toBeLessThan(md.indexOf('## catalog'));
  });

  it('shows the repository in each spec of specs.md only when the item names one', () => {
    const items = [item('cart', 'shop', 1, [], 'shop-api'), item('user-login', 'login', 2)];
    const md = renderSpecsMd('hello-001', { epics, items, keyIds: true, specs: {}, preplans: {} } as never);
    expect(md).toContain('Repositório: shop-api');
    expect(md.split('Repositório:').length).toBe(2);
  });
});

describe('backlog and spec packs of a stamped draft', () => {
  it('asks the backlog for one repository per item, with the rule on splitting across repositories', () => {
    const pack = backlogPack({ specHash: 'h', principles: [], projectMd: 'p', briefMd: 'b', previous: null, repositories: ['shop-api', 'shop-web'] });
    expect(pack.feedback).toContain('REPOSITORIES (mandatory): the architecture names these repositories: shop-api, shop-web.');
    expect(pack.feedback).toContain('one item per repository');
    const plain = backlogPack({ specHash: 'h', principles: [], projectMd: 'p', briefMd: 'b', previous: null });
    expect(plain.feedback).not.toContain('REPOSITORIES (mandatory)');
  });

  it('validates the backlog against the repositories it was asked for', () => {
    const out = { project: makeProject(), backlog: { epics, items: [item('cart', 'shop', 1)] } };
    const check = postProcessBacklog(out as never, null, {}, [], [], ['shop-api']);
    expect(check.ok).toBe(false);
    expect(check.ok ? [] : check.issues.join(' ')).toContain('sem repositório');
  });

  it('carries the repository and its integrations in the spec pack of its item', () => {
    const cart = { ...item('cart', 'shop', 1, [], 'shop-api') };
    const pack = specPack({ specHash: 'h', principles: [], docs: DOCS, batch: [cart], all: [cart], previous: {}, rejection: {}, repositories: { cart: repositoryContext(ARCH, 'shop-api') } });
    expect(pack.feedback).toContain('- repository: shop-api (api): Vende');
    expect(pack.feedback).toContain('integrations of this repository: shop-web → shop-api: GET /cart');
  });
});
