import { redactSecrets } from '../core/redact.js';
import { JevOpenRouterBackend } from '../decide/jev-openrouter.js';
import type { Exec } from '../exec/command.js';
import { childEnv } from './pty.js';

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

export interface ProbeDeps {
  exec: Exec;
  fetch: typeof fetch;
  hostEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const TIMEOUT = 30_000;
const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';

export async function claudeStatus(d: ProbeDeps): Promise<ProbeResult> {
  const r = await d.exec({ bin: d.hostEnv?.CLAUDE_BIN ?? 'claude', args: ['auth', 'status', '--json'], env: childEnv(d.hostEnv), timeoutMs: d.timeoutMs ?? TIMEOUT }).catch((e: Error) => ({ exitCode: 127, stdout: '', stderr: e.message }));
  if (r.exitCode !== 0) return { ok: false, detail: `claude auth status failed: ${firstLine(r.stderr || r.stdout) || `exit ${r.exitCode}`}` };
  try {
    const j = JSON.parse(r.stdout) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
    if (j.loggedIn !== true) return { ok: false, detail: 'not logged in' };
    return { ok: true, detail: `${j.email ?? 'unknown account'} (${j.subscriptionType ?? 'unknown plan'})` };
  } catch {
    return { ok: false, detail: 'claude auth status returned no JSON' };
  }
}

export async function ghStatus(d: ProbeDeps): Promise<ProbeResult> {
  const r = await d.exec({ bin: d.hostEnv?.GH_BIN ?? 'gh', args: ['auth', 'status'], env: childEnv(d.hostEnv), timeoutMs: d.timeoutMs ?? TIMEOUT }).catch((e: Error) => ({ exitCode: 127, stdout: '', stderr: e.message }));
  const text = `${r.stdout}\n${r.stderr}`;
  const m = /Logged in to github\.com (?:account|as) (\S+)/i.exec(text);
  if (r.exitCode === 0 && m) return { ok: true, detail: m[1]! };
  return { ok: false, detail: firstLine(r.stderr || r.stdout) || 'gh is not logged in' };
}

function ghEnv(d: ProbeDeps, token: string | null): Record<string, string> {
  return childEnv(d.hostEnv, token ? { GH_TOKEN: token } : {});
}

export async function ghOwner(d: ProbeDeps, owner: string, token: string | null): Promise<ProbeResult> {
  for (const kind of ['users', 'orgs'] as const) {
    const r = await d.exec({ bin: d.hostEnv?.GH_BIN ?? 'gh', args: ['api', `${kind}/${owner}`], env: ghEnv(d, token), timeoutMs: d.timeoutMs ?? TIMEOUT }).catch((e: Error) => ({ exitCode: 1, stdout: '', stderr: e.message }));
    if (r.exitCode === 0) {
      try {
        const j = JSON.parse(r.stdout) as { login?: string; type?: string };
        return { ok: true, detail: `${j.login ?? owner} (${j.type ?? kind})` };
      } catch {
        return { ok: true, detail: owner };
      }
    }
  }
  return { ok: false, detail: `GitHub knows no user or organization named ${owner}` };
}

export async function ghToken(d: ProbeDeps, token: string): Promise<ProbeResult> {
  const r = await d.exec({ bin: d.hostEnv?.GH_BIN ?? 'gh', args: ['api', 'user', '-i'], env: ghEnv(d, token), timeoutMs: d.timeoutMs ?? TIMEOUT }).catch((e: Error) => ({ exitCode: 1, stdout: '', stderr: e.message }));
  const clean = (s: string) => redactSecrets(s, [token]);
  if (r.exitCode !== 0) return { ok: false, detail: clean(firstLine(r.stderr || r.stdout) || `gh api user failed (exit ${r.exitCode})`) };
  const [head, ...rest] = r.stdout.split(/\r?\n\r?\n/);
  const scopes = /^X-Oauth-Scopes:\s*(.*)$/im.exec(head ?? '')?.[1]?.trim() ?? 'none';
  try {
    const j = JSON.parse(rest.join('\n\n') || head || '{}') as { login?: string };
    return { ok: true, detail: `${j.login ?? 'unknown'} · scopes: ${scopes}` };
  } catch {
    return { ok: false, detail: 'gh api user returned no JSON' };
  }
}

export async function openrouterKey(d: ProbeDeps, key: string, model = 'typesafe/jev-1.13'): Promise<ProbeResult> {
  const jev = new JevOpenRouterBackend({ fetch: d.fetch, apiKey: key, baseUrl: 'https://openrouter.ai/api', model, timeoutMs: d.timeoutMs ?? TIMEOUT, maxTries: 1, backoffMs: 0, sleep: async () => {} });
  const r = await jev.evaluate({ state: 'The onboarding probe checks the key.', questions: { probe: { type: 'noul', instructions: 'Is this sentence in English?' } }, escalateTo: 'test' });
  if (r.ok) return { ok: true, detail: `${r.model} · $${r.usage.costUsd ?? 0}` };
  return { ok: false, detail: redactSecrets(r.message, [key]) };
}
