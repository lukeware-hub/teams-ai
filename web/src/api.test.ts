import { afterEach, describe, expect, it, vi } from 'vitest';
import { refineApi, runApi } from './api.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runApi.docs', () => {
  it('gets the five main documents of a project', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ docs: [] }), { status: 200 }));
    await expect(runApi.docs('shop')).resolves.toEqual({ docs: [] });
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/projects/shop/docs');
  });
});

describe('the answer of a sign-in page', () => {
  it('is an error the owner can act on, not an empty answer', async () => {
    const signIn = new Response('<html>entrar</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    Object.defineProperty(signIn, 'redirected', { value: true });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(signIn);
    await expect(refineApi.suggestDoc('shop', 'shop-002', 'stack.md')).rejects.toThrow('Você precisa entrar de novo');
  });
});

describe('refineApi.scoreDoc', () => {
  it('posts the score of one named document of a refinement', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(refineApi.scoreDoc('shop', 'shop-002', 'stack.md')).resolves.toEqual({ ok: true });
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/refine/shop/shop-002/docs/stack.md/score');
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
  });

  it('posts the owner step to the next stage of a refinement', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(refineApi.continueStage('shop', 'shop-002')).resolves.toEqual({ ok: true });
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/refine/shop/shop-002/stage/continue');
  });

  it('posts a document to the Graphify graph as it is now', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 202 }));
    await expect(refineApi.addToGraph('shop', 'shop-002', 'stack.md')).resolves.toEqual({ ok: true });
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/refine/shop/shop-002/graph/add');
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
  });

  it('posts the close of the final review to the refinement', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(refineApi.closeReview('shop', 'shop-002')).resolves.toEqual({ ok: true });
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/refine/shop/shop-002/review/close');
  });

  it('posts the review of one stage document, which the server answers with 202', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 202 }));
    await expect(refineApi.evaluateStage('shop', 'shop-002', 'flow.md')).resolves.toEqual({ ok: true });
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/refine/shop/shop-002/docs/flow.md/evaluate');
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
  });

  it('posts the plan preparation, which the server answers with 202', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 202 }));
    await expect(refineApi.plans('shop', 'shop-002')).resolves.toEqual({ ok: true });
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/refine/shop/shop-002/plans');
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
  });

  it('posts the owner answer on confidentiality with its value', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(refineApi.confidential('shop', 'shop-002', true)).resolves.toEqual({ ok: true });
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/refine/shop/shop-002/confidential');
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body))).toEqual({ confidential: true });
  });
});

describe('refineApi.saveDoc', () => {
  it('can ask the browser to keep the save request after the page closes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, hash: 'hash-after' }), { status: 200 }));
    await expect(refineApi.saveDoc('shop', 'shop-002', 'flow.md', '# Fluxo', 'hash-before', true)).resolves.toEqual({ ok: true, hash: 'hash-after' });
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ method: 'PUT', keepalive: true });
  });

  it('sends a body too large for the browser keepalive limit without keepalive', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, hash: 'hash-after' }), { status: 200 }));
    await expect(refineApi.saveDoc('shop', 'shop-002', 'flow.md', 'x'.repeat(61 * 1024), 'hash-before', true)).resolves.toEqual({ ok: true, hash: 'hash-after' });
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({ method: 'PUT', keepalive: false });
  });
});
