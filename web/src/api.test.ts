import { afterEach, describe, expect, it, vi } from 'vitest';
import { refineApi } from './api.js';

afterEach(() => {
  vi.restoreAllMocks();
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
