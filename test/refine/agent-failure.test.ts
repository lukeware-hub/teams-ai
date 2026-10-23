import { describe, expect, it, vi } from 'vitest';
import { failureMessage, internalErrorMessage, retryOnSchema, withNote } from '../../server/refine/agent-failure.js';
import { PackTooLargeError } from '../../server/refine/fit-pack.js';

describe('failureMessage', () => {
  it.each([
    ['schema', 'A revisão de flow.md não devolveu o resultado em formato válido. Clique em Reavaliar.'],
    ['timeout', 'A revisão de flow.md passou do tempo limite. Clique em Reavaliar.'],
    ['compaction', 'A revisão de flow.md parou por causa do tamanho da conversa ou do ritmo de uso. Clique em Reavaliar.'],
    ['environment', 'A revisão de flow.md não conseguiu iniciar o agente. Clique em Reavaliar.'],
    ['code', 'A revisão de flow.md falhou por um erro do agente. Clique em Reavaliar.'],
  ] as const)('gives the %s failure its plain reason for the stage', (failure, reason) => {
    expect(failureMessage('A revisão de flow.md', failure, []).reason).toBe(reason);
  });

  it('gives the quota and auth failures their own reason, without a stage name', () => {
    expect(failureMessage('A revisão do PO', 'quota', []).reason).toBe('O limite de uso do Claude foi atingido. Tente de novo quando ele for liberado.');
    expect(failureMessage('A revisão do PO', 'auth', []).reason).toBe('A sessão do Claude expirou. Entre de novo no Claude em Configurações e processe de novo.');
  });

  it('keeps the raw errors as the detail, and the detail short', () => {
    expect(failureMessage('A revisão do SM', 'schema', ['no JSON object: from":"docs/flow.md"']).detail).toBe('no JSON object: from":"docs/flow.md"');
    expect(failureMessage('A revisão do SM', 'code', ['a'.repeat(5000)]).detail).toHaveLength(1000);
  });
});

describe('internalErrorMessage', () => {
  it('gives a plain reason, and keeps the error as the detail with its secrets redacted', () => {
    const { reason, detail } = internalErrorMessage('A revisão de flow.md', new Error('key sk-ant-abcdefghijklmnop rejected'));
    expect(reason).toBe('A revisão de flow.md parou por um erro interno. Clique em Reavaliar.');
    expect(detail).not.toContain('sk-ant-abcdefghijklmnop');
    expect(detail).toContain('[REDACTED]');
  });

  it('keeps the message of an oversized pack, which already says what to do', () => {
    const message = 'Reduza ou divida o conteúdo dos documentos.';
    expect(internalErrorMessage('A revisão de flow.md', new PackTooLargeError(message))).toEqual({ reason: message, detail: message });
  });
});

describe('retryOnSchema', () => {
  const failed = { ok: false, failure: 'schema', errors: ['specHash: mismatch'], summary: {}, sandboxDisabled: false };
  const ok = { ok: true, value: 'fine', summary: {} };

  it('runs the attempt once more with the first schema error in the note, and keeps the second answer', async () => {
    const attempt = vi.fn(async (note: string | null) => (note === null ? failed : ok));
    expect(await retryOnSchema(attempt as never)).toMatchObject({ ok: true, value: 'fine' });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(String(attempt.mock.calls[1]?.[0])).toContain('did not match the output schema: specHash: mismatch');
  });

  it('asks for the JSON object itself when the answer had none', async () => {
    const noObject = { ok: false, failure: 'schema', errors: ['no JSON object in the agent result (subtype=success)'], summary: {}, sandboxDisabled: false };
    const attempt = vi.fn(async (note: string | null) => (note === null ? noObject : ok));
    await retryOnSchema(attempt as never);
    expect(String(attempt.mock.calls[1]?.[0])).toContain('not one complete JSON object');
  });

  it('runs no retry for a failure that is not the schema', async () => {
    const quota = { ok: false, failure: 'quota', errors: ['janela'], summary: {}, sandboxDisabled: false };
    const attempt = vi.fn(async () => quota);
    expect(await retryOnSchema(attempt as never)).toBe(quota);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('withNote', () => {
  it('appends the note to the feedback, and returns the pack unchanged without one', () => {
    const pack = { kind: 'refine', feedback: 'docs', budgetTokens: 1 } as never;
    expect(withNote(pack, null)).toBe(pack);
    expect(withNote(pack, 'redo')).toMatchObject({ feedback: 'docs\n\nredo' });
  });
});
