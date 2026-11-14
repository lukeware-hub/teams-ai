import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Exec } from '../exec/command.js';

export interface GrpcMethod {
  name: string;
  requestType: string;
  responseType: string;
  /** A JSON request with every field of the message, empty. */
  template: string;
  streaming: boolean;
}
export interface GrpcService {
  service: string;
  methods: GrpcMethod[];
}
export interface GrpcCatalog {
  /** Where the methods came from: the repository's .proto files or, when it has none, the service itself (reflection). */
  source: 'proto' | 'reflection';
  services: GrpcService[];
}
export interface GrpcCallResult {
  ok: boolean;
  output: string;
  error: string;
  ms: number;
}

const NAME = /^[A-Za-z_][\w.]*$/;
const CALL = /^[A-Za-z_][\w.]*\/[A-Za-z_]\w*$/;
const HIDDEN = /^grpc\.(reflection|health)\./;
const RPC = /rpc\s+(\w+)\s*\(\s*(stream\s+)?\.?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?\.?([\w.]+)\s*\)/g;
const LIST_MS = 5_000;
const CALL_MS = 15_000;
const BUILD_MS = 60_000;
const OUTPUT_LIMIT = 512 * 1024;

/** `host:port` of a deployed service, from the address the deploy recorded; null when it has no port. */
export function grpcTarget(url: string | null): string | null {
  try {
    const u = new URL(url ?? '');
    return u.hostname && u.port ? `${u.hostname}:${u.port}` : null;
  } catch {
    return null;
  }
}

/** The folder `buf` builds: the repository's own, or its `proto` folder. */
async function bufDir(repo: string): Promise<string | null> {
  const has = (dir: string, file: string) => fs.access(path.join(dir, file)).then(() => true, () => false);
  for (const dir of [repo, path.join(repo, 'proto')]) if (await has(dir, 'buf.yaml')) return dir;
  return (await fs.stat(path.join(repo, 'proto')).then((s) => s.isDirectory(), () => false)) ? path.join(repo, 'proto') : null;
}

/** Builds the repository's descriptor set in a temporary folder, runs `use` with its path, and removes it. */
async function withProtoset<T>(exec: Exec, repo: string, use: (protoset: string) => Promise<T>): Promise<T> {
  const dir = await bufDir(repo);
  if (!dir) throw new Error('o repositório não tem arquivos .proto');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'grpc-'));
  try {
    const file = path.join(tmp, 'image.binpb');
    const built = await exec({ bin: 'buf', args: ['build', dir, '-o', file], timeoutMs: BUILD_MS });
    if (built.exitCode !== 0) throw new Error(`buf build falhou: ${built.stderr.trim().split('\n').at(-1) ?? ''}`);
    return await use(file);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

interface Call {
  target: string;
  protoset: string | null;
  flags?: string[];
  rest: string[];
}
const grpcurl = (exec: Exec, c: Call) =>
  exec({
    bin: 'grpcurl',
    args: ['-plaintext', '-max-time', String(LIST_MS / 1000), ...(c.protoset ? ['-protoset', c.protoset] : []), ...(c.flags ?? []), c.target, ...c.rest],
    timeoutMs: LIST_MS + 2_000,
    outputLimit: OUTPUT_LIMIT,
  });

/** Every service with its methods and a request template, read through `protoset` (null: the service's reflection). */
async function readServices(exec: Exec, target: string, protoset: string | null): Promise<GrpcService[]> {
  const listed = await grpcurl(exec, { target, protoset, rest: ['list'] });
  if (listed.exitCode !== 0) throw new Error(listed.stderr.trim().split('\n').at(-1) ?? 'grpcurl falhou');
  const names = listed.stdout.split('\n').map((l) => l.trim()).filter((l) => NAME.test(l) && !HIDDEN.test(l));
  return Promise.all(
    names.map(async (service) => {
      const described = await grpcurl(exec, { target, protoset, rest: ['describe', service] });
      const methods = await Promise.all(
        [...described.stdout.matchAll(RPC)].map(async ([, name, inStream, requestType, outStream, responseType]) => {
          const message = await grpcurl(exec, { target, protoset, flags: ['-msg-template'], rest: ['describe', requestType!] });
          const template = message.stdout.split('Message template:').at(1)?.trim() ?? '{}';
          return { name: name!, requestType: requestType!, responseType: responseType!, template, streaming: Boolean(inStream || outStream) };
        }),
      );
      return { service, methods };
    }),
  );
}

/**
 * The methods of a deployed service: from the repository's .proto files, which need no connection; a repository
 * without them is asked through the service's reflection, which only a service that serves HTTP/2 answers.
 */
export async function grpcCatalog(exec: Exec, target: string, repo: string): Promise<GrpcCatalog> {
  try {
    return { source: 'proto', services: await withProtoset(exec, repo, (protoset) => readServices(exec, target, protoset)) };
  } catch (proto) {
    try {
      return { source: 'reflection', services: await readServices(exec, target, null) };
    } catch (reflection) {
      throw new Error(`${(proto as Error).message}; reflection: ${(reflection as Error).message}`);
    }
  }
}

const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'content-type', 'connection', 'transfer-encoding', 'upgrade']);
const HEADER_NAME = /^[A-Za-z0-9-]+$/;

