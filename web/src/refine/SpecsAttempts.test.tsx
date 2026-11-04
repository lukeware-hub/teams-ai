import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SpecsAttemptView } from '../api.js';
import { repeatedPoints, SpecsAttempts } from './SpecsAttempts.js';

const attempt = (n: number, findings: string[], over: Partial<SpecsAttemptView> = {}): SpecsAttemptView => ({ n, hash: 'h', items: ['base'], points: 2, redone: ['base'], failed: [], after: { po: { verdict: 'rejected', findings }, sm: { verdict: 'approved', findings: [] } }, ...over });

describe('SpecsAttempts', () => {
  it('lists each try: what was pointed, what the team redid, and what the reviewers said after', () => {
    render(<SpecsAttempts attempts={[attempt(1, ['O item base cita uma seção vazia.'])]} />);
    expect(screen.getByTestId('specs-attempt-1').textContent).toContain('Os revisores apontaram 2 pontos em base. O time refez base.');
    expect(screen.getByTestId('specs-attempt-1').textContent).toContain('Depois: PO reprovou · SM aprovou.');
  });

  it('says a point came back unchanged, and explains why redoing the item does not settle it', () => {
    const same = 'Os ids de critério colidem com os do briefing e tornam a rastreabilidade ambígua.';
    render(<SpecsAttempts attempts={[attempt(1, [same]), attempt(2, [same])]} />);
    expect(screen.getByTestId('specs-attempt-2-repeated').textContent).toContain('Um ponto voltou sem mudar');
    expect(screen.getByTestId('specs-attempts-why').textContent).toContain('Refazer o item não corrige isso');
  });

  it('names what an agent could not redo, and shows nothing when no try was made', () => {
    const { unmount } = render(<SpecsAttempts attempts={[attempt(1, ['x'], { failed: [{ item: 'base', issues: ['o agente não devolveu a spec deste item'] }] })]} />);
    expect(screen.getByTestId('specs-attempt-1').textContent).toContain('O agente não conseguiu refazer base: o agente não devolveu a spec deste item');
    unmount();
    render(<SpecsAttempts attempts={[]} />);
    expect(screen.queryByTestId('specs-attempts')).toBeNull();
  });

  it('finds the repeated points by their opening words', () => {
    const open = 'Os ids dos critérios do specs colidem com os do briefing e tornam a rastreabilidade ambígua';
    expect(repeatedPoints([attempt(1, [open + ' hoje']), attempt(2, [open + ' ainda'])], 1)).toHaveLength(1);
    expect(repeatedPoints([attempt(1, ['Um ponto']), attempt(2, ['Outro ponto'])], 1)).toHaveLength(0);
  });

  it('says how many changes the PO made to the documents in a try', () => {
    render(<SpecsAttempts attempts={[attempt(1, ['x'], { documents: 2 })]} />);
    expect(screen.getByTestId('specs-attempt-1-documents').textContent).toBe('O PO corrigiu 2 trechos dos documentos.');
  });
});
