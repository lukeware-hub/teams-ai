import { loadSecrets } from '../core/secrets.js';
import { readUserConfig } from './config-store.js';
import { claudeStatus, ghOwner, ghStatus, ghToken, openrouterKey, type ProbeDeps } from './probes.js';

export type ItemName = 'claude' | 'githubOwner' | 'ghLogin' | 'githubToken' | 'openrouterKey';
export const ITEM_NAMES: readonly ItemName[] = ['claude', 'githubOwner', 'ghLogin', 'githubToken', 'openrouterKey'];
/** Not needed to run: the Jev (OpenRouter) is optional, so its item never holds back `allOk`. */
export const OPTIONAL_ITEMS: readonly ItemName[] = ['openrouterKey'];

export interface Item {
  ok: boolean;
  detail: string;
  secret?: { set: boolean; hint: string };
}

export interface Status {
  items: Record<ItemName, Item>;
  allOk: boolean;
}

export interface StatusDeps extends ProbeDeps {
  home?: string;
  secretsDir: string;
}

export function hint(value: string): string {
  void value;
  return '****';
}

/** Spec (onboarding) §4: every item is recomputed live; nothing is cached as "onboarded". */
export async function computeItem(d: StatusDeps, name: ItemName): Promise<Item> {
  const secrets = await loadSecrets(d.secretsDir);
  switch (name) {
    case 'claude':
      return claudeStatus(d);
    case 'ghLogin':
      return ghStatus(d);
    case 'githubOwner': {
      const owner = (await readUserConfig(d.home)).cfg.github.owner;
      if (!owner) return { ok: false, detail: 'GitHub owner not set' };
      return ghOwner(d, owner, secrets.GITHUB_TOKEN ?? null);
    }
    case 'githubToken': {
      const token = secrets.GITHUB_TOKEN;
      if (!token) return { ok: false, detail: 'GITHUB_TOKEN not set', secret: { set: false, hint: '' } };
      return { ...(await ghToken(d, token)), secret: { set: true, hint: hint(token) } };
    }
    case 'openrouterKey': {
      const key = secrets.OPENROUTER_API_KEY;
      if (!key) return { ok: false, detail: 'OPENROUTER_API_KEY not set', secret: { set: false, hint: '' } };
      return { ...(await openrouterKey(d, key)), secret: { set: true, hint: hint(key) } };
    }
  }
}

export async function computeStatus(d: StatusDeps): Promise<Status> {
  // Spec (onboarding) §8: a probe that blows up keeps only its item red; the other four still report.
  const entries = await Promise.all(
    ITEM_NAMES.map(async (name) => [name, await computeItem(d, name).catch((err: Error) => ({ ok: false, detail: err.message }))] as const),
  );
  const items = Object.fromEntries(entries) as Record<ItemName, Item>;
  return { items, allOk: ITEM_NAMES.every((n) => OPTIONAL_ITEMS.includes(n) || items[n].ok) };
}
