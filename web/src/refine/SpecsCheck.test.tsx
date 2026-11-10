import { describe, expect, it } from 'vitest';
import { currentReview, specsBlockReason } from './SpecsCheck.js';

const verdict = (specsHash: string, value: 'approved' | 'rejected' | 'failed') => ({ specsHash, verdict: value, findings: [], reason: null, at: null });

describe('the specs.md gate', () => {
  it('names the step it waits for while the backlog is not ready', () => {
    expect(specsBlockReason('answering', undefined)).toBe('Aguardando o backlog ficar pronto');
  });

  it('says the file is being written before any hash exists, or asks for it when nothing runs', () => {
    expect(specsBlockReason('ready', undefined)).toBe('Gerando o specs.md');
    expect(specsBlockReason('ready', undefined, false)).toBe('Gere o specs.md do backlog');
  });

  it('is null once the file is written: what PO and SM say never holds the start', () => {
    expect(specsBlockReason('ready', 'h1')).toBeNull();
  });

  it('finds the review of this text only', () => {
    expect(currentReview({ po: verdict('h1', 'failed') }, 'po', 'h1')?.verdict).toBe('failed');
    expect(currentReview({ po: verdict('h1', 'failed') }, 'po', 'h2')).toBeUndefined();
  });
});
