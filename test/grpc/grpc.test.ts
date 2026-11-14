import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { grpcCatalog, grpcInvoke, grpcTarget, parseHeaders } from '../../server/grpc/grpc.js';
import { FakeExec } from '../fixtures/fake-exec.js';

const DESCRIBE = 'kh.policy.v1.PolicyService is a service:\nservice PolicyService {\n  rpc GetEffective ( .kh.policy.v1.GetRequest ) returns ( .kh.policy.v1.GetReply );\n  rpc Watch ( .kh.policy.v1.GetRequest ) returns ( stream .kh.policy.v1.GetReply );\n}\n';
const TEMPLATE = 'kh.policy.v1.GetRequest is a message:\nmessage GetRequest {\n  string id = 1;\n}\n\nMessage template:\n{\n  "id": ""\n}\n';

/** grpcurl answering a list with the reflection service and one real service, however it was given the methods. */
const listing = () =>
  new FakeExec()
    .on((s) => s.args.includes('list'), () => ({ stdout: 'grpc.reflection.v1.ServerReflection\nkh.policy.v1.PolicyService\n' }))
    .on((s) => s.args.includes('describe') && s.args.includes('kh.policy.v1.PolicyService'), () => ({ stdout: DESCRIBE }))
    .on((s) => s.args.includes('describe') && s.args.includes('kh.policy.v1.GetRequest'), () => ({ stdout: TEMPLATE }));

const dirs: string[] = [];
const repoWith = async (files: Record<string, string>) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'grpc-test-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), text);
  }
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

const METHODS = [
  { name: 'GetEffective', requestType: 'kh.policy.v1.GetRequest', responseType: 'kh.policy.v1.GetReply', template: '{\n  "id": ""\n}', streaming: false },
  { name: 'Watch', requestType: 'kh.policy.v1.GetRequest', responseType: 'kh.policy.v1.GetReply', template: '{\n  "id": ""\n}', streaming: true },
];

describe('grpcTarget', () => {
  it('turns the deploy address into host:port and refuses one with no port', () => {
    expect(grpcTarget('http://dind:20059')).toBe('dind:20059');
    expect(grpcTarget('http://dind')).toBeNull();
    expect(grpcTarget(null)).toBeNull();
    expect(grpcTarget('not a url')).toBeNull();
  });
});

describe('grpcCatalog', () => {
  it('reads the methods from the repository .proto files through buf, without connecting to the service first', async () => {
    const repo = await repoWith({ 'proto/buf.yaml': 'version: v2\n' });
    const fake = listing();
    const catalog = await grpcCatalog(fake.exec, 'dind:20059', repo);
    expect(catalog).toEqual({ source: 'proto', services: [{ service: 'kh.policy.v1.PolicyService', methods: METHODS }] });
    expect(fake.calls.map((c) => c.bin)[0]).toBe('buf');
    expect(fake.lines('buf')[0]).toMatch(new RegExp(`^build ${path.join(repo, 'proto').replace(/\\/g, '\\\\')} -o .*image\\.binpb$`));
    expect(fake.lines('grpcurl')[0]).toMatch(/^-plaintext -max-time 5 -protoset .*image\.binpb dind:20059 list$/);
    expect(fake.calls.every((c) => c.timeoutMs !== undefined)).toBe(true);
  });

  it('falls back to the service reflection when the repository has no .proto files', async () => {
    const repo = await repoWith({ 'README.md': 'x' });
    const fake = listing();
    const catalog = await grpcCatalog(fake.exec, 'dind:20059', repo);
    expect(catalog).toEqual({ source: 'reflection', services: [{ service: 'kh.policy.v1.PolicyService', methods: METHODS }] });
    expect(fake.lines('grpcurl')[0]).toBe('-plaintext -max-time 5 dind:20059 list');
  });

  it('says why nothing could be listed when there are no .proto files and no reflection', async () => {
    const repo = await repoWith({ 'README.md': 'x' });
    const fake = new FakeExec().on((s) => s.bin === 'grpcurl', () => ({ exitCode: 1, stderr: 'Failed to dial target host' }));
    await expect(grpcCatalog(fake.exec, 'dind:20059', repo)).rejects.toThrow(/não tem arquivos \.proto; reflection: Failed to dial target host/);
  });

  it('says why buf could not build the files', async () => {
    const repo = await repoWith({ 'buf.yaml': 'version: v2\n' });
    const fake = new FakeExec().on((s) => s.bin === 'buf', () => ({ exitCode: 1, stderr: 'a.proto:1:1: syntax error' })).on((s) => s.bin === 'grpcurl', () => ({ exitCode: 1, stderr: 'no reflection' }));
    await expect(grpcCatalog(fake.exec, 'dind:20059', repo)).rejects.toThrow(/buf build falhou: a\.proto:1:1: syntax error; reflection: no reflection/);
  });
});

