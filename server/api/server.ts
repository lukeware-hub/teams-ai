import { promises as fs } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { bearerOk, requestAuthorized, resolveAuth, SESSION_PATH, sessionCookie, TOKEN_ENV } from './auth.js';
import { ALLOWED_HOSTS_ENV, applySecurityHeaders, crossSite, isJsonContentType, parseAllowedHosts } from './security.js';

export interface SseWriter {
  send(event: string, data: unknown, id?: string): void;
  close(): void;
  onClose(cb: () => void): void;
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  body: () => Promise<unknown>;
  json: (status: number, value: unknown) => void;
  sse: () => SseWriter;
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT';
  /** Literal segments or `:name` parameters, e.g. `/api/runs/:runId/events`. */
  path: string;
  handler: (ctx: RouteContext) => Promise<void>;
}

export function matchRoute(routes: readonly Route[], method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.split('/');
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = route.path.split('/');
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      const p = pattern[i]!;
      const v = parts[i]!;
      if (p.startsWith(':')) {
        if (v === '') {
          ok = false;
          break;
        }
        try {
          params[p.slice(1)] = decodeURIComponent(v);
        } catch {
          ok = false;
          break;
        }
      } else if (p !== v) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

export interface ApiDeps {
  routes: Route[];
  staticDir?: string | null;
  log?: (line: string) => void;
  /** Bearer token; defaults to TEAMS_AI_UI_TOKEN. */
  token?: string;
  /** Listen address; defaults to HOST or 127.0.0.1. */
  host?: string;
  /** Host header values accepted besides loopback (Service or Ingress names); defaults to TEAMS_AI_ALLOWED_HOSTS. */
  allowedHosts?: string[];
  /** Concurrent SSE streams, in total and per remote address (audit M5). */
  maxSse?: { total: number; perAddress: number };
  /** Audit M5: an event stream is closed after `lifetimeMs` in total or `idleMs` without an event (defaults 30 min / 10 min). */
  sseTimeouts?: { lifetimeMs: number; idleMs: number };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY = 64 * 1024;
export const API_PREFIX = '/teams-ai/v1';

function apiPath(pathname: string): string {
  return pathname === API_PREFIX ? '/' : pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length) : pathname;
}

/** Spec (onboarding) §7: only the local browser may talk to the API; a foreign Host is DNS rebinding. */
export function isAllowedHost(host: string | undefined, extra: readonly string[] = []): boolean {
  if (!host) return false;
  const full = host.toLowerCase();
  const name = full.replace(/:\d+$/, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || extra.includes(name) || extra.includes(full);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'body is not JSON');
  }
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

async function serveStatic(dir: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  const rel = urlPath === '/' || !path.extname(urlPath) ? 'index.html' : urlPath.slice(1);
  const file = path.resolve(dir, rel);
  if (!file.startsWith(path.resolve(dir) + path.sep)) return false;
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

export async function startApi(deps: ApiDeps, port: number): Promise<{ port: number; close(): Promise<void> }> {
  const log = deps.log ?? (() => undefined);
  const host = deps.host ?? process.env.HOST ?? '127.0.0.1';
  const token = resolveAuth(deps.token ?? process.env[TOKEN_ENV], host, log);
  const allowedHosts = (deps.allowedHosts ?? parseAllowedHosts(process.env[ALLOWED_HOSTS_ENV])).map((h) => h.toLowerCase());
  const maxSse = deps.maxSse ?? { total: 200, perAddress: 50 };
  const sseTimeouts = deps.sseTimeouts ?? { lifetimeMs: 30 * 60_000, idleMs: 10 * 60_000 };
  let sseTotal = 0;
  const ssePerAddress = new Map<string, number>();
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    applySecurityHeaders(res);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const done = (status: number) => log(`${req.method} ${url.pathname} ${status} ${Date.now() - started}ms`);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
      done(status);
    };
    if (!isAllowedHost(req.headers.host, allowedHosts)) return json(403, { error: 'forbidden host' });
    const routedPath = apiPath(url.pathname);
    const bearer = token !== null && bearerOk(req, token);
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isJsonContentType(req.headers['content-type'])) return json(415, { error: 'content-type must be application/json' });
    if (routedPath.startsWith('/api/') && !bearer && crossSite(req)) return json(403, { error: 'cross-site request refused' });
    if (routedPath === SESSION_PATH && req.method === 'POST') {
      // Lets the web client turn its bearer token into an HttpOnly cookie that EventSource can send.
      if (token !== null && !bearer) return json(401, { error: 'unauthorized' });
      res.writeHead(204, token === null ? {} : { 'set-cookie': sessionCookie(token) });
      res.end();
      return done(204);
    }
    if (token !== null && routedPath.startsWith('/api/') && !requestAuthorized(req, token)) {
      res.setHeader('www-authenticate', 'Bearer');
      return json(401, { error: 'unauthorized' });
    }
    const match = matchRoute(deps.routes, req.method ?? 'GET', routedPath);
    if (!match) {
      if (req.method === 'GET' && deps.staticDir && (await serveStatic(deps.staticDir, routedPath, res))) return done(200);
      return json(404, { error: 'not found' });
    }
    const sse = (): SseWriter => {
      const remote = req.socket.remoteAddress ?? '';
      const mine = ssePerAddress.get(remote) ?? 0;
      if (sseTotal >= maxSse.total || mine >= maxSse.perAddress) throw new HttpError(503, 'too many event streams');
      sseTotal++;
      ssePerAddress.set(remote, mine + 1);
      res.once('close', () => {
        sseTotal--;
        const left = (ssePerAddress.get(remote) ?? 1) - 1;
        if (left <= 0) ssePerAddress.delete(remote);
        else ssePerAddress.set(remote, left);
      });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.flushHeaders();
      done(200);
      // A browser that navigates away closes the socket while the tail is still producing events. A write
      // after that raises 'error' on the response, and an unhandled 'error' event takes the whole server
      // down (seen live: ERR_STREAM_WRITE_AFTER_END from the run events tail). Swallow it and stop writing.
      res.on('error', () => undefined);
      const open = () => !res.writableEnded && !res.destroyed;
      // Audit M5: tell the client to reconnect (EventSource does so with Last-Event-ID) and end the stream.
      const expire = () => {
        if (!open()) return;
        res.write('event: reconnect\ndata: {}\n\n');
        res.end();
      };
      const lifetime = setTimeout(expire, sseTimeouts.lifetimeMs);
      const idle = setTimeout(expire, sseTimeouts.idleMs);
      lifetime.unref();
      idle.unref();
      res.once('close', () => {
        clearTimeout(lifetime);
        clearTimeout(idle);
      });
      return {
        send: (event, data, id) => {
          idle.refresh();
          if (open()) res.write(`${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        },
        close: () => {
          if (open()) res.end();
        },
        onClose: (cb) => void res.on('close', cb),
      };
    };
    try {
      await match.route.handler({ req, res, params: match.params, body: () => readBody(req), json, sse });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) json(status, { error: err instanceof HttpError ? err.message : 'internal error' });
      else done(status);
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  return {
    port: bound,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
