import { describe, expect, it } from 'vitest';
import { adviceFor, exampleOf, isRead, prettyJson, shortService, statusOf, tokenExpiry, withAuthorization } from './grpc-hints.js';

describe('grpc hints', () => {
  it('reads a method as reading by its verb, and anything else as maybe writing', () => {
    for (const name of ['GetEffectivePolicy', 'ListPolicyVersions', 'SearchRules', 'WatchChanges', 'DescribeVersion']) expect(isRead(name)).toBe(true);
    for (const name of ['PublishPolicyVersion', 'PreparePolicyVersion', 'Getaway', 'ResetAll']) expect(isRead(name)).toBe(name === 'Getaway');
  });

  it('shows the last part of a service name', () => {
    expect(shortService('kh.policy_registry.v1.PolicyRegistryService')).toBe('PolicyRegistryService');
    expect(shortService('Plain')).toBe('Plain');
  });

  it('advises on the statuses the owner can act on, and says nothing for the others', () => {
    expect(adviceFor('UNAUTHENTICATED (16): UNAUTHENTICATED')).toContain('preencha Cabeçalhos');
    expect(adviceFor('PERMISSION_DENIED (7): no')).toContain('permissão');
    expect(adviceFor('INVALID_ARGUMENT (3): bad')).toContain('JSON');
    expect(adviceFor('UNAVAILABLE (14): down')).toContain('no ar');
    expect(adviceFor('não foi possível conectar ao serviço (ECONNREFUSED)')).toContain('no ar');
    expect(adviceFor('o serviço não respondeu em 15 s')).toContain('no ar');
    expect(adviceFor('NOT_FOUND (5): x')).toContain('não achou o registro');
    expect(adviceFor('ALREADY_EXISTS (6): x')).toBeNull();
    expect(adviceFor('fetch failed')).toBeNull();
  });
});

describe('call result helpers', () => {
  it('names the status of a call by its gRPC code, and says Erro when the service gave none', () => {
    expect(statusOf({ ok: true, error: '' })).toBe('0 OK');
    expect(statusOf({ ok: false, error: 'UNAUTHENTICATED (16): UNAUTHENTICATED' })).toBe('16 UNAUTHENTICATED');
    expect(statusOf({ ok: false, error: 'NOT_FOUND (5): policy' })).toBe('5 NOT_FOUND');
    expect(statusOf({ ok: false, error: 'fetch failed' })).toBe('Erro');
  });

  it('lays out one JSON value and leaves anything else untouched', () => {
    expect(prettyJson('{"a":1,"b":[2]}')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
    expect(prettyJson('not json')).toBe('not json');
    expect(prettyJson('')).toBe('');
  });
});

describe('exampleOf', () => {
  const now = new Date('2026-11-14T10:00:00.000Z');
  const uuid = () => '11111111-1111-4111-8111-111111111111';

  it('fills the empty template with samples by the kind of value, and keeps nested messages and lists', () => {
    const template = JSON.stringify({ id: '', policyType: '', actorId: '', idempotencyKey: '', limit: '0', page: 0, referenceAt: '1970-01-01T00:00:00Z', active: false, envelope: { actorId: '' }, items: [{ name: '' }] });
    expect(JSON.parse(exampleOf(template, now, uuid))).toEqual({
      id: uuid(),
      policyType: 'exemplo',
      actorId: uuid(),
      idempotencyKey: uuid(),
      limit: '10',
      page: 1,
      referenceAt: '2026-11-14T10:00:00.000Z',
      active: false,
      envelope: { actorId: uuid() },
      items: [{ name: 'exemplo' }],
    });
  });

  it('empties a free-form object, keeps values the template already names, and leaves anything that is not JSON as it came', () => {
    expect(JSON.parse(exampleOf('{"context":{"google.protobuf.Struct":"supports arbitrary JSON objects"},"kind":"KIND_A","wait":"0s"}', now, uuid))).toEqual({ context: {}, kind: 'KIND_A', wait: '0s' });
    expect(exampleOf('not json', now, uuid)).toBe('not json');
  });
});

describe('withAuthorization', () => {
  it('puts the authorization line first and drops the old one, keeping the other headers', () => {
    expect(withAuthorization('x-tenant: a\nAuthorization: Bearer old\n\n', 'authorization: Bearer new')).toBe('authorization: Bearer new\nx-tenant: a');
    expect(withAuthorization('', 'authorization: Bearer new')).toBe('authorization: Bearer new');
  });
});

describe('tokenExpiry', () => {
  const jwt = (claims: object) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_')}.s`;

  it('reads when a bearer token stops being valid from its exp claim', () => {
    expect(tokenExpiry(`authorization: Bearer ${jwt({ exp: 1_800_000_000 })}`)?.toISOString()).toBe('2027-01-15T08:00:00.000Z');
  });

  it('says nothing for a line without a readable token', () => {
    expect(tokenExpiry('authorization: Bearer abc.def')).toBeNull();
    expect(tokenExpiry('authorization: Bearer a.b.c')).toBeNull();
    expect(tokenExpiry(`authorization: Bearer ${jwt({ sub: 'x' })}`)).toBeNull();
    expect(tokenExpiry('')).toBeNull();
  });
});