describe('parseHeaders', () => {
  it('reads one name: value per line and keeps colons inside the value', () => {
    expect(parseHeaders('authorization: Bearer a:b\n\n x-tenant-id : kayron ')).toEqual({ authorization: 'Bearer a:b', 'x-tenant-id': 'kayron' });
    expect(parseHeaders('')).toEqual({});
  });

  it('refuses a line with no name, a bad name, or a header the call must own', () => {
    for (const bad of ['no colon here', ': value', 'bad name: x', 'Host: evil', 'content-type: text/plain', 'Content-Length: 1']) expect(() => parseHeaders(bad)).toThrow(/invalid header/);
  });
});

describe('grpcInvoke', () => {
  const frame = (flag: number, text: string) => {
    const payload = Buffer.from(text);
    const head = Buffer.alloc(5);
    head[0] = flag;
    head.writeUInt32BE(payload.length, 1);
    return Buffer.concat([head, payload]);
  };
  const answer = (body: Buffer, headers: Record<string, string> = {}, status = 200) => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const send = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(new Uint8Array(body), { status, headers });
    }) as unknown as typeof fetch;
    return { sent, send };
  };

  it('sends the JSON message as one gRPC-Web frame to the method, with the owner headers, and reads the message and the status from the answer', async () => {
    const { sent, send } = answer(Buffer.concat([frame(0, '{"version":"v1"}'), frame(0x80, 'grpc-status: 0\r\n')]));
    const r = await grpcInvoke('dind:20059', 'kh.policy.v1.PolicyService/GetEffective', '{"id":"a"}', { authorization: 'Bearer t' }, send);
    expect(r).toMatchObject({ ok: true, output: '{"version":"v1"}', error: '' });
    expect(sent[0]!.url).toBe('http://dind:20059/kh.policy.v1.PolicyService/GetEffective');
    expect(sent[0]!.init.headers).toMatchObject({ authorization: 'Bearer t', 'content-type': 'application/grpc-web+json', 'x-grpc-web': '1' });
    expect(Buffer.from(sent[0]!.init.body as Buffer)).toEqual(frame(0, '{"id":"a"}'));
  });

  it('reports a gRPC error with its status name, code and message, from the headers or from the trailers', async () => {
    const fromHeaders = answer(Buffer.alloc(0), { 'grpc-status': '16', 'grpc-message': 'UNAUTHENTICATED' });
    expect(await grpcInvoke('dind:20059', 'a.B/C', '{}', {}, fromHeaders.send)).toMatchObject({ ok: false, output: '', error: 'UNAUTHENTICATED (16): UNAUTHENTICATED' });
    const fromTrailers = answer(frame(0x80, 'grpc-status: 5\r\ngrpc-message: policy%20not%20found\r\n'));
    expect(await grpcInvoke('dind:20059', 'a.B/C', '{}', {}, fromTrailers.send)).toMatchObject({ ok: false, error: 'NOT_FOUND (5): policy not found' });
  });

  it('says the service did not answer in gRPC, and reports a connection failure with its message', async () => {
    const html = answer(Buffer.from('<html></html>'), {}, 404);
    expect(await grpcInvoke('dind:20059', 'a.B/C', '{}', {}, html.send)).toMatchObject({ ok: false, error: 'o serviço não respondeu em gRPC (HTTP 404)' });
    const down = (async () => {
      throw new Error('fetch failed');
    }) as unknown as typeof fetch;
    expect(await grpcInvoke('dind:20059', 'a.B/C', '{}', {}, down)).toMatchObject({ ok: false, error: 'fetch failed' });
    const refused = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as unknown as typeof fetch;
    expect(await grpcInvoke('dind:20059', 'a.B/C', '{}', {}, refused)).toMatchObject({ ok: false, error: 'não foi possível conectar ao serviço (ECONNREFUSED)' });
    const slow = (async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    expect(await grpcInvoke('dind:20059', 'a.B/C', '{}', {}, slow)).toMatchObject({ ok: false, error: 'o serviço não respondeu em 15 s' });
  });

  it('refuses a method name that is not package.Service/Method', async () => {
    const { sent, send } = answer(Buffer.alloc(0));
    for (const bad of ['a.B', 'a.B/C -x', '-plaintext/Go', 'a.B/C/d', '../a/B']) await expect(grpcInvoke('dind:20059', bad, '{}', {}, send)).rejects.toThrow(/invalid method/);
    expect(sent).toHaveLength(0);
  });
});
