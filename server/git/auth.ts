import { loadSecrets } from '../core/secrets.js';
import type { Exec } from '../exec/command.js';

/** The orchestrator authenticates to GitHub as the token's user (spec §10 GITHUB_TOKEN), for `gh` and for git over
 * HTTPS alike; the interactive `gh auth login` may belong to a different account. The helper reads the token from the
 * environment, so it never appears on a command line or in a remote URL. */
export function gitAuthEnv(token: string | undefined): Record<string, string> {
  if (!token) return {};
  return {
    GH_TOKEN: token,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f',
  };
}

/** Git commands of a long-lived server (the UI): the token is read on every call, because it may be saved in the
 * Onboarding after the server started. */
export function withGitAuth(exec: Exec, secretsDir: string): Exec {
  return async (spec) => {
    if (spec.bin !== 'git') return exec(spec);
    const auth = gitAuthEnv((await loadSecrets(secretsDir).catch(() => ({} as Record<string, string>))).GITHUB_TOKEN);
    return Object.keys(auth).length === 0 ? exec(spec) : exec({ ...spec, env: { ...(spec.env ?? {}), ...auth } });
  };
}
