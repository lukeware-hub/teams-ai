import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DocFile } from '@server/refine/draft';
import type { DocScore, Readiness } from '@server/refine/readiness';
import { ReadinessBanner } from './ReadinessBanner.js';

const DOCS: DocFile[] = ['project.md', 'briefing.md', 'stack.md', 'flow.md', 'design.md'];
const uniform = (value: number) => Object.fromEntries(DOCS.map((file) => [file, { score: value, checks: { complete: value, concrete: value, consistent: value, scoped: value } }])) as Record<DocFile, DocScore>;
const scored = (average: number, over: Partial<Readiness> = {}): Readiness => ({ cycle: 1, available: true, model: 'jev-1.13.0', average, docs: uniform(average), usage: null, outdated: false, ...over });
const props = (readiness: Readiness | undefined, over: Partial<{ canStart: boolean }> = {}) => ({ readiness, canStart: true, startState: { label: 'Iniciar análise', busy: false }, onScore: vi.fn(), onStart: vi.fn(), ...over });
const button = (name: string) => screen.queryByRole('button', { name }) as HTMLButtonElement | null;

describe('ReadinessBanner', () => {
  it('says ready at the minimum, with the score and the five documents, and starts the project from its own button', () => {
    const p = props(scored(0.8));
    render(<ReadinessBanner {...p} />);
    expect(screen.getByText('Pronto para desenvolver')).toBeTruthy();
    expect(screen.getByTestId('readiness-score').textContent).toBe('Nota do Jev 80%');
    expect(screen.getByTestId('readiness-docs').textContent).toContain('briefing.md80%');
    expect(button('Avaliar com o Jev')).toBeNull();
    fireEvent.click(screen.getByTestId('readiness-start'));
    expect(p.onStart).toHaveBeenCalledOnce();
  });

  it('shows the score of only the documents that have one, as a stage does before its documents are all scored', () => {
    const one = { 'stack.md': { score: 0.8, checks: { complete: 0.8, concrete: 0.8, consistent: 0.8, scoped: 0.8 } } } as Readiness['docs'];
    render(<ReadinessBanner {...props(scored(0.8, { docs: one }))} />);
    expect(screen.getByTestId('readiness-docs').textContent).toContain('stack.md80%');
    expect(screen.getByTestId('readiness-docs').textContent).not.toContain('briefing.md');
  });

  it('keeps the start shut when the gate of the screen says no', () => {
    render(<ReadinessBanner {...props(scored(0.9), { canStart: false })} />);
    expect((screen.getByTestId('readiness-start') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says below the minimum, and keeps the score button off, since the same documents would score the same', () => {
    render(<ReadinessBanner {...props(scored(0.79))} />);
    expect(screen.getByText('Ainda não está pronto para desenvolver')).toBeTruthy();
    expect(screen.getByTestId('readiness-score').textContent).toBe('Nota do Jev 79%');
    expect(button('Avaliar com o Jev')!.disabled).toBe(true);
  });

  it('starts below the minimum once the screen allows it, since the score never blocks by itself', () => {
    const p = props(scored(0.79));
    render(<ReadinessBanner {...p} />);
    fireEvent.click(screen.getByTestId('readiness-start'));
    expect(p.onStart).toHaveBeenCalledOnce();
  });

  it('asks for a first score when there is none', () => {
    const p = props(undefined);
    render(<ReadinessBanner {...p} />);
    expect(screen.getByText('Sem nota do Jev')).toBeTruthy();
    fireEvent.click(button('Avaliar com o Jev')!);
    expect(p.onScore).toHaveBeenCalledOnce();
  });

  it('says the documents changed after the score, and offers a new one without showing the old numbers', () => {
    render(<ReadinessBanner {...props(scored(0.9, { outdated: true }))} />);
    expect(screen.getByText('Os documentos mudaram depois da nota')).toBeTruthy();
    expect(button('Avaliar com o Jev')!.disabled).toBe(false);
    expect(screen.queryByTestId('readiness-score')).toBeNull();
    expect(screen.queryByTestId('readiness-docs')).toBeNull();
  });

  it('says the Jev did not answer and points to the OpenRouter key', () => {
    render(<ReadinessBanner {...props({ ...scored(0.9), available: false, average: null, docs: null })} />);
    expect(screen.getByText('O Jev não respondeu')).toBeTruthy();
    expect(screen.getByText(/chave do OpenRouter/)).toBeTruthy();
    expect(button('Avaliar com o Jev')!.disabled).toBe(false);
  });

  it('says a confidential project has no score, and offers no button', () => {
    render(<ReadinessBanner {...props({ ...scored(0), available: false, average: null, docs: null, skipped: 'confidential' })} />);
    expect(screen.getByText('Projeto confidencial')).toBeTruthy();
    expect(button('Avaliar com o Jev')).toBeNull();
  });
});
