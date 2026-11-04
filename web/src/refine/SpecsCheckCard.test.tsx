import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SpecsCheck } from './SpecsCheck.js';

describe('the specs.md card', () => {
  it('offers Tentar de novo when nothing was written and nothing runs, and calls the retry', () => {
    const onRetry = vi.fn();
    render(<SpecsCheck specsMd={null} reviews={{}} busy={false} onRetry={onRetry} />);
    fireEvent.click(screen.getByTestId('specs-check-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the file and both reviewers as running, with no retry, while the work runs', () => {
    render(<SpecsCheck specsMd={null} reviews={{}} busy onRetry={() => undefined} />);
    expect(screen.getByTestId('specs-check-file-status').textContent).toBe('Gerando');
    expect(screen.getByTestId('specs-check-po-status').textContent).toBe('Analisando');
    expect(screen.queryByTestId('specs-check-retry')).toBeNull();
  });

  it('offers the retry when a reviewer failed on the current text, and not when both approved', () => {
    const failed = { specsHash: 'h', verdict: 'failed' as const, findings: [], reason: 'sem resposta', at: null };
    const approved = { specsHash: 'h', verdict: 'approved' as const, findings: [], reason: null, at: null };
    const first = render(<SpecsCheck specsMd={{ hash: 'h' }} reviews={{ po: failed, sm: approved }} busy={false} onRetry={() => undefined} />);
    expect(screen.getByTestId('specs-check-retry')).toBeTruthy();
    first.unmount();
    render(<SpecsCheck specsMd={{ hash: 'h' }} reviews={{ po: approved, sm: approved }} busy={false} onRetry={() => undefined} />);
    expect(screen.queryByTestId('specs-check-retry')).toBeNull();
  });
});

describe('the specs.md card while the agents repair it', () => {
  const rejected = { specsHash: 'h', verdict: 'rejected' as const, findings: ['x'], reason: null, at: null };

  it('says the agents are correcting it, with the attempt', () => {
    render(<SpecsCheck specsMd={{ hash: 'h' }} reviews={{ po: rejected }} busy repairs={1} />);
    expect(screen.getByTestId('specs-check-repairing').textContent).toContain('tentativa 1 de 2');
  });

  it('says the agents gave up after the last attempt, and leaves the findings to the owner', () => {
    render(<SpecsCheck specsMd={{ hash: 'h' }} reviews={{ po: rejected }} busy={false} repairs={2} />);
    expect(screen.getByTestId('specs-check-gave-up').textContent).toContain('2 vezes');
  });

  it('says nothing about repairs when none ran', () => {
    render(<SpecsCheck specsMd={{ hash: 'h' }} reviews={{ po: rejected }} busy={false} />);
    expect(screen.queryByTestId('specs-check-gave-up')).toBeNull();
    expect(screen.queryByTestId('specs-check-repairing')).toBeNull();
  });
});

describe('the specs.md card when the repairs did not settle it', () => {
  const rejected = { specsHash: 'h', verdict: 'rejected' as const, findings: ['x'], reason: null, at: null };

  it('offers to ask the team and to follow anyway, and calls each', () => {
    const onAsk = vi.fn();
    const onApprove = vi.fn();
    render(<SpecsCheck specsMd={{ hash: 'h' }} reviews={{ po: rejected }} busy={false} repairs={2} onAsk={onAsk} onApprove={onApprove} />);
    fireEvent.click(screen.getByTestId('specs-check-ask'));
    fireEvent.click(screen.getByTestId('specs-check-approve'));
    expect(onAsk).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('once the team asked, points to the questions, and still offers to let the team resolve everything or to follow anyway', () => {
    render(<SpecsCheck specsMd={{ hash: 'h' }} reviews={{ po: rejected }} busy={false} repairs={2} asked onAsk={() => undefined} onApprove={() => undefined} />);
    expect(screen.getByTestId('specs-check-gave-up').textContent).toContain('Responda as perguntas abaixo');
    expect(screen.getByTestId('specs-check-ask')).toBeTruthy();
    expect(screen.getByTestId('specs-check-approve')).toBeTruthy();
  });
});

describe('the specs.md button says why nothing started', () => {
  it('shows the reason the server gave when the click started nothing', async () => {
    const onRetry = vi.fn().mockResolvedValue({ started: false, reason: 'O time ainda está trabalhando. Espere ele terminar e clique de novo.' });
    render(<SpecsCheck specsMd={null} reviews={{}} busy={false} onRetry={onRetry} />);
    fireEvent.click(screen.getByTestId('specs-check-retry'));
    expect((await screen.findByTestId('specs-check-note')).textContent).toContain('ainda está trabalhando');
  });

  it('shows no note when the click started the work', async () => {
    const onRetry = vi.fn().mockResolvedValue({ started: true });
    render(<SpecsCheck specsMd={null} reviews={{}} busy={false} onRetry={onRetry} />);
    fireEvent.click(screen.getByTestId('specs-check-retry'));
    await Promise.resolve();
    expect(screen.queryByTestId('specs-check-note')).toBeNull();
  });

  it('says what the documents still lack, since the team reviews them first', () => {
    render(<SpecsCheck specsMd={{ hash: 'h' }} reviews={{}} busy={false} onRetry={() => undefined} waitingOn={['1 pergunta obrigatória em aberto']} />);
    expect(screen.getByTestId('specs-check-waiting').textContent).toContain('1 pergunta obrigatória em aberto');
  });
});