/** The headers the owner typed, one `name: value` per line; a bad name or one the call must own is refused. */
export function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const at = line.indexOf(':');
    const name = at < 1 ? '' : line.slice(0, at).trim();
    if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) throw new Error(`invalid header ${line.slice(0, 40)}`);
    out[name] = line.slice(at + 1).trim();
  }
  return out;
}


const STATUS = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];

/** Splits a gRPC-Web body into its messages and its trailers: each frame is a flag byte, a 4-byte length and the payload; flag 0x80 marks the trailers. */
function frames(body: Buffer): { messages: string[]; trailers: Record<string, string> } {
  const messages: string[] = [];
  const trailers: Record<string, string> = {};
  for (let at = 0; at + 5 <= body.length; ) {
    const end = at + 5 + body.readUInt32BE(at + 1);
    const payload = body.subarray(at + 5, end).toString('utf8');
    if (body[at]! & 0x80) for (const line of payload.split(/\r?\n/)) { const colon = line.indexOf(':'); if (colon > 0) trailers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim(); }
    else messages.push(payload);
    at = end;
  }
  return { messages, trailers };
}

/**
 * One unary gRPC call over gRPC-Web with JSON messages, the gRPC protocol over HTTP/1.1. The deployed services
 * answer it with no change (they do not serve the HTTP/2 without TLS that grpcurl needs). `method` is `package.Service/Method`;
 * the result carries the call's grpc-status and grpc-message, not only the HTTP status.
 */
export async function grpcInvoke(target: string, method: string, body: string, headers: Record<string, string>, send: typeof fetch = fetch): Promise<GrpcCallResult> {
  if (!CALL.test(method)) throw new Error(`invalid method ${method}`);
  const payload = Buffer.from(body, 'utf8');
  const frame = Buffer.concat([Buffer.from([0, 0, 0, 0, 0]), payload]);
  frame.writeUInt32BE(payload.length, 1);
  const started = Date.now();
  try {
    const res = await send(`http://${target}/${method}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/grpc-web+json', accept: 'application/grpc-web+json', 'x-grpc-web': '1' }, body: frame, signal: AbortSignal.timeout(CALL_MS) });
    const { messages, trailers } = frames(Buffer.from(await res.arrayBuffer()).subarray(0, OUTPUT_LIMIT));
    // An error with no message comes back as headers only; a call that ran puts its status in the trailers.
    const code = Number(trailers['grpc-status'] ?? res.headers.get('grpc-status') ?? NaN);
    if (Number.isNaN(code)) return { ok: false, output: '', error: `o serviço não respondeu em gRPC (HTTP ${res.status})`, ms: Date.now() - started };
    const detail = decodeURIComponent(trailers['grpc-message'] ?? res.headers.get('grpc-message') ?? '');
    return { ok: code === 0, output: messages.join('\n'), error: code === 0 ? '' : `${STATUS[code] ?? 'UNKNOWN'} (${code})${detail ? `: ${detail}` : ''}`, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, output: '', error: connectionError(e), ms: Date.now() - started };
  }
}

/** What went wrong reaching the service, in words: no one listening, no answer in time, or the raw message. */
function connectionError(e: unknown): string {
  if (e instanceof Error && e.name === 'TimeoutError') return `o serviço não respondeu em ${CALL_MS / 1000} s`;
  const code = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (typeof code === 'string') return `não foi possível conectar ao serviço (${code})`;
  return e instanceof Error ? e.message : 'falha desconhecida';
}
