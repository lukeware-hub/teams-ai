import { loadSecrets } from '../core/secrets.js';
import type { Exec } from '../exec/command.js';

/** The orchestrator authenticates to GitHub as the token's user (spec §10 GITHUB_TOKEN), for `gh` and for git over
 * HTTPS alike; the interactive `gh auth login` may belong to a different account. The helper reads the token from the
 * environment, so it never appears on a command line or in a remote URL. */
export function gitAuthEnv(token: string | undefined): Record<string, string> {
  return withGitAuthEnv({}, token);
}

const CREDENTIAL_HELPER: readonly [string, string] = ['credential.helper', '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'];

/** Adds the token and its credential helper to `env`, after the git config entries already there; `env` as is without a token. */
export function withGitAuthEnv(env: Record<string, string>, token: string | undefined): Record<string, string> {
  return token ? withGitConfig({ ...env, GH_TOKEN: token }, [CREDENTIAL_HELPER]) : env;
}

/** The token saved in the secrets directory, read on every call; absent when none is saved. */
const savedToken = (secretsDir: string): Promise<string | undefined> =>
  loadSecrets(secretsDir).then((s) => s.GITHUB_TOKEN, () => undefined);

/** Git commands of a long-lived server (the UI): the token is read on every call, because it may be saved in the
 * Onboarding after the server started. */
export function withGitAuth(exec: Exec, secretsDir: string): Exec {
  return async (spec) => {
    if (spec.bin !== 'git') return exec(spec);
    const token = await savedToken(secretsDir);
    return token ? exec({ ...spec, env: withGitAuthEnv(spec.env ?? {}, token) }) : exec(spec);
  };
}

/** Appends `entries` as git config variables after the ones already in `env`; never overwrites an entry. */
export function withGitConfig(env: Record<string, string>, entries: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const raw = env.GIT_CONFIG_COUNT ?? '0';
  if (!/^\d+$/.test(raw)) throw new RangeError(`GIT_CONFIG_COUNT must be a whole number, got "${raw}"`);
  const start = Number(raw);
  const added: Record<string, string> = {};
  entries.forEach(([key, value], i) => {
    added[`GIT_CONFIG_KEY_${start + i}`] = key;
    added[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  return { ...env, ...added, GIT_CONFIG_COUNT: String(start + entries.length) };
}

/** gh commands get the saved token as GH_TOKEN, the same source as withGitAuth; no other environment is added. */
export function withGhAuth(exec: Exec, secretsDir: string): Exec {
  return async (spec) => {
    if (spec.bin !== 'gh') return exec(spec);
    const token = await savedToken(secretsDir);
    return token ? exec({ ...spec, env: { ...(spec.env ?? {}), GH_TOKEN: token } }) : exec(spec);
  };
}
