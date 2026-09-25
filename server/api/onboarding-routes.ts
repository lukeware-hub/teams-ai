import { SECRET_NAME, writeSecret } from '../core/secrets.js';
import { redactSecrets } from '../core/redact.js';
import { GITHUB_OWNER, setGithubOwner } from '../onboarding/config-store.js';
import { LoginSession } from '../onboarding/login-session.js';
import { claudeStatus, ghStatus } from '../onboarding/probes.js';
import { childEnv, type PtySpec, type SpawnPty } from '../onboarding/pty.js';
import { computeItem, computeStatus, type ItemName, type StatusDeps } from '../onboarding/status.js';
import type { Cli } from '../onboarding/transcripts.js';
import { HttpError, type Route } from './server.js';

export interface OnboardingDeps extends StatusDeps {
  spawn: SpawnPty;
  commands?: { claude: PtySpec; gh: PtySpec };
  log?: (line: string) => void;
}

const SECRETS: Record<string, ItemName> = { GITHUB_TOKEN: 'githubToken', OPENROUTER_API_KEY: 'openrouterKey' };

/** Spec (onboarding) §3: one live session per CLI, kept for the process lifetime. */
export class Onboarding {
  readonly sessions: Record<Cli, LoginSession>;

  constructor(private readonly deps: OnboardingDeps) {
    const env = childEnv(deps.hostEnv);
    const commands = deps.commands ?? {
      claude: { bin: deps.hostEnv?.CLAUDE_BIN ?? 'claude', args: ['auth', 'login', '--claudeai'], env },
      gh: { bin: deps.hostEnv?.GH_BIN ?? 'gh', args: ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https'], env },
    };
    const known = async () => Object.values(await import('../core/secrets.js').then((m) => m.loadSecrets(deps.secretsDir)));
    let knownCache: readonly string[] = [];
    void known().then((v) => (knownCache = v));
    this.sessions = {
      claude: new LoginSession({ cli: 'claude', spawn: deps.spawn, command: commands.claude, probe: () => claudeStatus(deps), knownSecrets: () => knownCache }),
      gh: new LoginSession({ cli: 'gh', spawn: deps.spawn, command: commands.gh, probe: () => ghStatus(deps), knownSecrets: () => knownCache }),
    };
  }
}

const str = (v: unknown, field: string): string => {
  if (typeof v !== 'object' || v === null || typeof (v as Record<string, unknown>)[field] !== 'string') throw new HttpError(400, `${field} must be a string`);
  return (v as Record<string, string>)[field]!;
};

export function onboardingRoutes(deps: OnboardingDeps): Route[] {
  const ob = new Onboarding(deps);
  const P = '/api/onboarding';
  const routes: Route[] = [
    { method: 'GET', path: `${P}/status`, handler: async ({ json }) => json(200, await computeStatus(deps)) },
    {
      method: 'PUT',
      path: `${P}/github-owner`,
      handler: async ({ body, json }) => {
        const owner = str(await body(), 'owner');
        if (!GITHUB_OWNER.test(owner)) throw new HttpError(400, 'owner is not a GitHub login');
        await setGithubOwner(owner, deps.home);
        json(200, { item: await computeItem(deps, 'githubOwner') });
      },
    },
  ];
  for (const [name, item] of Object.entries(SECRETS)) {
    routes.push({
      method: 'PUT',
      path: `${P}/secrets/${name}`,
      handler: async ({ body, json }) => {
        const value = str(await body(), 'value').trim();
        if (!SECRET_NAME.test(name) || value === '' || /[\r\n]/.test(value)) throw new HttpError(400, 'value must be a single non-empty line');
        await writeSecret(deps.secretsDir, name, value);
        const result = await computeItem(deps, item);
        // Belt and braces: the probes redact already; nothing that leaves this handler may carry the value.
        json(200, { item: { ...result, detail: redactSecrets(result.detail, [value]) } });
      },
    });
  }
  for (const cli of ['claude', 'gh'] as const) {
    const s = ob.sessions[cli];
    routes.push(
      { method: 'POST', path: `${P}/${cli}/login`, handler: async ({ json }) => { s.start(); json(202, { state: s.state }); } },
      { method: 'POST', path: `${P}/${cli}/cancel`, handler: async ({ json }) => { s.cancel(); json(200, { state: s.state }); } },
      {
        method: 'POST',
        path: `${P}/${cli}/code`,
        handler: async ({ body, json }) => {
          const code = str(await body(), 'code');
          if (!s.sendCode(code)) return json(409, { error: `session is ${s.state.name}, not awaiting-code`, state: s.state });
          json(202, { state: s.state });
        },
      },
      {
        method: 'GET',
        path: `${P}/${cli}/events`,
        handler: async ({ sse }) => {
          const w = sse();
          w.send('state', s.state);
          if (s.output) w.send('output', s.output);
          const off = s.on((e) => (e.type === 'state' ? w.send('state', e.state) : w.send('output', e.chunk)));
          w.onClose(off);
        },
      },
    );
  }
  return routes;
}
