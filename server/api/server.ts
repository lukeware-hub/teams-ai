import { promises as fs } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';

export interface SseWriter {
  send(event: string, data: unknown): void;
  close(): void;
  onClose(cb: () => void): void;
}

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  body: () => Promise<unknown>;
  json: (status: number, value: unknown) => void;
  sse: () => SseWriter;
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  handler: (ctx: RouteContext) => Promise<void>;
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

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

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
    const route = deps.routes.find((r) => r.method === req.method && r.path === url.pathname);
    if (!route) {
      if (req.method === 'GET' && deps.staticDir && (await serveStatic(deps.staticDir, url.pathname, res))) return done(200);
      return json(404, { error: 'not found' });
    }
    const sse = (): SseWriter => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.flushHeaders();
      done(200);
      return {
        send: (event, data) => void res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        close: () => res.end(),
        onClose: (cb) => void res.on('close', cb),
      };
    };
    try {
      await route.handler({ req, res, body: () => readBody(req), json, sse });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) json(status, { error: err instanceof HttpError ? err.message : 'internal error' });
      else done(status);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
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
