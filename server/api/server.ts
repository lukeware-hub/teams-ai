import { promises as fs } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

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
export function isAllowedHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
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
  if (!file.startsWith(path.resolve(dir))) return false;
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
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const done = (status: number) => log(`${req.method} ${url.pathname} ${status} ${Date.now() - started}ms`);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
      done(status);
    };
    if (!isAllowedHost(req.headers.host)) return json(403, { error: 'forbidden host' });
    const routedPath = apiPath(url.pathname);
    const match = matchRoute(deps.routes, req.method ?? 'GET', routedPath);
    if (!match) {
      if (req.method === 'GET' && deps.staticDir && (await serveStatic(deps.staticDir, routedPath, res))) return done(200);
      return json(404, { error: 'not found' });
    }
    const sse = (): SseWriter => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.flushHeaders();
      done(200);
      // A browser that navigates away closes the socket while the tail is still producing events. A write
      // after that raises 'error' on the response, and an unhandled 'error' event takes the whole server
      // down (seen live: ERR_STREAM_WRITE_AFTER_END from the run events tail). Swallow it and stop writing.
      res.on('error', () => undefined);
      const open = () => !res.writableEnded && !res.destroyed;
      return {
        send: (event, data, id) => {
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, process.env.HOST ?? '127.0.0.1', () => resolve());
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
