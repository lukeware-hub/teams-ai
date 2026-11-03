import { describe, expect, it } from 'vitest';
import { currentReview, specsBlockReason } from './SpecsCheck.js';

const verdict = (specsHash: string, value: 'approved' | 'rejected' | 'failed') => ({ specsHash, verdict: value, findings: [], reason: null, at: null });

describe('the specs.md gate', () => {
  it('names the step it waits for while the backlog is not ready', () => {
    expect(specsBlockReason('answering', undefined, {})).toBe('Aguardando o backlog ficar pronto');
  });

  it('says the file is being written before any hash exists', () => {
    expect(specsBlockReason('ready', undefined, {})).toBe('Gerando o specs.md');
  });

  it('asks for the approval of each owner still missing', () => {
    expect(specsBlockReason('ready', 'h1', { po: verdict('h1', 'approved'), sm: verdict('h1', 'rejected') })).toBe('Falta a aprovação do SM');
    expect(specsBlockReason('ready', 'h1', {})).toBe('Falta a aprovação do PO e do SM');
  });

  it('counts a verdict only for the text it read: an older one is owed again', () => {
    expect(specsBlockReason('ready', 'h2', { po: verdict('h1', 'approved'), sm: verdict('h2', 'approved') })).toBe('Falta a aprovação do PO');
  });

  it('is null once both approve the current text', () => {
    expect(specsBlockReason('ready', 'h1', { po: verdict('h1', 'approved'), sm: verdict('h1', 'approved') })).toBeNull();
  });

  it('finds the review of this text only', () => {
    expect(currentReview({ po: verdict('h1', 'failed') }, 'po', 'h1')?.verdict).toBe('failed');
    expect(currentReview({ po: verdict('h1', 'failed') }, 'po', 'h2')).toBeUndefined();
  });
});
