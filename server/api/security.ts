import { promises as dns } from 'node:dns';
import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';

export const ALLOWED_HOSTS_ENV = 'TEAMS_AI_ALLOWED_HOSTS';

/** Audit L3/H2: sent with every response (API, SSE and static). The SPA is same-origin only; React style attributes need inline styles. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

export function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

/** Comma list from TEAMS_AI_ALLOWED_HOSTS: host names (port ignored) or `host:port`; blanks dropped. */
export function parseAllowedHosts(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((h) => h.trim().toLowerCase()).filter((h) => h !== '');
}

/** Audit H2: a state-changing request must declare JSON; `text/plain` and form types are what a cross-site form can send. */
export function isJsonContentType(header: string | undefined): boolean {
  return /^application\/json\s*(;|$)/i.test(header ?? '');
}

/**
 * Audit H2: for a request that carries no bearer (cookie or unauthenticated loopback), refuse browser
 * requests that come from another site. Sec-Fetch-Site is trusted when present; otherwise Origin must
 * name the Host that was requested. Non-browser clients send neither header and pass.
 */
export function crossSite(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') return site !== 'same-origin' && site !== 'none';
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  try {
    return new URL(origin).host.toLowerCase() !== (req.headers.host ?? '').toLowerCase();
  } catch {
    return true;
  }
}

const PRIVATE_V4: ReadonlyArray<[number, number]> = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xe0000000, 3],
];

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
}

/** True for loopback, private, link-local, CGNAT, multicast and unspecified addresses (v4, v6 and v4-mapped v6). */
export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (net.isIPv4(bare)) {
    const n = v4ToInt(bare);
    return PRIVATE_V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
  }
  if (net.isIPv6(bare)) return bare === '::' || bare === '::1' || /^f[cd]/.test(bare) || /^fe[89ab]/.test(bare) || /^ff/.test(bare);
  return false;
}

export type ResolveHost = (name: string) => Promise<string[]>;
const systemResolve: ResolveHost = async (name) => (await dns.lookup(name, { all: true })).map((a) => a.address);

/** Names that only make sense inside a cluster or host. */
const INTERNAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|svc|cluster\.local)$/;

/**
 * Audit M1: why a clone host is refused, or null when it may be cloned. The allowlist (config) comes first;
 * private literals, internal names and names that resolve to private addresses are refused even when listed.
 * A name that does not resolve is left to the clone to fail.
 */
export async function refuseCloneHost(hostname: string, allowed: readonly string[], resolve: ResolveHost = systemResolve): Promise<string | null> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!allowed.map((a) => a.toLowerCase()).includes(host)) return 'esse servidor Git não está na lista permitida (github.allowedHosts)';
  if (net.isIP(host)) return isPrivateAddress(host) ? 'endereço interno não é permitido' : null;
  if (INTERNAL_NAME.test(host)) return 'nome interno não é permitido';
  const addresses = await resolve(host).catch(() => [] as string[]);
  return addresses.some(isPrivateAddress) ? 'o servidor Git resolve para um endereço interno' : null;
}
